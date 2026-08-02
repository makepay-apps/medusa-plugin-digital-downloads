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
