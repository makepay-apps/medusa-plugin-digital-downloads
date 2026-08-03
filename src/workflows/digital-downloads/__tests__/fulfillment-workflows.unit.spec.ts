import { asValue } from "awilix"
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../../modules/digital-downloads"
import {
  fulfillmentStrategyReady,
  issueOrderEntitlementsWorkflow,
  registeredCustomerId,
} from "../fulfillment-workflows"

function quantityBudgetDependencies(quantities: number[]) {
  const order = {
    id: `order_quantity_budget_${quantities.join("_")}`,
    email: null,
    total: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    items: quantities.map((quantity, index) => ({
      id: `item_quantity_budget_${index}`,
      variant_id: `variant_quantity_budget_${index}`,
      title: `Digital item ${index}`,
      quantity,
    })),
  }
  const digitalProduct = {
    id: "dprod_quantity_budget",
    title: "Quantity budget product",
    status: "active",
    delivery_type: "download",
    metadata: { fulfillment_strategy: "payment_captured" },
    releases: [
      {
        id: "drel_quantity_budget",
        status: "published",
        is_current: true,
        assets: [],
      },
    ],
  }
  const service = {
    listDigitalProducts: jest.fn().mockResolvedValue([digitalProduct]),
    listFulfillmentOperations: jest.fn().mockResolvedValue([]),
    createFulfillmentOperations: jest.fn(async (data) => ({
      id: `op_${data.idempotency_key}`,
      ...data,
    })),
    updateFulfillmentOperations: jest.fn(async (data) => ({ ...data })),
    issueOrderEntitlements: jest.fn(async (row) => [
      {
        id: `dent_${row.line_item_id}_${row.unit_index}`,
        order_id: row.order_id,
        order_line_item_id: row.line_item_id,
        customer_id: null,
        customer_email: null,
        status: "active",
        snapshot: row.snapshot,
      },
    ]),
    listDigitalEntitlements: jest.fn().mockResolvedValue([]),
  }
  const variantLinks = {
    list: jest.fn().mockResolvedValue(
      order.items.map((item) => ({
        product_variant_id: item.variant_id,
        digital_product_id: digitalProduct.id,
      }))
    ),
  }
  const emptyLinks = { list: jest.fn().mockResolvedValue([]) }
  const remoteLink = {
    getLinkModule: jest.fn((module) =>
      module === Modules.PRODUCT ? variantLinks : emptyLinks
    ),
    create: jest.fn().mockResolvedValue(undefined),
  }
  const container = createMedusaContainer()
  container.register({
    [ContainerRegistrationKeys.LINK]: asValue(remoteLink),
    [ContainerRegistrationKeys.QUERY]: asValue({
      graph: jest.fn().mockResolvedValue({ data: [order] }),
    }),
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
  return { container, digitalProduct, order, remoteLink, service }
}

describe("fulfillmentStrategyReady", () => {
  it("treats a zero-total order as paid without a capture event", () => {
    expect(
      fulfillmentStrategyReady(
        "payment_captured",
        "order.placed",
        { total: { value: "0" }, payment_status: "not_paid" }
      )
    ).toBe(true)
    expect(
      fulfillmentStrategyReady(
        "payment_captured",
        "order.placed",
        { total: 1000, payment_status: "not_paid" }
      )
    ).toBe(false)
  })

  it("requires a full capture before paid digital delivery", () => {
    const order = {
      total: 1000,
      payment_collections: [
        {
          amount: 1000,
          captured_amount: 400,
          payments: [{ amount: 1000, captured_at: new Date() }],
        },
      ],
    }
    expect(
      fulfillmentStrategyReady("payment_captured", "payment.captured", order)
    ).toBe(false)
    expect(
      fulfillmentStrategyReady("payment_captured", "payment.captured", {
        ...order,
        payment_collections: [
          { ...order.payment_collections[0], captured_amount: 1000 },
        ],
      })
    ).toBe(true)
    expect(
      fulfillmentStrategyReady("payment_captured", "payment.captured", {
        total: 1000,
      })
    ).toBe(false)
  })

  it("fails closed for missing or unknown automatic strategies but preserves manual overrides", () => {
    const order = { total: 0 }
    for (const strategy of [undefined, "order_placed", "unexpected"]) {
      expect(fulfillmentStrategyReady(strategy, "order.placed", order)).toBe(
        false,
      )
      expect(fulfillmentStrategyReady(strategy, "reconciliation", order)).toBe(
        false,
      )
      expect(fulfillmentStrategyReady(strategy, "manual", order)).toBe(true)
      expect(
        fulfillmentStrategyReady(strategy, "order.placed", order, true),
      ).toBe(true)
    }
  })
})

describe("registeredCustomerId", () => {
  it("does not treat Medusa's anonymous customer row as an account owner", () => {
    expect(
      registeredCustomerId({
        customer_id: "cus_guest",
        customer: { id: "cus_guest", has_account: false },
      })
    ).toBeNull()
    expect(
      registeredCustomerId({
        customer_id: "cus_account",
        customer: { id: "cus_account", has_account: true },
      })
    ).toBe("cus_account")
    expect(registeredCustomerId({ customer_id: "cus_unknown" })).toBeNull()
  })
})

describe("issueOrderEntitlementsWorkflow", () => {
  it("rejects an aggregate multi-line quantity over 1000 before any fulfillment write", async () => {
    const deps = quantityBudgetDependencies([600, 401])

    const response = await issueOrderEntitlementsWorkflow(deps.container).run({
      input: { order_id: deps.order.id, source: "order.placed" },
      context: { transactionId: "test:quantity-budget:over-cap" },
      throwOnError: false,
    })

    expect(response.errors[0]?.error).toMatchObject({
      message: expect.stringContaining(
        "cannot exceed 1000 digital entitlement units"
      ),
    })
    expect(deps.service.createFulfillmentOperations).not.toHaveBeenCalled()
    expect(deps.service.issueOrderEntitlements).not.toHaveBeenCalled()
    expect(deps.remoteLink.create).not.toHaveBeenCalled()
  })

  it("allows exactly 1000 aggregate digital entitlement units", async () => {
    const deps = quantityBudgetDependencies([600, 400])

    const { result } = await issueOrderEntitlementsWorkflow(deps.container).run({
      input: { order_id: deps.order.id, source: "order.placed" },
      context: { transactionId: "test:quantity-budget:exact-cap" },
    })

    expect(result.entitlements).toHaveLength(1_000)
    expect(deps.service.createFulfillmentOperations).toHaveBeenCalledTimes(1_000)
    expect(deps.service.issueOrderEntitlements).toHaveBeenCalledTimes(1_000)
  })

  it("fails a license-only item without a published current release", async () => {
    const deps = quantityBudgetDependencies([1])
    deps.digitalProduct.delivery_type = "license"
    deps.digitalProduct.releases = []
    Object.assign(deps.digitalProduct, {
      license_policy: {
        id: "dlpol_license_only",
        strategy: "generated",
        is_enabled: true,
      },
    })

    const { result } = await issueOrderEntitlementsWorkflow(
      deps.container,
    ).run({
      input: { order_id: deps.order.id, source: "order.placed" },
      context: { transactionId: "test:license-only:missing-release" },
    })

    expect(result.entitlements).toEqual([])
    expect(result.failures).toEqual([
      expect.objectContaining({
        message: "Digital product has no published, ready release",
      }),
    ])
    expect(deps.service.issueOrderEntitlements).not.toHaveBeenCalled()
    expect(deps.service.updateFulfillmentOperations).toHaveBeenCalledWith(
      expect.objectContaining({ error_code: "release_not_ready" }),
    )
  })

  it("defers invalid automatic configuration without leaking it and reconciles after correction", async () => {
    const order = {
      id: "order_strategy_correction",
      email: null,
      total: 0,
      items: [
        {
          id: "item_strategy_correction",
          variant_id: "variant_strategy_correction",
          quantity: 1,
          title: "Guide",
        },
      ],
    }
    const product = {
      id: "dprod_strategy_correction",
      title: "Guide",
      status: "active",
      delivery_type: "download",
      metadata: { fulfillment_strategy: "order_placed" },
      releases: [
        {
          id: "drel_strategy_correction",
          status: "published",
          is_current: true,
          assets: [],
        },
      ],
    }
    const operations = new Map<string, any>()
    const service = {
      listDigitalProducts: jest.fn(async () => [product]),
      listFulfillmentOperations: jest.fn(async ({ idempotency_key }) => {
        const operation = operations.get(idempotency_key)
        return operation ? [operation] : []
      }),
      createFulfillmentOperations: jest.fn(async (data) => {
        const operation = { id: "op_strategy_correction", ...data }
        operations.set(data.idempotency_key, operation)
        return operation
      }),
      updateFulfillmentOperations: jest.fn(async (data) => {
        const previous = [...operations.values()].find(
          (operation) => operation.id === data.id,
        )
        const updated = { ...previous, ...data }
        operations.set(updated.idempotency_key, updated)
        return updated
      }),
      issueOrderEntitlements: jest.fn(async (row) => [
        {
          id: "dent_strategy_correction",
          order_id: row.order_id,
          customer_id: row.customer_id,
          customer_email: row.email,
        },
      ]),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
    }
    const variantLinks = {
      list: jest.fn().mockResolvedValue([
        {
          product_variant_id: "variant_strategy_correction",
          digital_product_id: "dprod_strategy_correction",
        },
      ]),
    }
    const emptyLinks = { list: jest.fn().mockResolvedValue([]) }
    const remoteLink = {
      getLinkModule: jest.fn((module) =>
        module === Modules.PRODUCT ? variantLinks : emptyLinks,
      ),
      create: jest.fn().mockResolvedValue(undefined),
    }
    const query = {
      graph: jest.fn().mockResolvedValue({ data: [order] }),
    }
    const eventBus = {
      emit: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    }
    const container = createMedusaContainer()
    container.register({
      [ContainerRegistrationKeys.LINK]: asValue(remoteLink),
      [ContainerRegistrationKeys.QUERY]: asValue(query),
      [ContainerRegistrationKeys.LOGGER]: asValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
      [Modules.LOCKING]: asValue({ acquire: jest.fn(), release: jest.fn() }),
      [Modules.EVENT_BUS]: asValue(eventBus),
      [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
    })

    const deferred = await issueOrderEntitlementsWorkflow(container).run({
      input: { order_id: order.id, source: "order.placed" },
      context: { transactionId: "test:strategy:defer" },
    })

    expect(deferred.result.entitlements).toEqual([])
    expect(deferred.result.deferred).toEqual([
      { operation_id: "op_strategy_correction", strategy: "invalid" },
    ])
    expect(operations.get(`${order.id}:${order.items[0].id}:0`)).toMatchObject({
      state: "pending",
      attempt_count: 0,
      error_code: "invalid_fulfillment_strategy",
      error_message:
        "Fulfillment is waiting for a valid fulfillment strategy configuration",
    })
    expect(service.issueOrderEntitlements).not.toHaveBeenCalled()

    product.metadata.fulfillment_strategy = "payment_captured"
    const reconciled = await issueOrderEntitlementsWorkflow(container).run({
      input: { order_id: order.id, source: "reconciliation" },
      context: { transactionId: "test:strategy:reconcile" },
    })

    expect(reconciled.result.entitlements).toHaveLength(1)
    expect(service.issueOrderEntitlements).toHaveBeenCalledTimes(1)
    expect(operations.get(`${order.id}:${order.items[0].id}:0`)).toMatchObject({
      state: "completed",
      error_code: null,
      error_message: null,
    })
  })

  it("issues exactly one immutable entitlement per digital unit in a mixed order", async () => {
    const order = {
      id: "order_mixed",
      display_id: 1042,
      email: "buyer@example.com",
      customer_id: "cus_1",
      customer: { id: "cus_1", has_account: true },
      currency_code: "usd",
      payment_status: "not_paid",
      total: 2000,
      payment_collections: [{ amount: 2000, captured_amount: 0 }],
      created_at: "2026-07-31T00:00:00.000Z",
      items: [
        {
          id: "item_physical",
          variant_id: "variant_physical",
          title: "T-shirt",
          quantity: 3,
          unit_price: 2500,
        },
        {
          id: "item_digital",
          variant_id: "variant_digital",
          title: "Album",
          raw_quantity: { value: "2" },
          unit_price: 1000,
        },
      ],
    }
    const query = {
      graph: jest.fn(async ({ entity }) => {
        if (entity === "order") return { data: [order] }
        if (entity === "product_variant") {
          return {
            data: [
              { id: "variant_physical", product_id: "prod_physical" },
              { id: "variant_digital", product_id: "prod_digital" },
            ],
          }
        }
        return { data: [] }
      }),
    }
    const variantLinks = {
      list: jest.fn().mockResolvedValue([
        {
          product_variant_id: "variant_digital",
          digital_product_id: "dprod_1",
        },
      ]),
    }
    const createdLinks: any[] = []
    const orderEntitlementLinks = {
      list: jest.fn(async () =>
        createdLinks
          .filter((link) => link[Modules.ORDER])
          .map((link) => ({
            order_id: link[Modules.ORDER].order_id,
            digital_entitlement_id:
              link[DIGITAL_DOWNLOADS_MODULE].digital_entitlement_id,
          }))
      ),
    }
    const customerEntitlementLinks = {
      list: jest.fn(async () =>
        createdLinks
          .filter((link) => link[Modules.CUSTOMER])
          .map((link) => ({
            customer_id: link[Modules.CUSTOMER].customer_id,
            digital_entitlement_id:
              link[DIGITAL_DOWNLOADS_MODULE].digital_entitlement_id,
          }))
      ),
    }
    const remoteLink = {
      getLinkModule: jest.fn((leftModule) =>
        leftModule === Modules.PRODUCT
          ? variantLinks
          : leftModule === Modules.ORDER
            ? orderEntitlementLinks
            : customerEntitlementLinks
      ),
      create: jest.fn(async (links) => createdLinks.push(...links)),
      dismiss: jest.fn(),
    }
    const operations = new Map<string, any>()
    const notifications = new Map<string, any>()
    const entitlements = new Map<string, any>()
    const issuedRows: any[] = []
    const rawGuestToken = "dda_must_not_enter_workflow_state"
    const service = {
      listDigitalProducts: jest.fn().mockResolvedValue([
        {
          id: "dprod_1",
          title: "Album",
          status: "active",
          delivery_type: "download",
          metadata: {
            download_limit: 5,
            fulfillment_strategy: "payment_captured",
          },
          releases: [
            {
              id: "drel_1",
              version: "1.0.0",
              status: "published",
              is_current: true,
              assets: [
                {
                  id: "dasset_1",
                  original_filename: "album.zip",
                  storage_key: "private/album.zip",
                  checksum_sha256: "abc",
                },
              ],
            },
          ],
        },
      ]),
      listFulfillmentOperations: jest.fn(async ({ idempotency_key }) => {
        const operation = operations.get(idempotency_key)
        return operation ? [operation] : []
      }),
      createFulfillmentOperations: jest.fn(async (data) => {
        const operation = { id: `op_${data.unit_index}`, ...data }
        operations.set(data.idempotency_key, operation)
        return operation
      }),
      updateFulfillmentOperations: jest.fn(async (data) => {
        const existing = [...operations.values()].find((item) => item.id === data.id)
        const updated = { ...existing, ...data }
        operations.set(updated.idempotency_key, updated)
        return updated
      }),
      issueOrderEntitlements: jest.fn(async (row) => {
        issuedRows.push(row)
        const entitlement = {
            id: `dent_${row.unit_index}`,
            digital_product_id: row.digital_product_id,
            release_id: row.digital_product_release_id,
            order_id: row.order_id,
            order_line_item_id: row.line_item_id,
            customer_id: row.customer_id,
            customer_email: row.email,
            unit_index: row.unit_index,
            snapshot: row.snapshot,
          }
        entitlements.set(row.idempotency_key, entitlement)
        return [
          {
            ...entitlement,
            guest_access: {
              session: { id: `dasess_${row.unit_index}` },
              token: rawGuestToken,
            },
          },
        ]
      }),
      listDigitalEntitlements: jest.fn(async ({ idempotency_key }) => {
        const entitlement = entitlements.get(idempotency_key)
        return entitlement ? [entitlement] : []
      }),
      listNotificationDeliveries: jest.fn(async ({ idempotency_key }) => {
        const notification = notifications.get(idempotency_key)
        return notification ? [notification] : []
      }),
      createNotificationDeliveries: jest.fn(async (data) => {
        const notification = { id: `notif_${data.entitlement_id}`, ...data }
        notifications.set(data.idempotency_key, notification)
        return notification
      }),
      recipientHash: jest.fn(() => "recipient_hash"),
    }
    const eventBus = {
      emit: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    }
    const locking = { acquire: jest.fn(), release: jest.fn() }
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }
    const container = createMedusaContainer()
    container.register({
      [ContainerRegistrationKeys.LINK]: asValue(remoteLink),
      [ContainerRegistrationKeys.QUERY]: asValue(query),
      [ContainerRegistrationKeys.LOGGER]: asValue(logger),
      [Modules.LOCKING]: asValue(locking),
      [Modules.EVENT_BUS]: asValue(eventBus),
      [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
    })

    const placed = await issueOrderEntitlementsWorkflow(container).run({
      input: { order_id: order.id, source: "order.placed" },
      context: { transactionId: "test:mixed-order:placed" },
    })
    order.payment_collections[0].captured_amount = 2000
    const runCaptured = () =>
      issueOrderEntitlementsWorkflow(container).run({
        input: { order_id: order.id, source: "payment.captured" },
        context: { transactionId: "test:mixed-order:captured" },
      })
    const first = await runCaptured()
    const duplicate = await runCaptured()

    expect(placed.result.entitlements).toEqual([])
    expect(placed.result.deferred).toHaveLength(2)
    expect(first.result.entitlements).toHaveLength(2)
    expect(first.result.skipped_line_item_ids).toEqual(["item_physical"])
    expect(first.result.failures).toEqual([])
    expect(query.graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        fields: expect.arrayContaining([
          "items.raw_quantity",
          "display_id",
          "customer.has_account",
          "payment_collections.captured_amount",
        ]),
      })
    )
    expect(variantLinks.list).toHaveBeenCalledWith(
      {
        product_variant_id: ["variant_physical", "variant_digital"],
      },
      { take: 100 }
    )
    expect(duplicate.result.entitlements).toHaveLength(2)
    expect(service.issueOrderEntitlements).toHaveBeenCalledTimes(2)
    expect(issuedRows.map((row) => row.idempotency_key)).toEqual([
      "order_mixed:item_digital:0",
      "order_mixed:item_digital:1",
    ])
    expect(issuedRows.map((row) => row.quantity)).toEqual([1, 1])
    expect(issuedRows.every((row) => row.create_guest_access === false)).toBe(
      true
    )
    expect(issuedRows[0].snapshot.order).toMatchObject({
      id: "order_mixed",
      display_id: 1042,
    })
    expect(JSON.stringify(issuedRows[0].snapshot)).not.toContain("storage_key")
    expect(JSON.stringify(issuedRows[0].snapshot)).not.toContain(
      "private/album.zip"
    )
    expect(JSON.stringify(first.result)).not.toContain(rawGuestToken)
    expect(JSON.stringify([...notifications.values()])).not.toContain(
      rawGuestToken
    )
    // Two order links and two customer links, with no physical-item links.
    expect(createdLinks).toHaveLength(4)
  })
})
