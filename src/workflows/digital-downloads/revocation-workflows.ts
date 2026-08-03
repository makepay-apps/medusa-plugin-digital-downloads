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

const resolveRevocationOrderStep = createStep(
  "resolve-revocation-order",
  async (input: RevokeOrderEntitlementsWorkflowInput, { container }) => {
    const orderId = await resolveBoundOrderId(
      container,
      input.order_id ?? input.orderId,
      input.payment_id ?? input.paymentId
    )
    if (!orderId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "order_id or a payment linked to an order is required"
      )
    }
    return new StepResponse({ ...input, order_id: orderId })
  }
)

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
  async (
    input: RevokeOrderEntitlementsWorkflowInput & { order_id: string },
    { container }
  ) => {
    const orderId = input.order_id
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

    const result = await service.revokeOrderEntitlements({
      order_id: orderId,
      line_item_ids: [...lineItemIds],
      reason: input.reason,
      trigger: input.trigger,
      notify: true,
      actor: {
        type: "workflow",
        id: input.trigger ?? "manual",
      },
    })

    return new StepResponse({
      order_id: orderId,
      revoked: result.revoked,
      notification_events: result.deliveries.map((delivery: UnknownRecord) => ({
        delivery_id: delivery.id,
      })),
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
    const result = await service.revokeEntitlementWithNotification({
      entitlement_id: id,
      reason: input.reason,
      actor: input.actor
        ? { type: "admin", id: input.actor }
        : { type: "workflow" },
      notify: input.notify,
    })
    return new StepResponse({
      entitlement: result.entitlement,
      notification_events: result.delivery
        ? [{ delivery_id: result.delivery.id }]
        : [],
    })
  }
)

const reissueEntitlementStep = createStep(
  "reissue-entitlement",
  async (input: ReissueEntitlementWorkflowInput, { container }) => {
    const id = requireIdentifier(input, "entitlement_id", "entitlementId")
    const service = resolveDigitalDownloadsService(container)
    const expiresAt = input.expires_at !== undefined
      ? input.expires_at
      : input.expiresAt
    const reissued = await service.reissueEntitlement({
      entitlement_id: id,
      reason: input.reason ?? "manual reissue",
      reset_downloads:
        input.reset_downloads ?? input.resetDownloads ?? false,
      rotate_guest_token:
        input.rotate_guest_token ?? input.rotateGuestToken ?? true,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      // The notification worker creates a pending capability, redacts it from
      // Medusa's persisted notification, and only then activates it. Minting
      // here would leave an unreachable active capability beside that token.
      create_guest_access: false,
      notify: input.notify ?? true,
    })
    const entitlement = reissued.entitlement
    const delivery = reissued.delivery
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
    const resolved = resolveRevocationOrderStep(input)
    const orderId = transform(
      resolved,
      (data) => data.order_id
    )
    const lockKey = transform(orderId, (id) => `digital-downloads:order:${id}`)
    acquireLockStep({ key: lockKey, ttl: 120, timeout: 30, executeOnSubWorkflow: true })
    const result = revokeOrderEntitlementsStep(resolved)
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

export function sentNotificationRecoveryAttemptCount(
  delivery: UnknownRecord
): number {
  const attempt = Math.max(1, Number(delivery.attempt_count ?? 0))
  const maxAttempts = Math.max(1, Number(delivery.max_attempts ?? 8))
  return Math.min(attempt, maxAttempts - 1)
}

/**
 * Keeps post-send work retryable after the provider result and any bearer
 * capability have been durably checkpointed and redacted. The claim service
 * increments attempt_count and rejects rows already at max_attempts, so this
 * reserves one attempt slot for activation/finalization recovery. Repeated
 * recovery failures reuse that slot; the sent_redacted checkpoint ensures the
 * subscriber never crosses the provider boundary again.
 */
export async function markSentNotificationRecoveryFailed(
  service: any,
  delivery: UnknownRecord,
  error: unknown
): Promise<void> {
  const attempt = Math.max(1, Number(delivery.attempt_count ?? 0))
  await service.updateNotificationDeliveries({
    id: delivery.id,
    state: NotificationDeliveryState.FAILED,
    attempt_count: sentNotificationRecoveryAttemptCount(delivery),
    last_attempt_at: new Date(),
    next_retry_at: computeBackoffDate(attempt),
    lease_owner: null,
    lease_expires_at: null,
    error_code: "notification_failed",
    error_message: error instanceof Error ? error.message.slice(0, 2000) : String(error),
  })
}
