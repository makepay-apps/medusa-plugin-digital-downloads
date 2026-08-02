import { DigitalDownloadsModuleService } from ".."
import { AccessSessionStatus, DigitalEntitlementStatus } from "../types"

describe("revokeGuestAccessSession", () => {
  function serviceFor(session: Record<string, any> | undefined) {
    return {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue(session ? [session] : []),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue({
        ...session,
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
      expect.objectContaining({ manager: {} })
    )
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "daccess_1",
        status: "revoked",
        revoke_reason: "notification_cleanup",
      }),
      expect.objectContaining({ manager: {} })
    )
    expect(result).toEqual(expect.objectContaining({ id: "daccess_1", status: "revoked" }))
  })

  it("is idempotent for an already inactive session", async () => {
    const service = serviceFor({ id: "daccess_1", status: "revoked" })

    await (DigitalDownloadsModuleService.prototype as any)
      .revokeGuestAccessSession.call(service, "daccess_1", undefined, {
        transactionManager: {},
      })

    expect(service.updateEntitlementAccessSessions).not.toHaveBeenCalled()
    expect(service.safeAccessSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revoked" })
    )
  })

  it("fails rather than claiming cleanup succeeded for a missing session", async () => {
    const service = serviceFor(undefined)

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .revokeGuestAccessSession.call(service, "daccess_missing", undefined, {
          transactionManager: {},
        })
    ).rejects.toThrow("Guest access session was not found")
  })
})

describe("resolveGuestEntitlement", () => {
  it("includes ACTIVE in the compare-and-swap selector", async () => {
    const session = {
      id: "daccess_active",
      entitlement_id: "dent_guest",
      status: AccessSessionStatus.ACTIVE,
      expires_at: new Date(Date.now() + 60_000),
      use_count: 4,
      bound_ip_hash: null,
      bound_user_agent_hash: null,
    }
    const updated = { ...session, use_count: 5, last_used_at: new Date() }
    const service = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        tokenSecret: "guest-session-unit-token-secret-32-bytes-minimum",
      },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        require_order_email_match: true,
      }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([session]),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_guest",
        status: DigitalEntitlementStatus.ACTIVE,
        available_at: null,
        expires_at: null,
        customer_email: "buyer@example.test",
      }),
      updateEntitlementAccessSessions: jest.fn().mockResolvedValue([updated]),
      safeAccessSession: jest.fn((value) => value),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .resolveGuestEntitlement.call(
          service,
          "dda_guest_token_with_sufficient_entropy_0001",
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
  })
})
