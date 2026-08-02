import {
  LibraryQuerySchema,
  LicensePolicyInputSchema,
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
        max_upload_size_mb: 512,
        audit_retention_days: 365,
      }).success,
    ).toBe(true)
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
