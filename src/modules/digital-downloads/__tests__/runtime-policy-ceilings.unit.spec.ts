import { Readable } from "node:stream"

import DigitalDownloadsModuleService from "../service"
import {
  DigitalAssetStatus,
  DigitalDeliveryMode,
  DigitalEntitlementStatus,
  DigitalStorageProvider,
  DigitalUploadPurpose,
  DigitalUploadStatus,
} from "../types"
import { resolveDigitalDownloadsOptions, tokenHash } from "../utils"

const TOKEN_SECRET = "runtime-policy-token-secret".repeat(2)
const ENCRYPTION_KEY = "a".repeat(64)

function options(overrides: Record<string, unknown> = {}) {
  return resolveDigitalDownloadsOptions(
    {
      tokenSecret: TOKEN_SECRET,
      encryptionKey: ENCRYPTION_KEY,
      defaultGrantTtlSeconds: 60,
      maxGrantTtlSeconds: 120,
      maxUploadSizeBytes: 1_024,
      ...overrides,
    },
    {},
  )
}

function bareService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(DigitalDownloadsModuleService.prototype) as any
  service.options_ = options(overrides)
  service.baseRepository_ = { getFreshManager: jest.fn().mockReturnValue({}) }
  return service
}

describe("runtime policy ceilings", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("rejects a new upload above the runtime ceiling even when persisted settings are higher", async () => {
    const service = bareService()
    service.getSettings = jest.fn().mockResolvedValue({
      enabled: true,
      max_upload_size_bytes: 10_240,
    })
    service.storage_ = { driver: jest.fn() }

    await expect(
      service.initiateDigitalAssetUpload({
        filename: "oversized.bin",
        size: 2_048,
        mime_type: "application/octet-stream",
        purpose: DigitalUploadPurpose.DOWNLOAD,
      }),
    ).rejects.toThrow(/size must be an integer between 1 and 1024/)
    expect(service.storage_.driver).not.toHaveBeenCalled()
  })

  it("refuses an already-issued local upload intent after the effective ceiling is lowered", async () => {
    const service = bareService()
    const uploadToken = "ddu_runtime_policy_" + "x".repeat(40)
    service.retrieveDigitalUpload = jest.fn().mockResolvedValue({
      id: "dupl_policy",
      status: DigitalUploadStatus.PENDING,
      storage_provider: DigitalStorageProvider.LOCAL,
      storage_key: "uploads/policy.bin",
      expected_size_bytes: 2_048,
      expected_checksum_sha256: null,
      upload_token_hash: tokenHash(uploadToken, TOKEN_SECRET),
      mime_type: "application/octet-stream",
      expires_at: new Date(Date.now() + 60_000),
    })
    service.getSettings = jest.fn().mockResolvedValue({
      max_upload_size_bytes: 10_240,
    })
    service.storage_ = { putStream: jest.fn() }

    await expect(
      service.receiveDigitalAssetUpload("dupl_policy", {
        stream: Readable.from([Buffer.alloc(2_048)]),
        content_length: 2_048,
        content_type: "application/octet-stream",
        upload_token: uploadToken,
      }),
    ).rejects.toThrow("current configured upload size limit")
    expect(service.storage_.putStream).not.toHaveBeenCalled()
  })

  it("uses the lower runtime default and maximum for newly issued download grants", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T12:00:00.000Z"))
    const service = bareService()
    service.getSettings = jest.fn().mockResolvedValue({
      enabled: true,
      default_grant_ttl_seconds: 3_600,
      max_grant_ttl_seconds: 86_400,
    })
    service.lockRows_ = jest.fn()
    service.retrieveDigitalEntitlement = jest.fn().mockResolvedValue({
      id: "dent_policy",
      digital_product_id: "dprod_policy",
      release_id: "drel_policy",
      status: DigitalEntitlementStatus.ACTIVE,
      available_at: null,
      expires_at: null,
      download_count: 0,
      download_limit: 5,
    })
    service.retrieveDigitalAsset = jest.fn().mockResolvedValue({
      id: "dasset_policy",
      release_id: "drel_policy",
      status: DigitalAssetStatus.READY,
      is_enabled: true,
      delivery_type: DigitalDeliveryMode.DOWNLOAD,
      size_bytes: 10,
      original_filename: "policy.bin",
      mime_type: "application/octet-stream",
    })
    service.retrieveDigitalProductRelease = jest.fn().mockResolvedValue({
      id: "drel_policy",
      digital_product_id: "dprod_policy",
    })
    service.listDownloadGrants = jest.fn().mockResolvedValue([])
    service.createDownloadGrants = jest
      .fn()
      .mockImplementation(async (data: Record<string, unknown>) => ({
        id: "dgrant_policy",
        ...data,
      }))
    service.createDownloadEvents = jest.fn().mockResolvedValue({})

    const result = await service.createDownloadGrant(
      {
        entitlement_id: "dent_policy",
        asset_id: "dasset_policy",
        idempotency_key: "runtime-policy-default",
      },
      { transactionManager: {} },
    )
    expect((result.grant.expires_at as Date).toISOString()).toBe(
      "2026-08-03T12:01:00.000Z",
    )

    await expect(
      service.createDownloadGrant(
        {
          entitlement_id: "dent_policy",
          asset_id: "dasset_policy",
          idempotency_key: "runtime-policy-explicit",
          ttl_seconds: 121,
        },
        { transactionManager: {} },
      ),
    ).rejects.toThrow(/ttl_seconds must be an integer between 1 and 120/)
  })

  it("treats runtime guest disablement as authoritative for issuance and resolution", async () => {
    const service = bareService({ allowGuestAccess: false })
    service.getSettings = jest.fn().mockResolvedValue({
      allow_guest_access: true,
      guest_access_ttl_seconds: 2_592_000,
    })

    await expect(
      service.createGuestAccessSession(
        {
          entitlement_id: "dent_guest_policy",
          idempotency_key: "guest-policy-issuance",
        },
        { transactionManager: {} },
      ),
    ).rejects.toThrow("Guest entitlement access is disabled")
    await expect(
      service.resolveGuestEntitlement(
        "dda_" + "x".repeat(48),
        {},
        { transactionManager: {} },
      ),
    ).rejects.toThrow("Guest entitlement access is disabled")
  })

  it("prevents Admin settings from relaxing runtime defaults or guest disablement", async () => {
    const service = bareService({ allowGuestAccess: false })
    service.getSettings = jest.fn().mockResolvedValue({
      id: "ddset_global",
      singleton_key: "global",
      default_grant_ttl_seconds: 60,
      max_grant_ttl_seconds: 120,
      guest_access_ttl_seconds: 86_400,
      max_upload_size_bytes: 1_024,
      allow_guest_access: true,
      storage_namespace_fingerprint: "storage-fingerprint",
      storage_namespace_version: 1,
      token_secret_fingerprint: "token-fingerprint",
      encryption_key_fingerprint: "encryption-fingerprint",
    })
    service.updateDigitalDownloadsSettings = jest.fn(async (row) => row)

    await expect(
      service.updateSettings({ default_grant_ttl_seconds: 61 }),
    ).rejects.toThrow(
      /default_grant_ttl_seconds must be an integer between 1 and 60/,
    )
    expect(service.updateDigitalDownloadsSettings).not.toHaveBeenCalled()

    await expect(
      service.updateSettings({
        default_download_limit: 4,
        allow_guest_access: true,
      }),
    ).resolves.toMatchObject({
      default_download_limit: 4,
      allow_guest_access: false,
    })
  })
})
