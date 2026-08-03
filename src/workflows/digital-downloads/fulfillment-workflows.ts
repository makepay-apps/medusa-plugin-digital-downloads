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
  Modules,
} from "@medusajs/framework/utils"
import {
  DigitalEntitlementStatus,
  DigitalProductStatus,
  FulfillmentOperationState,
  NotificationDeliveryState,
} from "../../modules/digital-downloads/types"
import {
  isFulfillmentStrategy,
  type FulfillmentStrategy,
} from "../../product-config-metadata"
import { DIGITAL_DOWNLOAD_EVENTS } from "./events"
import {
  ensureOrderAndCustomerLinks,
  getLinkService,
  resolveDigitalDownloadsService,
} from "./service-helpers"
import type {
  FulfillDigitalItemsWorkflowInput,
  IssueOrderEntitlementsWorkflowInput,
  UnknownRecord,
} from "./types"
import {
  buildPurchaseSnapshot,
  computeBackoffDate,
  MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER,
  normalizeQuantity,
  requireIdentifier,
  selectPurchasableRelease,
  toFiniteAmount,
} from "./utils"

const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "customer_id",
  "customer.id",
  "customer.has_account",
  "currency_code",
  "region_id",
  "status",
  "payment_status",
  "total",
  "refund_total",
  "created_at",
  "metadata",
  "shipping_address.first_name",
  "shipping_address.last_name",
  "billing_address.first_name",
  "billing_address.last_name",
  "items.id",
  "items.title",
  "items.subtitle",
  "items.thumbnail",
  "items.quantity",
  "items.raw_quantity",
  "items.detail.quantity",
  "items.detail.raw_quantity",
  "items.unit_price",
  "items.raw_unit_price",
  "items.variant_id",
  "items.product_id",
  "items.metadata",
  "payment_collections.id",
  "payment_collections.amount",
  "payment_collections.captured_amount",
  "payment_collections.status",
  "payment_collections.payments.id",
  "payment_collections.payments.amount",
  "payment_collections.payments.captured_at",
  "payment_collections.payments.captures.id",
  "payment_collections.payments.captures.amount",
  "payment_collections.payments.captures.raw_amount",
]

function customerName(order: UnknownRecord): string | undefined {
  const address = order.billing_address ?? order.shipping_address
  const value = [address?.first_name, address?.last_name].filter(Boolean).join(" ")
  return value || undefined
}

export function registeredCustomerId(order: UnknownRecord): string | null {
  return order.customer?.has_account === true &&
    typeof order.customer_id === "string" &&
    order.customer_id
    ? order.customer_id
    : null
}

function calculateExpiry(
  order: UnknownRecord,
  digitalProduct: UnknownRecord
): Date | null {
  const metadata = digitalProduct.metadata ?? {}
  const seconds = Number(metadata.access_duration_seconds ?? 0)
  const days = Number(
    metadata.access_duration_days ?? metadata.expires_in_days ?? 0
  )
  const duration =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : Number.isFinite(days) && days > 0
        ? days * 86_400_000
        : 0

  if (!duration) {
    return null
  }

  const purchasedAt = new Date(order.created_at ?? Date.now())
  return new Date(purchasedAt.getTime() + duration)
}

async function upsertFulfillmentOperation(
  service: any,
  row: UnknownRecord,
  payload: UnknownRecord
): Promise<UnknownRecord> {
  const existing = await service.listFulfillmentOperations(
    { idempotency_key: row.idempotency_key },
    { take: 1 }
  )
  if (existing.length) {
    return existing[0]
  }

  try {
    return await service.createFulfillmentOperations({
      idempotency_key: row.idempotency_key,
      order_id: row.order_id,
      order_line_item_id: row.line_item_id,
      unit_index: row.unit_index,
      digital_product_id: row.digital_product_id,
      digital_product_release_id: row.digital_product_release_id ?? null,
      state: FulfillmentOperationState.PENDING,
      attempt_count: 0,
      max_attempts: 8,
      payload,
      metadata: {},
    })
  } catch (error) {
    const raced = await service.listFulfillmentOperations(
      { idempotency_key: row.idempotency_key },
      { take: 1 }
    )
    if (raced.length) {
      return raced[0]
    }
    throw error
  }
}

async function completeOperation(
  service: any,
  operation: UnknownRecord,
  entitlement: UnknownRecord
): Promise<UnknownRecord> {
  if (operation.state === FulfillmentOperationState.COMPLETED) {
    return operation
  }

  return service.updateFulfillmentOperations({
    id: operation.id,
    entitlement_id: entitlement.id,
    state: FulfillmentOperationState.COMPLETED,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    error_code: null,
    error_message: null,
    completed_at: new Date(),
  })
}

async function failOperation(
  service: any,
  operation: UnknownRecord,
  error: unknown,
  code = "fulfillment_failed"
): Promise<UnknownRecord> {
  const alreadyCountedByClaim =
    operation.state === FulfillmentOperationState.PROCESSING &&
    Boolean(operation.lease_owner)
  const attempts = Math.max(
    1,
    Number(operation.attempt_count ?? 0) + (alreadyCountedByClaim ? 0 : 1)
  )
  const terminal = attempts >= Number(operation.max_attempts ?? 8)
  return service.updateFulfillmentOperations({
    id: operation.id,
    state: terminal
      ? FulfillmentOperationState.DEAD_LETTER
      : FulfillmentOperationState.FAILED,
    attempt_count: attempts,
    last_attempt_at: new Date(),
    next_retry_at: terminal ? null : computeBackoffDate(attempts),
    lease_owner: null,
    lease_expires_at: null,
    error_code: code,
    error_message: error instanceof Error ? error.message.slice(0, 2000) : String(error),
    error_details: {},
  })
}

async function deferOperation(
  service: any,
  operation: UnknownRecord,
  strategy: FulfillmentStrategy | null
): Promise<UnknownRecord> {
  const validStrategy = strategy !== null
  return service.updateFulfillmentOperations({
    id: operation.id,
    state: FulfillmentOperationState.PENDING,
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: new Date(Date.now() + 15 * 60 * 1000),
    error_code: validStrategy
      ? `awaiting_${strategy}`
      : "invalid_fulfillment_strategy",
    error_message: validStrategy
      ? `Fulfillment is waiting for ${strategy}`
      : "Fulfillment is waiting for a valid fulfillment strategy configuration",
  })
}

export function fulfillmentStrategyReady(
  strategy: unknown,
  source: IssueOrderEntitlementsWorkflowInput["source"],
  order: UnknownRecord,
  force = false
): boolean {
  if (force || source === "manual") {
    return true
  }
  if (!isFulfillmentStrategy(strategy)) {
    return false
  }
  if (strategy === "manual") {
    return false
  }
  if (strategy === "order_completed") {
    return (
      source === "order.completed" ||
      ["completed", "archived"].includes(String(order.status).toLowerCase())
    )
  }
  if (strategy === "payment_captured") {
    const paymentCollections = Array.isArray(order.payment_collections)
      ? order.payment_collections
      : []
    const paymentCollectionAmount = paymentCollections.reduce(
      (total: number, collection: UnknownRecord) =>
        total + Math.max(0, toFiniteAmount(collection.amount)),
      0
    )
    const capturedAmount = paymentCollections.reduce(
      (total: number, collection: UnknownRecord) => {
        const projected = toFiniteAmount(collection.captured_amount)
        if (projected > 0) {
          return total + projected
        }
        const payments = Array.isArray(collection.payments)
          ? collection.payments
          : []
        return (
          total +
          payments.reduce((paymentTotal: number, payment: UnknownRecord) => {
            const captures = Array.isArray(payment.captures)
              ? payment.captures
              : []
            if (captures.length) {
              return (
                paymentTotal +
                captures.reduce(
                  (captureTotal: number, capture: UnknownRecord) =>
                    captureTotal +
                    Math.max(
                      0,
                      toFiniteAmount(capture.amount ?? capture.raw_amount)
                    ),
                  0
                )
              )
            }
            return payment.captured_at
              ? paymentTotal + Math.max(0, toFiniteAmount(payment.amount))
              : paymentTotal
          }, 0)
        )
      },
      0
    )
    const requiredAmount =
      paymentCollectionAmount > 0
        ? paymentCollectionAmount
        : Math.max(0, toFiniteAmount(order.total))
    return (
      requiredAmount === 0 ||
      (capturedAmount > 0 && capturedAmount + Number.EPSILON >= requiredAmount) ||
      ["captured", "paid"].includes(
        String(order.payment_status).toLowerCase()
      )
    )
  }
  return false
}

async function enqueueDeliveryNotification(
  service: any,
  entitlement: UnknownRecord
): Promise<UnknownRecord | undefined> {
  if (!entitlement.customer_email) {
    return undefined
  }

  const idempotencyKey = `${entitlement.id}:delivery:v1`
  const existing = await service.listNotificationDeliveries(
    { idempotency_key: idempotencyKey },
    { take: 1 }
  )
  if (existing.length) {
    return existing[0]
  }

  const guestAccessEpoch = Number(entitlement.guest_access_epoch ?? 0)
  if (
    !Number.isSafeInteger(guestAccessEpoch) ||
    guestAccessEpoch < 0 ||
    guestAccessEpoch > 2_147_483_647
  ) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Guest access epoch is invalid"
    )
  }

  try {
    return await service.createNotificationDeliveries({
      entitlement_id: entitlement.id,
      idempotency_key: idempotencyKey,
      channel: "email",
      template: "digital-downloads-delivery",
      recipient_hash: await service.recipientHash(entitlement.customer_email),
      state: NotificationDeliveryState.PENDING,
      attempt_count: 0,
      max_attempts: 8,
      payload: {
        entitlement_id: entitlement.id,
        order_id: entitlement.order_id,
        digital_product_id: entitlement.digital_product_id,
        ...(!entitlement.customer_id
          ? {
              guest_access: true,
              guest_access_epoch: guestAccessEpoch,
            }
          : {}),
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

async function retrieveOrder(container: any, orderId: string): Promise<UnknownRecord> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY) as any
  const result = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    filters: { id: orderId },
  })
  const order = result.data?.[0]
  if (!order) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Order ${orderId} was not found`
    )
  }
  return order
}

async function retrieveLinkedDigitalProducts(
  container: any,
  service: any,
  variantIds: string[]
): Promise<Map<string, UnknownRecord>> {
  if (!variantIds.length) {
    return new Map()
  }

  const linkService = getLinkService(
    container,
    Modules.PRODUCT,
    "product_variant_id",
    "digital_product_id"
  )
  const links = await linkService.list(
    { product_variant_id: variantIds },
    { take: Math.max(100, variantIds.length * 2) }
  )
  const digitalProductIds = [
    ...new Set(
      links
        .map(
          (entry: UnknownRecord) =>
            entry.digital_product_id ?? entry.digitalProductId
        )
        .filter(Boolean)
    ),
  ]
  const products = digitalProductIds.length
    ? await service.listDigitalProducts(
        { id: digitalProductIds },
        { relations: ["releases", "releases.assets", "license_policy"] }
      )
    : []
  const productById = new Map(
    products.map((product: UnknownRecord) => [product.id, product])
  )
  const result = new Map<string, UnknownRecord>()

  for (const link of links) {
    const variantId = link.product_variant_id
    const digitalProductId =
      link.digital_product_id ?? link.digitalProductId
    const product = productById.get(digitalProductId)
    if (variantId && product) {
      result.set(variantId, product)
    }
  }

  return result
}

export const issueOrderEntitlementsStep = createStep(
  "issue-order-entitlements",
  async (
    input: IssueOrderEntitlementsWorkflowInput & {
      line_item_ids?: string[]
      lineItemIds?: string[]
    },
    { container }
  ) => {
    const orderId = requireIdentifier(input, "order_id", "orderId")
    const service = resolveDigitalDownloadsService(container)
    const order = await retrieveOrder(container, orderId)
    const selectedLineItems = new Set(
      input.line_item_ids ?? input.lineItemIds ?? []
    )
    const items = (order.items ?? []).filter(
      (item: UnknownRecord) =>
        !selectedLineItems.size || selectedLineItems.has(item.id)
    )
    const variantIds = [
      ...new Set(items.map((item: UnknownRecord) => item.variant_id).filter(Boolean)),
    ] as string[]
    const productByVariant = await retrieveLinkedDigitalProducts(
      container,
      service,
      variantIds
    )
    const preparedItems = items.map((item: UnknownRecord) => {
      const digitalProduct = productByVariant.get(item.variant_id)
      return {
        item,
        digitalProduct,
        quantity: digitalProduct
          ? normalizeQuantity(
              item.quantity ??
                item.raw_quantity ??
                item.detail?.quantity ??
                item.detail?.raw_quantity
            )
          : 0,
      }
    })
    const digitalUnitCount = preparedItems.reduce(
      (total, prepared) => total + prepared.quantity,
      0
    )
    if (digitalUnitCount > MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `An order cannot exceed ${MAX_DIGITAL_ENTITLEMENT_UNITS_PER_ORDER} digital entitlement units`
      )
    }
    const entitlements: UnknownRecord[] = []
    const operations: UnknownRecord[] = []
    const failures: UnknownRecord[] = []
    const deferred: UnknownRecord[] = []
    const skippedLineItems: string[] = []

    for (const { item, digitalProduct, quantity } of preparedItems) {
      if (!digitalProduct) {
        // This is the expected path for physical items in a mixed order.
        skippedLineItems.push(item.id)
        continue
      }

      const release = selectPurchasableRelease(digitalProduct)
      const deliveryType = String(digitalProduct.delivery_type ?? "download")
      const active =
        digitalProduct.status === DigitalProductStatus.ACTIVE ||
        digitalProduct.status === "active"
      const configuredFulfillmentStrategy =
        digitalProduct.metadata?.fulfillment_strategy
      const fulfillmentStrategy = isFulfillmentStrategy(
        configuredFulfillmentStrategy
      )
        ? configuredFulfillmentStrategy
        : null

      for (let unitIndex = 0; unitIndex < quantity; unitIndex++) {
        const idempotencyKey = `${order.id}:${item.id}:${unitIndex}`
        const row: UnknownRecord = {
          idempotency_key: idempotencyKey,
          order_id: order.id,
          line_item_id: item.id,
          // Medusa assigns an internal customer row to anonymous carts too.
          // Only rows with an actual account are authorization principals;
          // has_account=false orders must receive guest-capability delivery.
          customer_id: registeredCustomerId(order),
          email: order.email ?? null,
          customer_name: customerName(order),
          digital_product_id: digitalProduct.id,
          digital_product_release_id: release?.id ?? null,
          unit_index: unitIndex,
          quantity: 1,
          status: DigitalEntitlementStatus.ACTIVE,
          available_at: release?.available_from ?? null,
          expires_at: calculateExpiry(order, digitalProduct),
          download_limit:
            digitalProduct.metadata?.download_limit ??
            digitalProduct.metadata?.max_downloads ??
            undefined,
          license_activation_limit:
            digitalProduct.license_policy?.max_activations ?? undefined,
          snapshot: buildPurchaseSnapshot({
            order,
            lineItem: item,
            digitalProduct,
            release,
            unitIndex,
          }),
          metadata: {
            workflow_source: input.source ?? "order.placed",
          },
          // The notification worker is the sole issuer of the guest token sent
          // to the customer. Direct service callers retain the legacy default.
          create_guest_access: false,
        }
        const operation = await upsertFulfillmentOperation(service, row, row)

        if (operation.state === FulfillmentOperationState.COMPLETED) {
          const existing = await service.listDigitalEntitlements(
            { idempotency_key: idempotencyKey },
            { take: 1 }
          )
          if (existing[0]) {
            entitlements.push(existing[0])
            operations.push(operation)
            continue
          }
        }

        if (!active || !release) {
          const error = new Error(
            !active
              ? "Digital product is not active"
              : "Digital product has no published, ready release"
          )
          const failed = await failOperation(
            service,
            operation,
            error,
            !active ? "product_not_active" : "release_not_ready"
          )
          failures.push({ operation_id: failed.id, message: error.message })
          operations.push(failed)
          continue
        }

        if (
          !fulfillmentStrategyReady(
            fulfillmentStrategy,
            input.source,
            order,
            input.force
          )
        ) {
          const pending = await deferOperation(
            service,
            operation,
            fulfillmentStrategy
          )
          deferred.push({
            operation_id: pending.id,
            strategy: fulfillmentStrategy ?? "invalid",
          })
          operations.push(pending)
          continue
        }

        if (["license", "mixed"].includes(deliveryType)) {
          const licenseStrategy = String(
            digitalProduct.license_policy?.strategy ?? "none"
          ).toLowerCase()
          if (!["generated", "pool"].includes(licenseStrategy)) {
            const external = licenseStrategy === "external"
            const error = new Error(
              external
                ? "External license providers are not supported in v1"
                : "Digital product does not have a ready generated or pool license policy"
            )
            const failed = await failOperation(
              service,
              operation,
              error,
              external
                ? "external_license_strategy_unsupported"
                : "license_policy_not_ready"
            )
            failures.push({
              operation_id: failed.id,
              message: error.message,
            })
            operations.push(failed)
            continue
          }
        }

        try {
          const [issuedEntitlement] = await service.issueOrderEntitlements(row)
          const entitlement = { ...issuedEntitlement }
          // Guest tokens are return-only capabilities. The notification worker
          // deterministically derives one just-in-time from the hashed session.
          delete entitlement.guest_access

          if (
            digitalProduct.license_policy?.id &&
            ["license", "mixed"].includes(deliveryType)
          ) {
            await service.assignLicenseKey({
              entitlement_id: entitlement.id,
              license_policy_id: digitalProduct.license_policy.id,
              idempotency_key: `${entitlement.id}:license:v1`,
              metadata: { order_id: order.id },
            })
          }

          const completed = await completeOperation(service, operation, entitlement)
          entitlements.push(entitlement)
          operations.push(completed)
        } catch (error) {
          const failed = await failOperation(service, operation, error)
          failures.push({
            operation_id: failed.id,
            message: error instanceof Error ? error.message : String(error),
          })
          operations.push(failed)
        }
      }
    }

    await ensureOrderAndCustomerLinks(container, entitlements)

    const notificationEvents: UnknownRecord[] = []
    for (const entitlement of entitlements) {
      const delivery = await enqueueDeliveryNotification(service, entitlement)
      if (
        delivery &&
        [NotificationDeliveryState.PENDING, NotificationDeliveryState.FAILED].includes(
          delivery.state
        )
      ) {
        notificationEvents.push({ delivery_id: delivery.id })
      }
    }

    return new StepResponse({
      order_id: order.id,
      entitlements,
      operations,
      notification_events: notificationEvents,
      failures,
      deferred,
      skipped_line_item_ids: skippedLineItems,
    })
  }
)

function buildIssuanceWorkflow(
  name: string,
  eventSource:
    | "order.placed"
    | "order.completed"
    | "payment.captured"
    | "reconciliation"
    | "manual"
) {
  const emitStepNames = {
    entitlements: `${name}-emit-entitlements`,
    completed: `${name}-emit-completed`,
    failures: `${name}-emit-failures`,
    notifications: `${name}-emit-notifications`,
  }
  return createWorkflow(
    { name, idempotent: true, store: true, retentionTime: 7 * 24 * 60 * 60 },
    (input: any) => {
      const orderId = transform(
        input,
        (data) => data.order_id ?? data.orderId ?? "missing"
      )
      const normalizedInput = transform(input, (data) => ({
        ...data,
        source: data.source ?? eventSource,
      }))
      const lockKey = transform(orderId, (id) => `digital-downloads:order:${id}`)
      acquireLockStep({
        key: lockKey,
        ttl: 120,
        timeout: 30,
        executeOnSubWorkflow: true,
      })
      const result = issueOrderEntitlementsStep(normalizedInput)
      emitEventStep({
        eventName: DIGITAL_DOWNLOAD_EVENTS.ENTITLEMENT_ISSUED,
        data: result.entitlements,
      }).config({ name: emitStepNames.entitlements })
      emitEventStep({
        eventName: DIGITAL_DOWNLOAD_EVENTS.FULFILLMENT_COMPLETED,
        data: result,
      }).config({ name: emitStepNames.completed })
      emitEventStep({
        eventName: DIGITAL_DOWNLOAD_EVENTS.FULFILLMENT_FAILED,
        data: result.failures,
      }).config({ name: emitStepNames.failures })
      emitEventStep({
        eventName: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
        data: result.notification_events,
      }).config({ name: emitStepNames.notifications })
      releaseLockStep({ key: lockKey, executeOnSubWorkflow: true })
      return new WorkflowResponse(result)
    }
  )
}

export const issueOrderEntitlementsWorkflow = buildIssuanceWorkflow(
  "digital-downloads-issue-order-entitlements",
  "order.placed"
)

export const fulfillDigitalItemsWorkflow = buildIssuanceWorkflow(
  "digital-downloads-fulfill-items",
  "manual"
) as ReturnType<typeof buildIssuanceWorkflow> & {
  run: ReturnType<typeof buildIssuanceWorkflow>["run"]
}
