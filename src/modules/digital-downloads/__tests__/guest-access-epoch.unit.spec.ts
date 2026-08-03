import { DigitalDownloadsModuleService } from ".."

const transactionContext = { transactionManager: { id: "guest-epoch-test" } }

function finalizationService({
  currentEpoch,
  expectedEpoch,
  sessionStatus = "pending",
}: {
  currentEpoch: number
  expectedEpoch: number
  sessionStatus?: string
}) {
  const delivery = {
    id: "dnotif_epoch",
    entitlement_id: "dent_epoch",
    state: "processing",
    lease_owner: "worker_epoch",
    payload: { guest_access: true, guest_access_epoch: expectedEpoch },
    metadata: {
      notification_capability: {
        version: 2,
        phase: "sent_redacted",
        attempt: 2,
        guest_access_epoch: expectedEpoch,
        guest_session_id: "daccess_epoch",
      },
    },
  }
  const session = {
    id: "daccess_epoch",
    entitlement_id: "dent_epoch",
    status: sessionStatus,
    expires_at: "2099-09-01T00:00:00.000Z",
    metadata: {
      notification_delivery_id: "dnotif_epoch",
      guest_access_epoch: expectedEpoch,
    },
  }
  const service: Record<string, any> = {
    baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
    lockRows_: jest.fn().mockResolvedValue(undefined),
    retrieveNotificationDelivery: jest.fn().mockResolvedValue(delivery),
    retrieveEntitlementAccessSession: jest.fn().mockResolvedValue(session),
    retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
      id: "dent_epoch",
      status: "active",
      available_at: null,
      expires_at: null,
      guest_access_epoch: currentEpoch,
    }),
    updateEntitlementAccessSessions: jest.fn(async (update) => {
      Object.assign(session, update)
      return session
    }),
    updateNotificationDeliveries: jest.fn(async (update) => {
      Object.assign(delivery, update)
      return delivery
    }),
    safeAccessSession: jest.fn((value) => value),
  }
  return { delivery, service, session }
}

describe("guest access epoch fencing", () => {
  it("rejects stale capability creation before idempotency replay or insert", async () => {
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        tokenSecret: "guest-epoch-test-token-secret-32-bytes",
        guestAccessTtlSeconds: 2_592_000,
      },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        guest_access_ttl_seconds: 2_592_000,
      }),
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_epoch",
        status: "active",
        available_at: null,
        expires_at: null,
        guest_access_epoch: 2,
      }),
      listEntitlementAccessSessions: jest.fn(),
      createEntitlementAccessSessions: jest.fn(),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .createGuestAccessSession.call(
          service,
          {
            entitlement_id: "dent_epoch",
            idempotency_key: "notification:epoch:1",
            expected_guest_access_epoch: 1,
          },
          transactionContext,
        ),
    ).rejects.toMatchObject({
      code: "guest_access_epoch_superseded",
      expectedEpoch: 1,
      currentEpoch: 2,
    })
    expect(service.listEntitlementAccessSessions).not.toHaveBeenCalled()
    expect(service.createEntitlementAccessSessions).not.toHaveBeenCalled()
  })

  it("stores the authoritative epoch after caller metadata", async () => {
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        tokenSecret: "guest-epoch-test-token-secret-32-bytes",
        guestAccessTtlSeconds: 2_592_000,
      },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        guest_access_ttl_seconds: 2_592_000,
      }),
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_epoch",
        status: "active",
        available_at: null,
        expires_at: null,
        guest_access_epoch: 2,
      }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([]),
      createEntitlementAccessSessions: jest.fn(async (row) => ({
        id: "daccess_epoch",
        ...row,
      })),
      safeAccessSession: jest.fn((value) => value),
    }

    await (DigitalDownloadsModuleService.prototype as any)
      .createGuestAccessSession.call(
        service,
        {
          entitlement_id: "dent_epoch",
          idempotency_key: "notification:epoch:2",
          expected_guest_access_epoch: 2,
          metadata: { guest_access_epoch: 999, purpose: "notification_delivery" },
        },
        transactionContext,
      )

    expect(service.createEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          purpose: "notification_delivery",
          guest_access_epoch: 2,
        },
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
  })

  it("refuses an idempotency replay whose same-epoch session is no longer usable", async () => {
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      options_: {
        tokenSecret: "guest-epoch-test-token-secret-32-bytes",
        guestAccessTtlSeconds: 2_592_000,
      },
      getSettings: jest.fn().mockResolvedValue({
        allow_guest_access: true,
        guest_access_ttl_seconds: 2_592_000,
      }),
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue({
        id: "dent_epoch",
        status: "active",
        available_at: null,
        expires_at: null,
        guest_access_epoch: 2,
      }),
      listEntitlementAccessSessions: jest.fn().mockResolvedValue([
        {
          id: "daccess_revoked",
          entitlement_id: "dent_epoch",
          status: "revoked",
          metadata: { guest_access_epoch: 2 },
        },
      ]),
      createEntitlementAccessSessions: jest.fn(),
      safeAccessSession: jest.fn((value) => value),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .createGuestAccessSession.call(
          service,
          {
            entitlement_id: "dent_epoch",
            idempotency_key: "notification:epoch:2:revoked",
            expected_guest_access_epoch: 2,
            initial_status: "pending",
          },
          transactionContext,
        ),
    ).rejects.toThrow("Idempotent guest access session is no longer usable")
    expect(service.createEntitlementAccessSessions).not.toHaveBeenCalled()
    expect(service.safeAccessSession).not.toHaveBeenCalled()
  })

  it("atomically revokes and cancels when reissue wins the epoch lock", async () => {
    const { delivery, service, session } = finalizationService({
      currentEpoch: 2,
      expectedEpoch: 1,
    })

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .finalizeNotificationGuestAccess.call(
        service,
        {
          delivery_id: delivery.id,
          entitlement_id: "dent_epoch",
          session_id: session.id,
          expected_guest_access_epoch: 1,
          worker_id: "worker_epoch",
          attempt: 2,
          provider_message_id: "provider_epoch",
        },
        transactionContext,
      )

    expect(service.lockRows_.mock.calls.map(([table]) => table)).toEqual([
      "digital_entitlement",
      "entitlement_access_session",
      "notification_delivery",
    ])
    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        status: "revoked",
        revoke_reason: "notification_guest_access_superseded",
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        id: delivery.id,
        state: "canceled",
        error_code: "guest_access_epoch_superseded",
        payload: expect.not.objectContaining({ guest_access: expect.anything() }),
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result.outcome).toBe("superseded")
  })

  it("activates the session and marks SENT in one matching-epoch transaction", async () => {
    const { delivery, service, session } = finalizationService({
      currentEpoch: 2,
      expectedEpoch: 2,
    })

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .finalizeNotificationGuestAccess.call(
        service,
        {
          delivery_id: delivery.id,
          entitlement_id: "dent_epoch",
          session_id: session.id,
          expected_guest_access_epoch: 2,
          worker_id: "worker_epoch",
          attempt: 2,
          provider_message_id: "provider_epoch",
        },
        transactionContext,
      )

    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      { id: session.id, status: "active" },
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        id: delivery.id,
        state: "sent",
        provider_message_id: "provider_epoch",
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result.outcome).toBe("sent")
  })

  it("revokes without activation and finalizes SENT when entitlement invalidation wins after provider send", async () => {
    const { delivery, service, session } = finalizationService({
      currentEpoch: 2,
      expectedEpoch: 2,
    })
    service.retrieveDigitalEntitlement.mockResolvedValue({
      id: "dent_epoch",
      status: "revoked",
      available_at: null,
      expires_at: null,
      guest_access_epoch: 2,
    })

    const result = await (DigitalDownloadsModuleService.prototype as any)
      .finalizeNotificationGuestAccess.call(
        service,
        {
          delivery_id: delivery.id,
          entitlement_id: "dent_epoch",
          session_id: session.id,
          expected_guest_access_epoch: 2,
          worker_id: "worker_epoch",
          attempt: 2,
          provider_message_id: "provider_epoch",
        },
        transactionContext,
      )

    expect(service.updateEntitlementAccessSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        id: session.id,
        status: "revoked",
        revoke_reason: "notification_entitlement_unusable_after_send",
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(service.updateEntitlementAccessSessions).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
      expect.anything(),
    )
    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({
        id: delivery.id,
        state: "sent",
        provider_message_id: "provider_epoch",
      }),
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(result.outcome).toBe("sent")
  })

  it.each([
    {
      name: "an unusable entitlement",
      entitlement: {
        id: "dent_epoch",
        status: "revoked",
        available_at: null,
        expires_at: null,
        guest_access_epoch: 2,
      },
      expectedError: "Digital entitlement is not active",
    },
    {
      name: "a stale access epoch",
      entitlement: {
        id: "dent_epoch",
        status: "active",
        available_at: null,
        expires_at: null,
        guest_access_epoch: 2,
      },
      expectedError: "Guest access generation was superseded",
    },
  ])("refuses activation for $name", async ({ entitlement, expectedError }) => {
    const session = {
      id: "daccess_activate",
      entitlement_id: "dent_epoch",
      status: "pending",
      expires_at: "2099-09-01T00:00:00.000Z",
      metadata: {
        notification_delivery_id: "dnotif_activate",
        guest_access_epoch: 1,
      },
    }
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveEntitlementAccessSession: jest.fn().mockResolvedValue(session),
      retrieveDigitalEntitlement: jest.fn().mockResolvedValue(entitlement),
      updateEntitlementAccessSessions: jest.fn(),
      safeAccessSession: jest.fn((value) => value),
    }

    await expect(
      (DigitalDownloadsModuleService.prototype as any)
        .activateGuestAccessSession.call(
          service,
          session.id,
          {
            expected_guest_access_epoch: 1,
            notification_delivery_id: "dnotif_activate",
          },
          transactionContext,
        ),
    ).rejects.toThrow(expectedError)
    expect(service.lockRows_.mock.calls.map(([table]) => table)).toEqual([
      "digital_entitlement",
      "entitlement_access_session",
    ])
    expect(service.updateEntitlementAccessSessions).not.toHaveBeenCalled()
  })

  it("updates a notification outcome only while the worker still owns its processing lease", async () => {
    const delivery = {
      id: "dnotif_claimed",
      state: "processing",
      lease_owner: "worker_claimed",
    }
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveNotificationDelivery: jest.fn().mockResolvedValue(delivery),
      updateNotificationDeliveries: jest.fn(async (update) => ({
        ...delivery,
        ...update,
      })),
    }

    const changed = await (DigitalDownloadsModuleService.prototype as any)
      .transitionClaimedNotificationDelivery.call(
        service,
        delivery.id,
        "worker_claimed",
        { id: "attacker-selected-id", state: "canceled", error_code: "superseded" },
        transactionContext,
      )

    expect(service.lockRows_).toHaveBeenCalledWith(
      "notification_delivery",
      [delivery.id],
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      {
        id: delivery.id,
        state: "canceled",
        error_code: "superseded",
      },
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(changed).toMatchObject({ state: "canceled" })
  })

  it("checkpoints a claimed notification without changing its processing state", async () => {
    const delivery = {
      id: "dnotif_checkpoint",
      state: "processing",
      lease_owner: "worker_checkpoint",
    }
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveNotificationDelivery: jest.fn().mockResolvedValue(delivery),
      updateNotificationDeliveries: jest.fn(async (update) => ({
        ...delivery,
        ...update,
      })),
    }
    const metadata = {
      notification_capability: { version: 2, phase: "prepared", attempt: 1 },
    }

    const changed = await (DigitalDownloadsModuleService.prototype as any)
      .transitionClaimedNotificationDelivery.call(
        service,
        delivery.id,
        "worker_checkpoint",
        { metadata },
        transactionContext,
      )

    expect(service.updateNotificationDeliveries).toHaveBeenCalledWith(
      { id: delivery.id, metadata },
      expect.objectContaining({
        transactionManager: transactionContext.transactionManager,
      }),
    )
    expect(changed).toMatchObject({ state: "processing", metadata })
  })

  it.each([
    { state: "canceled", lease_owner: null },
    { state: "processing", lease_owner: "another-worker" },
  ])("does not overwrite a $state delivery outside the claimed lease", async (row) => {
    const service: Record<string, any> = {
      baseRepository_: { getFreshManager: jest.fn().mockReturnValue({}) },
      lockRows_: jest.fn().mockResolvedValue(undefined),
      retrieveNotificationDelivery: jest.fn().mockResolvedValue({
        id: "dnotif_claim_lost",
        ...row,
      }),
      updateNotificationDeliveries: jest.fn(),
    }

    const changed = await (DigitalDownloadsModuleService.prototype as any)
      .transitionClaimedNotificationDelivery.call(
        service,
        "dnotif_claim_lost",
        "worker_claimed",
        { state: "failed" },
        transactionContext,
      )

    expect(changed).toBeNull()
    expect(service.updateNotificationDeliveries).not.toHaveBeenCalled()
  })
})
