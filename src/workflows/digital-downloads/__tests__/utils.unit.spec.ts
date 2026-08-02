import {
  buildPurchaseSnapshot,
  computeBackoffDate,
  MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER,
  normalizeQuantity,
  sanitizeForPurchaseSnapshot,
  selectPurchasableRelease,
  shouldRevokeForRefund,
  stripManagedFields,
} from "../utils"

describe("digital download orchestration utilities", () => {
  it.each([
    [3, 3],
    ["2", 2],
    [{ value: "4" }, 4],
    [{ raw_value: "5" }, 5],
    [0, 0],
    [-1, 0],
    [Number.NaN, 0],
    [
      MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER,
      MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER,
    ],
  ])("normalizes quantity %p to %p", (input, expected) => {
    expect(normalizeQuantity(input)).toBe(expected)
  })

  it("rejects a line quantity above the shared per-order budget", () => {
    expect(() =>
      normalizeQuantity(MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER + 1)
    ).toThrow(/cannot exceed 1000 entitlement units/)
  })

  it("selects the current, purchasable release without mutating the catalog", () => {
    const releases = [
      { id: "draft", status: "draft", created_at: "2026-01-03" },
      { id: "old", status: "published", published_at: "2026-01-01" },
      {
        id: "current",
        status: "published",
        is_current: true,
        published_at: "2026-01-02",
      },
    ]
    expect(selectPurchasableRelease({ releases })?.id).toBe("current")
    expect(releases.map((release) => release.id)).toEqual([
      "draft",
      "old",
      "current",
    ])
  })

  it("builds an immutable delivery snapshot without private storage fields", () => {
    const snapshot = buildPurchaseSnapshot({
      order: {
        id: "order_1",
        currency_code: "usd",
        created_at: "2026-07-31T00:00:00.000Z",
      },
      lineItem: {
        id: "item_1",
        variant_id: "variant_1",
        title: "Album",
        quantity: 2,
        unit_price: 1000,
      },
      digitalProduct: {
        id: "dprod_1",
        title: "Album",
        delivery_type: "download",
        metadata: { access_duration_days: 30 },
      },
      release: {
        id: "drel_1",
        version: "1.0",
        assets: [
          {
            id: "asset_1",
            original_filename: "album.zip",
            storage_key: "tenant/private/album.zip",
            storage_bucket: "private",
            checksum_sha256: "abc",
            metadata: { secret: "never", platform: "all" },
          },
        ],
      },
      unitIndex: 1,
    })

    expect(snapshot).toMatchObject({
      schema_version: 1,
      purchased_at: "2026-07-31T00:00:00.000Z",
      line_item: { id: "item_1", unit_index: 1, variant_id: "variant_1" },
      release: { id: "drel_1", version: "1.0" },
      assets: [{ id: "asset_1" }],
    })
    expect(JSON.stringify(snapshot)).not.toContain("storage_key")
    expect(JSON.stringify(snapshot)).not.toContain("private/album.zip")
    expect(JSON.stringify(snapshot)).not.toContain("never")
  })

  it("recursively strips secrets while retaining public metadata", () => {
    expect(
      sanitizeForPurchaseSnapshot({
        title: "Public",
        nested: { password: "hidden", region: "eu" },
        credentials: { access_key: "hidden" },
      })
    ).toEqual({ title: "Public", nested: { region: "eu" } })
  })

  it("implements cancellation/refund policy decisions", () => {
    expect(
      shouldRevokeForRefund({
        policy: "retain",
        orderTotal: 100,
        refundedTotal: 100,
        hasSelectedLineItems: false,
      })
    ).toBe(false)
    expect(
      shouldRevokeForRefund({
        policy: "any_refund",
        orderTotal: 100,
        refundedTotal: 1,
        hasSelectedLineItems: false,
      })
    ).toBe(true)
    expect(
      shouldRevokeForRefund({
        policy: "full_refund",
        orderTotal: { value: "100" },
        refundedTotal: { raw_value: "99" },
        hasSelectedLineItems: false,
      })
    ).toBe(false)
    expect(
      shouldRevokeForRefund({
        policy: "full_refund",
        orderTotal: 100,
        refundedTotal: 100,
        hasSelectedLineItems: false,
      })
    ).toBe(true)
    expect(
      shouldRevokeForRefund({
        policy: "refunded_items",
        orderTotal: 100,
        refundedTotal: 10,
        hasSelectedLineItems: true,
      })
    ).toBe(true)
  })

  it("uses bounded exponential retry delays", () => {
    const now = new Date("2026-01-01T00:00:00.000Z")
    expect(computeBackoffDate(0, now).toISOString()).toBe(
      "2026-01-01T00:00:30.000Z"
    )
    expect(computeBackoffDate(30, now).getTime() - now.getTime()).toBe(
      86_400_000
    )
  })

  it("removes generated fields and relation objects for compensation writes", () => {
    expect(
      stripManagedFields(
        {
          id: "dprod_1",
          title: "Product",
          created_at: new Date(),
          releases: [{ id: "drel_1" }],
          metadata: { preserved: true },
        },
        { keepId: true }
      )
    ).toEqual({ id: "dprod_1", title: "Product" })
  })
})
