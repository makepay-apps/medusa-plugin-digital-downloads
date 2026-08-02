import { MedusaError } from "@medusajs/framework/utils"
import type { RevocationPolicy, UnknownRecord } from "./types"

export const MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER = 1_000

const MANAGED_FIELDS = new Set([
  "created_at",
  "updated_at",
  "deleted_at",
  "created_by",
  "updated_by",
])

const SECRET_FIELDS = new Set([
  "access_key",
  "access_key_id",
  "secret",
  "secret_access_key",
  "session_token",
  "password",
  "private_key",
  "credentials",
  "storage_key",
  "object_key",
  "local_path",
  "absolute_path",
  "token",
])

export function requireIdentifier(
  input: UnknownRecord,
  snakeCase: string,
  camelCase: string
): string {
  const value = input[snakeCase] ?? input[camelCase]
  if (typeof value !== "string" || !value.trim()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `${snakeCase} is required`
    )
  }

  return value.trim()
}

export function normalizeQuantity(value: unknown): number {
  let primitive = value

  if (value && typeof value === "object") {
    const objectValue = value as UnknownRecord
    primitive =
      objectValue.value ??
      objectValue.numeric ??
      objectValue.raw_value ??
      objectValue.rawValue ??
      objectValue.toString?.()
  }

  const parsed = Number(primitive ?? 0)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }

  const normalized = Math.floor(parsed)
  if (normalized > MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `A digital line item cannot exceed ${MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER} entitlement units`
    )
  }

  return normalized
}

export function toFiniteAmount(value: unknown): number {
  if (value && typeof value === "object") {
    const objectValue = value as UnknownRecord
    value =
      objectValue.value ??
      objectValue.numeric ??
      objectValue.raw_value ??
      objectValue.rawValue ??
      objectValue.toString?.()
  }

  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function stripManagedFields<T extends UnknownRecord>(
  value: T,
  options: { keepId?: boolean } = {}
): UnknownRecord {
  const output: UnknownRecord = {}

  for (const [key, entry] of Object.entries(value ?? {})) {
    if (MANAGED_FIELDS.has(key) || (!options.keepId && key === "id")) {
      continue
    }

    if (Array.isArray(entry)) {
      continue
    }

    if (entry && typeof entry === "object" && !(entry instanceof Date)) {
      continue
    }

    output[key] = entry
  }

  return output
}

export function sanitizeForPurchaseSnapshot(value: unknown): any {
  if (value === null || value === undefined) {
    return value ?? null
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeForPurchaseSnapshot)
  }

  if (typeof value !== "object") {
    return value
  }

  const result: UnknownRecord = {}
  for (const [key, entry] of Object.entries(value as UnknownRecord)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) {
      continue
    }

    result[key] = sanitizeForPurchaseSnapshot(entry)
  }

  return result
}

export function selectPurchasableRelease(
  digitalProduct: UnknownRecord
): UnknownRecord | undefined {
  const releases = Array.isArray(digitalProduct.releases)
    ? digitalProduct.releases
    : Array.isArray(digitalProduct.digital_product_releases)
      ? digitalProduct.digital_product_releases
      : []

  const purchasable = releases.filter((release: UnknownRecord) => {
    const state = String(release.status ?? release.state ?? "").toLowerCase()
    return !release.deleted_at && state === "published"
  })

  if (!purchasable.length) {
    return undefined
  }

  return [...purchasable].sort((left, right) => {
    if (Boolean(left.is_current) !== Boolean(right.is_current)) {
      return left.is_current ? -1 : 1
    }

    const leftTime = new Date(
      left.published_at ?? left.released_at ?? left.created_at ?? 0
    ).getTime()
    const rightTime = new Date(
      right.published_at ?? right.released_at ?? right.created_at ?? 0
    ).getTime()
    return rightTime - leftTime
  })[0]
}

export function buildPurchaseSnapshot(input: {
  order: UnknownRecord
  lineItem: UnknownRecord
  digitalProduct: UnknownRecord
  release?: UnknownRecord
  unitIndex: number
}): UnknownRecord {
  const { order, lineItem, digitalProduct, release, unitIndex } = input
  const selectedAssets =
    release?.assets ??
    release?.digital_assets ??
    release?.deliverables ??
    digitalProduct.assets ??
    []

  return sanitizeForPurchaseSnapshot({
    schema_version: 1,
    purchased_at: order.created_at ?? new Date(0).toISOString(),
    order: {
      id: order.id,
      currency_code: order.currency_code,
      region_id: order.region_id,
    },
    line_item: {
      id: lineItem.id,
      unit_index: unitIndex,
      title: lineItem.title,
      subtitle: lineItem.subtitle,
      thumbnail: lineItem.thumbnail,
      product_id: lineItem.product_id,
      variant_id: lineItem.variant_id,
      unit_price: lineItem.unit_price,
      metadata: lineItem.metadata ?? {},
    },
    digital_product: {
      id: digitalProduct.id,
      name: digitalProduct.name ?? digitalProduct.title,
      kind: digitalProduct.kind ?? digitalProduct.type,
      delivery_mode:
        digitalProduct.delivery_mode ?? digitalProduct.delivery_type,
      download_limit: digitalProduct.download_limit,
      access_duration: digitalProduct.access_duration,
      metadata: digitalProduct.metadata ?? {},
    },
    release: release
      ? {
          id: release.id,
          version: release.version ?? release.name,
          published_at: release.published_at ?? release.released_at,
          metadata: release.metadata ?? {},
        }
      : null,
    assets: (Array.isArray(selectedAssets) ? selectedAssets : []).map(
      (asset: UnknownRecord) => ({
        id: asset.id ?? asset.digital_asset_id,
        asset_version_id:
          asset.asset_version_id ?? asset.version_id ?? asset.current_version_id,
        name:
          asset.name ??
          asset.filename ??
          asset.original_filename ??
          asset.display_name,
        mime_type: asset.mime_type ?? asset.content_type,
        size: asset.size ?? asset.size_bytes,
        checksum:
          asset.checksum ?? asset.sha256 ?? asset.checksum_sha256,
        role: asset.role,
        metadata: asset.public_metadata ?? asset.metadata ?? {},
      })
    ),
    license_policy: digitalProduct.license_policy ?? release?.license_policy ?? null,
  })
}

export function shouldRevokeForRefund(input: {
  policy: RevocationPolicy
  orderTotal: unknown
  refundedTotal: unknown
  hasSelectedLineItems: boolean
}): boolean {
  const { policy, hasSelectedLineItems } = input

  if (policy === "retain") {
    return false
  }

  if (policy === "all" || policy === "any_refund") {
    return true
  }

  if (policy === "refunded_items") {
    return hasSelectedLineItems
  }

  const orderTotal = Math.abs(toFiniteAmount(input.orderTotal))
  const refundedTotal = Math.abs(toFiniteAmount(input.refundedTotal))
  return orderTotal > 0 && refundedTotal + Number.EPSILON >= orderTotal
}

export function computeBackoffDate(attempt: number, now = new Date()): Date {
  const safeAttempt = Math.max(0, Math.floor(attempt))
  const seconds = Math.min(24 * 60 * 60, 30 * 2 ** safeAttempt)
  return new Date(now.getTime() + seconds * 1000)
}
