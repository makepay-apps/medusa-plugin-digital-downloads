import { emitEventStep } from "@medusajs/medusa/core-flows"
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import {
  DigitalEntitlementStatus,
} from "../../modules/digital-downloads/types"
import { DIGITAL_DOWNLOAD_EVENTS } from "./events"
import {
  deleteDigitalProduct,
  digitalProductLinkDefinition,
  getLinkService,
  resolveDigitalDownloadsService,
} from "./service-helpers"
import type {
  CleanupDigitalVariantWorkflowInput,
  CleanupOrphanedDigitalProductsWorkflowInput,
  ExpireEntitlementsWorkflowInput,
  RetryDigitalOperationsWorkflowInput,
  UnknownRecord,
} from "./types"
import { requireIdentifier } from "./utils"

async function safelyDeleteOrArchiveProduct(
  service: any,
  id: string,
  reason: string
): Promise<"deleted" | "archived"> {
  try {
    await deleteDigitalProduct(service, id)
    return "deleted"
  } catch {
    const product = await service.retrieveDigitalProduct(id)
    await service.updateDigitalProductConfigs({
      id,
      status: "archived",
      metadata: {
        ...(product.metadata ?? {}),
        orphaned_at: new Date().toISOString(),
        orphan_reason: reason,
      },
    })
    return "archived"
  }
}

const cleanupDigitalVariantStep = createStep(
  "cleanup-digital-variant",
  async (input: CleanupDigitalVariantWorkflowInput, { container }) => {
    const variantId = requireIdentifier(input, "variant_id", "variantId")
    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const linkService = getLinkService(
      container,
      Modules.PRODUCT,
      "product_variant_id",
      "digital_product_id"
    )
    const links = await linkService.list(
      { product_variant_id: variantId },
      { take: 100 }
    )
    const cleaned: UnknownRecord[] = []

    for (const link of links) {
      const digitalProductId = link.digital_product_id
      const definition = digitalProductLinkDefinition(variantId, digitalProductId)
      await remoteLink.dismiss([definition]).catch(() => undefined)
      const action = await safelyDeleteOrArchiveProduct(
        service,
        digitalProductId,
        "product_variant_deleted"
      )
      cleaned.push({ digital_product_id: digitalProductId, action })
    }

    return new StepResponse({ variant_id: variantId, cleaned })
  }
)

const cleanupOrphanedDigitalProductsStep = createStep(
  "cleanup-orphaned-digital-products",
  async (input: CleanupOrphanedDigitalProductsWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const remoteLink = container.resolve(ContainerRegistrationKeys.LINK) as any
    const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
    const linkService = getLinkService(
      container,
      Modules.PRODUCT,
      "product_variant_id",
      "digital_product_id"
    )
    const limit = Math.max(1, Math.min(1000, input.limit ?? 250))
    const links = await linkService.list({}, { take: limit })
    const variantIds = [
      ...new Set(
        links.map((link: UnknownRecord) => link.product_variant_id)
      ),
    ]
    const variants = variantIds.length
      ? (
          await query.graph({
            entity: "product_variant",
            fields: ["id"],
            filters: { id: variantIds },
          })
        ).data
      : []
    const existingVariantIds = new Set(
      variants.map((variant: UnknownRecord) => variant.id)
    )
    const staleLinks = links.filter(
      (link: UnknownRecord) =>
        !existingVariantIds.has(link.product_variant_id)
    )
    const linkedProductIds = new Set(
      links.map((link: UnknownRecord) => link.digital_product_id)
    )
    const products = await service.listDigitalProducts(
      {},
      { take: limit, order: { created_at: "ASC" } }
    )
    const unlinkedProducts: UnknownRecord[] = []
    for (const product of products) {
      if (linkedProductIds.has(product.id)) {
        continue
      }
      // The initial link page can be saturated by products with many variants.
      // Confirm each apparent orphan directly before deleting anything.
      const directLinks = await linkService.list(
        { digital_product_id: product.id },
        { take: 1 }
      )
      if (!directLinks.length) {
        unlinkedProducts.push(product)
      }
    }
    const candidates = new Map<string, UnknownRecord>()

    for (const link of staleLinks) {
      candidates.set(link.digital_product_id, {
        id: link.digital_product_id,
        variant_id: link.product_variant_id,
        definition: digitalProductLinkDefinition(
          link.product_variant_id,
          link.digital_product_id
        ),
      })
    }
    for (const product of unlinkedProducts) {
      candidates.set(product.id, { id: product.id })
    }

    const cleaned: UnknownRecord[] = []
    for (const candidate of candidates.values()) {
      if (input.dry_run) {
        cleaned.push({ digital_product_id: candidate.id, action: "would_delete" })
        continue
      }
      if (candidate.definition) {
        await remoteLink.dismiss([candidate.definition]).catch(() => undefined)
      }
      const action = await safelyDeleteOrArchiveProduct(
        service,
        candidate.id,
        "orphan_cleanup"
      )
      cleaned.push({ digital_product_id: candidate.id, action })
    }

    // Expired capability records are safe to purge/mark independently of
    // durable ownership. Entitlements themselves are never deleted here.
    const now = new Date()
    const expiredGrants = await service.listDownloadGrants(
      { status: "active", expires_at: { $lte: now } },
      { take: limit }
    )
    if (!input.dry_run && expiredGrants.length) {
      await service.updateDownloadGrants(
        expiredGrants.map((grant: UnknownRecord) => ({
          id: grant.id,
          status: "expired",
        }))
      )
    }

    return new StepResponse({
      cleaned,
      expired_grant_ids: expiredGrants.map((grant: UnknownRecord) => grant.id),
      dry_run: Boolean(input.dry_run),
    })
  }
)

const expireEntitlementsStep = createStep(
  "expire-entitlements",
  async (input: ExpireEntitlementsWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const asOf = input.as_of ? new Date(input.as_of) : new Date()
    if (Number.isNaN(asOf.getTime())) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "as_of must be a valid date"
      )
    }
    const limit = Math.max(1, Math.min(1000, input.limit ?? 250))
    const candidates = await service.listDigitalEntitlements(
      {
        status: DigitalEntitlementStatus.ACTIVE,
        expires_at: { $lte: asOf },
      },
      { take: limit, order: { expires_at: "ASC" } }
    )
    const repairCandidates =
      await service.listLifecycleNotificationRepairCandidates({
        limit,
        as_of: asOf,
      })
    const expired: UnknownRecord[] = []
    const repaired: UnknownRecord[] = []
    const notificationEvents: UnknownRecord[] = []

    for (const candidate of candidates) {
      const result = await service.expireEntitlementIfDue({
        entitlement_id: candidate.id,
        as_of: asOf,
        reason: "Entitlement access period expired",
      })
      if (!result.expired) {
        continue
      }
      const entitlement = result.entitlement
      expired.push(entitlement)
      if (result.delivery) {
        notificationEvents.push({ delivery_id: result.delivery.id })
      }
    }

    for (const candidate of repairCandidates) {
      const result = await service.repairLifecycleNotification({
        entitlement_id: candidate.id,
        expected_status: candidate.status,
        reason: candidate.reason,
      })
      if (!result.repaired) {
        continue
      }
      repaired.push(result.entitlement)
      if (result.delivery) {
        notificationEvents.push({ delivery_id: result.delivery.id })
      }
    }

    return new StepResponse({
      expired,
      repaired,
      notification_events: notificationEvents,
      as_of: asOf.toISOString(),
    })
  }
)

const retryDigitalOperationsStep = createStep(
  "retry-digital-operations",
  async (input: RetryDigitalOperationsWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const now = input.as_of ? new Date(input.as_of) : new Date()
    const limit = Math.max(1, Math.min(100, input.limit ?? 25))
    const workerId = `digital-downloads-retry-${now.getTime()}`
    const claimed = await service.claimFulfillmentOperations(workerId, limit, 120)
    return new StepResponse({
      claimed,
      order_ids: [...new Set(claimed.map((operation: UnknownRecord) => operation.order_id))],
      stale_operation_ids: [],
    })
  }
)

const retryNotificationDeliveriesStep = createStep(
  "retry-notification-deliveries",
  async (input: RetryDigitalOperationsWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const now = input.as_of ? new Date(input.as_of) : new Date()
    const limit = Math.max(1, Math.min(100, input.limit ?? 25))
    const workerId = `digital-downloads-notification-${now.getTime()}`
    const claimed = await service.claimNotificationDeliveries(workerId, limit, 120)
    return new StepResponse({
      claimed,
      notification_events: claimed.map((delivery: UnknownRecord) => ({
        delivery_id: delivery.id,
      })),
      stale_delivery_ids: [],
    })
  }
)

export const cleanupDigitalVariantWorkflow = createWorkflow(
  { name: "digital-downloads-cleanup-variant", idempotent: true, store: true },
  (input: CleanupDigitalVariantWorkflowInput) =>
    new WorkflowResponse(cleanupDigitalVariantStep(input))
)

export const cleanupOrphanedDigitalProductsWorkflow = createWorkflow(
  { name: "digital-downloads-cleanup-orphans", idempotent: true, store: true },
  (input: CleanupOrphanedDigitalProductsWorkflowInput) =>
    new WorkflowResponse(cleanupOrphanedDigitalProductsStep(input))
)

export const expireEntitlementsWorkflow = createWorkflow(
  { name: "digital-downloads-expire-entitlements", idempotent: true, store: true },
  (input: ExpireEntitlementsWorkflowInput) => {
    const result = expireEntitlementsStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_EXPIRED,
      data: result.expired,
    }).config({ name: "digital-downloads-emit-expired" })
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      data: result.notification_events,
    }).config({ name: "digital-downloads-emit-expiry-notifications" })
    return new WorkflowResponse(result)
  }
)

export const retryDigitalOperationsWorkflow = createWorkflow(
  { name: "digital-downloads-retry-operations", idempotent: true, store: true },
  (input: RetryDigitalOperationsWorkflowInput) =>
    new WorkflowResponse(retryDigitalOperationsStep(input))
)

export const retryNotificationDeliveriesWorkflow = createWorkflow(
  { name: "digital-downloads-retry-notifications", idempotent: true, store: true },
  (input: RetryDigitalOperationsWorkflowInput) =>
    new WorkflowResponse(retryNotificationDeliveriesStep(input))
)
