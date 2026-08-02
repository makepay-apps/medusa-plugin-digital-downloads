import { randomUUID } from "node:crypto"
import type { Readable } from "node:stream"

import { S3CompatibleStorageDriver } from "../../src/modules/digital-downloads/storage/s3-driver"
import type { ResolvedDigitalDownloadsModuleOptions } from "../../src/modules/digital-downloads/types"
import { sha256 } from "../../src/modules/digital-downloads/utils/crypto"

const requiredEnvironment = {
  DIGITAL_DOWNLOADS_MINIO_ENDPOINT:
    process.env.DIGITAL_DOWNLOADS_MINIO_ENDPOINT,
  DIGITAL_DOWNLOADS_MINIO_BUCKET: process.env.DIGITAL_DOWNLOADS_MINIO_BUCKET,
  DIGITAL_DOWNLOADS_MINIO_ACCESS_KEY_ID:
    process.env.DIGITAL_DOWNLOADS_MINIO_ACCESS_KEY_ID,
  DIGITAL_DOWNLOADS_MINIO_SECRET_ACCESS_KEY:
    process.env.DIGITAL_DOWNLOADS_MINIO_SECRET_ACCESS_KEY,
}
const missingEnvironment = Object.entries(requiredEnvironment)
  .filter(([, value]) => !value)
  .map(([name]) => name)
const describeMinio = missingEnvironment.length ? describe.skip : describe

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

describeMinio(
  `real MinIO compatibility${
    missingEnvironment.length
      ? ` (missing ${missingEnvironment.join(", ")})`
      : ""
  }`,
  () => {
    let options: NonNullable<
      ResolvedDigitalDownloadsModuleOptions["storage"]["s3"]
    >
    let driver: S3CompatibleStorageDriver
    const key = "private/range-object.bin"

    beforeAll(() => {
      const endpoint =
        requiredEnvironment.DIGITAL_DOWNLOADS_MINIO_ENDPOINT as string
      options = {
        endpoint,
        region: process.env.DIGITAL_DOWNLOADS_MINIO_REGION ?? "us-east-1",
        bucket: requiredEnvironment.DIGITAL_DOWNLOADS_MINIO_BUCKET as string,
        accessKeyId:
          requiredEnvironment.DIGITAL_DOWNLOADS_MINIO_ACCESS_KEY_ID as string,
        secretAccessKey:
          requiredEnvironment.DIGITAL_DOWNLOADS_MINIO_SECRET_ACCESS_KEY as string,
        forcePathStyle: true,
        allowInsecureEndpoint: new URL(endpoint).protocol === "http:",
        prefix: `integration-tests/${randomUUID()}`,
      }
      driver = new S3CompatibleStorageDriver(options)
    })

    afterAll(async () => {
      await driver.delete({ key }).catch(() => undefined)
      ;(driver as unknown as { client: { destroy: () => void } }).client.destroy()
    })

    it("round-trips a private object, supports ranges, and serves a bounded presigned URL", async () => {
      const body = Buffer.from("0123456789")
      await expect(
        driver.put({
          key,
          body,
          contentType: "application/octet-stream",
          checksumSha256: sha256(body),
        }),
      ).resolves.toMatchObject({
        key,
        size: body.byteLength,
        checksumSha256: sha256(body),
      })
      await expect(driver.exists({ key })).resolves.toBe(true)
      const ranged = await driver.get({ key, start: 2, end: 5 })
      expect(ranged).toMatchObject({
        size: 4,
        totalSize: 10,
        statusCode: 206,
        contentRange: "bytes 2-5/10",
      })
      await expect(collect(ranged.body)).resolves.toEqual(Buffer.from("2345"))

      const descriptor = await driver.createProtectedDescriptor({ key }, 60)
      const response = await fetch(descriptor.url)
      expect(response.status).toBe(200)
      await expect(response.arrayBuffer()).resolves.toEqual(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      )
      expect(descriptor.expiresAt.getTime()).toBeGreaterThan(Date.now())
      expect(descriptor.url).not.toContain(options.secretAccessKey)
    })
  },
)
