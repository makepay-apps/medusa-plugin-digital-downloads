import {
  LibraryQuerySchema,
  LicensePolicyInputSchema,
  ProductConfigInputSchema,
  PublishReleaseSchema,
  ReissueEntitlementSchema,
  SettingsPatchSchema,
  UploadCompleteSchema,
  UploadInputSchema,
} from "../lib/validators"

describe("frozen API validation contract", () => {
  it("keeps deployment storage topology read-only", () => {
    expect(
      SettingsPatchSchema.safeParse({ storage_provider: "s3" }).success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ s3_bucket: "private-bucket" }).success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({
        signed_url_ttl_seconds: 600,
        guest_access_ttl_seconds: 2_592_000,
        max_upload_size_mb: 512,
        audit_retention_days: 365,
      }).success,
    ).toBe(true)
    expect(
      SettingsPatchSchema.safeParse({ guest_access_ttl_seconds: 86_399 })
        .success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ guest_access_ttl_seconds: 31_536_001 })
        .success,
    ).toBe(false)
  })

  it("rejects unsupported existing-customer release notifications", () => {
    expect(PublishReleaseSchema.safeParse({}).success).toBe(true)
    expect(
      PublishReleaseSchema.safeParse({ notify_existing_customers: false })
        .success,
    ).toBe(true)
    const rejected = PublishReleaseSchema.safeParse({
      notify_existing_customers: true,
    })
    expect(rejected.success).toBe(false)
    if (!rejected.success) {
      expect(rejected.error.issues[0]?.message).toBe(
        "notify_existing_customers is not supported",
      )
    }
  })

  it("supports only implemented licensing strategies and online activation", () => {
    const base = { digital_product_id: "dprod_1" }
    for (const strategy of ["none", "pool", "generated"] as const) {
      expect(
        LicensePolicyInputSchema.safeParse({ ...base, strategy }).success,
      ).toBe(true)
    }
    expect(
      LicensePolicyInputSchema.safeParse({ ...base, strategy: "external" })
        .success,
    ).toBe(false)
    expect(
      LicensePolicyInputSchema.safeParse({
        ...base,
        strategy: "generated",
        allow_offline_activation: true,
      }).success,
    ).toBe(false)
  })

  it("accepts an explicit internal product-config handle", () => {
    const input = {
      product_id: "prod_1",
      variant_ids: ["variant_1"],
      title: "MakePay Creator Bundle",
      handle: "makepay-creator-bundle-run-1",
      delivery_type: "mixed" as const,
    }

    expect(ProductConfigInputSchema.safeParse(input).success).toBe(true)
    expect(
      ProductConfigInputSchema.safeParse({ ...input, handle: "" }).success,
    ).toBe(false)
    expect(
      ProductConfigInputSchema.safeParse({
        ...input,
        handle: "x".repeat(256),
      }).success,
    ).toBe(false)
  })

  it("accepts only explicit ISO deadlines or null for entitlement reissue", () => {
    expect(ReissueEntitlementSchema.safeParse({}).success).toBe(true)
    expect(
      ReissueEntitlementSchema.safeParse({
        expires_at: "2026-08-04T12:00:00.000Z",
      }).success,
    ).toBe(true)
    expect(
      ReissueEntitlementSchema.safeParse({ expires_at: null }).success,
    ).toBe(true)
    expect(
      ReissueEntitlementSchema.safeParse({ expires_at: "tomorrow" }).success,
    ).toBe(false)
  })

  it("uses one public upload-purpose vocabulary for intent and completion", () => {
    for (const purpose of [
      "download",
      "stream",
      "preview",
      "cover",
      "manual",
      "license",
    ] as const) {
      expect(
        UploadInputSchema.safeParse({
          filename: "asset.bin",
          mime_type: "application/octet-stream",
          size: 1,
          purpose,
        }).success,
      ).toBe(true)
      expect(UploadCompleteSchema.safeParse({ purpose }).success).toBe(true)
    }
    expect(UploadCompleteSchema.safeParse({ purpose: "key_import" }).success).toBe(
      false,
    )
    expect(UploadCompleteSchema.safeParse({ purpose: "asset" }).success).toBe(
      false,
    )
  })

  it("accepts SDK product kinds and rejects legacy kind aliases", () => {
    expect(
      LibraryQuerySchema.safeParse({ kind: ["ebook", "audio"], status: "pending" })
        .success,
    ).toBe(true)
    expect(LibraryQuerySchema.safeParse({ kind: "file" }).success).toBe(false)
    expect(LibraryQuerySchema.safeParse({ kind: "media" }).success).toBe(false)
  })
})
