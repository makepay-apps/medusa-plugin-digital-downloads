import { constants, type Stats } from "node:fs"
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { createHash, createHmac, createSecretKey, randomUUID, timingSafeEqual, type KeyObject } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { DigitalStorageProvider } from "../types"
import { sha256 } from "../utils"
import { safeProviderCode, sanitizedProviderError, withSanitizedProviderError } from "./errors"
import type {
  ProtectedStorageDescriptor,
  StorageDriver,
  StorageObjectLocator,
  StorageObjectMetadata,
  StorageObjectResult,
  StoragePutInput,
  StoragePutStreamInput,
  StorageReadInput,
} from "./types"

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const PRIVATE_DIRECTORY_MASK = 0o077
const PRIVATE_FILE_MODE = 0o600

function validKey(key: string): string {
  if (
    !key ||
    key.length > 1024 ||
    key.includes("\0") ||
    key.includes("\\") ||
    path.posix.isAbsolute(key)
  ) {
    throw new Error("Storage key is invalid")
  }
  const segments = key.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Storage key contains an unsafe path segment")
  }
  if (segments.some((segment) => Buffer.byteLength(segment, "utf8") > 255)) {
    throw new Error("Storage key contains an oversized path segment")
  }
  return segments.join("/")
}

function validRange(
  start: number | undefined,
  end: number | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (start === undefined && end === undefined) {
    return undefined
  }
  const from = start ?? 0
  const to = end ?? size - 1
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    from >= size
  ) {
    throw new RangeError("Requested byte range is not satisfiable")
  }
  return { start: from, end: Math.min(to, size - 1) }
}

function sameOrBelow(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

function normalizedForPolicy(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function assertPermittedRoot(rootPath: string): void {
  const candidate = normalizedForPolicy(rootPath)
  const filesystemRoot = normalizedForPolicy(path.parse(rootPath).root)
  const broadRoots = new Set(
    [
      filesystemRoot,
      homedir(),
      tmpdir(),
      process.cwd(),
      path.dirname(homedir()),
      ...(process.platform === "win32"
        ? []
        : [
            "/home",
            "/mnt",
            "/opt",
            "/private",
            "/root",
            "/srv",
            "/tmp",
            "/Users",
            "/var",
            "/Volumes",
          ]),
    ]
      .filter(Boolean)
      .map(normalizedForPolicy),
  )
  if (broadRoots.has(candidate)) {
    throw new Error("Local storage root is too broad")
  }

  const segments = candidate
    .slice(filesystemRoot.length)
    .split(path.sep)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase())
  if (
    segments.some((segment) =>
      ["htdocs", "public", "shared", "static", "www", "wwwroot"].includes(segment),
    )
  ) {
    throw new Error("Local storage root cannot be inside a public or shared directory")
  }

  if (process.platform !== "win32") {
    const systemTrees = [
      "/Applications",
      "/Library",
      "/System",
      "/bin",
      "/boot",
      "/dev",
      "/etc",
      "/proc",
      "/sbin",
      "/sys",
      "/usr",
    ].map(normalizedForPolicy)
    if (systemTrees.some((systemRoot) => sameOrBelow(candidate, systemRoot))) {
      throw new Error("Local storage root cannot be inside a system directory")
    }
  } else {
    const windowsDirectory = process.env.WINDIR
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value))
      .map(normalizedForPolicy)
    if (
      (windowsDirectory && sameOrBelow(candidate, normalizedForPolicy(windowsDirectory))) ||
      programFiles.some((systemRoot) => sameOrBelow(candidate, systemRoot))
    ) {
      throw new Error("Local storage root cannot be inside a system directory")
    }
  }
}

function assertPrivateDirectory(info: Stats, root = false): void {
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      root
        ? "Local storage root must be a real directory"
        : "Local storage path contains a non-directory component",
    )
  }
  if (process.platform !== "win32" && (info.mode & PRIVATE_DIRECTORY_MASK) !== 0) {
    throw new Error(
      root
        ? "Pre-existing local storage root must already be private (mode 0700 or stricter)"
        : "Local storage subdirectories must be private (mode 0700 or stricter)",
    )
  }
  if (
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    info.uid !== process.getuid()
  ) {
    throw new Error(
      root
        ? "Local storage root must be owned by the Medusa process user"
        : "Local storage subdirectories must be owned by the Medusa process user",
    )
  }
}

export class ProtectedLocalStorageDriver implements StorageDriver {
  readonly provider = DigitalStorageProvider.LOCAL
  private readonly configuredRootPath: string
  private readonly signingKey?: KeyObject
  private rootInitialization?: Promise<void>
  private canonicalRootPath?: string
  private rootIdentity?: { dev: number; ino: number }

  constructor(options: { rootPath: string; signingSecret?: string }) {
    if (!path.isAbsolute(options.rootPath)) {
      throw new Error("Local storage root must be absolute")
    }
    this.configuredRootPath = path.resolve(options.rootPath)
    assertPermittedRoot(this.configuredRootPath)
    if (options.signingSecret) {
      this.signingKey = createSecretKey(Buffer.from(options.signingSecret, "utf8"))
    }
  }

  private async initializeRoot(): Promise<void> {
    let info: Stats
    try {
      info = await lstat(this.configuredRootPath)
    } catch (error) {
      if (safeProviderCode(error) !== "ENOENT") {
        throw sanitizedProviderError("local", "inspect root", error)
      }
      await withSanitizedProviderError("local", "create root", () =>
        mkdir(this.configuredRootPath, { recursive: true, mode: 0o700 }).then(
          () => undefined,
        ),
      )
      info = await withSanitizedProviderError("local", "inspect root", () =>
        lstat(this.configuredRootPath),
      )
    }

    // Never repair a pre-existing root with chmod: an unexpectedly broad or
    // attacker-controlled directory is rejected instead.
    assertPrivateDirectory(info, true)
    const canonicalRoot = await withSanitizedProviderError(
      "local",
      "resolve root",
      () => realpath(this.configuredRootPath),
    )
    assertPermittedRoot(canonicalRoot)
    const canonicalInfo = await withSanitizedProviderError(
      "local",
      "inspect root",
      () => lstat(canonicalRoot),
    )
    assertPrivateDirectory(canonicalInfo, true)
    this.canonicalRootPath = canonicalRoot
    this.rootIdentity = { dev: canonicalInfo.dev, ino: canonicalInfo.ino }
  }

  private async ensureRoot(): Promise<string> {
    this.rootInitialization ??= this.initializeRoot()
    await this.rootInitialization
    const root = this.canonicalRootPath!
    const expected = this.rootIdentity!
    const info = await withSanitizedProviderError("local", "inspect root", () =>
      lstat(root),
    )
    assertPrivateDirectory(info, true)
    if (info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error("Local storage root changed after initialization")
    }
    return root
  }

  private async objectPath(keyInput: string): Promise<{ key: string; filePath: string }> {
    const key = validKey(keyInput)
    const root = await this.ensureRoot()
    const filePath = path.resolve(root, key)
    if (!sameOrBelow(filePath, root) || filePath === root) {
      throw new Error("Storage key escapes the configured root")
    }
    return { key, filePath }
  }

  private async inspectDirectory(directory: string): Promise<Stats | undefined> {
    try {
      return await lstat(directory)
    } catch (error) {
      if (safeProviderCode(error) === "ENOENT") {
        return undefined
      }
      throw sanitizedProviderError("local", "inspect directory", error)
    }
  }

  private async assertSafeParent(
    filePath: string,
    allowMissing: boolean,
  ): Promise<boolean> {
    const root = await this.ensureRoot()
    const parent = path.dirname(filePath)
    if (!sameOrBelow(parent, root)) {
      throw new Error("Storage key escapes the configured root")
    }
    const relativeParent = path.relative(root, parent)
    let current = root
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      const info = await this.inspectDirectory(current)
      if (!info) {
        if (allowMissing) {
          return false
        }
        throw sanitizedProviderError("local", "inspect directory", {
          code: "ENOENT",
        })
      }
      assertPrivateDirectory(info)
    }
    return true
  }

  private async prepareParent(filePath: string): Promise<void> {
    const root = await this.ensureRoot()
    const relativeParent = path.relative(root, path.dirname(filePath))
    let current = root
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      let info = await this.inspectDirectory(current)
      if (!info) {
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          if (safeProviderCode(error) !== "EEXIST") {
            throw sanitizedProviderError("local", "create directory", error)
          }
        }
        info = await withSanitizedProviderError(
          "local",
          "inspect directory",
          () => lstat(current),
        )
      }
      assertPrivateDirectory(info)
    }
    await this.assertSafeParent(filePath, false)
  }

  private async openRegularFile(
    filePath: string,
  ): Promise<{ handle: FileHandle; info: Stats }> {
    await this.assertSafeParent(filePath, false)
    const before = await withSanitizedProviderError("local", "inspect object", () =>
      lstat(filePath),
    )
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("Stored object is not a regular file")
    }

    const handle = await withSanitizedProviderError("local", "open object", () =>
      open(filePath, constants.O_RDONLY | NO_FOLLOW),
    )
    try {
      const info = await withSanitizedProviderError("local", "inspect object", () =>
        handle.stat(),
      )
      if (!info.isFile()) {
        throw new Error("Stored object is not a regular file")
      }
      await this.assertHandleMatchesPath(filePath, handle, info)
      return { handle, info }
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private async assertHandleMatchesPath(
    filePath: string,
    handle: FileHandle,
    handleInfo?: Stats,
  ): Promise<void> {
    const root = await this.ensureRoot()
    const info =
      handleInfo ??
      (await withSanitizedProviderError("local", "inspect object", () =>
        handle.stat(),
      ))
    const canonicalFile = await withSanitizedProviderError(
      "local",
      "resolve object",
      () => realpath(filePath),
    )
    if (!sameOrBelow(canonicalFile, root) || canonicalFile === root) {
      throw new Error("Stored object resolves outside the configured root")
    }
    const pathInfo = await withSanitizedProviderError(
      "local",
      "inspect object",
      () => lstat(filePath),
    )
    if (
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      pathInfo.dev !== info.dev ||
      pathInfo.ino !== info.ino
    ) {
      throw new Error("Stored object changed while it was being opened")
    }
  }

  private async close(handle: FileHandle): Promise<void> {
    await withSanitizedProviderError("local", "close object", () => handle.close())
  }

  /**
   * Streams from the exact O_NOFOLLOW handle that was validated by
   * openRegularFile. The handle is deliberately not re-opened by path: doing so
   * would reintroduce a symlink/replacement race between validation and I/O.
   */
  private streamRegularFile(
    filePath: string,
    handle: FileHandle,
    initialInfo: Stats,
    range: { start: number; end: number } | undefined,
  ): Readable {
    const expectedSize = range
      ? range.end - range.start + 1
      : initialInfo.size
    const source = handle.createReadStream({
      autoClose: false,
      ...(range ? { start: range.start, end: range.end } : {}),
    })
    let closePromise: Promise<void> | undefined
    const closeOnce = () => {
      closePromise ??= this.close(handle)
      return closePromise
    }
    const driver = this

    async function* verifiedBytes(): AsyncGenerator<Buffer> {
      let bytesRead = 0
      let failure: unknown
      try {
        for await (const chunk of source) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytesRead += bytes.byteLength
          if (!Number.isSafeInteger(bytesRead) || bytesRead > expectedSize) {
            throw new Error("Stored object exceeded its expected read length")
          }
          yield bytes
        }
        if (bytesRead !== expectedSize) {
          throw new Error("Stored object ended before its expected read length")
        }

        const after = await withSanitizedProviderError(
          "local",
          "inspect streamed object",
          () => handle.stat(),
        )
        if (
          after.dev !== initialInfo.dev ||
          after.ino !== initialInfo.ino ||
          after.size !== initialInfo.size ||
          after.mtimeMs !== initialInfo.mtimeMs
        ) {
          throw new Error("Stored object changed while it was being streamed")
        }
        await driver.assertHandleMatchesPath(filePath, handle, after)
      } catch (error) {
        failure = sanitizedProviderError("local", "stream object", error)
      } finally {
        source.destroy()
        try {
          await closeOnce()
        } catch (error) {
          failure ??= sanitizedProviderError("local", "close object", error)
        }
      }
      if (failure) {
        throw failure
      }
    }

    const body = Readable.from(verifiedBytes())
    // A consumer may destroy the returned stream before the async generator is
    // pulled. Close explicitly in that case as well.
    body.once("close", () => {
      source.destroy()
      void closeOnce().catch(() => undefined)
    })
    return body
  }

  private temporaryPath(destination: string): string {
    return path.join(
      path.dirname(destination),
      `.upload-${process.pid}-${randomUUID()}`,
    )
  }

  private async createTemporaryFile(temporary: string): Promise<FileHandle> {
    return withSanitizedProviderError("local", "create temporary object", () =>
      open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          NO_FOLLOW,
        PRIVATE_FILE_MODE,
      ),
    )
  }

  private async commitTemporaryFile(
    temporary: string,
    destination: string,
    overwrite: boolean,
  ): Promise<void> {
    await this.assertSafeParent(destination, false)
    if (overwrite) {
      await withSanitizedProviderError("local", "commit object", () =>
        rename(temporary, destination),
      )
    } else {
      await withSanitizedProviderError("local", "commit object", () =>
        link(temporary, destination),
      )
      await unlink(temporary).catch(() => undefined)
    }

    const opened = await this.openRegularFile(destination)
    await this.close(opened.handle)
  }

  async put(input: StoragePutInput): Promise<{
    key: string
    size: number
    checksumSha256: string
    etag: string
  }> {
    if (input.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    const { key, filePath: destination } = await this.objectPath(input.key)
    await this.prepareParent(destination)
    const body = Buffer.from(input.body)
    const digest = sha256(body)
    if (input.checksumSha256 && input.checksumSha256.toLowerCase() !== digest) {
      throw new Error("Object checksum does not match the supplied SHA-256")
    }

    const temporary = this.temporaryPath(destination)
    const handle = await this.createTemporaryFile(temporary)
    try {
      await withSanitizedProviderError("local", "write object", () =>
        handle.writeFile(body),
      )
      await withSanitizedProviderError("local", "sync object", () => handle.sync())
      const info = await withSanitizedProviderError("local", "inspect object", () =>
        handle.stat(),
      )
      if (!info.isFile() || info.size !== body.byteLength) {
        throw new Error("Stored object changed while it was being written")
      }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
    await this.close(handle)

    try {
      await this.commitTemporaryFile(
        temporary,
        destination,
        Boolean(input.overwrite),
      )
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }

    return { key, size: body.byteLength, checksumSha256: digest, etag: digest }
  }

  async putStream(input: StoragePutStreamInput): Promise<{
    key: string
    size: number
    checksumSha256: string
    etag: string
  }> {
    if (input.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1) {
      throw new Error("A positive expected stream size is required")
    }
    const { key, filePath: destination } = await this.objectPath(input.key)
    await this.prepareParent(destination)
    const temporary = this.temporaryPath(destination)
    const hash = createHash("sha256")
    let size = 0
    let exceededDeclaredSize = false
    const handle = await this.createTemporaryFile(temporary)
    try {
      try {
        for await (const chunk of input.body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (!bytes.byteLength) continue
          const nextSize = size + bytes.byteLength
          if (!Number.isSafeInteger(nextSize) || nextSize > input.expectedSize) {
            exceededDeclaredSize = true
            throw new Error("upload limit exceeded")
          }

          // Keep the securely opened O_NOFOLLOW file handle through write,
          // fsync, and stat. FileHandle.createWriteStream cannot be combined
          // with pipeline while retaining the handle: pipeline waits for a
          // close event that cannot happen until verification completes.
          // Explicit partial-write handling provides the same bounded
          // backpressure without reopening the temporary path.
          let offset = 0
          while (offset < bytes.byteLength) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.byteLength - offset,
              size + offset,
            )
            if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
              throw new Error("Unable to make progress while writing upload")
            }
            offset += bytesWritten
          }
          hash.update(bytes)
          size = nextSize
        }
      } catch (error) {
        if (exceededDeclaredSize) {
          throw new Error("Upload exceeded the declared content length")
        }
        throw sanitizedProviderError("local", "stream object", error)
      }
      if (size !== input.expectedSize) {
        throw new Error("Upload size does not match the declared content length")
      }
      await withSanitizedProviderError("local", "sync object", () => handle.sync())
      const info = await withSanitizedProviderError("local", "inspect object", () =>
        handle.stat(),
      )
      if (!info.isFile() || info.size !== size) {
        throw new Error("Stored object changed while it was being written")
      }
      const checksumSha256 = hash.digest("hex")
      if (
        input.checksumSha256 &&
        input.checksumSha256.toLowerCase() !== checksumSha256
      ) {
        throw new Error("Object checksum does not match the supplied SHA-256")
      }
      await this.close(handle)
      await this.commitTemporaryFile(
        temporary,
        destination,
        Boolean(input.overwrite),
      )
      return { key, size, checksumSha256, etag: checksumSha256 }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  async get(input: StorageReadInput): Promise<StorageObjectResult> {
    if (input.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    const { filePath } = await this.objectPath(input.key)
    const { handle, info } = await this.openRegularFile(filePath)
    let range: { start: number; end: number } | undefined
    try {
      if (!Number.isSafeInteger(info.size) || info.size < 0) {
        throw new Error("Stored object has an invalid size")
      }
      range = validRange(input.start, input.end, info.size)
      await this.assertHandleMatchesPath(filePath, handle, info)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }

    const size = range ? range.end - range.start + 1 : info.size
    const etag = `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`
    return {
      body: this.streamRegularFile(filePath, handle, info, range),
      size,
      totalSize: info.size,
      contentType: "application/octet-stream",
      etag,
      lastModified: info.mtime,
      statusCode: range ? 206 : 200,
      contentRange: range
        ? `bytes ${range.start}-${range.end}/${info.size}`
        : undefined,
    }
  }

  async inspect(locator: StorageObjectLocator): Promise<StorageObjectMetadata> {
    if (locator.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    const { filePath } = await this.objectPath(locator.key)
    const { handle, info } = await this.openRegularFile(filePath)
    try {
      if (!Number.isSafeInteger(info.size) || info.size < 0) {
        throw new Error("Stored object has an invalid size")
      }
      await this.assertHandleMatchesPath(filePath, handle, info)
      return {
        size: info.size,
        contentType: "application/octet-stream",
        etag: `W/\"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}\"`,
        lastModified: info.mtime,
      }
    } finally {
      await this.close(handle)
    }
  }

  async computeChecksum(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }> {
    if (locator.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    const { filePath } = await this.objectPath(locator.key)
    const { handle, info } = await this.openRegularFile(filePath)
    const hash = createHash("sha256")
    let size = 0
    try {
      const stream = handle.createReadStream({ autoClose: false })
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += bytes.byteLength
          if (!Number.isSafeInteger(size) || size > info.size) {
            throw new Error("Stored object changed while it was being checksummed")
          }
          hash.update(bytes)
        }
      } catch (error) {
        stream.destroy()
        throw sanitizedProviderError("local", "checksum object", error)
      }
      const after = await withSanitizedProviderError(
        "local",
        "inspect object",
        () => handle.stat(),
      )
      if (
        size !== info.size ||
        after.dev !== info.dev ||
        after.ino !== info.ino ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs
      ) {
        throw new Error("Stored object changed while it was being checksummed")
      }
      await this.assertHandleMatchesPath(filePath, handle, after)
      return { size, checksumSha256: hash.digest("hex") }
    } finally {
      await this.close(handle)
    }
  }

  async delete(locator: StorageObjectLocator): Promise<void> {
    if (locator.bucket) {
      throw new Error("Local storage does not accept bucket overrides")
    }
    const { filePath } = await this.objectPath(locator.key)
    if (!(await this.assertSafeParent(filePath, true))) {
      return
    }
    let info: Stats
    try {
      info = await lstat(filePath)
    } catch (error) {
      if (safeProviderCode(error) === "ENOENT") {
        return
      }
      throw sanitizedProviderError("local", "inspect object", error)
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Stored object is not a regular file")
    }
    await withSanitizedProviderError("local", "delete object", () =>
      unlink(filePath),
    )
  }

  async exists(locator: StorageObjectLocator): Promise<boolean> {
    if (locator.bucket) {
      return false
    }
    const { filePath } = await this.objectPath(locator.key)
    if (!(await this.assertSafeParent(filePath, true))) {
      return false
    }
    try {
      const info = await lstat(filePath)
      return info.isFile() && !info.isSymbolicLink()
    } catch (error) {
      if (safeProviderCode(error) === "ENOENT") {
        return false
      }
      throw sanitizedProviderError("local", "inspect object", error)
    }
  }

  async createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor> {
    if (!this.signingKey || (this.signingKey.symmetricKeySize ?? 0) < 32) {
      throw new Error("Local signing secret is required for protected descriptors")
    }
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1) {
      throw new Error("Descriptor expiry must be a positive integer")
    }
    const key = validKey(locator.key)
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)
    const expiry = Math.floor(expiresAt.getTime() / 1000)
    const signature = this.signDescriptor(key, expiry)
    const encodedKey = key.split("/").map(encodeURIComponent).join("/")
    return {
      provider: this.provider,
      url: `digital-downloads-local://protected/${encodedKey}?expires=${expiry}&signature=${signature}`,
      expiresAt,
    }
  }

  verifyProtectedDescriptor(url: string, now = new Date()): StorageObjectLocator {
    if (!this.signingKey || (this.signingKey.symmetricKeySize ?? 0) < 32) {
      throw new Error("Local signing secret is required for protected descriptors")
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error("Protected local descriptor is invalid")
    }
    if (parsed.protocol !== "digital-downloads-local:") {
      throw new Error("Protected local descriptor has an invalid protocol")
    }
    if (parsed.hostname !== "protected") {
      throw new Error("Protected local descriptor has an invalid authority")
    }
    let rawKey: string
    try {
      rawKey = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent)
        .join("/")
    } catch {
      throw new Error("Protected local descriptor contains an invalid key")
    }
    const key = validKey(rawKey)
    const expiry = Number.parseInt(parsed.searchParams.get("expires") ?? "", 10)
    const supplied = parsed.searchParams.get("signature") ?? ""
    if (!Number.isSafeInteger(expiry) || expiry < Math.floor(now.getTime() / 1000)) {
      throw new Error("Protected local descriptor has expired")
    }
    const expected = this.signDescriptor(key, expiry)
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      throw new Error("Protected local descriptor signature is invalid")
    }
    return { key }
  }

  private signDescriptor(key: string, expiry: number): string {
    return createHmac("sha256", this.signingKey!)
      .update("medusa-digital-downloads/local-descriptor/v1\0")
      .update(key)
      .update("\0")
      .update(String(expiry))
      .digest("base64url")
  }
}
