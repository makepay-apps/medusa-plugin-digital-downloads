type JsonRecord = Record<string, unknown>

const SENSITIVE_KEY_PATTERN =
  /^(?:(?:raw_|guest_|download_|access_|refresh_|session_|bearer_)?token(?:_hash)?|license_key|key|key_hash|key_ciphertext|normalized_key|encrypted_key|(?:api|encryption|signing|private)_key|secret|(?:access_|signing_|encryption_|client_|api_)?secret(?:_access_key)?|password|credentials|storage_key|storage_bucket|object_key|local_path|absolute_path|origin_url|authorization|nonce|(?:[a-z0-9]+_)*fingerprint|(?:device|ip|user_agent|storage_namespace|token_secret|encryption_key)_hash)$/i

const ADMIN_SECRET_ALLOWLIST = new Set(["key_hint", "masked_key"])
const PUBLIC_PRODUCT_KINDS = new Set([
  "download",
  "ebook",
  "audio",
  "video",
  "image",
  "software",
  "license",
  "bundle",
  "other",
])

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}

function pick(source: unknown, keys: readonly string[]): JsonRecord {
  const value = record(source)
  const result: JsonRecord = {}
  for (const key of keys) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  return result
}

function productKind(value: unknown, mimeType?: unknown): string {
  const kind = typeof value === "string" ? value.toLowerCase() : ""
  if (PUBLIC_PRODUCT_KINDS.has(kind)) return kind
  if (kind === "pdf") return "ebook"
  if (kind === "archive") return "software"
  if (kind === "file") return "download"
  if (kind === "mixed") return "bundle"

  const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : ""
  if (mime === "application/pdf" || /epub|mobi/.test(mime)) return "ebook"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("image/")) return "image"
  if (/zip|tar|gzip|compressed|executable/.test(mime)) return "software"
  return "download"
}

function assetDeliveryTypes(asset: unknown): Array<"download" | "stream"> {
  const source = record(asset)
  const delivery = source.delivery_type ?? source.delivery_mode
  if (delivery === "stream") return ["stream"]
  if (delivery === "mixed") return ["download", "stream"]
  if (source.role === "stream") return ["stream"]
  return ["download"]
}

export function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (!value || typeof value !== "object") return value

  const output: JsonRecord = {}
  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (SENSITIVE_KEY_PATTERN.test(key) && !ADMIN_SECRET_ALLOWLIST.has(key)) {
      continue
    }
    output[key] = stripSecrets(child)
  }
  return output
}

export function safeAdmin<T = unknown>(value: T): T {
  return stripSecrets(value) as T
}

export function publicPreview(asset: unknown): JsonRecord {
  const source = record(asset)
  const id = source.id
  return {
    id,
    kind: productKind(source.kind, source.mime_type),
    title:
      source.title ?? source.display_name ?? source.name ?? "Product preview",
    ...(source.description !== undefined
      ? { description: source.description }
      : {}),
    mime_type: source.mime_type,
    ...(source.size_bytes !== undefined
      ? { size_bytes: source.size_bytes }
      : source.size !== undefined
        ? { size_bytes: source.size }
        : {}),
    ...(typeof source.url === "string"
      ? { url: source.url }
      : typeof source.preview_url === "string"
        ? { url: source.preview_url }
        : typeof id === "string"
          ? {
              url: `/store/digital-downloads/previews/${encodeURIComponent(id)}`,
            }
          : {}),
    ...pick(source, [
      "duration_seconds",
      "width",
      "height",
      "poster_url",
      "alt",
    ]),
  }
}

export function publicProduct(value: unknown): JsonRecord {
  const source = record(value)
  const release = record(source.active_release ?? source.release)
  const allAssets: unknown[] = Array.isArray(source.assets)
    ? source.assets
    : Array.isArray(release.assets)
      ? release.assets
      : []
  const previews = Array.isArray(source.previews)
    ? source.previews.map(publicPreview)
    : allAssets
        .filter((asset) => {
          const role = record(asset).role
          return role === "preview" || role === "cover"
        })
        .map(publicPreview)

  const delivery = source.delivery_type
  const declaredDeliveryTypes = Array.isArray(source.delivery_types)
    ? source.delivery_types.filter(
        (entry): entry is string =>
          entry === "download" || entry === "stream" || entry === "license",
      )
    : []
  const assetDelivery = allAssets.flatMap(assetDeliveryTypes)
  const deliveryTypes = [
    ...new Set(
      declaredDeliveryTypes.length
        ? declaredDeliveryTypes
        : delivery === "mixed"
          ? [...assetDelivery, "license"]
          : delivery === "download" ||
              delivery === "stream" ||
              delivery === "license"
            ? [delivery]
            : assetDelivery,
    ),
  ]
  const representativeAsset =
    allAssets.find((asset) => {
      const role = record(asset).role
      return role !== "preview" && role !== "cover"
    }) ?? allAssets[0]
  const metadata = record(source.metadata)
  const kind = productKind(
    source.kind ??
      metadata.kind ??
      (delivery === "license"
        ? "license"
        : delivery === "mixed"
          ? "bundle"
          : record(representativeAsset).kind),
    record(representativeAsset).mime_type,
  )
  const protectedAssets = allAssets.filter((asset) => {
    const role = record(asset).role
    return role !== "preview" && role !== "cover"
  })
  const totalSize = protectedAssets.reduce<number>((sum, asset) => {
    const item = record(asset)
    const value = Number(item.size_bytes ?? item.size)
    return Number.isFinite(value) && value >= 0 ? sum + value : sum
  }, 0)

  return {
    product_id: source.product_id ?? source.medusa_product_id,
    variant_id: source.variant_id ?? source.medusa_variant_id,
    title: source.title,
    ...(source.variant_title !== undefined
      ? { variant_title: source.variant_title }
      : {}),
    kind,
    delivery_types: deliveryTypes,
    previews,
    file_count: protectedAssets.length,
    total_size_bytes: totalSize,
    ...(source.license_terms !== undefined
      ? { license_terms: safeAdmin(source.license_terms) }
      : {}),
  }
}

function safeActivation(value: unknown): JsonRecord {
  const source = record(value)
  return {
    ...pick(source, [
      "id",
      "status",
      "activated_at",
      "last_seen_at",
      "deactivated_at",
      "expires_at",
    ]),
    ...(source.name !== undefined
      ? { name: source.name }
      : source.device_name !== undefined
        ? { name: source.device_name }
        : {}),
    ...(source.installation_id !== undefined
      ? { installation_id: source.installation_id }
      : {}),
  }
}

function maskedLicense(
  value: unknown,
  fallbackMaxActivations?: unknown,
): JsonRecord {
  const source = record(value)
  const activationSource = Array.isArray(source.activations)
    ? source.activations
    : []
  return {
    ...pick(source, ["id", "status", "masked_key", "expires_at"]),
    ...(source.masked_key === undefined && source.key_hint !== undefined
      ? { masked_key: source.key_hint }
      : {}),
    ...(source.issued_at !== undefined
      ? { issued_at: source.issued_at }
      : source.assigned_at !== undefined
        ? { issued_at: source.assigned_at }
        : {}),
    max_activations:
      source.max_activations ??
      source.activation_limit ??
      fallbackMaxActivations ??
      null,
    activations: activationSource.map(safeActivation),
  }
}

/** Exact store-facing projection described by `src/storefront/types.ts`. */
export function safeEntitlement(value: unknown): JsonRecord {
  const source = record(value)
  const snapshot = record(source.snapshot)
  const release = record(source.release)
  const snapshotLineItem = record(snapshot.line_item)
  const snapshotProduct = record(snapshot.digital_product)
  const snapshotOrder = record(snapshot.order)
  const assetSource = source.assets ?? release.assets ?? snapshot.assets
  const assets = Array.isArray(assetSource)
    ? assetSource
        .filter((asset) => {
          const role = record(asset).role
          return role !== "preview" && role !== "cover" && role !== "license"
        })
        .map((asset) => {
          const item = record(asset)
          return {
            id: item.id,
            title:
              item.title ?? item.display_name ?? item.name ?? "Digital file",
            filename: item.filename ?? item.original_filename ?? item.name,
            kind: productKind(item.kind, item.mime_type),
            mime_type: item.mime_type,
            size_bytes: item.size_bytes ?? item.size,
            ...(item.duration_seconds !== undefined
              ? { duration_seconds: item.duration_seconds }
              : {}),
            checksum_sha256: item.checksum_sha256 ?? item.checksum,
            delivery_types: assetDeliveryTypes(item),
            download_count: item.download_count ?? source.download_count,
            download_limit: item.download_limit ?? source.download_limit,
            last_downloaded_at:
              item.last_downloaded_at ?? source.last_downloaded_at ?? null,
          }
        })
    : []
  const licenseSource = source.licenses ?? source.license_assignments
  const licenseRecord = Array.isArray(licenseSource)
    ? licenseSource[0]
    : source.license
  const license = licenseRecord
    ? maskedLicense(licenseRecord, source.license_activation_limit)
    : undefined
  const deliveryMode =
    snapshotProduct.delivery_mode ??
    snapshotProduct.delivery_type ??
    source.delivery_type
  const product = {
    product_id:
      source.product_id ??
      snapshotLineItem.product_id ??
      snapshotProduct.product_id ??
      null,
    variant_id: source.variant_id ?? snapshotLineItem.variant_id ?? null,
    title:
      source.title ??
      snapshotLineItem.title ??
      snapshotProduct.name ??
      "Digital product",
    ...(snapshotLineItem.subtitle !== undefined
      ? { variant_title: snapshotLineItem.subtitle }
      : {}),
    ...(snapshotProduct.handle !== undefined
      ? { handle: snapshotProduct.handle }
      : {}),
    ...(snapshotLineItem.thumbnail !== undefined
      ? { thumbnail: snapshotLineItem.thumbnail }
      : {}),
    kind: productKind(
      source.kind ?? snapshotProduct.kind ?? deliveryMode ?? assets[0]?.kind,
      assets[0]?.mime_type,
    ),
  }
  const expiry = source.expires_at
    ? new Date(String(source.expires_at)).valueOf()
    : undefined
  const usable =
    source.status === "active" &&
    (expiry === undefined || (Number.isFinite(expiry) && expiry > Date.now()))
  const withinDownloadLimit =
    source.download_limit === null ||
    source.download_limit === undefined ||
    Number(source.download_count ?? 0) < Number(source.download_limit)
  const licenseIsActive = record(licenseRecord).status === "active"
  const activeActivations = Array.isArray(record(license).activations)
    ? (record(license).activations as unknown[]).some(
        (activation) => record(activation).status === "active",
      )
    : false

  return {
    id: source.id,
    status: source.status,
    order_id: source.order_id ?? snapshotOrder.id ?? "manual",
    ...(source.order_display_id !== undefined
      ? { order_display_id: source.order_display_id }
      : snapshotOrder.display_id !== undefined
        ? { order_display_id: snapshotOrder.display_id }
        : {}),
    line_item_id:
      source.line_item_id ??
      source.order_line_item_id ??
      snapshotLineItem.id ??
      source.id,
    unit_index: source.unit_index ?? snapshotLineItem.unit_index ?? 0,
    created_at:
      source.created_at ?? snapshot.purchased_at ?? new Date(0).toISOString(),
    granted_at: source.granted_at ?? source.available_at ?? source.created_at,
    expires_at: source.expires_at,
    revoked_at: source.revoked_at,
    status_reason: source.status_reason ?? source.revoke_reason,
    product,
    assets,
    ...(license ? { license } : {}),
    capabilities: {
      can_download:
        usable &&
        withinDownloadLimit &&
        assets.some((asset) =>
          (asset.delivery_types as unknown[]).includes("download"),
        ),
      can_stream:
        usable &&
        withinDownloadLimit &&
        assets.some((asset) =>
          (asset.delivery_types as unknown[]).includes("stream"),
        ),
      can_reveal_license: usable && licenseIsActive,
      can_activate_license: usable && licenseIsActive,
      can_deactivate_license: usable && licenseIsActive && activeActivations,
    },
  }
}

export function safeEntitlements(values: unknown): JsonRecord[] {
  return Array.isArray(values) ? values.map(safeEntitlement) : []
}

/** Admin projection keeps operational fields but recursively removes secrets. */
export function adminEntitlement(value: unknown): JsonRecord {
  const source = record(value)
  const snapshot = record(source.snapshot)
  const lineItem = record(snapshot.line_item)
  const digitalProduct = record(snapshot.digital_product)
  const licenseSource = source.licenses ?? source.license_assignments
  const licenses = Array.isArray(licenseSource)
    ? licenseSource.map((entry) => safeAdmin(entry))
    : source.license
      ? [safeAdmin(source.license)]
      : []
  return safeAdmin({
    ...source,
    line_item_id: source.line_item_id ?? source.order_line_item_id,
    product_config_id:
      source.product_config_id ?? source.digital_product_id,
    product_id: source.product_id ?? lineItem.product_id,
    variant_id: source.variant_id ?? lineItem.variant_id,
    title: source.title ?? lineItem.title ?? digitalProduct.name,
    quantity_unit: source.quantity_unit ?? source.unit_index,
    granted_at: source.granted_at ?? source.available_at ?? source.created_at,
    revocation_reason: source.revocation_reason ?? source.revoke_reason,
    licenses,
  })
}

export function adminEntitlements(values: unknown): JsonRecord[] {
  return Array.isArray(values) ? values.map(adminEntitlement) : []
}

export function adminRelease(value: unknown): JsonRecord {
  const source = record(value)
  return safeAdmin({
    ...source,
    product_config_id:
      source.product_config_id ?? source.digital_product_id,
    notes: source.notes ?? source.release_notes,
  })
}

export function adminProductConfig(value: unknown): JsonRecord {
  const source = record(value)
  const metadata = record(source.metadata)
  const releases = Array.isArray(source.releases)
    ? source.releases.map(adminRelease)
    : []
  const variantIds = Array.isArray(source.variant_ids)
    ? source.variant_ids
    : Array.isArray(metadata.variant_ids)
      ? metadata.variant_ids
      : []
  const activeReleaseId =
    source.active_release_id ?? metadata.active_release_id
  const activeRelease =
    source.active_release ??
    releases.find(
      (release) =>
        release.id === activeReleaseId || release.is_current === true,
    )
  return safeAdmin({
    ...source,
    product_id:
      source.product_id ??
      source.medusa_product_id ??
      metadata.medusa_product_id,
    product_title: source.product_title ?? source.title,
    variant_ids: variantIds,
    variants: Array.isArray(source.variants)
      ? source.variants
      : variantIds.map((id) => ({ id })),
    fulfillment_strategy:
      source.fulfillment_strategy ??
      metadata.fulfillment_strategy ??
      (source.fulfillment_required === false ? "manual" : "payment_captured"),
    active_release_id: activeReleaseId ?? record(activeRelease).id,
    active_release: activeRelease,
    license_policy_id:
      source.license_policy_id ??
      metadata.license_policy_id ??
      record(source.license_policy).id,
    download_limit: source.download_limit ?? metadata.download_limit,
    expires_in_days: source.expires_in_days ?? metadata.expires_in_days,
    preview_enabled: source.preview_enabled ?? metadata.preview_enabled,
    update_policy: source.update_policy ?? metadata.update_policy,
    releases,
  })
}

export function adminProductConfigs(values: unknown): JsonRecord[] {
  return Array.isArray(values) ? values.map(adminProductConfig) : []
}

export function licenseSecretReply(value: unknown): JsonRecord {
  const source = record(value)
  const licenseKey = source.license_key ?? source.key
  return {
    license_key: typeof licenseKey === "string" ? licenseKey : undefined,
    ...maskedLicense(source.license ?? source),
  }
}

export function grantSecretReply(value: unknown): JsonRecord {
  const source = record(value)
  const grant = record(source.grant ?? source)
  return {
    token: source.token ?? grant.token,
    asset_id: grant.asset_id,
    action: grant.action,
    expires_at: grant.expires_at,
    url: grant.url,
    ...pick(source.asset ?? grant.asset, [
      "filename",
      "mime_type",
      "size_bytes",
    ]),
  }
}

export function licenseLifecycleReply(value: unknown): JsonRecord {
  const source = record(value)
  const activation = source.activation
    ? safeActivation(source.activation)
    : undefined
  const hasLicense = source.license !== undefined || source.assignment !== undefined
  const license =
    source.valid === false && !hasLicense
      ? {}
      : maskedLicense(source.license ?? source.assignment ?? source)
  if (activation) license.activations = [activation]
  return {
    ...(source.valid !== undefined ? { valid: Boolean(source.valid) } : {}),
    license,
    ...(activation ? { activation } : {}),
    ...(source.next_heartbeat_at
      ? { next_heartbeat_at: source.next_heartbeat_at }
      : {}),
  }
}
