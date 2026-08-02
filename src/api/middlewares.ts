import {
  authenticate,
  defineMiddlewares,
  validateAndTransformBody,
  validateAndTransformQuery,
  type MiddlewareRoute,
} from "@medusajs/framework/http"
import { PolicyOperation } from "@medusajs/framework/utils"

import { digitalDownloadsErrorHandler } from "./lib/errors.js"
import { rateLimit } from "./lib/security.js"
import {
  AssetPatchSchema,
  AssetQuerySchema,
  AuditEventQuerySchema,
  DownloadEventQuerySchema,
  EntitlementQuerySchema,
  GrantInputSchema,
  GuestAccessSchema,
  GuestGrantSchema,
  LibraryQuerySchema,
  LicenseActivateSchema,
  LicenseDeactivateSchema,
  LicenseHeartbeatSchema,
  LicenseKeyImportSchema,
  LicensePolicyInputSchema,
  LicensePolicyKeyQuerySchema,
  LicensePolicyPatchSchema,
  LicensePolicyQuerySchema,
  LicenseRevealSchema,
  LicenseValidateSchema,
  ProductConfigInputSchema,
  ProductConfigPatchSchema,
  ProductConfigQuerySchema,
  PublicProductQuerySchema,
  PublishReleaseSchema,
  ReleaseInputSchema,
  ReleasePatchSchema,
  ReleaseQuerySchema,
  ReissueEntitlementSchema,
  ReportQuerySchema,
  RevokeEntitlementSchema,
  SettingsPatchSchema,
  StorageTestSchema,
  UploadCompleteSchema,
  UploadInputSchema,
} from "./lib/validators.js"

const validateListQuery = (schema: Parameters<typeof validateAndTransformQuery>[0]) =>
  validateAndTransformQuery(schema, { isList: true })
const validateQuery = (schema: Parameters<typeof validateAndTransformQuery>[0]) =>
  validateAndTransformQuery(schema, {})

const adminPolicies: MiddlewareRoute[] = [
  {
    matcher: "/admin/digital-downloads/settings",
    methods: ["GET"],
    policies: [{ resource: "store", operation: PolicyOperation.read }],
  },
  {
    matcher: "/admin/digital-downloads/settings*",
    methods: ["PATCH", "POST"],
    policies: [{ resource: "store", operation: PolicyOperation.update }],
  },
  {
    matcher: "/admin/digital-downloads/product-configs*",
    methods: ["GET"],
    policies: [{ resource: "product", operation: PolicyOperation.read }],
  },
  {
    matcher: "/admin/digital-downloads/product-configs",
    methods: ["POST"],
    policies: [{ resource: "product", operation: PolicyOperation.create }],
  },
  {
    matcher: "/admin/digital-downloads/product-configs/:id",
    methods: ["PATCH", "DELETE"],
    policies: [{ resource: "product", operation: PolicyOperation.update }],
  },
  {
    matcher: /^\/admin\/digital-downloads\/(?:releases|assets|uploads|license-policies)(?:\/.*)?$/,
    methods: ["GET"],
    policies: [{ resource: "product", operation: PolicyOperation.read }],
  },
  {
    matcher: /^\/admin\/digital-downloads\/(?:releases|assets|uploads|license-policies)(?:\/.*)?$/,
    methods: ["POST", "PATCH", "DELETE"],
    policies: [{ resource: "product", operation: PolicyOperation.update }],
  },
  {
    matcher: /^\/admin\/digital-downloads\/(?:entitlements|downloads|audit-events|reports)(?:\/.*)?$/,
    methods: ["GET"],
    policies: [{ resource: "order", operation: PolicyOperation.read }],
  },
  {
    matcher: /^\/admin\/digital-downloads\/(?:entitlements|orders)(?:\/.*)?$/,
    methods: ["POST", "PATCH"],
    policies: [{ resource: "order", operation: PolicyOperation.update }],
  },
]

export default defineMiddlewares({
  errorHandler: digitalDownloadsErrorHandler,
  routes: [
    {
      matcher: "/admin/digital-downloads*",
      middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
    },
    ...adminPolicies,
    {
      matcher: "/admin/digital-downloads/settings",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(SettingsPatchSchema)],
    },
    {
      matcher: "/admin/digital-downloads/settings/test-storage",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(StorageTestSchema)],
    },
    {
      matcher: "/admin/digital-downloads/product-configs",
      methods: ["GET"],
      middlewares: [validateListQuery(ProductConfigQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/product-configs",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(ProductConfigInputSchema)],
    },
    {
      matcher: "/admin/digital-downloads/product-configs/:id",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(ProductConfigPatchSchema)],
    },
    {
      matcher: "/admin/digital-downloads/releases",
      methods: ["GET"],
      middlewares: [validateListQuery(ReleaseQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/releases",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(ReleaseInputSchema)],
    },
    {
      matcher: "/admin/digital-downloads/releases/:id",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(ReleasePatchSchema)],
    },
    {
      matcher: "/admin/digital-downloads/releases/:id/publish",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(PublishReleaseSchema)],
    },
    {
      matcher: "/admin/digital-downloads/assets",
      methods: ["GET"],
      middlewares: [validateListQuery(AssetQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/assets/:id",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(AssetPatchSchema)],
    },
    {
      matcher: "/admin/digital-downloads/uploads",
      methods: ["POST"],
      bodyParser: { sizeLimit: "64kb" },
      middlewares: [validateAndTransformBody(UploadInputSchema)],
    },
    {
      matcher: "/admin/digital-downloads/uploads/:id/content",
      methods: ["PUT"],
      bodyParser: false,
    },
    {
      matcher: "/admin/digital-downloads/uploads/:id/complete",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(UploadCompleteSchema)],
    },
    {
      matcher: "/admin/digital-downloads/license-policies",
      methods: ["GET"],
      middlewares: [validateListQuery(LicensePolicyQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/license-policies",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(LicensePolicyInputSchema)],
    },
    {
      matcher: "/admin/digital-downloads/license-policies/:id",
      methods: ["PATCH"],
      middlewares: [validateAndTransformBody(LicensePolicyPatchSchema)],
    },
    {
      matcher: "/admin/digital-downloads/license-policies/:id/keys",
      methods: ["GET"],
      middlewares: [validateListQuery(LicensePolicyKeyQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/license-policies/:id/keys",
      methods: ["POST"],
      bodyParser: { sizeLimit: "1mb" },
      middlewares: [validateAndTransformBody(LicenseKeyImportSchema)],
    },
    {
      matcher: "/admin/digital-downloads/entitlements",
      methods: ["GET"],
      middlewares: [validateListQuery(EntitlementQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/entitlements/:id/revoke",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(RevokeEntitlementSchema)],
    },
    {
      matcher: "/admin/digital-downloads/entitlements/:id/reissue",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(ReissueEntitlementSchema)],
    },
    {
      matcher: "/admin/digital-downloads/downloads",
      methods: ["GET"],
      middlewares: [validateListQuery(DownloadEventQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/audit-events",
      methods: ["GET"],
      middlewares: [validateListQuery(AuditEventQuerySchema)],
    },
    {
      matcher: "/admin/digital-downloads/reports/summary",
      methods: ["GET"],
      middlewares: [validateQuery(ReportQuerySchema)],
    },
    {
      matcher: "/store/digital-downloads/products/:variant_id",
      methods: ["GET"],
      middlewares: [validateQuery(PublicProductQuerySchema)],
    },
    {
      matcher: "/store/digital-downloads/library",
      methods: ["GET"],
      middlewares: [
        authenticate("customer", ["session", "bearer"]),
        validateListQuery(LibraryQuerySchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/entitlements*",
      middlewares: [authenticate("customer", ["session", "bearer"])],
    },
    {
      matcher: "/store/digital-downloads/entitlements/:id/grants",
      methods: ["POST"],
      middlewares: [validateAndTransformBody(GrantInputSchema)],
    },
    {
      matcher: "/store/digital-downloads/guest/access",
      methods: ["POST"],
      bodyParser: { sizeLimit: "16kb" },
      middlewares: [
        rateLimit({ name: "guest-access", limit: 20, windowMs: 60_000 }),
        validateAndTransformBody(GuestAccessSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/guest/grants",
      methods: ["POST"],
      bodyParser: { sizeLimit: "16kb" },
      middlewares: [
        rateLimit({ name: "guest-grant", limit: 20, windowMs: 60_000 }),
        validateAndTransformBody(GuestGrantSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/previews/:asset_id",
      methods: ["GET"],
      middlewares: [
        rateLimit({ name: "public-preview", limit: 120, windowMs: 60_000 }),
      ],
    },
    {
      matcher: "/store/digital-downloads/content/:asset_id",
      methods: ["GET"],
      middlewares: [
        rateLimit({ name: "content", limit: 240, windowMs: 60_000 }),
      ],
    },
    {
      matcher: "/store/digital-downloads/licenses/:id/reveal",
      methods: ["POST"],
      bodyParser: { sizeLimit: "16kb" },
      middlewares: [
        authenticate("customer", ["session", "bearer"], {
          allowUnauthenticated: true,
        }),
        rateLimit({ name: "license-reveal", limit: 20, windowMs: 60_000 }),
        validateAndTransformBody(LicenseRevealSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/licenses/activate",
      methods: ["POST"],
      bodyParser: { sizeLimit: "64kb" },
      middlewares: [
        rateLimit({ name: "license-activate", limit: 30, windowMs: 60_000 }),
        validateAndTransformBody(LicenseActivateSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/licenses/deactivate",
      methods: ["POST"],
      bodyParser: { sizeLimit: "32kb" },
      middlewares: [
        rateLimit({ name: "license-deactivate", limit: 30, windowMs: 60_000 }),
        validateAndTransformBody(LicenseDeactivateSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/licenses/heartbeat",
      methods: ["POST"],
      bodyParser: { sizeLimit: "64kb" },
      middlewares: [
        rateLimit({ name: "license-heartbeat", limit: 120, windowMs: 60_000 }),
        validateAndTransformBody(LicenseHeartbeatSchema),
      ],
    },
    {
      matcher: "/store/digital-downloads/licenses/validate",
      methods: ["POST"],
      bodyParser: { sizeLimit: "32kb" },
      middlewares: [
        rateLimit({ name: "license-validate", limit: 120, windowMs: 60_000 }),
        validateAndTransformBody(LicenseValidateSchema),
      ],
    },
  ],
})
