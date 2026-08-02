import type { FindConfig } from "@medusajs/framework/types"
import type { Readable } from "node:stream"

export enum DigitalProductStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  ARCHIVED = "archived",
}

export enum DigitalDeliveryMode {
  DOWNLOAD = "download",
  STREAM = "stream",
  LICENSE = "license",
  MIXED = "mixed",
}

export enum DigitalReleaseStatus {
  DRAFT = "draft",
  READY = "ready",
  PUBLISHED = "published",
  RETIRED = "retired",
}

export enum DigitalAssetRole {
  DOWNLOAD = "download",
  STREAM = "stream",
  PREVIEW = "preview",
  COVER = "cover",
  MANUAL = "manual",
  LICENSE = "license",
}

export enum DigitalAssetKind {
  FILE = "file",
  PDF = "pdf",
  AUDIO = "audio",
  VIDEO = "video",
  IMAGE = "image",
  ARCHIVE = "archive",
  LICENSE = "license",
}

export enum DigitalAssetStatus {
  STAGED = "staged",
  PROCESSING = "processing",
  READY = "ready",
  QUARANTINED = "quarantined",
  FAILED = "failed",
  RETIRED = "retired",
}

export enum DigitalStorageProvider {
  LOCAL = "local",
  S3 = "s3",
}

export enum DigitalEntitlementStatus {
  PENDING = "pending",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  REVOKED = "revoked",
  EXPIRED = "expired",
  REFUNDED = "refunded",
}

export enum DigitalEntitlementSource {
  ORDER = "order",
  MANUAL = "manual",
  IMPORT = "import",
}

export enum LicenseStrategy {
  NONE = "none",
  POOL = "pool",
  GENERATED = "generated",
  EXTERNAL = "external",
}

export enum LicensePoolKeyStatus {
  AVAILABLE = "available",
  RESERVED = "reserved",
  ASSIGNED = "assigned",
  REVOKED = "revoked",
}

export enum LicenseAssignmentStatus {
  ACTIVE = "active",
  REVOKED = "revoked",
}

export enum LicenseActivationStatus {
  ACTIVE = "active",
  DEACTIVATED = "deactivated",
  BLOCKED = "blocked",
}

export enum LicenseAuditAction {
  KEY_IMPORTED = "key_imported",
  KEY_ASSIGNED = "key_assigned",
  KEY_REVEALED = "key_revealed",
  ACTIVATED = "activated",
  DEACTIVATED = "deactivated",
  REVOKED = "revoked",
  VALIDATION_FAILED = "validation_failed",
}

export enum DownloadGrantStatus {
  ACTIVE = "active",
  EXHAUSTED = "exhausted",
  REVOKED = "revoked",
  EXPIRED = "expired",
}

export enum AccessSessionStatus {
  PENDING = "pending",
  ACTIVE = "active",
  REVOKED = "revoked",
  EXPIRED = "expired",
}

export enum DownloadEventType {
  GRANTED = "granted",
  TRANSFER_STARTED = "transfer_started",
  TRANSFER_COMPLETED = "transfer_completed",
  TRANSFER_FAILED = "transfer_failed",
  DOWNLOADED = "downloaded",
  STREAMED = "streamed",
  DENIED = "denied",
  EXPIRED = "expired",
  REVOKED = "revoked",
}

export enum FulfillmentOperationState {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
  CANCELED = "canceled",
}

export enum NotificationDeliveryState {
  PENDING = "pending",
  PROCESSING = "processing",
  SENT = "sent",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
  CANCELED = "canceled",
}

export enum NotificationChannel {
  EMAIL = "email",
  WEBHOOK = "webhook",
}

export enum DigitalUploadStatus {
  PENDING = "pending",
  UPLOADED = "uploaded",
  COMPLETED = "completed",
  FAILED = "failed",
  EXPIRED = "expired",
}

export enum DigitalUploadPurpose {
  DOWNLOAD = "download",
  STREAM = "stream",
  ASSET = "asset",
  PREVIEW = "preview",
  COVER = "cover",
  MANUAL = "manual",
  LICENSE = "license",
  KEY_IMPORT = "key_import",
}

/** Canonical policy vocabulary consumed by refund/cancellation subscribers. */
export type RevocationPolicy =
  | "retain"
  | "any_refund"
  | "full_refund"
  | "refunded_items"
  | "all"

export type JsonObject = Record<string, unknown>

export interface DigitalDownloadsLocalStorageOptions {
  rootPath?: string
  /** Secret used to sign protected local-file descriptors. */
  signingSecret?: string
}

export interface DigitalDownloadsS3StorageOptions {
  endpoint?: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  forcePathStyle?: boolean
  allowInsecureEndpoint?: boolean
  prefix?: string
}

export interface DigitalDownloadsModuleOptions {
  storage?: {
    defaultProvider?: DigitalStorageProvider | `${DigitalStorageProvider}`
    local?: DigitalDownloadsLocalStorageOptions
    s3?: DigitalDownloadsS3StorageOptions
  }
  /** Arbitrary UTF-8 HMAC secret containing at least 32 bytes. */
  tokenSecret?: string
  /** Dedicated 32-byte key encoded as 64 hex characters; differs from tokenSecret. */
  encryptionKey?: string
  defaultDownloadLimit?: number | null
  defaultGrantTtlSeconds?: number
  maxGrantTtlSeconds?: number
  maxUploadSizeBytes?: number
  allowedMimeTypes?: string[]
  allowGuestAccess?: boolean
  refundPolicy?: RevocationPolicy
  cancellationPolicy?: RevocationPolicy
}

export interface ResolvedDigitalDownloadsModuleOptions {
  storage: {
    defaultProvider: DigitalStorageProvider
    local: Required<DigitalDownloadsLocalStorageOptions>
    s3?: DigitalDownloadsS3StorageOptions & {
      endpoint: string
      region: string
      forcePathStyle: boolean
      allowInsecureEndpoint: boolean
      prefix: string
    }
  }
  /** Arbitrary UTF-8 HMAC secret containing at least 32 bytes. */
  tokenSecret?: string
  /** Dedicated 32-byte key encoded as 64 hex characters; differs from tokenSecret. */
  encryptionKey?: string
  defaultDownloadLimit: number | null
  defaultGrantTtlSeconds: number
  maxGrantTtlSeconds: number
  maxUploadSizeBytes: number
  allowedMimeTypes: string[]
  allowGuestAccess: boolean
  refundPolicy: RevocationPolicy
  cancellationPolicy: RevocationPolicy
}

export interface CreateDigitalProductConfigInput {
  title: string
  handle?: string
  description?: string | null
  status?: DigitalProductStatus
  delivery_type?: DigitalDeliveryMode
  fulfillment_required?: boolean
  metadata?: JsonObject
}

export type UpdateDigitalProductConfigInput = Partial<CreateDigitalProductConfigInput> & {
  id: string
}

export interface IssueOrderEntitlementItemInput {
  digital_product_id: string
  release_id?: string | null
  order_line_item_id: string
  quantity?: number
  download_limit?: number | null
  license_activation_limit?: number | null
  expires_at?: Date | string | null
  snapshot?: JsonObject
  metadata?: JsonObject
}

/** Canonical durable row accepted from fulfillment orchestration. */
export interface IssueEntitlementRowInput {
  idempotency_key: string
  order_id: string
  line_item_id: string
  customer_id?: string | null
  email?: string | null
  customer_name?: string | null
  digital_product_id: string
  digital_product_release_id?: string | null
  fulfillment_id?: string | null
  unit_index: number
  quantity?: number
  status?: DigitalEntitlementStatus
  available_at?: Date | string | null
  expires_at?: Date | string | null
  download_limit?: number | null
  license_activation_limit?: number | null
  snapshot?: JsonObject
  metadata?: JsonObject
}

export interface IssueOrderEntitlementsInput {
  order_id: string
  fulfillment_id?: string | null
  customer_id?: string | null
  customer_email: string
  customer_name?: string | null
  items: IssueOrderEntitlementItemInput[]
}

export interface CreateDownloadGrantInput {
  entitlement_id: string
  asset_id: string
  /** Internal proof binding a guest capability to grant minting. */
  guest_session_id?: string
  idempotency_key: string
  ttl_seconds?: number
  max_uses?: number
  action?: "download" | "stream"
  bind_ip?: string
  bind_user_agent?: string
  metadata?: JsonObject
}

export interface RedeemDownloadGrantContext {
  ip?: string
  ip_hash?: string
  user_agent?: string
  user_agent_hash?: string
  asset_id?: string
  action?: "download" | "stream"
  range?: { start?: number; end?: number }
  range_header?: string | null
  event_type?: DownloadEventType.DOWNLOADED | DownloadEventType.STREAMED
}

export interface OpenDigitalAssetInput {
  purpose: "preview" | "delivery" | "download" | "stream"
  grant_id?: string
  grant?: Record<string, any>
  start?: number
  end?: number
}

export interface OpenDigitalAssetResult {
  body: Readable
  size: number
  total_size: number
  mime_type: string
  filename: string
  etag: string
  last_modified?: Date
  status_code: 200 | 206
  content_range?: string
}

export interface ImportLicenseKeysInput {
  license_policy_id: string
  keys: string[]
  batch_id?: string
  duplicate_policy?: "reject" | "skip"
  metadata?: JsonObject
}

export interface AssignLicenseKeyInput {
  entitlement_id: string
  license_policy_id: string
  idempotency_key: string
  external_key?: string
  metadata?: JsonObject
}

export interface ActivateLicenseInput {
  assignment_id: string
  device_id: string
  device_name?: string | null
  ip?: string
  user_agent?: string
  metadata?: JsonObject
}

export interface CreateGuestAccessSessionInput {
  entitlement_id: string
  idempotency_key: string
  /** Internal delivery state; public issuance defaults to active. */
  initial_status?: AccessSessionStatus.ACTIVE | AccessSessionStatus.PENDING
  ttl_seconds?: number
  bind_ip?: string
  bind_user_agent?: string
  metadata?: JsonObject
}

export interface LicenseKeyClientInput {
  license_key: string
  instance_id?: string
  label?: string | null
  ip?: string
  user_agent?: string
  metadata?: JsonObject
  idempotency_key?: string
}

export type DigitalProductFindConfig = FindConfig<Record<string, unknown>>

export interface SafeDigitalAsset {
  id: string
  release_id: string | null
  name: string
  role: DigitalAssetRole
  kind: DigitalAssetKind
  status: DigitalAssetStatus
  delivery_type: DigitalDeliveryMode
  original_filename: string
  mime_type: string
  size_bytes: number
  checksum_sha256: string
  version: string
  sort_order: number
  metadata: JsonObject
}

export interface SafeLicensePoolKey {
  id: string
  license_policy_id: string
  status: LicensePoolKeyStatus
  key_hint: string
  batch_id: string | null
  reserved_at: Date | null
  assigned_at: Date | null
  metadata: JsonObject
}
