import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"

import {
  listAssets,
  listAuditEvents,
  listDownloads,
  listEntitlements,
  getEntitlement,
  getSettings,
  listProductConfigs,
  listReleases,
  testStorage,
} from "../lib/admin-handlers"

function response() {
  const res: any = { payload: undefined }
  res.json = jest.fn((payload: unknown) => {
    res.payload = payload
    return res
  })
  res.set = jest.fn(() => res)
  return res
}

function request(
  service: Record<string, unknown>,
  query: Record<string, unknown>,
  registrations: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
  return {
    query,
    params,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "digitalDownloads") return service
        if (registrations[key]) return registrations[key]
        throw new Error(`Unexpected registration: ${key}`)
      }),
    },
  } as any
}

describe("admin public-filter to persistence-filter adapters", () => {
  it.each([
    {
      provider: "local",
      storage: {
        defaultProvider: "local",
        local: {
          rootPath: "/srv/private-local-assets",
          signingSecret: "local-signing-secret",
        },
        s3: {
          bucket: "unused-private-bucket",
          region: "private-region",
          endpoint: "https://unused-storage.internal",
          prefix: "unused/private-prefix",
          forcePathStyle: true,
          accessKeyId: "unused-access-key",
          secretAccessKey: "unused-secret-key",
        },
      },
      prohibited: [
        "/srv/private-local-assets",
        "local-signing-secret",
        "unused-private-bucket",
        "private-region",
        "https://unused-storage.internal",
        "unused/private-prefix",
        "unused-access-key",
        "unused-secret-key",
      ],
    },
    {
      provider: "s3",
      storage: {
        defaultProvider: "s3",
        local: {
          rootPath: "/srv/unused-local-assets",
          signingSecret: "unused-local-signing-secret",
        },
        s3: {
          bucket: "production-private-bucket",
          region: "eu-central-1",
          endpoint: "https://s3.private.example",
          prefix: "merchant/production/private",
          forcePathStyle: true,
          accessKeyId: "production-access-key",
          secretAccessKey: "production-secret-key",
        },
      },
      prohibited: [
        "/srv/unused-local-assets",
        "unused-local-signing-secret",
        "production-private-bucket",
        "eu-central-1",
        "https://s3.private.example",
        "merchant/production/private",
        "production-access-key",
        "production-secret-key",
      ],
    },
  ] as const)(
    "returns only safe $provider storage diagnostics",
    async ({ provider, storage, prohibited }) => {
      const service = {
        options_: {
          tokenSecret: "token-secret",
          encryptionKey: "encryption-key",
          allowedMimeTypes: ["application/pdf"],
          storage,
        },
        getSettings: jest.fn().mockResolvedValue({
          enabled: true,
          default_delivery_type: "download",
          default_grant_ttl_seconds: 900,
          max_grant_ttl_seconds: 86_400,
          guest_access_ttl_seconds: 2_592_000,
          max_upload_size_bytes: 1024,
          allow_guest_access: true,
          require_order_email_match: true,
          event_retention_days: 365,
          metadata: {
            bucket: "metadata-private-bucket",
            endpoint: "https://metadata-storage.internal",
            forcePathStyle: "metadata-force-path-style",
            rootPath: "/metadata-private-root",
          },
        }),
        getReadinessDiagnostics: jest.fn().mockResolvedValue({
          ready: true,
          provider,
          issues: [],
        }),
        testStorage: jest.fn().mockResolvedValue({
          ready: true,
          provider,
          operation: "write_read_delete",
          ok: true,
          latency_ms: 12,
          issues: ["cannot reach https://probe-storage.internal"],
          bucket: "probe-private-bucket",
          endpoint: "https://probe-storage.internal",
          prefix: "probe/private-prefix",
          force_path_style: true,
          access_key_id: "probe-access-key",
          secret_access_key: "probe-secret-key",
        }),
      }
      const res = response()

      await getSettings(request(service, {}), res)

      expect(res.payload.settings.storage).toEqual({
        provider,
        configured: true,
      })
      expect(res.payload.settings.allowed_mime_types).toEqual([
        "application/pdf",
      ])
      expect(res.payload.settings.guest_access_ttl_seconds).toBe(2_592_000)
      expect(res.payload.settings.readiness).toMatchObject({
        ready: true,
        token_secret_configured: true,
        encryption_key_configured: true,
      })
      expect(res.payload.settings).not.toHaveProperty("storage_provider")
      expect(res.payload.settings).not.toHaveProperty("local_upload_path")
      expect(res.payload.settings).not.toHaveProperty("s3_bucket")

      const settingsSerialized = JSON.stringify(res.payload)
      expect(res.payload.settings.metadata).toEqual({})
      for (const value of [
        ...prohibited,
        "metadata-private-bucket",
        "https://metadata-storage.internal",
        "metadata-force-path-style",
        "/metadata-private-root",
      ]) {
        expect(settingsSerialized).not.toContain(value)
      }

      const probe = response()
      await testStorage(
        { ...request(service, {}), body: { operation: "write_read_delete" } },
        probe,
      )

      expect(probe.payload.storage_test).toEqual({
        ready: true,
        provider,
        operation: "write_read_delete",
        ok: true,
        latency_ms: 12,
      })
      expect(JSON.stringify(probe.payload)).not.toMatch(
        /bucket|endpoint|prefix|path_style|access_key|secret_access_key/i,
      )
    },
  )

  it("resolves product_id through native Medusa variant links", async () => {
    const service = {
      listAndCountDigitalProducts: jest.fn().mockResolvedValue([[], 0]),
    }
    const product = {
      listProductVariants: jest
        .fn()
        .mockResolvedValue([{ id: "variant_a" }, { id: "variant_b" }]),
    }
    const linkService = {
      list: jest.fn().mockResolvedValue([
        { variant_id: "variant_a", digital_product_id: "dprod_1" },
      ]),
    }
    const link = { getLinkModule: jest.fn(() => linkService) }
    const res = response()

    await listProductConfigs(
      request(
        service,
        { product_id: "prod_1", limit: "20", offset: "0" },
        {
          [Modules.PRODUCT]: product,
          [ContainerRegistrationKeys.LINK]: link,
        },
      ),
      res,
    )

    expect(link.getLinkModule).toHaveBeenCalledWith(
      Modules.PRODUCT,
      "product_variant_id",
      "digitalDownloads",
      "digital_product_id",
    )
    expect(linkService.list).toHaveBeenCalledWith(
      { product_variant_id: ["variant_a", "variant_b"] },
      { take: 10_000 },
    )
    expect(service.listAndCountDigitalProducts).toHaveBeenCalledWith(
      { id: ["dprod_1"] },
      expect.objectContaining({ skip: 0, take: 20 }),
    )
    expect(res.payload.count).toBe(0)
  })

  it("maps product_config_id to the release foreign key", async () => {
    const service = {
      listAndCountDigitalProductReleases: jest
        .fn()
        .mockResolvedValue([[], 0]),
    }

    await listReleases(
      request(service, {
        product_config_id: "dprod_1",
        status: "ready",
        limit: "10",
        offset: "0",
      }),
      response(),
    )

    expect(service.listAndCountDigitalProductReleases).toHaveBeenCalledWith(
      { digital_product_id: "dprod_1", status: "ready" },
      expect.objectContaining({ skip: 0, take: 10 }),
    )
  })

  it("resolves an asset product filter through its release IDs", async () => {
    const service = {
      listDigitalProductReleases: jest.fn().mockResolvedValue([
        { id: "drel_1" },
        { id: "drel_2" },
      ]),
      listAndCountDigitalAssets: jest.fn().mockResolvedValue([[], 0]),
    }

    await listAssets(
      request(service, {
        product_config_id: "dprod_1",
        role: "download",
        limit: "20",
        offset: "0",
      }),
      response(),
    )

    expect(service.listAndCountDigitalAssets).toHaveBeenCalledWith(
      { release_id: ["drel_1", "drel_2"], role: "download" },
      expect.objectContaining({ take: 20 }),
    )
  })

  it("maps entitlement aliases to persisted columns", async () => {
    const service = {
      listAndCountDigitalEntitlements: jest.fn().mockResolvedValue([[], 0]),
    }

    await listEntitlements(
      request(service, {
        product_config_id: "dprod_1",
        line_item_id: "item_1",
        status: "active",
        limit: "20",
        offset: "0",
      }),
      response(),
    )

    expect(service.listAndCountDigitalEntitlements).toHaveBeenCalledWith(
      {
        digital_product_id: "dprod_1",
        order_line_item_id: "item_1",
        status: "active",
      },
      expect.objectContaining({ take: 20 }),
    )
  })

  it("hydrates entitlement detail through its release assets relation", async () => {
    const service = {
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_1",
        release: { id: "drel_1", assets: [] },
      }),
    }

    await getEntitlement(
      request(service, {}, {}, { id: "dent_1" }),
      response(),
    )

    expect(service.retrieveDigitalEntitlement).toHaveBeenCalledWith(
      "dent_1",
      {
        relations: [
          "release",
          "release.assets",
          "license_assignments",
          "license_assignments.activations",
          "download_events",
        ],
      },
    )
  })

  it("maps download state and date aliases to event_type/occurred_at", async () => {
    const service = {
      listAndCountDownloadEvents: jest.fn().mockResolvedValue([[], 0]),
    }

    await listDownloads(
      request(service, {
        status: "completed",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-31T23:59:59.000Z",
        limit: "20",
        offset: "0",
      }),
      response(),
    )

    expect(service.listAndCountDownloadEvents).toHaveBeenCalledWith(
      {
        event_type: "transfer_completed",
        occurred_at: {
          $gte: new Date("2026-07-01T00:00:00.000Z"),
          $lte: new Date("2026-07-31T23:59:59.000Z"),
        },
      },
      expect.objectContaining({ take: 20 }),
    )
  })

  it("maps public audit action and entity aliases to persisted columns", async () => {
    const service = {
      listAndCountLicenseAuditEvents: jest.fn().mockResolvedValue([[], 0]),
    }

    await listAuditEvents(
      request(service, {
        entity_type: "license_assignment",
        entity_id: "dlassn_1",
        action: "revealed",
        limit: "20",
        offset: "0",
      }),
      response(),
    )

    expect(service.listAndCountLicenseAuditEvents).toHaveBeenCalledWith(
      {
        assignment_id: "dlassn_1",
        action: "key_revealed",
      },
      expect.objectContaining({ take: 20 }),
    )
  })
})
