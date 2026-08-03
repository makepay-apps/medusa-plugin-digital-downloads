import { asValue } from "awilix"
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../../modules/digital-downloads"
import {
  aggregateRefunds,
  orderTotalForRefundPolicy,
  reissueEntitlementWorkflow,
  revokeEntitlementWorkflow,
  revokeOrderEntitlementsWorkflow,
} from "../revocation-workflows"

function revocationDependencies(paymentOrderId?: string) {
  const entitlement = {
    id: "dent_bound",
    order_id: "order_bound",
    order_line_item_id: "item_bound",
    customer_email: null,
    status: "active",
  }
  const service = {
    revokeOrderEntitlements: jest.fn(async (input) => ({
      revoked: [
        {
          ...entitlement,
          status: input.trigger === "refund" ? "refunded" : "revoked",
        },
      ],
      deliveries: [],
    })),
  }
  const query = {
    graph: jest.fn(async ({ entity, filters }) => {
      if (entity === "payments") {
        return {
          data: paymentOrderId
            ? [
                {
                  id: filters.id,
                  payment_collection: { order: { id: paymentOrderId } },
                },
              ]
            : [],
        }
      }
      if (entity === "order") {
        return {
          data: [
            {
              id: filters.id,
              total: 100,
              original_total: 100,
              payment_collections: [],
            },
          ],
        }
      }
      return { data: [] }
    }),
  }
  const container = createMedusaContainer()
  const locking = {
    acquire: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  }
  container.register({
    [ContainerRegistrationKeys.QUERY]: asValue(query),
    [ContainerRegistrationKeys.LOGGER]: asValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    [Modules.LOCKING]: asValue(locking),
    [Modules.EVENT_BUS]: asValue({
      emit: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    }),
    [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
  })
  return { container, query, service, locking }
}

describe("refund projections", () => {
  it("uses original value after Medusa reduces a fully refunded order total to zero", () => {
    const order = {
      total: 0,
      original_total: 2608,
      refund_total: 0,
      summary: {
        original_order_total: 2608,
        refunded_total: 2608,
      },
      payment_collections: [
        {
          amount: 2608,
          payments: [
            {
              refunds: [
                { amount: 2608, raw_amount: { value: "2608", precision: 20 } },
              ],
            },
          ],
        },
      ],
    }

    expect(orderTotalForRefundPolicy(order)).toBe(2608)
    expect(aggregateRefunds(order)).toBe(2608)
  })
})

describe("revokeOrderEntitlementsWorkflow payment binding", () => {
  it("rejects a payment bound to a different supplied order before entitlement writes", async () => {
    const deps = revocationDependencies("order_bound")

    const response = await revokeOrderEntitlementsWorkflow(deps.container).run({
      input: {
        order_id: "order_other",
        payment_id: "pay_bound",
        trigger: "chargeback",
        policy: "all",
        reason: "Payment was disputed",
      },
      context: { transactionId: "test:revocation:payment-mismatch" },
      throwOnError: false,
    })

    expect(response.errors[0]?.error).toMatchObject({
      message: expect.stringContaining("does not belong to the supplied order"),
    })
    expect(deps.service.revokeOrderEntitlements).not.toHaveBeenCalled()
    expect(deps.query.graph).toHaveBeenCalledTimes(1)
  })

  it("rejects a missing or unlinked payment before entitlement writes", async () => {
    const deps = revocationDependencies()

    const response = await revokeOrderEntitlementsWorkflow(deps.container).run({
      input: {
        order_id: "order_bound",
        payment_id: "pay_missing",
        trigger: "refund",
        policy: "any_refund",
        refunded_amount: 1,
        reason: "Payment was refunded",
      },
      context: { transactionId: "test:revocation:payment-missing" },
      throwOnError: false,
    })

    expect(response.errors[0]?.error).toMatchObject({
      message: expect.stringContaining("Payment is not linked to an order"),
    })
    expect(deps.service.revokeOrderEntitlements).not.toHaveBeenCalled()
    expect(deps.query.graph).toHaveBeenCalledTimes(1)
  })

  it("allows a verified order/payment pair through the refund path", async () => {
    const deps = revocationDependencies("order_bound")

    const { result } = await revokeOrderEntitlementsWorkflow(deps.container).run({
      input: {
        order_id: "order_bound",
        payment_id: "pay_bound",
        trigger: "refund",
        policy: "any_refund",
        refunded_amount: 1,
        reason: "Payment was refunded",
      },
      context: { transactionId: "test:revocation:payment-bound" },
    })

    expect(result).toMatchObject({
      order_id: "order_bound",
      revoked: [{ id: "dent_bound", status: "refunded" }],
    })
    expect(deps.service.revokeOrderEntitlements).toHaveBeenCalledWith({
      order_id: "order_bound",
      line_item_ids: [],
      reason: "Payment was refunded",
      trigger: "refund",
      notify: true,
      actor: { type: "workflow", id: "refund" },
    })
    expect(deps.query.graph.mock.calls.map(([input]) => input.entity)).toEqual([
      "payments",
      "order",
    ])
  })

  it("uses the fulfillment order lock after resolving a payment-only input", async () => {
    const deps = revocationDependencies("order_bound")

    await revokeOrderEntitlementsWorkflow(deps.container).run({
      input: {
        payment_id: "pay_bound",
        trigger: "chargeback",
        policy: "all",
        reason: "Payment was disputed",
      },
      context: { transactionId: "test:revocation:shared-order-lock" },
    })

    expect(JSON.stringify(deps.locking.acquire.mock.calls)).toContain(
      "digital-downloads:order:order_bound",
    )
  })
})

describe("reissueEntitlementWorkflow", () => {
  it("defers guest capability issuance and forwards the exact future deadline", async () => {
    const delivery = {
      id: "ndel_reissue",
      idempotency_key:
        "dent_reissue:reissued:c549688c-c14f-4a0a-b4eb-f9a54ea50e26",
      payload: { guest_access: true },
    }
    const service = {
      reissueEntitlement: jest.fn().mockResolvedValue({
        entitlement: {
          id: "dent_reissue",
          order_id: "order_1",
          customer_id: null,
          customer_email: "guest@example.com",
          updated_at: "2026-07-31T22:00:00.000Z",
          metadata: {
            last_reissue_id: "c549688c-c14f-4a0a-b4eb-f9a54ea50e26",
            last_reissued_at: "2026-07-31T22:00:01.000Z",
          },
          snapshot: {},
        },
        guest_access_required: true,
        delivery,
      }),
    }
    const eventBus = {
      emit: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    }
    const locking = {
      acquire: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    }
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }
    const container = createMedusaContainer()
    container.register({
      [ContainerRegistrationKeys.LOGGER]: asValue(logger),
      [Modules.LOCKING]: asValue(locking),
      [Modules.EVENT_BUS]: asValue(eventBus),
      [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
    })

    const { result } = await reissueEntitlementWorkflow(container).run({
      input: {
        entitlement_id: "dent_reissue",
        reason: "Customer requested a reset",
        reset_downloads: true,
        rotate_guest_token: true,
        expires_at: "2026-10-15T12:34:56.000Z",
        notify: true,
      },
      context: { transactionId: "test:reissue:flags-and-capability" },
    })

    expect(service.reissueEntitlement).toHaveBeenCalledWith({
      entitlement_id: "dent_reissue",
      reason: "Customer requested a reset",
      reset_downloads: true,
      rotate_guest_token: true,
      expires_at: "2026-10-15T12:34:56.000Z",
      create_guest_access: false,
      notify: true,
    })
    expect(result).toMatchObject({
      entitlement: { id: "dent_reissue" },
      delivery: { id: "ndel_reissue" },
    })
    expect(delivery.payload).toMatchObject({
      guest_access: true,
    })
    expect(delivery.idempotency_key).toBe(
      "dent_reissue:reissued:c549688c-c14f-4a0a-b4eb-f9a54ea50e26"
    )
    expect(JSON.stringify(result)).not.toContain("guest_access_token")
    expect(JSON.stringify(delivery)).not.toContain("guest_access_token")
  })
})

describe("revokeEntitlementWorkflow", () => {
  it("uses the atomic state-and-outbox service operation", async () => {
    const service = {
      revokeEntitlementWithNotification: jest.fn().mockResolvedValue({
        entitlement: { id: "dent_admin", status: "revoked" },
        delivery: { id: "dnotif_admin" },
      }),
    }
    const container = createMedusaContainer()
    container.register({
      [ContainerRegistrationKeys.LOGGER]: asValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      [Modules.LOCKING]: asValue({
        acquire: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
      }),
      [Modules.EVENT_BUS]: asValue({
        emit: jest.fn().mockResolvedValue(undefined),
        clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
        releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
      }),
      [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
    })

    const { result } = await revokeEntitlementWorkflow(container).run({
      input: {
        entitlement_id: "dent_admin",
        reason: "Support revocation",
        actor: "user_admin",
        notify: true,
      },
      context: { transactionId: "test:single-revoke:atomic" },
    })

    expect(service.revokeEntitlementWithNotification).toHaveBeenCalledWith({
      entitlement_id: "dent_admin",
      reason: "Support revocation",
      actor: { type: "admin", id: "user_admin" },
      notify: true,
    })
    expect(result).toMatchObject({
      entitlement: { status: "revoked" },
      notification_events: [{ delivery_id: "dnotif_admin" }],
    })
  })
})
