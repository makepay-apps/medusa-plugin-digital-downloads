import { DigitalDownloadsModuleService } from ".."
import {
  DigitalEntitlementStatus,
  NotificationDeliveryState,
} from "../types"

const transactionContext = { transactionManager: { id: "expiry-test" } }

function expiryService(
  status = DigitalEntitlementStatus.ACTIVE,
  metadata: Record<string, unknown> = {},
) {
  const current = {
    id: "dent_due",
    status,
    customer_email: "buyer@example.com",
    order_id: "order_due",
    metadata,
  }
  const service: Record<string, any> = {
    baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
    lockRows_: jest.fn().mockResolvedValue(undefined),
    retrieveDigitalEntitlement: jest.fn().mockResolvedValue(current),
    revokeEntitlement: jest.fn().mockResolvedValue({
      ...current,
      status: DigitalEntitlementStatus.REVOKED,
      metadata: { last_revocation_id: "revocation_1" },
    }),
    updateDigitalEntitlements: jest.fn(async (update) => ({
      ...current,
      ...update,
    })),
    listNotificationDeliveries: jest.fn().mockResolvedValue([]),
    recipientHash: jest.fn().mockResolvedValue("recipient_hash"),
    createNotificationDeliveries: jest.fn(async (row) => ({
      id: "ndel_expired",
      ...row,
    })),
  }
  return service
}

describe("expireEntitlement", () => {
  it("expires state and persists a cycle-specific notification in one context", async () => {
    const service = expiryService()

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(
        service,
        "dent_due",
        "Entitlement access period expired",
        transactionContext,
      )

    expect(service.revokeEntitlement).toHaveBeenCalledWith(
      "dent_due",
      "Entitlement access period expired",
      { type: "scheduled_job", id: "expire-entitlements" },
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(service.updateDigitalEntitlements).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "dent_due",
        status: DigitalEntitlementStatus.EXPIRED,
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    const created = service.createNotificationDeliveries.mock.calls[0][0]
    expect(created).toEqual(
      expect.objectContaining({
        entitlement_id: "dent_due",
        idempotency_key: expect.stringMatching(
          /^dent_due:expired:[0-9a-f-]{36}$/,
        ),
        template: "digital-downloads-expired",
        state: NotificationDeliveryState.PENDING,
      }),
    )
    expect(service.createNotificationDeliveries).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result).toMatchObject({
      entitlement: { id: "dent_due", status: DigitalEntitlementStatus.EXPIRED },
      delivery: {
        id: "ndel_expired",
        idempotency_key: created.idempotency_key,
      },
    })
  })

  it("reuses a legacy v1 delivery for an upgraded expired entitlement", async () => {
    const service = expiryService(DigitalEntitlementStatus.EXPIRED)
    service.listNotificationDeliveries.mockImplementation(
      async ({ idempotency_key }) =>
        idempotency_key === "dent_due:expired:v1"
          ? [{ id: "ndel_legacy", idempotency_key }]
          : [],
    )

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(
        service,
        "dent_due",
        undefined,
        transactionContext,
      )

    expect(service.revokeEntitlement).not.toHaveBeenCalled()
    expect(service.updateDigitalEntitlements).not.toHaveBeenCalled()
    expect(service.listNotificationDeliveries).toHaveBeenCalledWith(
      { idempotency_key: "dent_due:expired:v1" },
      { take: 1 },
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result.delivery).toMatchObject({
      id: "ndel_legacy",
      idempotency_key: "dent_due:expired:v1",
    })
    expect(service.createNotificationDeliveries).not.toHaveBeenCalled()
  })

  it("repairs a legacy expired row without a seeded cycle exactly once", async () => {
    const service = expiryService(DigitalEntitlementStatus.EXPIRED)

    const first = await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(
        service,
        "dent_due",
        undefined,
        transactionContext,
      )
    const firstKey = first.delivery.idempotency_key
    expect(firstKey).toMatch(/^dent_due:expired:[0-9a-f-]{36}$/)
    expect(first.entitlement.metadata.last_expiration_id).toBe(
      firstKey.slice("dent_due:expired:".length),
    )

    service.retrieveDigitalEntitlement.mockResolvedValue(first.entitlement)
    service.listNotificationDeliveries.mockImplementation(
      async ({ idempotency_key }) =>
        idempotency_key === firstKey ? [first.delivery] : [],
    )
    const second = await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(
        service,
        "dent_due",
        undefined,
        transactionContext,
      )

    expect(second.delivery).toBe(first.delivery)
    expect(service.createNotificationDeliveries).toHaveBeenCalledTimes(1)
  })

  it("uses a distinct key for each new expiration cycle", async () => {
    const first = expiryService()
    const second = expiryService()

    await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(first, "dent_due", undefined, transactionContext)
    await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlement.call(second, "dent_due", undefined, transactionContext)

    const firstKey =
      first.createNotificationDeliveries.mock.calls[0][0].idempotency_key
    const secondKey =
      second.createNotificationDeliveries.mock.calls[0][0].idempotency_key
    expect(firstKey).not.toBe(secondKey)
  })
})

describe("expireEntitlementIfDue", () => {
  it("does not expire an entitlement reissued beyond the maintenance cutoff", async () => {
    const current = {
      id: "dent_reissued",
      status: DigitalEntitlementStatus.ACTIVE,
      expires_at: new Date("2026-09-01T00:00:00.000Z"),
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue(current),
      expireEntitlement: jest.fn(),
    }

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .expireEntitlementIfDue.call(
        service,
        {
          entitlement_id: current.id,
          as_of: "2026-08-01T00:00:00.000Z",
        },
        transactionContext,
      )

    expect(service.lockRows_).toHaveBeenCalledWith(
      "digital_entitlement",
      [current.id],
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result).toEqual({ entitlement: current, expired: false })
    expect(service.expireEntitlement).not.toHaveBeenCalled()
  })
})

describe("repairLifecycleNotification", () => {
  it("is a no-op when the scanned terminal status changed before locking", async () => {
    const current = {
      id: "dent_reissued",
      status: DigitalEntitlementStatus.ACTIVE,
    }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue(current),
      expireEntitlement: jest.fn(),
      revokeEntitlementWithNotification: jest.fn(),
    }

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .repairLifecycleNotification.call(
        service,
        {
          entitlement_id: current.id,
          expected_status: DigitalEntitlementStatus.EXPIRED,
          reason: "Entitlement access period expired",
        },
        transactionContext,
      )

    expect(result).toEqual({ entitlement: current, repaired: false })
    expect(service.expireEntitlement).not.toHaveBeenCalled()
    expect(service.revokeEntitlementWithNotification).not.toHaveBeenCalled()
  })
})

describe("reissueEntitlement expiry renewal", () => {
  afterEach(() => jest.useRealTimers())

  function reissueService(status = DigitalEntitlementStatus.EXPIRED) {
    const previous = {
      id: "dent_expired",
      status,
      customer_id: "cus_1",
      customer_email: "buyer@example.com",
      digital_product_id: "dprod_1",
      expires_at: new Date("2026-08-01T00:00:00.000Z"),
      created_at: new Date("2026-07-02T00:00:00.000Z"),
      snapshot: { purchased_at: "2026-07-02T00:00:00.000Z" },
      metadata: { last_expiration_id: "expired-cycle" },
    }
    return {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue(previous),
      getSettings: jest.fn().mockResolvedValue({ allow_guest_access: true }),
      updateDigitalEntitlements: jest.fn(async (row) => ({
        ...previous,
        ...row,
      })),
      listLicensePolicies: jest.fn().mockResolvedValue([]),
    }
  }

  it("renews a past deadline using the recorded purchase term", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = reissueService()

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        { entitlement_id: "dent_expired", notify: false },
        transactionContext,
      )

    expect(result.entitlement).toMatchObject({
      status: DigitalEntitlementStatus.ACTIVE,
      expires_at: new Date("2026-09-02T00:00:00.000Z"),
    })
    expect(result.entitlement.metadata).toMatchObject({
      last_reissue_previous_expires_at: "2026-08-01T00:00:00.000Z",
      last_reissue_expires_at: "2026-09-02T00:00:00.000Z",
    })
  })

  it("keeps the same term across repeated expire and reissue cycles", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = reissueService()

    const first = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        { entitlement_id: "dent_expired", notify: false },
        transactionContext,
      )
    service.retrieveDigitalEntitlement.mockResolvedValue({
      ...first.entitlement,
      status: DigitalEntitlementStatus.EXPIRED,
    })
    jest.setSystemTime(new Date("2026-09-03T00:00:00.000Z"))

    const second = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        { entitlement_id: "dent_expired", notify: false },
        transactionContext,
      )

    expect(second.entitlement.expires_at).toEqual(
      new Date("2026-10-03T00:00:00.000Z"),
    )
  })

  it("supports an explicit perpetual reissue", async () => {
    const service = reissueService()

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        { entitlement_id: "dent_expired", expires_at: null, notify: false },
        transactionContext,
      )

    expect(result.entitlement.expires_at).toBeNull()
    expect(result.entitlement.metadata.last_reissue_expires_at).toBeNull()
  })

  it("replaces the deadline with the exact explicit future expires_at", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = reissueService()

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .reissueEntitlement.call(
        service,
        {
          entitlement_id: "dent_expired",
          expires_at: "2026-10-15T12:34:56.000Z",
          notify: false,
        },
        transactionContext,
      )

    expect(result.entitlement.expires_at).toEqual(
      new Date("2026-10-15T12:34:56.000Z"),
    )
    expect(result.entitlement.metadata.last_reissue_expires_at).toBe(
      "2026-10-15T12:34:56.000Z",
    )
  })

  it("rejects an explicit deadline that is not in the future", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-03T00:00:00.000Z"))
    const service = reissueService()

    await expect(
      (DigitalDownloadsModuleService.prototype as any).reissueEntitlement.call(
        service,
        {
          entitlement_id: "dent_expired",
          expires_at: "2026-08-02T00:00:00.000Z",
          notify: false,
        },
        transactionContext,
      ),
    ).rejects.toThrow("expires_at must be later than the reissue time")
    expect(service.updateDigitalEntitlements).not.toHaveBeenCalled()
  })

  it("does not reopen refunded ownership", async () => {
    const service = reissueService(DigitalEntitlementStatus.REFUNDED)

    await expect(
      (DigitalDownloadsModuleService.prototype as any).reissueEntitlement.call(
        service,
        { entitlement_id: "dent_expired", expires_at: null },
        transactionContext,
      ),
    ).rejects.toThrow("Refunded entitlements require a new order")
  })
})
