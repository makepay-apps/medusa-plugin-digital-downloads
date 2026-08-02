import { z } from "@medusajs/framework/zod"

import {
  DEFAULT_PAGE_LIMIT,
  GRANT_TOKEN_MIN_LENGTH,
  GUEST_TOKEN_MIN_LENGTH,
  MAX_KEY_IMPORT_COUNT,
  MAX_PAGE_LIMIT,
  MAX_UPLOAD_BYTES,
} from "./constants.js"
import { hasReservedProductConfigMetadata } from "../../product-config-metadata.js"

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const mimePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}$/
const sha256Pattern = /^[a-f0-9]{64}$/i
const etagPattern = /^(?:W\/)?"?[A-Za-z0-9!#$%&'*+.^_`|~-]{1,190}"?$/
const controlCharacters = /[\u0000-\u001f\u007f]/

export const IdSchema = z.string().trim().regex(idPattern, "Invalid identifier.")

export const SafeFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !controlCharacters.test(value),
    "Filename must not contain a path or control characters.",
  )

export const MimeTypeSchema = z
  .string()
  .trim()
  .max(128)
  .regex(mimePattern, "Invalid MIME type.")
  .transform((value) => value.toLowerCase())

export const Sha256Schema = z
  .string()
  .trim()
  .regex(sha256Pattern, "Expected a SHA-256 hex digest.")
  .transform((value) => value.toLowerCase())

const OptionalBooleanQuery = z.preprocess((value) => {
  if (value === undefined) return undefined
  if (Array.isArray(value)) value = value[0]
  if (value === "true" || value === "1" || value === true) return true
  if (value === "false" || value === "0" || value === false) return false
  return value
}, z.boolean().optional())

const PageNumber = (fallback: number, maximum?: number) =>
  z.preprocess((value) => {
    if (Array.isArray(value)) value = value[0]
    if (value === undefined || value === "") return fallback
    return typeof value === "string" ? Number(value) : value
  }, z.number().int().min(0).max(maximum ?? Number.MAX_SAFE_INTEGER))

const QueryText = (maximum = 200) =>
  z.preprocess(
    (value) => (Array.isArray(value) ? value[0] : value),
    z.string().trim().min(1).max(maximum).optional(),
  )

export const PaginationQuerySchema = z
  .object({
    limit: PageNumber(DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    offset: PageNumber(0),
    q: QueryText(),
    order: QueryText(64),
  })
  .strict()

export const ProductConfigQuerySchema = PaginationQuerySchema.extend({
  product_id: IdSchema.optional(),
  variant_id: IdSchema.optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  delivery_type: z
    .enum(["download", "stream", "license", "mixed"])
    .optional(),
})

export const ProductConfigInputSchema = z
  .object({
    product_id: IdSchema,
    variant_ids: z.array(IdSchema).min(1).max(100),
    title: z.string().trim().min(1).max(255),
    description: z.string().trim().max(10_000).nullable().optional(),
    status: z.enum(["draft", "active", "archived"]).default("draft"),
    delivery_type: z.enum(["download", "stream", "license", "mixed"]),
    fulfillment_strategy: z
      .enum(["payment_captured", "order_completed", "manual"])
      .default("payment_captured"),
    active_release_id: IdSchema.nullable().optional(),
    license_policy_id: IdSchema.nullable().optional(),
    download_limit: z.number().int().min(0).max(1_000_000).nullable().optional(),
    expires_in_days: z.number().int().min(0).max(36_500).nullable().optional(),
    preview_enabled: z.boolean().optional(),
    update_policy: z
      .enum(["purchased_release", "latest_release", "merchant_selected"])
      .optional(),
    metadata: z
      .record(z.string(), z.unknown())
      .refine(
        (value) => !hasReservedProductConfigMetadata(value),
        "Product configuration fields must be supplied at the top level, not in metadata.",
      )
      .optional(),
  })
  .strict()

export const ProductConfigPatchSchema = ProductConfigInputSchema.partial()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.")
  .strict()

export const ReleaseQuerySchema = PaginationQuerySchema.omit({ q: true }).extend({
  product_config_id: IdSchema.optional(),
  status: z.enum(["draft", "ready", "published", "retired"]).optional(),
})

export const ReleaseInputSchema = z
  .object({
    product_config_id: IdSchema,
    version: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(255),
    notes: z.string().trim().max(20_000).nullable().optional(),
    status: z.enum(["draft", "ready"]).default("draft"),
    asset_ids: z.array(IdSchema).max(200).default([]),
    publish_at: z.string().datetime({ offset: true }).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const ReleasePatchSchema = ReleaseInputSchema.omit({
  product_config_id: true,
})
  .partial()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.")
  .strict()

export const PublishReleaseSchema = z
  .object({
    make_active: z.boolean().default(true),
    notify_existing_customers: z.boolean().default(false),
  })
  .strict()

export const AssetQuerySchema = PaginationQuerySchema.extend({
  release_id: IdSchema.optional(),
  product_config_id: IdSchema.optional(),
  role: z
    .enum(["download", "stream", "preview", "cover", "manual", "license"])
    .optional(),
  status: z
    .enum(["staged", "processing", "ready", "quarantined", "failed", "retired"])
    .optional(),
  mime_type: QueryText(128),
})

export const AssetInputSchema = z
  .object({
    upload_id: IdSchema.optional(),
    release_id: IdSchema.optional(),
    filename: SafeFilenameSchema,
    display_name: z.string().trim().min(1).max(255).optional(),
    mime_type: MimeTypeSchema,
    size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    checksum_sha256: Sha256Schema,
    role: z.enum([
      "download",
      "stream",
      "preview",
      "cover",
      "manual",
      "license",
    ]),
    sort_order: z.number().int().min(0).max(1_000_000).default(0),
    platform: z.string().trim().max(100).nullable().optional(),
    architecture: z.string().trim().max(100).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const AssetPatchSchema = AssetInputSchema.omit({
  upload_id: true,
  checksum_sha256: true,
  size: true,
})
  .partial()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.")
  .strict()

export const UploadInputSchema = z
  .object({
    release_id: IdSchema.optional(),
    filename: SafeFilenameSchema,
    mime_type: MimeTypeSchema,
    size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
    checksum_sha256: Sha256Schema.optional(),
    storage_provider: z.enum(["local", "s3"]).optional(),
    purpose: z
      .enum(["download", "stream", "preview", "cover", "manual", "license"])
      .default("download"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const UploadCompleteSchema = z
  .object({
    release_id: IdSchema.optional(),
    purpose: z
      .enum(["download", "stream", "preview", "cover", "manual", "license"])
      .optional(),
    etag: z.string().trim().regex(etagPattern, "Invalid ETag.").optional(),
    checksum_sha256: Sha256Schema.optional(),
    size: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),
    parts: z
      .array(
        z
          .object({
            part_number: z.number().int().min(1).max(10_000),
            etag: z.string().trim().regex(etagPattern, "Invalid ETag."),
          })
          .strict(),
      )
      .max(10_000)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "No completion data supplied.")

export const SettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    default_delivery_type: z
      .enum(["download", "stream", "license", "mixed"])
      .optional(),
    default_download_limit: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional(),
    default_grant_ttl_seconds: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .optional(),
    max_grant_ttl_seconds: z
      .number()
      .int()
      .min(30)
      .max(86_400)
      .optional(),
    max_upload_size_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_UPLOAD_BYTES)
      .optional(),
    allow_guest_access: z.boolean().optional(),
    require_order_email_match: z.boolean().optional(),
    event_retention_days: z.number().int().min(1).max(36_500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Stable API aliases used by the bundled Admin UI.
    max_upload_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_UPLOAD_BYTES)
      .optional(),
    grant_ttl_seconds: z.number().int().min(30).max(86_400).optional(),
    download_limit_default: z.number().int().min(0).max(1_000_000).optional(),
    signed_url_ttl_seconds: z.number().int().min(30).max(86_400).optional(),
    max_upload_size_mb: z.number().positive().max(5_120).optional(),
    audit_retention_days: z.number().int().min(1).max(36_500).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.")

export const StorageTestSchema = z
  .object({
    operation: z.enum(["health", "write_read_delete"]).default("health"),
  })
  .strict()

export const LicensePolicyQuerySchema = PaginationQuerySchema.omit({ q: true }).extend({
  strategy: z.enum(["none", "generated", "pool"]).optional(),
  digital_product_id: IdSchema.optional(),
  is_enabled: OptionalBooleanQuery,
})

export const LicensePolicyInputSchema = z
  .object({
    digital_product_id: IdSchema,
    strategy: z.enum(["none", "pool", "generated"]),
    license_pattern: z.string().trim().min(8).max(255).nullable().optional(),
    activation_limit: z.number().int().min(0).max(1_000_000).nullable().optional(),
    validity_days: z.number().int().min(1).max(36_500).nullable().optional(),
    allow_offline_activation: z.literal(false).optional(),
    require_device_id: z.boolean().optional(),
    is_enabled: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const LicensePolicyPatchSchema = LicensePolicyInputSchema.partial()
  .refine((value) => Object.keys(value).length > 0, "No changes supplied.")
  .strict()

export const LicenseKeyImportSchema = z
  .object({
    keys: z
      .array(z.string().trim().min(8).max(1_024))
      .min(1)
      .max(MAX_KEY_IMPORT_COUNT),
    duplicate_policy: z.enum(["reject", "skip"]).default("reject"),
  })
  .strict()

export const LicensePolicyKeyQuerySchema = PaginationQuerySchema.omit({ q: true }).extend({
  status: z.enum(["available", "reserved", "assigned", "revoked"]).optional(),
  batch_id: QueryText(255),
})

export const EntitlementQuerySchema = PaginationQuerySchema.extend({
  order_id: IdSchema.optional(),
  line_item_id: IdSchema.optional(),
  customer_id: IdSchema.optional(),
  product_config_id: IdSchema.optional(),
  product_id: IdSchema.optional(),
  variant_id: IdSchema.optional(),
  status: z
    .enum(["pending", "active", "expired", "suspended", "revoked", "refunded"])
    .optional(),
})

export const RevokeEntitlementSchema = z
  .object({
    reason: z.string().trim().min(3).max(2_000),
    notify: z.boolean().default(true),
  })
  .strict()

export const ReissueEntitlementSchema = z
  .object({
    reason: z.string().trim().max(2_000).optional(),
    notify: z.boolean().default(true),
    reset_downloads: z.boolean().default(false),
    rotate_guest_token: z.boolean().default(true),
  })
  .strict()

export const DownloadEventQuerySchema = PaginationQuerySchema.omit({ q: true }).extend({
  entitlement_id: IdSchema.optional(),
  asset_id: IdSchema.optional(),
  customer_id: IdSchema.optional(),
  status: z.enum(["started", "completed", "failed", "denied"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export const AuditEventQuerySchema = PaginationQuerySchema.omit({ q: true }).extend({
  entity_type: z.literal("license_assignment").optional(),
  entity_id: IdSchema.optional(),
  assignment_id: IdSchema.optional(),
  action: z
    .enum(["issued", "revealed", "activated", "deactivated", "revoked", "validation_failed"])
    .optional(),
  actor_id: IdSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

export const ReportQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    product_config_id: IdSchema.optional(),
  })
  .strict()

export const PublicProductQuerySchema = z
  .object({
    locale: QueryText(35),
  })
  .passthrough()

export const LibraryQuerySchema = PaginationQuerySchema.extend({
  status: z
    .union([
      z.enum([
        "pending",
        "active",
        "expired",
        "suspended",
        "revoked",
        "refunded",
      ]),
      z
        .array(
          z.enum([
            "pending",
            "active",
            "expired",
            "suspended",
            "revoked",
            "refunded",
          ]),
        )
        .min(1)
        .max(5),
    ])
    .optional(),
  kind: z
    .union([
      z.enum([
        "download",
        "ebook",
        "audio",
        "video",
        "image",
        "software",
        "license",
        "bundle",
        "other",
      ]),
      z
        .array(
          z.enum([
            "download",
            "ebook",
            "audio",
            "video",
            "image",
            "software",
            "license",
            "bundle",
            "other",
          ]),
        )
        .min(1)
        .max(4),
    ])
    .optional(),
  order_id: IdSchema.optional(),
})

export const GrantInputSchema = z
  .object({
    asset_id: IdSchema,
    action: z.enum(["download", "stream"]),
  })
  .strict()

export const GuestAccessSchema = z
  .object({
    token: z.string().min(GUEST_TOKEN_MIN_LENGTH).max(1_024),
    email: z.string().trim().email().max(320).optional(),
  })
  .strict()

export const GuestGrantSchema = GuestAccessSchema.extend({
  entitlement_id: IdSchema,
  asset_id: IdSchema,
  action: z.enum(["download", "stream"]),
}).strict()

export const LicenseRevealSchema = z
  .object({
    guest_token: z
      .string()
      .min(GUEST_TOKEN_MIN_LENGTH)
      .max(1_024)
      .optional(),
    guest_email: z.string().trim().email().max(320).optional(),
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

const LicenseKeySchema = z.string().trim().min(8).max(1_024)
const InstanceIdSchema = z.string().trim().min(1).max(255)
const ClientMetadataSchema = z
  .record(
    z.string().max(100),
    z.union([z.string().max(1_000), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 50, "Too many metadata fields.")
  .optional()

export const LicenseActivateSchema = z
  .object({
    license_key: LicenseKeySchema,
    instance_id: InstanceIdSchema,
    label: z.string().trim().min(1).max(255).optional(),
    metadata: ClientMetadataSchema,
  })
  .strict()

export const LicenseDeactivateSchema = z
  .object({
    license_key: LicenseKeySchema,
    instance_id: InstanceIdSchema,
    reason: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

export const LicenseHeartbeatSchema = z
  .object({
    license_key: LicenseKeySchema,
    instance_id: InstanceIdSchema,
    metadata: ClientMetadataSchema,
  })
  .strict()

export const LicenseValidateSchema = z
  .object({
    license_key: LicenseKeySchema,
    instance_id: InstanceIdSchema.optional(),
  })
  .strict()

export const GrantTokenSchema = z
  .string()
  .min(GRANT_TOKEN_MIN_LENGTH)
  .max(2_048)
  .regex(/^[A-Za-z0-9._~-]+$/, "Invalid grant token.")

export const UploadCapabilitySchema = z
  .string()
  .min(32)
  .max(2_048)
  .regex(/^[A-Za-z0-9._~-]+$/, "Invalid upload capability.")

export function parseId(value: unknown): string {
  return IdSchema.parse(value)
}

export function bodyOf<T>(
  request: { validatedBody?: unknown; body?: unknown },
  schema: z.ZodType<T>,
): T {
  const validated = request.validatedBody
  if (
    validated !== undefined &&
    validated !== null &&
    (typeof validated !== "object" || Object.keys(validated).length > 0)
  ) {
    return schema.parse(validated)
  }
  return schema.parse(request.body)
}

export function queryOf<T>(
  request: { validatedQuery?: unknown; query?: unknown },
  schema: z.ZodType<T>,
): T {
  const validated = request.validatedQuery
  if (
    validated !== undefined &&
    validated !== null &&
    (typeof validated !== "object" || Object.keys(validated).length > 0)
  ) {
    return schema.parse(validated)
  }
  return schema.parse(request.query)
}
