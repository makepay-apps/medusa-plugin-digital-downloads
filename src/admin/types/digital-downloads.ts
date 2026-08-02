export type DigitalProductStatus =
  | "draft"
  | "active"
  | "inactive"
  | "archived"

export type ReleaseStatus = "draft" | "ready" | "published" | "retired"

export type AssetStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "failed"
  | "quarantined"

export type EntitlementStatus =
  | "pending"
  | "active"
  | "suspended"
  | "refunded"
  | "expired"
  | "revoked"
  | "exhausted"

export type DeliveryType =
  | "download"
  | "license"
  | "mixed"
  | "download_and_license"
  | "stream"

export type FulfillmentStrategy =
  | "payment_captured"
  | "order_completed"
  | "manual"
export type StorageProvider = "local" | "s3"

export type UploadPurpose =
  | "download"
  | "stream"
  | "preview"
  | "cover"
  | "manual"
  | "license"

export interface DigitalAsset {
  id: string
  release_id?: string | null
  name: string
  filename?: string
  original_filename?: string
  mime_type: string
  size?: number
  size_bytes?: number
  status?: AssetStatus
  storage_provider?: StorageProvider | string
  role?: string
  kind?: string
  delivery_type?: DeliveryType
  is_enabled?: boolean
  checksum_sha256?: string | null
  created_at?: string
  updated_at?: string
  metadata?: Record<string, unknown> | null
}

export interface DigitalRelease {
  id: string
  product_config_id: string
  name?: string | null
  title?: string | null
  version: string
  status: ReleaseStatus
  release_notes?: string | null
  published_at?: string | null
  created_at: string
  updated_at?: string
  assets?: DigitalAsset[]
}

export interface LicensePolicy {
  id: string
  digital_product_id?: string
  product_config_id?: string
  product_title?: string | null
  name?: string
  strategy: "none" | "pool" | "generated" | string
  type?: "none" | "generated" | "pool" | string
  status?: "draft" | "active" | "archived" | string
  license_pattern?: string | null
  key_pattern?: string | null
  activation_limit?: number | null
  duration_days?: number | null
  validity_days?: number | null
  license_pool_id?: string | null
  allow_offline_activation?: boolean
  require_device_id?: boolean
  is_enabled?: boolean
  key_counts?: {
    available: number
    reserved: number
    assigned: number
    revoked: number
    total: number
  }
  created_at?: string
  updated_at?: string
  metadata?: Record<string, unknown> | null
}

export interface LicensePoolKeySummary {
  id: string
  license_policy_id: string
  status: "available" | "reserved" | "assigned" | "revoked" | string
  key_hint: string
  batch_id?: string | null
  reserved_at?: string | null
  assigned_at?: string | null
  revoked_at?: string | null
  created_at?: string
  metadata?: Record<string, unknown> | null
}

export interface LicensePolicyInput {
  digital_product_id: string
  strategy: "none" | "pool" | "generated"
  license_pattern?: string | null
  activation_limit?: number | null
  validity_days?: number | null
  allow_offline_activation?: false
  require_device_id?: boolean
  is_enabled?: boolean
  metadata?: Record<string, unknown>
}

export interface ProductVariantReference {
  id: string
  title?: string | null
  sku?: string | null
  product_id?: string
}

export interface ProductConfig {
  id: string
  product_id: string
  product_title?: string | null
  title: string
  description?: string | null
  status: DigitalProductStatus
  delivery_type: DeliveryType
  fulfillment_strategy: FulfillmentStrategy
  variant_ids: string[]
  variants?: ProductVariantReference[]
  active_release_id?: string | null
  active_release?: DigitalRelease | null
  releases?: DigitalRelease[]
  assets?: DigitalAsset[]
  license_policy_id?: string | null
  license_policy?: LicensePolicy | null
  download_limit?: number | null
  expires_in_days?: number | null
  created_at: string
  updated_at: string
  metadata?: Record<string, unknown> | null
}

export interface DownloadSummary {
  count: number
  limit?: number | null
  last_downloaded_at?: string | null
}

export interface DigitalEntitlement {
  id: string
  order_id: string
  line_item_id?: string | null
  order_line_item_id?: string | null
  line_item_title?: string | null
  customer_id?: string | null
  customer_email?: string | null
  product_config_id: string
  product_title?: string | null
  title?: string | null
  variant_id?: string | null
  variant_title?: string | null
  status: EntitlementStatus
  expires_at?: string | null
  download_count?: number
  download_limit?: number | null
  downloads?: DownloadSummary | null
  license_status?: string | null
  license_key_masked?: string | null
  licenses?: Array<{
    id?: string
    status?: string
    masked_key?: string
    key_hint?: string
    activation_limit?: number | null
    activation_count?: number | null
  }>
  fulfilled_at?: string | null
  revoked_at?: string | null
  created_at: string
  updated_at?: string
}

export interface DigitalDownloadSettings {
  enabled: boolean
  default_delivery_type: "download" | "stream" | "license" | "mixed"
  default_grant_ttl_seconds: number
  max_grant_ttl_seconds: number
  max_upload_size_bytes: number
  allow_guest_access: boolean
  require_order_email_match: boolean
  event_retention_days: number
  storage: {
    provider: StorageProvider
    configured: boolean
  }
  signed_url_ttl_seconds: number
  default_download_limit?: number | null
  default_expiry_days?: number | null
  max_upload_size_mb: number
  allowed_mime_types?: string[]
  enable_streaming?: boolean
  audit_retention_days?: number | null
  readiness?: {
    ready: boolean
    issues: string[]
    token_secret_configured: boolean
    encryption_key_configured: boolean
    local_signing_secret_configured: boolean
  }
  updated_at?: string
}

export type DigitalDownloadSettingsPatch = Partial<
  Pick<
    DigitalDownloadSettings,
    | "enabled"
    | "default_delivery_type"
    | "default_download_limit"
    | "default_grant_ttl_seconds"
    | "max_grant_ttl_seconds"
    | "max_upload_size_bytes"
    | "allow_guest_access"
    | "require_order_email_match"
    | "event_retention_days"
  >
>

export interface ReportSummary {
  product_configs: number
  active_product_configs: number
  assets: number
  storage_bytes: number
  active_entitlements: number
  downloads_30d: number
  revoked_entitlements?: number
}

export interface PaginatedResponse<T> {
  items: T[]
  count: number
  limit: number
  offset: number
}

export interface ProductConfigFilters {
  q?: string
  status?: DigitalProductStatus | ""
  delivery_type?: DeliveryType | ""
  product_id?: string
  variant_id?: string
  limit?: number
  offset?: number
  order?: string
}

export interface EntitlementFilters {
  q?: string
  status?: EntitlementStatus | ""
  order_id?: string
  customer_id?: string
  product_config_id?: string
  limit?: number
  offset?: number
  order?: string
}

export interface ProductConfigInput {
  product_id: string
  title: string
  description?: string | null
  status: DigitalProductStatus
  delivery_type: DeliveryType
  fulfillment_strategy: FulfillmentStrategy
  variant_ids: string[]
  license_policy_id?: string | null
  download_limit?: number | null
  expires_in_days?: number | null
  metadata?: Record<string, unknown> | null
}

export interface ReleaseInput {
  product_config_id: string
  version: string
  title: string
  notes?: string | null
}

export interface UploadIntent {
  id: string
  method: "PUT" | "POST"
  url?: string | null
  headers?: Record<string, string>
  expires_at?: string | null
  purpose?: UploadPurpose
}

export interface UploadProgress {
  file: File
  purpose: UploadPurpose
  percent: number
  state: "queued" | "uploading" | "complete" | "error"
  error?: string
  asset?: DigitalAsset
}

export interface AdminProductOption {
  id: string
  title: string
  variants: ProductVariantReference[]
}

export interface ListEnvelope<T> {
  count?: number
  limit?: number
  offset?: number
  [key: string]: T[] | number | undefined
}
