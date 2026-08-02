import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"

import {
  createDigitalProductReleaseWorkflow,
  createDigitalProductWorkflow,
  deleteDigitalProductReleaseWorkflow,
  deleteDigitalProductWorkflow,
  issueOrderEntitlementsWorkflow,
  publishDigitalProductReleaseWorkflow,
  reissueEntitlementWorkflow,
  revokeEntitlementWorkflow,
  updateDigitalProductReleaseWorkflow,
  updateDigitalProductWorkflow,
} from "../../workflows/index.js"

import { PRIVATE_NO_STORE_HEADERS } from "./constants.js"
import { conflict, unprocessable } from "./errors.js"
import {
  adminEntitlement,
  adminEntitlements,
  adminProductConfig,
  adminProductConfigs,
  adminRelease,
  safeAdmin,
} from "./projections.js"
import {
  actorContext,
  filtersWithoutPagination,
  invokeService,
  listService,
  resolveDigitalDownloadsService,
  retrieveService,
  unwrapResult,
} from "./service.js"
import {
  AssetInputSchema,
  AssetPatchSchema,
  AssetQuerySchema,
  AuditEventQuerySchema,
  DownloadEventQuerySchema,
  EntitlementQuerySchema,
  LicenseKeyImportSchema,
  LicensePolicyKeyQuerySchema,
  LicensePolicyInputSchema,
  LicensePolicyPatchSchema,
  LicensePolicyQuerySchema,
  ProductConfigInputSchema,
  ProductConfigPatchSchema,
  ProductConfigQuerySchema,
  PublishReleaseSchema,
  ReleaseInputSchema,
  ReleasePatchSchema,
  ReleaseQuerySchema,
  ReissueEntitlementSchema,
  ReportQuerySchema,
  RevokeEntitlementSchema,
  SettingsPatchSchema,
  StorageTestSchema,
  UploadCompleteSchema,
  UploadCapabilitySchema,
  UploadInputSchema,
  bodyOf,
  parseId,
  queryOf,
} from "./validators.js"

function pageQuery(value: { limit: number; offset: number; order?: string }) {
  return { limit: value.limit, offset: value.offset, order: value.order }
}

async function linkedDigitalProductIds(
  req: MedusaRequest,
  filters: { product_id?: string; variant_id?: string },
): Promise<string[] | undefined> {
  if (!filters.product_id && !filters.variant_id) return undefined

  let variantIds: string[]
  if (filters.product_id) {
    const productService = req.scope.resolve(Modules.PRODUCT) as unknown as {
      listProductVariants: (
        filters: Record<string, unknown>,
        config?: Record<string, unknown>,
      ) => Promise<Array<Record<string, unknown>>>
    }
    const variants = await productService.listProductVariants(
      {
        product_id: filters.product_id,
        ...(filters.variant_id ? { id: filters.variant_id } : {}),
      },
      { select: ["id"], take: 10_000 },
    )
    variantIds = variants
      .map((variant) => variant.id)
      .filter((id): id is string => typeof id === "string")
  } else {
    variantIds = [filters.variant_id as string]
  }
  if (!variantIds.length) return []

  const link = req.scope.resolve(ContainerRegistrationKeys.LINK) as {
    getLinkModule: (...args: unknown[]) => {
      list: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>
    }
  }
  const linkService = link.getLinkModule(
    Modules.PRODUCT,
    "product_variant_id",
    "digitalDownloads",
    "digital_product_id",
  )
  const links = await linkService.list(
    { product_variant_id: variantIds },
    { take: 10_000 },
  )
  return [
    ...new Set(
      links
        .map((entry) => entry.digital_product_id)
        .filter((id): id is string => typeof id === "string"),
    ),
  ]
}

async function releaseIdsForDigitalProduct(
  service: Record<string, unknown>,
  digitalProductId: string,
): Promise<string[]> {
  const releases = await invokeService<unknown>(
    service,
    ["listDigitalProductReleases"],
    { digital_product_id: digitalProductId },
    { take: 10_000, select: ["id"] },
  )
  const rows = Array.isArray(releases) ? releases : []
  return rows
    .map((release) => objectValue(release).id)
    .filter((id): id is string => typeof id === "string")
}

function emptyPage(
  res: MedusaResponse,
  key: string,
  query: { limit: number; offset: number },
): void {
  res.json({ [key]: [], count: 0, limit: query.limit, offset: query.offset })
}

function occurredAtFilter(from?: string, to?: string): Record<string, unknown> | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { $gte: new Date(from) } : {}),
    ...(to ? { $lte: new Date(to) } : {}),
  }
}

function entityResult(value: unknown, keys: string[]) {
  return safeAdmin(unwrapResult(value, keys))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

const SAFE_READINESS_ISSUES = new Set([
  "token_secret_missing",
  "encryption_key_missing",
  "local_signing_secret_missing",
])

function safeReadinessIssues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (issue): issue is string =>
          typeof issue === "string" && SAFE_READINESS_ISSUES.has(issue),
      )
    : []
}

async function runtimeSettingsProjection(
  service: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const options = objectValue(service.options_)
  const storage = objectValue(options.storage)
  const local = objectValue(storage.local)
  const s3 = objectValue(storage.s3)
  const readiness = objectValue(
    await invokeService(service, ["getReadinessDiagnostics"]),
  )
  const provider =
    readiness.provider === "s3" ||
    storage.defaultProvider === "s3" ||
    storage.default_provider === "s3"
      ? "s3"
      : "local"
  return {
    storage: {
      provider,
      configured:
        provider === "s3"
          ? Boolean(s3.bucket && s3.accessKeyId && s3.secretAccessKey)
          : Boolean(
              (local.rootPath ?? local.root_path) &&
                (local.signingSecret ?? local.signing_secret),
            ),
    },
    allowed_mime_types: Array.isArray(options.allowedMimeTypes)
      ? options.allowedMimeTypes
      : [],
    enable_streaming: true,
    default_expiry_days: null,
    readiness: {
      ready: readiness.ready === true,
      issues: safeReadinessIssues(readiness.issues),
      token_secret_configured: Boolean(options.tokenSecret),
      encryption_key_configured: Boolean(options.encryptionKey),
      local_signing_secret_configured: Boolean(local.signingSecret),
    },
  }
}

const SETTINGS_TOPOLOGY_KEY =
  /^(?:local_(?:base_url|upload_path|root_path)|root_?path|base_?url|s3_(?:bucket|region|endpoint|prefix|force_path_style|credentials_configured)|bucket|region|endpoint|prefix|force_?path_?style|access_?key_?id|secret_?access_?key|session_?token)$/i

function withoutSettingsTopology(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSettingsTopology)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SETTINGS_TOPOLOGY_KEY.test(key))
      .map(([key, child]) => [key, withoutSettingsTopology(child)]),
  )
}

function adminSettingsProjection(
  value: unknown,
  runtime: Record<string, unknown>,
) {
  const source = objectValue(value)
  const settings: Record<string, unknown> = {}
  for (const key of [
    "id",
    "singleton_key",
    "enabled",
    "default_delivery_type",
    "default_download_limit",
    "default_grant_ttl_seconds",
    "max_grant_ttl_seconds",
    "max_upload_size_bytes",
    "allow_guest_access",
    "require_order_email_match",
    "event_retention_days",
    "storage_namespace_version",
    "metadata",
    "created_at",
    "updated_at",
  ] as const) {
    if (source[key] !== undefined) settings[key] = source[key]
  }
  settings.signed_url_ttl_seconds = source.default_grant_ttl_seconds
  const uploadBytes = Number(source.max_upload_size_bytes)
  if (Number.isFinite(uploadBytes)) {
    settings.max_upload_size_bytes = uploadBytes
    settings.max_upload_size_mb = uploadBytes / (1024 * 1024)
  }
  settings.audit_retention_days = source.event_retention_days
  return withoutSettingsTopology(safeAdmin({ ...settings, ...runtime }))
}

function storageTestProjection(value: unknown): Record<string, unknown> {
  const source = objectValue(value)
  const projection: Record<string, unknown> = {
    ready: source.ready === true,
    provider: source.provider === "s3" ? "s3" : "local",
    operation:
      source.operation === "write_read_delete" ? "write_read_delete" : "health",
  }
  if (typeof source.ok === "boolean") projection.ok = source.ok
  const issues = safeReadinessIssues(source.issues)
  if (issues.length) projection.issues = issues
  if (
    typeof source.latency_ms === "number" &&
    Number.isFinite(source.latency_ms) &&
    source.latency_ms >= 0
  ) {
    projection.latency_ms = source.latency_ms
  }
  return projection
}

export async function getSettings(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const settings = await invokeService(service, [
    "getSettings",
    "getDigitalDownloadsSettings",
    "retrieveDigitalDownloadsSettings",
    "listDigitalDownloadsSettings",
  ])
  const resolved = Array.isArray(settings) ? settings[0] : settings
  const runtime = await runtimeSettingsProjection(service)
  res
    .set(PRIVATE_NO_STORE_HEADERS)
    .json({ settings: adminSettingsProjection(resolved ?? {}, runtime) })
}

export async function patchSettings(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, SettingsPatchSchema)
  const normalized: Record<string, unknown> = {}
  for (const key of [
    "enabled",
    "default_delivery_type",
    "allow_guest_access",
    "require_order_email_match",
    "metadata",
  ] as const) {
    if (input[key] !== undefined) normalized[key] = input[key]
  }
  const downloadLimit =
    input.default_download_limit !== undefined
      ? input.default_download_limit
      : input.download_limit_default
  if (downloadLimit !== undefined) {
    normalized.default_download_limit = downloadLimit
  }
  const grantTtl =
    input.default_grant_ttl_seconds ??
    input.signed_url_ttl_seconds ??
    input.grant_ttl_seconds
  if (grantTtl !== undefined) normalized.default_grant_ttl_seconds = grantTtl
  if (input.max_grant_ttl_seconds !== undefined) {
    normalized.max_grant_ttl_seconds = input.max_grant_ttl_seconds
  }
  const maxUploadBytes =
    input.max_upload_size_bytes ??
    input.max_upload_bytes ??
    (input.max_upload_size_mb !== undefined
      ? Math.round(input.max_upload_size_mb * 1024 * 1024)
      : undefined)
  if (maxUploadBytes !== undefined) {
    normalized.max_upload_size_bytes = maxUploadBytes
  }
  const retentionDays =
    input.event_retention_days ?? input.audit_retention_days
  if (retentionDays !== undefined) {
    normalized.event_retention_days = retentionDays
  }
  const result = await invokeService(service, [
    "updateSettings",
    "updateDigitalDownloadsSettings",
    "upsertDigitalDownloadsSettings",
  ], normalized, actorContext(req))
  const runtime = await runtimeSettingsProjection(service)
  res
    .set(PRIVATE_NO_STORE_HEADERS)
    .json({
      settings: adminSettingsProjection(
        unwrapResult(result, ["settings"]),
        runtime,
      ),
    })
}

export async function testStorage(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, StorageTestSchema)
  const result = await invokeService(service, [
    "testStorage",
    "testStorageProvider",
    "healthCheckStorage",
  ], { ...input, ...actorContext(req) })
  res
    .set(PRIVATE_NO_STORE_HEADERS)
    .json({ storage_test: storageTestProjection(result) })
}

export async function listProductConfigs(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, ProductConfigQuerySchema)
  const filters = filtersWithoutPagination(query)
  const productId = filters.product_id as string | undefined
  const variantId = filters.variant_id as string | undefined
  delete filters.product_id
  delete filters.variant_id
  const linkedIds = await linkedDigitalProductIds(req, {
    product_id: productId,
    variant_id: variantId,
  })
  if (linkedIds && !linkedIds.length) {
    emptyPage(res, "product_configs", query)
    return
  }
  if (linkedIds) filters.id = linkedIds
  const page = await listService(
    service,
    [
      "listAndCountDigitalProducts",
      "listDigitalProductConfigs",
      "listDigitalProducts",
    ],
    filters,
    pageQuery(query),
    ["releases", "releases.assets", "license_policy"],
  )
  res.json({
    product_configs: adminProductConfigs(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function createProductConfig(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const input = bodyOf(req, ProductConfigInputSchema)
  const { result } = await createDigitalProductWorkflow(req.scope).run({
    input,
  })
  res.status(201).json({
    product_config: adminProductConfig(
      unwrapResult(result, ["product_config", "digital_product"]),
    ),
  })
}

export async function getProductConfig(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const result = await retrieveService(
    service,
    ["retrieveDigitalProductConfig", "retrieveDigitalProduct"],
    id,
    [
      "releases",
      "releases.assets",
      "license_policy",
    ],
  )
  res.json({ product_config: adminProductConfig(result) })
}

export async function patchProductConfig(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const id = parseId(req.params.id)
  const patch = bodyOf(req, ProductConfigPatchSchema)
  const { result } = await updateDigitalProductWorkflow(req.scope).run({
    input: { id, ...patch },
  })
  res.json({
    product_config: adminProductConfig(
      unwrapResult(result, ["product_config", "digital_product"]),
    ),
  })
}

export async function deleteProductConfig(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const id = parseId(req.params.id)
  await deleteDigitalProductWorkflow(req.scope).run({ input: { id } })
  res.json({ id, object: "digital_product_config", deleted: true })
}

export async function listReleases(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, ReleaseQuerySchema)
  const filters = filtersWithoutPagination(query)
  if (filters.product_config_id !== undefined) {
    filters.digital_product_id = filters.product_config_id
    delete filters.product_config_id
  }
  const page = await listService(
    service,
    [
      "listAndCountDigitalProductReleases",
      "listDigitalProductReleases",
      "listDigitalReleases",
    ],
    filters,
    pageQuery(query),
    ["assets"],
  )
  res.json({
    releases: page.items.map(adminRelease),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function createRelease(req: MedusaRequest, res: MedusaResponse) {
  const input = bodyOf(req, ReleaseInputSchema)
  const { result } = await createDigitalProductReleaseWorkflow(req.scope).run({
    input: {
      digital_product_id: input.product_config_id,
      asset_ids: input.asset_ids,
      data: {
        version: input.version,
        title: input.title,
        release_notes: input.notes,
        status: input.status,
        available_from: input.publish_at,
        metadata: input.metadata,
      },
    },
  })
  res.status(201).json({ release: adminRelease(result) })
}

export async function getRelease(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const result = await retrieveService(
    service,
    ["retrieveDigitalProductRelease", "retrieveDigitalRelease"],
    parseId(req.params.id),
    ["assets", "product_config"],
  )
  res.json({ release: adminRelease(result) })
}

export async function patchRelease(req: MedusaRequest, res: MedusaResponse) {
  const id = parseId(req.params.id)
  const service = resolveDigitalDownloadsService(req)
  const existing = await retrieveService<Record<string, unknown>>(
    service,
    ["retrieveDigitalProductRelease", "retrieveDigitalRelease"],
    id,
  )
  if (existing.status === "published") {
    throw conflict("Published releases are immutable.")
  }
  const patch = bodyOf(req, ReleasePatchSchema)
  const { result } = await updateDigitalProductReleaseWorkflow(req.scope).run({
    input: {
      id,
      ...(patch.asset_ids !== undefined ? { asset_ids: patch.asset_ids } : {}),
      data: {
        ...(patch.version !== undefined ? { version: patch.version } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.notes !== undefined ? { release_notes: patch.notes } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.publish_at !== undefined
          ? { available_from: patch.publish_at }
          : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      },
    },
  })
  res.json({ release: adminRelease(result) })
}

export async function deleteRelease(req: MedusaRequest, res: MedusaResponse) {
  const id = parseId(req.params.id)
  const service = resolveDigitalDownloadsService(req)
  const existing = await retrieveService<Record<string, unknown>>(
    service,
    ["retrieveDigitalProductRelease", "retrieveDigitalRelease"],
    id,
  )
  if (existing.status === "published" || existing.is_current === true) {
    throw conflict("Published or current releases cannot be deleted.")
  }
  await deleteDigitalProductReleaseWorkflow(req.scope).run({ input: { id } })
  res.json({ id, object: "digital_product_release", deleted: true })
}

export async function publishRelease(req: MedusaRequest, res: MedusaResponse) {
  const id = parseId(req.params.id)
  const input = bodyOf(req, PublishReleaseSchema)
  const { result } = await publishDigitalProductReleaseWorkflow(req.scope).run({
    input: {
      id,
      make_active: input.make_active,
      notify_existing_customers: input.notify_existing_customers,
    },
  })
  res.json({ release: adminRelease(unwrapResult(result, ["release"])) })
}

export async function listAssets(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, AssetQuerySchema)
  const filters = filtersWithoutPagination(query)
  const productConfigId = filters.product_config_id as string | undefined
  delete filters.product_config_id
  if (productConfigId) {
    const releaseIds = await releaseIdsForDigitalProduct(
      service,
      productConfigId,
    )
    if (
      !releaseIds.length ||
      (typeof filters.release_id === "string" &&
        !releaseIds.includes(filters.release_id))
    ) {
      emptyPage(res, "assets", query)
      return
    }
    if (filters.release_id === undefined) filters.release_id = releaseIds
  }
  const page = await listService(
    service,
    ["listAndCountDigitalAssets", "listDigitalAssets"],
    filters,
    pageQuery(query),
    ["release"],
  )
  res.json({
    assets: safeAdmin(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function createAsset(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, AssetInputSchema)
  const result = await invokeService(service, [
    "createDigitalAssets",
    "createDigitalAsset",
  ], input, actorContext(req))
  res.status(201).json({ asset: entityResult(result, ["asset"]) })
}

export async function getAsset(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const result = await retrieveService(
    service,
    ["retrieveDigitalAsset"],
    parseId(req.params.id),
    ["release"],
  )
  res.json({ asset: safeAdmin(result) })
}

export async function patchAsset(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const existing = await retrieveService<Record<string, unknown>>(
    service,
    ["retrieveDigitalAsset"],
    id,
    ["release"],
  )
  if ((existing.release as Record<string, unknown> | undefined)?.status === "published") {
    throw conflict("Assets in a published release are immutable.")
  }
  const patch = bodyOf(req, AssetPatchSchema)
  const metadata = {
    ...(patch.metadata ?? {}),
    ...(patch.platform !== undefined ? { platform: patch.platform } : {}),
    ...(patch.architecture !== undefined
      ? { architecture: patch.architecture }
      : {}),
  }
  const result = await invokeService(service, [
    "updateDigitalAssets",
    "updateDigitalAsset",
  ], {
    id,
    ...(patch.release_id !== undefined ? { release_id: patch.release_id } : {}),
    ...(patch.display_name !== undefined ? { name: patch.display_name } : {}),
    ...(patch.filename !== undefined
      ? { original_filename: patch.filename }
      : {}),
    ...(patch.mime_type !== undefined ? { mime_type: patch.mime_type } : {}),
    ...(patch.role !== undefined ? { role: patch.role } : {}),
    ...(patch.sort_order !== undefined ? { sort_order: patch.sort_order } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  })
  res.json({ asset: entityResult(result, ["asset"]) })
}

export async function deleteAsset(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const existing = await retrieveService<Record<string, unknown>>(
    service,
    ["retrieveDigitalAsset"],
    id,
    ["release"],
  )
  if ((existing.release as Record<string, unknown> | undefined)?.status === "published") {
    throw conflict("Assets in a published release are immutable.")
  }
  await invokeService(service, ["updateDigitalAssets", "updateDigitalAsset"], {
    id,
    status: "retired",
    is_enabled: false,
  })
  res.json({ id, object: "digital_asset", deleted: true, retired: true })
}

export async function createUpload(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = UploadInputSchema.parse(req.body)
  const result = await invokeService(service, [
    "initiateDigitalAssetUpload",
    "createDigitalUpload",
    "initiateUpload",
  ], input, actorContext(req))
  res
    .status(201)
    .set(PRIVATE_NO_STORE_HEADERS)
    .json({ upload: safeAdmin(unwrapResult(result, ["upload"])) })
}

export async function receiveUpload(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const uploadToken = UploadCapabilitySchema.parse(
    req.get("x-digital-upload-token"),
  )
  const contentLength = Number(req.get("content-length"))
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > 5 * 1024 * 1024 * 1024
  ) {
    const error = new Error(
      "Content-Length is required and must not exceed 5 GiB.",
    ) as Error & { status?: number; code?: string }
    error.status = 413
    error.code = "invalid_upload_size"
    throw error
  }
  const contentType = req.get("content-type")?.trim()
  if (!contentType || /[\r\n]/.test(contentType)) {
    const error = new Error("A valid Content-Type is required.") as Error & {
      status?: number
      code?: string
    }
    error.status = 400
    error.code = "invalid_content_type"
    throw error
  }
  const result = await invokeService(service, [
    "receiveDigitalAssetUpload",
  ], id, {
    stream: req,
    content_length: contentLength,
    content_type: contentType,
    upload_token: uploadToken,
    ...actorContext(req),
  })
  res
    .status(202)
    .set(PRIVATE_NO_STORE_HEADERS)
    .json({ upload: safeAdmin(unwrapResult(result, ["upload"])) })
}

export async function completeUpload(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const input = bodyOf(req, UploadCompleteSchema)
  const result = await invokeService(service, [
    "completeDigitalAssetUpload",
    "completeDigitalUpload",
    "completeUpload",
  ], id, input, actorContext(req))
  res.status(201).json({ asset: entityResult(result, ["asset"]) })
}

export async function listLicensePolicies(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, LicensePolicyQuerySchema)
  const page = await listService(
    service,
    ["listAndCountLicensePolicies", "listLicensePolicies"],
    filtersWithoutPagination(query),
    pageQuery(query),
    ["digital_product", "pool_keys"],
  )
  res.json({
    license_policies: safeAdmin(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function createLicensePolicy(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, LicensePolicyInputSchema)
  const result = await invokeService(service, [
    "createLicensePolicies",
    "createLicensePolicy",
  ], input, actorContext(req))
  res.status(201).json({ license_policy: entityResult(result, ["license_policy"]) })
}

export async function getLicensePolicy(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const result = await retrieveService(
    service,
    ["retrieveLicensePolicy"],
    parseId(req.params.id),
    ["digital_product", "pool_keys"],
  )
  res.json({ license_policy: safeAdmin(result) })
}

export async function patchLicensePolicy(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  const patch = bodyOf(req, LicensePolicyPatchSchema)
  const result = await invokeService(service, [
    "updateLicensePolicies",
    "updateLicensePolicy",
  ], { id, ...patch }, actorContext(req))
  res.json({ license_policy: entityResult(result, ["license_policy"]) })
}

export async function deleteLicensePolicy(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const id = parseId(req.params.id)
  await invokeService(service, ["deleteLicensePolicies", "deleteLicensePolicy"], [id], actorContext(req))
  res.json({ id, object: "license_policy", deleted: true })
}

export async function importLicenseKeys(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const policyId = parseId(req.params.id)
  const input = bodyOf(req, LicenseKeyImportSchema)
  const result = await invokeService(service, [
    "importLicenseKeys",
  ], {
    license_policy_id: policyId,
    keys: input.keys,
    duplicate_policy: input.duplicate_policy,
    ...actorContext(req),
  })
  const imported = Array.isArray(result) ? result.length : 0
  res.status(201).set(PRIVATE_NO_STORE_HEADERS).json({
    import: {
      imported,
      duplicate_policy: input.duplicate_policy,
    },
  })
}

export async function listLicensePolicyKeys(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const policyId = parseId(req.params.id)
  const query = queryOf(req, LicensePolicyKeyQuerySchema)
  const page = await listService(
    service,
    ["listAndCountLicensePoolKeys", "listLicensePoolKeySummaries"],
    {
      ...filtersWithoutPagination(query),
      license_policy_id: policyId,
    },
    pageQuery(query),
  )
  res.set(PRIVATE_NO_STORE_HEADERS).json({
    keys: safeAdmin(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function listEntitlements(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, EntitlementQuerySchema)
  const filters = filtersWithoutPagination(query)
  const q = filters.q
  delete filters.q
  if (filters.line_item_id !== undefined) {
    filters.order_line_item_id = filters.line_item_id
    delete filters.line_item_id
  }
  const productConfigId = filters.product_config_id as string | undefined
  const productId = filters.product_id as string | undefined
  const variantId = filters.variant_id as string | undefined
  delete filters.product_config_id
  delete filters.product_id
  delete filters.variant_id
  const linkedIds = await linkedDigitalProductIds(req, {
    product_id: productId,
    variant_id: variantId,
  })
  if (linkedIds && !linkedIds.length) {
    emptyPage(res, "entitlements", query)
    return
  }
  if (productConfigId && linkedIds && !linkedIds.includes(productConfigId)) {
    emptyPage(res, "entitlements", query)
    return
  }
  if (productConfigId) {
    filters.digital_product_id = productConfigId
  } else if (linkedIds) {
    filters.digital_product_id = linkedIds
  }
  const relations = [
    "release",
    "release.assets",
    "license_assignments",
    "license_assignments.activations",
  ]
  if (typeof q === "string") {
    const scan = await listService(
      service,
      ["listAndCountDigitalEntitlements", "listDigitalEntitlements"],
      filters,
      { limit: 10_001, offset: 0, order: query.order },
      relations,
    )
    if (scan.count > 10_000) {
      throw unprocessable(
        "Search is too broad. Add a product, status, order, or customer filter.",
      )
    }
    const needle = q.toLowerCase()
    const matches = adminEntitlements(scan.items).filter((entitlement) =>
      [
        entitlement.id,
        entitlement.order_id,
        entitlement.customer_email,
        entitlement.customer_name,
        entitlement.title,
        entitlement.product_title,
        entitlement.variant_title,
      ].some(
        (entry) =>
          typeof entry === "string" && entry.toLowerCase().includes(needle),
      ),
    )
    res.json({
      entitlements: matches.slice(query.offset, query.offset + query.limit),
      count: matches.length,
      limit: query.limit,
      offset: query.offset,
    })
    return
  }
  const page = await listService(
    service,
    ["listAndCountDigitalEntitlements", "listDigitalEntitlements"],
    filters,
    pageQuery(query),
    relations,
  )
  res.json({
    entitlements: adminEntitlements(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function getEntitlement(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const result = await retrieveService(
    service,
    ["retrieveDigitalEntitlement"],
    parseId(req.params.id),
    [
      "release",
      "release.assets",
      "license_assignments",
      "license_assignments.activations",
      "download_events",
    ],
  )
  res.json({ entitlement: adminEntitlement(result) })
}

export async function revokeEntitlement(req: MedusaRequest, res: MedusaResponse) {
  const entitlementId = parseId(req.params.id)
  const input = bodyOf(req, RevokeEntitlementSchema)
  const { result } = await revokeEntitlementWorkflow(req.scope).run({
    input: {
      entitlement_id: entitlementId,
      reason: input.reason,
      actor: String(actorContext(req).actor_id ?? "admin"),
      notify: input.notify,
    },
  })
  res.json({ entitlement: adminEntitlement(unwrapResult(result, ["entitlement"])) })
}

export async function reissueEntitlement(req: MedusaRequest, res: MedusaResponse) {
  const entitlementId = parseId(req.params.id)
  const input = bodyOf(req, ReissueEntitlementSchema)
  const { result } = await reissueEntitlementWorkflow(req.scope).run({
    input: {
      entitlement_id: entitlementId,
      reason: input.reason,
      notify: input.notify,
      reset_downloads: input.reset_downloads,
      rotate_guest_token: input.rotate_guest_token,
    },
  })
  res.set(PRIVATE_NO_STORE_HEADERS).json({
    entitlement: adminEntitlement(unwrapResult(result, ["entitlement"])),
    delivery: safeAdmin(unwrapResult(result, ["delivery"]) ?? {}),
  })
}

export async function issueOrderEntitlements(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const orderId = parseId(req.params.order_id)
  const { result } = await issueOrderEntitlementsWorkflow(req.scope).run({
    input: {
      order_id: orderId,
      force: false,
      source: "manual",
    },
  })
  res.status(202).json({ operation: safeAdmin(result) })
}

export async function listDownloads(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, DownloadEventQuerySchema)
  const filters = filtersWithoutPagination(query)
  const status = filters.status
  delete filters.status
  if (typeof status === "string") {
    filters.event_type = {
      started: "transfer_started",
      completed: "transfer_completed",
      failed: "transfer_failed",
      denied: "denied",
    }[status]
  }
  const from = filters.from as string | undefined
  const to = filters.to as string | undefined
  delete filters.from
  delete filters.to
  const occurredAt = occurredAtFilter(from, to)
  if (occurredAt) filters.occurred_at = occurredAt
  const customerId = filters.customer_id as string | undefined
  delete filters.customer_id
  if (customerId) {
    const entitlements = await invokeService<unknown>(
      service,
      ["listDigitalEntitlements"],
      { customer_id: customerId },
      { take: 10_000, select: ["id"] },
    )
    const entitlementIds = (Array.isArray(entitlements) ? entitlements : [])
      .map((row) => objectValue(row).id)
      .filter((id): id is string => typeof id === "string")
    if (
      !entitlementIds.length ||
      (typeof filters.entitlement_id === "string" &&
        !entitlementIds.includes(filters.entitlement_id))
    ) {
      emptyPage(res, "downloads", query)
      return
    }
    if (filters.entitlement_id === undefined) {
      filters.entitlement_id = entitlementIds
    }
  }
  const page = await listService(
    service,
    [
      "listAndCountDownloadEvents",
      "listDownloadEvents",
      "listDigitalDownloadEvents",
    ],
    filters,
    pageQuery(query),
  )
  res.json({
    downloads: safeAdmin(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function listAuditEvents(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, AuditEventQuerySchema)
  const filters = filtersWithoutPagination(query)
  delete filters.entity_type
  if (typeof filters.action === "string") {
    const actionAliases: Record<string, string> = {
      issued: "key_assigned",
      revealed: "key_revealed",
      activated: "activated",
      deactivated: "deactivated",
      revoked: "revoked",
      validation_failed: "validation_failed",
    }
    filters.action = actionAliases[filters.action]
  }
  if (filters.entity_id !== undefined) {
    if (
      filters.assignment_id !== undefined &&
      filters.assignment_id !== filters.entity_id
    ) {
      emptyPage(res, "audit_events", query)
      return
    }
    filters.assignment_id = filters.entity_id
    delete filters.entity_id
  }
  const from = filters.from as string | undefined
  const to = filters.to as string | undefined
  delete filters.from
  delete filters.to
  const occurredAt = occurredAtFilter(from, to)
  if (occurredAt) filters.occurred_at = occurredAt
  const page = await listService(
    service,
    [
      "listAndCountLicenseAuditEvents",
      "listLicenseAuditEvents",
      "listDigitalAuditEvents",
      "listAuditEvents",
    ],
    filters,
    pageQuery(query),
  )
  res.json({
    audit_events: safeAdmin(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function getReportSummary(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const query = queryOf(req, ReportQuerySchema)
  const result = await invokeService(service, [
    "getDigitalDownloadsReport",
    "getDigitalDownloadsSummary",
    "getReportingSummary",
  ], query)
  res.json({ report: safeAdmin(result) })
}
