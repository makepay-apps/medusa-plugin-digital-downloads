import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { createHash } from "node:crypto"
import { Readable } from "node:stream"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { DigitalStorageProvider } from "../types"
import type { ResolvedDigitalDownloadsModuleOptions } from "../types"
import { sha256 } from "../utils"
import {
  safeProviderCode,
  safeProviderStatus,
  sanitizedProviderError,
  withSanitizedProviderError,
  withSanitizedProviderErrorSync,
} from "./errors"
import type {
  ProtectedStorageDescriptor,
  StorageDriver,
  StorageObjectLocator,
  StorageObjectMetadata,
  StorageObjectResult,
  StoragePutInput,
  StorageReadInput,
  StorageUploadDescriptor,
} from "./types"

type S3Options = NonNullable<
  ResolvedDigitalDownloadsModuleOptions["storage"]["s3"]
>

function normalizeKey(key: string, prefix: string): string {
  if (
    !key ||
    key.length > 1024 ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.startsWith("/") ||
    key.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("S3 object key is invalid")
  }
  return prefix ? `${prefix}/${key}` : key
}

function isNotFound(error: unknown): boolean {
  const code = safeProviderCode(error)
  return (
    safeProviderStatus(error) === 404 ||
    code === "NotFound" ||
    code === "NoSuchKey"
  )
}

function parseContentRange(value: string | undefined): {
  start: number
  end: number
  total: number
} | undefined {
  if (!value) {
    return undefined
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value)
  if (!match) {
    throw new Error("S3 returned an invalid content range")
  }
  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2], 10)
  const total = Number.parseInt(match[3], 10)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total < 1 ||
    end >= total
  ) {
    throw new Error("S3 returned invalid content range values")
  }
  return { start, end, total }
}

function nodeReadable(body: unknown): Readable {
  if (body instanceof Readable) {
    return body
  }
  if (!body || (typeof body !== "object" && typeof body !== "function")) {
    throw new Error("S3 returned an unsupported response body")
  }
  const candidate = body as {
    pipe?: unknown
    transformToWebStream?: () => ReadableStream<Uint8Array>
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>
  }
  if (typeof candidate.pipe === "function") {
    return candidate as unknown as Readable
  }
  if (typeof candidate.transformToWebStream === "function") {
    return Readable.fromWeb(
      candidate.transformToWebStream() as unknown as import("node:stream/web").ReadableStream,
    )
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    return Readable.from(candidate as AsyncIterable<Uint8Array>)
  }
  throw new Error("S3 returned an unsupported response body")
}

/**
 * A fresh wrapper prevents late SDK stream errors from leaking request,
 * endpoint, authorization, or credential-bearing objects through `error`.
 */
function sanitizedS3Readable(source: Readable, expectedSize: number): Readable {
  async function* verifiedBytes(): AsyncGenerator<Buffer> {
    let streamed = 0
    try {
      for await (const chunk of source) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        streamed += bytes.byteLength
        if (!Number.isSafeInteger(streamed) || streamed > expectedSize) {
          throw new Error("S3 response exceeded its declared content length")
        }
        yield bytes
      }
      if (streamed !== expectedSize) {
        throw new Error("S3 response ended before its declared content length")
      }
    } catch (error) {
      throw sanitizedProviderError("s3", "stream object", error)
    } finally {
      source.destroy()
    }
  }

  const body = Readable.from(verifiedBytes())
  body.once("close", () => source.destroy())
  return body
}

/** AWS SDK-backed driver that also works with MinIO and other S3-compatible APIs. */
export class S3CompatibleStorageDriver implements StorageDriver {
  readonly provider = DigitalStorageProvider.S3
  private readonly bucketName: string
  private readonly prefix: string
  private readonly client: S3Client

  constructor(options: S3Options, client?: S3Client) {
    this.bucketName = options.bucket
    this.prefix = options.prefix
    if (client) {
      this.client = client
      return
    }
    try {
      this.client = new S3Client({
        endpoint: options.endpoint,
        region: options.region,
        forcePathStyle: options.forcePathStyle,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          sessionToken: options.sessionToken,
        },
      })
    } catch (error) {
      throw sanitizedProviderError("s3", "initialize client", error)
    }
  }

  destroy(): void {
    try {
      this.client.destroy()
    } catch (error) {
      throw sanitizedProviderError("s3", "destroy client", error)
    }
  }

  private bucket(locator: StorageObjectLocator): string {
    const bucket = locator.bucket || this.bucketName
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      throw new Error("S3 bucket override is invalid")
    }
    return bucket
  }

  private locator(locator: StorageObjectLocator): {
    Bucket: string
    Key: string
  } {
    return {
      Bucket: this.bucket(locator),
      Key: normalizeKey(locator.key, this.prefix),
    }
  }

  private command<T>(operation: string, factory: () => T): T {
    return withSanitizedProviderErrorSync("s3", operation, factory)
  }

  async put(input: StoragePutInput): Promise<{
    key: string
    size: number
    checksumSha256: string
    etag: string
  }> {
    const body = Buffer.from(input.body)
    const checksumSha256 = sha256(body)
    if (
      input.checksumSha256 &&
      input.checksumSha256.toLowerCase() !== checksumSha256
    ) {
      throw new Error("Object checksum does not match the supplied SHA-256")
    }
    const target = this.locator(input)
    const command = this.command(
      "prepare object write",
      () =>
        new PutObjectCommand({
          ...target,
          Body: body,
          ContentType: input.contentType,
          ContentLength: body.byteLength,
          ChecksumSHA256: Buffer.from(checksumSha256, "hex").toString("base64"),
          IfNoneMatch: input.overwrite ? undefined : "*",
        }),
    )
    const response = await withSanitizedProviderError("s3", "write object", () =>
      this.client.send(command),
    )
    return {
      key: input.key,
      size: body.byteLength,
      checksumSha256,
      etag: response.ETag?.replace(/^\"|\"$/g, "") ?? checksumSha256,
    }
  }

  async get(input: StorageReadInput): Promise<StorageObjectResult> {
    let range: string | undefined
    if (input.start !== undefined || input.end !== undefined) {
      const start = input.start ?? 0
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        (input.end !== undefined &&
          (!Number.isSafeInteger(input.end) || input.end < start))
      ) {
        throw new RangeError("Requested byte range is invalid")
      }
      range = `bytes=${start}-${input.end ?? ""}`
    }
    const target = this.locator(input)
    const command = this.command(
      "prepare object read",
      () => new GetObjectCommand({ ...target, Range: range }),
    )
    const response = await withSanitizedProviderError("s3", "read object", () =>
      this.client.send(command),
    )
    if (!response.Body) {
      throw new Error("S3 returned an empty response body")
    }
    let source: Readable
    try {
      source = nodeReadable(response.Body)
    } catch (error) {
      throw sanitizedProviderError("s3", "open object stream", error)
    }
    try {
      const returnedContentLength = response.ContentLength
      if (
        !Number.isSafeInteger(returnedContentLength) ||
        returnedContentLength! < 0
      ) {
        throw new Error("S3 returned an invalid content length")
      }
      const contentLength = returnedContentLength as number
      const parsedRange = parseContentRange(response.ContentRange)
      if (range) {
        if (!parsedRange) {
          throw new Error("S3 did not honor the requested byte range")
        }
        const requestedStart = input.start ?? 0
        const requestedEnd = Math.min(
          input.end ?? parsedRange.total - 1,
          parsedRange.total - 1,
        )
        if (
          parsedRange.start !== requestedStart ||
          parsedRange.end !== requestedEnd ||
          contentLength !== parsedRange.end - parsedRange.start + 1
        ) {
          throw new Error("S3 returned a mismatched byte range")
        }
      } else if (parsedRange) {
        throw new Error("S3 returned an unexpected content range")
      }

      const totalSize = parsedRange?.total ?? contentLength
      const etag =
        response.ETag?.replace(/^\"|\"$/g, "") ??
        `W/\"${totalSize.toString(16)}-${Math.trunc(response.LastModified?.getTime() ?? 0).toString(16)}\"`
      return {
        body: sanitizedS3Readable(source, contentLength),
        size: contentLength,
        totalSize,
        contentType: response.ContentType ?? "application/octet-stream",
        etag,
        lastModified: response.LastModified,
        statusCode: parsedRange ? 206 : 200,
        contentRange: response.ContentRange,
      }
    } catch (error) {
      source.destroy()
      throw error
    }
  }

  async delete(locator: StorageObjectLocator): Promise<void> {
    const target = this.locator(locator)
    const command = this.command(
      "prepare object delete",
      () => new DeleteObjectCommand(target),
    )
    await withSanitizedProviderError("s3", "delete object", () =>
      this.client.send(command),
    )
  }

  async exists(locator: StorageObjectLocator): Promise<boolean> {
    const target = this.locator(locator)
    const command = this.command(
      "prepare object inspection",
      () => new HeadObjectCommand(target),
    )
    try {
      await this.client.send(command)
      return true
    } catch (error) {
      if (isNotFound(error)) {
        return false
      }
      throw sanitizedProviderError("s3", "inspect object", error)
    }
  }

  async inspect(locator: StorageObjectLocator): Promise<StorageObjectMetadata> {
    const target = this.locator(locator)
    const command = this.command(
      "prepare object inspection",
      () =>
        new HeadObjectCommand({
          ...target,
          ChecksumMode: "ENABLED",
        }),
    )
    const response = await withSanitizedProviderError("s3", "inspect object", () =>
      this.client.send(command),
    )
    if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength! < 0) {
      throw new Error("S3 returned an invalid content length")
    }
    return {
      size: response.ContentLength as number,
      contentType: response.ContentType ?? "application/octet-stream",
      checksumSha256: response.ChecksumSHA256
        ? Buffer.from(response.ChecksumSHA256, "base64").toString("hex")
        : undefined,
      etag: response.ETag?.replace(/^\"|\"$/g, ""),
      lastModified: response.LastModified,
    }
  }

  async computeChecksum(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }> {
    const target = this.locator(locator)
    const command = this.command(
      "prepare checksum read",
      () => new GetObjectCommand(target),
    )
    const response = await withSanitizedProviderError(
      "s3",
      "read object for checksum",
      () => this.client.send(command),
    )
    if (!response.Body) {
      throw new Error("S3 returned an empty response body")
    }
    let source: Readable
    try {
      source = nodeReadable(response.Body)
    } catch (error) {
      throw sanitizedProviderError("s3", "open checksum stream", error)
    }
    if (
      !Number.isSafeInteger(response.ContentLength) ||
      response.ContentLength! < 0
    ) {
      source.destroy()
      throw new Error("S3 returned an invalid content length")
    }
    const body = sanitizedS3Readable(source, response.ContentLength as number)
    const hash = createHash("sha256")
    let size = 0
    try {
      for await (const chunk of body) {
        const bytes = Buffer.from(chunk)
        size += bytes.byteLength
        hash.update(bytes)
      }
    } catch (error) {
      throw sanitizedProviderError("s3", "stream object for checksum", error)
    } finally {
      body.destroy()
    }
    return { size, checksumSha256: hash.digest("hex") }
  }

  async createUploadDescriptor(
    locator: StorageObjectLocator,
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ): Promise<StorageUploadDescriptor> {
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 30 ||
      expiresInSeconds > 86400
    ) {
      throw new Error("S3 upload URL expiry must be between 30 and 86400 seconds")
    }
    const checksum = input.checksumSha256
      ? Buffer.from(input.checksumSha256, "hex").toString("base64")
      : undefined
    const target = this.locator(locator)
    const command = this.command(
      "prepare upload URL",
      () =>
        new PutObjectCommand({
          ...target,
          ContentType: input.contentType,
          ContentLength: input.expectedSize,
          ChecksumSHA256: checksum,
          IfNoneMatch: "*",
        }),
    )
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)
    const url = await withSanitizedProviderError("s3", "sign upload URL", () =>
      getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      }),
    )
    return {
      method: "PUT",
      url,
      expiresAt,
      headers: {
        "content-type": input.contentType,
        "if-none-match": "*",
        ...(input.expectedSize !== undefined
          ? { "content-length": String(input.expectedSize) }
          : {}),
        ...(checksum ? { "x-amz-checksum-sha256": checksum } : {}),
      },
    }
  }

  async createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor> {
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > 604800
    ) {
      throw new Error("S3 presigned URL expiry must be between 1 and 604800 seconds")
    }
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000)
    const target = this.locator(locator)
    const command = this.command(
      "prepare download URL",
      () => new GetObjectCommand(target),
    )
    const url = await withSanitizedProviderError(
      "s3",
      "sign download URL",
      () => getSignedUrl(this.client, command, { expiresIn: expiresInSeconds }),
    )
    return { provider: this.provider, url, expiresAt }
  }
}
