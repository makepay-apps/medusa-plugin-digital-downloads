import {
  DigitalDownloadsError,
  normalizeDigitalDownloadsError,
} from "./errors"
import type {
  DigitalAccessGrantRequest,
  DigitalAccessGrant,
  DigitalAccessGrantResponse,
  DigitalEntitlementResponse,
  DigitalGuestAccessRequest,
  DigitalGuestAccessGrantRequest,
  DigitalGuestAccessResponse,
  DigitalLibraryQuery,
  DigitalLibraryResponse,
  DigitalLicenseActivateRequest,
  DigitalLicenseActivateResponse,
  DigitalLicenseDeactivateRequest,
  DigitalLicenseDeactivateResponse,
  DigitalLicenseHeartbeatRequest,
  DigitalLicenseHeartbeatResponse,
  DigitalLicenseRevealRequest,
  DigitalLicenseRevealResponse,
  DigitalLicenseValidateRequest,
  DigitalLicenseValidateResponse,
  DigitalProductPreviewResponse,
  DigitalStorefrontRequestOptions,
} from "./types"

export const DIGITAL_DOWNLOADS_STORE_PATH = "/store/digital-downloads" as const

export type DigitalDownloadsHttpMethod = "GET" | "POST" | "DELETE"

export interface DigitalDownloadsTransportRequest {
  path: string
  method: DigitalDownloadsHttpMethod
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  cache?: RequestCache
}

export interface DigitalDownloadsTransport {
  request<T>(request: DigitalDownloadsTransportRequest): Promise<T>
}

export type HeaderValue = string | undefined
export type HeaderProvider =
  | Record<string, HeaderValue>
  | (() => Record<string, HeaderValue> | Promise<Record<string, HeaderValue>>)

export interface FetchTransportOptions {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  publishableKey?: string
  authToken?: string | (() => string | undefined | Promise<string | undefined>)
  headers?: HeaderProvider
  credentials?: RequestCredentials
  timeoutMs?: number
}

export interface MedusaSdkFetchOptions {
  method?: DigitalDownloadsHttpMethod
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  cache?: RequestCache
}

/** Structural subset of `sdk.client`; no @medusajs/js-sdk dependency is needed. */
export interface MedusaSdkClientLike {
  fetch<T>(path: string, options?: MedusaSdkFetchOptions): Promise<T>
}

export interface MedusaSdkTransportOptions {
  headers?: HeaderProvider
}

export interface DigitalDownloadsClientOptions {
  transport: DigitalDownloadsTransport
  pathPrefix?: string
  /** Headers required when consuming protected bytes, such as a Medusa publishable key. */
  grantHeaders?: HeaderProvider
}

interface DigitalAccessGrantWireResponse {
  grant: {
    token: string
    asset_id: string
    expires_at: string
    url: string
    filename?: string | null
    mime_type?: string | null
    size_bytes?: number | null
  }
}

export interface FetchDigitalAccessGrantOptions {
  fetch?: typeof globalThis.fetch
  signal?: AbortSignal
  /** Standard HTTP byte range, for example `bytes=0-1048575`. */
  range?: string
}

/**
 * Consumes a short-lived content grant without placing its bearer in the URL.
 * The caller owns the response stream and can pipe it through a framework BFF,
 * save it, or create an object URL for modest browser downloads.
 */
export const fetchDigitalAccessGrant = async (
  grant: DigitalAccessGrant,
  options: FetchDigitalAccessGrantOptions = {}
): Promise<Response> => {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  if (typeof fetchImplementation !== "function") {
    throw new DigitalDownloadsError(
      "A fetch implementation is required in this runtime.",
      { code: "invalid_configuration" }
    )
  }

  const headers: Record<string, string> = { ...grant.headers }
  if (options.range) {
    if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(options.range)) {
      throw new DigitalDownloadsError("A single valid byte range is required.", {
        code: "invalid_argument",
      })
    }
    headers.range = options.range
  }

  let response: Response
  try {
    response = await fetchImplementation(grant.url, {
      method: "GET",
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: options.signal,
    })
  } catch (error) {
    throw normalizeDigitalDownloadsError(
      error,
      "The protected content request failed."
    )
  }

  if (!response.ok && response.status !== 206) {
    throw new DigitalDownloadsError(
      `Digital content request failed with status ${response.status}.`,
      {
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      }
    )
  }

  return response
}

export interface DigitalDownloadsClient {
  getProductPreview(
    variantId: string,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalProductPreviewResponse>
  listLibrary(
    query?: DigitalLibraryQuery,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLibraryResponse>
  getEntitlement(
    entitlementId: string,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalEntitlementResponse>
  getGuestAccess(
    input: DigitalGuestAccessRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalGuestAccessResponse>
  requestAccessGrant(
    entitlementId: string,
    input: DigitalAccessGrantRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalAccessGrantResponse>
  requestGuestAccessGrant(
    input: DigitalGuestAccessGrantRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalAccessGrantResponse>
  requestDownloadGrant(
    entitlementId: string,
    assetId: string,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalAccessGrantResponse>
  requestStreamGrant(
    entitlementId: string,
    assetId: string,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalAccessGrantResponse>
  revealLicense(
    licenseId: string,
    input?: DigitalLicenseRevealRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLicenseRevealResponse>
  activateLicense(
    input: DigitalLicenseActivateRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLicenseActivateResponse>
  deactivateLicense(
    input: DigitalLicenseDeactivateRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLicenseDeactivateResponse>
  heartbeatLicense(
    input: DigitalLicenseHeartbeatRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLicenseHeartbeatResponse>
  validateLicense(
    input: DigitalLicenseValidateRequest,
    options?: DigitalStorefrontRequestOptions
  ): Promise<DigitalLicenseValidateResponse>
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, "")

const resolveHeaders = async (
  provider?: HeaderProvider
): Promise<Record<string, string>> => {
  const candidate = typeof provider === "function" ? await provider() : provider
  const result: Record<string, string> = {}

  for (const [name, value] of Object.entries(candidate ?? {})) {
    if (value !== undefined) {
      result[name] = value
    }
  }

  return result
}

const appendQuery = (
  url: URL,
  query?: DigitalDownloadsTransportRequest["query"]
): void => {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(name, item)
      }
    } else {
      url.searchParams.set(name, String(value))
    }
  }
}

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) {
    return undefined
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds
  }

  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000))
}

const parseResponseBody = async (response: Response): Promise<unknown> => {
  if (response.status === 204) {
    return undefined
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("application/json")) {
    return response.json()
  }

  const text = await response.text()
  return text.length ? text : undefined
}

const createCombinedSignal = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal?: AbortSignal; cleanup: () => void } => {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal, cleanup: () => undefined }
  }

  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) {
    abort()
  } else {
    signal?.addEventListener("abort", abort, { once: true })
  }
  const timer = setTimeout(
    () => controller.abort(new Error("Digital downloads request timed out.")),
    timeoutMs
  )

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
    },
  }
}

export const createFetchTransport = (
  options: FetchTransportOptions
): DigitalDownloadsTransport => {
  const baseUrl = trimTrailingSlash(options.baseUrl)
  const fetchImplementation = options.fetch ?? globalThis.fetch

  if (!baseUrl) {
    throw new DigitalDownloadsError("A Medusa baseUrl is required.", {
      code: "invalid_configuration",
    })
  }
  if (typeof fetchImplementation !== "function") {
    throw new DigitalDownloadsError(
      "A fetch implementation is required in this runtime.",
      { code: "invalid_configuration" }
    )
  }

  return {
    async request<T>(request: DigitalDownloadsTransportRequest): Promise<T> {
      const url = new URL(request.path, `${baseUrl}/`)
      appendQuery(url, request.query)

      const headers = await resolveHeaders(options.headers)
      if (options.publishableKey) {
        headers["x-publishable-api-key"] = options.publishableKey
      }
      const authToken =
        typeof options.authToken === "function"
          ? await options.authToken()
          : options.authToken
      if (authToken) {
        headers.authorization = `Bearer ${authToken}`
      }
      Object.assign(headers, request.headers)

      if (request.body !== undefined) {
        headers["content-type"] = headers["content-type"] ?? "application/json"
      }
      headers.accept = headers.accept ?? "application/json"

      const combined = createCombinedSignal(request.signal, options.timeoutMs)
      try {
        const response = await fetchImplementation(url, {
          method: request.method,
          headers,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          credentials: options.credentials,
          signal: combined.signal,
          cache: request.cache,
        })
        const body = await parseResponseBody(response)

        if (!response.ok) {
          const errorBody =
            body && typeof body === "object"
              ? (body as {
                  message?: unknown
                  code?: unknown
                  type?: unknown
                  request_id?: unknown
                  details?: unknown
                })
              : undefined
          throw new DigitalDownloadsError(
            typeof errorBody?.message === "string"
              ? errorBody.message
              : `Digital downloads request failed with status ${response.status}.`,
            {
              status: response.status,
              code:
                typeof errorBody?.code === "string"
                  ? errorBody.code
                  : typeof errorBody?.type === "string"
                    ? errorBody.type
                    : undefined,
              requestId:
                typeof errorBody?.request_id === "string"
                  ? errorBody.request_id
                  : response.headers.get("x-request-id") ?? undefined,
              retryAfter: parseRetryAfter(response.headers.get("retry-after")),
              details: errorBody?.details,
            }
          )
        }

        return body as T
      } catch (error) {
        throw normalizeDigitalDownloadsError(error)
      } finally {
        combined.cleanup()
      }
    },
  }
}

export const createMedusaSdkTransport = (
  client: MedusaSdkClientLike,
  options: MedusaSdkTransportOptions = {}
): DigitalDownloadsTransport => ({
  async request<T>(request: DigitalDownloadsTransportRequest): Promise<T> {
    try {
      const configuredHeaders = await resolveHeaders(options.headers)
      return await client.fetch<T>(request.path, {
        method: request.method,
        query: request.query,
        body: request.body,
        headers: { ...configuredHeaders, ...request.headers },
        signal: request.signal,
        cache: request.cache,
      })
    } catch (error) {
      throw normalizeDigitalDownloadsError(error)
    }
  },
})

const requiredId = (value: string, name: string): string => {
  const normalized = value.trim()
  if (!normalized) {
    throw new DigitalDownloadsError(`${name} is required.`, {
      code: "invalid_argument",
    })
  }
  return encodeURIComponent(normalized)
}

const queryValue = <T extends string>(
  value: T | T[] | undefined
): string[] | undefined => (value === undefined ? undefined : Array.isArray(value) ? value : [value])

const requestHeaders = (
  options: DigitalStorefrontRequestOptions | undefined
): Record<string, string> => {
  const headers = { ...(options?.headers ?? {}) }

  if (options?.idempotency_key) {
    headers["idempotency-key"] = options.idempotency_key
  }
  return headers
}

export const createDigitalDownloadsClient = (
  options: DigitalDownloadsClientOptions
): DigitalDownloadsClient => {
  const prefix = trimTrailingSlash(options.pathPrefix ?? DIGITAL_DOWNLOADS_STORE_PATH)

  const request = async <T>(
    path: string,
    method: DigitalDownloadsHttpMethod,
    requestOptions: DigitalStorefrontRequestOptions | undefined,
    configuration: {
      body?: unknown
      query?: DigitalDownloadsTransportRequest["query"]
      sensitive?: boolean
    } = {}
  ): Promise<T> =>
    options.transport.request<T>({
      path: `${prefix}${path}`,
      method,
      body: configuration.body,
      query: configuration.query,
      headers: requestHeaders(requestOptions),
      signal: requestOptions?.signal,
      cache: configuration.sensitive ? "no-store" : requestOptions?.cache,
    })

  const requestGrant = async (
    path: string,
    body: DigitalAccessGrantRequest | DigitalGuestAccessGrantRequest,
    requestOptions?: DigitalStorefrontRequestOptions
  ): Promise<DigitalAccessGrantResponse> => {
    const { grant } = await request<DigitalAccessGrantWireResponse>(
      path,
      "POST",
      requestOptions,
      { body, sensitive: true }
    )
    const grantHeaders = await resolveHeaders(options.grantHeaders)

    return {
      grant: {
        ...grant,
        action: body.action,
        method: "GET",
        headers: {
          ...grantHeaders,
          authorization: `Bearer ${grant.token}`,
        },
        supports_ranges: true,
      },
    }
  }

  return {
    getProductPreview(variantId, requestOptions) {
      return request<DigitalProductPreviewResponse>(
        `/products/${requiredId(variantId, "variantId")}`,
        "GET",
        requestOptions
      )
    },

    listLibrary(query = {}, requestOptions) {
      return request<DigitalLibraryResponse>("/library", "GET", requestOptions, {
        sensitive: true,
        query: {
          limit: query.limit,
          offset: query.offset,
          order_id: query.order_id,
          status: queryValue(query.status),
          kind: queryValue(query.kind),
          q: query.q,
        },
      })
    },

    getEntitlement(entitlementId, requestOptions) {
      return request<DigitalEntitlementResponse>(
        `/entitlements/${requiredId(entitlementId, "entitlementId")}`,
        "GET",
        requestOptions,
        { sensitive: true }
      )
    },

    getGuestAccess(input, requestOptions) {
      if (!input.token.trim()) {
        throw new DigitalDownloadsError("token is required.", {
          code: "invalid_argument",
        })
      }
      return request<DigitalGuestAccessResponse>(
        "/guest/access",
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },

    requestAccessGrant(entitlementId, input, requestOptions) {
      if (!input.asset_id.trim()) {
        throw new DigitalDownloadsError("asset_id is required.", {
          code: "invalid_argument",
        })
      }
      return requestGrant(
        `/entitlements/${requiredId(entitlementId, "entitlementId")}/grants`,
        input,
        requestOptions
      )
    },

    requestGuestAccessGrant(input, requestOptions) {
      if (!input.token.trim()) {
        throw new DigitalDownloadsError("token is required.", {
          code: "invalid_argument",
        })
      }
      if (!input.entitlement_id.trim() || !input.asset_id.trim()) {
        throw new DigitalDownloadsError(
          "entitlement_id and asset_id are required.",
          { code: "invalid_argument" }
        )
      }
      return requestGrant("/guest/grants", input, requestOptions)
    },

    requestDownloadGrant(entitlementId, assetId, requestOptions) {
      if (!assetId.trim()) {
        throw new DigitalDownloadsError("assetId is required.", {
          code: "invalid_argument",
        })
      }
      return requestGrant(
        `/entitlements/${requiredId(entitlementId, "entitlementId")}/grants`,
        { asset_id: assetId, action: "download" },
        requestOptions
      )
    },

    requestStreamGrant(entitlementId, assetId, requestOptions) {
      if (!assetId.trim()) {
        throw new DigitalDownloadsError("assetId is required.", {
          code: "invalid_argument",
        })
      }
      return requestGrant(
        `/entitlements/${requiredId(entitlementId, "entitlementId")}/grants`,
        { asset_id: assetId, action: "stream" },
        requestOptions
      )
    },

    revealLicense(licenseId, input = {}, requestOptions) {
      return request<DigitalLicenseRevealResponse>(
        `/licenses/${requiredId(licenseId, "licenseId")}/reveal`,
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },

    activateLicense(input, requestOptions) {
      return request<DigitalLicenseActivateResponse>(
        "/licenses/activate",
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },

    deactivateLicense(input, requestOptions) {
      return request<DigitalLicenseDeactivateResponse>(
        "/licenses/deactivate",
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },

    heartbeatLicense(input, requestOptions) {
      return request<DigitalLicenseHeartbeatResponse>(
        "/licenses/heartbeat",
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },

    validateLicense(input, requestOptions) {
      return request<DigitalLicenseValidateResponse>(
        "/licenses/validate",
        "POST",
        requestOptions,
        { body: input, sensitive: true }
      )
    },
  }
}

/** Convenience constructor for storefronts that do not use @medusajs/js-sdk. */
export const createDigitalDownloadsFetchClient = (
  options: FetchTransportOptions & {
    pathPrefix?: string
    grantHeaders?: HeaderProvider
  }
): DigitalDownloadsClient =>
  createDigitalDownloadsClient({
    transport: createFetchTransport(options),
    pathPrefix: options.pathPrefix,
    grantHeaders:
      options.grantHeaders ??
      (options.publishableKey
        ? { "x-publishable-api-key": options.publishableKey }
        : undefined),
  })
