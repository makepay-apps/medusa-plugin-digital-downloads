import Medusa from "@medusajs/js-sdk"

import type {
  AdminProductOption,
  DigitalAsset,
  DigitalDownloadSettings,
  DigitalDownloadSettingsPatch,
  DigitalEntitlement,
  DigitalRelease,
  EntitlementFilters,
  ListEnvelope,
  LicensePolicy,
  LicensePolicyInput,
  LicensePoolKeySummary,
  PaginatedResponse,
  ProductConfig,
  ProductConfigFilters,
  ProductConfigInput,
  ReleaseInput,
  ReportSummary,
  UploadIntent,
  UploadPurpose,
} from "../types/digital-downloads"

const API_ROOT = "/admin/digital-downloads"

export const sdk = new Medusa({
  baseUrl: __BACKEND_URL__ || "/",
  debug: import.meta.env.DEV,
  auth: {
    type: "session",
  },
})

type Query = Record<
  string,
  string | number | boolean | string[] | null | undefined
>

const compactQuery = (query?: Query) =>
  Object.fromEntries(
    Object.entries(query ?? {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
  )

const listEnvelope = <T>(
  response: ListEnvelope<T> | Record<string, unknown>,
  keys: string[],
  fallbackLimit = 20,
  fallbackOffset = 0
): PaginatedResponse<T> => {
  const record = response as Record<string, unknown>
  const found = keys.find((key) => Array.isArray(record[key]))
  const items = found ? (record[found] as T[]) : []

  return {
    items,
    count: typeof record.count === "number" ? record.count : items.length,
    limit:
      typeof record.limit === "number" ? record.limit : fallbackLimit,
    offset:
      typeof record.offset === "number" ? record.offset : fallbackOffset,
  }
}

const unwrap = <T>(response: unknown, keys: string[]): T => {
  const record = response as Record<string, unknown>
  const found = keys.find((key) => record?.[key] !== undefined)
  return (found ? record[found] : response) as T
}

const recordValue = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const numericValue = (value: unknown, fallback: number) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  const nested = recordValue(value).value
  if (typeof nested === "string" || typeof nested === "number") {
    const parsed = Number(nested)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

const diagnosticText = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, 500)
    : undefined

const diagnosticIssues = (value: unknown) =>
  Array.isArray(value)
    ? value
        .map(diagnosticText)
        .filter((issue): issue is string => Boolean(issue))
        .slice(0, 20)
    : []

const normalizeSettings = (value: unknown): DigitalDownloadSettings => {
  const settings = recordValue(value)
  const storage = recordValue(settings.storage)
  const readiness = recordValue(settings.readiness)
  const maxUploadBytes = numericValue(
    settings.max_upload_size_bytes,
    5 * 1024 * 1024 * 1024
  )

  return {
    enabled: settings.enabled === true,
    default_delivery_type: ((settings.default_delivery_type ??
      "download") as DigitalDownloadSettings["default_delivery_type"]),
    default_grant_ttl_seconds: numericValue(
      settings.default_grant_ttl_seconds ?? settings.signed_url_ttl_seconds,
      900
    ),
    max_grant_ttl_seconds: numericValue(
      settings.max_grant_ttl_seconds,
      86_400
    ),
    max_upload_size_bytes: maxUploadBytes,
    allow_guest_access: settings.allow_guest_access !== false,
    require_order_email_match: settings.require_order_email_match !== false,
    event_retention_days: numericValue(
      settings.event_retention_days ?? settings.audit_retention_days,
      365
    ),
    storage: {
      provider: ((storage.provider ??
        settings.storage_provider ??
        "local") as DigitalDownloadSettings["storage"]["provider"]),
      configured: storage.configured === true,
    },
    signed_url_ttl_seconds: Number(
      settings.signed_url_ttl_seconds ??
        settings.default_grant_ttl_seconds ??
        900
    ),
    default_download_limit:
      settings.default_download_limit === undefined
        ? null
        : (settings.default_download_limit as number | null),
    default_expiry_days:
      settings.default_expiry_days === undefined
        ? null
        : (settings.default_expiry_days as number | null),
    max_upload_size_mb: Number(
      settings.max_upload_size_mb ??
        maxUploadBytes / 1024 / 1024
    ),
    allowed_mime_types: Array.isArray(settings.allowed_mime_types)
      ? (settings.allowed_mime_types as string[])
      : [],
    enable_streaming: Boolean(settings.enable_streaming ?? false),
    audit_retention_days:
      settings.audit_retention_days === undefined &&
      settings.event_retention_days === undefined
        ? null
        : (settings.audit_retention_days ??
            settings.event_retention_days) as number | null,
    readiness: {
      ready: readiness.ready === true,
      issues: diagnosticIssues(readiness.issues),
      token_secret_configured:
        readiness.token_secret_configured === true,
      encryption_key_configured:
        readiness.encryption_key_configured === true,
      local_signing_secret_configured:
        readiness.local_signing_secret_configured === true,
    },
    updated_at:
      typeof settings.updated_at === "string" ? settings.updated_at : undefined,
  }
}

const normalizeEntitlement = (
  entitlement: DigitalEntitlement
): DigitalEntitlement => {
  const license = entitlement.licenses?.[0]
  return {
    ...entitlement,
    line_item_title:
      entitlement.line_item_title ?? entitlement.title ?? entitlement.product_title,
    license_key_masked:
      entitlement.license_key_masked ??
      license?.masked_key ??
      license?.key_hint ??
      null,
    license_status: entitlement.license_status ?? license?.status ?? null,
    downloads:
      entitlement.downloads ??
      ({
        count: entitlement.download_count ?? 0,
        limit: entitlement.download_limit,
      } satisfies DigitalEntitlement["downloads"]),
  }
}

export const digitalDownloadsApi = {
  async listProductConfigs(filters: ProductConfigFilters = {}) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/product-configs`,
      { query: compactQuery(filters as Query) }
    )

    return listEnvelope<ProductConfig>(
      response,
      ["product_configs", "configs", "items"],
      filters.limit,
      filters.offset
    )
  },

  async getProductConfig(id: string) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/product-configs/${id}`
    )
    return unwrap<ProductConfig>(response, ["product_config", "config"])
  },

  async createProductConfig(input: ProductConfigInput) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/product-configs`,
      { method: "POST", body: input }
    )
    return unwrap<ProductConfig>(response, ["product_config", "config"])
  },

  async updateProductConfig(id: string, input: Partial<ProductConfigInput>) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/product-configs/${id}`,
      { method: "PATCH", body: input }
    )
    return unwrap<ProductConfig>(response, ["product_config", "config"])
  },

  async deleteProductConfig(id: string) {
    return sdk.client.fetch(`${API_ROOT}/product-configs/${id}`, {
      method: "DELETE",
    })
  },

  async createRelease(input: ReleaseInput) {
    const response = await sdk.client.fetch<Record<string, unknown>>(`${API_ROOT}/releases`, {
      method: "POST",
      body: input,
    })
    return unwrap<DigitalRelease>(response, ["release"])
  },

  async publishRelease(id: string) {
    return sdk.client.fetch(`${API_ROOT}/releases/${id}/publish`, {
      method: "POST",
      body: {
        make_active: true,
        notify_existing_customers: false,
      },
    })
  },

  async deleteAsset(id: string) {
    return sdk.client.fetch(`${API_ROOT}/assets/${id}`, { method: "DELETE" })
  },

  async listEntitlements(filters: EntitlementFilters = {}) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/entitlements`,
      { query: compactQuery(filters as Query) }
    )

    const page = listEnvelope<DigitalEntitlement>(
      response,
      ["entitlements", "items"],
      filters.limit,
      filters.offset
    )
    return { ...page, items: page.items.map(normalizeEntitlement) }
  },

  async revokeEntitlement(id: string, reason?: string) {
    return sdk.client.fetch(`${API_ROOT}/entitlements/${id}/revoke`, {
      method: "POST",
      body: reason ? { reason } : {},
    })
  },

  async reissueEntitlement(id: string) {
    return sdk.client.fetch(`${API_ROOT}/entitlements/${id}/reissue`, {
      method: "POST",
      body: {
        notify: true,
        reset_downloads: false,
        rotate_guest_token: true,
      },
    })
  },

  async getSettings() {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/settings`
    )
    return normalizeSettings(unwrap<unknown>(response, ["settings"]))
  },

  async updateSettings(input: DigitalDownloadSettingsPatch) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/settings`,
      { method: "PATCH", body: input }
    )
    return normalizeSettings(unwrap<unknown>(response, ["settings"]))
  },

  async testStorage() {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/settings/test-storage`,
      { method: "POST", body: { operation: "health" } }
    )
    const result = recordValue(unwrap<unknown>(response, ["storage_test"]))
    const issues = diagnosticIssues(result.issues ?? result.errors)
    return {
      success:
        result.ready === true ||
        result.ok === true ||
        result.success === true ||
        result.healthy === true,
      message: diagnosticText(result.message),
      issues,
    }
  },

  async getSummary() {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/reports/summary`
    )
    return unwrap<ReportSummary>(response, ["summary", "report"])
  },

  async listProducts(q?: string) {
    const response = await sdk.client.fetch<{
      products?: AdminProductOption[]
    }>("/admin/products", {
      query: compactQuery({
        q,
        limit: 100,
        fields: "id,title,*variants.id,*variants.title,*variants.sku",
      }),
    })
    return response.products ?? []
  },

  async listLicensePolicies(filters: {
    q?: string
    status?: string
    limit?: number
    offset?: number
  } = {}) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/license-policies`,
      { query: compactQuery(filters) }
    )
    return listEnvelope<LicensePolicy>(
      response,
      ["license_policies", "policies", "items"],
      filters.limit,
      filters.offset
    )
  },

  async createLicensePolicy(input: LicensePolicyInput) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/license-policies`,
      { method: "POST", body: input }
    )
    return unwrap<LicensePolicy>(response, ["license_policy", "policy"])
  },

  async listLicenseKeys(
    policyId: string,
    filters: { status?: string; limit?: number; offset?: number } = {}
  ) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/license-policies/${policyId}/keys`,
      { query: compactQuery(filters) }
    )
    return listEnvelope<LicensePoolKeySummary>(
      response,
      ["keys", "license_keys", "items"],
      filters.limit,
      filters.offset
    )
  },

  async importLicenseKeys(
    policyId: string,
    input: { keys: string[]; duplicate_policy: "reject" | "skip" }
  ) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/license-policies/${policyId}/keys`,
      { method: "POST", body: input }
    )
    const result = unwrap<unknown>(response, ["import"])
    if (Array.isArray(result)) {
      return { imported: result.length }
    }
    const record = recordValue(result)
    return {
      imported:
        typeof record.imported === "number" ? record.imported : undefined,
      skipped: typeof record.skipped === "number" ? record.skipped : undefined,
    }
  },

  async createUploadIntent(
    file: File,
    releaseId: string,
    purpose: UploadPurpose,
    storageProvider?: string
  ) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/uploads`,
      {
        method: "POST",
        body: {
          filename: file.name,
          size: file.size,
          mime_type: file.type || "application/octet-stream",
          release_id: releaseId,
          storage_provider: storageProvider,
          purpose,
        },
      }
    )
    return unwrap<UploadIntent>(response, ["upload"])
  },

  async completeUpload(
    id: string,
    releaseId: string,
    purpose: UploadPurpose
  ) {
    const response = await sdk.client.fetch<Record<string, unknown>>(
      `${API_ROOT}/uploads/${id}/complete`,
      { method: "POST", body: { release_id: releaseId, purpose } }
    )
    return unwrap<DigitalAsset>(response, ["asset"])
  },
}

const absoluteUploadUrl = (url: string) => {
  if (/^https?:\/\//i.test(url)) {
    return url
  }

  const base = (__BACKEND_URL__ || window.location.origin).replace(/\/$/, "")
  return `${base}/${url.replace(/^\//, "")}`
}

export const uploadToIntent = (
  intent: UploadIntent,
  file: File,
  onProgress: (percent: number) => void
) =>
  new Promise<void>((resolve, reject) => {
    if (!intent.url) {
      reject(new Error("The storage provider did not return an upload URL."))
      return
    }

    const request = new XMLHttpRequest()
    request.open(intent.method || "PUT", absoluteUploadUrl(intent.url))
    request.withCredentials = !/^https?:\/\//i.test(intent.url)

    Object.entries(intent.headers ?? {}).forEach(([key, value]) => {
      request.setRequestHeader(key, value)
    })

    if (!intent.headers?.["content-type"] && !intent.headers?.["Content-Type"]) {
      request.setRequestHeader(
        "Content-Type",
        file.type || "application/octet-stream"
      )
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`Upload failed with status ${request.status}.`))
      }
    })
    request.addEventListener("error", () =>
      reject(new Error("The upload could not be completed."))
    )
    request.addEventListener("abort", () =>
      reject(new Error("The upload was cancelled."))
    )
    request.send(file)
  })
