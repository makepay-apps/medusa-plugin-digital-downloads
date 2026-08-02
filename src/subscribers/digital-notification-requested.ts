import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { randomUUID } from "node:crypto"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils"
import {
  NotificationDeliveryState,
} from "../modules/digital-downloads/types"
import { DIGITAL_DOWNLOAD_EVENTS } from "../workflows/digital-downloads/events"
import { markNotificationFailed } from "../workflows/digital-downloads/revocation-workflows"
import { resolveDigitalDownloadsService } from "../workflows/digital-downloads/service-helpers"

type NotificationEvent = { delivery_id: string; lease_owner?: string }

type CapabilityCheckpointPhase =
  | "prepared"
  | "provider_created"
  | "sent_redacted"
  | "cleanup_revoked"
  | "quarantined"

type CapabilityCheckpoint = {
  version: 1
  phase: CapabilityCheckpointPhase
  attempt: number
  guest_session_id?: string
  guest_session_idempotency_key?: string
  notification_idempotency_key?: string
  notification_id?: string
  updated_at: string
}

function checkpointFromDelivery(delivery: Record<string, any>): CapabilityCheckpoint | undefined {
  const checkpoint = delivery.metadata?.notification_capability
  if (!checkpoint || typeof checkpoint !== "object" || checkpoint.version !== 1) {
    return undefined
  }
  return checkpoint as CapabilityCheckpoint
}

function metadataWithCheckpoint(
  delivery: Record<string, any>,
  checkpoint: Omit<CapabilityCheckpoint, "version" | "updated_at">
): Record<string, unknown> {
  return {
    ...(delivery.metadata ?? {}),
    notification_capability: {
      version: 1,
      ...checkpoint,
      updated_at: new Date().toISOString(),
    },
  }
}

async function redactNotificationCapability(
  notificationService: any,
  input: {
    notificationId?: string
    idempotencyKey: string
    data: Record<string, unknown>
  }
): Promise<void> {
  let ids = input.notificationId ? [input.notificationId] : []
  if (!ids.length && typeof notificationService.listNotifications === "function") {
    const notifications = await notificationService.listNotifications(
      { idempotency_key: input.idempotencyKey },
      { take: 10 }
    )
    ids = notifications.map((notification: { id: string }) => notification.id)
  }
  for (const id of ids) {
    await notificationService.updateNotifications({ id, data: input.data })
  }
}

async function redactNotificationCapabilityTwice(
  notificationService: any,
  input: {
    notificationId?: string
    idempotencyKey: string
    data: Record<string, unknown>
  }
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await redactNotificationCapability(notificationService, input)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function redactedErrorMessage(error: unknown, secret?: string): string {
  const message = error instanceof Error ? error.message : String(error)
  return secret ? message.split(secret).join("[REDACTED]") : message
}

function attemptKeys(delivery: Record<string, any>): {
  attempt: number
  guestSession: string
  notification: string
} {
  const attempt = Math.max(1, Number(delivery.attempt_count ?? 0))
  // A nonce is intentionally included. A delivery retry must never reactivate
  // the token of an earlier, potentially exposed attempt.
  const nonce = randomUUID()
  return {
    attempt,
    guestSession: `dnotif:${delivery.id}:guest:${attempt}:${nonce}`,
    notification: `dnotif:${delivery.id}:notification:${attempt}:${nonce}`,
  }
}

function safeNotificationData(
  delivery: Record<string, any>,
  entitlement: Record<string, any>,
  guestSession?: Record<string, unknown>
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    ...(delivery.payload ?? {}),
    entitlement: entitlement.snapshot ?? {},
    ...(guestSession
      ? {
          guest_access: {
            available: true,
            session_id: guestSession.id,
            expires_at: guestSession.expires_at,
          },
        }
      : {}),
  }
  delete data.guest_access_idempotency_key
  delete data.guest_access_token
  if (data.guest_access && typeof data.guest_access === "object") {
    delete (data.guest_access as Record<string, unknown>).token
  }
  return data
}

async function quarantineDelivery(
  service: any,
  delivery: Record<string, any>,
  checkpoint: Omit<CapabilityCheckpoint, "version" | "updated_at">
): Promise<void> {
  await service.updateNotificationDeliveries({
    id: delivery.id,
    state: NotificationDeliveryState.DEAD_LETTER,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    error_code: "guest_access_cleanup_unconfirmed",
    error_message: "Guest access cleanup could not be confirmed",
    metadata: metadataWithCheckpoint(delivery, {
      ...checkpoint,
      phase: "quarantined",
    }),
  })
}

export async function deliverDigitalNotification({
  event,
  container,
}: SubscriberArgs<NotificationEvent>): Promise<void> {
  const service = resolveDigitalDownloadsService(container)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const expectedLeaseOwner = event.data.lease_owner
  const workerId =
    expectedLeaseOwner ?? `digital-downloads-event-${randomUUID()}`
  const delivery = await service.claimNotificationDelivery(
    event.data.delivery_id,
    workerId,
    {
      lease_seconds: 120,
      expected_lease_owner: expectedLeaseOwner,
    }
  )
  if (!delivery) return

  const entitlement =
    delivery.entitlement ??
    (await service.retrieveDigitalEntitlement(delivery.entitlement_id))
  if (!entitlement.customer_email) {
    await markNotificationFailed(
      service,
      delivery,
      new Error("Entitlement does not have a notification destination")
    )
    return
  }

  const existingCheckpoint = checkpointFromDelivery(delivery)
  // Redaction completed before a worker crashed. The provider already received
  // the message, so activate the pending capability idempotently and complete
  // the outbox row without sending a duplicate.
  if (existingCheckpoint?.phase === "sent_redacted") {
    try {
      if (existingCheckpoint.guest_session_id) {
        await service.activateGuestAccessSession(
          existingCheckpoint.guest_session_id
        )
      }
      await service.updateNotificationDeliveries({
        id: delivery.id,
        state: NotificationDeliveryState.SENT,
        sent_at: new Date(),
        provider_message_id: existingCheckpoint.notification_id ?? null,
        lease_owner: null,
        lease_expires_at: null,
        next_retry_at: null,
        error_code: null,
        error_message: null,
      })
    } catch (error) {
      await markNotificationFailed(service, delivery, error)
      logger.error(
        `Digital download notification ${delivery.id} could not complete its redacted capability activation; it remains queued for retry`
      )
    }
    return
  }

  // A prepared checkpoint means a previous worker may have reached the
  // provider boundary. Revoke and redact it before creating a distinct retry
  // capability. Redaction is best-effort because confirmed revocation makes
  // the previous token unusable even if the notification module is unavailable.
  if (
    existingCheckpoint?.phase === "prepared" ||
    existingCheckpoint?.phase === "provider_created"
  ) {
    let recoveryRevokeError: unknown
    if (existingCheckpoint.guest_session_id) {
      try {
        await service.revokeGuestAccessSession(
          existingCheckpoint.guest_session_id,
          "notification_delivery_retry_cleanup"
        )
      } catch (error) {
        recoveryRevokeError = error
      }

      if (existingCheckpoint.notification_idempotency_key) {
        try {
          const recoveryNotificationService = container.resolve(
            Modules.NOTIFICATION
          ) as any
          await redactNotificationCapabilityTwice(recoveryNotificationService, {
            notificationId: existingCheckpoint.notification_id,
            idempotencyKey: existingCheckpoint.notification_idempotency_key,
            data: safeNotificationData(delivery, entitlement),
          })
        } catch {
          logger.error(
            `Digital download notification ${delivery.id} could not redact provider data from its previous revoked capability`
          )
        }
      }

      if (recoveryRevokeError) {
        try {
          await quarantineDelivery(service, delivery, existingCheckpoint)
        } catch {
          logger.error(
            `Digital download notification ${delivery.id} could not persist its guest access quarantine`
          )
          throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            "Guest access cleanup could not be confirmed"
          )
        }
        logger.error(
          `Digital download notification ${delivery.id} quarantined because guest access cleanup could not be confirmed`
        )
        return
      }
    }
  }

  let guestToken: string | undefined
  let guestSessionId: string | undefined
  let notificationService: any
  let safeData: Record<string, unknown> | undefined
  let notificationId: string | undefined
  let keys: ReturnType<typeof attemptKeys> | undefined
  let sentRedacted = false
  try {
    notificationService = container.resolve(Modules.NOTIFICATION) as any
    const guestAccessRequested = Boolean(
      delivery.payload?.guest_access ||
        delivery.payload?.guest_access_idempotency_key
    )
    let guestSession: Record<string, unknown> | undefined
    keys = attemptKeys(delivery)
    if (guestAccessRequested) {
      const guest = await service.createGuestAccessSession({
        entitlement_id: entitlement.id,
        idempotency_key: keys.guestSession,
        initial_status: "pending",
        metadata: {
          purpose: "notification_delivery",
          notification_delivery_id: delivery.id,
          notification_attempt: keys.attempt,
        },
      })
      guestToken = guest.token
      guestSession = guest.session
      guestSessionId = String(guest.session.id)
      if (String(guest.session.status).toLowerCase() !== "pending") {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Notification guest access must remain pending until provider data is redacted"
        )
      }
    }
    safeData = safeNotificationData(delivery, entitlement, guestSession)

    // Medusa persists notification data before invoking a provider. Store this
    // token-free checkpoint first so recovery can redact and revoke safely.
    await service.updateNotificationDeliveries({
      id: delivery.id,
      metadata: metadataWithCheckpoint(delivery, {
        phase: "prepared",
        attempt: keys.attempt,
        guest_session_id: guestSessionId,
        guest_session_idempotency_key: guestAccessRequested
          ? keys.guestSession
          : undefined,
        notification_idempotency_key: keys.notification,
      }),
    })

    const notification = await notificationService.createNotifications({
      to: entitlement.customer_email,
      channel: delivery.channel,
      template: delivery.template,
      idempotency_key: keys.notification,
      trigger_type: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
      resource_id: entitlement.id,
      resource_type: "digital_entitlement",
      receiver_id: entitlement.customer_id ?? undefined,
      data: {
        ...safeData,
        ...(guestToken
          ? {
              guest_access_token: guestToken,
              guest_access: {
                ...(safeData.guest_access as Record<string, unknown>),
                token: guestToken,
              },
            }
          : {}),
      },
    })
    notificationId = notification.id
    // The provider boundary has returned. Redact its persisted notification
    // immediately, while the bearer capability is still pending and unusable.
    if (guestToken) {
      await redactNotificationCapabilityTwice(notificationService, {
        notificationId,
        idempotencyKey: keys.notification,
        data: safeData,
      })
    }
    await service.updateNotificationDeliveries({
      id: delivery.id,
      metadata: metadataWithCheckpoint(delivery, {
        phase: "sent_redacted",
        attempt: keys.attempt,
        guest_session_id: guestSessionId,
        guest_session_idempotency_key: guestAccessRequested
          ? keys.guestSession
          : undefined,
        notification_idempotency_key: keys.notification,
        notification_id: notificationId,
      }),
    })
    sentRedacted = true
    if (guestSessionId) {
      await service.activateGuestAccessSession(guestSessionId)
    }
    await service.updateNotificationDeliveries({
      id: delivery.id,
      state: NotificationDeliveryState.SENT,
      sent_at: new Date(),
      provider_message_id: notification.external_id ?? notification.id,
      lease_owner: null,
      lease_expires_at: null,
      next_retry_at: null,
      error_code: null,
      error_message: null,
    })
  } catch (error) {
    if (sentRedacted) {
      // The durable redaction checkpoint is enough for the next worker to
      // activate idempotently and mark the delivery sent without ever
      // re-sending the notification. Do not revoke here: the provider already
      // received this token and its persisted copy has been safely redacted.
      await markNotificationFailed(service, delivery, error)
      logger.error(
        `Digital download notification ${delivery.id} failed after safe redaction; recovery will activate and finalize without resending it`
      )
      return
    }

    let revokeError: unknown
    let redactionError: unknown
    if (guestSessionId) {
      if (notificationService && safeData && keys) {
        try {
          await redactNotificationCapabilityTwice(notificationService, {
            notificationId,
            idempotencyKey: keys.notification,
            data: safeData,
          })
        } catch (cleanupError) {
          redactionError = cleanupError
        }
      }
      try {
        await service.revokeGuestAccessSession(
          guestSessionId,
          "notification_delivery_failed_cleanup"
        )
      } catch (cleanupError) {
        revokeError = cleanupError
      }
    }

    if (revokeError) {
      try {
        await quarantineDelivery(service, delivery, {
          phase: "provider_created",
          attempt: keys?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
          guest_session_id: guestSessionId,
          guest_session_idempotency_key: keys?.guestSession,
          notification_idempotency_key: keys?.notification,
          notification_id: notificationId,
        })
      } catch {
        logger.error(
          `Digital download notification ${delivery.id} could not persist its guest access quarantine`
        )
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Guest access cleanup could not be confirmed"
        )
      }
      logger.error(
        `Digital download notification ${delivery.id} quarantined because guest access cleanup could not be confirmed`
      )
      return
    }

    const safeError = new Error(redactedErrorMessage(error, guestToken))
    if (guestSessionId) {
      await service.updateNotificationDeliveries({
        id: delivery.id,
        metadata: metadataWithCheckpoint(delivery, {
          phase: "cleanup_revoked",
          attempt: keys?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
          guest_session_id: guestSessionId,
          guest_session_idempotency_key: keys?.guestSession,
          notification_idempotency_key: keys?.notification,
          notification_id: notificationId,
        }),
      })
    }
    await markNotificationFailed(service, delivery, safeError)
    logger.error(
      `Digital download notification ${delivery.id} failed; it remains queued for retry: ${safeError.message}${
        redactionError ? " (provider data redaction retried; capability revoked)" : ""
      }`
    )
  }
}

export default async function digitalNotificationRequestedHandler(
  args: SubscriberArgs<NotificationEvent>
): Promise<void> {
  const locking = args.container.resolve(Modules.LOCKING)
  await locking.execute(
    `digital-downloads:notification-delivery:${args.event.data.delivery_id}`,
    () => deliverDigitalNotification(args),
    { timeout: 30 }
  )
}

export const config: SubscriberConfig = {
  event: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
  context: { subscriberId: "digital-downloads-notification-requested" },
}
