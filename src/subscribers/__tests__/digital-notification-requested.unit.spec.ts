import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { DIGITAL_DOWNLOADS_MODULE } from "../../modules/digital-downloads"
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
  it("checkpoints and redacts a successful guest capability hand-off", async () => {
    const delivery = guestDelivery()
    const deps = dependencies(delivery)

    await deliver(deps.container, delivery.id)

    const guestInput = deps.service.createGuestAccessSession.mock.calls[0][0]
    const notificationInput = deps.notificationService.createNotifications.mock.calls[0][0]
    expect(guestInput.idempotency_key).toMatch(
      /^dnotif:ndel_guest:guest:1:[0-9a-f-]+$/
    )
    expect(guestInput.initial_status).toBe("pending")
    expect(notificationInput.idempotency_key).toMatch(
      /^dnotif:ndel_guest:notification:1:[0-9a-f-]+$/
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
      { idempotency_key: expect.stringMatching(/^dnotif:ndel_guest:notification:1:/) },
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
      /^dnotif:ndel_guest:guest:2:/
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
      expect.objectContaining({ state: "sent", provider_message_id: "noti_already_sent" }),
    ])
  })

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
