export const FULFILLMENT_STRATEGIES = [
  "payment_captured",
  "order_completed",
  "manual",
] as const

export type FulfillmentStrategy = (typeof FULFILLMENT_STRATEGIES)[number]

// These fields are written by product configuration workflows or release
// publication. They must not be accepted through free-form metadata.
export const PRODUCT_CONFIG_RESERVED_METADATA_FIELDS = [
  "medusa_product_id",
  "variant_ids",
  "fulfillment_strategy",
  "active_release_id",
  "license_policy_id",
  "download_limit",
  "expires_in_days",
  "preview_enabled",
  "update_policy",
  // Legacy aliases still affect entitlement issuance, so they are reserved too.
  "max_downloads",
  "access_duration_seconds",
  "access_duration_days",
] as const

const reservedMetadataFields = new Set<string>(
  PRODUCT_CONFIG_RESERVED_METADATA_FIELDS,
)

export function isFulfillmentStrategy(
  value: unknown,
): value is FulfillmentStrategy {
  return (
    typeof value === "string" &&
    (FULFILLMENT_STRATEGIES as readonly string[]).includes(value)
  )
}

export function hasReservedProductConfigMetadata(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      Object.keys(value).some((key) => reservedMetadataFields.has(key)),
  )
}

export function stripReservedProductConfigMetadata(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !reservedMetadataFields.has(key)),
  )
}
