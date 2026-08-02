import { randomUUID } from "node:crypto"

import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"

import { PLUGIN_METADATA, PRIVATE_NO_STORE_HEADERS } from "./constants.js"
import { notFound, unauthorized, unprocessable } from "./errors.js"
import {
  grantSecretReply,
  licenseLifecycleReply,
  licenseSecretReply,
  publicProduct,
  safeEntitlement,
  safeEntitlements,
} from "./projections.js"
import {
  clientContext,
  getIdempotencyKey,
} from "./security.js"
import {
  assertOwnedByCustomer,
  customerId,
  filtersWithoutPagination,
  invokeService,
  listService,
  resolveDigitalDownloadsService,
  retrieveService,
  unwrapResult,
} from "./service.js"
import {
  GrantInputSchema,
  GuestAccessSchema,
  GuestGrantSchema,
  LibraryQuerySchema,
  LicenseActivateSchema,
  LicenseDeactivateSchema,
  LicenseHeartbeatSchema,
  LicenseRevealSchema,
  LicenseValidateSchema,
  PublicProductQuerySchema,
  bodyOf,
  parseId,
  queryOf,
} from "./validators.js"

function privateResponse(res: MedusaResponse) {
  return res.set(PRIVATE_NO_STORE_HEADERS)
}

function requestIdempotencyKey(req: MedusaRequest, operation: string): string {
  return (
    getIdempotencyKey(req) ??
    `${operation}:${req.requestId ?? randomUUID()}`
  )
}

function redactRequestSecret(req: MedusaRequest, key: string): void {
  for (const property of ["body", "validatedBody"] as const) {
    const value = req[property]
    if (value && typeof value === "object" && key in value) {
      ;(value as Record<string, unknown>)[key] = "[redacted]"
    }
  }
}

function normalizeGrant(value: unknown, assetId: string) {
  const projected = grantSecretReply(value)
  return {
    ...projected,
    asset_id: projected.asset_id ?? assetId,
    url:
      projected.url ??
      `/store/digital-downloads/content/${encodeURIComponent(assetId)}`,
  }
}

function actorIdIfPresent(req: MedusaRequest): string | undefined {
  return (
    req as MedusaRequest & { auth_context?: { actor_id?: string } }
  ).auth_context?.actor_id
}

export async function getPluginMetadata(
  _req: MedusaRequest,
  res: MedusaResponse,
) {
  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate")
  res.json({ plugin: PLUGIN_METADATA })
}

export async function getPublicProduct(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const variantId = parseId(req.params.variant_id)
  queryOf(req, PublicProductQuerySchema)
  const link = req.scope.resolve(ContainerRegistrationKeys.LINK) as {
    getLinkModule: (...args: unknown[]) => {
      list: (...args: unknown[]) => Promise<Array<Record<string, unknown>>>
    }
  }
  const linkService = link.getLinkModule(
    Modules.PRODUCT,
    "product_variant_id",
    "digitalDownloads",
    "digital_product_id",
  )
  const links = await linkService.list(
    { product_variant_id: variantId },
    { take: 1 },
  )
  if (!links.length || typeof links[0].digital_product_id !== "string") {
    throw notFound()
  }
  const digitalProduct = await retrieveService<Record<string, unknown>>(
    service,
    ["retrieveDigitalProductConfig"],
    links[0].digital_product_id,
    ["releases", "releases.assets", "license_policy"],
  )
  if (digitalProduct.status !== "active") throw notFound()
  const releases = Array.isArray(digitalProduct.releases)
    ? (digitalProduct.releases as Array<Record<string, unknown>>)
    : []
  const now = Date.now()
  const release = releases.find((candidate) => {
    const from = candidate.available_from
      ? new Date(String(candidate.available_from)).valueOf()
      : undefined
    const until = candidate.available_until
      ? new Date(String(candidate.available_until)).valueOf()
      : undefined
    return (
      candidate.status === "published" &&
      candidate.is_current === true &&
      (from === undefined || from <= now) &&
      (until === undefined || until > now)
    )
  })
  const productService = req.scope.resolve(Modules.PRODUCT) as unknown as {
    retrieveProductVariant: (
      id: string,
      config?: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>
  }
  const variant = await productService.retrieveProductVariant(variantId, {
    relations: ["product"],
  })
  const releaseAssets = Array.isArray(release?.assets)
    ? (release.assets as Array<Record<string, unknown>>).filter(
        (asset) =>
          asset.status === "ready" &&
          asset.is_enabled !== false,
      )
    : []
  const product = publicProduct({
    ...digitalProduct,
    product_id: variant.product_id,
    variant_id: variantId,
    variant_title: variant.title,
    title:
      digitalProduct.title ??
      (variant.product as Record<string, unknown> | undefined)?.title,
    release: release ? { ...release, assets: releaseAssets } : undefined,
  })
  if (!product.product_id) throw notFound()
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate")
  res.json({ product })
}

export async function listLibrary(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const ownerId = customerId(req)
  const query = queryOf(req, LibraryQuerySchema)
  const requestedKinds = query.kind
    ? Array.isArray(query.kind)
      ? query.kind
      : [query.kind]
    : undefined
  const search = query.q?.toLowerCase()
  const filters: Record<string, unknown> = {
    ...filtersWithoutPagination(query),
    customer_id: ownerId,
  }
  delete filters.q
  delete filters.kind
  const relations = [
    "release",
    "release.assets",
    "license_assignments",
    "license_assignments.activations",
  ]
  if (search || requestedKinds) {
    const scan = await listService(
      service,
      ["listAndCountDigitalEntitlements", "listDigitalEntitlements"],
      filters,
      { limit: 10_001, offset: 0, order: query.order },
      relations,
    )
    if (scan.count > 10_000) {
      throw unprocessable(
        "Library search is too broad. Add an order or status filter.",
      )
    }
    for (const item of scan.items) assertOwnedByCustomer(item, ownerId)
    const matches = safeEntitlements(scan.items).filter((entitlement) => {
      const product = (entitlement.product ?? {}) as Record<string, unknown>
      if (
        requestedKinds &&
        !requestedKinds.includes(product.kind as never)
      ) {
        return false
      }
      if (!search) return true
      const assets = Array.isArray(entitlement.assets)
        ? entitlement.assets
        : []
      return [
        entitlement.id,
        entitlement.order_id,
        product.title,
        product.variant_title,
        ...assets.flatMap((asset) => {
          const item = asset as Record<string, unknown>
          return [item.title, item.filename]
        }),
      ].some(
        (entry) =>
          typeof entry === "string" && entry.toLowerCase().includes(search),
      )
    })
    privateResponse(res).json({
      entitlements: matches.slice(query.offset, query.offset + query.limit),
      count: matches.length,
      limit: query.limit,
      offset: query.offset,
    })
    return
  }
  const page = await listService(
    service,
    [
      "listAndCountDigitalEntitlements",
      "listCustomerEntitlements",
      "listDigitalEntitlements",
    ],
    filters,
    { limit: query.limit, offset: query.offset, order: query.order },
    relations,
  )
  for (const item of page.items) assertOwnedByCustomer(item, ownerId)
  privateResponse(res).json({
    entitlements: safeEntitlements(page.items),
    count: page.count,
    limit: page.limit,
    offset: page.offset,
  })
}

export async function getCustomerEntitlement(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const ownerId = customerId(req)
  const entitlement = await retrieveService(
    service,
    ["retrieveDigitalEntitlement"],
    parseId(req.params.id),
    [
      "release",
      "release.assets",
      "license_assignments",
      "license_assignments.activations",
    ],
  )
  assertOwnedByCustomer(entitlement, ownerId)
  privateResponse(res).json({ entitlement: safeEntitlement(entitlement) })
}

export async function createCustomerGrant(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  const service = resolveDigitalDownloadsService(req)
  const ownerId = customerId(req)
  const entitlementId = parseId(req.params.id)
  const input = bodyOf(req, GrantInputSchema)
  const entitlement = await retrieveService(
    service,
    ["retrieveDigitalEntitlement"],
    entitlementId,
  )
  assertOwnedByCustomer(entitlement, ownerId)
  const result = await invokeService(service, ["createDownloadGrant"], {
    entitlement_id: entitlementId,
    asset_id: input.asset_id,
    action: input.action,
    customer_id: ownerId,
    idempotency_key: requestIdempotencyKey(req, "customer-grant"),
    metadata: { action: input.action },
    ...clientContext(req),
  })
  privateResponse(res)
    .status(201)
    .json({ grant: normalizeGrant(result, input.asset_id) })
}

export async function getGuestAccess(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, GuestAccessSchema)
  const token = input.token
  redactRequestSecret(req, "token")
  const result = await invokeService(service, [
    "resolveGuestAccess",
    "resolveGuestEntitlement",
  ], token, {
    email: input.email,
    ip: req.ip,
    user_agent: req.get("user-agent"),
  })
  const entitlement = unwrapResult(result, ["entitlement"]) as
    | Record<string, unknown>
    | undefined
  if (!entitlement || typeof entitlement.id !== "string") throw notFound()
  const hydrated = await retrieveService(
    service,
    ["retrieveDigitalEntitlement"],
    entitlement.id,
    [
      "release",
      "release.assets",
      "license_assignments",
      "license_assignments.activations",
    ],
  )
  privateResponse(res).json({ entitlement: safeEntitlement(hydrated) })
}

export async function createGuestGrant(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const input = bodyOf(req, GuestGrantSchema)
  const token = input.token
  redactRequestSecret(req, "token")
  const access = await invokeService<Record<string, unknown>>(service, [
    "getGuestAccess",
    "resolveGuestEntitlement",
  ], token, {
    email: input.email,
    ip: req.ip,
    user_agent: req.get("user-agent"),
  })
  const entitlement = unwrapResult(access, ["entitlement"]) as
    | Record<string, unknown>
    | undefined
  if (!entitlement || entitlement.id !== input.entitlement_id) throw notFound()
  const session = unwrapResult(access, ["session"]) as
    | Record<string, unknown>
    | undefined
  if (!session || typeof session.id !== "string") throw notFound()
  const result = await invokeService(service, ["createDownloadGrant"], {
    entitlement_id: input.entitlement_id,
    asset_id: input.asset_id,
    action: input.action,
    guest_session_id: session.id,
    idempotency_key: requestIdempotencyKey(req, "guest-grant"),
    metadata: { action: input.action },
    ...clientContext(req),
  })
  privateResponse(res)
    .status(201)
    .json({ grant: normalizeGrant(result, input.asset_id) })
}

export async function revealLicense(req: MedusaRequest, res: MedusaResponse) {
  const service = resolveDigitalDownloadsService(req)
  const assignmentId = parseId(req.params.id)
  const input = bodyOf(req, LicenseRevealSchema)
  const ownerId = actorIdIfPresent(req)
  if (!ownerId && !input.guest_token) {
    throw unauthorized("Customer authentication or a guest token is required.")
  }
  const guestToken = input.guest_token
  if (guestToken) redactRequestSecret(req, "guest_token")
  const result = await invokeService(service, ["revealLicenseKey"], {
    assignment_id: assignmentId,
    customer_id: ownerId,
    guest_token: guestToken,
    guest_email: input.guest_email,
    reason: input.reason,
    ip: req.ip,
    user_agent: req.get("user-agent"),
    ...clientContext(req),
  })
  const reply = licenseSecretReply(result)
  if (typeof reply.license_key !== "string") throw notFound()
  privateResponse(res).json({ license_key: reply.license_key })
}

async function licenseLifecycle(
  req: MedusaRequest,
  res: MedusaResponse,
  operation: "activate" | "deactivate" | "heartbeat" | "validate",
) {
  const schemas = {
    activate: LicenseActivateSchema,
    deactivate: LicenseDeactivateSchema,
    heartbeat: LicenseHeartbeatSchema,
    validate: LicenseValidateSchema,
  }
  const methods = {
    activate: ["activateLicenseByKey"],
    deactivate: ["deactivateLicenseByKey"],
    heartbeat: ["heartbeatLicenseByKey"],
    validate: ["validateLicenseByKey"],
  }
  const input = bodyOf(req, schemas[operation]) as Record<string, unknown>
  const licenseKey = input.license_key as string
  redactRequestSecret(req, "license_key")
  const service = resolveDigitalDownloadsService(req)
  const result = await invokeService(service, methods[operation], {
    ...input,
    license_key: licenseKey,
    idempotency_key: requestIdempotencyKey(req, `license-${operation}`),
    ip: req.ip,
    user_agent: req.get("user-agent"),
    ...clientContext(req),
  })
  const reply = licenseLifecycleReply(result)
  if (operation === "validate") {
    const reason = (result as Record<string, unknown> | undefined)?.reason
    privateResponse(res).json({
      valid: reply.valid === true,
      license: reply.license,
      ...(reply.activation ? { activation: reply.activation } : {}),
      ...(typeof reason === "string" ? { reason } : {}),
    })
    return
  }
  privateResponse(res).json(reply)
}

export async function activateLicense(req: MedusaRequest, res: MedusaResponse) {
  await licenseLifecycle(req, res, "activate")
}

export async function deactivateLicense(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  await licenseLifecycle(req, res, "deactivate")
}

export async function heartbeatLicense(
  req: MedusaRequest,
  res: MedusaResponse,
) {
  await licenseLifecycle(req, res, "heartbeat")
}

export async function validateLicense(req: MedusaRequest, res: MedusaResponse) {
  await licenseLifecycle(req, res, "validate")
}
