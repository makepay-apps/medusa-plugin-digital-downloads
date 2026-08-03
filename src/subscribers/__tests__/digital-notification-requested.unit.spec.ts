import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../modules/digital-downloads"
import { GuestAccessEpochSupersededError } from "../../modules/digital-downloads/service"
import handler from "../digital-notification-requested"

const rawToken = "dda_never_log_this_capability"

function guestDelivery(overrides: Record<string, any> = {}) {
  return {
    id: "ndel_guest",
    entitlement_id: "dent_guest",
    idempotency_key: "legacy-delivery-key",
    channel: "email",
    template: "digital-downloads-delivery",
    state: "processing",
    attempt_count: 1,
    max_attempts: 8,
    payload: { guest_access: true },
    metadata: {},
    entitlement: {
      id: "dent_guest",
      customer_id: null,
      customer_email: "guest@example.com",
      snapshot: { product: { title: "Album" } },
    },
    ...overrides,
  }
}

function dependencies(
  delivery: Record<string, any>,
  overrides: {
    service?: Record<string, any>
    notificationService?: Record<string, any>
    locking?: Record<string, any>
  } = {}
) {
  const deliveryUpdates: any[] = []
  const service = {
    claimNotificationDelivery: jest.fn().mockResolvedValue(delivery),
    retrieveDigitalEntitlement: jest
      .fn()
      .mockResolvedValue(delivery.entitlement),
    updateNotificationDeliveries: jest.fn(async (update) => {
      deliveryUpdates.push(update)
      Object.assign(delivery, update)
      return delivery
    }),
    createGuestAccessSession: jest.fn().mockResolvedValue({
      session: {
        id: "dasess_1",
        status: "pending",
        expires_at: "2026-08-01T00:00:00.000Z",
      },
      token: rawToken,
      created: true,
    }),
    activateGuestAccessSession: jest.fn().mockResolvedValue({
      id: "dasess_1",
      status: "active",
    }),
    revokeGuestAccessSession: jest.fn().mockResolvedValue({
      id: "dasess_1",
      status: "revoked",
    }),
    ...overrides.service,
  }
  ;(service as any).transitionClaimedNotificationDelivery ??= jest.fn(
    async (deliveryId, _workerId, update) => {
      if (["sent", "canceled", "dead_letter"].includes(delivery.state)) {
        return null
      }
      return service.updateNotificationDeliveries({
        ...update,
        id: deliveryId,
      })
    }
  )
  ;(service as any).finalizeNotificationGuestAccess ??= jest.fn(async (input) => {
    const session = await service.activateGuestAccessSession(input.session_id)
    const changed = await service.updateNotificationDeliveries({
      id: input.delivery_id,
      state: "sent",
      attempt_count: input.attempt,
      sent_at: new Date(),
      provider_message_id: input.provider_message_id ?? null,
      lease_owner: null,
      lease_expires_at: null,
      next_retry_at: null,
      error_code: null,
      error_message: null,
    })
    return { outcome: "sent", delivery: changed, session }
  })
  const notificationService = {
    createNotifications: jest.fn().mockResolvedValue({ id: "noti_1" }),
    updateNotifications: jest.fn().mockResolvedValue({ id: "noti_1" }),
    listNotifications: jest.fn().mockResolvedValue([]),
    ...overrides.notificationService,
  }
  const logger = { error: jest.fn() }
  const locking = overrides.locking ?? {
    execute: jest.fn(async (_key, job) => await job()),
  }
  const container = {
    resolve: jest.fn((key) => {
      if (key === DIGITAL_DOWNLOADS_MODULE) return service
      if (key === Modules.NOTIFICATION) return notificationService
      if (key === Modules.LOCKING) return locking
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      throw new Error(`Unexpected dependency ${String(key)}`)
    }),
  }
  return { container, deliveryUpdates, logger, locking, notificationService, service }
}

async function deliver(container: any, deliveryId = "ndel_guest") {
  await handler({
    event: {
      name: "digital_downloads.notification.requested",
      data: { delivery_id: deliveryId },
    },
    container,
  } as any)
}

describe("digital notification delivery", () => {
  it("hydrates a partial entitlement relation before resolving the recipient", async () => {
    const fullEntitlement = {
      id: "dent_partial",
      customer_id: "cus_partial",
      customer_email: "buyer@example.com",
      snapshot: { product: { title: "Album" } },
    }
    const delivery = guestDelivery({
      id: "ndel_partial",
      entitlement_id: fullEntitlement.id,
      payload: {},
      entitlement: { id: fullEntitlement.id },
    })
    const deps = dependencies(delivery, {
      service: {
        retrieveDigitalEntitlement: jest.fn().mockResolvedValue(fullEntitlement),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.service.retrieveDigitalEntitlement).toHaveBeenCalledWith(
      fullEntitlement.id
    )
    expect(deps.notificationService.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        to: fullEntitlement.customer_email,
        receiver_id: fullEntitlement.customer_id,
      })
    )
    expect(delivery.state).toBe("sent")
  })

  it("projects an allowlisted notification payload instead of forwarding purchase metadata", async () => {
    const fullEntitlement = {
      id: "dent_projection",
      order_id: "order_projection",
      order_line_item_id: "item_projection",
      digital_product_id: "dprod_projection",
      release_id: "drel_projection",
      customer_id: "cus_projection",
      customer_email: "buyer@example.com",
      snapshot: {
        order: { id: "order_projection", display_id: 1042 },
        line_item: {
          id: "item_projection",
          title: "Safe album title",
          metadata: { api_key: "api-secret-marker" },
        },
        digital_product: {
          id: "dprod_projection",
          name: "Safe album",
          metadata: { client_secret: "client-secret-marker" },
        },
        release: {
          id: "drel_projection",
          version: "1.0.0",
          metadata: { authorization: "authorization-secret-marker" },
        },
        assets: [{ metadata: { refresh_token: "refresh-secret-marker" } }],
      },
    }
    const delivery = guestDelivery({
      id: "ndel_projection",
      entitlement_id: fullEntitlement.id,
      payload: {
        entitlement_id: fullEntitlement.id,
        order_id: fullEntitlement.order_id,
        notification_type: "delivery",
        reason: "Purchase completed",
        refresh_token: "payload-secret-marker",
        arbitrary: { nested: "untrusted-marker" },
      },
      entitlement: { id: fullEntitlement.id },
    })
    const deps = dependencies(delivery, {
      service: {
        retrieveDigitalEntitlement: jest.fn().mockResolvedValue(fullEntitlement),
      },
    })

    await deliver(deps.container, delivery.id)

    const providerData =
      deps.notificationService.createNotifications.mock.calls[0][0].data
    expect(providerData).toMatchObject({
      entitlement_id: fullEntitlement.id,
      order_id: fullEntitlement.order_id,
      notification_type: "delivery",
      reason: "Purchase completed",
      entitlement: {
        order: { id: fullEntitlement.order_id, display_id: 1042 },
        line_item: { id: "item_projection", title: "Safe album title" },
        digital_product: { id: "dprod_projection", name: "Safe album" },
        release: { id: "drel_projection", version: "1.0.0" },
      },
    })
    const serialized = JSON.stringify(providerData)
    for (const marker of [
      "api-secret-marker",
      "client-secret-marker",
      "authorization-secret-marker",
      "refresh-secret-marker",
      "payload-secret-marker",
      "untrusted-marker",
    ]) {
      expect(serialized).not.toContain(marker)
    }
  })

  it("reconciles a successful customer provider send after its checkpoint write fails", async () => {
    const fullEntitlement = {
      id: "dent_customer_recovery",
      customer_id: "cus_customer_recovery",
      customer_email: "customer@example.com",
      snapshot: { product: { title: "Album" } },
    }
    const delivery = guestDelivery({
      id: "ndel_customer_recovery",
      entitlement_id: fullEntitlement.id,
      payload: {},
      entitlement: { id: fullEntitlement.id },
    })
    const persistedNotifications: Record<string, any>[] = []
    let failCheckpointOnce = true
    const deps = dependencies(delivery, {
      service: {
        retrieveDigitalEntitlement: jest.fn().mockResolvedValue(fullEntitlement),
        updateNotificationDeliveries: jest.fn(async (update) => {
          if (
            failCheckpointOnce &&
            update.metadata?.notification_capability?.phase === "sent_redacted"
          ) {
            failCheckpointOnce = false
            throw new Error("checkpoint temporarily unavailable")
          }
          Object.assign(delivery, update)
          return delivery
        }),
      },
      notificationService: {
        createNotifications: jest.fn(async (input) => {
          const notification = {
            id: "noti_customer_recovery",
            external_id: "provider_customer_recovery",
            idempotency_key: input.idempotency_key,
            status: "success",
          }
          persistedNotifications.push(notification)
          return notification
        }),
        listNotifications: jest.fn(async ({ idempotency_key }) =>
          persistedNotifications.filter(
            (notification) =>
              notification.idempotency_key === idempotency_key
          )
        ),
      },
    })

    await deliver(deps.container, delivery.id)
    expect(delivery.state).toBe("failed")
    expect(delivery.metadata.notification_capability.phase).toBe("prepared")

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    expect(deps.notificationService.listNotifications).toHaveBeenCalledWith(
      {
        idempotency_key:
          delivery.metadata.notification_capability.notification_idempotency_key,
      },
      { take: 10 }
    )
    expect(delivery).toMatchObject({
      state: "sent",
      provider_message_id: "provider_customer_recovery",
      error_code: null,
      error_message: null,
      metadata: {
        notification_capability: {
          phase: "sent_redacted",
          notification_id: "noti_customer_recovery",
        },
      },
    })
  })

  it("does not reconcile an unrelated successful notification", async () => {
    const expectedIdempotencyKey =
      "dnotif:ndel_customer_mismatch:notification:1:expected"
    const fullEntitlement = {
      id: "dent_customer_mismatch",
      customer_id: "cus_customer_mismatch",
      customer_email: "customer@example.com",
      snapshot: {},
    }
    const delivery = guestDelivery({
      id: "ndel_customer_mismatch",
      entitlement_id: fullEntitlement.id,
      payload: {},
      entitlement: { id: fullEntitlement.id },
      metadata: {
        notification_capability: {
          version: 1,
          phase: "prepared",
          attempt: 1,
          notification_idempotency_key: expectedIdempotencyKey,
        },
      },
    })
    const deps = dependencies(delivery, {
      service: {
        retrieveDigitalEntitlement: jest.fn().mockResolvedValue(fullEntitlement),
      },
      notificationService: {
        listNotifications: jest.fn().mockResolvedValue([
          {
            id: "noti_unrelated",
            idempotency_key: "another-delivery",
            status: "success",
          },
        ]),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.listNotifications).toHaveBeenCalledWith(
      { idempotency_key: expectedIdempotencyKey },
      { take: 10 }
    )
    expect(deps.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    expect(delivery.state).toBe("sent")
    expect(delivery.provider_message_id).toBe("noti_1")
  })

  it("cancels a stale queued guest delivery before minting or contacting the provider", async () => {
    const delivery = guestDelivery({
      id: "ndel_stale_queued",
      payload: {
        guest_access: true,
        guest_access_epoch: 0,
        guest_access_idempotency_key: "stale-guest-access",
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 1,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(delivery).toMatchObject({
      state: "canceled",
      error_code: "guest_access_epoch_superseded",
      error_message: "Guest access generation was superseded",
      payload: {},
      metadata: {
        notification_capability: {
          version: 2,
          phase: "superseded",
          guest_access_epoch: 0,
        },
      },
    })
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    expect(deps.notificationService.updateNotifications).not.toHaveBeenCalled()
  })

  it.each(["prepared", "provider_created"] as const)(
    "revokes and redacts a stale %s checkpoint before canceling it",
    async (phase) => {
      const delivery = guestDelivery({
        id: `ndel_stale_${phase}`,
        payload: { guest_access: true, guest_access_epoch: 0 },
        metadata: {
          notification_capability: {
            version: 2,
            phase,
            attempt: 1,
            guest_access_epoch: 0,
            guest_session_id: `dasess_stale_${phase}`,
            guest_session_idempotency_key: `guest-stale-${phase}`,
            notification_idempotency_key: `notification-stale-${phase}`,
            notification_id: `noti_stale_${phase}`,
            updated_at: "2026-08-03T00:00:00.000Z",
          },
        },
        entitlement: {
          id: "dent_guest",
          customer_id: null,
          customer_email: "guest@example.com",
          guest_access_epoch: 1,
          snapshot: {},
        },
      })
      const deps = dependencies(delivery)

      await deliver(deps.container, delivery.id)

      expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
        `dasess_stale_${phase}`,
        "notification_guest_access_superseded"
      )
      expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          id: `noti_stale_${phase}`,
          data: expect.not.objectContaining({
            guest_access_token: expect.anything(),
          }),
        })
      )
      expect(delivery).toMatchObject({
        state: "canceled",
        error_code: "guest_access_epoch_superseded",
        metadata: {
          notification_capability: {
            version: 2,
            phase: "superseded",
            guest_access_epoch: 0,
            guest_session_id: `dasess_stale_${phase}`,
          },
        },
      })
      expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
      expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    }
  )

  it.each(["prepared", "provider_created"] as const)(
    "retries only revoked capability cleanup when stale %s provider redaction initially fails",
    async (phase) => {
      const notificationId = `noti_stale_cleanup_${phase}`
      const notificationIdempotencyKey =
        `notification-stale-cleanup-${phase}`
      const guestSessionId = `dasess_stale_cleanup_${phase}`
      const delivery = guestDelivery({
        id: `ndel_stale_cleanup_${phase}`,
        payload: {
          guest_access: true,
          guest_access_epoch: 0,
          guest_access_idempotency_key: `guest-stale-cleanup-${phase}`,
          guest_access_token: "must-be-scrubbed",
          reason: "Keep this non-capability field",
        },
        metadata: {
          notification_capability: {
            version: 2,
            phase,
            attempt: 1,
            guest_access_epoch: 0,
            guest_session_id: guestSessionId,
            guest_session_idempotency_key: `guest-stale-cleanup-${phase}`,
            notification_idempotency_key: notificationIdempotencyKey,
            notification_id: notificationId,
            updated_at: "2026-08-03T00:00:00.000Z",
          },
        },
        entitlement: {
          id: "dent_guest",
          customer_id: null,
          customer_email: "guest@example.com",
          guest_access_epoch: 1,
          snapshot: {},
        },
      })
      const updateNotifications = jest
        .fn()
        .mockRejectedValueOnce(new Error("provider redaction unavailable"))
        .mockRejectedValueOnce(new Error("provider redaction unavailable"))
        .mockResolvedValue({ id: notificationId })
      const deps = dependencies(delivery, {
        service: {
          claimNotificationDelivery: jest.fn(async (_id, workerId) => {
            if (["sent", "canceled", "dead_letter"].includes(delivery.state)) {
              return null
            }
            if (delivery.state === "failed") {
              delivery.attempt_count = Number(delivery.attempt_count) + 1
            }
            Object.assign(delivery, {
              state: "processing",
              lease_owner: workerId,
            })
            return delivery
          }),
        },
        notificationService: { updateNotifications },
      })

      await deliver(deps.container, delivery.id)

      expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledTimes(1)
      expect(deps.service.revokeGuestAccessSession).toHaveBeenLastCalledWith(
        guestSessionId,
        "notification_guest_access_superseded"
      )
      expect(updateNotifications).toHaveBeenCalledTimes(2)
      for (const [update] of updateNotifications.mock.calls) {
        expect(update).toEqual(
          expect.objectContaining({
            id: notificationId,
            data: expect.not.objectContaining({
              guest_access_token: expect.anything(),
            }),
          })
        )
      }
      expect(deps.notificationService.listNotifications).not.toHaveBeenCalled()
      expect(delivery).toMatchObject({
        state: "failed",
        lease_owner: null,
        payload: { reason: "Keep this non-capability field" },
        metadata: {
          notification_capability: {
            version: 2,
            phase: "superseded_cleanup",
            guest_access_epoch: 0,
            guest_session_id: guestSessionId,
            notification_idempotency_key: notificationIdempotencyKey,
            notification_id: notificationId,
          },
        },
      })
      expect(delivery.next_retry_at).toBeInstanceOf(Date)
      expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.activateGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
      expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()

      await deliver(deps.container, delivery.id)

      expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledTimes(2)
      expect(deps.service.revokeGuestAccessSession).toHaveBeenLastCalledWith(
        guestSessionId,
        "notification_guest_access_superseded"
      )
      expect(updateNotifications).toHaveBeenCalledTimes(3)
      expect(updateNotifications.mock.calls[2][0]).toEqual(
        expect.objectContaining({ id: notificationId })
      )
      expect(deps.notificationService.listNotifications).not.toHaveBeenCalled()
      expect(delivery).toMatchObject({
        state: "canceled",
        error_code: "guest_access_epoch_superseded",
        payload: { reason: "Keep this non-capability field" },
        metadata: {
          notification_capability: {
            phase: "superseded",
            guest_access_epoch: 0,
            guest_session_id: guestSessionId,
            notification_idempotency_key: notificationIdempotencyKey,
            notification_id: notificationId,
          },
        },
      })
      expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.activateGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
      expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    }
  )

  it("revokes and cancels a stale sent_redacted checkpoint without activating or finalizing it", async () => {
    const delivery = guestDelivery({
      id: "ndel_stale_sent_redacted",
      payload: { guest_access: true, guest_access_epoch: 0 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "sent_redacted",
          attempt: 1,
          guest_access_epoch: 0,
          guest_session_id: "dasess_stale_sent_redacted",
          guest_session_idempotency_key: "guest-stale-sent-redacted",
          notification_idempotency_key: "notification-stale-sent-redacted",
          notification_id: "noti_stale_sent_redacted",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 1,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_stale_sent_redacted",
      "notification_guest_access_superseded"
    )
    expect(delivery).toMatchObject({
      state: "canceled",
      error_code: "guest_access_epoch_superseded",
      metadata: {
        notification_capability: {
          phase: "superseded",
          guest_access_epoch: 0,
        },
      },
    })
    expect(deps.service.activateGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    expect(deps.notificationService.updateNotifications).not.toHaveBeenCalled()
  })

  it.each([
    {
      source: "payload",
      payloadEpoch: "not-an-epoch",
      checkpointEpoch: undefined,
      guestSessionId: undefined,
    },
    {
      source: "checkpoint",
      payloadEpoch: 0,
      checkpointEpoch: -1,
      guestSessionId: "dasess_invalid_checkpoint_epoch",
    },
  ])(
    "dead-letters a malformed $source guest epoch without minting a capability",
    async ({ payloadEpoch, checkpointEpoch, guestSessionId }) => {
      const delivery = guestDelivery({
        id: `ndel_invalid_epoch_${String(payloadEpoch)}`,
        payload: { guest_access: true, guest_access_epoch: payloadEpoch },
        metadata:
          checkpointEpoch === undefined
            ? {}
            : {
                notification_capability: {
                  version: 2,
                  phase: "prepared",
                  attempt: 1,
                  guest_access_epoch: checkpointEpoch,
                  guest_session_id: guestSessionId,
                  notification_idempotency_key: "notification-invalid-epoch",
                  updated_at: "2026-08-03T00:00:00.000Z",
                },
              },
        entitlement: {
          id: "dent_guest",
          customer_id: null,
          customer_email: "guest@example.com",
          guest_access_epoch: 0,
          snapshot: {},
        },
      })
      const deps = dependencies(delivery)

      await deliver(deps.container, delivery.id)

      expect(delivery).toMatchObject({
        state: "dead_letter",
        error_code: "guest_access_epoch_invalid",
        error_message: "Guest access epoch binding is invalid",
      })
      if (guestSessionId) {
        expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
          guestSessionId,
          "notification_guest_access_epoch_invalid"
        )
      }
      expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
      expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
      expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    }
  )

  it("redacts an exact prepared provider record before dead-lettering a malformed checkpoint epoch", async () => {
    const notificationId = "noti_invalid_checkpoint_epoch"
    const notificationIdempotencyKey =
      "notification-invalid-checkpoint-epoch"
    const delivery = guestDelivery({
      id: "ndel_invalid_checkpoint_epoch_exact",
      payload: { guest_access: true, guest_access_epoch: 0 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "prepared",
          attempt: 1,
          guest_access_epoch: -1,
          guest_session_id: "dasess_invalid_checkpoint_epoch_exact",
          guest_session_idempotency_key:
            "guest-invalid-checkpoint-epoch-exact",
          notification_idempotency_key: notificationIdempotencyKey,
          notification_id: notificationId,
          updated_at: "2026-08-03T00:00:00.000Z",
        },
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 0,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_invalid_checkpoint_epoch_exact",
      "notification_guest_access_epoch_invalid"
    )
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledTimes(1)
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        id: notificationId,
        data: expect.not.objectContaining({
          guest_access_token: expect.anything(),
        }),
      })
    )
    expect(deps.notificationService.listNotifications).not.toHaveBeenCalled()
    expect(deps.service.transitionClaimedNotificationDelivery).toHaveBeenCalledWith(
      delivery.id,
      expect.stringMatching(/^digital-downloads-event-/),
      expect.objectContaining({
        state: "dead_letter",
        error_code: "guest_access_epoch_invalid",
      })
    )
    expect(
      deps.notificationService.updateNotifications.mock.invocationCallOrder[0]
    ).toBeLessThan(
      deps.service.transitionClaimedNotificationDelivery.mock.invocationCallOrder[0]
    )
    expect(delivery.state).toBe("dead_letter")
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("revokes and redacts a capability referenced by an unsupported checkpoint phase", async () => {
    const delivery = guestDelivery({
      id: "ndel_invalid_checkpoint_phase",
      payload: { guest_access: true, guest_access_epoch: 0 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "attacker_controlled_phase",
          attempt: 1,
          guest_access_epoch: 0,
          guest_session_id: "dasess_invalid_phase",
          notification_idempotency_key: "notification-invalid-phase",
          notification_id: "noti_invalid_phase",
        },
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 0,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_invalid_phase",
      "notification_guest_access_epoch_invalid"
    )
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ id: "noti_invalid_phase" })
    )
    expect(delivery).toMatchObject({
      state: "dead_letter",
      error_code: "guest_access_epoch_invalid",
      payload: {},
    })
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("dead-letters a guest prepared checkpoint that lost its session binding", async () => {
    const delivery = guestDelivery({
      id: "ndel_missing_checkpoint_session",
      payload: { guest_access: true, guest_access_epoch: 0 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "prepared",
          attempt: 1,
          guest_access_epoch: 0,
          notification_idempotency_key: "notification-missing-session",
          notification_id: "noti_missing_session",
        },
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 0,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(delivery).toMatchObject({
      state: "dead_letter",
      error_code: "guest_access_epoch_invalid",
      payload: {},
    })
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ id: "noti_missing_session" })
    )
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it.each([
    { phase: "superseded", expectedState: "canceled" },
    { phase: "quarantined", expectedState: "dead_letter" },
  ])("never reopens a $phase checkpoint", async ({ phase, expectedState }) => {
    const delivery = guestDelivery({
      id: `ndel_terminal_checkpoint_${phase}`,
      payload: {},
      metadata: {
        notification_capability: {
          version: 2,
          phase,
          attempt: 1,
        },
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(delivery.state).toBe(expectedState)
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("cancels a mint superseded after the top-level epoch check without a generic failure overwrite", async () => {
    const delivery = guestDelivery({
      id: "ndel_mint_epoch_race",
      payload: { guest_access: true, guest_access_epoch: 0 },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 0,
        snapshot: {},
      },
    })
    const deps = dependencies(delivery, {
      service: {
        createGuestAccessSession: jest
          .fn()
          .mockRejectedValue(new GuestAccessEpochSupersededError(0, 1)),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.service.createGuestAccessSession).toHaveBeenCalledTimes(1)
    expect(delivery).toMatchObject({
      state: "canceled",
      error_code: "guest_access_epoch_superseded",
      metadata: {
        notification_capability: {
          version: 2,
          phase: "superseded",
          guest_access_epoch: 0,
        },
      },
    })
    expect(deps.deliveryUpdates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "failed" }),
      ])
    )
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("does not overwrite a concurrently terminal delivery when superseded cleanup loses its lease", async () => {
    const delivery = guestDelivery({
      id: "ndel_superseded_cleanup_terminal_race",
      lease_owner: "initial-worker",
      payload: { guest_access: true, guest_access_epoch: 0 },
      metadata: {
        notification_capability: {
          version: 2,
          phase: "prepared",
          attempt: 1,
          guest_access_epoch: 0,
          guest_session_id: "dasess_terminal_race",
          notification_idempotency_key: "notification-terminal-race",
          notification_id: "noti_terminal_race",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
      },
      entitlement: {
        id: "dent_guest",
        customer_id: null,
        customer_email: "guest@example.com",
        guest_access_epoch: 1,
        snapshot: {},
      },
    })
    const transitionClaimedNotificationDelivery = jest.fn(
      async (_deliveryId, _workerId, update) => {
        expect(update).toEqual(
          expect.objectContaining({
            state: "failed",
            metadata: expect.objectContaining({
              notification_capability: expect.objectContaining({
                phase: "superseded_cleanup",
              }),
            }),
          })
        )
        Object.assign(delivery, {
          state: "canceled",
          error_code: "concurrent_terminal_transition_won",
          error_message: "Preserve the winning terminal state",
          lease_owner: null,
          metadata: { terminal_writer: "another-worker" },
        })
        return null
      }
    )
    const deps = dependencies(delivery, {
      service: { transitionClaimedNotificationDelivery },
      notificationService: {
        updateNotifications: jest
          .fn()
          .mockRejectedValue(new Error("provider redaction unavailable")),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(transitionClaimedNotificationDelivery).toHaveBeenCalledTimes(1)
    expect(delivery).toMatchObject({
      state: "canceled",
      error_code: "concurrent_terminal_transition_won",
      error_message: "Preserve the winning terminal state",
      lease_owner: null,
      metadata: { terminal_writer: "another-worker" },
    })
    expect(deps.deliveryUpdates).toEqual([])
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_terminal_race",
      "notification_guest_access_superseded"
    )
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
  })

  it("revokes a pending capability and exits when the lease is lost before the prepared checkpoint", async () => {
    const delivery = guestDelivery({ lease_owner: "worker-before-checkpoint" })
    const transitionClaimedNotificationDelivery = jest
      .fn()
      .mockResolvedValue(null)
    const deps = dependencies(delivery, {
      service: { transitionClaimedNotificationDelivery },
    })

    await deliver(deps.container, delivery.id)

    expect(transitionClaimedNotificationDelivery).toHaveBeenCalledWith(
      delivery.id,
      expect.stringMatching(/^digital-downloads-event-/),
      expect.objectContaining({
        metadata: expect.objectContaining({
          notification_capability: expect.objectContaining({ phase: "prepared" }),
        }),
      })
    )
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1",
      "notification_delivery_lease_lost_before_send"
    )
    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
  })

  it("revokes without finalizing when the lease is lost after a safely redacted provider send", async () => {
    const delivery = guestDelivery({ lease_owner: "worker-after-send" })
    const transitionClaimedNotificationDelivery = jest.fn(
      async (_deliveryId, _workerId, update) => {
        if (
          update.metadata?.notification_capability?.phase === "sent_redacted"
        ) {
          return null
        }
        Object.assign(delivery, update)
        return delivery
      }
    )
    const deps = dependencies(delivery, {
      service: { transitionClaimedNotificationDelivery },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.createNotifications).toHaveBeenCalledTimes(1)
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledTimes(1)
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1",
      "notification_delivery_lease_lost_after_send"
    )
    expect(deps.service.finalizeNotificationGuestAccess).not.toHaveBeenCalled()
  })

  it("checkpoints and redacts a successful guest capability hand-off", async () => {
    const delivery = guestDelivery()
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    const guestInput = deps.service.createGuestAccessSession.mock.calls[0][0]
    const notificationInput = deps.notificationService.createNotifications.mock.calls[0][0]
    expect(guestInput.idempotency_key).toMatch(
      /^dnotif:ndel_guest:guest:epoch:0:1:[0-9a-f-]+$/
    )
    expect(guestInput.initial_status).toBe("pending")
    expect(notificationInput.idempotency_key).toMatch(
      /^dnotif:ndel_guest:notification:epoch:0:1:[0-9a-f-]+$/
    )
    expect(notificationInput.data).toEqual(
      expect.objectContaining({
        guest_access_token: rawToken,
        guest_access: expect.objectContaining({ token: rawToken }),
      })
    )
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "noti_1",
        data: expect.not.objectContaining({ guest_access_token: expect.anything() }),
      })
    )
    expect(deps.deliveryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            notification_capability: expect.objectContaining({
              phase: "prepared",
              guest_session_id: "dasess_1",
            }),
          }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            notification_capability: expect.objectContaining({ phase: "sent_redacted" }),
          }),
        }),
        expect.objectContaining({ state: "sent" }),
      ])
    )
    expect(JSON.stringify(deps.deliveryUpdates)).not.toContain(rawToken)
    expect(JSON.stringify(deps.notificationService.updateNotifications.mock.calls)).not.toContain(rawToken)
    expect(deps.service.activateGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1"
    )
    const redactionOrder =
      deps.notificationService.updateNotifications.mock.invocationCallOrder[0]
    const sentRedactedUpdateIndex = deps.deliveryUpdates.findIndex(
      (update) => update.metadata?.notification_capability?.phase === "sent_redacted"
    )
    const sentUpdateIndex = deps.deliveryUpdates.findIndex(
      (update) => update.state === "sent"
    )
    expect(redactionOrder).toBeLessThan(
      deps.service.updateNotificationDeliveries.mock.invocationCallOrder[
        sentRedactedUpdateIndex
      ]
    )
    expect(
      deps.service.updateNotificationDeliveries.mock.invocationCallOrder[
        sentRedactedUpdateIndex
      ]
    ).toBeLessThan(
      deps.service.activateGuestAccessSession.mock.invocationCallOrder[0]
    )
    expect(
      deps.service.activateGuestAccessSession.mock.invocationCallOrder[0]
    ).toBeLessThan(
      deps.service.updateNotificationDeliveries.mock.invocationCallOrder[
        sentUpdateIndex
      ]
    )
    expect(deps.service.revokeGuestAccessSession).not.toHaveBeenCalled()
  })

  it("keeps the persisted guest token inactive until provider data is redacted", async () => {
    const delivery = guestDelivery()
    let sessionStatus = "uncreated"
    let persistedNotificationData: Record<string, unknown> | undefined
    const sequence: string[] = []
    const deps = dependencies(delivery, {
      service: {
        createGuestAccessSession: jest.fn(async (input) => {
          expect(input.initial_status).toBe("pending")
          sessionStatus = "pending"
          sequence.push("created_pending")
          return {
            session: {
              id: "dasess_pending",
              status: "pending",
              expires_at: "2026-08-01T00:00:00.000Z",
            },
            token: rawToken,
            created: true,
          }
        }),
        activateGuestAccessSession: jest.fn(async () => {
          expect(sessionStatus).toBe("pending")
          expect(JSON.stringify(persistedNotificationData)).not.toContain(rawToken)
          sessionStatus = "active"
          sequence.push("activated_after_redaction")
          return { id: "dasess_pending", status: "active" }
        }),
      },
      notificationService: {
        createNotifications: jest.fn(async (input) => {
          expect(sessionStatus).toBe("pending")
          persistedNotificationData = input.data
          expect(JSON.stringify(persistedNotificationData)).toContain(rawToken)
          sequence.push("sent_while_pending")
          return { id: "noti_pending" }
        }),
        updateNotifications: jest.fn(async (input) => {
          expect(sessionStatus).toBe("pending")
          persistedNotificationData = input.data
          expect(JSON.stringify(persistedNotificationData)).not.toContain(rawToken)
          sequence.push("redacted_while_pending")
          return { id: "noti_pending" }
        }),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(sequence).toEqual([
      "created_pending",
      "sent_while_pending",
      "redacted_while_pending",
      "activated_after_redaction",
    ])
    expect(sessionStatus).toBe("active")
    expect(delivery.state).toBe("sent")
  })

  it("retries redaction twice and revokes the capability when redaction keeps failing", async () => {
    const delivery = guestDelivery()
    const deps = dependencies(delivery, {
      notificationService: {
        updateNotifications: jest.fn().mockRejectedValue(new Error("redaction unavailable")),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.updateNotifications).toHaveBeenCalledTimes(4)
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1",
      "notification_delivery_failed_cleanup"
    )
    expect(deps.service.activateGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.deliveryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            notification_capability: expect.objectContaining({ phase: "cleanup_revoked" }),
          }),
        }),
        expect.objectContaining({ state: "failed" }),
      ])
    )
    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(rawToken)
  })

  it("redacts a partially persisted provider notification before retrying", async () => {
    const delivery = guestDelivery()
    const deps = dependencies(delivery, {
      notificationService: {
        createNotifications: jest
          .fn()
          .mockRejectedValue(new Error(`provider rejected ${rawToken}`)),
        listNotifications: jest.fn().mockResolvedValue([{ id: "noti_partial" }]),
        updateNotifications: jest.fn().mockResolvedValue({ id: "noti_partial" }),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.listNotifications).toHaveBeenCalledWith(
      { idempotency_key: expect.stringMatching(/^dnotif:ndel_guest:notification:epoch:0:1:/) },
      { take: 10 }
    )
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ id: "noti_partial" })
    )
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1",
      "notification_delivery_failed_cleanup"
    )
    expect(JSON.stringify(deps.deliveryUpdates)).not.toContain(rawToken)
    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(rawToken)
  })

  it("revokes a prepared session before minting a fresh recovery capability", async () => {
    const delivery = guestDelivery({
      attempt_count: 2,
      metadata: {
        notification_capability: {
          version: 1,
          phase: "prepared",
          attempt: 1,
          guest_session_id: "dasess_old",
          guest_session_idempotency_key: "dnotif:ndel_guest:guest:1:old",
          notification_idempotency_key: "dnotif:ndel_guest:notification:1:old",
          notification_id: "noti_old",
        },
      },
    })
    const calls: string[] = []
    const deps = dependencies(delivery, {
      service: {
        revokeGuestAccessSession: jest.fn(async () => {
          calls.push("revoke")
          return { id: "dasess_old", status: "revoked" }
        }),
        createGuestAccessSession: jest.fn(async (input) => {
          calls.push("create")
          return {
            session: {
              id: "dasess_new",
              status: "pending",
              expires_at: "2026-08-01T00:00:00.000Z",
            },
            token: rawToken,
            created: true,
          }
        }),
      },
      notificationService: {
        updateNotifications: jest.fn(async (input) => {
          calls.push(`redact:${input.id}`)
          return { id: input.id }
        }),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(calls).toEqual([
      "revoke",
      "redact:noti_old",
      "create",
      "redact:noti_1",
    ])
    expect(deps.service.revokeGuestAccessSession).toHaveBeenCalledWith(
      "dasess_old",
      "notification_delivery_retry_cleanup"
    )
    expect(deps.notificationService.updateNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "noti_old",
        data: expect.not.objectContaining({ guest_access_token: expect.anything() }),
      })
    )
    expect(deps.service.createGuestAccessSession.mock.calls[0][0].idempotency_key).toMatch(
      /^dnotif:ndel_guest:guest:epoch:0:2:/
    )
  })

  it("recovers a redacted send checkpoint without another provider call", async () => {
    const delivery = guestDelivery({
      metadata: {
        notification_capability: {
          version: 1,
          phase: "sent_redacted",
          attempt: 1,
          guest_session_id: "dasess_1",
          notification_id: "noti_already_sent",
        },
      },
    })
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    expect(deps.notificationService.createNotifications).not.toHaveBeenCalled()
    expect(deps.service.createGuestAccessSession).not.toHaveBeenCalled()
    expect(deps.service.activateGuestAccessSession).toHaveBeenCalledWith(
      "dasess_1"
    )
    expect(deps.deliveryUpdates).toEqual([
      expect.objectContaining({ attempt_count: 1 }),
      expect.objectContaining({
        state: "sent",
        attempt_count: 1,
        provider_message_id: "noti_already_sent",
      }),
    ])
  })

  it.each(["activation", "finalization"] as const)(
    "keeps a final-attempt sent_redacted %s failure claimable and recovers without resending",
    async (failurePoint) => {
      const maxAttempts = 3
      const delivery = guestDelivery({
        id: `ndel_final_${failurePoint}`,
        state: "failed",
        attempt_count: maxAttempts - 1,
        max_attempts: maxAttempts,
      })
      const updates: Record<string, any>[] = []
      let failActivation = failurePoint === "activation"
      let failFinalization = failurePoint === "finalization"
      const deps = dependencies(delivery, {
        service: {
          claimNotificationDelivery: jest.fn(async () => {
            if (["sent", "canceled", "dead_letter"].includes(delivery.state)) {
              return null
            }
            if (delivery.attempt_count >= delivery.max_attempts) {
              Object.assign(delivery, { state: "dead_letter" })
              return null
            }
            Object.assign(delivery, {
              state: "processing",
              attempt_count: Number(delivery.attempt_count) + 1,
            })
            return delivery
          }),
          activateGuestAccessSession: jest.fn(async () => {
            if (failActivation) {
              failActivation = false
              throw new Error("activation temporarily unavailable")
            }
            return { id: "dasess_1", status: "active" }
          }),
          updateNotificationDeliveries: jest.fn(async (update) => {
            if (update.state === "sent" && failFinalization) {
              failFinalization = false
              throw new Error("finalization temporarily unavailable")
            }
            updates.push(update)
            Object.assign(delivery, update)
            return delivery
          }),
        },
      })

      await deliver(deps.container, delivery.id)

      expect(deps.notificationService.createNotifications).toHaveBeenCalledTimes(1)
      expect(delivery).toMatchObject({
        state: "failed",
        attempt_count: maxAttempts - 1,
        metadata: {
          notification_capability: { phase: "sent_redacted" },
        },
      })
      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attempt_count: maxAttempts - 1,
            metadata: expect.objectContaining({
              notification_capability: expect.objectContaining({
                phase: "sent_redacted",
              }),
            }),
          }),
        ])
      )
      expect(updates).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ state: "dead_letter" })])
      )

      await deliver(deps.container, delivery.id)

      expect(delivery).toMatchObject({
        state: "sent",
        attempt_count: maxAttempts,
        provider_message_id: "noti_1",
      })
      expect(deps.notificationService.createNotifications).toHaveBeenCalledTimes(1)
      expect(deps.service.createGuestAccessSession).toHaveBeenCalledTimes(1)
      expect(deps.notificationService.updateNotifications).toHaveBeenCalledTimes(1)
      expect(deps.service.claimNotificationDelivery).toHaveBeenCalledTimes(2)
    }
  )

  it("quarantines instead of retrying when guest cleanup cannot be confirmed", async () => {
    const delivery = guestDelivery()
    const deps = dependencies(delivery, {
      service: {
        revokeGuestAccessSession: jest.fn().mockRejectedValue(new Error("database unavailable")),
      },
      notificationService: {
        createNotifications: jest.fn().mockRejectedValue(new Error("provider failed")),
      },
    })

    await deliver(deps.container, delivery.id)

    expect(deps.deliveryUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "dead_letter",
          error_code: "guest_access_cleanup_unconfirmed",
          metadata: expect.objectContaining({
            notification_capability: expect.objectContaining({ phase: "quarantined" }),
          }),
        }),
      ])
    )
    expect(deps.deliveryUpdates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ state: "failed" })])
    )
    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain(rawToken)
  })

  it("serializes duplicate events and sends a delivery only once", async () => {
    let currentDelivery: any = guestDelivery({
      id: "ndel_duplicate",
      entitlement_id: "dent_duplicate",
      payload: {},
      attempt_count: 0,
      entitlement: {
        id: "dent_duplicate",
        customer_id: "cus_duplicate",
        customer_email: "customer@example.com",
        snapshot: {},
      },
    })
    const service = {
      claimNotificationDelivery: jest.fn(async (_id, workerId) => {
        if (["sent", "canceled", "dead_letter"].includes(currentDelivery.state)) return null
        currentDelivery = {
          ...currentDelivery,
          state: "processing",
          attempt_count: Number(currentDelivery.attempt_count) + 1,
          lease_owner: workerId,
        }
        return { ...currentDelivery }
      }),
      retrieveDigitalEntitlement: jest.fn(async () => currentDelivery.entitlement),
      updateNotificationDeliveries: jest.fn(async (update) => {
        currentDelivery = { ...currentDelivery, ...update }
        return { ...currentDelivery }
      }),
    }
    const notificationService = {
      createNotifications: jest.fn().mockResolvedValue({ id: "noti_duplicate" }),
    }
    let tail = Promise.resolve()
    const locking = {
      execute: jest.fn((_key, job) => {
        const result = tail.then(job)
        tail = result.then(() => undefined, () => undefined)
        return result
      }),
    }
    const logger = { error: jest.fn() }
    const container = {
      resolve: jest.fn((key) => {
        if (key === DIGITAL_DOWNLOADS_MODULE) return service
        if (key === Modules.NOTIFICATION) return notificationService
        if (key === Modules.LOCKING) return locking
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        throw new Error(`Unexpected dependency ${String(key)}`)
      }),
    }

    await Promise.all([deliver(container, currentDelivery.id), deliver(container, currentDelivery.id)])

    expect(notificationService.createNotifications).toHaveBeenCalledTimes(1)
    expect(currentDelivery.state).toBe("sent")
    expect(locking.execute).toHaveBeenCalledTimes(2)
  })
})
