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
    listDigitalEntitlements: jest.fn().mockResolvedValue([entitlement]),
    revokeEntitlement: jest.fn().mockResolvedValue({
      ...entitlement,
      status: "revoked",
    }),
    updateDigitalEntitlements: jest.fn(async (data) => ({
      ...entitlement,
      ...data,
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
  container.register({
    [ContainerRegistrationKeys.QUERY]: asValue(query),
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
  return { container, query, service }
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
    expect(deps.service.listDigitalEntitlements).not.toHaveBeenCalled()
    expect(deps.service.revokeEntitlement).not.toHaveBeenCalled()
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
    expect(deps.service.listDigitalEntitlements).not.toHaveBeenCalled()
    expect(deps.service.revokeEntitlement).not.toHaveBeenCalled()
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
    expect(deps.service.revokeEntitlement).toHaveBeenCalledWith(
      "dent_bound",
      "Payment was refunded",
      { type: "workflow", id: "refund" }
    )
    expect(deps.query.graph.mock.calls.map(([input]) => input.entity)).toEqual([
      "payments",
      "order",
    ])
  })
})

describe("reissueEntitlementWorkflow", () => {
  it("propagates reset/rotation flags without persisting the guest token", async () => {
    const rawToken = "dda_reissue_return_only_capability"
    const deliveries: any[] = []
    const service = {
      reissueEntitlement: jest.fn().mockResolvedValue({
        entitlement: {
          id: "dent_reissue",
          order_id: "order_1",
          customer_id: null,
          customer_email: "guest@example.com",
          updated_at: "2026-07-31T22:00:00.000Z",
          snapshot: {},
        },
        guest_access: {
          session: {
            id: "dasess_reissue",
            idempotency_key: "reissue:dent_reissue:nonce",
          },
          token: rawToken,
        },
      }),
      listNotificationDeliveries: jest.fn().mockResolvedValue([]),
      createNotificationDeliveries: jest.fn(async (data) => {
        const delivery = { id: "ndel_reissue", ...data }
        deliveries.push(delivery)
        return delivery
      }),
      recipientHash: jest.fn().mockResolvedValue("recipient_hash"),
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
        notify: true,
      },
      context: { transactionId: "test:reissue:flags-and-capability" },
    })

    expect(service.reissueEntitlement).toHaveBeenCalledWith({
      entitlement_id: "dent_reissue",
      reason: "Customer requested a reset",
      reset_downloads: true,
      rotate_guest_token: true,
      notify: true,
    })
    expect(result).toMatchObject({
      entitlement: { id: "dent_reissue" },
      delivery: { id: "ndel_reissue" },
    })
    expect(JSON.stringify(result)).not.toContain(rawToken)
    expect(deliveries[0].payload).toMatchObject({
      guest_access: true,
      guest_access_idempotency_key: "reissue:dent_reissue:nonce",
    })
    expect(JSON.stringify(deliveries)).not.toContain(rawToken)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rawToken)
  })
})
