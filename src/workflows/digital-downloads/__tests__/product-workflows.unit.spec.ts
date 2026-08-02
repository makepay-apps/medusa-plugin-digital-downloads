import { asValue } from "awilix"
import {
  ContainerRegistrationKeys,
  createMedusaContainer,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../../modules/digital-downloads"
import {
  createDigitalProductReleaseWorkflow,
  createDigitalProductWorkflow,
  publishDigitalProductReleaseWorkflow,
  updateDigitalProductReleaseWorkflow,
  updateDigitalProductWorkflow,
} from "../product-workflows"

function createWorkflowContainer(service: Record<string, any>) {
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
  return { container, eventBus, locking }
}

describe("createDigitalProductWorkflow", () => {
  it("validates and links every requested variant to one configuration", async () => {
    const createdLinks: any[] = []
    const linkService = { list: jest.fn().mockResolvedValue([]) }
    const remoteLink = {
      getLinkModule: jest.fn().mockReturnValue(linkService),
      create: jest.fn(async (links) => createdLinks.push(...links)),
      dismiss: jest.fn(),
    }
    const service = {
      createDigitalProductConfigs: jest.fn(async (data) => ({
        id: "dprod_1",
        ...data,
      })),
      deleteDigitalProductConfigs: jest.fn(),
    }
    const query = {
      graph: jest.fn().mockResolvedValue({
        data: [
          { id: "variant_1", product_id: "prod_1" },
          { id: "variant_2", product_id: "prod_1" },
        ],
      }),
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

    const { result } = await createDigitalProductWorkflow(container).run({
      input: {
        product_id: "prod_1",
        variant_ids: ["variant_1", "variant_2"],
        title: "Digital album",
        delivery_type: "download",
        fulfillment_strategy: "payment_captured",
      },
      context: { transactionId: "test:create:multi-variant" },
    })

    expect(result).toMatchObject({
      product_id: "prod_1",
      variant_ids: ["variant_1", "variant_2"],
      digital_product: {
        id: "dprod_1",
        product_id: "prod_1",
        variant_ids: ["variant_1", "variant_2"],
      },
    })
    expect(service.createDigitalProductConfigs).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Digital album",
        metadata: expect.objectContaining({
          medusa_product_id: "prod_1",
          variant_ids: ["variant_1", "variant_2"],
          fulfillment_strategy: "payment_captured",
        }),
      })
    )
    expect(createdLinks).toHaveLength(2)
    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: ["variant_1", "variant_2"] },
      { take: 100 }
    )
    expect(remoteLink.getLinkModule).toHaveBeenCalledWith(
      Modules.PRODUCT,
      "product_variant_id",
      DIGITAL_DOWNLOADS_MODULE,
      "digital_product_id"
    )
    expect(locking.acquire).toHaveBeenCalledTimes(1)
    expect(locking.release).toHaveBeenCalledTimes(1)
  })

  it("projects product_variant_id rows while updating variant membership", async () => {
    const linkService = {
      list: jest.fn(async (filters) => {
        if (filters.digital_product_id === "dprod_1") {
          return [
            {
              product_variant_id: "variant_1",
              digital_product_id: "dprod_1",
            },
          ]
        }
        if (filters.product_variant_id) {
          return []
        }
        throw new Error(`Unexpected link filters ${JSON.stringify(filters)}`)
      }),
    }
    const remoteLink = {
      getLinkModule: jest.fn().mockReturnValue(linkService),
      create: jest.fn().mockResolvedValue(undefined),
      dismiss: jest.fn().mockResolvedValue(undefined),
    }
    const service = {
      retrieveDigitalProductConfig: jest.fn().mockResolvedValue({
        id: "dprod_1",
        title: "Album",
        metadata: {
          medusa_product_id: "prod_1",
          variant_ids: ["variant_1"],
          fulfillment_strategy: "payment_captured",
          active_release_id: "drel_1",
          customer_note: "before",
        },
      }),
      updateDigitalProductConfigs: jest.fn(async (data) => data),
    }
    const query = {
      graph: jest.fn().mockResolvedValue({
        data: [
          { id: "variant_1", product_id: "prod_1" },
          { id: "variant_2", product_id: "prod_1" },
        ],
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
      [ContainerRegistrationKeys.LINK]: asValue(remoteLink),
      [ContainerRegistrationKeys.QUERY]: asValue(query),
      [ContainerRegistrationKeys.LOGGER]: asValue(logger),
      [Modules.LOCKING]: asValue(locking),
      [Modules.EVENT_BUS]: asValue(eventBus),
      [DIGITAL_DOWNLOADS_MODULE]: asValue(service),
    })

    const { result } = await updateDigitalProductWorkflow(container).run({
      input: {
        id: "dprod_1",
        product_id: "prod_1",
        variant_ids: ["variant_1", "variant_2"],
        data: {
          title: "Album remaster",
          fulfillment_strategy: "order_placed",
          metadata: {
            customer_note: "after",
            fulfillment_strategy: "manual",
            medusa_product_id: "prod_injected",
            active_release_id: "drel_injected",
          },
        },
      },
      context: { transactionId: "test:update:link-row-field" },
    })

    expect(linkService.list).toHaveBeenCalledWith(
      { digital_product_id: "dprod_1" },
      { take: 100 }
    )
    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: ["variant_2"] },
      { take: 100 }
    )
    expect(remoteLink.create).toHaveBeenCalledWith([
      {
        [Modules.PRODUCT]: { product_variant_id: "variant_2" },
        [DIGITAL_DOWNLOADS_MODULE]: { digital_product_id: "dprod_1" },
      },
    ])
    expect(result).toMatchObject({
      id: "dprod_1",
      variant_ids: ["variant_1", "variant_2"],
    })
    expect(service.updateDigitalProductConfigs).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          medusa_product_id: "prod_1",
          variant_ids: ["variant_1", "variant_2"],
          fulfillment_strategy: "payment_captured",
          active_release_id: "drel_1",
          customer_note: "after",
        },
      }),
    )
  })
})

describe("digital product release workflows", () => {
  it("attaches staged assets while creating a release", async () => {
    const assets = new Map<string, any>([
      [
        "dasset_1",
        { id: "dasset_1", release_id: null, status: "staged" },
      ],
    ])
    const releases = new Map<string, any>()
    const service = {
      listDigitalAssets: jest.fn(async ({ id }: { id: string[] }) =>
        id.map((assetId) => assets.get(assetId)).filter(Boolean)
      ),
      listDigitalProductReleases: jest.fn().mockResolvedValue([]),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      listDownloadGrants: jest.fn().mockResolvedValue([]),
      createDigitalProductReleases: jest.fn(async (data) => {
        const release = { id: "drel_1", ...data, assets: [] }
        releases.set(release.id, release)
        return release
      }),
      updateDigitalAssets: jest.fn(async (updates: any[]) => {
        for (const update of updates) {
          Object.assign(assets.get(update.id), update)
        }
      }),
      retrieveDigitalProductRelease: jest.fn(async (id: string) => ({
        ...releases.get(id),
        assets: [...assets.values()].filter(
          (asset) => asset.release_id === id
        ),
      })),
      deleteDigitalProductReleases: jest.fn(),
    }
    const { container } = createWorkflowContainer(service)

    const { result } = await createDigitalProductReleaseWorkflow(container).run({
      input: {
        digital_product_id: "dprod_1",
        asset_ids: ["dasset_1"],
        data: { version: "1.0.0", title: "First release", status: "ready" },
      },
      context: { transactionId: "test:create-release:asset-attach" },
    })

    expect(result).toMatchObject({
      id: "drel_1",
      digital_product_id: "dprod_1",
      assets: [{ id: "dasset_1", release_id: "drel_1" }],
    })
    expect(service.createDigitalProductReleases).toHaveBeenCalledWith(
      expect.not.objectContaining({ asset_ids: expect.anything() })
    )
    expect(service.updateDigitalAssets).toHaveBeenCalledWith([
      { id: "dasset_1", release_id: "drel_1" },
    ])
  })

  it("replaces an unpublished release asset set and preserves rollback data", async () => {
    const assets = new Map<string, any>([
      [
        "dasset_old",
        { id: "dasset_old", release_id: "drel_target", status: "ready" },
      ],
      [
        "dasset_new",
        { id: "dasset_new", release_id: "drel_source", status: "staged" },
      ],
    ])
    let targetRelease = {
      id: "drel_target",
      digital_product_id: "dprod_1",
      version: "1.0.0",
      title: "Draft",
      status: "draft",
      assets: [assets.get("dasset_old")],
    }
    const service = {
      retrieveDigitalProductRelease: jest.fn(async () => ({
        ...targetRelease,
        assets: [...assets.values()].filter(
          (asset) => asset.release_id === "drel_target"
        ),
      })),
      listDigitalAssets: jest.fn(async ({ id }: { id: string[] }) =>
        id.map((assetId) => assets.get(assetId)).filter(Boolean)
      ),
      listDigitalProductReleases: jest.fn().mockResolvedValue([
        { id: "drel_source", status: "draft" },
      ]),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      listDownloadGrants: jest.fn().mockResolvedValue([]),
      updateDigitalProductReleases: jest.fn(async (update) => {
        targetRelease = { ...targetRelease, ...update }
        return targetRelease
      }),
      updateDigitalAssets: jest.fn(async (updates: any[]) => {
        for (const update of updates) {
          Object.assign(assets.get(update.id), update)
        }
      }),
    }
    const { container } = createWorkflowContainer(service)

    const { result } = await updateDigitalProductReleaseWorkflow(container).run({
      input: {
        id: "drel_target",
        asset_ids: ["dasset_new"],
        data: { title: "Ready" },
      },
      context: { transactionId: "test:update-release:exact-asset-set" },
    })

    expect(result).toMatchObject({
      id: "drel_target",
      title: "Ready",
      assets: [{ id: "dasset_new", release_id: "drel_target" }],
    })
    expect(service.updateDigitalAssets).toHaveBeenCalledWith([
      { id: "dasset_new", release_id: "drel_target" },
      { id: "dasset_old", release_id: null },
    ])
  })

  it("publishes a ready release and atomically advances the current release", async () => {
    const releases = new Map<string, any>([
      [
        "drel_previous",
        {
          id: "drel_previous",
          digital_product_id: "dprod_publish",
          version: "0.9.0",
          status: "published",
          is_current: true,
          assets: [],
          metadata: {},
        },
      ],
      [
        "drel_publish",
        {
          id: "drel_publish",
          digital_product_id: "dprod_publish",
          version: "1.0.0",
          status: "ready",
          is_current: false,
          assets: [
            {
              id: "dasset_release",
              role: "download",
              status: "ready",
              is_enabled: true,
            },
          ],
          metadata: {},
        },
      ],
    ])
    let product: any = {
      id: "dprod_publish",
      title: "Album",
      handle: "album",
      status: "draft",
      delivery_type: "download",
      metadata: { fulfillment_strategy: "payment_captured" },
      license_policy: null,
    }
    const service = {
      retrieveDigitalProductRelease: jest.fn(async (id: string) => ({
        ...releases.get(id),
        assets: [...(releases.get(id)?.assets ?? [])],
      })),
      retrieveDigitalProductConfig: jest.fn(async () => ({
        ...product,
        releases: [...releases.values()],
      })),
      listDigitalProductReleases: jest.fn(async () =>
        [...releases.values()].filter((release) => release.is_current)
      ),
      updateDigitalProductReleases: jest.fn(async (update) => {
        const updated = { ...releases.get(update.id), ...update }
        releases.set(update.id, updated)
        return updated
      }),
      updateDigitalProductConfigs: jest.fn(async (update) => {
        product = { ...product, ...update }
        return product
      }),
      publishDigitalProductRelease: jest.fn(async (id, input) => {
        for (const release of releases.values()) {
          if (release.id !== id && release.is_current) {
            Object.assign(release, { status: "retired", is_current: false })
          }
        }
        const target = releases.get(id)
        const publishedAt = new Date()
        Object.assign(target, {
          status: "published",
          is_current: input.make_active,
          published_at: publishedAt,
          metadata: {
            ...target.metadata,
            asset_set_locked: true,
            published_asset_ids: target.assets.map((asset) => asset.id),
          },
        })
        product = {
          ...product,
          status: "active",
          published_at: publishedAt,
          metadata: { ...product.metadata, active_release_id: id },
        }
        return {
          ...target,
          digital_product: { ...product, releases: [...releases.values()] },
          notify_existing_customers: input.notify_existing_customers,
        }
      }),
    }
    const { container, eventBus } = createWorkflowContainer(service)

    const { result } = await publishDigitalProductReleaseWorkflow(container).run({
      input: {
        id: "drel_publish",
        make_active: true,
        notify_existing_customers: true,
      },
      context: { transactionId: "test:publish-release:advance-current" },
    })

    expect(result).toMatchObject({
      id: "drel_publish",
      status: "published",
      is_current: true,
      notify_existing_customers: true,
      metadata: {
        asset_set_locked: true,
        published_asset_ids: ["dasset_release"],
      },
      digital_product: {
        id: "dprod_publish",
        status: "active",
        metadata: {
          active_release_id: "drel_publish",
          fulfillment_strategy: "payment_captured",
        },
      },
    })
    expect(releases.get("drel_previous")).toMatchObject({
      status: "retired",
      is_current: false,
    })
    expect(eventBus.emit).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "digital_downloads.release.published",
      }),
    ])
  })

  it("rejects reassignment from another published release", async () => {
    const service = {
      retrieveDigitalProductRelease: jest.fn().mockResolvedValue({
        id: "drel_target_published_guard",
        status: "draft",
        assets: [],
      }),
      listDigitalAssets: jest.fn().mockResolvedValue([
        {
          id: "dasset_published",
          release_id: "drel_published_source",
          status: "ready",
        },
      ]),
      listDigitalProductReleases: jest.fn().mockResolvedValue([
        { id: "drel_published_source", status: "published" },
      ]),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      listDownloadGrants: jest.fn().mockResolvedValue([]),
      updateDigitalProductReleases: jest.fn(),
      updateDigitalAssets: jest.fn(),
    }
    const { container } = createWorkflowContainer(service)

    const response = await updateDigitalProductReleaseWorkflow(container).run({
      input: {
        id: "drel_target_published_guard",
        asset_ids: ["dasset_published"],
      },
      context: { transactionId: "test:update-release:published-source" },
      throwOnError: false,
    })

    expect(service.listDigitalProductReleases).toHaveBeenCalledWith(
      { id: ["drel_published_source"] },
      { take: 1 }
    )
    expect(response.errors[0]?.error).toMatchObject({
      message: expect.stringContaining(
        "cannot be reassigned from published release"
      ),
    })
    expect(service.updateDigitalAssets).not.toHaveBeenCalled()
  })
})
