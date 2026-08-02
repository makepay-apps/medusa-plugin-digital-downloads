import {
  CONTENT_SECURITY_HEADERS,
  PRIVATE_NO_STORE_HEADERS,
} from "../src/api/lib/constants"
import { PRODUCT_CONFIG_RESERVED_METADATA_FIELDS } from "../src/product-config-metadata"
import {
  DigitalDownloadsApiError,
  digitalDownloadsErrorHandler,
  isDigitalDownloadsApiPath,
  sendApiError,
} from "../src/api/lib/errors"
import {
  licenseSecretReply,
  safeAdmin,
  safeEntitlement,
  stripSecrets,
} from "../src/api/lib/projections"
import {
  constantTimeDigestEqual,
  getBearerGrantToken,
  getIdempotencyKey,
  privacyHash,
  sha256Token,
} from "../src/api/lib/security"
import {
  assertOwnedByCustomer,
  customerId,
  filtersWithoutPagination,
} from "../src/api/lib/service"
import {
  parseSingleRange,
  resolveLocalAssetPath,
  validateSingleRangeSyntax,
} from "../src/api/lib/content"
import {
  bodyOf,
  GrantTokenSchema,
  GuestGrantSchema,
  LicenseActivateSchema,
  LicensePolicyInputSchema,
  PaginationQuerySchema,
  ProductConfigInputSchema,
  ProductConfigPatchSchema,
  queryOf,
  SafeFilenameSchema,
  SettingsPatchSchema,
} from "../src/api/lib/validators"

type RequestShape = {
  query?: Record<string, unknown>
  requestId?: string
  auth_context?: { actor_id?: string; actor_type?: string }
  get(name: string): string | undefined
}

function request(headers: Record<string, string> = {}): RequestShape {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  )
  return {
    query: {},
    requestId: "req_test",
    get: (name) => normalized[name.toLowerCase()],
  }
}

describe("API bearer and ownership boundaries", () => {
  it("accepts grant capabilities only from a bounded Authorization header", () => {
    const token = `ddg_${"a".repeat(43)}`
    const authorized = request({ authorization: `Bearer ${token}` })

    expect(getBearerGrantToken(authorized as any)).toBe(token)

    const queryLeak = request({ authorization: `Bearer ${token}` })
    queryLeak.query = { token }
    expect(() => getBearerGrantToken(queryLeak as any)).toThrow(
      expect.objectContaining({
        status: 400,
        code: "token_in_query_not_allowed",
      }),
    )
    expect(() => getBearerGrantToken(request() as any)).toThrow(
      expect.objectContaining({ status: 401 }),
    )
    expect(() =>
      getBearerGrantToken(
        request({ authorization: "Basic Z3JhbnQ6c2VjcmV0" }) as any,
      ),
    ).toThrow(expect.objectContaining({ status: 401 }))
  })

  it("requires URL-safe bounded idempotency keys", () => {
    expect(
      getIdempotencyKey(
        request({ "idempotency-key": "order_1:item_1:unit_0" }) as any,
      ),
    ).toBe("order_1:item_1:unit_0")
    expect(() =>
      getIdempotencyKey(request({ "idempotency-key": "short" }) as any),
    ).toThrow(expect.objectContaining({ code: "invalid_idempotency_key" }))
    expect(() =>
      getIdempotencyKey(
        request({ "idempotency-key": `safe_${"a".repeat(251)}` }) as any,
      ),
    ).toThrow(expect.objectContaining({ status: 400 }))
  })

  it("fails closed for unauthenticated, foreign, and ownerless resources", () => {
    expect(() => customerId(request() as any)).toThrow(
      expect.objectContaining({ status: 401 }),
    )
    expect(() =>
      assertOwnedByCustomer({ id: "dent_1", customer_id: "cus_b" }, "cus_a"),
    ).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => assertOwnedByCustomer({ id: "dent_1" }, "cus_a")).toThrow(
      expect.objectContaining({ status: 404 }),
    )
    expect(() =>
      assertOwnedByCustomer({ id: "dent_1", customer_id: "cus_a" }, "cus_a"),
    ).not.toThrow()
  })

  it("uses keyed token equality and non-reversible privacy hashes", () => {
    const digest = sha256Token("grant-secret", "pepper")
    expect(constantTimeDigestEqual(digest, "grant-secret", "pepper")).toBe(true)
    expect(constantTimeDigestEqual(digest, "other", "pepper")).toBe(false)
    expect(constantTimeDigestEqual("invalid", "grant-secret", "pepper")).toBe(
      false,
    )

    const previous = process.env.DIGITAL_DOWNLOADS_PRIVACY_SALT
    process.env.DIGITAL_DOWNLOADS_PRIVACY_SALT = "test-privacy-salt"
    try {
      const hashed = privacyHash("203.0.113.7")
      expect(hashed).toHaveLength(64)
      expect(hashed).not.toContain("203.0.113.7")
      expect(privacyHash("203.0.113.7")).toBe(hashed)
    } finally {
      if (previous === undefined) {
        delete process.env.DIGITAL_DOWNLOADS_PRIVACY_SALT
      } else {
        process.env.DIGITAL_DOWNLOADS_PRIVACY_SALT = previous
      }
    }
  })
})

describe("safe request validation", () => {
  it.each(["../secret", "nested/name.pdf", "nested\\name.pdf", ".", "..", "bad\nname"])(
    "rejects unsafe filename %p",
    (filename) => {
      expect(SafeFilenameSchema.safeParse(filename).success).toBe(false)
    },
  )

  it("normalizes pagination and rejects managed product metadata", () => {
    expect(PaginationQuerySchema.parse({ limit: "100", offset: "20" })).toMatchObject(
      { limit: 100, offset: 20 },
    )
    expect(PaginationQuerySchema.safeParse({ limit: "101" }).success).toBe(false)

    const base = {
      product_id: "prod_1",
      variant_ids: ["variant_1"],
      title: "Guide",
      delivery_type: "download",
    }
    expect(ProductConfigInputSchema.parse(base)).toMatchObject({
      status: "draft",
      delivery_type: "download",
      fulfillment_strategy: "payment_captured",
    })
    expect(
      ProductConfigInputSchema.safeParse({ ...base, delivery_type: "file" }).success,
    ).toBe(false)
    for (const field of PRODUCT_CONFIG_RESERVED_METADATA_FIELDS) {
      expect(
        ProductConfigInputSchema.safeParse({
          ...base,
          metadata: { [field]: "injected" },
        }).success,
      ).toBe(false)
      expect(
        ProductConfigPatchSchema.safeParse({
          metadata: { [field]: "injected" },
        }).success,
      ).toBe(false)
    }
    expect(
      ProductConfigPatchSchema.safeParse({
        metadata: { customer_note: "keep this" },
      }).success,
    ).toBe(true)
  })

  it("bounds guest grants, license metadata, pool policies, and settings", () => {
    expect(
      GuestGrantSchema.safeParse({
        token: "short",
        entitlement_id: "dent_1",
        asset_id: "dasset_1",
        action: "download",
      }).success,
    ).toBe(false)
    expect(GrantTokenSchema.safeParse(`ddg_${"a".repeat(43)}`).success).toBe(true)

    const tooMuchMetadata = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`key_${index}`, index]),
    )
    expect(
      LicenseActivateSchema.safeParse({
        license_key: "AAAA-BBBB",
        instance_id: "device_1",
        metadata: tooMuchMetadata,
      }).success,
    ).toBe(false)
    expect(
      LicensePolicyInputSchema.safeParse({
        name: "Pool policy",
        type: "pool",
      }).success,
    ).toBe(false)
    expect(SettingsPatchSchema.safeParse({}).success).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ grant_ttl_seconds: 86_401 }).success,
    ).toBe(false)
  })

  it("prefers non-empty framework-validated values and drops pagination filters", () => {
    const schema = ProductConfigInputSchema.pick({ title: true })
    expect(
      bodyOf(
        { validatedBody: { title: "Validated" }, body: { title: "Raw" } },
        schema,
      ),
    ).toEqual({ title: "Validated" })
    expect(
      bodyOf({ validatedBody: {}, body: { title: "Raw" } }, schema),
    ).toEqual({ title: "Raw" })

    expect(
      queryOf(
        { validatedQuery: { limit: 10 }, query: { limit: "20" } },
        PaginationQuerySchema,
      ).limit,
    ).toBe(10)
    expect(
      filtersWithoutPagination({
        limit: 20,
        offset: 0,
        order: "created_at",
        status: "active",
        q: undefined,
      }),
    ).toEqual({ status: "active" })
  })
})

describe("ranges, projections, and error privacy", () => {
  it("scopes custom API errors to the plugin route namespace", () => {
    expect(isDigitalDownloadsApiPath("/admin/digital-downloads/settings")).toBe(
      true,
    )
    expect(isDigitalDownloadsApiPath("/store/digital-downloads/content/a")).toBe(
      true,
    )
    expect(isDigitalDownloadsApiPath("/store/digital-downloads-legacy")).toBe(
      false,
    )
    expect(isDigitalDownloadsApiPath("/store/products")).toBe(false)
  })

  it("delegates stream errors after protected response headers were sent", () => {
    const error = new Error("stream failed")
    const next = jest.fn()
    const response: any = { headersSent: true }

    digitalDownloadsErrorHandler(
      error,
      { path: "/store/digital-downloads/content/dasset_1" } as any,
      response,
      next,
    )

    expect(next).toHaveBeenCalledWith(error)
  })

  it("parses one satisfiable range and rejects multiples and overrun starts", () => {
    expect(parseSingleRange("bytes=2-5", 10)).toEqual({
      start: 2,
      end: 5,
      length: 4,
      contentRange: "bytes 2-5/10",
    })
    expect(parseSingleRange("bytes=-3", 10)).toMatchObject({ start: 7, end: 9 })
    expect(parseSingleRange("bytes=8-100", 10)).toMatchObject({ start: 8, end: 9 })
    expect(() => validateSingleRangeSyntax("bytes=0-1,3-4")).toThrow(
      expect.objectContaining({ status: 416 }),
    )
    expect(() => parseSingleRange("bytes=10-", 10)).toThrow(
      expect.objectContaining({ code: "range_not_satisfiable" }),
    )
  })

  it("keeps local content paths below their configured root", () => {
    const root = "/srv/medusa/private"
    expect(resolveLocalAssetPath(root, "tenant/asset.bin")).toBe(
      "/srv/medusa/private/tenant/asset.bin",
    )
    expect(() => resolveLocalAssetPath(root, "../../etc/passwd")).toThrow(
      expect.objectContaining({ code: "unsafe_storage_path" }),
    )
    expect(() => resolveLocalAssetPath(root, "/etc/passwd")).toThrow(
      expect.objectContaining({ status: 500 }),
    )
  })

  it("recursively strips all bearer, credential, key, and storage aliases", () => {
    const value = {
      id: "dent_1",
      token: "grant-secret",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      api_key: "api-secret",
      encryption_key: "encryption-secret",
      storage_key: "private/object.bin",
      nested: {
        secret_access_key: "aws-secret",
        key_hint: "••••-ABCD",
      },
    }

    expect(safeAdmin(value)).toEqual({
      id: "dent_1",
      nested: { key_hint: "••••-ABCD" },
    })
    expect(JSON.stringify(stripSecrets(value))).not.toContain("secret")
  })

  it("uses explicit entitlement allowlists and reveals a license only deliberately", () => {
    const persisted = {
      id: "dent_1",
      status: "active",
      customer_id: "cus_1",
      storage_key: "private/object.bin",
      token_hash: "hash",
      assets: [
        {
          id: "dasset_1",
          filename: "guide.pdf",
          mime_type: "application/pdf",
          storage_key: "private/object.bin",
        },
      ],
      licenses: [
        {
          id: "lassign_1",
          key_hint: "••••-ABCD",
          encrypted_key: "ciphertext",
        },
      ],
    }

    const projected = safeEntitlement(persisted)
    expect(projected).toMatchObject({
      id: "dent_1",
      assets: [{ id: "dasset_1", filename: "guide.pdf" }],
      license: { id: "lassign_1", masked_key: "••••-ABCD" },
    })
    expect(projected).not.toHaveProperty("customer_id")
    expect(JSON.stringify(projected)).not.toMatch(
      /customer_id|storage_key|token_hash|encrypted_key/,
    )
    expect(
      licenseSecretReply({
        license_key: "AAAA-BBBB",
        encrypted_key: "ciphertext",
        id: "lassign_1",
        key_hint: "••••-BBBB",
      }),
    ).toEqual({
      license_key: "AAAA-BBBB",
      id: "lassign_1",
      masked_key: "••••-BBBB",
      max_activations: null,
      activations: [],
    })
  })

  it("redacts unexpected internal errors while preserving safe typed errors", () => {
    const response = () => {
      const res: any = {
        req: { requestId: "req_test" },
        status: jest.fn(),
        set: jest.fn(),
        json: jest.fn(),
      }
      res.status.mockReturnValue(res)
      res.set.mockReturnValue(res)
      return res
    }

    const internal = response()
    sendApiError(
      internal,
      new Error("database failed with license_key=AAAA and password=secret"),
    )
    expect(internal.status).toHaveBeenCalledWith(500)
    expect(internal.set).toHaveBeenCalledWith(PRIVATE_NO_STORE_HEADERS)
    expect(internal.json).toHaveBeenCalledWith({
      type: "internal_error",
      code: "internal_error",
      message: "The request could not be completed.",
      request_id: "req_test",
    })

    const typed = response()
    sendApiError(
      typed,
      new DigitalDownloadsApiError(409, "grant_consumed", "Grant was consumed."),
    )
    expect(typed.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "grant_consumed",
        message: "Grant was consumed.",
      }),
    )
    expect(typed.set).toHaveBeenCalledWith(PRIVATE_NO_STORE_HEADERS)
  })

  it("defines private anti-sniffing headers for all sensitive responses", () => {
    expect(PRIVATE_NO_STORE_HEADERS).toMatchObject({
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    expect(CONTENT_SECURITY_HEADERS).toMatchObject({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    })
  })
})
