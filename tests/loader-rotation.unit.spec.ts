import path from "node:path"

import digitalDownloadsLoader from "../src/modules/digital-downloads/loaders"
import type { DigitalDownloadsModuleOptions } from "../src/modules/digital-downloads/types"
import {
  digitalDownloadsStorageNamespaceFingerprint,
  resolveDigitalDownloadsOptions,
  sha256,
} from "../src/modules/digital-downloads/utils"

const TOKEN_A = "token-secret-a".repeat(3)
const TOKEN_B = "token-secret-b".repeat(3)
const ENCRYPTION_A = "a".repeat(64)
const ENCRYPTION_B = "b".repeat(64)
const SIGNING_SECRET = "local-signing-secret".repeat(2)

const ROOT_A = path.resolve(process.cwd(), ".tmp/loader-rotation-a")
const ROOT_B = path.resolve(process.cwd(), ".tmp/loader-rotation-b")

function options(overrides: Partial<DigitalDownloadsModuleOptions> = {}) {
  return {
    tokenSecret: TOKEN_A,
    encryptionKey: ENCRYPTION_A,
    storage: {
      local: {
        rootPath: ROOT_A,
        signingSecret: SIGNING_SECRET,
      },
    },
    ...overrides,
  } satisfies DigitalDownloadsModuleOptions
}

function secretFingerprint(value: string, purpose: "token" | "encryption") {
  return sha256(`medusa-digital-downloads/${purpose}-secret/v1\0${value}`)
}

function persistedSettings(config: DigitalDownloadsModuleOptions) {
  const resolved = resolveDigitalDownloadsOptions(config, {})
  return {
    id: "ddset_global",
    singleton_key: "global",
    storage_namespace_fingerprint:
      digitalDownloadsStorageNamespaceFingerprint(resolved),
    storage_namespace_version: 1,
    token_secret_fingerprint: secretFingerprint(
      resolved.tokenSecret as string,
      "token",
    ),
    encryption_key_fingerprint: secretFingerprint(
      resolved.encryptionKey as string,
      "encryption",
    ),
    default_grant_ttl_seconds: resolved.defaultGrantTtlSeconds,
    max_grant_ttl_seconds: resolved.maxGrantTtlSeconds,
    guest_access_ttl_seconds: resolved.guestAccessTtlSeconds,
    max_upload_size_bytes: resolved.maxUploadSizeBytes,
    allow_guest_access: resolved.allowGuestAccess,
  }
}

function countService(count = 0) {
  return {
    listAndCount: jest.fn().mockResolvedValue([[], count]),
  }
}

function loaderHarness(
  current: ReturnType<typeof persistedSettings>,
  counts: Record<string, number> = {},
) {
  const settingsService = {
    listAndCount: jest.fn().mockResolvedValue([[current], 1]),
    create: jest.fn(),
    update: jest.fn().mockImplementation(async (change) => ({
      ...current,
      ...change,
    })),
  }
  const services: Record<string, ReturnType<typeof countService> | typeof settingsService> = {
    digitalDownloadsSettingsService: settingsService,
  }
  for (const name of [
    "digitalAssetService",
    "digitalUploadService",
    "downloadGrantService",
    "entitlementAccessSessionService",
    "downloadEventService",
    "licenseActivationService",
    "licenseAuditEventService",
    "notificationDeliveryService",
    "licensePoolKeyService",
  ]) {
    services[name] = countService(counts[name] ?? 0)
  }

  const container = {
    register: jest.fn(),
    resolve: jest.fn((name: string) => {
      const service = services[name]
      if (!service) {
        throw new Error(`Unexpected loader dependency: ${name}`)
      }
      return service
    }),
  }

  return { container, settingsService, services }
}

describe("digital-download loader rotation guards", () => {
  it("blocks a storage namespace change while assets exist", async () => {
    const original = options()
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
      { digitalAssetService: 1 },
    )
    const changed = options({
      storage: {
        local: { rootPath: ROOT_B, signingSecret: SIGNING_SECRET },
      },
    })

    await expect(
      digitalDownloadsLoader({ container, options: changed } as any),
    ).rejects.toThrow(/storage namespace is missing or changed/)
    expect(settingsService.update).not.toHaveBeenCalled()
  })

  it("blocks token-secret rotation while token-derived rows exist", async () => {
    const original = options()
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
      { downloadGrantService: 1 },
    )

    await expect(
      digitalDownloadsLoader({
        container,
        options: options({ tokenSecret: TOKEN_B }),
      } as any),
    ).rejects.toThrow(/token secret rotation is blocked/)
    expect(settingsService.update).not.toHaveBeenCalled()
  })

  it("blocks encryption-key rotation while encrypted license keys exist", async () => {
    const original = options()
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
      { licensePoolKeyService: 1 },
    )

    await expect(
      digitalDownloadsLoader({
        container,
        options: options({ encryptionKey: ENCRYPTION_B }),
      } as any),
    ).rejects.toThrow(/encryption-key rotation is blocked/)
    expect(settingsService.update).not.toHaveBeenCalled()
  })

  it("persists all new fingerprints together when no dependent rows exist", async () => {
    const original = options()
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
    )
    const changed = options({
      tokenSecret: TOKEN_B,
      encryptionKey: ENCRYPTION_B,
      storage: {
        local: { rootPath: ROOT_B, signingSecret: SIGNING_SECRET },
      },
    })
    const resolved = resolveDigitalDownloadsOptions(changed, {})

    await expect(
      digitalDownloadsLoader({ container, options: changed } as any),
    ).resolves.toBeUndefined()
    expect(settingsService.update).toHaveBeenCalledTimes(1)
    expect(settingsService.update).toHaveBeenCalledWith({
      id: "ddset_global",
      storage_namespace_fingerprint:
        digitalDownloadsStorageNamespaceFingerprint(resolved),
      storage_namespace_version: 1,
      token_secret_fingerprint: secretFingerprint(TOKEN_B, "token"),
      encryption_key_fingerprint: secretFingerprint(
        ENCRYPTION_B,
        "encryption",
      ),
    })
  })

  it("narrows a migration-seeded 30-day guest TTL to a one-day module policy", async () => {
    const original = options()
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
    )

    await expect(
      digitalDownloadsLoader({
        container,
        options: options({ guestAccessTtlSeconds: 86_400 }),
      } as any),
    ).resolves.toBeUndefined()

    expect(settingsService.update).toHaveBeenCalledTimes(1)
    expect(settingsService.update).toHaveBeenCalledWith({
      id: "ddset_global",
      guest_access_ttl_seconds: 86_400,
    })
  })

  it("reconciles persisted upload, grant, and guest policy above runtime ceilings", async () => {
    const original = options({
      defaultGrantTtlSeconds: 3_600,
      maxGrantTtlSeconds: 86_400,
      maxUploadSizeBytes: 512 * 1024 * 1024,
      allowGuestAccess: true,
    })
    const { container, settingsService } = loaderHarness(
      persistedSettings(original),
    )

    await expect(
      digitalDownloadsLoader({
        container,
        options: options({
          defaultGrantTtlSeconds: 60,
          maxGrantTtlSeconds: 120,
          maxUploadSizeBytes: 8 * 1024 * 1024,
          allowGuestAccess: false,
        }),
      } as any),
    ).resolves.toBeUndefined()

    expect(settingsService.update).toHaveBeenCalledTimes(1)
    expect(settingsService.update).toHaveBeenCalledWith({
      id: "ddset_global",
      default_grant_ttl_seconds: 60,
      max_grant_ttl_seconds: 120,
      max_upload_size_bytes: 8 * 1024 * 1024,
      allow_guest_access: false,
    })
  })
})
