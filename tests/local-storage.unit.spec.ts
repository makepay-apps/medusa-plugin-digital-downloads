import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { ProtectedLocalStorageDriver } from "../src/modules/digital-downloads/storage/local-driver"
import { sha256 } from "../src/modules/digital-downloads/utils/crypto"

const SIGNING_SECRET = "local-storage-signing-secret-32-bytes-minimum"

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describe("protected local storage", () => {
  let root: string
  let outside: string
  let driver: ProtectedLocalStorageDriver

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "digital-downloads-root-"))
    outside = await mkdtemp(path.join(os.tmpdir(), "digital-downloads-outside-"))
    driver = new ProtectedLocalStorageDriver({
      rootPath: root,
      signingSecret: SIGNING_SECRET,
    })
  })

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  })

  it("writes private files atomically and returns checksum metadata", async () => {
    const body = Buffer.from("protected payload")
    const result = await driver.put({
      key: "orders/order_1/guide.pdf",
      body,
      contentType: "application/pdf",
    })

    expect(result).toEqual({
      key: "orders/order_1/guide.pdf",
      size: body.byteLength,
      checksumSha256: sha256(body),
      etag: sha256(body),
    })
    expect(await readFile(path.join(root, result.key))).toEqual(body)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(root, result.key))).mode & 0o777).toBe(0o600)
    expect(await driver.exists({ key: result.key })).toBe(true)
  })

  it("finishes streamed uploads while retaining the handle for verification", async () => {
    const chunks = [Buffer.from("streamed "), Buffer.from("private payload")]
    const body = Buffer.concat(chunks)

    const result = await driver.putStream!({
      key: "uploads/release_1/ebook.pdf",
      body: Readable.from(chunks),
      contentType: "application/pdf",
      expectedSize: body.byteLength,
      checksumSha256: sha256(body),
    })

    expect(result).toEqual({
      key: "uploads/release_1/ebook.pdf",
      size: body.byteLength,
      checksumSha256: sha256(body),
      etag: sha256(body),
    })
    expect(await readFile(path.join(root, result.key))).toEqual(body)
    expect((await stat(path.join(root, result.key))).mode & 0o777).toBe(0o600)
  })

  it("removes streamed upload temporaries when size or checksum verification fails", async () => {
    const body = Buffer.from("streamed private payload")

    await expect(
      driver.putStream!({
        key: "uploads/release_1/short.pdf",
        body: Readable.from([body.subarray(0, -1)]),
        contentType: "application/pdf",
        expectedSize: body.byteLength,
      }),
    ).rejects.toThrow("declared content length")
    await expect(
      driver.putStream!({
        key: "uploads/release_1/bad-checksum.pdf",
        body: Readable.from([body]),
        contentType: "application/pdf",
        expectedSize: body.byteLength,
        checksumSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("checksum does not match")

    expect(
      await driver.exists({ key: "uploads/release_1/short.pdf" }),
    ).toBe(false)
    expect(
      await driver.exists({ key: "uploads/release_1/bad-checksum.pdf" }),
    ).toBe(false)
  })

  it("rejects broad and public roots before touching the filesystem", () => {
    expect(
      () =>
        new ProtectedLocalStorageDriver({
          rootPath: os.tmpdir(),
          signingSecret: SIGNING_SECRET,
        }),
    ).toThrow("Local storage root is too broad")
    expect(
      () =>
        new ProtectedLocalStorageDriver({
          rootPath: path.join(root, "public", "digital-downloads"),
          signingSecret: SIGNING_SECRET,
        }),
    ).toThrow("public or shared directory")
  })

  const posixIt = process.platform === "win32" ? it.skip : it

  posixIt(
    "rejects an existing permissive root without repairing it with chmod",
    async () => {
      const permissiveRoot = path.join(outside, "permissive-root")
      await mkdir(permissiveRoot, { mode: 0o755 })
      await chmod(permissiveRoot, 0o755)
      const unsafeDriver = new ProtectedLocalStorageDriver({
        rootPath: permissiveRoot,
        signingSecret: SIGNING_SECRET,
      })

      await expect(unsafeDriver.exists({ key: "probe.bin" })).rejects.toThrow(
        "must already be private",
      )
      expect((await stat(permissiveRoot)).mode & 0o777).toBe(0o755)
    },
  )

  it("rejects a symlink configured as the storage root", async () => {
    const actualRoot = path.join(outside, "actual-root")
    const linkedRoot = path.join(outside, "linked-root")
    await mkdir(actualRoot, { mode: 0o700 })
    await symlink(actualRoot, linkedRoot)
    const unsafeDriver = new ProtectedLocalStorageDriver({
      rootPath: linkedRoot,
      signingSecret: SIGNING_SECRET,
    })

    await expect(unsafeDriver.exists({ key: "probe.bin" })).rejects.toThrow(
      "must be a real directory",
    )
  })

  it("checks supplied digests and preserves an existing object by default", async () => {
    await expect(
      driver.put({
        key: "assets/bad.bin",
        body: Buffer.from("body"),
        contentType: "application/octet-stream",
        checksumSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("checksum does not match")
    expect(await driver.exists({ key: "assets/bad.bin" })).toBe(false)

    await driver.put({
      key: "assets/stable.bin",
      body: Buffer.from("first"),
      contentType: "application/octet-stream",
    })
    await expect(
      driver.put({
        key: "assets/stable.bin",
        body: Buffer.from("second"),
        contentType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(path.join(root, "assets/stable.bin"), "utf8")).toBe(
      "first",
    )

    await driver.put({
      key: "assets/stable.bin",
      body: Buffer.from("second"),
      contentType: "application/octet-stream",
      overwrite: true,
    })
    expect(await readFile(path.join(root, "assets/stable.bin"), "utf8")).toBe(
      "second",
    )
  })

  it("supports bounded byte ranges without changing the stored object", async () => {
    await driver.put({
      key: "media/video.bin",
      body: Buffer.from("0123456789"),
      contentType: "application/octet-stream",
    })

    const complete = await driver.get({ key: "media/video.bin" })
    const middle = await driver.get({ key: "media/video.bin", start: 2, end: 5 })
    const tail = await driver.get({ key: "media/video.bin", start: 8, end: 100 })

    expect(complete.body).toBeInstanceOf(Readable)
    expect(Buffer.isBuffer(complete.body)).toBe(false)
    expect(complete).toMatchObject({
      size: 10,
      totalSize: 10,
      statusCode: 200,
    })
    await expect(collect(complete.body)).resolves.toEqual(
      Buffer.from("0123456789"),
    )
    expect(middle).toMatchObject({
      size: 4,
      totalSize: 10,
      statusCode: 206,
      contentRange: "bytes 2-5/10",
    })
    await expect(collect(middle.body)).resolves.toEqual(Buffer.from("2345"))
    expect(tail).toMatchObject({
      contentRange: "bytes 8-9/10",
    })
    await expect(collect(tail.body)).resolves.toEqual(Buffer.from("89"))
    await expect(
      driver.get({ key: "media/video.bin", start: 10 }),
    ).rejects.toThrow("not satisfiable")
  })

  it("closes its validated file handle when the consumer aborts", async () => {
    await driver.put({
      key: "media/abort.bin",
      body: Buffer.alloc(2 * 1024 * 1024, 0x61),
      contentType: "application/octet-stream",
    })
    const closeSpy = jest.spyOn(driver as any, "close")
    const opened = await driver.get({ key: "media/abort.bin" })
    const closed = new Promise<void>((resolve) => opened.body.once("close", resolve))

    opened.body.destroy(new Error("consumer aborted"))
    // The explicit error has no pipeline listener in this focused test.
    opened.body.on("error", () => undefined)
    await closed

    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it("streams a large sparse object with bounded RSS instead of readFile buffering", async () => {
    const size = 256 * 1024 * 1024
    const target = path.join(root, "large-sparse.bin")
    const file = await open(target, "w", 0o600)
    await file.truncate(size)
    await file.close()

    const baseline = process.memoryUsage().rss
    let peak = baseline
    let received = 0
    const opened = await driver.get({ key: "large-sparse.bin" })
    expect(opened.body).toBeInstanceOf(Readable)
    for await (const chunk of opened.body) {
      received += Buffer.byteLength(chunk)
      peak = Math.max(peak, process.memoryUsage().rss)
    }

    expect(received).toBe(size)
    // RSS includes allocator arenas retained by earlier Jest cases and varies
    // across supported Node releases. Keep the ceiling well below the 256 MiB
    // object so this still catches whole-file buffering without flaking on
    // normal stream-buffer churn.
    expect(peak - baseline).toBeLessThan(160 * 1024 * 1024)
  })

  it.each([
    "../outside.bin",
    "nested/../../outside.bin",
    "/absolute.bin",
    "nested//file.bin",
    "nested/./file.bin",
    "nested\\file.bin",
    "nul\0file.bin",
  ])("rejects unsafe storage key %p", async (key) => {
    await expect(
      driver.put({
        key,
        body: Buffer.from("payload"),
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/Storage key/)
  })

  it("refuses parent and final symlinks that escape the configured root", async () => {
    await symlink(outside, path.join(root, "linked-parent"))
    await expect(
      driver.put({
        key: "linked-parent/escape.bin",
        body: Buffer.from("payload"),
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow("non-directory component")

    const outsideFile = path.join(outside, "secret.bin")
    await writeFile(outsideFile, "outside secret")
    await symlink(outsideFile, path.join(root, "linked-file.bin"))
    await expect(driver.get({ key: "linked-file.bin" })).rejects.toThrow(
      "not a regular file",
    )
    expect(await driver.exists({ key: "linked-file.bin" })).toBe(false)
  })

  posixIt("keeps reading from the validated handle when its path is replaced", async () => {
    const key = "assets/path-race.bin"
    const internal = Buffer.from("validated private bytes")
    const external = Buffer.from("outside attacker bytes")
    await driver.put({
      key,
      body: internal,
      contentType: "application/octet-stream",
    })
    const externalFile = path.join(outside, "attacker.bin")
    await writeFile(externalFile, external)

    const closeSpy = jest.spyOn(driver as any, "close")
    const opened = await driver.get({ key })
    const storedPath = path.join(root, key)
    await unlink(storedPath)
    await symlink(externalFile, storedPath)

    const chunks: Buffer[] = []
    let failure: unknown
    try {
      for await (const chunk of opened.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
    } catch (error) {
      failure = error
    }

    expect(Buffer.concat(chunks)).toEqual(internal)
    expect(Buffer.concat(chunks)).not.toEqual(external)
    expect(failure).toMatchObject({
      name: "StorageProviderError",
      code: "LOCAL_IO_ERROR",
    })
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  posixIt(
    "fails closed when an opened object is truncated before EOF",
    async () => {
      const key = "assets/truncated.bin"
      await driver.put({
        key,
        body: Buffer.from("0123456789"),
        contentType: "application/octet-stream",
      })
      const closeSpy = jest.spyOn(driver as any, "close")
      const opened = await driver.get({ key })
      await truncate(path.join(root, key), 3)

      const failure = await collect(opened.body).catch((error) => error)
      expect(failure).toMatchObject({
        name: "StorageProviderError",
        code: "LOCAL_IO_ERROR",
      })
      expect(failure).not.toHaveProperty("path")
      expect(failure).not.toHaveProperty("cause")
      expect(JSON.stringify(failure)).not.toContain(root)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    },
  )

  it("signs short-lived descriptors and rejects tampering and expiry", async () => {
    await mkdir(path.join(root, "assets"), { recursive: true })
    const descriptor = await driver.createProtectedDescriptor(
      { key: "assets/manual #1.pdf" },
      60,
    )

    expect(descriptor.url).not.toContain("manual #1.pdf")
    expect(driver.verifyProtectedDescriptor(descriptor.url)).toEqual({
      key: "assets/manual #1.pdf",
    })

    const tampered = new URL(descriptor.url)
    tampered.searchParams.set("signature", "A".repeat(43))
    expect(() => driver.verifyProtectedDescriptor(tampered.toString())).toThrow(
      "signature is invalid",
    )
    expect(() =>
      driver.verifyProtectedDescriptor(
        descriptor.url,
        new Date(descriptor.expiresAt.getTime() + 1_000),
      ),
    ).toThrow("has expired")
  })

  it("deletes idempotently and rejects local bucket overrides", async () => {
    await driver.put({
      key: "assets/delete.bin",
      body: Buffer.from("payload"),
      contentType: "application/octet-stream",
    })
    await driver.delete({ key: "assets/delete.bin" })
    await driver.delete({ key: "assets/delete.bin" })

    expect(await driver.exists({ key: "assets/delete.bin" })).toBe(false)
    await expect(
      driver.get({ key: "assets/delete.bin", bucket: "other" }),
    ).rejects.toThrow("does not accept bucket overrides")
  })
})
