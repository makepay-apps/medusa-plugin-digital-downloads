import type {
  JsonObject,
  SafeDigitalAsset,
  SafeLicensePoolKey,
} from "../types"

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {}
}

export function toSafeDigitalAsset(value: unknown): SafeDigitalAsset {
  const asset = object(value)
  return {
    id: asset.id,
    release_id: asset.release_id,
    name: asset.name,
    role: asset.role,
    kind: asset.kind,
    status: asset.status,
    delivery_type: asset.delivery_type,
    original_filename: asset.original_filename,
    mime_type: asset.mime_type,
    size_bytes: asset.size_bytes,
    checksum_sha256: asset.checksum_sha256,
    version: asset.version,
    sort_order: asset.sort_order,
    metadata: object(asset.metadata) as JsonObject,
  }
}

export function toSafeLicensePoolKey(value: unknown): SafeLicensePoolKey {
  const key = object(value)
  return {
    id: key.id,
    license_policy_id: key.license_policy_id,
    status: key.status,
    key_hint: key.key_hint,
    batch_id: key.batch_id ?? null,
    reserved_at: key.reserved_at ?? null,
    assigned_at: key.assigned_at ?? null,
    metadata: object(key.metadata) as JsonObject,
  }
}

export function toSafeDownloadGrant(value: unknown): Record<string, unknown> {
  const grant = object(value)
  return {
    id: grant.id,
    entitlement_id: grant.entitlement_id,
    asset_id: grant.asset_id,
    status: grant.status,
    token_prefix: grant.token_prefix,
    max_uses: grant.max_uses,
    use_count: grant.use_count,
    expires_at: grant.expires_at,
    last_used_at: grant.last_used_at ?? null,
    metadata: object(grant.metadata),
  }
}
