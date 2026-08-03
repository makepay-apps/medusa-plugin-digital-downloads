import { asValue } from "awilix"
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../../modules/digital-downloads"
import {
  cleanupDigitalVariantWorkflow,
  cleanupOrphanedDigitalProductsWorkflow,
  expireEntitlementsWorkflow,
  retryNotificationDeliveriesWorkflow,
} from "../maintenance-workflows"

function maintenanceContainer(input: {
  linkService: { list: jest.Mock }
  service: Record<string, any>
  query?: Record<string, any>
}) {
  const remoteLink = {
    getLinkModule: jest.fn().mockReturnValue(input.linkService),
    dismiss: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue(undefined),
  }
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  const container = createMedusaContainer()
  container.register({
    [ContainerRegistrationKeys.LINK]: asValue(remoteLink),
    [ContainerRegistrationKeys.LOGGER]: asValue(logger),
    [ContainerRegistrationKeys.QUERY]: asValue(input.query ?? {}),
    [Modules.EVENT_BUS]: asValue({
      emit: jest.fn().mockResolvedValue(undefined),
      clearGroupedEvents: jest.fn().mockResolvedValue(undefined),
      releaseGroupedEvents: jest.fn().mockResolvedValue(undefined),
    }),
    [DIGITAL_DOWNLOADS_MODULE]: asValue(input.service),
  })
  return { container, remoteLink }
}

describe("digital product link maintenance", () => {
  it("filters the generated link model by product_variant_id", async () => {
    const linkService = {
      list: jest.fn().mockResolvedValue([
        {
          product_variant_id: "variant_deleted",
          digital_product_id: "dprod_1",
        },
      ]),
    }
    const service = {
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      deleteDigitalProductConfigs: jest.fn().mockResolvedValue(undefined),
    }
    const { container, remoteLink } = maintenanceContainer({
      linkService,
      service,
    })

    const { result } = await cleanupDigitalVariantWorkflow(container).run({
      input: { variant_id: "variant_deleted" },
      context: { transactionId: "test:cleanup-link:selector-field" },
    })

    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: "variant_deleted" },
      { take: 100 }
    )
    expect(remoteLink.dismiss).toHaveBeenCalledWith([
      {
        [Modules.PRODUCT]: { product_variant_id: "variant_deleted" },
        [DIGITAL_DOWNLOADS_MODULE]: { digital_product_id: "dprod_1" },
      },
    ])
    expect(result).toMatchObject({
      variant_id: "variant_deleted",
      cleaned: [{ digital_product_id: "dprod_1", action: "deleted" }],
    })
  })

  it("projects product_variant_id from generated rows while dismissing native definitions", async () => {
    const linkService = {
      list: jest.fn().mockResolvedValue([
        {
          product_variant_id: "variant_missing",
          digital_product_id: "dprod_orphan",
        },
      ]),
    }
    const query = {
      graph: jest.fn().mockResolvedValue({ data: [] }),
    }
    const service = {
      listDigitalProducts: jest.fn().mockResolvedValue([]),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      listDownloadGrants: jest.fn().mockResolvedValue([]),
      deleteDigitalProductConfigs: jest.fn().mockResolvedValue(undefined),
    }
    const { container, remoteLink } = maintenanceContainer({
      linkService,
      service,
      query,
    })

    const { result } = await cleanupOrphanedDigitalProductsWorkflow(
      container
    ).run({
      input: { limit: 25 },
      context: { transactionId: "test:cleanup-link:projection-field" },
    })

    expect(query.graph).toHaveBeenCalledWith({
      entity: "product_variant",
      fields: ["id"],
      filters: { id: ["variant_missing"] },
    })
    expect(remoteLink.dismiss).toHaveBeenCalledWith([
      {
        [Modules.PRODUCT]: { product_variant_id: "variant_missing" },
        [DIGITAL_DOWNLOADS_MODULE]: {
          digital_product_id: "dprod_orphan",
        },
      },
    ])
    expect(result.cleaned).toEqual([
      { digital_product_id: "dprod_orphan", action: "deleted" },
    ])
  })
})

describe("digital notification retry maintenance", () => {
  it("claims rows without fanning the batch out through the event bus", async () => {
    const claimed = [
      { id: "ndel_1", lease_owner: "digital-downloads-notification-1785564000000" },
      { id: "ndel_2", lease_owner: "digital-downloads-notification-1785564000000" },
    ]
    const service = {
      claimNotificationDeliveries: jest.fn().mockResolvedValue(claimed),
    }
    const { container } = maintenanceContainer({
      linkService: { list: jest.fn() },
      service,
    })

    const { result } = await retryNotificationDeliveriesWorkflow(container).run({
      input: { as_of: "2026-08-01T06:00:00.000Z", limit: 10 },
      context: { transactionId: "test:notification-retry:no-fanout" },
    })

    expect(service.claimNotificationDeliveries).toHaveBeenCalledWith(
      "digital-downloads-notification-1785564000000",
      10,
      120
    )
    expect(result).toEqual({
      claimed,
      notification_events: [
        { delivery_id: "ndel_1" },
        { delivery_id: "ndel_2" },
      ],
      stale_delivery_ids: [],
    })
  })
})

describe("entitlement expiry maintenance", () => {
  it("uses the atomic expiry/outbox service operation", async () => {
    const candidate = {
      id: "dent_due",
      status: "active",
      expires_at: "2026-08-01T05:00:00.000Z",
    }
    const service = {
      listDigitalEntitlements: jest.fn().mockResolvedValue([candidate]),
      listLifecycleNotificationRepairCandidates: jest
        .fn()
        .mockResolvedValue([]),
      expireEntitlementIfDue: jest.fn().mockResolvedValue({
        entitlement: { ...candidate, status: "expired" },
        delivery: { id: "ndel_expired" },
        expired: true,
      }),
    }
    const { container } = maintenanceContainer({
      linkService: { list: jest.fn() },
      service,
    })

    const { result } = await expireEntitlementsWorkflow(container).run({
      input: { as_of: "2026-08-01T06:00:00.000Z", limit: 10 },
      context: { transactionId: "test:expiry:atomic-outbox" },
    })

    expect(service.listDigitalEntitlements).toHaveBeenCalledWith(
      {
        status: "active",
        expires_at: { $lte: new Date("2026-08-01T06:00:00.000Z") },
      },
      { take: 10, order: { expires_at: "ASC" } },
    )
    expect(service.expireEntitlementIfDue).toHaveBeenCalledWith({
      entitlement_id: candidate.id,
      as_of: new Date("2026-08-01T06:00:00.000Z"),
      reason: "Entitlement access period expired",
    })
    expect(
      service.listLifecycleNotificationRepairCandidates,
    ).toHaveBeenCalledWith({
      limit: 10,
      as_of: new Date("2026-08-01T06:00:00.000Z"),
    })
    expect(result).toMatchObject({
      expired: [{ id: candidate.id, status: "expired" }],
      repaired: [],
      notification_events: [{ delivery_id: "ndel_expired" }],
    })
  })

  it("repairs a bounded terminal lifecycle batch through the status-guarded atomic primitive", async () => {
    const repairCandidates = [
      {
        id: "dent_expired_legacy",
        status: "expired",
        reason: "Entitlement access period expired",
      },
      {
        id: "dent_refunded_legacy",
        status: "refunded",
        reason: "Order refunded",
      },
    ]
    const service = {
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      listLifecycleNotificationRepairCandidates: jest
        .fn()
        .mockResolvedValue(repairCandidates),
      repairLifecycleNotification: jest
        .fn()
        .mockResolvedValueOnce({
          entitlement: { id: "dent_expired_legacy", status: "expired" },
          delivery: { id: "ndel_expired_repair" },
          repaired: true,
        })
        .mockResolvedValueOnce({
          entitlement: { id: "dent_refunded_legacy", status: "active" },
          repaired: false,
        }),
    }
    const { container } = maintenanceContainer({
      linkService: { list: jest.fn() },
      service,
    })

    const { result } = await expireEntitlementsWorkflow(container).run({
      input: { as_of: "2026-08-01T06:00:00.000Z", limit: 5_000 },
      context: { transactionId: "test:lifecycle:bounded-repair" },
    })

    expect(
      service.listLifecycleNotificationRepairCandidates,
    ).toHaveBeenCalledWith({
      limit: 1_000,
      as_of: new Date("2026-08-01T06:00:00.000Z"),
    })
    expect(service.repairLifecycleNotification.mock.calls).toEqual(
      repairCandidates.map((candidate) => [
        {
          entitlement_id: candidate.id,
          expected_status: candidate.status,
          reason: candidate.reason,
        },
      ]),
    )
    expect(result).toMatchObject({
      expired: [],
      repaired: [{ id: "dent_expired_legacy", status: "expired" }],
      notification_events: [{ delivery_id: "ndel_expired_repair" }],
    })
  })
})
