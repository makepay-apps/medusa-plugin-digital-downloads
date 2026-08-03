import { asValue } from "@medusajs/framework/awilix"
import type { LoaderOptions } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"
import {
  DIGITAL_DOWNLOADS_SETTINGS_KEY,
  MAKEPAY_ATTRIBUTION_LABEL,
  MAKEPAY_ATTRIBUTION_URL,
} from "../models/digital-downloads-settings"
import { DigitalDownloadsStorageManager } from "../storage"
import type { DigitalDownloadsModuleOptions } from "../types"
import {
  digitalDownloadsStorageNamespaceFingerprint,
  resolveDigitalDownloadsOptions,
  sha256,
} from "../utils"

interface InternalSettingsService {
  listAndCount(
    filters?: Record<string, unknown>,
  ): Promise<[Array<Record<string, unknown>>, number]>
  create(data: Record<string, unknown>): Promise<Record<string, unknown>>
  update(data: Record<string, unknown>): Promise<Record<string, unknown>>
}

interface InternalCountService {
  listAndCount(
    filters?: Record<string, unknown>,
  ): Promise<[Array<Record<string, unknown>>, number]>
}

function positiveSafeInteger(value: unknown): number | undefined {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

function secretFingerprint(
  value: string | undefined,
  purpose: "token" | "encryption",
): string | null {
  return value
    ? sha256(`medusa-digital-downloads/${purpose}-secret/v1\0${value}`)
    : null
}

export default async function digitalDownloadsLoader({
  container,
  options,
}: LoaderOptions<DigitalDownloadsModuleOptions>): Promise<void> {
  const resolved = resolveDigitalDownloadsOptions(options ?? {})
  const storage = new DigitalDownloadsStorageManager(resolved)
  const ready = Boolean(
    resolved.tokenSecret &&
      resolved.encryptionKey &&
      (resolved.storage.defaultProvider === "s3" ||
        resolved.storage.local.signingSecret),
  )
  container.register({
    digitalDownloadsOptions: asValue(resolved),
    digitalDownloadsStorage: asValue(storage),
  })

  const settingsService = container.resolve(
    "digitalDownloadsSettingsService",
  ) as InternalSettingsService
  let [settings, count] = await settingsService.listAndCount({
    singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY,
  })
  const storageNamespaceFingerprint =
    digitalDownloadsStorageNamespaceFingerprint(resolved)
  const tokenSecretFingerprint = secretFingerprint(resolved.tokenSecret, "token")
  const encryptionKeyFingerprint = secretFingerprint(
    resolved.encryptionKey,
    "encryption",
  )
  if (count === 0) {
    try {
      const created = await settingsService.create({
        singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY,
        enabled: ready,
        default_download_limit: resolved.defaultDownloadLimit,
        default_grant_ttl_seconds: resolved.defaultGrantTtlSeconds,
        max_grant_ttl_seconds: resolved.maxGrantTtlSeconds,
        guest_access_ttl_seconds: resolved.guestAccessTtlSeconds,
        max_upload_size_bytes: resolved.maxUploadSizeBytes,
        allow_guest_access: resolved.allowGuestAccess,
        storage_namespace_fingerprint: storageNamespaceFingerprint,
        storage_namespace_version: 1,
        token_secret_fingerprint: tokenSecretFingerprint,
        encryption_key_fingerprint: encryptionKeyFingerprint,
        show_makepay_attribution: true,
        attribution_label: MAKEPAY_ATTRIBUTION_LABEL,
        attribution_url: MAKEPAY_ATTRIBUTION_URL,
      })
      settings = [created]
      count = 1
    } catch (error) {
      ;[settings, count] = await settingsService.listAndCount({
        singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY,
      })
      if (count === 0) {
        storage.destroy()
        throw error
      }
    }
  }

  const current = settings[0]
  const changes: Record<string, unknown> = { id: current.id }
  const persistedMaxGrantTtl = positiveSafeInteger(
    current.max_grant_ttl_seconds,
  )
  const effectiveMaxGrantTtl = Math.min(
    persistedMaxGrantTtl ?? resolved.maxGrantTtlSeconds,
    resolved.maxGrantTtlSeconds,
  )
  if (persistedMaxGrantTtl !== effectiveMaxGrantTtl) {
    changes.max_grant_ttl_seconds = effectiveMaxGrantTtl
  }
  const persistedDefaultGrantTtl = positiveSafeInteger(
    current.default_grant_ttl_seconds,
  )
  const effectiveDefaultGrantTtl = Math.min(
    persistedDefaultGrantTtl ?? resolved.defaultGrantTtlSeconds,
    resolved.defaultGrantTtlSeconds,
    effectiveMaxGrantTtl,
  )
  if (persistedDefaultGrantTtl !== effectiveDefaultGrantTtl) {
    changes.default_grant_ttl_seconds = effectiveDefaultGrantTtl
  }
  const persistedMaxUploadSize = positiveSafeInteger(
    current.max_upload_size_bytes,
  )
  const effectiveMaxUploadSize = Math.min(
    persistedMaxUploadSize ?? resolved.maxUploadSizeBytes,
    resolved.maxUploadSizeBytes,
  )
  if (persistedMaxUploadSize !== effectiveMaxUploadSize) {
    changes.max_upload_size_bytes = effectiveMaxUploadSize
  }
  if (
    resolved.allowGuestAccess === false &&
    current.allow_guest_access !== false
  ) {
    changes.allow_guest_access = false
  }
  const persistedGuestAccessTtl = Number(current.guest_access_ttl_seconds)
  if (
    Number.isSafeInteger(persistedGuestAccessTtl) &&
    persistedGuestAccessTtl > resolved.guestAccessTtlSeconds
  ) {
    changes.guest_access_ttl_seconds = resolved.guestAccessTtlSeconds
  }
  if (current.storage_namespace_fingerprint !== storageNamespaceFingerprint) {
    const assetService = container.resolve("digitalAssetService") as InternalCountService
    const uploadService = container.resolve("digitalUploadService") as InternalCountService
    const [[, assetCount], [, uploadCount]] = await Promise.all([
      assetService.listAndCount({}),
      uploadService.listAndCount({}),
    ])
    if (assetCount + uploadCount > 0) {
      storage.destroy()
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Digital downloads storage namespace is missing or changed while stored assets or uploads exist. Run an explicit storage migration before changing local roots, S3 endpoints, buckets, or prefixes.",
      )
    }
    changes.storage_namespace_fingerprint = storageNamespaceFingerprint
    changes.storage_namespace_version = 1
  }

  if (current.token_secret_fingerprint !== tokenSecretFingerprint) {
    // The token secret is also the domain-separated key for persisted bearer
    // token hashes, request/binding fingerprints, privacy hashes, and the
    // notification recipient natural key. Rotating it underneath any of those
    // rows would invalidate credentials or split one logical identity into two.
    const services = [
      "downloadGrantService",
      "entitlementAccessSessionService",
      "digitalUploadService",
      "downloadEventService",
      "licenseActivationService",
      "licenseAuditEventService",
      "notificationDeliveryService",
    ].map((name) => container.resolve(name) as InternalCountService)
    const counts = await Promise.all(services.map((service) => service.listAndCount({})))
    if (counts.some(([, entityCount]) => entityCount > 0)) {
      storage.destroy()
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Digital downloads token secret rotation is blocked while token-derived credential, upload, audit, activation, or notification rows exist. Use an explicit credential-rotation migration.",
      )
    }
    changes.token_secret_fingerprint = tokenSecretFingerprint
  }

  if (current.encryption_key_fingerprint !== encryptionKeyFingerprint) {
    // The encryption key protects both key ciphertext/fingerprints and the
    // stable device fingerprints used to find activation records.
    const services = ["licensePoolKeyService", "licenseActivationService"].map(
      (name) => container.resolve(name) as InternalCountService,
    )
    const counts = await Promise.all(
      services.map((service) => service.listAndCount({})),
    )
    if (counts.some(([, entityCount]) => entityCount > 0)) {
      storage.destroy()
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Digital downloads encryption-key rotation is blocked while encrypted license keys or device activation fingerprints exist. Re-encrypt and re-fingerprint them through an explicit migration first.",
      )
    }
    changes.encryption_key_fingerprint = encryptionKeyFingerprint
  }

  if (Object.keys(changes).length > 1) {
    await settingsService.update(changes)
  }
}
