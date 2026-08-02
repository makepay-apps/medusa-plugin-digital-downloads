import path from "node:path"

import { DigitalStorageProvider } from "../src/modules/digital-downloads/types"
import {
  assertMimeTypeAllowed,
  assertSafeAttribution,
  resolveDigitalDownloadsOptions,
} from "../src/modules/digital-downloads/utils/options"

const SECRET = "s".repeat(32)
const ENCRYPTION_KEY = "e".repeat(64)

describe("digital-download module options", () => {
  it("resolves bounded local-storage defaults without reading ambient secrets", () => {
    const options = resolveDigitalDownloadsOptions({}, {})

    expect(options).toMatchObject({
      defaultDownloadLimit: 5,
      defaultGrantTtlSeconds: 900,
      maxGrantTtlSeconds: 86_400,
      maxUploadSizeBytes: 5 * 1024 * 1024 * 1024,
      allowedMimeTypes: [],
      allowGuestAccess: true,
      storage: { defaultProvider: DigitalStorageProvider.LOCAL },
    })
    expect(path.isAbsolute(options.storage.local.rootPath)).toBe(true)
    expect(options.storage.local.signingSecret).toBe("")
  })

  it("normalizes MIME policy and reads secrets from explicit environment input", () => {
    const options = resolveDigitalDownloadsOptions(
      {
        allowedMimeTypes: ["Audio/*", "audio/*", "application/pdf"],
        storage: { local: { rootPath: "./private-assets" } },
      },
      {
        DIGITAL_DOWNLOADS_TOKEN_SECRET: SECRET,
        DIGITAL_DOWNLOADS_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    )

    expect(options.allowedMimeTypes).toEqual(["audio/*", "application/pdf"])
    expect(options.tokenSecret).toBe(SECRET)
    expect(options.encryptionKey).toBe(ENCRYPTION_KEY)
    expect(options.storage.local.signingSecret).toBe(SECRET)
    expect(options.storage.local.rootPath).toBe(
      path.resolve("./private-assets"),
    )
  })

  it("rejects invalid counts, TTL relationships, and short secrets", () => {
    expect(() =>
      resolveDigitalDownloadsOptions({ defaultGrantTtlSeconds: 29 }, {}),
    ).toThrow("defaultGrantTtlSeconds must be an integer between 30")
    expect(() =>
      resolveDigitalDownloadsOptions(
        { defaultGrantTtlSeconds: 900, maxGrantTtlSeconds: 899 },
        {},
      ),
    ).toThrow("maxGrantTtlSeconds must be an integer between 900")
    expect(() =>
      resolveDigitalDownloadsOptions({ defaultDownloadLimit: -1 }, {}),
    ).toThrow("defaultDownloadLimit must be an integer between 0")
    expect(() =>
      resolveDigitalDownloadsOptions({ tokenSecret: "too-short" }, {}),
    ).toThrow("tokenSecret must contain at least 32 bytes")
  })

  it("requires a dedicated 32-byte hexadecimal encryption key", () => {
    for (const encryptionKey of [
      "e".repeat(63),
      "e".repeat(65),
      "z".repeat(64),
      "🔐".repeat(32),
    ]) {
      expect(() =>
        resolveDigitalDownloadsOptions({ encryptionKey }, {}),
      ).toThrow(
        "encryptionKey must be exactly 64 hexadecimal characters (32 bytes)",
      )
    }

    expect(() =>
      resolveDigitalDownloadsOptions(
        { tokenSecret: ENCRYPTION_KEY, encryptionKey: ENCRYPTION_KEY },
        {},
      ),
    ).toThrow("encryptionKey must be different from tokenSecret")

    expect(
      resolveDigitalDownloadsOptions(
        { tokenSecret: SECRET, encryptionKey: ENCRYPTION_KEY },
        {},
      ).encryptionKey,
    ).toBe(ENCRYPTION_KEY)
  })

  it("requires complete S3 credentials and HTTPS unless explicitly allowed", () => {
    expect(() =>
      resolveDigitalDownloadsOptions(
        {
          storage: {
            defaultProvider: DigitalStorageProvider.S3,
          },
        },
        {},
      ),
    ).toThrow("S3 is the default provider")

    expect(() =>
      resolveDigitalDownloadsOptions(
        {
          storage: {
            s3: {
              bucket: "private-assets",
              accessKeyId: "access",
              secretAccessKey: "secret",
              endpoint: "http://minio.example.test",
            },
          },
        },
        {},
      ),
    ).toThrow("must use HTTPS")

    const options = resolveDigitalDownloadsOptions(
      {
        storage: {
          defaultProvider: DigitalStorageProvider.S3,
          s3: {
            bucket: "private-assets",
            accessKeyId: "access",
            secretAccessKey: "secret",
            endpoint: "http://127.0.0.1:9000/",
            allowInsecureEndpoint: true,
            forcePathStyle: true,
            prefix: "/tenant-a/files/",
          },
        },
      },
      {},
    )

    expect(options.storage.s3).toMatchObject({
      endpoint: "http://127.0.0.1:9000",
      prefix: "tenant-a/files",
      forcePathStyle: true,
    })
  })

  it("rejects unsafe S3 topology and key prefixes", () => {
    const base = {
      bucket: "private-assets",
      accessKeyId: "access",
      secretAccessKey: "secret",
    }

    expect(() =>
      resolveDigitalDownloadsOptions(
        { storage: { s3: { ...base, endpoint: "ftp://storage.example" } } },
        {},
      ),
    ).toThrow("must use HTTP or HTTPS")
    expect(() =>
      resolveDigitalDownloadsOptions(
        {
          storage: {
            s3: {
              ...base,
              endpoint: "https://user:password@storage.example",
            },
          },
        },
        {},
      ),
    ).toThrow("cannot include credentials")
    expect(() =>
      resolveDigitalDownloadsOptions(
        { storage: { s3: { ...base, prefix: "tenant/../other" } } },
        {},
      ),
    ).toThrow("cannot contain parent-directory segments")
  })
})

describe("merchant-visible policy", () => {
  it("matches exact and wildcard MIME rules after removing parameters", () => {
    expect(() => assertMimeTypeAllowed("audio/mpeg; charset=binary", ["audio/*"]))
      .not.toThrow()
    expect(() => assertMimeTypeAllowed("application/pdf", ["application/pdf"]))
      .not.toThrow()
    expect(() => assertMimeTypeAllowed("text/html", ["application/*"]))
      .toThrow("MIME type text/html is not allowed")
    expect(() => assertMimeTypeAllowed("bad\r\nvalue", [])).toThrow(
      "Invalid MIME type",
    )
  })

  it("keeps the public attribution fixed and non-HTML", () => {
    expect(() =>
      assertSafeAttribution({
        attribution_label:
          "Brought to you by MakePay.io — crypto payment gateway.",
        attribution_url: "https://makepay.io",
      }),
    ).not.toThrow()
    expect(() =>
      assertSafeAttribution({ attribution_label: "<script>alert(1)</script>" }),
    ).toThrow("fixed and cannot contain custom content")
    expect(() =>
      assertSafeAttribution({ attribution_url: "javascript:alert(1)" }),
    ).toThrow("fixed to https://makepay.io")
  })
})
