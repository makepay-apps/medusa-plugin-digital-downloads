import {
  createDigitalDownloadsClient,
  createDigitalDownloadsFetchClient,
  createMedusaSdkTransport,
  fetchDigitalAccessGrant,
  type DigitalDownloadsTransportRequest,
} from "../client"
import { DigitalDownloadsError } from "../errors"
import type { DigitalAccessGrant } from "../types"

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })

describe("digital downloads storefront client", () => {
  it("fetches public variant metadata with a publishable key", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        product: {
          product_id: "prod_1",
          variant_id: "variant/a",
          kind: "audio",
          delivery_types: ["download", "stream"],
          previews: [],
        },
      })
    )
    const client = createDigitalDownloadsFetchClient({
      baseUrl: "https://medusa.example/",
      publishableKey: "pk_test",
      fetch: fetchMock as typeof fetch,
    })

    await client.getProductPreview("variant/a")

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      "https://medusa.example/store/digital-downloads/products/variant%2Fa"
    )
    expect(init.method).toBe("GET")
    expect(init.headers).toMatchObject({
      accept: "application/json",
      "x-publishable-api-key": "pk_test",
    })
  })

  it("puts a guest capability only in the POST body", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({ entitlement: { id: "ent_1" } })
    )
    const client = createDigitalDownloadsFetchClient({
      baseUrl: "https://medusa.example",
      fetch: fetchMock as typeof fetch,
    })

    await client.getGuestAccess({
      token: "guest-secret",
      email: "buyer@example.test",
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      "https://medusa.example/store/digital-downloads/guest/access"
    )
    expect(url.toString()).not.toContain("guest-secret")
    expect(JSON.parse(String(init.body))).toEqual({
      token: "guest-secret",
      email: "buyer@example.test",
    })
    expect(init.headers).not.toHaveProperty("authorization")
    expect(init.headers).not.toHaveProperty("x-digital-download-token")
    expect(init.cache).toBe("no-store")
  })

  it("creates a guest grant with idempotency and normalizes its bearer request", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        grant: {
          token: "short-lived-secret",
          asset_id: "asset_1",
          expires_at: "2030-01-01T00:00:00.000Z",
          url: "https://medusa.example/store/digital-downloads/content/asset_1",
        },
      })
    )
    const client = createDigitalDownloadsFetchClient({
      baseUrl: "https://medusa.example",
      fetch: fetchMock as typeof fetch,
    })

    const { grant } = await client.requestGuestAccessGrant(
      {
        token: "guest-secret",
        entitlement_id: "ent_1",
        asset_id: "asset_1",
        action: "stream",
      },
      { idempotency_key: "grant-attempt-1" }
    )

    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.headers).toMatchObject({
      "idempotency-key": "grant-attempt-1",
    })
    expect(grant).toMatchObject({
      action: "stream",
      method: "GET",
      supports_ranges: true,
      headers: { authorization: "Bearer short-lived-secret" },
    })
  })

  it("serializes library filters and resolves a customer token per request", async () => {
    const authToken = jest.fn(async () => "customer-jwt")
    const fetchMock = jest.fn(async () =>
      jsonResponse({ entitlements: [], count: 0, limit: 10, offset: 20 })
    )
    const client = createDigitalDownloadsFetchClient({
      baseUrl: "https://medusa.example",
      authToken,
      fetch: fetchMock as typeof fetch,
    })

    await client.listLibrary({
      limit: 10,
      offset: 20,
      status: ["active", "expired"],
      kind: "ebook",
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.searchParams.getAll("status")).toEqual(["active", "expired"])
    expect(url.searchParams.getAll("kind")).toEqual(["ebook"])
    expect(init.headers).toMatchObject({ authorization: "Bearer customer-jwt" })
    expect(authToken).toHaveBeenCalledTimes(1)
  })

  it("maps API errors without retaining a response body or secret", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(
        {
          code: "download_limit_reached",
          message: "The download limit has been reached.",
          request_id: "req_1",
          details: { remaining: 0 },
        },
        { status: 429, headers: { "retry-after": "12" } }
      )
    )
    const client = createDigitalDownloadsFetchClient({
      baseUrl: "https://medusa.example",
      fetch: fetchMock as typeof fetch,
    })

    await expect(client.requestDownloadGrant("ent_1", "asset_1")).rejects.toEqual(
      expect.objectContaining({
        name: "DigitalDownloadsError",
        status: 429,
        code: "download_limit_reached",
        requestId: "req_1",
        retryAfter: 12,
      })
    )
  })

  it("adapts an existing Medusa SDK client and request headers", async () => {
    const sdkFetch = jest.fn(async (_path: string, _options?: unknown) =>
      ({
        entitlements: [],
        count: 0,
        limit: 20,
        offset: 0,
      })
    )
    const client = createDigitalDownloadsClient({
      transport: createMedusaSdkTransport(
        {
          fetch: <T,>(path: string, options?: unknown) =>
            sdkFetch(path, options) as Promise<T>,
        },
        { headers: async () => ({ authorization: "Bearer server-jwt" }) }
      ),
    })

    await client.listLibrary()

    expect(sdkFetch).toHaveBeenCalledWith(
      "/store/digital-downloads/library",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: expect.objectContaining({
          authorization: "Bearer server-jwt",
        }),
      })
    )
  })

  it("uses the confirmed license lifecycle paths and request bodies", async () => {
    const request = jest.fn(async (_input: DigitalDownloadsTransportRequest) => ({}))
    const client = createDigitalDownloadsClient({
      transport: {
        request: <T,>(input: DigitalDownloadsTransportRequest) =>
          request(input) as Promise<T>,
      },
    })

    await client.revealLicense("lic/1", { guest_token: "guest-secret" })
    await client.activateLicense(
      { license_key: "AAAA-BBBB", instance_id: "install_1", label: "Laptop" },
      { idempotency_key: "activation-1" }
    )
    await client.deactivateLicense({
      license_key: "AAAA-BBBB",
      instance_id: "install_1",
    })
    await client.heartbeatLicense({
      license_key: "AAAA-BBBB",
      instance_id: "install_1",
    })
    await client.validateLicense({ license_key: "AAAA-BBBB" })

    const calls = request.mock.calls as unknown as Array<
      [DigitalDownloadsTransportRequest]
    >
    expect(calls.map(([call]) => [call.path, call.method])).toEqual([
      ["/store/digital-downloads/licenses/lic%2F1/reveal", "POST"],
      ["/store/digital-downloads/licenses/activate", "POST"],
      ["/store/digital-downloads/licenses/deactivate", "POST"],
      ["/store/digital-downloads/licenses/heartbeat", "POST"],
      ["/store/digital-downloads/licenses/validate", "POST"],
    ])
    expect(calls[1][0]).toMatchObject({
      body: {
        license_key: "AAAA-BBBB",
        instance_id: "install_1",
        label: "Laptop",
      },
      headers: expect.objectContaining({ "idempotency-key": "activation-1" }),
    })
  })
})

describe("fetchDigitalAccessGrant", () => {
  const grant: DigitalAccessGrant = {
    token: "content-secret",
    asset_id: "asset_1",
    action: "stream",
    url: "https://medusa.example/store/digital-downloads/content/asset_1",
    method: "GET",
    headers: { authorization: "Bearer content-secret" },
    expires_at: "2030-01-01T00:00:00.000Z",
    supports_ranges: true,
  }

  it("sends the bearer and a byte range without URL leakage", async () => {
    const fetchMock = jest.fn(async () => new Response("data", { status: 206 }))

    await fetchDigitalAccessGrant(grant, {
      fetch: fetchMock as typeof fetch,
      range: "bytes=0-3",
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain("content-secret")
    expect(init.headers).toEqual({
      authorization: "Bearer content-secret",
      range: "bytes=0-3",
    })
    expect(init.redirect).toBe("error")
  })

  it("throws a normalized status error", async () => {
    const fetchMock = jest.fn(async () => new Response(null, { status: 410 }))

    await expect(
      fetchDigitalAccessGrant(grant, { fetch: fetchMock as typeof fetch })
    ).rejects.toBeInstanceOf(DigitalDownloadsError)
  })
})
