/**
 * Public storefront types for the Digital Downloads plugin.
 *
 * These types intentionally model only data that is safe to expose to a buyer.
 * Storage keys, provider credentials, token hashes, raw license-key hashes, and
 * internal audit metadata must never be added to these projections.
 */

export type ISODateString = string

export type DigitalProductKind =
  | "download"
  | "ebook"
  | "audio"
  | "video"
  | "image"
  | "software"
  | "license"
  | "bundle"
  | "other"

export type DigitalDeliveryType = "download" | "stream" | "license"

export type DigitalEntitlementStatus =
  | "pending"
  | "active"
  | "suspended"
  | "expired"
  | "revoked"
  | "refunded"

export type DigitalLicenseStatus =
  | "pending"
  | "active"
  | "suspended"
  | "expired"
  | "revoked"

export type DigitalLicenseActivationStatus =
  | "active"
  | "deactivated"
  | "expired"
  | "revoked"

export interface DigitalPreviewAsset {
  id: string
  kind: DigitalProductKind
  title: string
  description?: string | null
  mime_type: string
  size_bytes?: number | null
  duration_seconds?: number | null
  width?: number | null
  height?: number | null
  /** A public, sanitized preview URL. It is never the protected full asset. */
  url?: string | null
  poster_url?: string | null
  alt?: string | null
}

export interface DigitalProductPreview {
  product_id: string
  variant_id: string
  title?: string | null
  variant_title?: string | null
  kind: DigitalProductKind
  delivery_types: DigitalDeliveryType[]
  previews: DigitalPreviewAsset[]
  file_count?: number
  total_size_bytes?: number | null
  license_terms?: {
    max_activations?: number | null
    validity_days?: number | null
    offline_allowed?: boolean
  } | null
}

export interface DigitalProductPreviewResponse {
  product: DigitalProductPreview
}

export interface DigitalProductSnapshot {
  product_id?: string | null
  variant_id?: string | null
  title: string
  variant_title?: string | null
  handle?: string | null
  thumbnail?: string | null
  kind: DigitalProductKind
}

export interface DigitalEntitlementAsset {
  id: string
  title: string
  filename: string
  kind: DigitalProductKind
  mime_type: string
  size_bytes?: number | null
  duration_seconds?: number | null
  checksum_sha256?: string | null
  delivery_types: Array<Extract<DigitalDeliveryType, "download" | "stream">>
  download_count?: number
  download_limit?: number | null
  last_downloaded_at?: ISODateString | null
}

export interface DigitalLicenseActivation {
  id: string
  name?: string | null
  installation_id?: string | null
  status: DigitalLicenseActivationStatus
  activated_at: ISODateString
  last_seen_at?: ISODateString | null
  deactivated_at?: ISODateString | null
  expires_at?: ISODateString | null
}

export interface DigitalLicenseSummary {
  id: string
  status: DigitalLicenseStatus
  masked_key?: string | null
  issued_at?: ISODateString | null
  expires_at?: ISODateString | null
  max_activations?: number | null
  activations: DigitalLicenseActivation[]
}

export interface DigitalEntitlementCapabilities {
  can_download: boolean
  can_stream: boolean
  can_reveal_license: boolean
  can_activate_license: boolean
  can_deactivate_license: boolean
}

export interface DigitalEntitlement {
  id: string
  status: DigitalEntitlementStatus
  order_id: string
  order_display_id?: number | string | null
  line_item_id: string
  unit_index?: number
  created_at: ISODateString
  granted_at?: ISODateString | null
  expires_at?: ISODateString | null
  revoked_at?: ISODateString | null
  status_reason?: string | null
  product: DigitalProductSnapshot
  assets: DigitalEntitlementAsset[]
  license?: DigitalLicenseSummary | null
  capabilities: DigitalEntitlementCapabilities
}

export interface DigitalLibraryResponse {
  entitlements: DigitalEntitlement[]
  count: number
  limit: number
  offset: number
}

export interface DigitalEntitlementResponse {
  entitlement: DigitalEntitlement
}

export interface DigitalLibraryQuery {
  limit?: number
  offset?: number
  order_id?: string
  status?: DigitalEntitlementStatus | DigitalEntitlementStatus[]
  kind?: DigitalProductKind | DigitalProductKind[]
  q?: string
}

export interface DigitalAccessGrantRequest {
  asset_id: string
  action: Extract<DigitalDeliveryType, "download" | "stream">
}

export interface DigitalAccessGrant {
  /** Secret, short-lived bearer. Never persist it or put it in a URL. */
  token: string
  asset_id: string
  action: Extract<DigitalDeliveryType, "download" | "stream">
  url: string
  method: "GET"
  headers: Record<string, string> & { authorization: string }
  expires_at: ISODateString
  filename?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  supports_ranges: boolean
}

export interface DigitalAccessGrantResponse {
  grant: DigitalAccessGrant
}

export interface DigitalGuestAccessRequest {
  token: string
  /** Order email; required when the merchant enables email matching (default). */
  email?: string
}

export interface DigitalGuestAccessResponse {
  entitlement: DigitalEntitlement
}

export interface DigitalGuestAccessGrantRequest extends DigitalAccessGrantRequest {
  token: string
  email?: string
  entitlement_id: string
}

export interface DigitalLicenseRevealRequest {
  /** Opaque guest purchase capability. Customer requests omit this field. */
  guest_token?: string
  /** Order email paired with guest_token when email matching is enabled. */
  guest_email?: string
  /** Optional buyer-facing reason, useful for high-assurance audit policies. */
  reason?: string
}

export interface RevealedDigitalLicense {
  id: string
  key: string
  status: DigitalLicenseStatus
  issued_at?: ISODateString | null
  expires_at?: ISODateString | null
  max_activations?: number | null
}

export interface DigitalLicenseRevealResponse {
  license_key: string
}

export interface DigitalLicenseActivateRequest {
  license_key: string
  /** Stable, app-generated identifier. Do not use raw hardware identifiers. */
  instance_id: string
  label?: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface DigitalLicenseActivateResponse {
  activation: DigitalLicenseActivation
  license: DigitalLicenseSummary
}

export interface DigitalLicenseDeactivateRequest {
  license_key: string
  instance_id: string
  reason?: string
}

export interface DigitalLicenseDeactivateResponse {
  activation: DigitalLicenseActivation
  license: DigitalLicenseSummary
}

export interface DigitalLicenseHeartbeatRequest {
  license_key: string
  instance_id: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface DigitalLicenseHeartbeatResponse {
  activation: DigitalLicenseActivation
  license: DigitalLicenseSummary
  next_heartbeat_at?: ISODateString | null
}

export interface DigitalLicenseValidateRequest {
  license_key: string
  instance_id?: string
}

export interface DigitalLicenseValidateResponse {
  valid: boolean
  license: DigitalLicenseSummary
  activation?: DigitalLicenseActivation | null
  reason?: string | null
}

/**
 * Per-request authorization. Customer JWTs are normally configured once on
 * the transport. Guest capabilities are deliberately accepted only here and
 * are serialized in guest-only POST JSON bodies, never in a header or query
 * string.
 */
export interface DigitalStorefrontAccess {
  guest_token?: string
  guest_email?: string
}

export interface DigitalStorefrontRequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  idempotency_key?: string
  cache?: RequestCache
}

export interface DigitalDownloadsApiErrorBody {
  type?: string
  code?: string
  message?: string
  request_id?: string
  details?: unknown
}
