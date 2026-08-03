import { Readable } from "node:stream"

import { DigitalDownloadsModuleService } from ".."

type LockObserver = (table: string, ids: string[]) => void | Promise<void>

function serviceHarness(allowedMimeTypes: string[] = []) {
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
        role: "download",
        delivery_type: "download",
        mime_type: "application/pdf",
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
    digitalDownloadsOptions: { allowedMimeTypes },
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

  it.each([
    { role: "stream", deliveryType: "stream" },
    { role: "download", deliveryType: "download" },
    { role: "preview", deliveryType: "download" },
    { role: "cover", deliveryType: "download" },
    { role: "manual", deliveryType: "download" },
    { role: "license", deliveryType: "license" },
  ])(
    "updates delivery_type atomically when an asset role changes to $role",
    async ({ role, deliveryType }) => {
      const harness = serviceHarness()

      await harness.service.updateDigitalAssets({ id: "dasset_1", role })

      expect(harness.generated.assetUpdate).toHaveBeenCalledWith(
        {
          id: "dasset_1",
          role,
          delivery_type: deliveryType,
        },
        expect.objectContaining({
          transactionManager: harness.transactionManager,
        }),
      )
    },
  )

  it("normalizes a created stream role and rejects incompatible explicit asset delivery", async () => {
    const harness = serviceHarness()

    await harness.service.createDigitalAssets({
      release_id: "drel_old",
      name: "Stream asset",
      role: "stream",
    })
    expect(harness.generated.assetCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "stream",
        delivery_type: "stream",
      }),
      expect.objectContaining({
        transactionManager: harness.transactionManager,
      }),
    )

    await expect(
      harness.service.createDigitalAssets({
        release_id: "drel_old",
        name: "Invalid stream asset",
        role: "stream",
        delivery_type: "download",
      }),
    ).rejects.toThrow(/incompatible/)
  })

  it("reapplies the configured MIME policy to the effective asset MIME on update", async () => {
    const harness = serviceHarness(["application/pdf"])

    await harness.service.updateDigitalAssets({
      id: "dasset_1",
      name: "Allowed PDF asset",
    })
    expect(harness.generated.assetUpdate).toHaveBeenCalledTimes(1)

    harness.generated.assetUpdate.mockClear()
    await expect(
      harness.service.updateDigitalAssets({
        id: "dasset_1",
        mime_type: "text/html",
      }),
    ).rejects.toThrow(/MIME type text\/html is not allowed/)
    expect(harness.generated.assetUpdate).not.toHaveBeenCalled()
    expect(harness.assets.get("dasset_1")!.mime_type).toBe("application/pdf")

    await harness.service.updateDigitalAssets({
      id: "dasset_1",
      name: "Allowed explicit PDF asset",
      mime_type: "application/pdf",
    })
    expect(harness.generated.assetUpdate).toHaveBeenCalledTimes(1)
  })

  it("rejects a disallowed explicit MIME before creating an asset", async () => {
    const harness = serviceHarness(["application/pdf"])

    await expect(
      harness.service.createDigitalAssets({
        release_id: "drel_old",
        name: "HTML asset",
        mime_type: "text/html",
      }),
    ).rejects.toThrow(/MIME type text\/html is not allowed/)
    expect(harness.generated.assetCreate).not.toHaveBeenCalled()
  })

  it("reports immutable-release conflicts before MIME-policy errors", async () => {
    const harness = serviceHarness(["application/pdf"])
    harness.releases.get("drel_old")!.status = "published"

    await expect(
      harness.service.updateDigitalAssets({
        id: "dasset_1",
        mime_type: "text/html",
      }),
    ).rejects.toThrow(/immutable/)
    expect(harness.generated.assetUpdate).not.toHaveBeenCalled()

    await expect(
      harness.service.createDigitalAssets({
        release_id: "drel_old",
        name: "HTML asset",
        mime_type: "text/html",
      }),
    ).rejects.toThrow(/immutable/)
    expect(harness.generated.assetCreate).not.toHaveBeenCalled()
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

  it("fails public previews closed when product preview policy or ownership changes", async () => {
    const harness = serviceHarness()
    const bytes = Buffer.from("preview")
    harness.assets.set("dasset_preview", {
      id: "dasset_preview",
      release_id: "drel_old",
      role: "preview",
      status: "ready",
      is_enabled: true,
      storage_provider: "local",
      storage_key: "previews/preview.txt",
      storage_bucket: null,
      original_filename: "preview.txt",
      mime_type: "text/plain",
      size_bytes: bytes.byteLength,
    })
    harness.releases.set("drel_old", {
      id: "drel_old",
      digital_product_id: "dprod_1",
      status: "published",
      is_current: true,
      published_at: new Date(),
      metadata: {},
    })
    const product = {
      id: "dprod_1",
      status: "active",
      metadata: {
        preview_enabled: true,
        active_release_id: "drel_old",
      },
    }
    harness.service.retrieveDigitalProduct.mockImplementation(async () => ({
      ...product,
      metadata: { ...product.metadata },
    }))
    const get = jest.fn(async () => ({
      body: Readable.from([bytes]),
      size: bytes.byteLength,
      totalSize: bytes.byteLength,
      contentType: "text/plain",
      etag: 'W/"preview"',
      statusCode: 200,
      contentRange: undefined,
    }))
    harness.service.storage_ = { get }

    const opened = await harness.service.openDigitalAsset("dasset_preview", {
      purpose: "preview",
    })
    opened.body.destroy()
    expect(get).toHaveBeenCalledTimes(1)

    product.metadata.preview_enabled = false
    await expect(
      harness.service.openDigitalAsset("dasset_preview", {
        purpose: "preview",
      }),
    ).rejects.toMatchObject({ type: "not_found" })
    expect(get).toHaveBeenCalledTimes(1)

    product.metadata.preview_enabled = true
    product.metadata.active_release_id = "drel_other"
    await expect(
      harness.service.openDigitalAsset("dasset_preview", {
        purpose: "preview",
      }),
    ).rejects.toMatchObject({ type: "not_found" })
    expect(get).toHaveBeenCalledTimes(1)

    product.metadata.active_release_id = "drel_old"
    product.id = "dprod_other"
    await expect(
      harness.service.openDigitalAsset("dasset_preview", {
        purpose: "preview",
      }),
    ).rejects.toMatchObject({ type: "not_found" })
    expect(get).toHaveBeenCalledTimes(1)
  })
})
