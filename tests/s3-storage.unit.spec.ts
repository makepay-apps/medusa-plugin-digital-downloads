import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Readable } from "node:stream"

import { S3CompatibleStorageDriver } from "../src/modules/digital-downloads/storage/s3-driver"
import type { ResolvedDigitalDownloadsModuleOptions } from "../src/modules/digital-downloads/types"
import { sha256 } from "../src/modules/digital-downloads/utils/crypto"

jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3")
  return { ...actual, S3Client: jest.fn() }
})

jest.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: jest.fn(),
}))

const options: NonNullable<
  ResolvedDigitalDownloadsModuleOptions["storage"]["s3"]
> = {
  endpoint: "https://objects.example.test/api/",
  region: "us-east-1",
  bucket: "private-assets",
  accessKeyId: "TESTACCESS",
  secretAccessKey: "super-secret-signing-key",
  forcePathStyle: true,
  allowInsecureEndpoint: false,
  prefix: "tenant-a",
}

type MockClient = {
  send: jest.Mock
  destroy: jest.Mock
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describe("S3-compatible protected storage", () => {
  const clients: MockClient[] = []
  const signedUrlMock = jest.mocked(getSignedUrl)

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-01T00:00:00.000Z"))
    jest.mocked(S3Client).mockImplementation(() => {
      const client: MockClient = {
        send: jest.fn(),
        destroy: jest.fn(),
      }
      clients.push(client)
      return client as unknown as S3Client
    })
    signedUrlMock.mockResolvedValue(
      "https://objects.example.test/api/private-assets/tenant-a/manuals/guide%20%231.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=abc123",
    )
  })

  afterEach(() => {
    for (const client of clients.splice(0)) {
      if (client.destroy.mock.calls.length === 0) {
        client.destroy()
      }
      expect(client.destroy).toHaveBeenCalledTimes(1)
    }
    jest.useRealTimers()
  })

  function driverAndClient() {
    const driver = new S3CompatibleStorageDriver(options)
    return { driver, client: clients[clients.length - 1] as MockClient }
  }

  function expectRedactedProviderFailure(
    failure: any,
    rawError: Error,
    code = "S3_PROVIDER_ERROR",
  ) {
    expect(failure).not.toBe(rawError)
    expect(failure).toMatchObject({
      name: "StorageProviderError",
      code,
      status: 502,
    })
    expect(failure).not.toHaveProperty("$metadata")
    expect(failure).not.toHaveProperty("$response")
    expect(failure).not.toHaveProperty("request")
    expect(failure).not.toHaveProperty("cause")
    expect(`${failure.message}\n${JSON.stringify(failure)}`).not.toMatch(
      /TESTACCESS|super-secret-signing-key|raw-provider-detail/,
    )
  }

  it("uses an atomic conditional PutObject and never returns credentials", async () => {
    const { driver, client } = driverAndClient()
    client.send.mockResolvedValue({ ETag: '"server-etag"' })
    const body = Buffer.from("protected payload")

    await expect(
      driver.put({
        key: "orders/order 1/guide.pdf",
        body,
        contentType: "application/pdf",
        checksumSha256: sha256(body),
      }),
    ).resolves.toEqual({
      key: "orders/order 1/guide.pdf",
      size: body.byteLength,
      checksumSha256: sha256(body),
      etag: "server-etag",
    })

    expect(client.send).toHaveBeenCalledTimes(1)
    const command = client.send.mock.calls[0][0]
    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input).toMatchObject({
      Bucket: "private-assets",
      Key: "tenant-a/orders/order 1/guide.pdf",
      Body: body,
      ContentType: "application/pdf",
      ContentLength: body.byteLength,
      ChecksumSHA256: Buffer.from(sha256(body), "hex").toString("base64"),
      IfNoneMatch: "*",
    })
    expect(JSON.stringify(command.input)).not.toMatch(/super-secret|TESTACCESS/)
  })

  it("signs upload length, conditional-create, checksum, and content-type headers", async () => {
    const { driver, client } = driverAndClient()
    const checksumSha256 = sha256("signed upload body")
    const checksumBase64 = Buffer.from(checksumSha256, "hex").toString("base64")

    const descriptor = await driver.createUploadDescriptor(
      { key: "uploads/order 1/asset.bin" },
      {
        contentType: "application/octet-stream",
        expectedSize: 18,
        checksumSha256,
      },
      900,
    )

    expect(signedUrlMock).toHaveBeenCalledTimes(1)
    expect(signedUrlMock.mock.calls[0][0]).toBe(client as unknown as S3Client)
    expect(signedUrlMock.mock.calls[0][1]).toBeInstanceOf(PutObjectCommand)
    expect(signedUrlMock.mock.calls[0][1].input).toEqual({
      Bucket: "private-assets",
      Key: "tenant-a/uploads/order 1/asset.bin",
      ContentType: "application/octet-stream",
      ContentLength: 18,
      ChecksumSHA256: checksumBase64,
      IfNoneMatch: "*",
    })
    expect(signedUrlMock.mock.calls[0][2]).toEqual({ expiresIn: 900 })
    expect(descriptor).toMatchObject({
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "18",
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksumBase64,
      },
    })
    expect(descriptor.expiresAt.toISOString()).toBe(
      "2026-08-01T00:15:00.000Z",
    )
    expect(descriptor.url).not.toMatch(/super-secret|TESTACCESS/)
  })

  it("requests one bounded range and validates returned size metadata", async () => {
    const { driver, client } = driverAndClient()
    const source = Readable.from([Buffer.from("2345")]) as Readable & {
      transformToByteArray: jest.Mock
    }
    source.transformToByteArray = jest.fn(() => {
      throw new Error("buffer conversion must not be called")
    })
    client.send.mockResolvedValue({
      Body: source,
      ContentLength: 4,
      ContentRange: "bytes 2-5/10",
      ContentType: "application/octet-stream",
      ETag: '"range-etag"',
    })

    const opened = await driver.get({ key: "media/video.bin", start: 2, end: 5 })
    expect(opened.body).toBeInstanceOf(Readable)
    expect(Buffer.isBuffer(opened.body)).toBe(false)
    expect(opened).toMatchObject({
      size: 4,
      totalSize: 10,
      statusCode: 206,
      contentRange: "bytes 2-5/10",
      etag: "range-etag",
    })
    await expect(collect(opened.body)).resolves.toEqual(Buffer.from("2345"))
    expect(source.transformToByteArray).not.toHaveBeenCalled()

    const command = client.send.mock.calls[0][0]
    expect(command).toBeInstanceOf(GetObjectCommand)
    expect(command.input).toMatchObject({
      Bucket: "private-assets",
      Key: "tenant-a/media/video.bin",
      Range: "bytes=2-5",
    })
    await expect(
      driver.get({ key: "media/video.bin", start: 7, end: 2 }),
    ).rejects.toThrow("Requested byte range is invalid")
    expect(client.send).toHaveBeenCalledTimes(1)
  })

  it("streams complete objects and enforces the declared byte count", async () => {
    const { driver, client } = driverAndClient()
    client.send.mockResolvedValue({
      Body: Readable.from([Buffer.from("complete")]),
      ContentLength: 8,
      ContentType: "text/plain",
      ETag: '"full-etag"',
    })

    const opened = await driver.get({ key: "complete.txt" })
    expect(opened).toMatchObject({
      size: 8,
      totalSize: 8,
      statusCode: 200,
      etag: "full-etag",
    })
    await expect(collect(opened.body)).resolves.toEqual(Buffer.from("complete"))

    client.send.mockResolvedValueOnce({
      Body: Readable.from([Buffer.from("short")]),
      ContentLength: 8,
      ContentType: "text/plain",
    })
    const short = await driver.get({ key: "short.txt" })
    await expect(collect(short.body)).rejects.toMatchObject({
      name: "StorageProviderError",
      code: "S3_PROVIDER_ERROR",
    })
  })

  it("sanitizes late provider stream errors and destroys the source on abort", async () => {
    const { driver, client } = driverAndClient()
    const rawError = Object.assign(new Error("Authorization: SECRETACCESS"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
      $response: {
        body: { request: { headers: { authorization: "SECRETACCESS" } } },
      },
    })
    let read = false
    const failingSource = new Readable({
      read() {
        if (read) return
        read = true
        this.push(Buffer.from("12"))
        this.destroy(rawError)
      },
    })
    client.send.mockResolvedValueOnce({
      Body: failingSource,
      ContentLength: 4,
      ContentType: "application/octet-stream",
    })
    const failing = await driver.get({ key: "late-error.bin" })
    const sanitized = await collect(failing.body).catch((error) => error)
    expect(sanitized).not.toBe(rawError)
    expect(sanitized).toMatchObject({
      name: "StorageProviderError",
      code: "AccessDenied",
      status: 403,
    })
    expect(sanitized).not.toHaveProperty("$response")
    expect(sanitized).not.toHaveProperty("cause")
    expect(JSON.stringify(sanitized)).not.toContain("SECRETACCESS")

    const abortSource = new Readable({
      read() {
        this.push(Buffer.alloc(64 * 1024))
      },
    })
    client.send.mockResolvedValueOnce({
      Body: abortSource,
      ContentLength: 1024 * 1024,
      ContentType: "application/octet-stream",
    })
    const aborted = await driver.get({ key: "abort.bin" })
    const closed = new Promise<void>((resolve) => aborted.body.once("close", resolve))
    aborted.body.destroy()
    await closed
    expect(abortSource.destroyed).toBe(true)
  })

  it("redacts raw request and signer failures instead of retaining provider objects", async () => {
    const { driver, client } = driverAndClient()
    const rawError = Object.assign(
      new Error(
        "raw-provider-detail TESTACCESS super-secret-signing-key",
      ),
      {
        name: "ProviderMessageContainingCustomerData",
        code: "raw-provider-detail",
        statusCode: 502,
        $metadata: { httpStatusCode: 502, requestId: "raw-provider-detail" },
        $response: {
          request: {
            headers: { authorization: "TESTACCESS" },
          },
        },
        request: { endpoint: options.endpoint },
        cause: new Error("super-secret-signing-key"),
      },
    )

    client.send.mockRejectedValueOnce(rawError)
    const requestFailure = await driver
      .put({
        key: "assets/request-failure.bin",
        body: Buffer.from("body"),
        contentType: "application/octet-stream",
      })
      .catch((error) => error)
    expectRedactedProviderFailure(requestFailure, rawError)

    signedUrlMock.mockRejectedValueOnce(rawError)
    const signerFailure = await driver
      .createProtectedDescriptor({ key: "assets/sign-failure.bin" }, 60)
      .catch((error) => error)
    expectRedactedProviderFailure(signerFailure, rawError)
  })

  it("sanitizes late checksum-stream failures and releases the provider stream", async () => {
    const { driver, client } = driverAndClient()
    const rawError = Object.assign(
      new Error("raw-provider-detail super-secret-signing-key"),
      {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 502 },
        $response: { authorization: "TESTACCESS" },
        cause: new Error("raw-provider-detail"),
      },
    )
    let read = false
    const source = new Readable({
      read() {
        if (read) return
        read = true
        this.push(Buffer.from("partial"))
        this.destroy(rawError)
      },
    })
    client.send.mockResolvedValueOnce({ Body: source, ContentLength: 7 })

    const failure = await driver
      .computeChecksum({ key: "assets/checksum-failure.bin" })
      .catch((error) => error)
    expectRedactedProviderFailure(failure, rawError, "AccessDenied")
    expect(source.destroyed).toBe(true)
  })

  it("destroys its SDK client once and sanitizes cleanup failures", () => {
    const { driver, client } = driverAndClient()
    driver.destroy()
    expect(client.destroy).toHaveBeenCalledTimes(1)

    const { driver: failingDriver, client: failingClient } = driverAndClient()
    const rawError = Object.assign(
      new Error("raw-provider-detail super-secret-signing-key"),
      {
        name: "NetworkingError",
        $metadata: { httpStatusCode: 502 },
        request: { authorization: "TESTACCESS" },
      },
    )
    failingClient.destroy.mockImplementationOnce(() => {
      throw rawError
    })

    let failure: unknown
    try {
      failingDriver.destroy()
    } catch (error) {
      failure = error
    }
    expectRedactedProviderFailure(failure, rawError, "NetworkingError")
    expect(failingClient.destroy).toHaveBeenCalledTimes(1)
  })

  it("creates a bounded protected descriptor without exposing credentials", async () => {
    const { driver, client } = driverAndClient()

    const descriptor = await driver.createProtectedDescriptor(
      { key: "manuals/guide #1.pdf" },
      300,
    )

    expect(signedUrlMock).toHaveBeenCalledTimes(1)
    expect(signedUrlMock.mock.calls[0][0]).toBe(
      client as unknown as S3Client,
    )
    expect(signedUrlMock.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand)
    expect(signedUrlMock.mock.calls[0][1].input).toMatchObject({
      Bucket: "private-assets",
      Key: "tenant-a/manuals/guide #1.pdf",
    })
    expect(signedUrlMock.mock.calls[0][2]).toEqual({ expiresIn: 300 })
    expect(descriptor.url).not.toMatch(/super-secret|TESTACCESS/)
    expect(descriptor.expiresAt.toISOString()).toBe(
      "2026-08-01T00:05:00.000Z",
    )

    await expect(
      driver.createProtectedDescriptor({ key: "manuals/guide.pdf" }, 0),
    ).rejects.toThrow("between 1 and 604800 seconds")
  })

  it("maps HEAD 404s, deletes explicitly, and sanitizes non-404 provider errors", async () => {
    const { driver, client } = driverAndClient()
    const notFound = Object.assign(new Error("not found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    })
    const denied = Object.assign(new Error("access denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    })
    client.send
      .mockRejectedValueOnce(notFound)
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(denied)

    await expect(driver.exists({ key: "missing.bin" })).resolves.toBe(false)
    await expect(driver.delete({ key: "delete.bin" })).resolves.toBeUndefined()
    await expect(driver.exists({ key: "private.bin" })).rejects.toMatchObject({
      name: "StorageProviderError",
      code: "AccessDenied",
      status: 403,
    })
    client.send.mockRejectedValueOnce(denied)
    const sanitized = await driver
      .exists({ key: "private-again.bin" })
      .catch((error) => error)
    expect(sanitized).not.toBe(denied)
    expect(sanitized).not.toHaveProperty("$metadata")
    expect(sanitized).not.toHaveProperty("$response")
    expect(sanitized).not.toHaveProperty("cause")

    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand)
    expect(client.send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand)
    expect(client.send.mock.calls[2][0]).toBeInstanceOf(HeadObjectCommand)
  })

  it("rejects unsafe keys, bucket overrides, and checksum mismatches before I/O", async () => {
    const { driver, client } = driverAndClient()

    await expect(driver.exists({ key: "../escape.bin" })).rejects.toThrow(
      "S3 object key is invalid",
    )
    await expect(
      driver.exists({ key: "safe.bin", bucket: "Bad_Bucket" }),
    ).rejects.toThrow("S3 bucket override is invalid")
    await expect(
      driver.put({
        key: "safe.bin",
        body: Buffer.from("contents"),
        contentType: "application/octet-stream",
        checksumSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("checksum does not match")
    expect(client.send).not.toHaveBeenCalled()
  })
})
