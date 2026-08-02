import {
  activateLicense,
  createCustomerGrant,
  createGuestGrant,
  getCustomerEntitlement,
  listLibrary,
  revealLicense,
  validateLicense,
} from "../src/api/lib/store-handlers"
import { PRIVATE_NO_STORE_HEADERS } from "../src/api/lib/constants"

type Service = Record<string, jest.Mock>

function mockResponse() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    payload: undefined,
  }
  res.set = jest.fn((headers: Record<string, string>) => {
    Object.assign(res.headers, headers)
    return res
  })
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers[name] = value
    return res
  })
  res.status = jest.fn((status: number) => {
    res.statusCode = status
    return res
  })
  res.json = jest.fn((payload: unknown) => {
    res.payload = payload
    return res
  })
  return res
}

function mockRequest({
  service,
  customerId,
  params = {},
  body = {},
  query = {},
  headers = {},
}: {
  service: Service
  customerId?: string
  params?: Record<string, string>
  body?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, string>
}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    scope: {
      resolve: jest.fn((name: string) => {
        if (name === "digitalDownloads") return service
        throw new Error(`Unexpected registration: ${name}`)
      }),
    },
    auth_context: customerId
      ? { actor_id: customerId, actor_type: "customer" }
      : undefined,
    params,
    body,
    query,
    ip: "203.0.113.8",
    requestId: "req_handler_test",
    get: jest.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
  } as any
}

describe("store handler authorization boundaries", () => {
  it.each([
    ["a foreign", { id: "dent_1", customer_id: "cus_other" }],
    ["an ownerless", { id: "dent_1" }],
  ])("returns indistinguishable not-found for %s entitlement", async (_case, row) => {
    const service = {
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue(row),
    }
    const req = mockRequest({
      service,
      customerId: "cus_owner",
      params: { id: "dent_1" },
    })
    const res = mockResponse()

    await expect(getCustomerEntitlement(req, res)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    })
    expect(res.json).not.toHaveBeenCalled()
  })

  it("scopes library queries to the authenticated customer and fails closed on a bad service row", async () => {
    const service = {
      listDigitalEntitlements: jest.fn().mockResolvedValue([
        { id: "dent_foreign", customer_id: "cus_other" },
      ]),
    }
    const req = mockRequest({
      service,
      customerId: "cus_owner",
      query: { limit: "10", offset: "0", status: "active" },
    })
    const res = mockResponse()

    await expect(listLibrary(req, res)).rejects.toMatchObject({ status: 404 })
    expect(service.listDigitalEntitlements).toHaveBeenCalledWith(
      { status: "active", customer_id: "cus_owner" },
      expect.objectContaining({ limit: 10, offset: 0 }),
    )
  })

  it("checks ownership before minting a customer grant and returns only the one-time capability", async () => {
    const service = {
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_1",
        customer_id: "cus_owner",
      }),
      createDownloadGrant: jest.fn().mockResolvedValue({
        token: "ddg_one_time_secret",
        grant: {
          id: "dgrant_1",
          asset_id: "dasset_1",
          token_hash: "server-only-hash",
          storage_key: "server-only/path",
          expires_at: "2026-08-02T00:00:00.000Z",
        },
      }),
    }
    const req = mockRequest({
      service,
      customerId: "cus_owner",
      params: { id: "dent_1" },
      body: { asset_id: "dasset_1", action: "download" },
      headers: { "idempotency-key": "grant-request-0001" },
    })
    const res = mockResponse()

    await createCustomerGrant(req, res)

    expect(service.createDownloadGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement_id: "dent_1",
        asset_id: "dasset_1",
        action: "download",
        customer_id: "cus_owner",
        idempotency_key: "grant-request-0001",
      }),
    )
    expect(res.statusCode).toBe(201)
    expect(res.headers).toMatchObject(PRIVATE_NO_STORE_HEADERS)
    expect(res.payload).toEqual({
      grant: {
        token: "ddg_one_time_secret",
        asset_id: "dasset_1",
        action: undefined,
        expires_at: "2026-08-02T00:00:00.000Z",
        url: "/store/digital-downloads/content/dasset_1",
      },
    })
    expect(JSON.stringify(res.payload)).not.toMatch(/token_hash|storage_key/)
  })

  it("does not let a guest capability mint a grant for a different entitlement", async () => {
    const service = {
      getGuestAccess: jest.fn().mockResolvedValue({
        entitlement: { id: "dent_authorized" },
      }),
      createDownloadGrant: jest.fn(),
    }
    const body = {
      token: "guest_token_with_at_least_thirty_two_bytes_0001",
      entitlement_id: "dent_other",
      asset_id: "dasset_1",
      action: "download",
    }
    const req = mockRequest({ service, body })
    const res = mockResponse()

    await expect(createGuestGrant(req, res)).rejects.toMatchObject({
      status: 404,
    })
    expect(service.getGuestAccess).toHaveBeenCalledWith(
      "guest_token_with_at_least_thirty_two_bytes_0001",
      expect.objectContaining({ ip: "203.0.113.8" }),
    )
    expect(service.createDownloadGrant).not.toHaveBeenCalled()
    expect(body.token).toBe("[redacted]")
  })

  it("forwards guest email and binds the resolved session when minting a grant", async () => {
    const service = {
      getGuestAccess: jest.fn().mockResolvedValue({
        entitlement: { id: "dent_authorized" },
        session: { id: "daccess_authorized", status: "active" },
      }),
      createDownloadGrant: jest.fn().mockResolvedValue({
        token: "ddg_guest_one_time_secret",
        grant: {
          id: "dgrant_guest",
          asset_id: "dasset_1",
          expires_at: "2026-08-02T00:00:00.000Z",
        },
      }),
    }
    const body = {
      token: "guest_token_with_at_least_thirty_two_bytes_0002",
      email: " Buyer@Example.test ",
      entitlement_id: "dent_authorized",
      asset_id: "dasset_1",
      action: "download",
    }
    const req = mockRequest({
      service,
      body,
      headers: { "idempotency-key": "guest-grant-request-0002" },
    })
    const res = mockResponse()

    await createGuestGrant(req, res)

    expect(service.getGuestAccess).toHaveBeenCalledWith(
      "guest_token_with_at_least_thirty_two_bytes_0002",
      expect.objectContaining({
        email: "Buyer@Example.test",
        ip: "203.0.113.8",
      }),
    )
    expect(service.createDownloadGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement_id: "dent_authorized",
        asset_id: "dasset_1",
        guest_session_id: "daccess_authorized",
        idempotency_key: "guest-grant-request-0002",
      }),
    )
    expect(res.statusCode).toBe(201)
    expect(body.token).toBe("[redacted]")
  })

  it("requires customer or guest ownership proof before revealing a license", async () => {
    const service = { revealLicenseKey: jest.fn() }
    const unauthenticated = mockRequest({
      service,
      params: { id: "dlassn_1" },
      body: {},
    })

    await expect(
      revealLicense(unauthenticated, mockResponse()),
    ).rejects.toMatchObject({ status: 401 })
    expect(service.revealLicenseKey).not.toHaveBeenCalled()

    service.revealLicenseKey.mockResolvedValue({
      license_key: "REAL-LICENSE-KEY",
      assignment: {
        id: "dlassn_1",
        key_ciphertext: "server-secret",
      },
    })
    const authenticated = mockRequest({
      service,
      customerId: "cus_owner",
      params: { id: "dlassn_1" },
      body: {},
    })
    const res = mockResponse()
    await revealLicense(authenticated, res)

    expect(service.revealLicenseKey).toHaveBeenCalledWith(
      expect.objectContaining({
        assignment_id: "dlassn_1",
        customer_id: "cus_owner",
      }),
    )
    expect(res.payload).toEqual({ license_key: "REAL-LICENSE-KEY" })
    expect(res.headers).toMatchObject(PRIVATE_NO_STORE_HEADERS)
  })

  it("redacts license keys from request state while passing a parsed copy to lifecycle methods", async () => {
    const service = {
      activateLicenseByKey: jest.fn().mockResolvedValue({
        assignment: {
          id: "dlassn_1",
          status: "active",
          key_ciphertext: "never-return-this",
        },
        activation: {
          id: "dlact_1",
          status: "active",
          device_fingerprint: "server-only-device-hash",
        },
      }),
      validateLicenseByKey: jest.fn().mockResolvedValue({
        valid: false,
        reason: "instance_inactive",
      }),
    }
    const body = {
      license_key: "LICENSE-KEY-1234",
      instance_id: "device-1",
    }
    const req = mockRequest({ service, body })
    const res = mockResponse()

    await activateLicense(req, res)

    expect(body.license_key).toBe("[redacted]")
    expect(service.activateLicenseByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        license_key: "LICENSE-KEY-1234",
        instance_id: "device-1",
      }),
    )
    expect(JSON.stringify(res.payload)).not.toMatch(
      /key_ciphertext|device_fingerprint/,
    )

    const validateBody = {
      license_key: "LICENSE-KEY-1234",
      instance_id: "unknown-device",
    }
    const validateReq = mockRequest({ service, body: validateBody })
    const validateRes = mockResponse()
    await validateLicense(validateReq, validateRes)
    expect(validateRes.payload).toEqual({
      valid: false,
      license: {},
      reason: "instance_inactive",
    })
  })
})
