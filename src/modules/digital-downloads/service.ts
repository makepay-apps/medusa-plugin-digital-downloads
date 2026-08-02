import type { Context, FindConfig } from "@medusajs/framework/types"
import type { Readable } from "node:stream"
import {
  InjectManager,
  InjectTransactionManager,
  MedusaContext,
  MedusaError,
  MedusaService,
} from "@medusajs/framework/utils"
import {
  DigitalAsset,
  DigitalDownloadsSettings,
  DigitalEntitlement,
  DigitalProduct,
  DigitalProductRelease,
  DigitalUpload,
  DownloadEvent,
  DownloadGrant,
  EntitlementAccessSession,
  FulfillmentOperation,
  LicenseActivation,
  LicenseAssignment,
  LicenseAuditEvent,
  LicensePolicy,
  LicensePoolKey,
  NotificationDelivery,
} from "./models"
import {
  DIGITAL_DOWNLOADS_SETTINGS_KEY,
  MAKEPAY_ATTRIBUTION_LABEL,
  MAKEPAY_ATTRIBUTION_URL,
} from "./models/digital-downloads-settings"
import { DigitalDownloadsStorageManager } from "./storage"
import {
  AccessSessionStatus,
  DigitalAssetKind,
  DigitalAssetRole,
  DigitalAssetStatus,
  DigitalDeliveryMode,
  DigitalEntitlementSource,
  DigitalEntitlementStatus,
  DigitalProductStatus,
  DigitalReleaseStatus,
  DigitalStorageProvider,
  DigitalUploadPurpose,
  DigitalUploadStatus,
  DownloadEventType,
  DownloadGrantStatus,
  FulfillmentOperationState,
  LicenseActivationStatus,
  LicenseAssignmentStatus,
  LicenseAuditAction,
  LicensePoolKeyStatus,
  LicenseStrategy,
  NotificationDeliveryState,
  type ActivateLicenseInput,
  type AssignLicenseKeyInput,
  type CreateDigitalProductConfigInput,
  type CreateDownloadGrantInput,
  type CreateGuestAccessSessionInput,
  type DigitalDownloadsModuleOptions,
  type ImportLicenseKeysInput,
  type IssueEntitlementRowInput,
  type IssueOrderEntitlementsInput,
  type LicenseKeyClientInput,
  type OpenDigitalAssetInput,
  type OpenDigitalAssetResult,
  type RedeemDownloadGrantContext,
  type ResolvedDigitalDownloadsModuleOptions,
  type UpdateDigitalProductConfigInput,
} from "./types"
import {
  assertMimeTypeAllowed,
  assertSafeAttribution,
  decryptSecret,
  deriveOpaqueToken,
  digitalDownloadsStorageNamespaceFingerprint,
  encryptSecret,
  generateLicenseKey,
  keyedFingerprint,
  licenseKeyHint,
  normalizeAndFingerprint,
  normalizeLicenseKey,
  resolveDigitalDownloadsOptions,
  randomOpaqueToken,
  safeHashEqual,
  sha256,
  toSafeDigitalAsset,
  toSafeDownloadGrant,
  toSafeLicensePoolKey,
  tokenHash,
  validateLicensePattern,
} from "./utils"

type AnyRecord = Record<string, any>
type ServiceContainer = AnyRecord & {
  digitalDownloadsOptions?: ResolvedDigitalDownloadsModuleOptions
  digitalDownloadsStorage?: DigitalDownloadsStorageManager
}

const TERMINAL_ENTITLEMENT_STATUSES = new Set<DigitalEntitlementStatus>([
  DigitalEntitlementStatus.REVOKED,
  DigitalEntitlementStatus.REFUNDED,
  DigitalEntitlementStatus.EXPIRED,
])

const RANGE_CONTINUATION_WINDOW_MS = 15 * 60 * 1000
const RANGE_CONTINUATION_MAX_REQUESTS = 64
const RANGE_CONTINUATION_MAX_ASSET_MULTIPLIER = 2

type CanonicalByteRange = { start: number; end: number; length: number }

function invalid(message: string): never {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message)
}

function forbidden(message: string): never {
  throw new MedusaError(MedusaError.Types.FORBIDDEN, message)
}

function conflict(message: string): never {
  throw new MedusaError(MedusaError.Types.CONFLICT, message)
}

async function collectBoundedStream(
  body: Readable,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Storage health-check response exceeded its bounded limit",
        )
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    // Also releases a provider socket/file handle if iteration failed or was
    // cancelled before EOF.
    body.destroy()
  }
}

function parseDate(
  value: Date | string | null | undefined,
  name: string,
): Date | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    invalid(`${name} must be a valid date`)
  }
  return parsed
}

function positiveInteger(
  value: unknown,
  name: string,
  { allowZero = false, max = 1_000_000 } = {},
): number {
  const minimum = allowZero ? 0 : 1
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > max
  ) {
    invalid(`${name} must be an integer between ${minimum} and ${max}`)
  }
  return value as number
}

function bounded(value: string, name: string, max = 512): string {
  const normalized = value?.trim()
  if (!normalized || normalized.length > max || /[\r\n\0]/.test(normalized)) {
    invalid(`${name} must contain 1-${max} safe characters`)
  }
  return normalized
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const email = value.trim().toLowerCase()
  if (
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    /[\r\n]/.test(email)
  ) {
    invalid("customer email is invalid")
  }
  return email
}

function canonicalByteRange(
  request: RedeemDownloadGrantContext,
  rawTotalSize: unknown,
): CanonicalByteRange | undefined {
  if (!request.range && !request.range_header) return undefined
  const totalSize = Number(rawTotalSize)
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) {
    invalid("Digital asset size is invalid")
  }

  let start: number
  let end: number
  if (request.range_header) {
    const header = request.range_header
    if (
      header.length > 200 ||
      header.includes(",") ||
      !/^bytes=(?:\d+-\d*|-\d+)$/.test(header)
    ) {
      invalid("Only one valid byte range is supported")
    }
    const value = header.slice("bytes=".length)
    if (value.startsWith("-")) {
      const suffix = Number(value.slice(1))
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        invalid("Byte range is invalid")
      }
      start = Math.max(0, totalSize - suffix)
      end = totalSize - 1
    } else {
      const [startText, endText] = value.split("-", 2)
      start = Number(startText)
      end = endText ? Number(endText) : totalSize - 1
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= totalSize
      ) {
        invalid("Byte range is not satisfiable")
      }
      end = Math.min(end, totalSize - 1)
    }
  } else {
    start = Number(request.range?.start)
    end = Number(request.range?.end)
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= totalSize
    ) {
      invalid("Byte range is not satisfiable")
    }
    end = Math.min(end, totalSize - 1)
  }
  return { start, end, length: end - start + 1 }
}

function slugify(value: string): string {
  const handle = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
  if (!handle) {
    invalid("A URL-safe product handle is required")
  }
  return handle
}

function safeFilename(value: string): string {
  const filename = value.trim()
  if (
    !filename ||
    filename.length > 255 ||
    /[\/\\\r\n\0]/.test(filename) ||
    filename === "." ||
    filename === ".."
  ) {
    invalid("filename is invalid")
  }
  return filename
}

function assetKind(mimeType: string, filename: string): DigitalAssetKind {
  if (mimeType === "application/pdf") return DigitalAssetKind.PDF
  if (mimeType.startsWith("audio/")) return DigitalAssetKind.AUDIO
  if (mimeType.startsWith("video/")) return DigitalAssetKind.VIDEO
  if (mimeType.startsWith("image/")) return DigitalAssetKind.IMAGE
  if (/\.(?:zip|tar|tgz|gz|7z|rar)$/i.test(filename)) {
    return DigitalAssetKind.ARCHIVE
  }
  return DigitalAssetKind.FILE
}

function uploadAssetIntent(purpose: DigitalUploadPurpose): {
  role: DigitalAssetRole
  deliveryType: DigitalDeliveryMode
} {
  switch (purpose) {
    case DigitalUploadPurpose.STREAM:
      return {
        role: DigitalAssetRole.STREAM,
        deliveryType: DigitalDeliveryMode.STREAM,
      }
    case DigitalUploadPurpose.PREVIEW:
      return {
        role: DigitalAssetRole.PREVIEW,
        deliveryType: DigitalDeliveryMode.DOWNLOAD,
      }
    case DigitalUploadPurpose.COVER:
      return {
        role: DigitalAssetRole.COVER,
        deliveryType: DigitalDeliveryMode.DOWNLOAD,
      }
    case DigitalUploadPurpose.MANUAL:
      return {
        role: DigitalAssetRole.MANUAL,
        deliveryType: DigitalDeliveryMode.DOWNLOAD,
      }
    case DigitalUploadPurpose.LICENSE:
      return {
        role: DigitalAssetRole.LICENSE,
        deliveryType: DigitalDeliveryMode.LICENSE,
      }
    case DigitalUploadPurpose.DOWNLOAD:
    case DigitalUploadPurpose.ASSET:
      return {
        role: DigitalAssetRole.DOWNLOAD,
        deliveryType: DigitalDeliveryMode.DOWNLOAD,
      }
    case DigitalUploadPurpose.KEY_IMPORT:
      conflict("License key imports must use the dedicated key import endpoint")
  }
}

function isDuplicateError(error: unknown): boolean {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  while (pending.length) {
    const candidate = pending.shift() as AnyRecord | undefined
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    const message = String(candidate.message ?? "")
    if (
      candidate.type === MedusaError.Types.DUPLICATE_ERROR ||
      candidate.code === "23505" ||
      candidate.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      /(?:already exists|duplicate key|unique constraint)/i.test(message)
    ) {
      return true
    }
    if (typeof candidate === "object") {
      pending.push(candidate.cause, candidate.originalError, candidate.driverException)
    }
  }
  return false
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (entry instanceof Date) return entry.toISOString()
    if (Array.isArray(entry)) return entry.map(normalize)
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as AnyRecord)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      )
    }
    if (typeof entry === "bigint") return entry.toString()
    return entry
  }
  return JSON.stringify(normalize(value))
}

function sameInstant(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined) {
    return right === null || right === undefined
  }
  if (right === null || right === undefined) return false
  return new Date(left as string | number | Date).getTime() ===
    new Date(right as string | number | Date).getTime()
}

function entitlementMatches(existing: AnyRecord, requested: AnyRecord): boolean {
  return (
    existing.order_id === requested.order_id &&
    existing.order_line_item_id === requested.order_line_item_id &&
    existing.digital_product_id === requested.digital_product_id &&
    existing.release_id === requested.release_id &&
    existing.fulfillment_id === requested.fulfillment_id &&
    existing.unit_index === requested.unit_index &&
    existing.customer_id === requested.customer_id &&
    existing.customer_email === requested.customer_email &&
    existing.customer_name === requested.customer_name &&
    Number(existing.quantity) === Number(requested.quantity) &&
    (existing.download_limit === null
      ? requested.download_limit === null
      : Number(existing.download_limit) === Number(requested.download_limit)) &&
    (existing.license_activation_limit === null
      ? requested.license_activation_limit === null
      : Number(existing.license_activation_limit) ===
        Number(requested.license_activation_limit)) &&
    sameInstant(existing.available_at, requested.available_at) &&
    sameInstant(existing.expires_at, requested.expires_at) &&
    canonicalJson(existing.snapshot ?? {}) ===
      canonicalJson(requested.snapshot ?? {}) &&
    canonicalJson(existing.metadata ?? {}) ===
      canonicalJson(requested.metadata ?? {})
  )
}

function validateProductInput(
  value: CreateDigitalProductConfigInput | UpdateDigitalProductConfigInput,
  updating = false,
): AnyRecord {
  const result: AnyRecord = { ...value }
  if (!updating || value.title !== undefined) {
    result.title = bounded(value.title as string, "title", 255)
  }
  if (!updating || value.handle !== undefined || value.title !== undefined) {
    const handle = value.handle ?? value.title
    result.handle = slugify(bounded(handle as string, "handle", 255))
  }
  if (value.description !== undefined && value.description !== null) {
    result.description = bounded(value.description, "description", 100_000)
  }
  if (
    value.status !== undefined &&
    !Object.values(DigitalProductStatus).includes(value.status)
  ) {
    invalid("Invalid digital product status")
  }
  return result
}

function entitlementIsUsable(entitlement: AnyRecord, now: Date): void {
  if (entitlement.status !== DigitalEntitlementStatus.ACTIVE) {
    forbidden("Digital entitlement is not active")
  }
  const availableAt = entitlement.available_at
    ? new Date(entitlement.available_at)
    : null
  const expiresAt = entitlement.expires_at
    ? new Date(entitlement.expires_at)
    : null
  if (availableAt && availableAt > now) {
    forbidden("Digital entitlement is not available yet")
  }
  if (expiresAt && expiresAt <= now) {
    forbidden("Digital entitlement has expired")
  }
}

function assertReleaseDeliverables(
  release: AnyRecord,
  product: AnyRecord,
  assets: AnyRecord[],
  licensePolicy?: AnyRecord,
): AnyRecord[] {
  if (
    ![DigitalReleaseStatus.READY, DigitalReleaseStatus.PUBLISHED].includes(
      release.status,
    )
  ) {
    conflict("A release must be ready before it can be published")
  }
  const readyAssets = assets.filter(
    (asset) =>
      asset.release_id === release.id &&
      asset.is_enabled !== false &&
      asset.status === DigitalAssetStatus.READY,
  )
  const roles = new Set(readyAssets.map((asset) => asset.role))
  const hasDownload =
    roles.has(DigitalAssetRole.DOWNLOAD) || roles.has(DigitalAssetRole.MANUAL)
  const hasStream = roles.has(DigitalAssetRole.STREAM) || readyAssets.some(
    (asset) =>
      [DigitalDeliveryMode.STREAM, DigitalDeliveryMode.MIXED].includes(
        asset.delivery_type,
      ),
  )
  const hasLicense =
    roles.has(DigitalAssetRole.LICENSE) ||
    Boolean(
      licensePolicy?.is_enabled !== false &&
        licensePolicy?.strategy &&
        licensePolicy.strategy !== LicenseStrategy.NONE,
    )
  const valid =
    product.delivery_type === DigitalDeliveryMode.LICENSE
      ? hasLicense
      : product.delivery_type === DigitalDeliveryMode.STREAM
        ? hasStream
        : product.delivery_type === DigitalDeliveryMode.MIXED
          ? (hasDownload || hasStream) && hasLicense
          : hasDownload
  if (!valid) {
    conflict(
      `Release does not have ready deliverables for ${product.delivery_type} delivery`,
    )
  }
  return readyAssets
}

function releaseAssetManifest(assets: AnyRecord[]): string {
  return canonicalJson(
    assets
      .map((asset) => ({
        id: asset.id,
        release_id: asset.release_id ?? null,
        name: asset.name,
        role: asset.role,
        kind: asset.kind,
        status: asset.status,
        delivery_type: asset.delivery_type,
        storage_provider: asset.storage_provider,
        storage_key: asset.storage_key,
        storage_bucket: asset.storage_bucket ?? null,
        original_filename: asset.original_filename,
        mime_type: asset.mime_type,
        size_bytes: Number(asset.size_bytes),
        checksum_sha256: asset.checksum_sha256,
        version: asset.version,
        sort_order: Number(asset.sort_order),
        is_enabled: asset.is_enabled !== false,
        metadata: asset.metadata ?? {},
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id))),
  )
}

export default class DigitalDownloadsModuleService extends MedusaService({
  DigitalProduct,
  DigitalProductRelease,
  DigitalUpload,
  DigitalAsset,
  DigitalEntitlement,
  LicensePolicy,
  LicensePoolKey,
  LicenseAssignment,
  LicenseActivation,
  LicenseAuditEvent,
  DownloadGrant,
  DownloadEvent,
  EntitlementAccessSession,
  DigitalDownloadsSettings,
  FulfillmentOperation,
  NotificationDelivery,
}) {
  private readonly options_: ResolvedDigitalDownloadsModuleOptions
  private readonly storage_: DigitalDownloadsStorageManager

  constructor(container: ServiceContainer) {
    super(container)
    this.options_ =
      container.digitalDownloadsOptions ?? resolveDigitalDownloadsOptions()
    this.storage_ =
      container.digitalDownloadsStorage ??
      new DigitalDownloadsStorageManager(this.options_)
  }

  @InjectTransactionManager()
  protected async inTransaction_<T>(
    operation: (transactionContext: Context) => Promise<T>,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<T> {
    return operation(sharedContext)
  }

  private transactionKnex_(sharedContext: AnyRecord): any {
    const manager = (sharedContext as AnyRecord).transactionManager
    const knex = manager?.getTransactionContext?.()
    if (!knex) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "This operation requires a database transaction",
      )
    }
    return knex
  }

  private async lockRows_(
    table: string,
    ids: string[],
    sharedContext: AnyRecord,
  ): Promise<void> {
    if (!ids.length) return
    const allowedTables = new Set([
      "digital_asset",
      "digital_entitlement",
      "digital_product",
      "digital_product_release",
      "digital_upload",
      "download_event",
      "download_grant",
      "entitlement_access_session",
      "license_assignment",
      "license_policy",
    ])
    if (!allowedTables.has(table)) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Attempted to lock an unsupported digital-downloads table",
      )
    }
    const knex = this.transactionKnex_(sharedContext)
    await knex(table)
      .whereIn("id", [...new Set(ids)].sort())
      .orderBy("id")
      .forUpdate()
      .select("id")
  }

  /** Compatibility vocabulary used by admin/API adapters. */
  @InjectManager()
  async listDigitalProductConfigs(
    filters: AnyRecord = {},
    config: FindConfig<any> = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.listDigitalProducts(filters, config, sharedContext)
  }

  @InjectManager()
  async retrieveDigitalProductConfig(
    id: string,
    config: FindConfig<any> = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.retrieveDigitalProduct(id, config, sharedContext)
  }

  @InjectManager()
  async createDigitalProductConfigs(
    data: CreateDigitalProductConfigInput | CreateDigitalProductConfigInput[],
    @MedusaContext() sharedContext: Context = {},
  ) {
    const input = Array.isArray(data) ? data : [data]
    const result = await this.createDigitalProducts(
      input.map((entry) => validateProductInput(entry)),
      sharedContext,
    )
    return Array.isArray(data) ? result : result[0]
  }

  @InjectManager()
  async updateDigitalProductConfigs(
    data: UpdateDigitalProductConfigInput | UpdateDigitalProductConfigInput[],
    @MedusaContext() sharedContext: Context = {},
  ) {
    const input = Array.isArray(data) ? data : [data]
    const result = await this.updateDigitalProducts(
      input.map((entry) => ({
        ...validateProductInput(entry, true),
        id: bounded(entry.id, "id", 255),
      })),
      sharedContext,
    )
    return Array.isArray(data) ? result : result[0]
  }

  updateDigitalProducts = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.updateDigitalProducts(data, transactionContext),
        sharedContext,
      )
    }
    const updates = Array.isArray(data) ? data : [data]
    const ids = updates.map((entry) => {
      if (!entry.id) conflict("Digital product updates require explicit ids")
      return bounded(entry.id, "digital product id", 255)
    })
    await this.lockRows_("digital_product", ids, sharedContext)
    for (const [index, update] of updates.entries()) {
      if (
        (update.delivery_type !== undefined ||
          update.fulfillment_required !== undefined) &&
        (await this.productHasImmutableRelease_(ids[index], sharedContext))
      ) {
        const existing = await this.retrieveDigitalProduct(
          ids[index],
          { options: { refresh: true } } as any,
          sharedContext,
        )
        if (
          (update.delivery_type !== undefined &&
            update.delivery_type !== existing.delivery_type) ||
          (update.fulfillment_required !== undefined &&
            update.fulfillment_required !== existing.fulfillment_required)
        ) {
          conflict(
            "Digital product delivery configuration is immutable after publication or entitlement issuance",
          )
        }
      }
    }
    return this.callGenerated_("updateDigitalProducts", [data, sharedContext])
  }

  @InjectManager()
  async deleteDigitalProductConfigs(
    ids: string | string[],
    @MedusaContext() sharedContext: Context = {},
  ): Promise<void> {
    return this.deleteDigitalProducts(ids, sharedContext)
  }

  private async releaseIsImmutable_(
    releaseId: string | null | undefined,
    sharedContext: AnyRecord,
  ): Promise<boolean> {
    if (!releaseId) return false
    const release = await this.retrieveDigitalProductRelease(
      releaseId,
      {},
      sharedContext,
    )
    if (
      release.status === DigitalReleaseStatus.PUBLISHED ||
      release.status === DigitalReleaseStatus.RETIRED ||
      release.metadata?.asset_set_locked === true
    ) {
      return true
    }
    const entitlements = await this.listDigitalEntitlements(
      { release_id: releaseId },
      { take: 1 } as any,
      sharedContext,
    )
    return entitlements.length > 0
  }

  private async productHasImmutableRelease_(
    productId: string,
    sharedContext: AnyRecord,
  ): Promise<boolean> {
    const knex = this.transactionKnex_(sharedContext)
    const [release, entitlement] = await Promise.all([
      knex("digital_product_release")
        .where({ digital_product_id: productId, deleted_at: null })
        .whereIn("status", [
          DigitalReleaseStatus.PUBLISHED,
          DigitalReleaseStatus.RETIRED,
        ])
        .first("id"),
      knex("digital_entitlement")
        .where({ digital_product_id: productId, deleted_at: null })
        .first("id"),
    ])
    return Boolean(release || entitlement)
  }

  private callGenerated_<T>(name: string, args: unknown[]): Promise<T> {
    const generated = (Object.getPrototypeOf(
      DigitalDownloadsModuleService.prototype,
    ) as AnyRecord)[name]
    return generated.apply(this, args)
  }

  createDigitalAssets = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) => this.createDigitalAssets(data, transactionContext),
        sharedContext,
      )
    }
    const entries = Array.isArray(data) ? data : [data]
    const releaseIds = entries
      .map((entry) => entry.release_id)
      .filter((id): id is string => typeof id === "string" && Boolean(id))
      .map((id) => bounded(id, "release id", 255))
    await this.lockRows_("digital_product_release", releaseIds, sharedContext)
    for (const entry of entries) {
      if (await this.releaseIsImmutable_(entry.release_id, sharedContext)) {
        conflict("Published or entitlement-referenced releases are immutable")
      }
    }
    return this.callGenerated_("createDigitalAssets", [data, sharedContext])
  }

  updateDigitalAssets = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) => this.updateDigitalAssets(data, transactionContext),
        sharedContext,
      )
    }
    const updates = Array.isArray(data) ? data : [data]
    const assetIds = updates.map((update) => {
      if (!update.id) conflict("Digital asset updates require explicit ids")
      return bounded(update.id, "asset id", 255)
    })
    const observed = await Promise.all(
      assetIds.map((id) =>
        this.retrieveDigitalAsset(id, {}, sharedContext),
      ),
    )
    const releaseIds = updates
      .flatMap((update, index) => [observed[index].release_id, update.release_id])
      .filter((id): id is string => typeof id === "string" && Boolean(id))
      .map((id) => bounded(id, "release id", 255))
    await this.lockRows_("digital_product_release", releaseIds, sharedContext)
    await this.lockRows_("digital_asset", assetIds, sharedContext)
    const lockedReleaseIds = new Set(releaseIds)
    for (const update of updates) {
      const existing = await this.retrieveDigitalAsset(
        bounded(update.id, "asset id", 255),
        { options: { refresh: true } } as any,
        sharedContext,
      )
      if (
        existing.release_id &&
        !lockedReleaseIds.has(existing.release_id)
      ) {
        conflict("Digital asset changed concurrently; retry the update")
      }
      const changed = Object.entries(update).some(
        ([key, value]) =>
          key !== "id" && canonicalJson(existing[key]) !== canonicalJson(value),
      )
      if (
        changed &&
        (await this.releaseIsImmutable_(existing.release_id, sharedContext))
      ) {
        conflict("Published or entitlement-referenced assets are immutable")
      }
      if (
        update.release_id !== undefined &&
        update.release_id !== existing.release_id &&
        (await this.releaseIsImmutable_(update.release_id, sharedContext))
      ) {
        conflict("Assets cannot be attached to an immutable release")
      }
    }
    return this.callGenerated_("updateDigitalAssets", [data, sharedContext])
  }

  deleteDigitalAssets = async (
    ids: string | string[],
    sharedContext: Context = {},
  ): Promise<void> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) => this.deleteDigitalAssets(ids, transactionContext),
        sharedContext,
      )
    }
    const assetIds = (Array.isArray(ids) ? ids : [ids]).map((id) =>
      bounded(id, "asset id", 255),
    )
    const observed = await Promise.all(
      assetIds.map((id) =>
        this.retrieveDigitalAsset(id, {}, sharedContext),
      ),
    )
    const releaseIds = observed
      .map((asset) => asset.release_id)
      .filter((id): id is string => typeof id === "string" && Boolean(id))
    await this.lockRows_(
      "digital_product_release",
      releaseIds,
      sharedContext,
    )
    await this.lockRows_("digital_asset", assetIds, sharedContext)
    const lockedReleaseIds = new Set(releaseIds)
    const assets = await Promise.all(
      assetIds.map((id) =>
        this.retrieveDigitalAsset(
          id,
          { options: { refresh: true } } as any,
          sharedContext,
        ),
      ),
    )
    for (const asset of assets) {
      if (asset.release_id && !lockedReleaseIds.has(asset.release_id)) {
        conflict("Digital asset changed concurrently; retry the deletion")
      }
      if (await this.releaseIsImmutable_(asset.release_id, sharedContext)) {
        conflict("Published or entitlement-referenced assets cannot be deleted")
      }
    }
    return this.callGenerated_("deleteDigitalAssets", [ids, sharedContext])
  }

  updateDigitalProductReleases = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.updateDigitalProductReleases(data, transactionContext),
        sharedContext,
      )
    }
    const updates = Array.isArray(data) ? data : [data]
    const releaseIds = updates.map((update) => {
      if (!update.id) conflict("Digital release updates require explicit ids")
      return bounded(update.id, "release id", 255)
    })
    await this.lockRows_("digital_product_release", releaseIds, sharedContext)
    for (const update of updates) {
      const existing = await this.retrieveDigitalProductRelease(
        bounded(update.id, "release id", 255),
        { options: { refresh: true } } as any,
        sharedContext,
      )
      if (!(await this.releaseIsImmutable_(existing.id, sharedContext))) {
        continue
      }
      for (const [field, value] of Object.entries(update)) {
        if (field === "id" || canonicalJson(existing[field]) === canonicalJson(value)) {
          continue
        }
        if (!["status", "is_current"].includes(field)) {
          conflict("Published or entitlement-referenced releases are immutable")
        }
      }
      if (
        update.status !== undefined &&
        !(
          existing.status === DigitalReleaseStatus.PUBLISHED &&
          [DigitalReleaseStatus.PUBLISHED, DigitalReleaseStatus.RETIRED].includes(
            update.status,
          )
        ) &&
        !(
          existing.status === DigitalReleaseStatus.RETIRED &&
          update.status === DigitalReleaseStatus.RETIRED
        )
      ) {
        conflict("A historical release can only transition from published to retired")
      }
      if (
        update.is_current === true &&
        (existing.status === DigitalReleaseStatus.RETIRED ||
          update.status === DigitalReleaseStatus.RETIRED)
      ) {
        conflict("A retired release cannot be made current")
      }
    }
    return this.callGenerated_("updateDigitalProductReleases", [
      data,
      sharedContext,
    ])
  }

  updateDigitalEntitlements = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    const immutableFields = new Set([
      "digital_product_id",
      "release_id",
      "source",
      "order_id",
      "order_line_item_id",
      "fulfillment_id",
      "customer_id",
      "customer_email",
      "customer_name",
      "unit_index",
      "quantity",
      "idempotency_key",
      "snapshot",
    ])
    for (const update of Array.isArray(data) ? data : [data]) {
      if (!update.id) {
        conflict("Digital entitlement updates require explicit ids")
      }
      const existing = await this.retrieveDigitalEntitlement(
        bounded(update.id, "entitlement id", 255),
        {},
        sharedContext,
      )
      for (const field of immutableFields) {
        if (
          update[field] !== undefined &&
          canonicalJson(existing[field]) !== canonicalJson(update[field])
        ) {
          conflict(`Digital entitlement field ${field} is immutable`)
        }
      }
    }
    return this.callGenerated_("updateDigitalEntitlements", [
      data,
      sharedContext,
    ])
  }

  deleteDigitalProductReleases = async (
    ids: string | string[],
    sharedContext: Context = {},
  ): Promise<void> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.deleteDigitalProductReleases(ids, transactionContext),
        sharedContext,
      )
    }
    const releaseIds = (Array.isArray(ids) ? ids : [ids]).map((id) =>
      bounded(id, "release id", 255),
    )
    await this.lockRows_("digital_product_release", releaseIds, sharedContext)
    for (const id of releaseIds) {
      if (
        await this.releaseIsImmutable_(
          bounded(id, "release id", 255),
          sharedContext,
        )
      ) {
        conflict("Published or entitlement-referenced releases cannot be deleted")
      }
    }
    return this.callGenerated_("deleteDigitalProductReleases", [
      ids,
      sharedContext,
    ])
  }

  createLicensePolicies = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.createLicensePolicies(data, transactionContext),
        sharedContext,
      )
    }
    const entries = Array.isArray(data) ? data : [data]
    const productIds = entries.map((entry) =>
      bounded(entry.digital_product_id, "digital_product_id", 255),
    )
    await this.lockRows_("digital_product", productIds, sharedContext)
    for (const entry of entries) {
      if (
        await this.productHasImmutableRelease_(
          entry.digital_product_id,
          sharedContext,
        )
      ) {
        conflict("License policy is immutable after publication or entitlement issuance")
      }
      if (entry.strategy === LicenseStrategy.EXTERNAL) {
        conflict(
          "External license providers are not supported in v1; use generated or pool",
        )
      }
      if (entry.allow_offline_activation === true) {
        conflict("Offline activation certificates are not supported in v1")
      }
    }
    return this.callGenerated_("createLicensePolicies", [data, sharedContext])
  }

  updateLicensePolicies = async (
    data: AnyRecord | AnyRecord[],
    sharedContext: Context = {},
  ): Promise<any> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.updateLicensePolicies(data, transactionContext),
        sharedContext,
      )
    }
    const entries = Array.isArray(data) ? data : [data]
    const policyIds = entries.map((entry) => {
      const id = entry.id ?? entry.selector?.id
      return bounded(id, "license policy id", 255)
    })
    const observedPolicies = await Promise.all(
      policyIds.map((id) => this.retrieveLicensePolicy(id, {}, sharedContext)),
    )
    const productIds = observedPolicies.map((policy) =>
      bounded(policy.digital_product_id, "digital_product_id", 255),
    )
    await this.lockRows_("digital_product", productIds, sharedContext)
    await this.lockRows_("license_policy", policyIds, sharedContext)
    for (const productId of productIds) {
      if (await this.productHasImmutableRelease_(productId, sharedContext)) {
        conflict("License policy is immutable after publication or entitlement issuance")
      }
    }
    for (const entry of entries) {
      const payloads = entry.data
        ? Array.isArray(entry.data)
          ? entry.data
          : [entry.data]
        : [entry]
      for (const payload of payloads) {
        if (payload.strategy === LicenseStrategy.EXTERNAL) {
          conflict(
            "External license providers are not supported in v1; use generated or pool",
          )
        }
        if (payload.allow_offline_activation === true) {
          conflict("Offline activation certificates are not supported in v1")
        }
      }
    }
    return this.callGenerated_("updateLicensePolicies", [data, sharedContext])
  }

  deleteLicensePolicies = async (
    ids: string | string[],
    sharedContext: Context = {},
  ): Promise<void> => {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.deleteLicensePolicies(ids, transactionContext),
        sharedContext,
      )
    }
    const policyIds = (Array.isArray(ids) ? ids : [ids]).map((id) =>
      bounded(id, "license policy id", 255),
    )
    const policies = await Promise.all(
      policyIds.map((id) => this.retrieveLicensePolicy(id, {}, sharedContext)),
    )
    const productIds = policies.map((policy) =>
      bounded(policy.digital_product_id, "digital_product_id", 255),
    )
    await this.lockRows_("digital_product", productIds, sharedContext)
    await this.lockRows_("license_policy", policyIds, sharedContext)
    for (const productId of productIds) {
      if (await this.productHasImmutableRelease_(productId, sharedContext)) {
        conflict("License policy is immutable after publication or entitlement issuance")
      }
    }
    return this.callGenerated_("deleteLicensePolicies", [ids, sharedContext])
  }

  @InjectManager()
  async publishDigitalProductRelease(
    id: string,
    input: {
      make_active?: boolean
      makeActive?: boolean
      notify_existing_customers?: boolean
      notifyExistingCustomers?: boolean
    } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    const releaseId = bounded(id, "release id", 255)
    const settings = await this.getSettings(sharedContext)
    if (!settings.enabled) {
      forbidden("Digital downloads are not enabled")
    }
    const readiness = await this.getReadinessDiagnostics()
    if (!readiness.ready) {
      conflict(
        `Digital downloads are not ready: ${readiness.issues.join(", ")}`,
      )
    }

    const preflightRelease = await this.retrieveDigitalProductRelease(
      releaseId,
      { relations: ["assets"] } as any,
      sharedContext,
    )
    const preflightProduct = await this.retrieveDigitalProduct(
      preflightRelease.digital_product_id,
      { relations: ["license_policy"] } as any,
      sharedContext,
    )
    const preflightAssets = Array.isArray(preflightRelease.assets)
      ? preflightRelease.assets
      : await this.listDigitalAssets(
          { release_id: releaseId },
          { take: 201 } as any,
          sharedContext,
        )
    const policies = preflightProduct.license_policy
      ? [preflightProduct.license_policy]
      : await this.listLicensePolicies(
          { digital_product_id: preflightProduct.id, is_enabled: true },
          { take: 1 } as any,
          sharedContext,
        )
    const readyAssets = assertReleaseDeliverables(
      preflightRelease,
      preflightProduct,
      preflightAssets,
      policies[0],
    )
    const preflightAssetManifest = releaseAssetManifest(preflightAssets)
    if (preflightAssets.length > 200) {
      conflict("A release cannot contain more than 200 assets")
    }
    await Promise.all(
      readyAssets.map(async (asset) => {
        const stored = await this.storage_.inspect({
          provider: asset.storage_provider,
          key: asset.storage_key,
          bucket: asset.storage_bucket,
        })
        if (Number(stored.size) !== Number(asset.size_bytes)) {
          conflict(`Stored object size does not match asset ${asset.id}`)
        }
        const integrity = stored.checksumSha256
          ? { size: stored.size, checksumSha256: stored.checksumSha256 }
          : await this.storage_.computeChecksum({
              provider: asset.storage_provider,
              key: asset.storage_key,
              bucket: asset.storage_bucket,
            })
        if (
          Number(integrity.size) !== Number(asset.size_bytes) ||
          !safeHashEqual(integrity.checksumSha256, asset.checksum_sha256)
        ) {
          conflict(`Stored object checksum does not match asset ${asset.id}`)
        }
      }),
    )

    const makeActive = input.make_active ?? input.makeActive ?? true
    const notifyExistingCustomers =
      input.notify_existing_customers ?? input.notifyExistingCustomers ?? false
    return this.inTransaction_(async (transactionContext) => {
      const knex = this.transactionKnex_(transactionContext)
      const releaseRow = await knex("digital_product_release")
        .where({ id: releaseId, deleted_at: null })
        .first("id", "digital_product_id")
      if (!releaseRow?.digital_product_id) {
        conflict("Digital product release no longer exists")
      }
      await knex("digital_product")
        .where({ id: releaseRow.digital_product_id, deleted_at: null })
        .forUpdate()
        .select("id")
      await knex("digital_product_release")
        .where({
          digital_product_id: releaseRow.digital_product_id,
          deleted_at: null,
        })
        .orderBy("id")
        .forUpdate()
        .select("id")

      const target = await this.retrieveDigitalProductRelease(
        releaseId,
        { relations: ["assets"], options: { refresh: true } } as any,
        transactionContext,
      )
      const product = await this.retrieveDigitalProduct(
        releaseRow.digital_product_id,
        { relations: ["license_policy"], options: { refresh: true } } as any,
        transactionContext,
      )
      const assets = Array.isArray(target.assets)
        ? target.assets
        : await this.listDigitalAssets(
            { release_id: target.id },
            { take: 201 } as any,
            transactionContext,
          )
      const currentPolicy = product.license_policy
        ? product.license_policy
        : (
            await this.listLicensePolicies(
              { digital_product_id: product.id, is_enabled: true },
              { take: 1 } as any,
              transactionContext,
            )
          )[0]
      const publishableAssets = assertReleaseDeliverables(
        target,
        product,
        assets,
        currentPolicy,
      )
      if (releaseAssetManifest(assets) !== preflightAssetManifest) {
        conflict("Release assets changed while publication was being validated")
      }
      const publishedAt = target.published_at ?? new Date()
      if (makeActive) {
        const previousCurrent = await this.listDigitalProductReleases(
          {
            digital_product_id: product.id,
            is_current: true,
          },
          { take: 200 } as any,
          transactionContext,
        )
        for (const previous of previousCurrent) {
          if (previous.id !== target.id) {
            await this.updateDigitalProductReleases(
              {
                id: previous.id,
                is_current: false,
                status: DigitalReleaseStatus.RETIRED,
              },
              transactionContext,
            )
          }
        }
      }
      await this.updateDigitalProductReleases(
        {
          id: target.id,
          status: DigitalReleaseStatus.PUBLISHED,
          is_current: makeActive,
          published_at: publishedAt,
          metadata: {
            ...(target.metadata ?? {}),
            asset_set_locked: true,
            published_asset_ids: publishableAssets
              .map((asset) => asset.id)
              .sort(),
          },
        },
        transactionContext,
      )
      if (makeActive) {
        await this.updateDigitalProducts(
          {
            id: product.id,
            status: DigitalProductStatus.ACTIVE,
            published_at: product.published_at ?? publishedAt,
            metadata: {
              ...(product.metadata ?? {}),
              active_release_id: target.id,
            },
          },
          transactionContext,
        )
      }
      const published = await this.retrieveDigitalProductRelease(
        target.id,
        { relations: ["assets"], options: { refresh: true } } as any,
        transactionContext,
      )
      return {
        ...published,
        digital_product: makeActive
          ? await this.retrieveDigitalProduct(
              product.id,
              { options: { refresh: true } } as any,
              transactionContext,
            )
          : product,
        notify_existing_customers: notifyExistingCustomers,
      }
    }, sharedContext)
  }

  @InjectManager()
  async publishRelease(
    id: string,
    input: Parameters<DigitalDownloadsModuleService["publishDigitalProductRelease"]>[1] = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    return this.publishDigitalProductRelease(id, input, sharedContext)
  }

  private normalizeEntitlementRows(
    input:
      | IssueEntitlementRowInput
      | IssueEntitlementRowInput[]
      | IssueOrderEntitlementsInput,
  ): IssueEntitlementRowInput[] {
    if (Array.isArray(input)) {
      return input
    }
    if (!("items" in input)) {
      return [input]
    }

    const rows: IssueEntitlementRowInput[] = []
    let totalQuantity = 0
    for (const item of input.items) {
      const quantity = positiveInteger(item.quantity ?? 1, "quantity", {
        max: 10_000,
      })
      totalQuantity += quantity
      if (totalQuantity > 10_000) {
        invalid("An issuance request cannot exceed 10000 entitlement units")
      }
      for (let unitIndex = 0; unitIndex < quantity; unitIndex += 1) {
        rows.push({
          idempotency_key: `${input.order_id}:${item.order_line_item_id}:${unitIndex}`,
          order_id: input.order_id,
          line_item_id: item.order_line_item_id,
          customer_id: input.customer_id,
          email: input.customer_email,
          customer_name: input.customer_name,
          digital_product_id: item.digital_product_id,
          digital_product_release_id: item.release_id,
          fulfillment_id: input.fulfillment_id,
          unit_index: unitIndex,
          quantity: 1,
          expires_at: item.expires_at,
          download_limit: item.download_limit,
          license_activation_limit: item.license_activation_limit,
          snapshot: item.snapshot,
          metadata: item.metadata,
        })
      }
    }
    return rows
  }

  @InjectManager()
  async issueOrderEntitlements(
    input:
      | IssueEntitlementRowInput
      | IssueEntitlementRowInput[]
      | IssueOrderEntitlementsInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord[]> {
    const settings = await this.getSettings(sharedContext)
    if (!settings.enabled) {
      forbidden("Digital downloads are not enabled")
    }
    const rows = this.normalizeEntitlementRows(input)
    if (!rows.length || rows.length > 10_000) {
      invalid("Between 1 and 10000 entitlement rows are required")
    }

    const seen = new Set<string>()
    const prepared = rows.map((row) => {
      const idempotencyKey = bounded(
        row.idempotency_key,
        "idempotency_key",
        512,
      )
      if (seen.has(idempotencyKey)) {
        invalid(`Duplicate idempotency key in request: ${idempotencyKey}`)
      }
      seen.add(idempotencyKey)
      const availableAt = parseDate(row.available_at, "available_at")
      const expiresAt = parseDate(row.expires_at, "expires_at")
      if (availableAt && expiresAt && expiresAt <= availableAt) {
        invalid("expires_at must be later than available_at")
      }
      const unitIndex = positiveInteger(row.unit_index, "unit_index", {
        allowZero: true,
      })
      return {
        digital_product_id: bounded(
          row.digital_product_id,
          "digital_product_id",
          255,
        ),
        release_id: row.digital_product_release_id
          ? bounded(
              row.digital_product_release_id,
              "digital_product_release_id",
              255,
            )
          : null,
        status: row.status ?? DigitalEntitlementStatus.ACTIVE,
        source: DigitalEntitlementSource.ORDER,
        order_id: bounded(row.order_id, "order_id", 255),
        order_line_item_id: bounded(row.line_item_id, "line_item_id", 255),
        fulfillment_id: row.fulfillment_id
          ? bounded(row.fulfillment_id, "fulfillment_id", 255)
          : null,
        customer_id: row.customer_id
          ? bounded(row.customer_id, "customer_id", 255)
          : null,
        customer_email: normalizeEmail(row.email),
        customer_name: row.customer_name?.trim().slice(0, 512) || null,
        unit_index: unitIndex,
        quantity: positiveInteger(row.quantity ?? 1, "quantity"),
        available_at: availableAt,
        expires_at: expiresAt,
        download_limit:
          row.download_limit === undefined
            ? settings.default_download_limit
            : row.download_limit === null
              ? null
              : positiveInteger(row.download_limit, "download_limit", {
                  allowZero: true,
                }),
        license_activation_limit:
          row.license_activation_limit === undefined ||
          row.license_activation_limit === null
            ? null
            : positiveInteger(
                row.license_activation_limit,
                "license_activation_limit",
                { allowZero: true },
              ),
        idempotency_key: idempotencyKey,
        snapshot: row.snapshot ?? {},
        metadata: row.metadata ?? {},
      }
    })

    const result: AnyRecord[] = []
    const withGuestCapability = async (entitlement: AnyRecord) => {
      if (entitlement.customer_id || !settings.allow_guest_access) {
        return entitlement
      }
      const guest = await this.createGuestAccessSession(
        {
          entitlement_id: entitlement.id,
          idempotency_key: `${entitlement.id}:guest:v1`,
          metadata: {
            order_id: entitlement.order_id,
            purpose: "initial_delivery",
          },
        },
        sharedContext,
      )
      return {
        ...entitlement,
        guest_access: { session: guest.session, token: guest.token },
      }
    }
    for (const row of prepared) {
      const product = await this.retrieveDigitalProduct(
        row.digital_product_id,
        {},
        sharedContext,
      )
      let releaseId = row.release_id
      if (!releaseId) {
        const releases = await this.listDigitalProductReleases(
          {
            digital_product_id: product.id,
            status: DigitalReleaseStatus.PUBLISHED,
            is_current: true,
          },
          { take: 1 } as any,
          sharedContext,
        )
        if (!releases.length) {
          conflict("Digital product has no current published release")
        }
        releaseId = releases[0].id
      }
      const release = await this.retrieveDigitalProductRelease(
        releaseId,
        {},
        sharedContext,
      )
      if (
        release.digital_product_id !== product.id ||
        release.status !== DigitalReleaseStatus.PUBLISHED
      ) {
        conflict("Entitlements can only pin a published release of the product")
      }
      row.release_id = release.id
      row.snapshot = {
        ...(row.snapshot ?? {}),
        product: {
          id: product.id,
          title: product.title,
          handle: product.handle,
          delivery_type: product.delivery_type,
        },
        release: {
          id: release.id,
          version: release.version,
          published_at: release.published_at,
        },
        order: {
          id: row.order_id,
          line_item_id: row.order_line_item_id,
          unit_index: row.unit_index,
        },
        customer: {
          id: row.customer_id,
          email: row.customer_email,
          name: row.customer_name,
        },
      }
      const existing = await this.listDigitalEntitlements(
        { idempotency_key: row.idempotency_key },
        {},
        sharedContext,
      )
      if (existing.length) {
        if (!entitlementMatches(existing[0], row)) {
          conflict("Idempotency key is already associated with another entitlement")
        }
        result.push(await withGuestCapability(existing[0]))
        continue
      }

      try {
        const created = await this.createDigitalEntitlements(
          row as any,
          sharedContext,
        )
        result.push(await withGuestCapability(created))
      } catch (error) {
        if (!isDuplicateError(error)) {
          throw error
        }
        const raced = await this.listDigitalEntitlements(
          { idempotency_key: row.idempotency_key },
          {},
          sharedContext,
        )
        if (!raced.length) {
          throw error
        }
        if (!entitlementMatches(raced[0], row)) {
          conflict("Idempotency key is already associated with another entitlement")
        }
        result.push(await withGuestCapability(raced[0]))
      }
    }
    return result
  }

  @InjectManager()
  async revokeEntitlement(
    id: string,
    reason: string,
    actor: { type?: string; id?: string } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.revokeEntitlement(id, reason, actor, transactionContext),
        sharedContext,
      )
    }
    const entitlementId = bounded(id, "entitlement id", 255)
    await this.lockRows_("digital_entitlement", [entitlementId], sharedContext)
    const entitlement = await this.retrieveDigitalEntitlement(
      entitlementId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    const revokeReason = bounded(reason, "revoke reason", 2000)
    if (entitlement.status === DigitalEntitlementStatus.REVOKED) {
      return entitlement
    }
    if (TERMINAL_ENTITLEMENT_STATUSES.has(entitlement.status)) {
      conflict(`Cannot revoke an entitlement in ${entitlement.status} state`)
    }
    const now = new Date()
    const updated = await this.updateDigitalEntitlements(
      {
        id: entitlement.id,
        status: DigitalEntitlementStatus.REVOKED,
        revoked_at: now,
        revoke_reason: revokeReason,
      },
      sharedContext,
    )

    const grants = await this.listDownloadGrants(
      { entitlement_id: entitlement.id, status: DownloadGrantStatus.ACTIVE },
      {},
      sharedContext,
    )
    if (grants.length) {
      await this.updateDownloadGrants(
        grants.map((grant) => ({
          id: grant.id,
          status: DownloadGrantStatus.REVOKED,
          revoked_at: now,
          revoke_reason: revokeReason,
        })),
        sharedContext,
      )
    }
    const accessSessions = (
      await this.listEntitlementAccessSessions(
        { entitlement_id: entitlement.id },
        {},
        sharedContext,
      )
    ).filter((session) =>
      [AccessSessionStatus.ACTIVE, AccessSessionStatus.PENDING].includes(
        session.status,
      ),
    )
    if (accessSessions.length) {
      await this.updateEntitlementAccessSessions(
        accessSessions.map((session) => ({
          id: session.id,
          status: AccessSessionStatus.REVOKED,
          revoked_at: now,
          revoke_reason: revokeReason,
        })),
        sharedContext,
      )
    }
    const assignments = await this.listLicenseAssignments(
      {
        entitlement_id: entitlement.id,
        status: LicenseAssignmentStatus.ACTIVE,
      },
      {},
      sharedContext,
    )
    for (const assignment of assignments) {
      const activations = await this.listLicenseActivations(
        {
          assignment_id: assignment.id,
          status: LicenseActivationStatus.ACTIVE,
        },
        {},
        sharedContext,
      )
      if (activations.length) {
        await this.updateLicenseActivations(
          activations.map((activation) => ({
            id: activation.id,
            status: LicenseActivationStatus.DEACTIVATED,
            deactivated_at: now,
            last_seen_at: now,
          })),
          sharedContext,
        )
      }
      await this.updateLicenseAssignments(
        {
          id: assignment.id,
          status: LicenseAssignmentStatus.REVOKED,
          revoked_at: now,
          revoke_reason: revokeReason,
        },
        sharedContext,
      )
      await this.createLicenseAuditEvents(
        {
          assignment_id: assignment.id,
          action: LicenseAuditAction.REVOKED,
          success: true,
          actor_type: actor.type ?? null,
          actor_id: actor.id ?? null,
          occurred_at: now,
          metadata: { reason: revokeReason },
        },
        sharedContext,
      )
    }
    return updated
  }

  @InjectManager()
  async reissueEntitlement(
    input: {
      entitlementId?: string
      entitlement_id?: string
      reason?: string
      reset_downloads?: boolean
      rotate_guest_token?: boolean
      notify?: boolean
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    entitlement: AnyRecord
    guest_access?: { session: Record<string, unknown>; token: string }
  }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.reissueEntitlement(input, transactionContext),
        sharedContext,
      )
    }
    const id = input.entitlement_id ?? input.entitlementId
    const entitlementId = bounded(id ?? "", "entitlement id", 255)
    await this.lockRows_("digital_entitlement", [entitlementId], sharedContext)
    const previous = await this.retrieveDigitalEntitlement(
      entitlementId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (previous.status === DigitalEntitlementStatus.REFUNDED) {
      conflict("Refunded entitlements require a new order")
    }
    const reason = input.reason?.trim().slice(0, 2000) || "manual reissue"
    const entitlement = await this.updateDigitalEntitlements(
      {
        id: previous.id,
        status: DigitalEntitlementStatus.ACTIVE,
        revoked_at: null,
        revoke_reason: null,
        ...(input.reset_downloads ? { download_count: 0 } : {}),
        metadata: {
          ...(previous.metadata ?? {}),
          last_reissued_at: new Date().toISOString(),
          last_reissue_reason: reason,
        },
      },
      sharedContext,
    )
    let guestAccess:
      | { session: Record<string, unknown>; token: string }
      | undefined
    const settings = await this.getSettings(sharedContext)
    if (
      !previous.customer_id &&
      input.rotate_guest_token !== false &&
      settings.allow_guest_access
    ) {
      const sessions = (
        await this.listEntitlementAccessSessions(
          { entitlement_id: previous.id },
          {},
          sharedContext,
        )
      ).filter((session) =>
        [AccessSessionStatus.ACTIVE, AccessSessionStatus.PENDING].includes(
          session.status,
        ),
      )
      if (sessions.length) {
        await this.updateEntitlementAccessSessions(
          sessions.map((session) => ({
            id: session.id,
            status: AccessSessionStatus.REVOKED,
            revoked_at: new Date(),
            revoke_reason: "rotated_on_reissue",
          })),
          sharedContext,
        )
      }
      const issued = await this.createGuestAccessSession(
        {
          entitlement_id: previous.id,
          idempotency_key: `reissue:${previous.id}:${randomOpaqueToken("ri", 24)}`,
          metadata: { reason },
        },
        sharedContext,
      )
      guestAccess = { session: issued.session, token: issued.token }
    }
    const policies = await this.listLicensePolicies(
      { digital_product_id: previous.digital_product_id, is_enabled: true },
      { take: 1 } as any,
      sharedContext,
    )
    if (policies[0] && policies[0].strategy !== LicenseStrategy.NONE) {
      await this.assignLicenseKey(
        {
          entitlement_id: previous.id,
          license_policy_id: policies[0].id,
          idempotency_key: `reissue:${previous.id}:${randomOpaqueToken("lk", 24)}`,
          metadata: { reason },
        },
        sharedContext,
      )
    }
    return {
      entitlement,
      ...(guestAccess ? { guest_access: guestAccess } : {}),
    }
  }

  @InjectManager()
  async createDownloadGrant(
    input: CreateDownloadGrantInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ grant: Record<string, unknown>; token: string; created: boolean }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.createDownloadGrant(input, transactionContext),
        sharedContext,
      )
    }
    const settings = await this.getSettings(sharedContext)
    if (!settings.enabled) {
      forbidden("Digital downloads are not enabled")
    }
    const idempotencyKey = bounded(
      input.idempotency_key,
      "idempotency_key",
      512,
    )
    const token = deriveOpaqueToken(
      `download:${idempotencyKey}`,
      this.options_.tokenSecret,
    )
    const now = new Date()
    await this.lockRows_(
      "digital_entitlement",
      [bounded(input.entitlement_id, "entitlement_id", 255)],
      sharedContext,
    )
    let guestSession: AnyRecord | undefined
    if (input.guest_session_id) {
      const guestSessionId = bounded(
        input.guest_session_id,
        "guest_session_id",
        255,
      )
      await this.lockRows_(
        "entitlement_access_session",
        [guestSessionId],
        sharedContext,
      )
      guestSession = await this.retrieveEntitlementAccessSession(
        guestSessionId,
        { options: { refresh: true } } as any,
        sharedContext,
      )
      if (
        guestSession.entitlement_id !== input.entitlement_id ||
        guestSession.status !== AccessSessionStatus.ACTIVE ||
        new Date(guestSession.expires_at) <= now
      ) {
        throw new MedusaError(
          MedusaError.Types.UNAUTHORIZED,
          "Guest access session is inactive",
        )
      }
    }
    const entitlement = await this.retrieveDigitalEntitlement(
      bounded(input.entitlement_id, "entitlement_id", 255),
      {},
      sharedContext,
    )
    entitlementIsUsable(entitlement, now)
    if (!entitlement.release_id) {
      forbidden("Digital entitlement is not pinned to a published release")
    }
    const asset = await this.retrieveDigitalAsset(
      bounded(input.asset_id, "asset_id", 255),
      {},
      sharedContext,
    )
    if (!asset.is_enabled || asset.status !== DigitalAssetStatus.READY) {
      forbidden("Digital asset is disabled")
    }
    if (!asset.release_id) {
      forbidden("Digital asset is not attached to a release")
    }
    const release = await this.retrieveDigitalProductRelease(
      asset.release_id,
      {},
      sharedContext,
    )
    if (release.digital_product_id !== entitlement.digital_product_id) {
      forbidden("Asset does not belong to the entitled digital product")
    }
    if (entitlement.release_id !== asset.release_id) {
      forbidden("Asset does not belong to the entitled release")
    }

    const action =
      input.action ??
      (asset.delivery_type === DigitalDeliveryMode.STREAM ? "stream" : "download")
    if (
      (action === "stream" &&
        ![DigitalDeliveryMode.STREAM, DigitalDeliveryMode.MIXED].includes(
          asset.delivery_type,
        )) ||
      (action === "download" &&
        ![DigitalDeliveryMode.DOWNLOAD, DigitalDeliveryMode.MIXED].includes(
          asset.delivery_type,
        ))
    ) {
      forbidden(`Asset does not permit ${action} delivery`)
    }

    const ttl = positiveInteger(
      input.ttl_seconds ?? Number(settings.default_grant_ttl_seconds),
      "ttl_seconds",
      { max: Number(settings.max_grant_ttl_seconds) },
    )
    const maxUses = positiveInteger(input.max_uses ?? 1, "max_uses", {
      max: 10_000,
    })
    const boundIpHash = normalizeAndFingerprint(
      input.bind_ip,
      this.options_.tokenSecret,
      "ip",
    )
    const boundUserAgentHash = normalizeAndFingerprint(
      input.bind_user_agent,
      this.options_.tokenSecret,
      "user-agent",
    )
    const requestFingerprint = keyedFingerprint(
      canonicalJson({
        entitlement_id: entitlement.id,
        asset_id: asset.id,
        action,
        ttl_seconds: input.ttl_seconds ?? null,
        max_uses: maxUses,
        guest_session_id: guestSession?.id ?? null,
        bound_ip_hash: boundIpHash,
        bound_user_agent_hash: boundUserAgentHash,
      }),
      this.options_.tokenSecret,
      "download-grant-request",
    )
    const existing = await this.listDownloadGrants(
      { idempotency_key: idempotencyKey },
      {},
      sharedContext,
    )
    if (existing.length) {
      if (
        existing[0].entitlement_id !== entitlement.id ||
        existing[0].asset_id !== asset.id ||
        !safeHashEqual(
          typeof existing[0].metadata?.request_fingerprint === "string"
            ? existing[0].metadata.request_fingerprint
            : "",
          requestFingerprint,
        )
      ) {
        conflict("Idempotency key is already associated with another grant request")
      }
      return { grant: toSafeDownloadGrant(existing[0]), token, created: false }
    }
    const grant = await this.createDownloadGrants(
      {
        entitlement_id: entitlement.id,
        asset_id: asset.id,
        status: DownloadGrantStatus.ACTIVE,
        token_hash: tokenHash(token, this.options_.tokenSecret),
        token_prefix: token.slice(0, 12),
        idempotency_key: idempotencyKey,
        max_uses: maxUses,
        use_count: 0,
        expires_at: new Date(now.getTime() + ttl * 1000),
        bound_ip_hash: boundIpHash,
        bound_user_agent_hash: boundUserAgentHash,
        metadata: {
          ...(input.metadata ?? {}),
          action,
          request_fingerprint: requestFingerprint,
        },
      },
      sharedContext,
    )
    await this.createDownloadEvents(
      {
        grant_id: grant.id,
        entitlement_id: entitlement.id,
        asset_id: asset.id,
        event_type: DownloadEventType.GRANTED,
        success: true,
        occurred_at: now,
        metadata: {},
      },
      sharedContext,
    )
    return { grant: toSafeDownloadGrant(grant), token, created: true }
  }

  @InjectManager()
  async createGuestAccessSession(
    input: CreateGuestAccessSessionInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ session: Record<string, unknown>; token: string; created: boolean }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.createGuestAccessSession(input, transactionContext),
        sharedContext,
      )
    }
    const settings = await this.getSettings(sharedContext)
    if (!settings.allow_guest_access) {
      forbidden("Guest entitlement access is disabled")
    }
    const idempotencyKey = bounded(
      input.idempotency_key,
      "idempotency_key",
      512,
    )
    const token = deriveOpaqueToken(
      `access:${idempotencyKey}`,
      this.options_.tokenSecret,
      "dda",
    )
    const entitlementId = bounded(
      input.entitlement_id,
      "entitlement_id",
      255,
    )
    await this.lockRows_("digital_entitlement", [entitlementId], sharedContext)
    const entitlement = await this.retrieveDigitalEntitlement(
      entitlementId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    entitlementIsUsable(entitlement, new Date())
    const previous = await this.listEntitlementAccessSessions(
      { idempotency_key: idempotencyKey },
      {},
      sharedContext,
    )
    if (previous.length) {
      if (previous[0].entitlement_id !== entitlement.id) {
        conflict("Idempotency key is already associated with another access session")
      }
      return {
        session: this.safeAccessSession(previous[0]),
        token,
        created: false,
      }
    }
    const initialStatus = input.initial_status ?? AccessSessionStatus.ACTIVE
    if (
      ![AccessSessionStatus.ACTIVE, AccessSessionStatus.PENDING].includes(
        initialStatus,
      )
    ) {
      invalid("Guest access initial status must be active or pending")
    }
    const ttl = positiveInteger(
      input.ttl_seconds ?? Math.min(Number(settings.max_grant_ttl_seconds), 86400),
      "ttl_seconds",
      { max: Number(settings.max_grant_ttl_seconds) },
    )
    let session: AnyRecord
    try {
      session = await this.createEntitlementAccessSessions(
        {
          entitlement_id: entitlement.id,
          status: initialStatus,
          token_hash: tokenHash(token, this.options_.tokenSecret),
          token_prefix: token.slice(0, 12),
          idempotency_key: idempotencyKey,
          expires_at: new Date(Date.now() + ttl * 1000),
          bound_ip_hash: normalizeAndFingerprint(
            input.bind_ip,
            this.options_.tokenSecret,
            "ip",
          ),
          bound_user_agent_hash: normalizeAndFingerprint(
            input.bind_user_agent,
            this.options_.tokenSecret,
            "user-agent",
          ),
          metadata: input.metadata ?? {},
        },
        sharedContext,
      )
    } catch (error) {
      if (!isDuplicateError(error)) throw error
      const raced = await this.listEntitlementAccessSessions(
        { idempotency_key: idempotencyKey },
        {},
        sharedContext,
      )
      if (!raced.length || raced[0].entitlement_id !== entitlement.id) {
        throw error
      }
      return {
        session: this.safeAccessSession(raced[0]),
        token,
        created: false,
      }
    }
    return { session: this.safeAccessSession(session), token, created: true }
  }

  /**
   * Invalidates a known guest capability without changing its entitlement.
   * Repeating the operation is safe: an already revoked or expired session is
   * returned as-is, while a missing session is an error because cleanup cannot
   * be confirmed.
   */
  @InjectManager()
  async revokeGuestAccessSession(
    sessionId: string,
    reason = "guest_access_revoked",
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Record<string, unknown>> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.revokeGuestAccessSession(sessionId, reason, transactionContext),
        sharedContext,
      )
    }
    const id = bounded(sessionId, "guest access session id", 255)
    const revokeReason = bounded(reason, "guest access revoke reason", 2000)
    await this.lockRows_("entitlement_access_session", [id], sharedContext)
    const sessions = await this.listEntitlementAccessSessions(
      { id },
      {},
      sharedContext,
    )
    if (!sessions.length) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "Guest access session was not found",
      )
    }
    const session = sessions[0]
    if (
      ![AccessSessionStatus.ACTIVE, AccessSessionStatus.PENDING].includes(
        session.status,
      )
    ) {
      return this.safeAccessSession(session)
    }
    const revoked = await this.updateEntitlementAccessSessions(
      {
        id: session.id,
        status: AccessSessionStatus.REVOKED,
        revoked_at: new Date(),
        revoke_reason: revokeReason,
      },
      sharedContext,
    )
    return this.safeAccessSession(revoked)
  }

  /** Activates a notification-prepared guest capability after token redaction. */
  @InjectManager()
  async activateGuestAccessSession(
    sessionId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Record<string, unknown>> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.activateGuestAccessSession(sessionId, transactionContext),
        sharedContext,
      )
    }
    const id = bounded(sessionId, "guest access session id", 255)
    await this.lockRows_("entitlement_access_session", [id], sharedContext)
    const session = await this.retrieveEntitlementAccessSession(
      id,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (session.status === AccessSessionStatus.ACTIVE) {
      return this.safeAccessSession(session)
    }
    if (
      session.status !== AccessSessionStatus.PENDING ||
      new Date(session.expires_at) <= new Date()
    ) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Guest access session cannot be activated",
      )
    }
    const activated = await this.updateEntitlementAccessSessions(
      { id, status: AccessSessionStatus.ACTIVE },
      sharedContext,
    )
    return this.safeAccessSession(activated)
  }

  @InjectManager()
  async resolveGuestEntitlement(
    rawToken: string,
    request: { ip?: string; user_agent?: string; email?: string } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ entitlement: AnyRecord; session: Record<string, unknown> }> {
    const settings = await this.getSettings(sharedContext)
    if (!settings.allow_guest_access) {
      forbidden("Guest entitlement access is disabled")
    }
    let hash: string
    try {
      hash = tokenHash(rawToken, this.options_.tokenSecret)
    } catch {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Guest access token is invalid")
    }
    const sessions = await this.listEntitlementAccessSessions(
      { token_hash: hash },
      {},
      sharedContext,
    )
    if (!sessions.length) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Guest access token is invalid")
    }
    const session = sessions[0]
    const now = new Date()
    if (session.status !== AccessSessionStatus.ACTIVE) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Guest access session is inactive")
    }
    if (new Date(session.expires_at) <= now) {
      await this.updateEntitlementAccessSessions(
        { id: session.id, status: AccessSessionStatus.EXPIRED },
        sharedContext,
      )
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Guest access session has expired")
    }
    const ipHash = normalizeAndFingerprint(
      request.ip,
      this.options_.tokenSecret,
      "ip",
    )
    const userAgentHash = normalizeAndFingerprint(
      request.user_agent,
      this.options_.tokenSecret,
      "user-agent",
    )
    if (
      (session.bound_ip_hash && session.bound_ip_hash !== ipHash) ||
      (session.bound_user_agent_hash &&
        session.bound_user_agent_hash !== userAgentHash)
    ) {
      throw new MedusaError(
        MedusaError.Types.UNAUTHORIZED,
        "Guest access request binding does not match",
      )
    }
    const entitlement = await this.retrieveDigitalEntitlement(
      session.entitlement_id,
      {},
      sharedContext,
    )
    entitlementIsUsable(entitlement, now)
    if (settings.require_order_email_match) {
      let suppliedEmail: string | null = null
      try {
        suppliedEmail = normalizeEmail(request.email)
      } catch {
        // Guest authentication failures intentionally share one envelope.
      }
      const expectedEmail = normalizeEmail(entitlement.customer_email)
      const suppliedFingerprint = normalizeAndFingerprint(
        suppliedEmail ?? undefined,
        this.options_.tokenSecret,
        "recipient",
      )
      const expectedFingerprint = normalizeAndFingerprint(
        expectedEmail ?? undefined,
        this.options_.tokenSecret,
        "recipient",
      )
      if (
        !suppliedFingerprint ||
        !expectedFingerprint ||
        !safeHashEqual(suppliedFingerprint, expectedFingerprint)
      ) {
        throw new MedusaError(
          MedusaError.Types.UNAUTHORIZED,
          "Guest access credentials are invalid",
        )
      }
    }
    const changed = await this.updateEntitlementAccessSessions(
      {
        selector: {
          id: session.id,
          status: AccessSessionStatus.ACTIVE,
          use_count: session.use_count,
        },
        data: { use_count: session.use_count + 1, last_used_at: now },
      },
      sharedContext,
    )
    if (!changed.length) {
      conflict("Guest access session was concurrently updated")
    }
    return { entitlement, session: this.safeAccessSession(changed[0]) }
  }

  @InjectManager()
  async getGuestAccess(
    rawToken: string,
    request: { ip?: string; user_agent?: string; email?: string } = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.resolveGuestEntitlement(rawToken, request, sharedContext)
  }

  private safeAccessSession(session: AnyRecord): Record<string, unknown> {
    return {
      id: session.id,
      entitlement_id: session.entitlement_id,
      status: session.status,
      token_prefix: session.token_prefix,
      idempotency_key: session.idempotency_key,
      expires_at: session.expires_at,
      last_used_at: session.last_used_at ?? null,
      use_count: session.use_count,
      metadata: session.metadata ?? {},
    }
  }

  @InjectManager()
  async redeemDownloadGrant(
    rawToken: string,
    request: RedeemDownloadGrantContext = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    authorized: true
    grant: Record<string, unknown>
    asset: ReturnType<typeof toSafeDigitalAsset>
    grant_id: string
    event_id: string
    asset_id: string
    total_size: number
    size: number
    filename: string
    mime_type: string
    action: "download" | "stream"
  }> {
    const now = new Date()
    let hash: string
    try {
      hash = tokenHash(rawToken, this.options_.tokenSecret)
    } catch {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Download grant is invalid")
    }
    const grants = await this.listDownloadGrants(
      { token_hash: hash },
      {},
      sharedContext,
    )
    if (!grants.length) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Download grant is invalid")
    }
    const grant = grants[0]
    const entitlement = await this.retrieveDigitalEntitlement(
      grant.entitlement_id,
      {},
      sharedContext,
    )
    const asset = await this.retrieveDigitalAsset(
      grant.asset_id,
      {},
      sharedContext,
    )
    const requestedRange = canonicalByteRange(request, asset.size_bytes)
    const isRangeRequest = Boolean(requestedRange)
    const isPartialRange = Boolean(
      requestedRange && requestedRange.length < Number(asset.size_bytes),
    )
    const denial = async (reason: string): Promise<never> => {
      const existing = await this.listDownloadEvents(
        {
          grant_id: grant.id,
          event_type: DownloadEventType.DENIED,
          denial_reason: reason,
        },
        { take: 1 } as any,
        sharedContext,
      )
      if (!existing.length) {
        try {
          await this.createDownloadEvents(
            {
              grant_id: grant.id,
              entitlement_id: entitlement.id,
              asset_id: asset.id,
              event_type: DownloadEventType.DENIED,
              success: false,
              denial_reason: reason,
              ip_hash:
                request.ip_hash ??
                normalizeAndFingerprint(
                  request.ip,
                  this.options_.tokenSecret,
                  "ip",
                ),
              user_agent_hash:
                request.user_agent_hash ??
                normalizeAndFingerprint(
                  request.user_agent,
                  this.options_.tokenSecret,
                  "user-agent",
                ),
              occurred_at: now,
              metadata: {},
            },
            sharedContext,
          )
        } catch (error) {
          if (!isDuplicateError(error)) throw error
        }
      }
      forbidden(reason)
    }

    if (request.asset_id && request.asset_id !== asset.id) {
      return denial("Download grant is not valid for this asset")
    }
    const isContinuation = Boolean(
      isPartialRange &&
        Number(grant.use_count) > 0 &&
        grant.continuation_expires_at &&
        new Date(grant.continuation_expires_at) > now,
    )
    if (grant.status !== DownloadGrantStatus.ACTIVE) {
      return denial("Download grant is not active")
    }
    if (new Date(grant.expires_at) <= now) {
      await this.updateDownloadGrants(
        { id: grant.id, status: DownloadGrantStatus.EXPIRED },
        sharedContext,
      )
      return denial("Download grant has expired")
    }
    if (grant.use_count >= grant.max_uses && !isContinuation) {
      return denial("Download grant has been exhausted")
    }
    try {
      entitlementIsUsable(entitlement, now)
    } catch (error) {
      return denial((error as Error).message)
    }
    if (!asset.is_enabled || asset.status !== DigitalAssetStatus.READY) {
      return denial("Digital asset is disabled")
    }

    const action =
      grant.metadata?.action === "stream" ? "stream" : "download"
    if (request.action && request.action !== action) {
      return denial("Download grant does not permit the requested action")
    }

    const requestIpHash =
      request.ip_hash ??
      normalizeAndFingerprint(request.ip, this.options_.tokenSecret, "ip")
    const requestAgentHash =
      request.user_agent_hash ??
      normalizeAndFingerprint(
        request.user_agent,
        this.options_.tokenSecret,
        "user-agent",
      )
    if (grant.bound_ip_hash && grant.bound_ip_hash !== requestIpHash) {
      return denial("Download grant request binding does not match")
    }
    if (
      grant.bound_user_agent_hash &&
      grant.bound_user_agent_hash !== requestAgentHash
    ) {
      return denial("Download grant request binding does not match")
    }
    if (
      !isContinuation &&
      entitlement.download_limit !== null &&
      entitlement.download_count >= entitlement.download_limit
    ) {
      return denial("Entitlement download limit has been reached")
    }

    if (!isContinuation && grant.reservation_id) {
      const reservedAt = grant.reserved_at ? new Date(grant.reserved_at) : now
      if (reservedAt.getTime() > now.getTime() - 5 * 60 * 1000) {
        conflict("Another transfer is already in progress for this grant")
      }
    }
    const { transfer, authorizedGrant } = await this.inTransaction_(
      async (transactionContext) => {
        await this.lockRows_(
          "digital_entitlement",
          [entitlement.id],
          transactionContext,
        )
        await this.lockRows_("download_grant", [grant.id], transactionContext)
        const freshEntitlement = await this.retrieveDigitalEntitlement(
          entitlement.id,
          {},
          transactionContext,
        )
        entitlementIsUsable(freshEntitlement, new Date())
        const freshGrant = await this.retrieveDownloadGrant(
          grant.id,
          {},
          transactionContext,
        )
        const continuation = Boolean(
          isPartialRange &&
            Number(freshGrant.use_count) > 0 &&
            freshGrant.continuation_expires_at &&
            new Date(freshGrant.continuation_expires_at) > new Date(),
        )
        if (freshGrant.status !== DownloadGrantStatus.ACTIVE) {
          conflict("Download grant is no longer active")
        }
        if (new Date(freshGrant.expires_at) <= new Date()) {
          conflict("Download grant expired while it was being reserved")
        }
        if (freshGrant.use_count >= freshGrant.max_uses && !continuation) {
          conflict("Download grant was concurrently exhausted")
        }
        if (continuation) {
          if (!freshGrant.continuation_started_at) {
            conflict("Download range continuation is no longer valid")
          }
          const knex = this.transactionKnex_(transactionContext)
          const continuationStartedAt = new Date(
            freshGrant.continuation_started_at,
          )
          const priorRanges = await knex("download_event")
            .where({ grant_id: freshGrant.id, deleted_at: null })
            .where("occurred_at", ">=", continuationStartedAt)
            .whereNotNull("range_start")
            .whereNotNull("range_end")
            .whereIn("event_type", [
              DownloadEventType.TRANSFER_STARTED,
              DownloadEventType.TRANSFER_COMPLETED,
              DownloadEventType.TRANSFER_FAILED,
            ])
            .select("range_start", "range_end")
          const priorRequestedBytes = priorRanges.reduce(
            (total: number, row: AnyRecord) =>
              total + Number(row.range_end) - Number(row.range_start) + 1,
            0,
          )
          const continuationByteBudget =
            Number(asset.size_bytes) *
            RANGE_CONTINUATION_MAX_ASSET_MULTIPLIER
          if (
            priorRanges.length >= RANGE_CONTINUATION_MAX_REQUESTS ||
            priorRequestedBytes + Number(requestedRange?.length ?? 0) >
              continuationByteBudget
          ) {
            conflict("Download range continuation budget has been exhausted")
          }
        }
        if (!continuation && freshGrant.reservation_id) {
          const reservedAt = freshGrant.reserved_at
            ? new Date(freshGrant.reserved_at)
            : new Date()
          if (reservedAt.getTime() > Date.now() - 5 * 60 * 1000) {
            conflict("Another transfer is already in progress for this grant")
          }
          await this.lockRows_(
            "download_event",
            [freshGrant.reservation_id],
            transactionContext,
          )
          const staleEvent = await this.retrieveDownloadEvent(
            freshGrant.reservation_id,
            {},
            transactionContext,
          )
          if (staleEvent.event_type === DownloadEventType.TRANSFER_STARTED) {
            await this.updateDownloadEvents(
              {
                id: staleEvent.id,
                event_type: DownloadEventType.TRANSFER_FAILED,
                success: false,
                denial_reason: "transfer_reservation_expired",
              },
              transactionContext,
            )
          }
        }
        if (!continuation) {
          if (freshEntitlement.download_limit !== null) {
            const knex = this.transactionKnex_(transactionContext)
            const reserved = await knex("download_grant")
              .where("entitlement_id", entitlement.id)
              .whereNot("id", freshGrant.id)
              .whereNotNull("reservation_id")
              .where("reserved_at", ">", new Date(Date.now() - 5 * 60 * 1000))
              .count({ count: "id" })
              .first()
            if (
              Number(freshEntitlement.download_count) +
                Number(reserved?.count ?? 0) >=
              Number(freshEntitlement.download_limit)
            ) {
              conflict("Entitlement download limit was concurrently reached")
            }
          }
        }
        const freshAsset = await this.retrieveDigitalAsset(
          asset.id,
          {},
          transactionContext,
        )
        if (
          !freshAsset.is_enabled ||
          freshAsset.status !== DigitalAssetStatus.READY ||
          !freshAsset.release_id ||
          freshAsset.release_id !== freshEntitlement.release_id
        ) {
          forbidden("Asset no longer belongs to the pinned entitlement release")
        }
        const transferStartedAt = new Date()
        const createdTransfer = await this.createDownloadEvents(
          {
            grant_id: freshGrant.id,
            entitlement_id: entitlement.id,
            asset_id: asset.id,
            event_type: DownloadEventType.TRANSFER_STARTED,
            success: false,
            ip_hash: requestIpHash,
            user_agent_hash: requestAgentHash,
            occurred_at: transferStartedAt,
            range_start: requestedRange?.start ?? null,
            range_end: requestedRange?.end ?? null,
            metadata: {
              action,
              is_range: isRangeRequest,
              is_partial_range: isPartialRange,
              is_continuation: continuation,
              requested_bytes: requestedRange?.length ?? asset.size_bytes,
            },
          },
          transactionContext,
        )
        const updatedGrant = continuation
          ? freshGrant
          : await this.updateDownloadGrants(
              {
                id: freshGrant.id,
                reservation_id: createdTransfer.id,
                reserved_at: transferStartedAt,
              },
              transactionContext,
            )
        return {
          transfer: createdTransfer,
          authorizedGrant: updatedGrant,
        }
      },
      sharedContext,
    )
    return {
      authorized: true,
      grant: toSafeDownloadGrant(authorizedGrant),
      asset: toSafeDigitalAsset(asset),
      grant_id: grant.id,
      event_id: transfer.id,
      asset_id: asset.id,
      total_size: asset.size_bytes,
      size: requestedRange?.length ?? asset.size_bytes,
      filename: asset.original_filename,
      mime_type: asset.mime_type,
      action,
    }
  }

  @InjectManager()
  async commitDownloadGrantUse(
    eventId: string,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ event: AnyRecord; grant: Record<string, unknown> }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.commitDownloadGrantUse(eventId, transactionContext),
        sharedContext,
      )
    }
    const transferId = bounded(eventId, "download event id", 255)
    const observedEvent = await this.retrieveDownloadEvent(
      transferId,
      {},
      sharedContext,
    )
    if (
      !observedEvent.grant_id ||
      !observedEvent.entitlement_id ||
      !observedEvent.asset_id
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer is missing its grant, entitlement, or asset",
      )
    }
    await this.lockRows_(
      "digital_entitlement",
      [observedEvent.entitlement_id],
      sharedContext,
    )
    await this.lockRows_(
      "download_grant",
      [observedEvent.grant_id],
      sharedContext,
    )
    await this.lockRows_("download_event", [transferId], sharedContext)
    const event = await this.retrieveDownloadEvent(
      transferId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (
      event.grant_id !== observedEvent.grant_id ||
      event.entitlement_id !== observedEvent.entitlement_id ||
      event.asset_id !== observedEvent.asset_id
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer relationships changed unexpectedly",
      )
    }
    const grant = await this.retrieveDownloadGrant(
      event.grant_id,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (event.metadata?.accounting_committed === true) {
      return { event, grant: toSafeDownloadGrant(grant) }
    }
    if (event.event_type !== DownloadEventType.TRANSFER_STARTED) {
      conflict("Download transfer is not in an accounting-committable state")
    }

    const commitTime = new Date()
    if (
      grant.status !== DownloadGrantStatus.ACTIVE ||
      new Date(grant.expires_at) <= commitTime
    ) {
      conflict("Download grant is no longer active")
    }
    const entitlement = await this.retrieveDigitalEntitlement(
      event.entitlement_id,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    entitlementIsUsable(entitlement, commitTime)
    const asset = await this.retrieveDigitalAsset(
      event.asset_id,
      {},
      sharedContext,
    )
    if (
      !asset.is_enabled ||
      asset.status !== DigitalAssetStatus.READY ||
      !asset.release_id ||
      asset.release_id !== entitlement.release_id
    ) {
      conflict("Transfer asset no longer matches the pinned entitlement release")
    }

    const continuation = event.metadata?.is_continuation === true
    let committedGrant = grant
    if (continuation) {
      const rangeStart = Number(event.range_start)
      const rangeEnd = Number(event.range_end)
      if (
        !Number.isSafeInteger(rangeStart) ||
        !Number.isSafeInteger(rangeEnd) ||
        rangeStart < 0 ||
        rangeEnd < rangeStart ||
        rangeEnd >= Number(asset.size_bytes) ||
        rangeEnd - rangeStart + 1 >= Number(asset.size_bytes) ||
        !grant.continuation_expires_at ||
        new Date(grant.continuation_expires_at) <= commitTime
      ) {
        conflict("Download range continuation is no longer valid")
      }
    } else {
      if (grant.reservation_id !== event.id) {
        conflict("Download transfer no longer owns the grant reservation")
      }
      if (
        entitlement.download_limit !== null &&
        Number(entitlement.download_count) >= Number(entitlement.download_limit)
      ) {
        conflict("Entitlement download limit has been reached")
      }
      const rangeStart = Number(event.range_start)
      const rangeEnd = Number(event.range_end)
      const partialRange = Boolean(
        event.metadata?.is_partial_range === true &&
          Number.isSafeInteger(rangeStart) &&
          Number.isSafeInteger(rangeEnd) &&
          rangeStart >= 0 &&
          rangeEnd >= rangeStart &&
          rangeEnd < Number(asset.size_bytes) &&
          rangeEnd - rangeStart + 1 < Number(asset.size_bytes),
      )
      committedGrant = await this.updateDownloadGrants(
        {
          id: grant.id,
          use_count: Number(grant.use_count) + 1,
          last_used_at: commitTime,
          reservation_id: null,
          reserved_at: null,
          continuation_started_at: partialRange ? commitTime : null,
          continuation_expires_at: partialRange
            ? new Date(commitTime.getTime() + RANGE_CONTINUATION_WINDOW_MS)
            : null,
        },
        sharedContext,
      )
      await this.updateDigitalEntitlements(
        {
          id: entitlement.id,
          download_count: Number(entitlement.download_count) + 1,
        },
        sharedContext,
      )
    }
    const committedEvent = await this.updateDownloadEvents(
      {
        id: event.id,
        metadata: {
          ...(event.metadata ?? {}),
          accounting_committed: true,
          accounting_committed_at: commitTime.toISOString(),
        },
      },
      sharedContext,
    )
    return {
      event: committedEvent,
      grant: toSafeDownloadGrant(committedGrant),
    }
  }

  @InjectManager()
  async commitDownloadEvent(
    eventId: string,
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.commitDownloadGrantUse(eventId, sharedContext)
  }

  @InjectManager()
  async completeDownloadGrant(
    eventId: string,
    input: { bytes_transferred?: number } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ event: AnyRecord; grant: Record<string, unknown> }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.completeDownloadGrant(eventId, input, transactionContext),
        sharedContext,
      )
    }
    const transferId = bounded(eventId, "download event id", 255)
    const observedEvent = await this.retrieveDownloadEvent(
      transferId,
      {},
      sharedContext,
    )
    if (!observedEvent.grant_id || !observedEvent.entitlement_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer is missing its grant or entitlement",
      )
    }
    await this.lockRows_(
      "digital_entitlement",
      [observedEvent.entitlement_id],
      sharedContext,
    )
    await this.lockRows_(
      "download_grant",
      [observedEvent.grant_id],
      sharedContext,
    )
    await this.lockRows_("download_event", [transferId], sharedContext)
    const event = await this.retrieveDownloadEvent(
      transferId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (
      event.grant_id !== observedEvent.grant_id ||
      event.entitlement_id !== observedEvent.entitlement_id
    ) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer relationships changed unexpectedly",
      )
    }
    let grant = await this.retrieveDownloadGrant(
      event.grant_id,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (event.event_type === DownloadEventType.TRANSFER_COMPLETED) {
      return { event, grant: toSafeDownloadGrant(grant) }
    }
    if (event.event_type !== DownloadEventType.TRANSFER_STARTED) {
      conflict("Download transfer is not in a committable state")
    }
    if (event.metadata?.accounting_committed !== true) {
      await this.commitDownloadGrantUse(event.id, sharedContext)
      grant = await this.retrieveDownloadGrant(
        event.grant_id,
        { options: { refresh: true } } as any,
        sharedContext,
      )
    }
    const bytes = input.bytes_transferred
    if (bytes !== undefined) {
      positiveInteger(bytes, "bytes_transferred", {
        allowZero: true,
        max: Number.MAX_SAFE_INTEGER,
      })
    }
    const completed = await this.updateDownloadEvents(
      {
        id: event.id,
        event_type: DownloadEventType.TRANSFER_COMPLETED,
        success: true,
        bytes_served: bytes ?? null,
      },
      sharedContext,
    )
    return { event: completed, grant: toSafeDownloadGrant(grant) }
  }

  @InjectManager()
  async completeDownloadEvent(
    eventId: string,
    input: { bytes_transferred?: number } = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.completeDownloadGrant(eventId, input, sharedContext)
  }

  @InjectManager()
  async failDownloadGrant(
    eventId: string,
    input: { reason?: string; bytes_transferred?: number } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ event: AnyRecord }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.failDownloadGrant(eventId, input, transactionContext),
        sharedContext,
      )
    }
    const transferId = bounded(eventId, "download event id", 255)
    const observedEvent = await this.retrieveDownloadEvent(
      transferId,
      {},
      sharedContext,
    )
    if (!observedEvent.grant_id || !observedEvent.entitlement_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer is missing its grant or entitlement",
      )
    }
    await this.lockRows_(
      "digital_entitlement",
      [observedEvent.entitlement_id],
      sharedContext,
    )
    await this.lockRows_(
      "download_grant",
      [observedEvent.grant_id],
      sharedContext,
    )
    await this.lockRows_("download_event", [transferId], sharedContext)
    const event = await this.retrieveDownloadEvent(
      transferId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (event.event_type === DownloadEventType.TRANSFER_FAILED) {
      return { event }
    }
    if (event.event_type !== DownloadEventType.TRANSFER_STARTED) {
      conflict("Only an in-progress transfer can be marked failed")
    }
    if (event.grant_id !== observedEvent.grant_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Download transfer grant changed unexpectedly",
      )
    }
    const grant = await this.retrieveDownloadGrant(
      observedEvent.grant_id,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (grant.reservation_id === event.id) {
      await this.updateDownloadGrants(
        { id: grant.id, reservation_id: null, reserved_at: null },
        sharedContext,
      )
    }
    const bytes = input.bytes_transferred
    if (bytes !== undefined) {
      positiveInteger(bytes, "bytes_transferred", {
        allowZero: true,
        max: Number.MAX_SAFE_INTEGER,
      })
    }
    const failed = await this.updateDownloadEvents(
      {
        id: event.id,
        event_type: DownloadEventType.TRANSFER_FAILED,
        success: false,
        bytes_served: bytes ?? null,
        denial_reason: input.reason?.slice(0, 2000) ?? "transfer_failed",
      },
      sharedContext,
    )
    return { event: failed }
  }

  @InjectManager()
  async failDownloadEvent(
    eventId: string,
    input: { reason?: string; bytes_transferred?: number } = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.failDownloadGrant(eventId, input, sharedContext)
  }

  @InjectManager()
  async openDigitalAsset(
    assetId: string,
    input: OpenDigitalAssetInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<OpenDigitalAssetResult> {
    const asset = await this.retrieveDigitalAsset(
      bounded(assetId, "asset id", 255),
      {},
      sharedContext,
    )
    if (!asset.is_enabled || asset.status !== DigitalAssetStatus.READY) {
      forbidden("Digital asset is disabled")
    }
    if (input.purpose === "preview") {
      if (
        asset.role !== DigitalAssetRole.PREVIEW &&
        asset.role !== DigitalAssetRole.COVER
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Public preview is not available",
        )
      }
      if (!asset.release_id) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Public preview is not available",
        )
      }
      const release = await this.retrieveDigitalProductRelease(
        asset.release_id,
        {},
        sharedContext,
      )
      const now = new Date()
      const availableFrom = release.available_from
        ? new Date(release.available_from)
        : undefined
      const availableUntil = release.available_until
        ? new Date(release.available_until)
        : undefined
      if (
        release.status !== DigitalReleaseStatus.PUBLISHED ||
        release.is_current !== true ||
        (availableFrom &&
          (!Number.isFinite(availableFrom.valueOf()) || availableFrom > now)) ||
        (availableUntil &&
          (!Number.isFinite(availableUntil.valueOf()) || availableUntil <= now))
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Public preview is not available",
        )
      }
      const product = await this.retrieveDigitalProduct(
        release.digital_product_id,
        {},
        sharedContext,
      )
      if (product.status !== DigitalProductStatus.ACTIVE) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          "Public preview is not available",
        )
      }
    } else {
      const nestedGrant = input.grant as AnyRecord | undefined
      const grantId =
        input.grant_id ??
        nestedGrant?.grant_id ??
        nestedGrant?.grant?.id
      const eventId = nestedGrant?.event_id ?? nestedGrant?.event?.id
      if (!grantId) {
        forbidden("An authorized download grant is required")
      }
      if (!eventId) {
        forbidden("An in-progress transfer event is required")
      }
      const grant = await this.retrieveDownloadGrant(
        grantId as string,
        {},
        sharedContext,
      )
      const event = await this.retrieveDownloadEvent(
        eventId as string,
        {},
        sharedContext,
      )
      const entitlement = await this.retrieveDigitalEntitlement(
        grant.entitlement_id,
        {},
        sharedContext,
      )
      entitlementIsUsable(entitlement, new Date())
      const continuation = event.metadata?.is_continuation === true
      if (
        grant.asset_id !== asset.id ||
        event.grant_id !== grant.id ||
        event.asset_id !== asset.id ||
        event.event_type !== DownloadEventType.TRANSFER_STARTED ||
        asset.release_id !== entitlement.release_id ||
        (continuation
          ? !grant.continuation_expires_at ||
            new Date(grant.continuation_expires_at) <= new Date()
          : grant.reservation_id !== event.id)
      ) {
        forbidden("Download grant does not authorize this asset")
      }
    }
    let stored
    try {
      stored = await this.storage_.get({
        provider: asset.storage_provider,
        key: asset.storage_key,
        bucket: asset.storage_bucket,
        start: input.start,
        end: input.end,
      })
      const totalSize = Number(asset.size_bytes)
      const rangeRequested = input.start !== undefined || input.end !== undefined
      const rangeStart = input.start ?? 0
      const rangeEnd = Math.min(input.end ?? totalSize - 1, totalSize - 1)
      const expectedSize = rangeRequested
        ? rangeEnd - rangeStart + 1
        : totalSize
      const expectedContentRange = rangeRequested
        ? `bytes ${rangeStart}-${rangeEnd}/${totalSize}`
        : undefined
      if (
        !Number.isSafeInteger(totalSize) ||
        totalSize < 0 ||
        stored.totalSize !== totalSize ||
        stored.size !== expectedSize ||
        stored.statusCode !== (rangeRequested ? 206 : 200) ||
        stored.contentRange !== expectedContentRange
      ) {
        stored.body.destroy()
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Stored asset metadata does not match its verified publication manifest",
        )
      }
    } catch (error) {
      const eventId = (input.grant as AnyRecord | undefined)?.event_id
      if (eventId) {
        await this.failDownloadGrant(
          eventId,
          { reason: "storage_open_failed" },
          sharedContext,
        )
      }
      throw error
    }
    return {
      body: stored.body,
      size: stored.size,
      total_size: stored.totalSize,
      mime_type: asset.mime_type,
      filename: asset.original_filename,
      etag: stored.etag,
      last_modified: stored.lastModified,
      status_code: stored.statusCode,
      content_range: stored.contentRange,
    }
  }

  async storeAssetObject(input: {
    provider?: any
    key: string
    bucket?: string | null
    body: Buffer | Uint8Array
    mime_type: string
    checksum_sha256?: string
    overwrite?: boolean
  }) {
    if (input.body.byteLength > this.options_.maxUploadSizeBytes) {
      invalid("Asset exceeds the configured upload size limit")
    }
    assertMimeTypeAllowed(input.mime_type, this.options_.allowedMimeTypes)
    return this.storage_.put({
      provider: input.provider,
      key: input.key,
      bucket: input.bucket,
      body: input.body,
      contentType: input.mime_type,
      checksumSha256: input.checksum_sha256,
      overwrite: input.overwrite,
    })
  }

  @InjectManager()
  async initiateDigitalAssetUpload(
    input: {
      release_id?: string
      filename: string
      size: number
      mime_type: string
      checksum_sha256?: string
      storage_provider?: DigitalStorageProvider
      purpose?: DigitalUploadPurpose
      metadata?: Record<string, unknown>
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Record<string, unknown>> {
    const settings = await this.getSettings(sharedContext)
    if (!settings.enabled) {
      forbidden("Digital downloads are not enabled")
    }
    const filename = safeFilename(input.filename)
    const size = positiveInteger(input.size, "size", {
      max: Number(settings.max_upload_size_bytes),
    })
    assertMimeTypeAllowed(input.mime_type, this.options_.allowedMimeTypes)
    const checksum = input.checksum_sha256?.toLowerCase()
    if (checksum && !/^[a-f0-9]{64}$/.test(checksum)) {
      invalid("checksum_sha256 must be a lowercase SHA-256 digest")
    }
    if (input.release_id) {
      await this.retrieveDigitalProductRelease(
        bounded(input.release_id, "release_id", 255),
        {},
        sharedContext,
      )
    }
    const provider =
      input.storage_provider ?? this.options_.storage.defaultProvider
    this.storage_.driver(provider)
    const purpose = input.purpose ?? DigitalUploadPurpose.DOWNLOAD
    if (
      !Object.values(DigitalUploadPurpose).includes(purpose) ||
      purpose === DigitalUploadPurpose.KEY_IMPORT
    ) {
      invalid("purpose must be download, stream, preview, cover, manual, or license")
    }
    const suffix = filename.replace(/[^A-Za-z0-9._-]+/g, "-")
    const key = `uploads/${new Date().toISOString().slice(0, 10)}/${randomOpaqueToken("up", 24)}-${suffix}`
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const uploadToken =
      provider === DigitalStorageProvider.LOCAL
        ? randomOpaqueToken("ddu", 32)
        : undefined
    const upload = await this.createDigitalUploads(
      {
        release_id: input.release_id ?? null,
        status: DigitalUploadStatus.PENDING,
        purpose,
        storage_provider: provider,
        storage_key: key,
        storage_bucket:
          provider === DigitalStorageProvider.S3
            ? this.options_.storage.s3?.bucket ?? null
            : null,
        original_filename: filename,
        mime_type: input.mime_type,
        expected_size_bytes: size,
        expected_checksum_sha256: checksum ?? null,
        upload_token_hash: uploadToken
          ? tokenHash(uploadToken, this.options_.tokenSecret)
          : null,
        expires_at: expiresAt,
        metadata: input.metadata ?? {},
      },
      sharedContext,
    )
    if (provider === DigitalStorageProvider.S3) {
      const descriptor = await this.storage_.createUploadDescriptor(
        { provider, key, bucket: upload.storage_bucket },
        {
          contentType: input.mime_type,
          checksumSha256: checksum,
          expectedSize: size,
        },
        15 * 60,
      )
      return {
        id: upload.id,
        method: descriptor.method,
        url: descriptor.url,
        headers: descriptor.headers,
        expires_at: descriptor.expiresAt,
        storage_provider: provider,
      }
    }
    return {
      id: upload.id,
      method: "PUT",
      url: `/admin/digital-downloads/uploads/${upload.id}/content`,
      headers: { "x-digital-upload-token": uploadToken },
      expires_at: expiresAt,
      storage_provider: provider,
    }
  }

  @InjectManager()
  async receiveDigitalAssetUpload(
    uploadId: string,
    input: {
      stream: Readable
      content_length: number
      content_type: string
      upload_token: string
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Record<string, unknown>> {
    const upload = await this.retrieveDigitalUpload(
      bounded(uploadId, "upload id", 255),
      {},
      sharedContext,
    )
    if (
      upload.storage_provider !== DigitalStorageProvider.LOCAL ||
      upload.status !== DigitalUploadStatus.PENDING
    ) {
      conflict("Upload is not awaiting local content")
    }
    if (new Date(upload.expires_at) <= new Date()) {
      await this.updateDigitalUploads(
        { id: upload.id, status: DigitalUploadStatus.EXPIRED },
        sharedContext,
      )
      forbidden("Upload intent has expired")
    }
    const suppliedHash = tokenHash(
      input.upload_token,
      this.options_.tokenSecret,
    )
    if (
      !upload.upload_token_hash ||
      !safeHashEqual(upload.upload_token_hash, suppliedHash)
    ) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "Upload token is invalid")
    }
    if (
      input.content_length !== Number(upload.expected_size_bytes) ||
      input.content_type.split(";", 1)[0].trim().toLowerCase() !==
        upload.mime_type.toLowerCase()
    ) {
      invalid("Upload Content-Length or Content-Type does not match its intent")
    }
    const stored = await this.storage_.putStream({
      provider: DigitalStorageProvider.LOCAL,
      key: upload.storage_key,
      body: input.stream,
      contentType: upload.mime_type,
      expectedSize: Number(upload.expected_size_bytes),
      checksumSha256: upload.expected_checksum_sha256 ?? undefined,
    })
    const updated = await this.updateDigitalUploads(
      {
        id: upload.id,
        status: DigitalUploadStatus.UPLOADED,
        actual_size_bytes: stored.size,
        actual_checksum_sha256: stored.checksumSha256,
        uploaded_at: new Date(),
        upload_token_hash: null,
      },
      sharedContext,
    )
    return {
      id: updated.id,
      status: updated.status,
      size: stored.size,
      checksum_sha256: stored.checksumSha256,
    }
  }

  @InjectManager()
  async completeDigitalAssetUpload(
    uploadId: string,
    input: {
      release_id?: string
      purpose?: DigitalUploadPurpose
      checksum_sha256?: string
      size?: number
      etag?: string
    } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    const upload = await this.retrieveDigitalUpload(
      bounded(uploadId, "upload id", 255),
      {},
      sharedContext,
    )
    if (upload.status === DigitalUploadStatus.COMPLETED && upload.asset_id) {
      return this.retrieveDigitalAsset(upload.asset_id, {}, sharedContext)
    }
    if (input.purpose !== undefined && input.purpose !== upload.purpose) {
      conflict("Upload purpose cannot be changed during completion")
    }
    if (new Date(upload.expires_at) <= new Date()) {
      forbidden("Upload intent has expired")
    }
    const expectedSize = Number(upload.expected_size_bytes)
    let size = Number(upload.actual_size_bytes ?? 0)
    let checksum = upload.actual_checksum_sha256 as string | null
    if (upload.storage_provider === DigitalStorageProvider.S3) {
      const metadata = await this.storage_.inspect({
        provider: DigitalStorageProvider.S3,
        key: upload.storage_key,
        bucket: upload.storage_bucket,
      })
      size = metadata.size
      if (size !== expectedSize) {
        invalid("Stored upload size does not match its upload intent")
      }
      checksum = metadata.checksumSha256 ?? null
      if (!checksum) {
        const computed = await this.storage_.computeChecksum({
          provider: DigitalStorageProvider.S3,
          key: upload.storage_key,
          bucket: upload.storage_bucket,
        })
        size = computed.size
        checksum = computed.checksumSha256
      }
    }
    const expectedChecksum =
      upload.expected_checksum_sha256 ?? input.checksum_sha256?.toLowerCase()
    if (size !== expectedSize || (input.size !== undefined && input.size !== size)) {
      invalid("Stored upload size does not match its upload intent")
    }
    if (!checksum || (expectedChecksum && checksum !== expectedChecksum)) {
      invalid("Stored upload checksum does not match its upload intent")
    }
    const releaseId = input.release_id ?? upload.release_id
    if (!releaseId) {
      conflict("release_id is required to complete a digital asset upload")
    }
    await this.retrieveDigitalProductRelease(releaseId, {}, sharedContext)
    const { role, deliveryType } = uploadAssetIntent(upload.purpose)
    const kind =
      upload.purpose === DigitalUploadPurpose.LICENSE
        ? DigitalAssetKind.LICENSE
        : assetKind(upload.mime_type, upload.original_filename)
    return this.inTransaction_(async (transactionContext) => {
      await this.lockRows_("digital_upload", [upload.id], transactionContext)
      const freshUpload = await this.retrieveDigitalUpload(
        upload.id,
        { options: { refresh: true } } as any,
        transactionContext,
      )
      if (
        freshUpload.status === DigitalUploadStatus.COMPLETED &&
        freshUpload.asset_id
      ) {
        return this.retrieveDigitalAsset(
          freshUpload.asset_id,
          {},
          transactionContext,
        )
      }
      if (
        [
          DigitalUploadStatus.EXPIRED,
          DigitalUploadStatus.FAILED,
        ].includes(freshUpload.status)
      ) {
        conflict("Upload cannot be completed in its current state")
      }
      const asset = await this.createDigitalAssets(
        {
          release_id: releaseId,
          name: upload.original_filename,
          role,
          kind,
          status: DigitalAssetStatus.READY,
          delivery_type: deliveryType,
          storage_provider: upload.storage_provider,
          storage_key: upload.storage_key,
          storage_bucket: upload.storage_bucket,
          original_filename: upload.original_filename,
          mime_type: upload.mime_type,
          size_bytes: size,
          checksum_sha256: checksum,
          version: "1",
          sort_order: 0,
          is_enabled: true,
          metadata: upload.metadata ?? {},
        },
        transactionContext,
      )
      await this.updateDigitalUploads(
        {
          id: upload.id,
          asset_id: asset.id,
          status: DigitalUploadStatus.COMPLETED,
          actual_size_bytes: size,
          actual_checksum_sha256: checksum,
          completed_at: new Date(),
        },
        transactionContext,
      )
      return asset
    }, sharedContext)
  }

  @InjectManager()
  async uploadDigitalAsset(
    input: {
      release_id: string
      filename: string
      mime_type: string
      bytes: Buffer | Uint8Array
      checksum_sha256?: string
      purpose?: DigitalUploadPurpose
      storage_provider?: DigitalStorageProvider
      metadata?: Record<string, unknown>
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    const intent = await this.initiateDigitalAssetUpload(
      {
        release_id: input.release_id,
        filename: input.filename,
        mime_type: input.mime_type,
        size: input.bytes.byteLength,
        checksum_sha256: input.checksum_sha256 ?? sha256(input.bytes),
        purpose: input.purpose,
        storage_provider: input.storage_provider,
        metadata: input.metadata,
      },
      sharedContext,
    )
    const upload = await this.retrieveDigitalUpload(
      intent.id as string,
      {},
      sharedContext,
    )
    const stored = await this.storage_.put({
      provider: upload.storage_provider,
      key: upload.storage_key,
      bucket: upload.storage_bucket,
      body: input.bytes,
      contentType: input.mime_type,
      checksumSha256: input.checksum_sha256,
    })
    await this.updateDigitalUploads(
      {
        id: upload.id,
        status: DigitalUploadStatus.UPLOADED,
        actual_size_bytes: stored.size,
        actual_checksum_sha256: stored.checksumSha256,
        uploaded_at: new Date(),
      },
      sharedContext,
    )
    return this.completeDigitalAssetUpload(
      upload.id,
      { release_id: input.release_id },
      sharedContext,
    )
  }

  async deleteAssetObject(input: {
    provider: DigitalStorageProvider
    key: string
    bucket?: string | null
  }): Promise<void> {
    await this.storage_.delete(input)
  }

  async getReadinessDiagnostics(): Promise<{
    ready: boolean
    provider: DigitalStorageProvider
    issues: string[]
  }> {
    const issues: string[] = []
    if (!this.options_.tokenSecret) {
      issues.push("token_secret_missing")
    }
    if (!this.options_.encryptionKey) {
      issues.push("encryption_key_missing")
    }
    if (
      this.options_.storage.defaultProvider === DigitalStorageProvider.LOCAL &&
      !this.options_.storage.local.signingSecret
    ) {
      issues.push("local_signing_secret_missing")
    }
    return {
      ready: issues.length === 0,
      provider: this.options_.storage.defaultProvider,
      issues,
    }
  }

  async testStorage(input: {
    operation?: "health" | "write_read_delete"
    provider?: DigitalStorageProvider
  } = {}): Promise<Record<string, unknown>> {
    const readiness = await this.getReadinessDiagnostics()
    const provider = input.provider ?? this.options_.storage.defaultProvider
    if (input.operation !== "write_read_delete") {
      return { ...readiness, provider, operation: "health" }
    }
    const body = Buffer.from(randomOpaqueToken("ddh", 24), "utf8")
    const key = `_healthchecks/${Date.now()}-${randomOpaqueToken("hc", 24)}.txt`
    const startedAt = Date.now()
    try {
      const written = await this.storage_.put({
        provider,
        key,
        body,
        contentType: "text/plain",
      })
      const read = await this.storage_.get({ provider, key })
      const received = await collectBoundedStream(read.body, 64 * 1024)
      if (!received.equals(body) || written.checksumSha256 !== sha256(body)) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Storage health-check round trip did not preserve bytes",
        )
      }
      return {
        ready: readiness.ready,
        provider,
        operation: "write_read_delete",
        ok: true,
        latency_ms: Date.now() - startedAt,
      }
    } finally {
      await this.storage_.delete({ provider, key }).catch(() => undefined)
    }
  }

  @InjectManager()
  async listDigitalAssetProjections(
    filters: AnyRecord = {},
    config: FindConfig<any> = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    const assets = await this.listDigitalAssets(filters, config, sharedContext)
    return assets.map(toSafeDigitalAsset)
  }

  @InjectManager()
  async listLicensePoolKeySummaries(
    filters: AnyRecord = {},
    config: FindConfig<any> = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    const keys = await this.listLicensePoolKeys(filters, config, sharedContext)
    return keys.map(toSafeLicensePoolKey)
  }

  @InjectManager()
  async importLicenseKeys(
    input: ImportLicenseKeysInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<Array<ReturnType<typeof toSafeLicensePoolKey>>> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) => this.importLicenseKeys(input, transactionContext),
        sharedContext,
      )
    }
    if (!input.keys.length || input.keys.length > 10_000) {
      invalid("Between 1 and 10000 license keys are required")
    }
    const duplicatePolicy = input.duplicate_policy ?? "reject"
    if (!["reject", "skip"].includes(duplicatePolicy)) {
      invalid("duplicate_policy must be reject or skip")
    }
    const policyId = bounded(
      input.license_policy_id,
      "license_policy_id",
      255,
    )
    await this.lockRows_("license_policy", [policyId], sharedContext)
    const policy = await this.retrieveLicensePolicy(
      policyId,
      {},
      sharedContext,
    )
    if (policy.strategy !== LicenseStrategy.POOL) {
      conflict("License keys can only be imported into a pool policy")
    }
    const secret = this.options_.encryptionKey
    const normalizedInput = input.keys.map(normalizeLicenseKey)
    const normalized = [...new Set(normalizedInput)]
    if (
      duplicatePolicy === "reject" &&
      normalized.length !== normalizedInput.length
    ) {
      conflict("The import contains duplicate license keys")
    }
    const candidates = normalized.map((plaintext) => ({
      plaintext,
      fingerprint: keyedFingerprint(plaintext, secret, "license-key"),
    }))
    const knex = this.transactionKnex_(sharedContext)
    await knex.raw(
      "SELECT pg_advisory_xact_lock(hashtext(value)) FROM unnest(?::text[]) AS locks(value) ORDER BY value",
      [candidates.map(({ fingerprint }) => `digital-license:${fingerprint}`)],
    )
    const existing = candidates.length
      ? await this.listLicensePoolKeys(
          { key_fingerprint: candidates.map(({ fingerprint }) => fingerprint) },
          { take: candidates.length } as any,
          sharedContext,
        )
      : []
    if (duplicatePolicy === "reject" && existing.length) {
      conflict("One or more supplied license keys already exist")
    }
    const existingFingerprints = new Set(
      existing.map((entry) => entry.key_fingerprint),
    )
    const pending = candidates.filter(
      ({ fingerprint }) => !existingFingerprints.has(fingerprint),
    )
    if (!pending.length) return []
    const batchId = input.batch_id
      ? bounded(input.batch_id, "batch_id", 255)
      : null
    const created = await this.createLicensePoolKeys(
      pending.map(({ plaintext, fingerprint }) => ({
        license_policy_id: policy.id,
        status: LicensePoolKeyStatus.AVAILABLE,
        key_ciphertext: encryptSecret(plaintext, this.options_.encryptionKey),
        key_fingerprint: fingerprint,
        key_hint: licenseKeyHint(plaintext),
        batch_id: batchId,
        metadata: input.metadata ?? {},
      })),
      sharedContext,
    )
    await this.createLicenseAuditEvents(
      {
        assignment_id: null,
        action: LicenseAuditAction.KEY_IMPORTED,
        success: true,
        occurred_at: new Date(),
        metadata: {
          license_policy_id: policy.id,
          batch_id: batchId,
          imported_count: created.length,
          skipped_count: normalizedInput.length - created.length,
        },
      },
      sharedContext,
    )
    return created.map(toSafeLicensePoolKey)
  }

  @InjectManager()
  async assignLicenseKey(
    input: AssignLicenseKeyInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ assignment: AnyRecord; license_key: string; created: boolean }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.assignLicenseKey(input, transactionContext),
        sharedContext,
      )
    }
    const idempotencyKey = bounded(
      input.idempotency_key,
      "idempotency_key",
      512,
    )
    await this.lockRows_(
      "digital_entitlement",
      [bounded(input.entitlement_id, "entitlement_id", 255)],
      sharedContext,
    )
    const previous = await this.listLicenseAssignments(
      { idempotency_key: idempotencyKey },
      {},
      sharedContext,
    )
    if (previous.length) {
      if (
        previous[0].entitlement_id !== input.entitlement_id ||
        previous[0].license_policy_id !== input.license_policy_id
      ) {
        conflict("Idempotency key is already associated with another assignment")
      }
      if (!previous[0].license_pool_key_id) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "License assignment has no key",
        )
      }
      const key = await this.retrieveLicensePoolKey(
        previous[0].license_pool_key_id,
        {},
        sharedContext,
      )
      return {
        assignment: previous[0],
        license_key: decryptSecret(
          key.key_ciphertext,
          this.options_.encryptionKey,
        ),
        created: false,
      }
    }

    const now = new Date()
    const entitlement = await this.retrieveDigitalEntitlement(
      bounded(input.entitlement_id, "entitlement_id", 255),
      {},
      sharedContext,
    )
    entitlementIsUsable(entitlement, now)
    const policy = await this.retrieveLicensePolicy(
      bounded(input.license_policy_id, "license_policy_id", 255),
      {},
      sharedContext,
    )
    if (policy.strategy === LicenseStrategy.EXTERNAL) {
      conflict(
        "External license providers are not supported in v1; use generated or pool",
      )
    }
    if (policy.allow_offline_activation === true) {
      conflict("Offline activation certificates are not supported in v1")
    }
    if (!policy.is_enabled || policy.strategy === LicenseStrategy.NONE) {
      forbidden("License policy is disabled")
    }
    if (policy.digital_product_id !== entitlement.digital_product_id) {
      forbidden("License policy does not belong to the entitled product")
    }
    const entitlementAssignments = await this.listLicenseAssignments(
      {
        entitlement_id: entitlement.id,
        license_policy_id: policy.id,
      },
      {},
      sharedContext,
    )
    const existingAssignment = entitlementAssignments[0]
    if (
      existingAssignment?.status === LicenseAssignmentStatus.ACTIVE &&
      existingAssignment.license_pool_key_id
    ) {
      const existingKey = await this.retrieveLicensePoolKey(
        existingAssignment.license_pool_key_id,
        {},
        sharedContext,
      )
      return {
        assignment: existingAssignment,
        license_key: decryptSecret(
          existingKey.key_ciphertext,
          this.options_.encryptionKey,
        ),
        created: false,
      }
    }

    let poolKey: AnyRecord
    let plaintext: string
    if (policy.strategy === LicenseStrategy.POOL) {
      const knex = this.transactionKnex_(sharedContext)
      const candidate = await knex("license_pool_key")
        .where({
          license_policy_id: policy.id,
          status: LicensePoolKeyStatus.AVAILABLE,
          deleted_at: null,
        })
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .first("id")
      if (!candidate?.id) {
        conflict("License key pool is exhausted")
      }
      poolKey = await this.retrieveLicensePoolKey(
        candidate.id,
        {},
        sharedContext,
      )
      poolKey = await this.updateLicensePoolKeys(
        {
          id: poolKey.id,
          status: LicensePoolKeyStatus.RESERVED,
          reserved_at: now,
        },
        sharedContext,
      )
      plaintext = decryptSecret(
        poolKey.key_ciphertext,
        this.options_.encryptionKey,
      )
    } else {
      if (policy.strategy === LicenseStrategy.GENERATED) {
        if (policy.license_pattern) {
          validateLicensePattern(policy.license_pattern)
        }
        plaintext = generateLicenseKey(policy.license_pattern ?? undefined)
      } else {
        plaintext = normalizeLicenseKey(
          input.external_key ?? invalid("external_key is required"),
        )
      }
      const fingerprint = keyedFingerprint(
        plaintext,
        this.options_.encryptionKey,
        "license-key",
      )
      poolKey = await this.createLicensePoolKeys(
        {
          license_policy_id: policy.id,
          status: LicensePoolKeyStatus.RESERVED,
          key_ciphertext: encryptSecret(
            plaintext,
            this.options_.encryptionKey,
          ),
          key_fingerprint: fingerprint,
          key_hint: licenseKeyHint(plaintext),
          reserved_at: now,
          metadata: input.metadata ?? {},
        },
        sharedContext,
      )
    }

    const policyExpiry = policy.validity_days
      ? new Date(now.getTime() + policy.validity_days * 86400000)
      : null
    const entitlementExpiry = entitlement.expires_at
      ? new Date(entitlement.expires_at)
      : null
    const expiresAt =
      policyExpiry && entitlementExpiry
        ? new Date(Math.min(policyExpiry.getTime(), entitlementExpiry.getTime()))
        : policyExpiry ?? entitlementExpiry
    const assignmentData = {
      entitlement_id: entitlement.id,
      license_policy_id: policy.id,
      license_pool_key_id: poolKey.id,
      status: LicenseAssignmentStatus.ACTIVE,
      idempotency_key: idempotencyKey,
      activation_count: 0,
      assigned_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      revoke_reason: null,
      metadata: input.metadata ?? {},
    }
    const assignment = existingAssignment
      ? await this.updateLicenseAssignments(
          { id: existingAssignment.id, ...assignmentData },
          sharedContext,
        )
      : await this.createLicenseAssignments(assignmentData, sharedContext)
    if (existingAssignment?.license_pool_key_id) {
      await this.updateLicensePoolKeys(
        {
          id: existingAssignment.license_pool_key_id,
          status: LicensePoolKeyStatus.REVOKED,
          revoked_at: now,
        },
        sharedContext,
      )
    }
    await this.updateLicensePoolKeys(
      {
        id: poolKey.id,
        status: LicensePoolKeyStatus.ASSIGNED,
        assigned_at: now,
      },
      sharedContext,
    )
    await this.createLicenseAuditEvents(
      {
        assignment_id: assignment.id,
        action: LicenseAuditAction.KEY_ASSIGNED,
        success: true,
        occurred_at: now,
        metadata: { key_hint: poolKey.key_hint },
      },
      sharedContext,
    )
    return { assignment, license_key: plaintext, created: true }
  }

  @InjectManager()
  async activateLicense(
    input: ActivateLicenseInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ activation: AnyRecord; assignment: AnyRecord; created: boolean }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      try {
        return await this.inTransaction_(
          (transactionContext) =>
            this.activateLicense(input, transactionContext),
          sharedContext,
        )
      } catch (error) {
        if (
          error instanceof MedusaError &&
          error.message === "License activation limit has been reached"
        ) {
          await this.createLicenseAuditEvents(
            {
              assignment_id: bounded(
                input.assignment_id,
                "assignment_id",
                255,
              ),
              action: LicenseAuditAction.VALIDATION_FAILED,
              success: false,
              error_code: "activation_limit_reached",
              occurred_at: new Date(),
              metadata: {},
            },
            sharedContext,
          ).catch(() => undefined)
        }
        throw error
      }
    }
    const now = new Date()
    const assignmentId = bounded(input.assignment_id, "assignment_id", 255)
    await this.lockRows_("license_assignment", [assignmentId], sharedContext)
    const assignment = await this.retrieveLicenseAssignment(
      assignmentId,
      {},
      sharedContext,
    )
    if (assignment.status !== LicenseAssignmentStatus.ACTIVE) {
      forbidden("License assignment is not active")
    }
    if (assignment.expires_at && new Date(assignment.expires_at) <= now) {
      forbidden("License assignment has expired")
    }
    const policy = await this.retrieveLicensePolicy(
      assignment.license_policy_id,
      {},
      sharedContext,
    )
    const entitlement = await this.retrieveDigitalEntitlement(
      assignment.entitlement_id,
      {},
      sharedContext,
    )
    entitlementIsUsable(entitlement, now)
    const deviceFingerprint = keyedFingerprint(
      bounded(input.device_id, "device_id", 1024),
      this.options_.encryptionKey,
      "device",
    )
    const existing = await this.listLicenseActivations(
      {
        assignment_id: assignment.id,
        device_fingerprint: deviceFingerprint,
      },
      {},
      sharedContext,
    )
    if (existing.length && existing[0].status === LicenseActivationStatus.ACTIVE) {
      const activation = await this.updateLicenseActivations(
        { id: existing[0].id, last_seen_at: now },
        sharedContext,
      )
      return { activation, assignment, created: false }
    }
    if (existing.length && existing[0].status === LicenseActivationStatus.BLOCKED) {
      forbidden("License instance is blocked")
    }

    const limit =
      entitlement.license_activation_limit ?? policy.activation_limit ?? null
    if (limit !== null && assignment.activation_count >= limit) {
      await this.createLicenseAuditEvents(
        {
          assignment_id: assignment.id,
          action: LicenseAuditAction.VALIDATION_FAILED,
          success: false,
          error_code: "activation_limit_reached",
          occurred_at: now,
          metadata: {},
        },
        sharedContext,
      )
      forbidden("License activation limit has been reached")
    }

    const changedAssignment = await this.updateLicenseAssignments(
      {
        id: assignment.id,
        activation_count: Number(assignment.activation_count) + 1,
      },
      sharedContext,
    )

    const activation = existing.length
      ? await this.updateLicenseActivations(
          {
            id: existing[0].id,
            status: LicenseActivationStatus.ACTIVE,
            activated_at: now,
            last_seen_at: now,
            deactivated_at: null,
          },
          sharedContext,
        )
      : await this.createLicenseActivations(
          {
            assignment_id: assignment.id,
            device_fingerprint: deviceFingerprint,
            device_name: input.device_name?.trim().slice(0, 255) || null,
            ip_hash: normalizeAndFingerprint(
              input.ip,
              this.options_.tokenSecret,
              "ip",
            ),
            user_agent_hash: normalizeAndFingerprint(
              input.user_agent,
              this.options_.tokenSecret,
              "user-agent",
            ),
            status: LicenseActivationStatus.ACTIVE,
            activated_at: now,
            last_seen_at: now,
            metadata: input.metadata ?? {},
          },
          sharedContext,
        )
    await this.createLicenseAuditEvents(
      {
        assignment_id: assignment.id,
        action: LicenseAuditAction.ACTIVATED,
        success: true,
        occurred_at: now,
        metadata: { activation_id: activation.id },
      },
      sharedContext,
    )
    return {
      activation,
      assignment: changedAssignment,
      created: !existing.length,
    }
  }

  private async resolveLicenseKeyRecord(
    rawLicenseKey: string,
    sharedContext: AnyRecord = {},
  ): Promise<{
    poolKey: AnyRecord
    assignment: AnyRecord
    entitlement: AnyRecord
    policy: AnyRecord
  }> {
    let normalized: string
    try {
      normalized = normalizeLicenseKey(rawLicenseKey)
    } catch {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "License key is invalid")
    }
    const fingerprint = keyedFingerprint(
      normalized,
      this.options_.encryptionKey,
      "license-key",
    )
    const keys = await this.listLicensePoolKeys(
      { key_fingerprint: fingerprint },
      {},
      sharedContext,
    )
    if (!keys.length || keys[0].status !== LicensePoolKeyStatus.ASSIGNED) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "License key is invalid")
    }
    const plaintext = decryptSecret(
      keys[0].key_ciphertext,
      this.options_.encryptionKey,
    )
    if (normalizeLicenseKey(plaintext) !== normalized) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "License key is invalid")
    }
    const assignments = await this.listLicenseAssignments(
      { license_pool_key_id: keys[0].id },
      {},
      sharedContext,
    )
    if (!assignments.length) {
      throw new MedusaError(MedusaError.Types.UNAUTHORIZED, "License key is invalid")
    }
    const assignment = assignments[0]
    const [entitlement, policy] = await Promise.all([
      this.retrieveDigitalEntitlement(
        assignment.entitlement_id,
        {},
        sharedContext,
      ),
      this.retrieveLicensePolicy(
        assignment.license_policy_id,
        {},
        sharedContext,
      ),
    ])
    return { poolKey: keys[0], assignment, entitlement, policy }
  }

  @InjectManager()
  async activateLicenseByKey(
    input: LicenseKeyClientInput,
    @MedusaContext() sharedContext: Context = {},
  ) {
    const resolved = await this.resolveLicenseKeyRecord(
      input.license_key,
      sharedContext,
    )
    return this.activateLicense(
      {
        assignment_id: resolved.assignment.id,
        device_id: bounded(
          input.instance_id ?? invalid("instance_id is required"),
          "instance_id",
          1024,
        ),
        device_name: input.label,
        ip: input.ip,
        user_agent: input.user_agent,
        metadata: input.metadata,
      },
      sharedContext,
    )
  }

  @InjectManager()
  async deactivateLicenseByKey(
    input: LicenseKeyClientInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    deactivated: boolean
    assignment: AnyRecord
    license: AnyRecord
    activation?: AnyRecord
  }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.deactivateLicenseByKey(input, transactionContext),
        sharedContext,
      )
    }
    const now = new Date()
    const resolved = await this.resolveLicenseKeyRecord(
      input.license_key,
      sharedContext,
    )
    await this.lockRows_(
      "license_assignment",
      [resolved.assignment.id],
      sharedContext,
    )
    const assignment = await this.retrieveLicenseAssignment(
      resolved.assignment.id,
      {},
      sharedContext,
    )
    const deviceFingerprint = keyedFingerprint(
      bounded(input.instance_id ?? invalid("instance_id is required"), "instance_id", 1024),
      this.options_.encryptionKey,
      "device",
    )
    const activations = await this.listLicenseActivations(
      {
        assignment_id: assignment.id,
        device_fingerprint: deviceFingerprint,
      },
      {},
      sharedContext,
    )
    if (
      !activations.length ||
      [
        LicenseActivationStatus.DEACTIVATED,
        LicenseActivationStatus.BLOCKED,
      ].includes(activations[0].status)
    ) {
      return {
        deactivated: false,
        assignment,
        license: assignment,
        activation: activations[0],
      }
    }
    const updatedActivation = await this.updateLicenseActivations(
      {
        id: activations[0].id,
        status: LicenseActivationStatus.DEACTIVATED,
        deactivated_at: now,
        last_seen_at: now,
      },
      sharedContext,
    )
    const updatedAssignment = await this.updateLicenseAssignments(
      {
        id: assignment.id,
        activation_count: Math.max(0, Number(assignment.activation_count) - 1),
      },
      sharedContext,
    )
    await this.createLicenseAuditEvents(
      {
        assignment_id: assignment.id,
        action: LicenseAuditAction.DEACTIVATED,
        success: true,
        occurred_at: now,
        metadata: { activation_id: activations[0].id },
      },
      sharedContext,
    )
    return {
      deactivated: true,
      assignment: updatedAssignment,
      license: updatedAssignment,
      activation: updatedActivation,
    }
  }

  @InjectManager()
  async heartbeatLicenseByKey(
    input: LicenseKeyClientInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ valid: true; activation: AnyRecord; assignment: AnyRecord }> {
    const now = new Date()
    const resolved = await this.resolveLicenseKeyRecord(
      input.license_key,
      sharedContext,
    )
    if (resolved.assignment.status !== LicenseAssignmentStatus.ACTIVE) {
      forbidden("License assignment is not active")
    }
    if (
      resolved.assignment.expires_at &&
      new Date(resolved.assignment.expires_at) <= now
    ) {
      forbidden("License assignment has expired")
    }
    entitlementIsUsable(resolved.entitlement, now)
    const deviceFingerprint = keyedFingerprint(
      bounded(input.instance_id ?? invalid("instance_id is required"), "instance_id", 1024),
      this.options_.encryptionKey,
      "device",
    )
    const activations = await this.listLicenseActivations(
      {
        assignment_id: resolved.assignment.id,
        device_fingerprint: deviceFingerprint,
        status: LicenseActivationStatus.ACTIVE,
      },
      {},
      sharedContext,
    )
    if (!activations.length) {
      forbidden("License instance is not active")
    }
    const activation = await this.updateLicenseActivations(
      { id: activations[0].id, last_seen_at: now },
      sharedContext,
    )
    return { valid: true, activation, assignment: resolved.assignment }
  }

  @InjectManager()
  async validateLicenseByKey(
    input: LicenseKeyClientInput,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    valid: boolean
    reason?: string
    assignment?: AnyRecord
    activation?: AnyRecord
  }> {
    try {
      const now = new Date()
      const resolved = await this.resolveLicenseKeyRecord(
        input.license_key,
        sharedContext,
      )
      if (resolved.assignment.status !== LicenseAssignmentStatus.ACTIVE) {
        return { valid: false, reason: "inactive" }
      }
      if (
        resolved.assignment.expires_at &&
        new Date(resolved.assignment.expires_at) <= now
      ) {
        return { valid: false, reason: "expired" }
      }
      try {
        entitlementIsUsable(resolved.entitlement, now)
      } catch {
        return { valid: false, reason: "entitlement_inactive" }
      }
      if (!input.instance_id) {
        if (resolved.policy.require_device_id !== false) {
          return { valid: false, reason: "instance_required" }
        }
        return { valid: true, assignment: resolved.assignment }
      }
      const deviceFingerprint = keyedFingerprint(
        bounded(input.instance_id, "instance_id", 1024),
        this.options_.encryptionKey,
        "device",
      )
      const activations = await this.listLicenseActivations(
        {
          assignment_id: resolved.assignment.id,
          device_fingerprint: deviceFingerprint,
          status: LicenseActivationStatus.ACTIVE,
        },
        {},
        sharedContext,
      )
      if (!activations.length) {
        return { valid: false, reason: "instance_inactive" }
      }
      return {
        valid: true,
        assignment: resolved.assignment,
        activation: activations[0],
      }
    } catch (error) {
      if (
        error instanceof MedusaError &&
        [MedusaError.Types.UNAUTHORIZED, MedusaError.Types.FORBIDDEN].includes(
          error.type,
        )
      ) {
        return { valid: false, reason: "invalid" }
      }
      throw error
    }
  }

  @InjectManager()
  async revealLicenseKey(
    input: {
      assignment_id: string
      customer_id?: string
      guest_token?: string
      guest_email?: string
      ip?: string
      user_agent?: string
    },
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{ assignment: AnyRecord; license_key: string }> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.revealLicenseKey(input, transactionContext),
        sharedContext,
      )
    }
    const assignmentId = bounded(input.assignment_id, "assignment id", 255)
    const hidden = (): never => {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "License assignment was not found",
      )
    }
    let guestEntitlementId: string | undefined
    if (!input.customer_id && input.guest_token) {
      const access = await this.resolveGuestEntitlement(
        input.guest_token,
        {
          email: input.guest_email,
          ip: input.ip,
          user_agent: input.user_agent,
        },
        sharedContext,
      )
      guestEntitlementId = access.entitlement.id
    } else if (!input.customer_id) {
      forbidden("License ownership proof is required")
    }
    let observed: AnyRecord
    try {
      observed = await this.retrieveLicenseAssignment(
        assignmentId,
        {},
        sharedContext,
      )
    } catch (error) {
      if (
        error instanceof MedusaError &&
        error.type === MedusaError.Types.NOT_FOUND
      ) {
        return hidden()
      }
      throw error
    }
    const observedEntitlement = await this.retrieveDigitalEntitlement(
      observed.entitlement_id,
      {},
      sharedContext,
    )
    if (
      (input.customer_id &&
        observedEntitlement.customer_id !== input.customer_id) ||
      (guestEntitlementId && guestEntitlementId !== observedEntitlement.id)
    ) {
      return hidden()
    }
    await this.lockRows_("license_assignment", [assignmentId], sharedContext)
    const assignment = await this.retrieveLicenseAssignment(
      assignmentId,
      { options: { refresh: true } } as any,
      sharedContext,
    )
    if (assignment.entitlement_id !== observedEntitlement.id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "License assignment relationships changed unexpectedly",
      )
    }
    if (assignment.status !== LicenseAssignmentStatus.ACTIVE) {
      forbidden("License assignment is not active")
    }
    if (assignment.expires_at && new Date(assignment.expires_at) <= new Date()) {
      forbidden("License assignment has expired")
    }
    entitlementIsUsable(observedEntitlement, new Date())
    if (!assignment.license_pool_key_id) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "License assignment has no key",
      )
    }
    const key = await this.retrieveLicensePoolKey(
      assignment.license_pool_key_id,
      {},
      sharedContext,
    )
    if (key.status !== LicensePoolKeyStatus.ASSIGNED) {
      forbidden("Assigned license key is not active")
    }
    const updated = await this.updateLicenseAssignments(
      { id: assignment.id, revealed_at: new Date() },
      sharedContext,
    )
    await this.createLicenseAuditEvents(
      {
        assignment_id: assignment.id,
        action: LicenseAuditAction.KEY_REVEALED,
        success: true,
        occurred_at: new Date(),
        metadata: {},
      },
      sharedContext,
    )
    return {
      assignment: updated,
      license_key: decryptSecret(
        key.key_ciphertext,
        this.options_.encryptionKey,
      ),
    }
  }

  @InjectManager()
  async getSettings(
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    const settings = await this.listDigitalDownloadsSettings(
      { singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY },
      {},
      sharedContext,
    )
    if (settings.length) {
      return settings[0]
    }
    return this.createDigitalDownloadsSettings(
      {
        singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY,
        enabled: (await this.getReadinessDiagnostics()).ready,
        default_download_limit: this.options_.defaultDownloadLimit,
        default_grant_ttl_seconds: this.options_.defaultGrantTtlSeconds,
        max_grant_ttl_seconds: this.options_.maxGrantTtlSeconds,
        max_upload_size_bytes: this.options_.maxUploadSizeBytes,
        allow_guest_access: this.options_.allowGuestAccess,
        storage_namespace_fingerprint:
          digitalDownloadsStorageNamespaceFingerprint(this.options_),
        storage_namespace_version: 1,
        token_secret_fingerprint: this.options_.tokenSecret
          ? sha256(
              `medusa-digital-downloads/token-secret/v1\0${this.options_.tokenSecret}`,
            )
          : null,
        encryption_key_fingerprint: this.options_.encryptionKey
          ? sha256(
              `medusa-digital-downloads/encryption-secret/v1\0${this.options_.encryptionKey}`,
            )
          : null,
        show_makepay_attribution: true,
        attribution_label: MAKEPAY_ATTRIBUTION_LABEL,
        attribution_url: MAKEPAY_ATTRIBUTION_URL,
      },
      sharedContext,
    )
  }

  @InjectManager()
  async updateSettings(
    input: AnyRecord,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord> {
    assertSafeAttribution(input)
    const current = await this.getSettings(sharedContext)
    const normalized: AnyRecord = { ...input }
    if (input.max_upload_bytes !== undefined) {
      normalized.max_upload_size_bytes = input.max_upload_bytes
    }
    if (input.grant_ttl_seconds !== undefined) {
      normalized.default_grant_ttl_seconds = input.grant_ttl_seconds
    }
    if (input.download_limit_default !== undefined) {
      normalized.default_download_limit = input.download_limit_default
    }
    if (input.signed_url_ttl_seconds !== undefined) {
      normalized.default_grant_ttl_seconds = input.signed_url_ttl_seconds
    }
    if (input.max_upload_size_mb !== undefined) {
      normalized.max_upload_size_bytes = Math.round(
        Number(input.max_upload_size_mb) * 1024 * 1024,
      )
    }
    if (input.audit_retention_days !== undefined) {
      normalized.event_retention_days = input.audit_retention_days
    }
    for (const alias of [
      "max_upload_bytes",
      "grant_ttl_seconds",
      "download_limit_default",
      "signed_url_ttl_seconds",
      "max_upload_size_mb",
      "audit_retention_days",
    ]) {
      delete normalized[alias]
    }
    if (input.enabled === true && !(await this.getReadinessDiagnostics()).ready) {
      conflict("Digital downloads cannot be enabled until readiness checks pass")
    }
    if (
      normalized.default_delivery_type !== undefined &&
      !Object.values(DigitalDeliveryMode).includes(
        normalized.default_delivery_type,
      )
    ) {
      invalid("default_delivery_type is invalid")
    }
    if (normalized.default_download_limit !== undefined &&
      normalized.default_download_limit !== null) {
      positiveInteger(
        normalized.default_download_limit,
        "default_download_limit",
        { allowZero: true },
      )
    }
    const defaultTtl = positiveInteger(
      normalized.default_grant_ttl_seconds ??
        Number(current.default_grant_ttl_seconds),
      "default_grant_ttl_seconds",
      { max: this.options_.maxGrantTtlSeconds },
    )
    const maxTtl = positiveInteger(
      normalized.max_grant_ttl_seconds ?? Number(current.max_grant_ttl_seconds),
      "max_grant_ttl_seconds",
      { max: this.options_.maxGrantTtlSeconds },
    )
    if (defaultTtl > maxTtl) {
      invalid("default_grant_ttl_seconds cannot exceed max_grant_ttl_seconds")
    }
    if (normalized.max_upload_size_bytes !== undefined) {
      positiveInteger(
        normalized.max_upload_size_bytes,
        "max_upload_size_bytes",
        { max: this.options_.maxUploadSizeBytes },
      )
    }
    if (normalized.event_retention_days !== undefined) {
      positiveInteger(normalized.event_retention_days, "event_retention_days", {
        max: 36_500,
      })
    }
    return this.updateDigitalDownloadsSettings(
      {
        ...normalized,
        id: current.id,
        singleton_key: DIGITAL_DOWNLOADS_SETTINGS_KEY,
        storage_namespace_fingerprint:
          current.storage_namespace_fingerprint,
        storage_namespace_version: current.storage_namespace_version,
        token_secret_fingerprint: current.token_secret_fingerprint,
        encryption_key_fingerprint: current.encryption_key_fingerprint,
        attribution_label: MAKEPAY_ATTRIBUTION_LABEL,
        attribution_url: MAKEPAY_ATTRIBUTION_URL,
      },
      sharedContext,
    )
  }

  @InjectManager()
  async claimFulfillmentOperations(
    workerId: string,
    limit = 25,
    leaseSeconds = 60,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord[]> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.claimFulfillmentOperations(
            workerId,
            limit,
            leaseSeconds,
            transactionContext,
          ),
        sharedContext,
      )
    }
    const worker = bounded(workerId, "worker id", 255)
    const take = positiveInteger(limit, "limit", { max: 100 })
    const lease = positiveInteger(leaseSeconds, "lease seconds", { max: 3600 })
    const now = new Date()
    const knex = this.transactionKnex_(sharedContext)
    const maxed = await knex("fulfillment_operation")
      .select("id")
      .whereNull("deleted_at")
      .andWhere((eligible: AnyRecord) => {
        eligible
          .where((retryable: AnyRecord) => {
            retryable
              .whereIn("state", [
                FulfillmentOperationState.PENDING,
                FulfillmentOperationState.FAILED,
              ])
              .andWhere((retryDue: AnyRecord) => {
                retryDue
                  .whereNull("next_retry_at")
                  .orWhere("next_retry_at", "<=", now)
              })
          })
          .orWhere((expiredLease: AnyRecord) => {
            expiredLease
              .where("state", FulfillmentOperationState.PROCESSING)
              .andWhere("lease_expires_at", "<=", now)
          })
      })
      .whereColumn("attempt_count", ">=", "max_attempts")
      .orderBy("created_at", "asc")
      .limit(100)
      .forUpdate()
      .skipLocked()
    if (maxed.length) {
      await this.updateFulfillmentOperations(
        maxed.map(({ id }: AnyRecord) => ({
          id,
          state: FulfillmentOperationState.DEAD_LETTER,
          lease_owner: null,
          lease_expires_at: null,
        })),
        sharedContext,
      )
    }
    const candidates = await knex("fulfillment_operation")
      .select("id")
      .whereNull("deleted_at")
      .andWhere((eligible: AnyRecord) => {
        eligible
          .where((retryable: AnyRecord) => {
            retryable
              .whereIn("state", [
                FulfillmentOperationState.PENDING,
                FulfillmentOperationState.FAILED,
              ])
              .andWhere((retryDue: AnyRecord) => {
                retryDue
                  .whereNull("next_retry_at")
                  .orWhere("next_retry_at", "<=", now)
              })
          })
          .orWhere((expiredLease: AnyRecord) => {
            expiredLease
              .where("state", FulfillmentOperationState.PROCESSING)
              .andWhere("lease_expires_at", "<=", now)
          })
      })
      .whereColumn("attempt_count", "<", "max_attempts")
      .orderBy("created_at", "asc")
      .limit(take)
      .forUpdate()
      .skipLocked()
    const claimed: AnyRecord[] = []
    for (const candidate of candidates) {
      const operation = await this.retrieveFulfillmentOperation(
        candidate.id,
        {},
        sharedContext,
      )
      const changed = await this.updateFulfillmentOperations(
        {
          id: operation.id,
          state: FulfillmentOperationState.PROCESSING,
          lease_owner: worker,
          lease_expires_at: new Date(now.getTime() + lease * 1000),
          attempt_count: Number(operation.attempt_count) + 1,
          last_attempt_at: now,
        },
        sharedContext,
      )
      claimed.push(changed)
    }
    return claimed
  }

  @InjectManager()
  async claimNotificationDelivery(
    deliveryId: string,
    workerId: string,
    options: {
      lease_seconds?: number
      expected_lease_owner?: string
    } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord | null> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.claimNotificationDelivery(
            deliveryId,
            workerId,
            options,
            transactionContext,
          ),
        sharedContext,
      )
    }

    const id = bounded(deliveryId, "notification delivery id", 255)
    const worker = bounded(workerId, "worker id", 255)
    const lease = positiveInteger(options.lease_seconds ?? 120, "lease seconds", {
      max: 3600,
    })
    const expectedLeaseOwner = options.expected_lease_owner
      ? bounded(options.expected_lease_owner, "expected lease owner", 255)
      : undefined
    const now = new Date()
    const knex = this.transactionKnex_(sharedContext)
    const current = await knex("notification_delivery")
      .select([
        "id",
        "state",
        "attempt_count",
        "max_attempts",
        "next_retry_at",
        "lease_owner",
        "lease_expires_at",
      ])
      .where({ id })
      .whereNull("deleted_at")
      .forUpdate()
      .first()

    if (!current) return null
    if (
      [
        NotificationDeliveryState.SENT,
        NotificationDeliveryState.CANCELED,
        NotificationDeliveryState.DEAD_LETTER,
      ].includes(current.state)
    ) {
      return null
    }

    // A retry job claims a batch before processing it. Only that lease owner may
    // consume an unexpired PROCESSING row, and reusing the lease must not count
    // as a second delivery attempt.
    if (
      current.state === NotificationDeliveryState.PROCESSING &&
      expectedLeaseOwner &&
      current.lease_owner === expectedLeaseOwner
    ) {
      return this.updateNotificationDeliveries(
        {
          id,
          lease_owner: worker,
          lease_expires_at: new Date(now.getTime() + lease * 1000),
        },
        sharedContext,
      )
    }

    if (current.state === NotificationDeliveryState.PROCESSING) {
      const expiresAt = current.lease_expires_at
        ? new Date(current.lease_expires_at).getTime()
        : Number.POSITIVE_INFINITY
      if (expiresAt > now.getTime()) return null
    }

    const attemptCount = Number(current.attempt_count ?? 0)
    const maxAttempts = Number(current.max_attempts ?? 8)
    if (attemptCount >= maxAttempts) {
      await this.updateNotificationDeliveries(
        {
          id,
          state: NotificationDeliveryState.DEAD_LETTER,
          lease_owner: null,
          lease_expires_at: null,
          next_retry_at: null,
        },
        sharedContext,
      )
      return null
    }

    if (
      current.state !== NotificationDeliveryState.PROCESSING &&
      [
        NotificationDeliveryState.PENDING,
        NotificationDeliveryState.FAILED,
      ].includes(current.state)
    ) {
      const retryAt = current.next_retry_at
        ? new Date(current.next_retry_at).getTime()
        : 0
      if (retryAt > now.getTime()) return null
    } else if (current.state !== NotificationDeliveryState.PROCESSING) {
      return null
    }

    return this.updateNotificationDeliveries(
      {
        id,
        state: NotificationDeliveryState.PROCESSING,
        attempt_count: attemptCount + 1,
        lease_owner: worker,
        lease_expires_at: new Date(now.getTime() + lease * 1000),
        last_attempt_at: now,
      },
      sharedContext,
    )
  }

  @InjectManager()
  async claimNotificationDeliveries(
    workerId: string,
    limit = 25,
    leaseSeconds = 60,
    @MedusaContext() sharedContext: Context = {},
  ): Promise<AnyRecord[]> {
    if (!(sharedContext as AnyRecord).transactionManager) {
      return this.inTransaction_(
        (transactionContext) =>
          this.claimNotificationDeliveries(
            workerId,
            limit,
            leaseSeconds,
            transactionContext,
          ),
        sharedContext,
      )
    }
    const worker = bounded(workerId, "worker id", 255)
    const take = positiveInteger(limit, "limit", { max: 100 })
    const lease = positiveInteger(leaseSeconds, "lease seconds", { max: 3600 })
    const now = new Date()
    const knex = this.transactionKnex_(sharedContext)
    const maxed = await knex("notification_delivery")
      .select("id")
      .whereNull("deleted_at")
      .andWhere((eligible: AnyRecord) => {
        eligible
          .where((retryable: AnyRecord) => {
            retryable
              .whereIn("state", [
                NotificationDeliveryState.PENDING,
                NotificationDeliveryState.FAILED,
              ])
              .andWhere((retryDue: AnyRecord) => {
                retryDue
                  .whereNull("next_retry_at")
                  .orWhere("next_retry_at", "<=", now)
              })
          })
          .orWhere((expiredLease: AnyRecord) => {
            expiredLease
              .where("state", NotificationDeliveryState.PROCESSING)
              .andWhere("lease_expires_at", "<=", now)
          })
      })
      .whereColumn("attempt_count", ">=", "max_attempts")
      .orderBy("created_at", "asc")
      .limit(100)
      .forUpdate()
      .skipLocked()
    if (maxed.length) {
      await this.updateNotificationDeliveries(
        maxed.map(({ id }: AnyRecord) => ({
          id,
          state: NotificationDeliveryState.DEAD_LETTER,
          lease_owner: null,
          lease_expires_at: null,
        })),
        sharedContext,
      )
    }
    const candidates = await knex("notification_delivery")
      .select("id")
      .whereNull("deleted_at")
      .andWhere((eligible: AnyRecord) => {
        eligible
          .where((retryable: AnyRecord) => {
            retryable
              .whereIn("state", [
                NotificationDeliveryState.PENDING,
                NotificationDeliveryState.FAILED,
              ])
              .andWhere((retryDue: AnyRecord) => {
                retryDue
                  .whereNull("next_retry_at")
                  .orWhere("next_retry_at", "<=", now)
              })
          })
          .orWhere((expiredLease: AnyRecord) => {
            expiredLease
              .where("state", NotificationDeliveryState.PROCESSING)
              .andWhere("lease_expires_at", "<=", now)
          })
      })
      .whereColumn("attempt_count", "<", "max_attempts")
      .orderBy("created_at", "asc")
      .limit(take)
      .forUpdate()
      .skipLocked()
    const claimed: AnyRecord[] = []
    for (const candidate of candidates) {
      const delivery = await this.retrieveNotificationDelivery(
        candidate.id,
        {},
        sharedContext,
      )
      const changed = await this.updateNotificationDeliveries(
        {
          id: delivery.id,
          state: NotificationDeliveryState.PROCESSING,
          lease_owner: worker,
          lease_expires_at: new Date(now.getTime() + lease * 1000),
          attempt_count: Number(delivery.attempt_count) + 1,
          last_attempt_at: now,
        },
        sharedContext,
      )
      claimed.push(changed)
    }
    return claimed
  }

  @InjectManager()
  async getDigitalDownloadsReport(
    input: {
      from?: Date | string
      to?: Date | string
      product_config_id?: string
    } = {},
    @MedusaContext() sharedContext: Context = {},
  ): Promise<{
    product_configs: number
    active_product_configs: number
    assets: number
    storage_bytes: number
    active_entitlements: number
    downloads_30d: number
    revoked_entitlements: number
  }> {
    const to = parseDate(input.to, "to") ?? new Date()
    const from =
      parseDate(input.from, "from") ??
      new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
    if (from >= to) invalid("from must be earlier than to")
    const productId = input.product_config_id
      ? bounded(input.product_config_id, "product_config_id", 255)
      : undefined

    return this.inTransaction_(async (transactionContext) => {
      const knex = this.transactionKnex_(transactionContext)
      const productBase = () => {
        const query = knex("digital_product").whereNull("deleted_at")
        if (productId) query.where("id", productId)
        return query
      }
      const assetBase = () => {
        const query = knex("digital_asset as asset").whereNull(
          "asset.deleted_at",
        )
        if (productId) {
          query
            .join(
            "digital_product_release as release",
            "release.id",
            "asset.release_id",
          )
            .whereNull("release.deleted_at")
            .where("release.digital_product_id", productId)
        }
        return query
      }
      const entitlementBase = () => {
        const query = knex("digital_entitlement").whereNull("deleted_at")
        if (productId) query.where("digital_product_id", productId)
        return query
      }
      const downloadBase = () => {
        const query = knex("download_event as event")
          .join(
            "digital_entitlement as entitlement",
            "entitlement.id",
            "event.entitlement_id",
          )
          .whereNull("event.deleted_at")
          .whereNull("entitlement.deleted_at")
          .where("event.success", true)
          .whereIn("event.event_type", [
            DownloadEventType.TRANSFER_COMPLETED,
            DownloadEventType.DOWNLOADED,
            DownloadEventType.STREAMED,
          ])
          .where("event.occurred_at", ">=", from)
          .where("event.occurred_at", "<", to)
        if (productId) query.where("entitlement.digital_product_id", productId)
        return query
      }
      const [
        products,
        activeProducts,
        assetStats,
        activeEntitlements,
        revokedEntitlements,
        downloads,
      ] = await Promise.all([
        productBase().count({ count: "id" }).first(),
        productBase()
          .where("status", DigitalProductStatus.ACTIVE)
          .count({ count: "id" })
          .first(),
        assetBase()
          .count({ count: "asset.id" })
          .sum({ storage_bytes: "asset.size_bytes" })
          .first(),
        entitlementBase()
          .where("status", DigitalEntitlementStatus.ACTIVE)
          .count({ count: "id" })
          .first(),
        entitlementBase()
          .whereIn("status", [
            DigitalEntitlementStatus.REVOKED,
            DigitalEntitlementStatus.REFUNDED,
          ])
          .count({ count: "id" })
          .first(),
        downloadBase().count({ count: "event.id" }).first(),
      ])
      return {
        product_configs: Number(products?.count ?? 0),
        active_product_configs: Number(activeProducts?.count ?? 0),
        assets: Number(assetStats?.count ?? 0),
        storage_bytes: Number(assetStats?.storage_bytes ?? 0),
        active_entitlements: Number(activeEntitlements?.count ?? 0),
        downloads_30d: Number(downloads?.count ?? 0),
        revoked_entitlements: Number(revokedEntitlements?.count ?? 0),
      }
    }, sharedContext)
  }

  @InjectManager()
  async getDigitalDownloadsSummary(
    input: Parameters<DigitalDownloadsModuleService["getDigitalDownloadsReport"]>[0] = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.getDigitalDownloadsReport(input, sharedContext)
  }

  @InjectManager()
  async getReportingSummary(
    input: Parameters<DigitalDownloadsModuleService["getDigitalDownloadsReport"]>[0] = {},
    @MedusaContext() sharedContext: Context = {},
  ) {
    return this.getDigitalDownloadsReport(input, sharedContext)
  }

  async recipientHash(recipient: string): Promise<string> {
    return normalizeAndFingerprint(
      normalizeEmail(recipient) ?? invalid("recipient is required"),
      this.options_.tokenSecret,
      "recipient",
    ) as string
  }
}

export type { DigitalDownloadsModuleOptions }
