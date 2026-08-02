import {
  acquireLockStep,
  emitEventStep,
  releaseLockStep,
} from "@medusajs/medusa/core-flows"
import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  ContainerRegistrationKeys,
  MedusaError,
} from "@medusajs/framework/utils"
import {
  DigitalEntitlementStatus,
  NotificationDeliveryState,
} from "../../modules/digital-downloads/types"
import { DIGITAL_DOWNLOAD_EVENTS } from "./events"
import { resolveDigitalDownloadsService } from "./service-helpers"
import type {
  EmitDigitalNotificationWorkflowInput,
  ReissueEntitlementWorkflowInput,
  RevokeEntitlementWorkflowInput,
  RevokeOrderEntitlementsWorkflowInput,
  UnknownRecord,
} from "./types"
import {
  computeBackoffDate,
  requireIdentifier,
  shouldRevokeForRefund,
  toFiniteAmount,
} from "./utils"

const TERMINAL_STATUSES = new Set([
  DigitalEntitlementStatus.REVOKED,
  DigitalEntitlementStatus.REFUNDED,
  DigitalEntitlementStatus.EXPIRED,
])

async function resolveOrderIdFromPayment(
  container: any,
  paymentId: string
): Promise<string | undefined> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const result = await query.graph({
    entity: "payments",
    fields: ["id", "payment_collection.order.id"],
    filters: { id: paymentId },
  })
  return result.data?.[0]?.payment_collection?.order?.id
}

async function resolveBoundOrderId(
  container: any,
  orderId: string | undefined,
  paymentId: string | undefined
): Promise<string | undefined> {
  if (!paymentId) {
    return orderId
  }

  const paymentOrderId = await resolveOrderIdFromPayment(container, paymentId)
  if (!paymentOrderId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Payment is not linked to an order"
    )
  }
  if (orderId && paymentOrderId !== orderId) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Payment does not belong to the supplied order"
    )
  }

  return orderId ?? paymentOrderId
}

async function retrieveOrderForRevocation(
  container: any,
  orderId: string
): Promise<UnknownRecord> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const result = await query.graph({
    entity: "order",
    fields: [
      "id",
      "total",
      "original_total",
      "summary",
      "refund_total",
      "payment_collections.amount",
      "payment_collections.captured_amount",
      "payment_collections.payments.id",
      "payment_collections.payments.refunds.amount",
      "payment_collections.payments.refunds.raw_amount",
    ],
    filters: { id: orderId },
  })
  if (!result.data?.[0]) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Order ${orderId} was not found`
    )
  }
  return result.data[0]
}

export function aggregateRefunds(order: UnknownRecord): number {
  const nestedRefunds = (order.payment_collections ?? []).reduce(
    (collectionTotal: number, collection: UnknownRecord) =>
      collectionTotal +
      (collection.payments ?? []).reduce(
        (paymentTotal: number, payment: UnknownRecord) =>
          paymentTotal +
          (payment.refunds ?? []).reduce(
            (refundTotal: number, refund: UnknownRecord) =>
              refundTotal + toFiniteAmount(refund.raw_amount ?? refund.amount),
            0
          ),
        0
      ),
    0
  )
  return Math.max(
    Math.abs(toFiniteAmount(order.refund_total)),
    Math.abs(toFiniteAmount(order.summary?.refunded_total)),
    Math.abs(toFiniteAmount(order.summary?.raw_refunded_total)),
    Math.abs(nestedRefunds)
  )
}

export function orderTotalForRefundPolicy(order: UnknownRecord): number {
  const collectionTotal = (order.payment_collections ?? []).reduce(
    (total: number, collection: UnknownRecord) =>
      total + Math.abs(toFiniteAmount(collection.amount)),
    0
  )
  return Math.max(
    Math.abs(toFiniteAmount(order.original_total)),
    Math.abs(toFiniteAmount(order.summary?.original_order_total)),
    Math.abs(toFiniteAmount(order.summary?.raw_original_order_total)),
    collectionTotal,
    Math.abs(toFiniteAmount(order.total))
  )
}

async function createNotificationOutbox(
  service: any,
  input: {
    entitlement: UnknownRecord
    type: string
    data?: UnknownRecord
  }
): Promise<UnknownRecord | undefined> {
  const { entitlement, type } = input
  if (!entitlement.customer_email) {
    return undefined
  }

  const template = `digital-downloads-${type.replace(/_/g, "-")}`
  const notificationVersion =
    input.data?.notification_idempotency_key ?? "v1"
  const idempotencyKey = `${entitlement.id}:${type}:${notificationVersion}`
  const payloadData = { ...(input.data ?? {}) }
  delete payloadData.notification_idempotency_key
  const existing = await service.listNotificationDeliveries(
    { idempotency_key: idempotencyKey },
    { take: 1 }
  )
  if (existing.length) {
    return existing[0]
  }

  try {
    return await service.createNotificationDeliveries({
      entitlement_id: entitlement.id,
      idempotency_key: idempotencyKey,
      channel: "email",
      template,
      recipient_hash: await service.recipientHash(entitlement.customer_email),
      state: NotificationDeliveryState.PENDING,
      attempt_count: 0,
      max_attempts: 8,
      payload: {
        entitlement_id: entitlement.id,
        order_id: entitlement.order_id,
        notification_type: type,
        ...payloadData,
      },
      metadata: {},
    })
  } catch (error) {
    const raced = await service.listNotificationDeliveries(
      { idempotency_key: idempotencyKey },
      { take: 1 }
    )
    if (raced.length) {
      return raced[0]
    }
    throw error
  }
}

const revokeOrderEntitlementsStep = createStep(
  "revoke-order-entitlements",
  async (input: RevokeOrderEntitlementsWorkflowInput, { container }) => {
    const paymentId = input.payment_id ?? input.paymentId
    let orderId = input.order_id ?? input.orderId
    orderId = await resolveBoundOrderId(container, orderId, paymentId)
    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "order_id or a payment linked to an order is required"
      )
    }

    const service = resolveDigitalDownloadsService(container)
    const policy = input.policy ?? (input.trigger === "refund" ? "full_refund" : "all")
    const lineItemIds = new Set(input.line_item_ids ?? input.lineItemIds ?? [])
    const order = await retrieveOrderForRevocation(container, orderId)
    const refundedTotal =
      input.refunded_amount !== undefined
        ? toFiniteAmount(input.refunded_amount)
        : aggregateRefunds(order)
    const shouldRevoke =
      policy === "retain"
        ? false
        : input.trigger !== "refund" ||
          shouldRevokeForRefund({
            policy,
            orderTotal: orderTotalForRefundPolicy(order),
            refundedTotal,
            hasSelectedLineItems: lineItemIds.size > 0,
          })

    if (!shouldRevoke) {
      return new StepResponse({
        order_id: orderId,
        revoked: [],
        notification_events: [],
        retained: true,
        policy,
      })
    }

    const entitlements = await service.listDigitalEntitlements(
      { order_id: orderId },
      { take: 10_000 }
    )
    const selected = entitlements.filter(
      (entitlement: UnknownRecord) =>
        (!lineItemIds.size || lineItemIds.has(entitlement.order_line_item_id)) &&
        !TERMINAL_STATUSES.has(entitlement.status)
    )
    const revoked: UnknownRecord[] = []
    const notificationEvents: UnknownRecord[] = []

    for (const entitlement of selected) {
      let updated = await service.revokeEntitlement(entitlement.id, input.reason, {
        type: "workflow",
        id: input.trigger ?? "manual",
      })
      if (input.trigger === "refund") {
        updated = await service.updateDigitalEntitlements({
          id: updated.id,
          status: DigitalEntitlementStatus.REFUNDED,
        })
      }
      revoked.push(updated)
      const delivery = await createNotificationOutbox(service, {
        entitlement: updated,
        type: "revoked",
        data: { reason: input.reason },
      })
      if (delivery) {
        notificationEvents.push({ delivery_id: delivery.id })
      }
    }

    return new StepResponse({
      order_id: orderId,
      revoked,
      notification_events: notificationEvents,
      retained: false,
      policy,
    })
  }
)

const revokeEntitlementStep = createStep(
  "revoke-entitlement",
  async (input: RevokeEntitlementWorkflowInput, { container }) => {
    const id = requireIdentifier(input, "entitlement_id", "entitlementId")
    const service = resolveDigitalDownloadsService(container)
    const entitlement = await service.revokeEntitlement(
      id,
      input.reason,
      input.actor ? { type: "admin", id: input.actor } : { type: "workflow" }
    )
    const delivery = input.notify === false
      ? undefined
      : await createNotificationOutbox(service, {
          entitlement,
          type: "revoked",
          data: { reason: input.reason },
        })
    return new StepResponse({
      entitlement,
      notification_events: delivery ? [{ delivery_id: delivery.id }] : [],
    })
  }
)

const reissueEntitlementStep = createStep(
  "reissue-entitlement",
  async (input: ReissueEntitlementWorkflowInput, { container }) => {
    const id = requireIdentifier(input, "entitlement_id", "entitlementId")
    const service = resolveDigitalDownloadsService(container)
    const reissued = await service.reissueEntitlement({
      entitlement_id: id,
      reason: input.reason ?? "manual reissue",
      reset_downloads:
        input.reset_downloads ?? input.resetDownloads ?? false,
      rotate_guest_token:
        input.rotate_guest_token ?? input.rotateGuestToken ?? true,
      notify: input.notify ?? true,
    })
    const entitlement = reissued.entitlement
    const guestAccessIdempotencyKey =
      reissued.guest_access?.session?.idempotency_key
    const delivery = input.notify === false
      ? undefined
      : await createNotificationOutbox(service, {
          entitlement,
          type: "reissued",
          data: {
            reason: input.reason ?? "manual reissue",
            notification_idempotency_key:
              guestAccessIdempotencyKey ??
              entitlement.updated_at ??
              "reissue",
            ...(guestAccessIdempotencyKey
              ? {
                  guest_access: true,
                  guest_access_idempotency_key:
                    guestAccessIdempotencyKey,
                }
              : {}),
          },
        })
    return new StepResponse({
      entitlement,
      delivery,
      notification_events: delivery ? [{ delivery_id: delivery.id }] : [],
    })
  }
)

const enqueueNotificationStep = createStep(
  "enqueue-notification",
  async (input: EmitDigitalNotificationWorkflowInput, { container }) => {
    const service = resolveDigitalDownloadsService(container)
    const entitlementId = input.entitlement_id ?? input.entitlementId
    const entitlements = entitlementId
      ? [await service.retrieveDigitalEntitlement(entitlementId)]
      : await service.listDigitalEntitlements(
          { order_id: input.order_id ?? input.orderId },
          { take: 10_000 }
        )
    const deliveries: UnknownRecord[] = []

    for (const entitlement of entitlements) {
      const delivery = await createNotificationOutbox(service, {
        entitlement,
        type: input.type,
        data: input.data,
      })
      if (delivery) {
        deliveries.push(delivery)
      }
    }
    return new StepResponse({
      deliveries,
      notification_events: deliveries.map((delivery) => ({
        delivery_id: delivery.id,
      })),
    })
  }
)

export const revokeOrderEntitlementsWorkflow = createWorkflow(
  { name: "digital-downloads-revoke-order", idempotent: true, store: true },
  (input: RevokeOrderEntitlementsWorkflowInput) => {
    const resourceId = transform(
      input,
      (data) => data.order_id ?? data.orderId ?? data.payment_id ?? data.paymentId ?? "missing"
    )
    const lockKey = transform(resourceId, (id) => `digital-downloads:revoke:${id}`)
    acquireLockStep({ key: lockKey, ttl: 120, timeout: 30, executeOnSubWorkflow: true })
    const result = revokeOrderEntitlementsStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_REVOKED,
      data: result.revoked,
    }).config({ name: "digital-downloads-emit-order-revocations" })
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      data: result.notification_events,
    }).config({ name: "digital-downloads-emit-order-revocation-notifications" })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const revokeEntitlementWorkflow = createWorkflow(
  { name: "digital-downloads-revoke-entitlement", idempotent: true, store: true },
  (input: RevokeEntitlementWorkflowInput) => {
    const id = transform(
      input,
      (data) => data.entitlement_id ?? data.entitlementId ?? "missing"
    )
    const lockKey = transform(id, (value) => `digital-downloads:entitlement:${value}`)
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = revokeEntitlementStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_REVOKED,
      data: result.entitlement,
    }).config({ name: "digital-downloads-emit-single-revocation" })
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      data: result.notification_events,
    }).config({ name: "digital-downloads-emit-single-revocation-notification" })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const reissueEntitlementWorkflow = createWorkflow(
  { name: "digital-downloads-reissue-entitlement", idempotent: true, store: true },
  (input: ReissueEntitlementWorkflowInput) => {
    const id = transform(
      input,
      (data) => data.entitlement_id ?? data.entitlementId ?? "missing"
    )
    const lockKey = transform(id, (value) => `digital-downloads:entitlement:${value}`)
    acquireLockStep({ key: lockKey, ttl: 60, timeout: 10, executeOnSubWorkflow: true })
    const result = reissueEntitlementStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_REISSUED,
      data: result.entitlement,
    }).config({ name: "digital-downloads-emit-reissue" })
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      data: result.notification_events,
    }).config({ name: "digital-downloads-emit-reissue-notification" })
    releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
    return new WorkflowResponse(result)
  }
)

export const emitDigitalNotificationWorkflow = createWorkflow(
  { name: "digital-downloads-enqueue-notification", idempotent: true, store: true },
  (input: EmitDigitalNotificationWorkflowInput) => {
    const result = enqueueNotificationStep(input)
    emitEventStep({
      eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      data: result.notification_events,
    })
    return new WorkflowResponse(result)
  }
)

export async function markNotificationFailed(
  service: any,
  delivery: UnknownRecord,
  error: unknown
): Promise<void> {
  const attempt = Math.max(1, Number(delivery.attempt_count ?? 0))
  const terminal = attempt >= Number(delivery.max_attempts ?? 8)
  await service.updateNotificationDeliveries({
    id: delivery.id,
    state: terminal
      ? NotificationDeliveryState.DEAD_LETTER
      : NotificationDeliveryState.FAILED,
    attempt_count: attempt,
    last_attempt_at: new Date(),
    next_retry_at: terminal ? null : computeBackoffDate(attempt),
    lease_owner: null,
    lease_expires_at: null,
    error_code: "notification_failed",
    error_message: error instanceof Error ? error.message.slice(0, 2000) : String(error),
  })
}
