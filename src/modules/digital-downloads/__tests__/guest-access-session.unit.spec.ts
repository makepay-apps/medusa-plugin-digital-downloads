import { DigitalDownloadsModuleService, tokenHash } from ".."
import { AccessSessionStatus, DigitalEntitlementStatus } from "../types"

const TOKEN_SECRET = "guest-session-unit-token-secret-32-bytes-minimum"

function guestCreationService({
  configuredTtl = 2_592_000,
  persistedTtl = 2_592_000,
}: {
  configuredTtl?: number
  persistedTtl?: number
} = {}) {
  const service = {
    baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
    options_: {
      tokenSecret: TOKEN_SECRET,
      guestAccessTtlSeconds: configuredTtl,
    },
    getSettings: jest.fn().mockResolvedValue({
      allow_guest_access: true,
      guest_access_ttl_seconds: persistedTtl,
      // This intentionally remains short to prove the lifecycles are separate.
      max_grant_ttl_seconds: 900,
    }),
    lockRows_: jest.fn().mockResolvedValue(undefined),
    retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
      id: "dent_guest",
      status: DigitalEntitlementStatus.ACTIVE,
      available_at: null,
      expires_at: null,
    }),
    listEntitlementAccessSessions: jest.fn().mockResolvedValue([]),
    createEntitlementAccessSessions: jest.fn(async (data) => ({
      id: "daccess_created",
      ...data,
    })),
    safeAccessSession: jest.fn((value) => value),
  }
  return service
}

describe("createGuestAccessSession", () => {
  afterEach(() => jest.useRealTimers())

  it("uses the durable guest-access setting instead of the asset-grant limit", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = guestCreationService()

    await (DigitalDownloadsModuleService.prototype as any)
      .createGuestAccessSession.call(
        service,
        {
          entitlement_id: "dent_guest",
          idempotency_key: "guest:durable:v1",
        },
        { transactionManager: {} },
      )

    expect(service.createEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        expires_at: new Date("2026-09-02T00:00:00.000Z"),
      }),
      expect.any(Object),
    )
  })

  it("does not allow a caller to exceed the configured guest-access lifetime", async () => {
    const service = guestCreationService()

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .createGuestAccessSession.call(
          service,
          {
            entitlement_id: "dent_guest",
            idempotency_key: "guest:too-long:v1",
            ttl_seconds: 2_592_001,
          },
          { transactionManager: {} },
        ),
    ).rejects.toThrow("ttl_seconds must be an integer between 1 and 2592000")
    expect(service.createEntitlementAccessSessions).not.toHaveBeenCalled()
  })

  it("keeps a one-day module policy restrictive after an upgrade seeds a 30-day row", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = guestCreationService({
      configuredTtl: 86_400,
      persistedTtl: 2_592_000,
    })

    await (DigitalDownloadsModuleService.prototype as any)
      .createGuestAccessSession.call(
        service,
        {
          entitlement_id: "dent_guest",
          idempotency_key: "guest:upgrade-policy:v1",
        },
        { transactionManager: {} },
      )

    expect(service.createEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        expires_at: new Date("2026-08-04T00:00:00.000Z"),
      }),
      expect.any(Object),
    )
  })

  it("validates an explicit TTL against the more restrictive effective policy", async () => {
    const service = guestCreationService({
      configuredTtl: 86_400,
      persistedTtl: 2_592_000,
    })

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .createGuestAccessSession.call(
          service,
          {
            entitlement_id: "dent_guest",
            idempotency_key: "guest:upgrade-policy:too-long:v1",
            ttl_seconds: 86_401,
          },
          { transactionManager: {} },
        ),
    ).rejects.toThrow("ttl_seconds must be an integer between 1 and 86400")
    expect(service.createEntitlementAccessSessions).not.toHaveBeenCalled()
  })
})

describe("updateSettings guest capability policy", () => {
  function settingsService() {
    return {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        maxGrantTtlSeconds: 86_400,
        guestAccessTtlSeconds: 86_400,
      },
      getSettings: jest.fn().mockResolvedValue({
        id: "ddset_global",
        singleton_key: "global",
        default_grant_ttl_seconds: 900,
        max_grant_ttl_seconds: 86_400,
        guest_access_ttl_seconds: 2_592_000,
        storage_namespace_fingerprint: "storage-fingerprint",
        storage_namespace_version: 1,
        token_secret_fingerprint: "token-fingerprint",
        encryption_key_fingerprint: "encryption-fingerprint",
      }),
      updateDigitalDownloadsSettings: jest.fn(async (row) => row),
    }
  }

  it("normalizes an upgraded 30-day row when another setting is saved", async () => {
    const service = settingsService()

    await (DigitalDownloadsModuleService.prototype as any).updateSettings.call(
      service,
      { default_download_limit: 4 },
      {},
    )

    expect(service.updateDigitalDownloadsSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ddset_global",
        default_download_limit: 4,
        guest_access_ttl_seconds: 86_400,
      }),
      expect.any(Object),
    )
  })

  it("rejects an Admin TTL above the module policy ceiling", async () => {
    const service = settingsService()

    await expect(
      (DigitalDownloadsModuleService.prototype as any).updateSettings.call(
        service,
        { guest_access_ttl_seconds: 86_401 },
        {},
      ),
    ).rejects.toThrow(
      "guest_access_ttl_seconds must be an integer between 1 and 86400",
    )
    expect(service.updateDigitalDownloadsSettings).not.toHaveBeenCalled()
  })
})

describe("issueOrderEntitlements guest capability policy", () => {
  function issuanceService() {
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      getSettings: jest.fn().mockResolvedValue({
        enabled: true,
        allow_guest_access: true,
        default_download_limit: 5,
      }),
      retrieveDigitalProduct: jest.fn().mockResolvedValue({
        id: "dprod_1",
        title: "Guide",
        handle: "guide",
        delivery_type: "download",
      }),
      retrieveDigitalProductRelease: jest.fn().mockResolvedValue({
        id: "drel_1",
        digital_product_id: "dprod_1",
        status: "published",
        version: "1.0.0",
        published_at: "2026-08-03T00:00:00.000Z",
      }),
      listDigitalEntitlements: jest.fn().mockResolvedValue([]),
      createDigitalEntitlements: jest.fn(async (row) => ({
        id: `dent_${row.idempotency_key}`,
        ...row,
      })),
      createGuestAccessSession: jest.fn(async ({ entitlement_id }) => ({
        session: { id: `daccess_${entitlement_id}` },
        token: "dda_return_only_token",
      })),
    }
    service.normalizeEntitlementRows = (input: unknown) =>
      (DigitalDownloadsModuleService.prototype as any)
        .normalizeEntitlementRows.call(service, input)
    return service
  }

  const row = {
    idempotency_key: "order_1:item_1:0",
    order_id: "order_1",
    line_item_id: "item_1",
    email: "guest@example.test",
    digital_product_id: "dprod_1",
    digital_product_release_id: "drel_1",
    unit_index: 0,
    snapshot: { order: { id: "order_1", display_id: 1042 } },
  }

  it("supports an internal opt-out while keeping direct calls default-compatible", async () => {
    const service = issuanceService()

    const [suppressed] = await (DigitalDownloadsModuleService.prototype as any)
      .issueOrderEntitlements.call(
        service,
        { ...row, create_guest_access: false },
        { transactionManager: {} },
      )
    expect(suppressed).not.toHaveProperty("guest_access")
    expect(suppressed.snapshot.order).toMatchObject({
      id: "order_1",
      display_id: 1042,
    })
    expect(service.createGuestAccessSession).not.toHaveBeenCalled()

    const [legacyDefault] = await (DigitalDownloadsModuleService.prototype as any)
      .issueOrderEntitlements.call(
        service,
        { ...row, idempotency_key: "order_1:item_1:1", unit_index: 1 },
        { transactionManager: {} },
      )
    expect(legacyDefault.guest_access).toMatchObject({
      token: "dda_return_only_token",
    })
    expect(service.createGuestAccessSession).toHaveBeenCalledTimes(1)
  })
})

describe("release publication notifications", () => {
  it("rejects unsupported existing-customer notifications before publication", async () => {
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
    }
    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .publishDigitalProductRelease.call(
          service,
          "drel_1",
          { notify_existing_customers: true },
          {},
        ),
    ).rejects.toThrow(
      "notify_existing_customers is not supported; publish the release with false",
    )
  })
})

describe("revokeEntitlement lifecycle operation ids", () => {
  it("persists a distinct non-secret id for each actual revoke cycle", async () => {
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_revoke_cycles",
        status: "active",
        metadata: {},
      }),
      updateDigitalEntitlements: jest.fn(async (row) => row),
      listDownloadGrants: jest.fn().mockResolvedValue([]),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([]),
      listLicenseAssignments: jest.fn().mockResolvedValue([]),
    }

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await (DigitalDownloadsModuleService.prototype as any)
        .revokeEntitlement.call(
          service,
          "dent_revoke_cycles",
          `Cycle ${cycle}`,
          { type: "admin", id: "user_1" },
          { transactionManager: {} },
        )
    }

    const ids = service.updateDigitalEntitlements.mock.calls.map(
      ([row]) => row.metadata.last_revocation_id,
    )
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(ids[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(ids[0]).not.toBe(ids[1])
  })
})

describe("reissueEntitlement guest capability handoff", () => {
  it("uses a unique operation id for every reissue notification version", async () => {
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_registered_reissue",
        customer_id: "cus_1",
        customer_email: "buyer@example.test",
        digital_product_id: "dprod_1",
        status: "active",
        metadata: {},
      }),
      getSettings: jest.fn().mockResolvedValue({ allow_guest_access: true }),
      updateDigitalEntitlements: jest.fn(async (row) => row),
      listLicensePolicies: jest.fn().mockResolvedValue([]),
    }

    for (let index = 0; index < 2; index += 1) {
      await (DigitalDownloadsModuleService.prototype as any)
        .reissueEntitlement.call(
          service,
          { entitlement_id: "dent_registered_reissue" },
          { transactionManager: {} },
        )
    }

    const ids = service.updateDigitalEntitlements.mock.calls.map(
      ([row]) => row.metadata.last_reissue_id,
    )
    expect(ids[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(ids[1]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  it("rejects deferred guest rotation when no notification can deliver the replacement", async () => {
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest_reissue",
        customer_id: null,
        customer_email: "guest@example.test",
        status: "active",
      }),
      getSettings: jest.fn().mockResolvedValue({ allow_guest_access: true }),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .reissueEntitlement.call(
          service,
          {
            entitlement_id: "dent_guest_reissue",
            rotate_guest_token: true,
            create_guest_access: false,
            notify: false,
          },
          { transactionManager: {} },
        ),
    ).rejects.toThrow(
      "Guest token rotation requires notification delivery to a customer email",
    )
  })

  it("rotates old guest capabilities without issuing a replacement while guest access is disabled", async () => {
    const activeSession = {
      id: "daccess_guest_disabled_old",
      entitlement_id: "dent_guest_disabled",
      status: "active",
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest_disabled",
        customer_id: null,
        customer_email: null,
        digital_product_id: "dprod_1",
        status: "active",
        guest_access_epoch: 0,
        metadata: {},
      }),
      getSettings: jest.fn().mockResolvedValue({ allow_guest_access: false }),
      updateDigitalEntitlements: jest.fn(async (row) => row),
      listEntitlementAccessSessions: jest
        .fn()
        .mockResolvedValue([activeSession]),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue({
        ...activeSession,
        status: "revoked",
      }),
      listNotificationDeliveries: jest.fn().mockResolvedValue([]),
      listLicensePolicies: jest.fn().mockResolvedValue([]),
      createGuestAccessSession: jest.fn(),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .reissueEntitlement.call(
          service,
          {
            entitlement_id: "dent_guest_disabled",
            rotate_guest_token: true,
            create_guest_access: false,
            notify: false,
          },
          { transactionManager: {} },
        ),
    ).resolves.toMatchObject({
      entitlement: { id: "dent_guest_disabled" },
      guest_access_required: false,
    })
    expect(service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: activeSession.id,
          status: "revoked",
          revoke_reason: "rotated_on_reissue",
        }),
      ],
      expect.anything(),
    )
    expect(service.updateDigitalEntitlements).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dent_guest_disabled",
        guest_access_epoch: 1,
      }),
      expect.anything(),
    )
  })

  it("revokes existing guest sessions without minting an orphan when issuance is deferred", async () => {
    const reissuedAt = "2026-08-03T10:15:00.000Z"
    const queuedDelivery = {
      id: "dnotif_old_queued",
      entitlement_id: "dent_guest_reissue",
      state: "pending",
      payload: {
        guest_access: true,
        guest_access_epoch: 4,
        guest_access_idempotency_key: "old-queued",
        ordinary_field: "preserved",
      },
      metadata: {},
    }
    const checkpointedDelivery = {
      id: "dnotif_old_checkpointed",
      entitlement_id: "dent_guest_reissue",
      state: "processing",
      payload: { guest_access: true, guest_access_epoch: 4 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "prepared",
          guest_access_epoch: 4,
          guest_session_id: "daccess_checkpointed",
        },
      },
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest_reissue",
        customer_id: null,
        digital_product_id: "dprod_1",
        status: "active",
        customer_email: "guest@example.test",
        guest_access_epoch: 4,
        metadata: {},
      }),
      updateDigitalEntitlements: jest.fn(async (row) => ({
        ...row,
        updated_at: reissuedAt,
      })),
      getSettings: jest.fn().mockResolvedValue({ allow_guest_access: true }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([
        {
          id: "daccess_old",
          entitlement_id: "dent_guest_reissue",
          status: "active",
        },
      ]),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue([]),
      createGuestAccessSession: jest.fn(),
      listLicensePolicies: jest.fn().mockResolvedValue([]),
      listNotificationDeliveries: jest.fn(async (selector) =>
        selector.idempotency_key
          ? []
          : [queuedDelivery, checkpointedDelivery],
      ),
      retrieveNotificationDelivery: jest.fn().mockResolvedValue(queuedDelivery),
      updateNotificationDeliveries: jest.fn(async (row) => row),
      createNotificationDeliveries: jest.fn(async (row) => ({
        id: "dnotif_reissue",
        ...row,
      })),
      recipientHash: jest.fn().mockResolvedValue("recipient_hash"),
    }

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        {
          entitlement_id: "dent_guest_reissue",
          rotate_guest_token: true,
          create_guest_access: false,
          notify: true,
        },
        { transactionManager: {} },
      )

    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "daccess_old",
          status: "revoked",
          revoke_reason: "rotated_on_reissue",
        }),
      ],
      expect.objectContaining({ transactionManager: {} }),
    )
    expect(service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(service.updateDigitalEntitlements).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dent_guest_reissue",
        guest_access_epoch: 5,
      }),
      expect.objectContaining({ transactionManager: {} }),
    )
    expect(result).toMatchObject({
      entitlement: { id: "dent_guest_reissue" },
      guest_access_required: true,
      delivery: { id: "dnotif_reissue" },
    })
    expect(result).not.toHaveProperty("guest_access")
    expect(service.createNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        entitlement_id: "dent_guest_reissue",
        template: "digital-downloads-reissued",
        payload: expect.objectContaining({
          guest_access: true,
          guest_access_epoch: 5,
        }),
      }),
      expect.objectContaining({ transactionManager: {} }),
    )
    expect(service.lockRows_).toHaveBeenCalledWith(
      "notification_delivery",
      [queuedDelivery.id],
      expect.objectContaining({ transactionManager: {} }),
    )
    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        id: queuedDelivery.id,
        state: "canceled",
        error_code: "guest_access_epoch_superseded",
        payload: { ordinary_field: "preserved" },
      }),
      expect.objectContaining({ transactionManager: {} }),
    )
    expect(service.updateNotificationDeliveries).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: checkpointedDelivery.id }),
      expect.anything(),
    )
    expect(result.entitlement.metadata.last_reissued_at).toEqual(
      expect.any(String),
    )
  })
})

describe("revokeGuestAccessSession", () => {
  function serviceFor(session: Record<string, any> | undefined) {
    const stored = session
      ? { entitlement_id: "dent_guest", ...session }
      : undefined
    return {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      listEntitlementAccessSessions: jest
        .fn()
        .mockResolvedValue(stored ? [stored] : []),
      retrieveEntitlementAccessSession: jest.fn().mockResolvedValue(stored),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue({
        ...stored,
        status: "revoked",
      }),
      safeAccessSession: jest.fn((value) => ({
        id: value.id,
        status: value.status,
        revoke_reason: value.revoke_reason ?? null,
      })),
    }
  }

  it("revokes an active session once and returns a safe projection", async () => {
    const service = serviceFor({ id: "daccess_1", status: "active" })

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .revokeGuestAccessSession.call(
        service,
        "daccess_1",
        "notification_cleanup",
        { transactionManager: {} },
      )

    expect(service.listEntitlementAccessSessions).toHaveBeenCalledWith(
      { id: "daccess_1" },
      {},
      expect.objectContaining({ manager: {} }),
    )
    expect(service.lockRows_.mock.calls.map(([table]) => table)).toEqual([
      "digital_entitlement",
      "entitlement_access_session",
    ])
    expect(service.retrieveEntitlementAccessSession).toHaveBeenCalledWith(
      "daccess_1",
      { options: { refresh: true } },
      expect.objectContaining({ manager: {} }),
    )
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "daccess_1",
        status: "revoked",
        revoke_reason: "notification_cleanup",
      }),
      expect.objectContaining({ manager: {} }),
    )
    expect(result).toEqual(
      expect.objectContaining({ id: "daccess_1", status: "revoked" }),
    )
  })

  it("is idempotent for an already inactive session", async () => {
    const service = serviceFor({ id: "daccess_1", status: "revoked" })

    await (DigitalDownloadsModuleService.prototype as any)
      .revokeGuestAccessSession.call(service, "daccess_1", undefined, {
        transactionManager: {},
      })

    expect(service.updateEntitlementAccessSessions).not.toHaveBeenCalled()
    expect(service.safeAccessSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revoked" }),
    )
  })

  it("fails rather than claiming cleanup succeeded for a missing session", async () => {
    const service = serviceFor(undefined)

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .revokeGuestAccessSession.call(service, "daccess_missing", undefined, {
          transactionManager: {},
        }),
    ).rejects.toThrow("Guest access session was not found")
    expect(service.lockRows_).not.toHaveBeenCalled()
  })
})

describe("resolveGuestEntitlement", () => {
  it("includes ACTIVE in the compare-and-swap selector", async () => {
    const rawToken = "dda_guest_token_with_sufficient_entropy_0001"
    const session = {
      id: "daccess_active",
      entitlement_id: "dent_guest",
      status: AccessSessionStatus.ACTIVE,
      token_hash: tokenHash(rawToken, TOKEN_SECRET),
      expires_at: new Date(Date.now() + 60_000),
      use_count: 4,
      bound_ip_hash: null,
      bound_user_agent_hash: null,
      metadata: { guest_access_epoch: 0 },
    }
    const updated = { ...session, use_count: 5, last_used_at: new Date() }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        tokenSecret: TOKEN_SECRET,
      },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        require_order_email_match: true,
      }),
      lockRows_: jest.fn().mockResolvedValue(undefined),
      discoverGuestAccessSession_: jest.fn().mockResolvedValue({
        hash: tokenHash(rawToken, TOKEN_SECRET),
        session,
      }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([session]),
      retrieveEntitlementAccessSession: jest.fn().mockResolvedValue(session),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest",
        status: DigitalEntitlementStatus.ACTIVE,
        available_at: null,
        expires_at: null,
        customer_email: "buyer@example.test",
        guest_access_epoch: 0,
      }),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue([updated]),
      safeAccessSession: jest.fn((value) => value),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .resolveGuestEntitlement.call(
          service,
          rawToken,
          { email: " BUYER@EXAMPLE.TEST " },
          { transactionManager: {} },
        ),
    ).resolves.toMatchObject({
      entitlement: { id: "dent_guest" },
      session: { id: "daccess_active", use_count: 5 },
    })
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      {
        selector: {
          id: "daccess_active",
          status: AccessSessionStatus.ACTIVE,
          use_count: 4,
        },
        data: {
          use_count: 5,
          last_used_at: expect.any(Date),
        },
      },
      expect.objectContaining({ manager: {} }),
    )
    expect(service.lockRows_.mock.calls.map(([table]) => table)).toEqual([
      "digital_entitlement",
      "entitlement_access_session",
    ])
  })

  it("denies and attempts to revoke an ACTIVE session from an older epoch", async () => {
    const rawToken = "dda_guest_token_with_sufficient_entropy_stale"
    const session = {
      id: "daccess_stale",
      entitlement_id: "dent_guest",
      status: AccessSessionStatus.ACTIVE,
      token_hash: tokenHash(rawToken, TOKEN_SECRET),
      expires_at: new Date(Date.now() + 60_000),
      use_count: 0,
      bound_ip_hash: null,
      bound_user_agent_hash: null,
      metadata: { guest_access_epoch: 0 },
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: { tokenSecret: TOKEN_SECRET },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        require_order_email_match: false,
      }),
      lockRows_: jest.fn().mockResolvedValue(undefined),
      discoverGuestAccessSession_: jest.fn().mockResolvedValue({
        hash: tokenHash(rawToken, TOKEN_SECRET),
        session,
      }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([session]),
      retrieveEntitlementAccessSession: jest.fn().mockResolvedValue(session),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest",
        status: DigitalEntitlementStatus.ACTIVE,
        available_at: null,
        expires_at: null,
        customer_email: "buyer@example.test",
        guest_access_epoch: 1,
      }),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue({
        ...session,
        status: AccessSessionStatus.REVOKED,
      }),
      safeAccessSession: jest.fn((value) => value),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .resolveGuestEntitlement.call(
          service,
          rawToken,
          {},
          { transactionManager: {} },
        ),
    ).rejects.toThrow("Guest access session is inactive")
    expect(service.lockRows_.mock.calls.map(([table]) => table)).toEqual([
      "digital_entitlement",
      "entitlement_access_session",
    ])
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        status: AccessSessionStatus.REVOKED,
        revoke_reason: "guest_access_epoch_superseded",
        revoked_at: expect.any(Date),
      }),
      expect.objectContaining({ manager: {} }),
    )
  })
})
