import { DigitalDownloadsModuleService } from ".."

type LockObserver = (table: string, ids: string[]) => void | Promise<void>

function serviceHarness() {
  const events: string[] = []
  const releases = new Map<string, Record<string, any>>([
    [
      "drel_old",
      {
        id: "drel_old",
        digital_product_id: "dprod_1",
        status: "draft",
        title: "Original release",
        metadata: {},
      },
    ],
    [
      "drel_new",
      {
        id: "drel_new",
        digital_product_id: "dprod_1",
        status: "draft",
        title: "Next release",
        metadata: {},
      },
    ],
  ])
  const assets = new Map<string, Record<string, any>>([
    [
      "dasset_1",
      {
        id: "dasset_1",
        release_id: "drel_old",
        name: "Original asset",
      },
    ],
  ])
  let observeLock: LockObserver = () => undefined

  const knex = jest.fn((table: string) => {
    let ids: string[] = []
    const builder: Record<string, jest.Mock> = {}
    builder.whereIn = jest.fn((_column: string, values: string[]) => {
      ids = values
      return builder
    })
    builder.orderBy = jest.fn(() => builder)
    builder.forUpdate = jest.fn(() => builder)
    builder.select = jest.fn(async () => {
      events.push(`lock:${table}:${ids.join(",")}`)
      await observeLock(table, ids)
      return ids.map((id) => ({ id }))
    })
    return builder
  })
  const transactionManager = {
    getTransactionContext: jest.fn(() => knex),
  }
  const transactionContext = { transactionManager }

  const generated = {
    assetCreate: jest.fn(async (data) => {
      events.push("write:asset:create")
      return data
    }),
    assetUpdate: jest.fn(async (data) => {
      events.push("write:asset:update")
      return data
    }),
    assetDelete: jest.fn(async () => {
      events.push("write:asset:delete")
    }),
    productUpdate: jest.fn(async (data) => {
      events.push("write:product:update")
      return data
    }),
    releaseUpdate: jest.fn(async (data) => {
      events.push("write:release:update")
      return data
    }),
    releaseDelete: jest.fn(async () => {
      events.push("write:release:delete")
    }),
  }
  const baseRepository = {
    getFreshManager: jest.fn(() => ({})),
    serialize: jest.fn(async (value) => value),
  }
  const service = new DigitalDownloadsModuleService({
    baseRepository,
    digitalDownloadsOptions: {},
    digitalDownloadsStorage: {},
    digitalAssetService: {
      create: generated.assetCreate,
      update: generated.assetUpdate,
      delete: generated.assetDelete,
    },
    digitalProductService: { update: generated.productUpdate },
    digitalProductReleaseService: {
      update: generated.releaseUpdate,
      delete: generated.releaseDelete,
    },
  } as any) as any

  service.inTransaction_ = jest.fn(
    async (operation: (context: Record<string, unknown>) => Promise<unknown>) => {
      events.push("transaction")
      return operation(transactionContext)
    },
  )
  service.retrieveDigitalAsset = jest.fn(async (id: string) => {
    events.push(`read:asset:${id}`)
    return { ...(assets.get(id) ?? { id, release_id: null }) }
  })
  service.retrieveDigitalProductRelease = jest.fn(async (id: string) => {
    events.push(`read:release:${id}`)
    return {
      ...(releases.get(id) ?? {
        id,
        digital_product_id: "dprod_1",
        status: "draft",
        metadata: {},
      }),
    }
  })
  service.listDigitalEntitlements = jest.fn(async () => {
    events.push("read:entitlements")
    return []
  })
  service.productHasImmutableRelease_ = jest.fn(async () => false)
  service.retrieveDigitalProduct = jest.fn(async (id: string) => ({
    id,
    delivery_type: "download",
    fulfillment_required: true,
  }))

  return {
    assets,
    events,
    generated,
    releases,
    service,
    transactionContext,
    transactionManager,
    onLock(observer: LockObserver) {
      observeLock = observer
    },
  }
}

describe("transactional publication immutability wrappers", () => {
  const mutableCases: Array<{
    name: string
    invoke: (service: any) => Promise<unknown>
    locks: string[]
    write: keyof ReturnType<typeof serviceHarness>["generated"]
  }> = [
    {
      name: "asset create",
      invoke: (service) =>
        service.createDigitalAssets({
          release_id: "drel_old",
          name: "Created asset",
        }),
      locks: ["lock:digital_product_release:drel_old"],
      write: "assetCreate",
    },
    {
      name: "asset update",
      invoke: (service) =>
        service.updateDigitalAssets({ id: "dasset_1", name: "Updated asset" }),
      locks: [
        "lock:digital_asset:dasset_1",
        "lock:digital_product_release:drel_old",
      ],
      write: "assetUpdate",
    },
    {
      name: "asset delete",
      invoke: (service) => service.deleteDigitalAssets("dasset_1"),
      locks: [
        "lock:digital_asset:dasset_1",
        "lock:digital_product_release:drel_old",
      ],
      write: "assetDelete",
    },
    {
      name: "release update",
      invoke: (service) =>
        service.updateDigitalProductReleases({
          id: "drel_old",
          title: "Updated release",
        }),
      locks: ["lock:digital_product_release:drel_old"],
      write: "releaseUpdate",
    },
    {
      name: "release delete",
      invoke: (service) => service.deleteDigitalProductReleases("drel_old"),
      locks: ["lock:digital_product_release:drel_old"],
      write: "releaseDelete",
    },
    {
      name: "delivery-affecting product update",
      invoke: (service) =>
        service.updateDigitalProducts([
          { id: "dprod_b", delivery_type: "stream" },
          { id: "dprod_a", delivery_type: "download" },
          { id: "dprod_b", delivery_type: "mixed" },
        ]),
      locks: ["lock:digital_product:dprod_a,dprod_b"],
      write: "productUpdate",
    },
  ]

  it.each(mutableCases)(
    "runs $name through one transaction and the generated implementation after locking",
    async ({ invoke, locks, write }) => {
      const harness = serviceHarness()

      await invoke(harness.service)

      expect(harness.service.inTransaction_).toHaveBeenCalledTimes(1)
      expect(harness.events[0]).toBe("transaction")
      expect(harness.generated[write]).toHaveBeenCalledTimes(1)
      const writeEvent = harness.events.findIndex((event) =>
        event.startsWith("write:"),
      )
      for (const lock of locks) {
        const lockEvent = harness.events.indexOf(lock)
        expect(lockEvent).toBeGreaterThan(0)
        expect(lockEvent).toBeLessThan(writeEvent)
      }
      const generatedContext = harness.generated[write].mock.calls[0].at(-1)
      expect(generatedContext.transactionManager).toBe(
        harness.transactionManager,
      )
    },
  )

  it("rechecks a release after locking before creating an asset", async () => {
    const harness = serviceHarness()
    harness.onLock((table) => {
      if (table === "digital_product_release") {
        harness.releases.get("drel_old")!.status = "published"
      }
    })

    await expect(
      harness.service.createDigitalAssets({
        release_id: "drel_old",
        name: "Late asset",
      }),
    ).rejects.toThrow(/immutable/)

    expect(harness.events.indexOf("lock:digital_product_release:drel_old")).toBeLessThan(
      harness.events.indexOf("read:release:drel_old"),
    )
    expect(harness.generated.assetCreate).not.toHaveBeenCalled()
  })

  it("locks an asset and both release rows before accepting reassignment", async () => {
    const harness = serviceHarness()
    harness.onLock((table) => {
      if (table === "digital_product_release") {
        harness.releases.get("drel_new")!.status = "published"
      }
    })

    await expect(
      harness.service.updateDigitalAssets({
        id: "dasset_1",
        release_id: "drel_new",
      }),
    ).rejects.toThrow(/immutable/)

    const assetLock = harness.events.indexOf("lock:digital_asset:dasset_1")
    const releaseLock = harness.events.indexOf(
      "lock:digital_product_release:drel_new,drel_old",
    )
    const finalAssetRead = harness.events.lastIndexOf("read:asset:dasset_1")
    const targetReleaseRead = harness.events.lastIndexOf("read:release:drel_new")
    expect(releaseLock).toBeLessThan(assetLock)
    expect(assetLock).toBeLessThan(finalAssetRead)
    expect(releaseLock).toBeLessThan(targetReleaseRead)
    expect(harness.generated.assetUpdate).not.toHaveBeenCalled()
  })

  it("rechecks the owning release after asset and release locks before deleting", async () => {
    const harness = serviceHarness()
    harness.onLock((table) => {
      if (table === "digital_product_release") {
        harness.releases.get("drel_old")!.status = "published"
      }
    })

    await expect(
      harness.service.deleteDigitalAssets("dasset_1"),
    ).rejects.toThrow(/cannot be deleted/)

    const assetLock = harness.events.indexOf("lock:digital_asset:dasset_1")
    const releaseLock = harness.events.indexOf(
      "lock:digital_product_release:drel_old",
    )
    const releaseRead = harness.events.lastIndexOf("read:release:drel_old")
    expect(releaseLock).toBeLessThan(assetLock)
    expect(assetLock).toBeLessThan(releaseRead)
    expect(harness.generated.assetDelete).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: "update",
      invoke: (service: any) =>
        service.updateDigitalProductReleases({
          id: "drel_old",
          title: "Stale rewrite",
        }),
      generated: "releaseUpdate" as const,
    },
    {
      name: "delete",
      invoke: (service: any) =>
        service.deleteDigitalProductReleases("drel_old"),
      generated: "releaseDelete" as const,
    },
  ])("rechecks release immutability after locking before $name", async (entry) => {
    const harness = serviceHarness()
    harness.onLock((table) => {
      if (table === "digital_product_release") {
        harness.releases.get("drel_old")!.status = "published"
      }
    })

    await expect(entry.invoke(harness.service)).rejects.toThrow(/immutable|deleted/)

    const releaseLock = harness.events.indexOf(
      "lock:digital_product_release:drel_old",
    )
    const releaseRead = harness.events.lastIndexOf("read:release:drel_old")
    expect(releaseLock).toBeGreaterThan(0)
    expect(releaseLock).toBeLessThan(releaseRead)
    expect(harness.generated[entry.generated]).not.toHaveBeenCalled()
  })
})
