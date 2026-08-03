import type { S3Client } from "@aws-sdk/client-s3"
import type { FindConfig } from "@medusajs/framework/types"
import type { Readable } from "node:stream"

export declare const DIGITAL_DOWNLOADS_MODULE = "digitalDownloads"

export declare enum DigitalProductStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  ARCHIVED = "archived",
}

export declare enum DigitalDeliveryMode {
  DOWNLOAD = "download",
  STREAM = "stream",
  LICENSE = "license",
  MIXED = "mixed",
}

export declare enum DigitalReleaseStatus {
  DRAFT = "draft",
  READY = "ready",
  PUBLISHED = "published",
  RETIRED = "retired",
}

export declare enum DigitalAssetRole {
  DOWNLOAD = "download",
  STREAM = "stream",
  PREVIEW = "preview",
  COVER = "cover",
  MANUAL = "manual",
  LICENSE = "license",
}

export declare enum DigitalAssetKind {
  FILE = "file",
  PDF = "pdf",
  AUDIO = "audio",
  VIDEO = "video",
  IMAGE = "image",
  ARCHIVE = "archive",
  LICENSE = "license",
}

export declare enum DigitalAssetStatus {
  STAGED = "staged",
  PROCESSING = "processing",
  READY = "ready",
  QUARANTINED = "quarantined",
  FAILED = "failed",
  RETIRED = "retired",
}

export declare enum DigitalStorageProvider {
  LOCAL = "local",
  S3 = "s3",
}

export declare enum DigitalEntitlementStatus {
  PENDING = "pending",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  REVOKED = "revoked",
  EXPIRED = "expired",
  REFUNDED = "refunded",
}

export declare enum DigitalEntitlementSource {
  ORDER = "order",
  MANUAL = "manual",
  IMPORT = "import",
}

export declare enum LicenseStrategy {
  NONE = "none",
  POOL = "pool",
  GENERATED = "generated",
  EXTERNAL = "external",
}

export declare enum LicensePoolKeyStatus {
  AVAILABLE = "available",
  RESERVED = "reserved",
  ASSIGNED = "assigned",
  REVOKED = "revoked",
}

export declare enum LicenseAssignmentStatus {
  ACTIVE = "active",
  REVOKED = "revoked",
}

export declare enum LicenseActivationStatus {
  ACTIVE = "active",
  DEACTIVATED = "deactivated",
  BLOCKED = "blocked",
}

export declare enum LicenseAuditAction {
  KEY_IMPORTED = "key_imported",
  KEY_ASSIGNED = "key_assigned",
  KEY_REVEALED = "key_revealed",
  ACTIVATED = "activated",
  DEACTIVATED = "deactivated",
  REVOKED = "revoked",
  VALIDATION_FAILED = "validation_failed",
}

export declare enum DownloadGrantStatus {
  ACTIVE = "active",
  EXHAUSTED = "exhausted",
  REVOKED = "revoked",
  EXPIRED = "expired",
}

export declare enum AccessSessionStatus {
  PENDING = "pending",
  ACTIVE = "active",
  REVOKED = "revoked",
  EXPIRED = "expired",
}

export declare enum DownloadEventType {
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

export declare enum FulfillmentOperationState {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
  CANCELED = "canceled",
}

export declare enum NotificationDeliveryState {
  PENDING = "pending",
  PROCESSING = "processing",
  SENT = "sent",
  FAILED = "failed",
  DEAD_LETTER = "dead_letter",
  CANCELED = "canceled",
}

export declare enum NotificationChannel {
  EMAIL = "email",
  WEBHOOK = "webhook",
}

export declare enum DigitalUploadStatus {
  PENDING = "pending",
  UPLOADED = "uploaded",
  COMPLETED = "completed",
  FAILED = "failed",
  EXPIRED = "expired",
}

export declare enum DigitalUploadPurpose {
  DOWNLOAD = "download",
  STREAM = "stream",
  ASSET = "asset",
  PREVIEW = "preview",
  COVER = "cover",
  MANUAL = "manual",
  LICENSE = "license",
  KEY_IMPORT = "key_import",
}

export type RevocationPolicy =
  | "retain"
  | "any_refund"
  | "full_refund"
  | "refunded_items"
  | "all"

export type JsonObject = Record<string, unknown>
export type DigitalRecord = Record<string, unknown>
export type DigitalDownloadsServiceContext = Record<string, unknown>

export interface DigitalDownloadsLocalStorageOptions {
  rootPath?: string
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
  /** Lifetime of guest purchase-access capabilities; independent of asset grants. */
  guestAccessTtlSeconds?: number
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
  guestAccessTtlSeconds: number
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

export type UpdateDigitalProductConfigInput =
  Partial<CreateDigitalProductConfigInput> & { id: string }

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
  /** Internal orchestration control. Omitted values preserve direct-call behavior. */
  create_guest_access?: boolean
}

export interface IssueOrderEntitlementsInput {
  order_id: string
  fulfillment_id?: string | null
  customer_id?: string | null
  customer_email: string
  customer_name?: string | null
  items: IssueOrderEntitlementItemInput[]
}

export interface ReissueEntitlementInput {
  entitlementId?: string
  entitlement_id?: string
  reason?: string
  reset_downloads?: boolean
  rotate_guest_token?: boolean
  expires_at?: Date | string | null
  expiresAt?: Date | string | null
  create_guest_access?: boolean
  notify?: boolean
}

export interface RevokeEntitlementWithNotificationInput {
  entitlement_id: string
  reason: string
  actor?: { type?: string; id?: string }
  notify?: boolean
  final_status?: DigitalEntitlementStatus.REVOKED | DigitalEntitlementStatus.REFUNDED
}

export interface RevokeOrderEntitlementsInput {
  order_id: string
  line_item_ids?: string[]
  reason: string
  trigger?: "refund" | "cancellation" | "chargeback" | "manual"
  notify?: boolean
  actor?: { type?: string; id?: string }
}

export interface ListLifecycleNotificationRepairCandidatesInput {
  limit?: number
  as_of?: Date | string
}

export interface LifecycleNotificationRepairCandidate {
  id: string
  status:
    | DigitalEntitlementStatus.EXPIRED
    | DigitalEntitlementStatus.REVOKED
    | DigitalEntitlementStatus.REFUNDED
  reason: string
}

export interface ExpireEntitlementIfDueInput {
  entitlement_id: string
  as_of: Date | string
  reason?: string
}

export interface RepairLifecycleNotificationInput {
  entitlement_id: string
  expected_status:
    | DigitalEntitlementStatus.EXPIRED
    | DigitalEntitlementStatus.REVOKED
    | DigitalEntitlementStatus.REFUNDED
  reason: string
}

export interface CreateDownloadGrantInput {
  entitlement_id: string
  asset_id: string
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
  grant?: DigitalRecord
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
  /** Internal reissue control: rotate an otherwise active assignment. */
  replace_existing?: boolean
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
  /** Internal generation fence used by notification delivery. */
  expected_guest_access_epoch?: number
  ttl_seconds?: number
  bind_ip?: string
  bind_user_agent?: string
  metadata?: JsonObject
}

export interface ActivateGuestAccessSessionInput {
  /** Internal generation fence used by notification delivery. */
  expected_guest_access_epoch?: number
  /** Binds notification-created sessions to their owning outbox row. */
  notification_delivery_id?: string
}

export interface FinalizeNotificationGuestAccessInput {
  delivery_id: string
  entitlement_id: string
  session_id: string
  expected_guest_access_epoch: number
  worker_id: string
  attempt: number
  provider_message_id?: string | null
}

export type FinalizeNotificationGuestAccessResult =
  | {
      outcome: "sent"
      delivery: Record<string, unknown>
      session: Record<string, unknown>
    }
  | {
      outcome: "superseded"
      delivery: Record<string, unknown>
      session: Record<string, unknown>
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

export interface InitiateDigitalAssetUploadInput {
  release_id?: string
  filename: string
  size: number
  mime_type: string
  checksum_sha256?: string
  storage_provider?: DigitalStorageProvider
  purpose?: DigitalUploadPurpose
  metadata?: JsonObject
}

export interface CompleteDigitalAssetUploadInput {
  release_id?: string
  purpose?: DigitalUploadPurpose
  checksum_sha256?: string
  size?: number
  etag?: string
}

export interface UploadDigitalAssetInput {
  release_id: string
  filename: string
  mime_type: string
  bytes: Buffer | Uint8Array
  checksum_sha256?: string
  purpose?: DigitalUploadPurpose
  storage_provider?: DigitalStorageProvider
  metadata?: JsonObject
}

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

export type DigitalProductFindConfig = FindConfig<DigitalRecord>

export interface StorageObjectLocator {
  key: string
  bucket?: string | null
}

export interface StoragePutInput extends StorageObjectLocator {
  body: Buffer | Uint8Array
  contentType: string
  checksumSha256?: string
  overwrite?: boolean
}

export interface StoragePutStreamInput extends StorageObjectLocator {
  body: Readable
  contentType: string
  expectedSize: number
  checksumSha256?: string
  overwrite?: boolean
}

export interface StorageReadInput extends StorageObjectLocator {
  start?: number
  end?: number
}

export interface StorageObjectResult {
  body: Readable
  size: number
  totalSize: number
  contentType: string
  etag: string
  lastModified?: Date
  statusCode: 200 | 206
  contentRange?: string
}

export interface ProtectedStorageDescriptor {
  provider: DigitalStorageProvider
  url: string
  expiresAt: Date
}

export interface StorageObjectMetadata {
  size: number
  contentType: string
  checksumSha256?: string
  etag?: string
  lastModified?: Date
}

export interface StorageUploadDescriptor {
  method: "PUT"
  url: string
  headers: Record<string, string>
  expiresAt: Date
}

export interface StorageWriteResult {
  key: string
  size: number
  checksumSha256: string
  etag: string
}

export interface StorageDriver {
  readonly provider: DigitalStorageProvider
  put(input: StoragePutInput): Promise<StorageWriteResult>
  putStream?(input: StoragePutStreamInput): Promise<StorageWriteResult>
  get(input: StorageReadInput): Promise<StorageObjectResult>
  delete(locator: StorageObjectLocator): Promise<void>
  exists(locator: StorageObjectLocator): Promise<boolean>
  inspect?(locator: StorageObjectLocator): Promise<StorageObjectMetadata>
  computeChecksum?(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }>
  createUploadDescriptor?(
    locator: StorageObjectLocator,
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ): Promise<StorageUploadDescriptor>
  createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor>
  destroy?(): void
}

export declare class ProtectedLocalStorageDriver implements StorageDriver {
  readonly provider: DigitalStorageProvider.LOCAL
  constructor(options: { rootPath: string; signingSecret?: string })
  put(input: StoragePutInput): Promise<StorageWriteResult>
  putStream(input: StoragePutStreamInput): Promise<StorageWriteResult>
  get(input: StorageReadInput): Promise<StorageObjectResult>
  inspect(locator: StorageObjectLocator): Promise<StorageObjectMetadata>
  computeChecksum(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }>
  delete(locator: StorageObjectLocator): Promise<void>
  exists(locator: StorageObjectLocator): Promise<boolean>
  createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor>
  verifyProtectedDescriptor(url: string, now?: Date): StorageObjectLocator
}

export declare class S3CompatibleStorageDriver implements StorageDriver {
  readonly provider: DigitalStorageProvider.S3
  constructor(
    options: NonNullable<ResolvedDigitalDownloadsModuleOptions["storage"]["s3"]>,
    client?: S3Client,
  )
  destroy(): void
  put(input: StoragePutInput): Promise<StorageWriteResult>
  get(input: StorageReadInput): Promise<StorageObjectResult>
  delete(locator: StorageObjectLocator): Promise<void>
  exists(locator: StorageObjectLocator): Promise<boolean>
  inspect(locator: StorageObjectLocator): Promise<StorageObjectMetadata>
  computeChecksum(locator: StorageObjectLocator): Promise<{
    size: number
    checksumSha256: string
  }>
  createUploadDescriptor(
    locator: StorageObjectLocator,
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ): Promise<StorageUploadDescriptor>
  createProtectedDescriptor(
    locator: StorageObjectLocator,
    expiresInSeconds: number,
  ): Promise<ProtectedStorageDescriptor>
}

export declare class DigitalDownloadsStorageManager {
  readonly defaultProvider: DigitalStorageProvider
  constructor(options: ResolvedDigitalDownloadsModuleOptions)
  driver(provider?: DigitalStorageProvider): StorageDriver
  put(input: StoragePutInput & { provider?: DigitalStorageProvider }): Promise<StorageWriteResult>
  putStream(
    input: StoragePutStreamInput & { provider?: DigitalStorageProvider },
  ): Promise<StorageWriteResult>
  get(
    input: StorageReadInput & { provider: DigitalStorageProvider },
  ): Promise<StorageObjectResult>
  delete(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ): Promise<void>
  exists(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ): Promise<boolean>
  inspect(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ): Promise<StorageObjectMetadata>
  computeChecksum(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
  ): Promise<{ size: number; checksumSha256: string }>
  createUploadDescriptor(
    locator: StorageObjectLocator & { provider: DigitalStorageProvider },
    input: {
      contentType: string
      checksumSha256?: string
      expectedSize?: number
    },
    expiresInSeconds: number,
  ): Promise<StorageUploadDescriptor>
  destroy(): void
}

export type SanitizedStorageProviderError = Error & {
  code: string
  status?: number
}

export declare function safeProviderStatus(error: unknown): number | undefined
export declare function safeProviderCode(error: unknown): string | undefined
export declare function sanitizedProviderError(
  provider: "local" | "s3",
  operation: string,
  error: unknown,
): SanitizedStorageProviderError
export declare function withSanitizedProviderError<T>(
  provider: "local" | "s3",
  operation: string,
  callback: () => Promise<T>,
): Promise<T>
export declare function withSanitizedProviderErrorSync<T>(
  provider: "local" | "s3",
  operation: string,
  callback: () => T,
): T

export declare function sha256(input: string | Buffer | Uint8Array): string
export declare function keyedFingerprint(
  value: string,
  secret: string | undefined,
  context?: string,
): string
export declare function normalizeAndFingerprint(
  value: string | undefined,
  secret: string | undefined,
  context: "ip" | "user-agent" | "device" | "recipient",
): string | null
export declare function randomOpaqueToken(prefix?: string, bytes?: number): string
export declare function deriveOpaqueToken(
  idempotencyKey: string,
  secret: string | undefined,
  prefix?: string,
): string
export declare function tokenHash(
  token: string,
  secret: string | undefined,
): string
export declare function safeHashEqual(left: string, right: string): boolean
export declare function encryptSecret(
  plaintext: string,
  secret: string | undefined,
): string
export declare function decryptSecret(
  envelope: string,
  secret: string | undefined,
): string

export declare const DEFAULT_LICENSE_PATTERN =
  "{ALNUM:5}-{ALNUM:5}-{ALNUM:5}-{ALNUM:5}"
export declare function validateLicensePattern(pattern: string): void
export declare function generateLicenseKey(pattern?: string): string
export declare function normalizeLicenseKey(value: string): string
export declare function licenseKeyHint(value: string): string
export declare const MIN_GUEST_ACCESS_TTL_SECONDS: number
export declare const DEFAULT_GUEST_ACCESS_TTL_SECONDS: number
export declare const MAX_GUEST_ACCESS_TTL_SECONDS: number
export declare function resolveDigitalDownloadsOptions(
  options?: DigitalDownloadsModuleOptions,
  env?: NodeJS.ProcessEnv,
): ResolvedDigitalDownloadsModuleOptions
export declare function digitalDownloadsStorageNamespaceFingerprint(
  options: ResolvedDigitalDownloadsModuleOptions,
): string
export declare function assertMimeTypeAllowed(
  mimeType: string,
  allowedMimeTypes: string[],
): void
export declare function assertSafeAttribution(value: {
  attribution_label?: unknown
  attribution_url?: unknown
}): void
export declare function toSafeDigitalAsset(value: unknown): SafeDigitalAsset
export declare function toSafeLicensePoolKey(value: unknown): SafeLicensePoolKey
export declare function toSafeDownloadGrant(
  value: unknown,
): Record<string, unknown>

export interface DigitalModelDefinition {
  readonly name?: string
  readonly tableName?: string
  readonly [key: string]: unknown
}

export declare const DigitalAsset: DigitalModelDefinition
export declare const DigitalDownloadsSettings: DigitalModelDefinition
export declare const DigitalEntitlement: DigitalModelDefinition
export declare const EntitlementAccessSession: DigitalModelDefinition
export declare const DigitalProduct: DigitalModelDefinition
export declare const DigitalProductRelease: DigitalModelDefinition
export declare const DigitalUpload: DigitalModelDefinition
export declare const DownloadEvent: DigitalModelDefinition
export declare const DownloadGrant: DigitalModelDefinition
export declare const FulfillmentOperation: DigitalModelDefinition
export declare const LicenseActivation: DigitalModelDefinition
export declare const LicenseAssignment: DigitalModelDefinition
export declare const LicenseAuditEvent: DigitalModelDefinition
export declare const LicensePolicy: DigitalModelDefinition
export declare const LicensePoolKey: DigitalModelDefinition
export declare const NotificationDelivery: DigitalModelDefinition

export interface DownloadGrantRedemption {
  authorized: true
  grant: DigitalRecord
  asset: SafeDigitalAsset
  grant_id: string
  event_id: string
  asset_id: string
  total_size: number
  size: number
  filename: string
  mime_type: string
  action: "download" | "stream"
}

export interface DigitalDownloadsReport {
  product_configs: number
  active_product_configs: number
  assets: number
  storage_bytes: number
  active_entitlements: number
  downloads_30d: number
  revoked_entitlements: number
}

export declare class DigitalDownloadsModuleService {
  constructor(container: unknown)
  listDigitalProductConfigs(
    filters?: DigitalRecord,
    config?: DigitalProductFindConfig,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  retrieveDigitalProductConfig(
    id: string,
    config?: DigitalProductFindConfig,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  createDigitalProductConfigs(
    data: CreateDigitalProductConfigInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  createDigitalProductConfigs(
    data: CreateDigitalProductConfigInput[],
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  updateDigitalProductConfigs(
    data: UpdateDigitalProductConfigInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  updateDigitalProductConfigs(
    data: UpdateDigitalProductConfigInput[],
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  deleteDigitalProductConfigs(
    ids: string | string[],
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<void>
  publishDigitalProductRelease(
    id: string,
    input?: {
      make_active?: boolean
      makeActive?: boolean
      notify_existing_customers?: boolean
      notifyExistingCustomers?: boolean
    },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  publishRelease(
    id: string,
    input?: {
      make_active?: boolean
      makeActive?: boolean
      notify_existing_customers?: boolean
      notifyExistingCustomers?: boolean
    },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  issueOrderEntitlements(
    input:
      | IssueEntitlementRowInput
      | IssueEntitlementRowInput[]
      | IssueOrderEntitlementsInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  revokeEntitlement(
    id: string,
    reason: string,
    actor?: { type?: string; id?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  revokeEntitlementWithNotification(
    input: RevokeEntitlementWithNotificationInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ entitlement: DigitalRecord; delivery?: DigitalRecord }>
  revokeOrderEntitlements(
    input: RevokeOrderEntitlementsInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ revoked: DigitalRecord[]; deliveries: DigitalRecord[] }>
  listLifecycleNotificationRepairCandidates(
    input?: ListLifecycleNotificationRepairCandidatesInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<LifecycleNotificationRepairCandidate[]>
  expireEntitlement(
    id: string,
    reason?: string,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ entitlement: DigitalRecord; delivery?: DigitalRecord }>
  expireEntitlementIfDue(
    input: ExpireEntitlementIfDueInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    entitlement: DigitalRecord
    delivery?: DigitalRecord
    expired: boolean
  }>
  repairLifecycleNotification(
    input: RepairLifecycleNotificationInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    entitlement: DigitalRecord
    delivery?: DigitalRecord
    repaired: boolean
  }>
  reissueEntitlement(
    input: ReissueEntitlementInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    entitlement: DigitalRecord
    guest_access?: { session: DigitalRecord; token: string }
    guest_access_required?: boolean
    delivery?: DigitalRecord
  }>
  createDownloadGrant(
    input: CreateDownloadGrantInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ grant: DigitalRecord; token: string; created: boolean }>
  createGuestAccessSession(
    input: CreateGuestAccessSessionInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ session: DigitalRecord; token: string; created: boolean }>
  revokeGuestAccessSession(
    sessionId: string,
    reason?: string,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  activateGuestAccessSession(
    sessionId: string,
    input?: ActivateGuestAccessSessionInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  finalizeNotificationGuestAccess(
    input: FinalizeNotificationGuestAccessInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<FinalizeNotificationGuestAccessResult>
  resolveGuestEntitlement(
    rawToken: string,
    request?: { ip?: string; user_agent?: string; email?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ entitlement: DigitalRecord; session: DigitalRecord }>
  getGuestAccess(
    rawToken: string,
    request?: { ip?: string; user_agent?: string; email?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ entitlement: DigitalRecord; session: DigitalRecord }>
  redeemDownloadGrant(
    rawToken: string,
    request?: RedeemDownloadGrantContext,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DownloadGrantRedemption>
  commitDownloadGrantUse(
    eventId: string,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ event: DigitalRecord; grant: DigitalRecord }>
  commitDownloadEvent(
    eventId: string,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ event: DigitalRecord; grant: DigitalRecord }>
  completeDownloadGrant(
    eventId: string,
    input?: { bytes_transferred?: number },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ event: DigitalRecord; grant: DigitalRecord }>
  openDigitalAsset(
    assetId: string,
    input: OpenDigitalAssetInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<OpenDigitalAssetResult>
  initiateDigitalAssetUpload(
    input: InitiateDigitalAssetUploadInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  receiveDigitalAssetUpload(
    uploadId: string,
    input: {
      stream: Readable
      content_length: number
      content_type: string
      upload_token: string
    },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  completeDigitalAssetUpload(
    uploadId: string,
    input?: CompleteDigitalAssetUploadInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  uploadDigitalAsset(
    input: UploadDigitalAssetInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  getReadinessDiagnostics(): Promise<{
    ready: boolean
    provider: DigitalStorageProvider
    issues: string[]
  }>
  testStorage(input?: {
    operation?: "health" | "write_read_delete"
    provider?: DigitalStorageProvider
  }): Promise<DigitalRecord>
  importLicenseKeys(
    input: ImportLicenseKeysInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<SafeLicensePoolKey[]>
  assignLicenseKey(
    input: AssignLicenseKeyInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ assignment: DigitalRecord; license_key: string; created: boolean }>
  activateLicense(
    input: ActivateLicenseInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    activation: DigitalRecord
    assignment: DigitalRecord
    created: boolean
  }>
  activateLicenseByKey(
    input: LicenseKeyClientInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    activation: DigitalRecord
    assignment: DigitalRecord
    created: boolean
  }>
  deactivateLicenseByKey(
    input: LicenseKeyClientInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    deactivated: boolean
    assignment: DigitalRecord
    license: DigitalRecord
    activation?: DigitalRecord
  }>
  heartbeatLicenseByKey(
    input: LicenseKeyClientInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    valid: true
    activation: DigitalRecord
    assignment: DigitalRecord
  }>
  validateLicenseByKey(
    input: LicenseKeyClientInput,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{
    valid: boolean
    reason?: string
    assignment?: DigitalRecord
    activation?: DigitalRecord
  }>
  revealLicenseKey(
    input: {
      assignment_id: string
      customer_id?: string
      guest_token?: string
      ip?: string
      user_agent?: string
    },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<{ assignment: DigitalRecord; license_key: string }>
  getSettings(
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  updateSettings(
    input: DigitalRecord,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord>
  claimFulfillmentOperations(
    workerId: string,
    limit?: number,
    leaseSeconds?: number,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  claimNotificationDeliveries(
    workerId: string,
    limit?: number,
    leaseSeconds?: number,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord[]>
  claimNotificationDelivery(
    deliveryId: string,
    workerId: string,
    options?: { lease_seconds?: number; expected_lease_owner?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord | null>
  transitionClaimedNotificationDelivery(
    deliveryId: string,
    workerId: string,
    update: DigitalRecord,
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalRecord | null>
  getDigitalDownloadsReport(
    input?: { from?: Date | string; to?: Date | string; product_config_id?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalDownloadsReport>
  getDigitalDownloadsSummary(
    input?: { from?: Date | string; to?: Date | string; product_config_id?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalDownloadsReport>
  getReportingSummary(
    input?: { from?: Date | string; to?: Date | string; product_config_id?: string },
    sharedContext?: DigitalDownloadsServiceContext,
  ): Promise<DigitalDownloadsReport>
  recipientHash(recipient: string): Promise<string>
}

export interface DigitalDownloadsModuleDefinition {
  readonly service: typeof DigitalDownloadsModuleService
  readonly loaders?: readonly unknown[]
  readonly linkable?: Record<string, unknown>
}

declare const digitalDownloadsModule: DigitalDownloadsModuleDefinition
export default digitalDownloadsModule
