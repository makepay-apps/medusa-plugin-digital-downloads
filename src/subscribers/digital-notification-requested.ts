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
import {
  guestAccessEpoch,
  isGuestAccessEpochSupersededError,
} from "../modules/digital-downloads/service"
import { DIGITAL_DOWNLOAD_EVENTS } from "../workflows/digital-downloads/events"
import {
  sentNotificationRecoveryAttemptCount,
} from "../workflows/digital-downloads/revocation-workflows"
import { resolveDigitalDownloadsService } from "../workflows/digital-downloads/service-helpers"
import { computeBackoffDate } from "../workflows/digital-downloads/utils"

type NotificationEvent = { delivery_id: string; lease_owner?: string }

type CapabilityCheckpointPhase =
  | "prepared"
  | "provider_created"
  | "sent_redacted"
  | "cleanup_revoked"
  | "superseded_cleanup"
  | "superseded"
  | "quarantined"

type CapabilityCheckpoint = {
  version: 1 | 2
  phase: CapabilityCheckpointPhase
  attempt: number
  guest_access_epoch?: number
  guest_session_id?: string
  guest_session_idempotency_key?: string
  notification_idempotency_key?: string
  notification_id?: string
  updated_at: string
}

const CAPABILITY_CHECKPOINT_PHASES = new Set<CapabilityCheckpointPhase>([
  "prepared",
  "provider_created",
  "sent_redacted",
  "cleanup_revoked",
  "superseded_cleanup",
  "superseded",
  "quarantined",
])

function checkpointText(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined
}

function checkpointFromDelivery(delivery: Record<string, any>): CapabilityCheckpoint | undefined {
  const checkpoint = delivery.metadata?.notification_capability
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    ![1, 2].includes(checkpoint.version) ||
    !CAPABILITY_CHECKPOINT_PHASES.has(checkpoint.phase) ||
    !Number.isSafeInteger(checkpoint.attempt) ||
    checkpoint.attempt < 1 ||
    [
      checkpoint.guest_session_id,
      checkpoint.guest_session_idempotency_key,
      checkpoint.notification_idempotency_key,
      checkpoint.notification_id,
    ].some(
      (value) =>
        value !== undefined && checkpointText(value) === undefined,
    )
  ) {
    return undefined
  }
  return checkpoint as CapabilityCheckpoint
}

function cleanupCheckpointFromDelivery(
  delivery: Record<string, any>,
): CapabilityCheckpoint | undefined {
  const raw = delivery.metadata?.notification_capability
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  return {
    version: 2,
    phase: raw.phase === "sent_redacted" ? "sent_redacted" : "prepared",
    attempt: Number.isSafeInteger(raw.attempt) && raw.attempt > 0
      ? raw.attempt
      : Math.max(1, Number(delivery.attempt_count ?? 0)),
    guest_access_epoch: raw.guest_access_epoch,
    guest_session_id: checkpointText(raw.guest_session_id, 255),
    guest_session_idempotency_key:
      checkpointText(raw.guest_session_idempotency_key),
    notification_idempotency_key:
      checkpointText(raw.notification_idempotency_key),
    notification_id: checkpointText(raw.notification_id, 255),
    updated_at: new Date().toISOString(),
  }
}

function metadataWithCheckpoint(
  delivery: Record<string, any>,
  checkpoint: Omit<CapabilityCheckpoint, "version" | "updated_at">
): Record<string, unknown> {
  return {
    ...(delivery.metadata ?? {}),
    notification_capability: {
      version: 2,
      ...checkpoint,
      updated_at: new Date().toISOString(),
    },
  }
}

function payloadWithoutGuestAccess(delivery: Record<string, any>): Record<string, unknown> {
  const payload = { ...(delivery.payload ?? {}) }
  delete payload.guest_access
  delete payload.guest_access_epoch
  delete payload.guest_access_idempotency_key
  delete payload.guest_access_token
  return payload
}

async function transitionClaimedDelivery(
  service: any,
  delivery: Record<string, any>,
  workerId: string,
  update: Record<string, unknown>,
): Promise<Record<string, any> | null> {
  if (typeof service.transitionClaimedNotificationDelivery === "function") {
    return service.transitionClaimedNotificationDelivery(
      delivery.id,
      workerId,
      update,
    )
  }

  // Compatibility fallback for older test doubles. Production services use
  // the transactionally locked transition above so a stale worker cannot
  // overwrite a cancellation or another worker's lease.
  const current = typeof service.retrieveNotificationDelivery === "function"
    ? await service.retrieveNotificationDelivery(delivery.id)
    : delivery
  if (
    [
      NotificationDeliveryState.SENT,
      NotificationDeliveryState.CANCELED,
      NotificationDeliveryState.DEAD_LETTER,
    ].includes(current?.state)
  ) {
    return null
  }
  if (
    current?.state &&
    current.state !== NotificationDeliveryState.PROCESSING
  ) {
    return null
  }
  if (current?.lease_owner && current.lease_owner !== workerId) {
    return null
  }
  return service.updateNotificationDeliveries({ id: delivery.id, ...update })
}

async function markClaimedNotificationFailed(
  service: any,
  delivery: Record<string, any>,
  workerId: string,
  error: unknown,
  options: {
    reserveSentRecovery?: boolean
    metadata?: Record<string, unknown>
  } = {},
): Promise<Record<string, any> | null> {
  const attempt = Math.max(1, Number(delivery.attempt_count ?? 0))
  const terminal =
    !options.reserveSentRecovery &&
    attempt >= Math.max(1, Number(delivery.max_attempts ?? 8))
  return transitionClaimedDelivery(service, delivery, workerId, {
    state: terminal
      ? NotificationDeliveryState.DEAD_LETTER
      : NotificationDeliveryState.FAILED,
    attempt_count: options.reserveSentRecovery
      ? sentNotificationRecoveryAttemptCount(delivery)
      : attempt,
    last_attempt_at: new Date(),
    next_retry_at: terminal ? null : computeBackoffDate(attempt),
    lease_owner: null,
    lease_expires_at: null,
    error_code: "notification_failed",
    error_message:
      error instanceof Error ? error.message.slice(0, 2_000) : String(error),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
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

async function notificationByIdempotencyKey(
  notificationService: any,
  idempotencyKey: string
): Promise<Record<string, any> | undefined> {
  if (typeof notificationService.listNotifications !== "function") {
    return undefined
  }
  const notifications = await notificationService.listNotifications(
    { idempotency_key: idempotencyKey },
    { take: 10 }
  )
  return notifications.find(
    (notification: Record<string, any>) =>
      notification.idempotency_key === idempotencyKey
  )
}

function notificationWasSent(notification: Record<string, any> | undefined): boolean {
  return String(notification?.status ?? "").toLowerCase() === "success"
}

function attemptKeys(
  delivery: Record<string, any>,
  epoch: number,
): {
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
    guestSession: `dnotif:${delivery.id}:guest:epoch:${epoch}:${attempt}:${nonce}`,
    notification: `dnotif:${delivery.id}:notification:epoch:${epoch}:${attempt}:${nonce}`,
  }
}

function deliveryRequestsGuestAccess(delivery: Record<string, any>): boolean {
  return Boolean(
    delivery.payload?.guest_access ||
      delivery.payload?.guest_access_idempotency_key,
  )
}

function deliveryGuestAccessEpoch(delivery: Record<string, any>): number {
  return guestAccessEpoch(delivery.payload?.guest_access_epoch)
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {}
}

function boundedText(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
  return normalized ? normalized.slice(0, max) : undefined
}

function defined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  )
}

/**
 * Notification providers receive only the small buyer-facing projection needed
 * by the bundled template example. Purchase snapshots intentionally retain
 * immutable commerce context, including merchant/customer metadata, but that
 * broader record must never cross the provider boundary.
 */
function notificationEntitlementProjection(
  entitlement: Record<string, any>,
): Record<string, unknown> {
  const snapshot = record(entitlement.snapshot)
  const order = record(snapshot.order)
  const lineItem = record(snapshot.line_item)
  const digitalProduct = record(snapshot.digital_product)
  const release = record(snapshot.release)
  const displayId =
    typeof order.display_id === "number" && Number.isSafeInteger(order.display_id)
      ? order.display_id
      : boundedText(order.display_id, 64)

  return {
    order: defined({
      id: boundedText(entitlement.order_id ?? order.id, 255),
      display_id: displayId,
    }),
    line_item: defined({
      id: boundedText(entitlement.order_line_item_id ?? lineItem.id, 255),
      title: boundedText(lineItem.title, 300),
      subtitle: boundedText(lineItem.subtitle, 300),
      product_id: boundedText(lineItem.product_id, 255),
      variant_id: boundedText(lineItem.variant_id, 255),
    }),
    digital_product: defined({
      id: boundedText(entitlement.digital_product_id ?? digitalProduct.id, 255),
      name: boundedText(digitalProduct.name, 300),
      kind: boundedText(digitalProduct.kind, 80),
      delivery_mode: boundedText(digitalProduct.delivery_mode, 80),
    }),
    release: defined({
      id: boundedText(entitlement.release_id ?? release.id, 255),
      version: boundedText(release.version, 160),
    }),
  }
}

function safeNotificationData(
  delivery: Record<string, any>,
  entitlement: Record<string, any>,
  guestSession?: Record<string, unknown>
): Record<string, unknown> {
  const payload = record(delivery.payload)
  const data: Record<string, unknown> = {
    ...defined({
      entitlement_id: boundedText(
        payload.entitlement_id ?? entitlement.id,
        255,
      ),
      order_id: boundedText(payload.order_id ?? entitlement.order_id, 255),
      digital_product_id: boundedText(
        payload.digital_product_id ?? entitlement.digital_product_id,
        255,
      ),
      notification_type: boundedText(payload.notification_type, 80),
      reason: boundedText(payload.reason, 2_000),
    }),
    entitlement: notificationEntitlementProjection(entitlement),
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
  return data
}

async function quarantineDelivery(
  service: any,
  delivery: Record<string, any>,
  workerId: string,
  checkpoint: Omit<CapabilityCheckpoint, "version" | "updated_at">
): Promise<void> {
  const persistedCheckpoint = { ...checkpoint } as Record<string, unknown>
  delete persistedCheckpoint.version
  delete persistedCheckpoint.updated_at
  await transitionClaimedDelivery(service, delivery, workerId, {
    state: NotificationDeliveryState.DEAD_LETTER,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    error_code: "guest_access_cleanup_unconfirmed",
    error_message: "Guest access cleanup could not be confirmed",
    metadata: metadataWithCheckpoint(delivery, {
      ...persistedCheckpoint,
      phase: "quarantined",
    } as Omit<CapabilityCheckpoint, "version" | "updated_at">),
  })
}

async function cancelSupersededGuestDelivery(input: {
  service: any
  container: any
  logger: any
  delivery: Record<string, any>
  entitlement: Record<string, any>
  checkpoint?: CapabilityCheckpoint
  expectedEpoch: number
  currentEpoch: number
  guestSessionId?: string
  notificationId?: string
  notificationIdempotencyKey?: string
  workerId: string
}): Promise<void> {
  const {
    service,
    container,
    logger,
    delivery,
    entitlement,
    checkpoint,
    expectedEpoch,
    currentEpoch,
  } = input
  const guestSessionId = input.guestSessionId ?? checkpoint?.guest_session_id
  const notificationId = input.notificationId ?? checkpoint?.notification_id
  const notificationIdempotencyKey =
    input.notificationIdempotencyKey ??
    checkpoint?.notification_idempotency_key

  if (guestSessionId) {
    try {
      await service.revokeGuestAccessSession(
        guestSessionId,
        "notification_guest_access_superseded",
      )
    } catch {
      await quarantineDelivery(service, delivery, input.workerId, {
        phase: "quarantined",
        attempt: checkpoint?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
        guest_access_epoch: expectedEpoch,
        guest_session_id: guestSessionId,
        guest_session_idempotency_key:
          checkpoint?.guest_session_idempotency_key,
        notification_idempotency_key: notificationIdempotencyKey,
        notification_id: notificationId,
      })
      logger.error(
        `Digital download notification ${delivery.id} quarantined because superseded guest access cleanup could not be confirmed`,
      )
      return
    }
  }

  if (
    checkpoint?.phase !== "sent_redacted" &&
    notificationIdempotencyKey
  ) {
    try {
      const notificationService = container.resolve(Modules.NOTIFICATION) as any
      await redactNotificationCapabilityTwice(notificationService, {
        notificationId,
        idempotencyKey: notificationIdempotencyKey,
        data: safeNotificationData(delivery, entitlement),
      })
    } catch {
      const attempt = Math.max(
        1,
        Number(delivery.attempt_count ?? checkpoint?.attempt ?? 0),
      )
      const terminal = attempt >= Math.max(1, Number(delivery.max_attempts ?? 8))
      await transitionClaimedDelivery(service, delivery, input.workerId, {
        state: terminal
          ? NotificationDeliveryState.DEAD_LETTER
          : NotificationDeliveryState.FAILED,
        attempt_count: attempt,
        last_attempt_at: new Date(),
        next_retry_at: terminal ? null : computeBackoffDate(attempt),
        lease_owner: null,
        lease_expires_at: null,
        error_code: "guest_access_superseded_redaction_failed",
        error_message: "Superseded guest access provider data could not be redacted",
        payload: payloadWithoutGuestAccess(delivery),
        metadata: metadataWithCheckpoint(delivery, {
          phase: "superseded_cleanup",
          attempt,
          guest_access_epoch: expectedEpoch,
          guest_session_id: guestSessionId,
          guest_session_idempotency_key:
            checkpoint?.guest_session_idempotency_key,
          notification_idempotency_key: notificationIdempotencyKey,
          notification_id: notificationId,
        }),
      })
      logger.error(
        `Digital download notification ${delivery.id} could not redact provider data for its superseded capability; cleanup remains retryable`,
      )
      return
    }
  }

  await transitionClaimedDelivery(service, delivery, input.workerId, {
    state: NotificationDeliveryState.CANCELED,
    canceled_at: new Date(),
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    error_code: "guest_access_epoch_superseded",
    error_message: "Guest access generation was superseded",
    payload: payloadWithoutGuestAccess(delivery),
    metadata: metadataWithCheckpoint(delivery, {
      phase: "superseded",
      attempt: checkpoint?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
      guest_access_epoch: expectedEpoch,
      guest_session_id: guestSessionId,
      guest_session_idempotency_key:
        checkpoint?.guest_session_idempotency_key,
      notification_idempotency_key: notificationIdempotencyKey,
      notification_id: notificationId,
    }),
  })
  logger.error(
    `Digital download notification ${delivery.id} canceled because guest access epoch ${expectedEpoch} was superseded by ${currentEpoch}`,
  )
}

async function invalidateGuestEpochDelivery(input: {
  service: any
  container: any
  logger: any
  delivery: Record<string, any>
  entitlement: Record<string, any>
  checkpoint?: CapabilityCheckpoint
  workerId: string
}): Promise<void> {
  const { service, container, logger, delivery, entitlement, checkpoint, workerId } = input
  let revokeFailed = false
  if (checkpoint?.guest_session_id) {
    try {
      await service.revokeGuestAccessSession(
        checkpoint.guest_session_id,
        "notification_guest_access_epoch_invalid",
      )
    } catch {
      revokeFailed = true
    }
  }

  if (checkpoint?.notification_idempotency_key) {
    try {
      const notificationService = container.resolve(Modules.NOTIFICATION) as any
      await redactNotificationCapabilityTwice(notificationService, {
        notificationId: checkpoint.notification_id,
        idempotencyKey: checkpoint.notification_idempotency_key,
        data: safeNotificationData(delivery, entitlement),
      })
    } catch {
      logger.error(
        `Digital download notification ${delivery.id} could not redact provider data for its invalid guest access epoch`,
      )
    }
  }

  if (revokeFailed) {
    await quarantineDelivery(service, delivery, workerId, {
      phase: "quarantined",
      attempt: checkpoint?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
      guest_session_id: checkpoint?.guest_session_id,
      guest_session_idempotency_key:
        checkpoint?.guest_session_idempotency_key,
      notification_idempotency_key:
        checkpoint?.notification_idempotency_key,
      notification_id: checkpoint?.notification_id,
    })
    logger.error(
      `Digital download notification ${delivery.id} quarantined because invalid guest access cleanup could not be confirmed`,
    )
    return
  }

  await transitionClaimedDelivery(service, delivery, workerId, {
    state: NotificationDeliveryState.DEAD_LETTER,
    lease_owner: null,
    lease_expires_at: null,
    next_retry_at: null,
    error_code: "guest_access_epoch_invalid",
    error_message: "Guest access epoch binding is invalid",
    payload: payloadWithoutGuestAccess(delivery),
  })
  logger.error(
    `Digital download notification ${delivery.id} quarantined because its guest access epoch is invalid`,
  )
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

  // Generated module relation projections may contain only the entitlement ID.
  // Always hydrate the authoritative row before resolving the destination or
  // building provider data; a truthy partial relation is not sufficient here.
  const entitlement = await service.retrieveDigitalEntitlement(
    delivery.entitlement_id
  )
  const existingCheckpoint = checkpointFromDelivery(delivery)
  if (
    delivery.metadata?.notification_capability !== undefined &&
    !existingCheckpoint
  ) {
    await invalidateGuestEpochDelivery({
      service,
      container,
      logger,
      delivery,
      entitlement,
      checkpoint: cleanupCheckpointFromDelivery(delivery),
      workerId,
    })
    return
  }
  if (existingCheckpoint?.phase === "superseded_cleanup") {
    let cleanupEpoch: number
    let currentEpoch: number
    try {
      cleanupEpoch = guestAccessEpoch(
        existingCheckpoint.guest_access_epoch,
      )
      currentEpoch = guestAccessEpoch(entitlement.guest_access_epoch)
    } catch {
      await invalidateGuestEpochDelivery({
        service,
        container,
        logger,
        delivery,
        entitlement,
        checkpoint: existingCheckpoint,
        workerId,
      })
      return
    }
    await cancelSupersededGuestDelivery({
      service,
      container,
      logger,
      delivery,
      entitlement,
      checkpoint: existingCheckpoint,
      expectedEpoch: cleanupEpoch,
      currentEpoch,
      workerId,
    })
    return
  }
  if (existingCheckpoint?.phase === "superseded") {
    await transitionClaimedDelivery(service, delivery, workerId, {
      state: NotificationDeliveryState.CANCELED,
      canceled_at: new Date(),
      lease_owner: null,
      lease_expires_at: null,
      next_retry_at: null,
      error_code: "guest_access_epoch_superseded",
      error_message: "Guest access generation was superseded",
      payload: payloadWithoutGuestAccess(delivery),
    })
    return
  }
  if (existingCheckpoint?.phase === "quarantined") {
    await quarantineDelivery(service, delivery, workerId, existingCheckpoint)
    return
  }

  const guestAccessRequested = deliveryRequestsGuestAccess(delivery)
  let expectedGuestAccessEpoch = 0
  let currentGuestAccessEpoch = 0
  if (guestAccessRequested) {
    try {
      expectedGuestAccessEpoch = deliveryGuestAccessEpoch(delivery)
      currentGuestAccessEpoch = guestAccessEpoch(
        entitlement.guest_access_epoch,
      )
      const checkpointEpoch = existingCheckpoint
        ? guestAccessEpoch(existingCheckpoint.guest_access_epoch)
        : expectedGuestAccessEpoch
      if (existingCheckpoint && checkpointEpoch !== expectedGuestAccessEpoch) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Notification capability epoch binding is inconsistent",
        )
      }
      if (
        existingCheckpoint &&
        [
          "prepared",
          "provider_created",
          "sent_redacted",
          "cleanup_revoked",
        ].includes(existingCheckpoint.phase) &&
        !existingCheckpoint.guest_session_id
      ) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          "Guest notification checkpoint is missing its access session",
        )
      }
    } catch {
      await invalidateGuestEpochDelivery({
        service,
        container,
        logger,
        delivery,
        entitlement,
        checkpoint: existingCheckpoint,
        workerId,
      })
      return
    }
    if (expectedGuestAccessEpoch !== currentGuestAccessEpoch) {
      await cancelSupersededGuestDelivery({
        service,
        container,
        logger,
        delivery,
        entitlement,
        checkpoint: existingCheckpoint,
        expectedEpoch: expectedGuestAccessEpoch,
        currentEpoch: currentGuestAccessEpoch,
        workerId,
      })
      return
    }
  }

  if (!entitlement.customer_email) {
    await markClaimedNotificationFailed(
      service,
      delivery,
      workerId,
      new Error("Entitlement does not have a notification destination"),
    )
    return
  }

  // A registered-customer provider send can succeed immediately before the
  // outbox checkpoint write fails. The prepared checkpoint already contains
  // the native notification idempotency key, so reconcile that record before
  // considering another provider call. Guest sends follow the capability
  // cleanup path below because a previously delivered token must be revoked
  // before a replacement can be issued.
  if (
    (existingCheckpoint?.phase === "prepared" ||
      existingCheckpoint?.phase === "provider_created") &&
    !existingCheckpoint.guest_session_id &&
    existingCheckpoint.notification_idempotency_key
  ) {
    try {
      const notificationService = container.resolve(Modules.NOTIFICATION) as any
      const notification = await notificationByIdempotencyKey(
        notificationService,
        existingCheckpoint.notification_idempotency_key
      )
      if (notificationWasSent(notification)) {
        await transitionClaimedDelivery(service, delivery, workerId, {
          state: NotificationDeliveryState.SENT,
          sent_at: new Date(),
          provider_message_id: notification?.external_id ?? notification?.id ?? null,
          lease_owner: null,
          lease_expires_at: null,
          next_retry_at: null,
          error_code: null,
          error_message: null,
          metadata: metadataWithCheckpoint(delivery, {
            phase: "sent_redacted",
            attempt: existingCheckpoint.attempt,
            notification_idempotency_key:
              existingCheckpoint.notification_idempotency_key,
            notification_id: notification?.id,
          }),
        })
        return
      }
    } catch (error) {
      await markClaimedNotificationFailed(service, delivery, workerId, error)
      logger.error(
        `Digital download notification ${delivery.id} could not reconcile its previous provider result; it remains queued for retry`
      )
      return
    }
  }

  // Redaction completed before a worker crashed. The provider already received
  // the message, so activate the pending capability idempotently and complete
  // the outbox row without sending a duplicate.
  if (existingCheckpoint?.phase === "sent_redacted") {
    try {
      // Re-reserve the recovery slot immediately after every claim. A failed
      // activation or final state write therefore cannot strand a maxed row.
      const reserved = await transitionClaimedDelivery(
        service,
        delivery,
        workerId,
        {
        attempt_count: sentNotificationRecoveryAttemptCount(delivery),
        },
      )
      if (!reserved) return
      if (existingCheckpoint.guest_session_id) {
        const finalized = await service.finalizeNotificationGuestAccess({
          delivery_id: delivery.id,
          entitlement_id: entitlement.id,
          session_id: existingCheckpoint.guest_session_id,
          expected_guest_access_epoch: expectedGuestAccessEpoch,
          worker_id: workerId,
          attempt: Math.max(1, Number(existingCheckpoint.attempt)),
          provider_message_id: existingCheckpoint.notification_id ?? null,
        })
        if (finalized.outcome === "superseded") return
      } else {
        await transitionClaimedDelivery(service, delivery, workerId, {
          state: NotificationDeliveryState.SENT,
          attempt_count: Math.max(1, Number(existingCheckpoint.attempt)),
          sent_at: new Date(),
          provider_message_id: existingCheckpoint.notification_id ?? null,
          lease_owner: null,
          lease_expires_at: null,
          next_retry_at: null,
          error_code: null,
          error_message: null,
        })
      }
    } catch (error) {
      await markClaimedNotificationFailed(service, delivery, workerId, error, {
        reserveSentRecovery: true,
      })
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
          await quarantineDelivery(
            service,
            delivery,
            workerId,
            existingCheckpoint,
          )
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
    let guestSession: Record<string, unknown> | undefined
    keys = attemptKeys(delivery, expectedGuestAccessEpoch)
    if (guestAccessRequested) {
      const guest = await service.createGuestAccessSession({
        entitlement_id: entitlement.id,
        idempotency_key: keys.guestSession,
        initial_status: "pending",
        expected_guest_access_epoch: expectedGuestAccessEpoch,
        metadata: {
          purpose: "notification_delivery",
          notification_delivery_id: delivery.id,
          notification_attempt: keys.attempt,
          guest_access_epoch: expectedGuestAccessEpoch,
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
    const prepared = await transitionClaimedDelivery(
      service,
      delivery,
      workerId,
      {
      metadata: metadataWithCheckpoint(delivery, {
        phase: "prepared",
        attempt: keys.attempt,
        guest_access_epoch: guestAccessRequested
          ? expectedGuestAccessEpoch
          : undefined,
        guest_session_id: guestSessionId,
        guest_session_idempotency_key: guestAccessRequested
          ? keys.guestSession
          : undefined,
        notification_idempotency_key: keys.notification,
      }),
      },
    )
    if (!prepared) {
      if (guestSessionId) {
        await service.revokeGuestAccessSession(
          guestSessionId,
          "notification_delivery_lease_lost_before_send",
        )
      }
      return
    }

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
    const redactedCheckpoint = await transitionClaimedDelivery(
      service,
      delivery,
      workerId,
      {
      // Persist the reserved recovery slot atomically with sent_redacted so a
      // process exit before activation cannot leave this row maxed/dead-lettered.
      attempt_count: sentNotificationRecoveryAttemptCount(delivery),
      metadata: metadataWithCheckpoint(delivery, {
        phase: "sent_redacted",
        attempt: keys.attempt,
        guest_access_epoch: guestAccessRequested
          ? expectedGuestAccessEpoch
          : undefined,
        guest_session_id: guestSessionId,
        guest_session_idempotency_key: guestAccessRequested
          ? keys.guestSession
          : undefined,
        notification_idempotency_key: keys.notification,
        notification_id: notificationId,
      }),
      },
    )
    if (!redactedCheckpoint) {
      if (guestSessionId) {
        await service.revokeGuestAccessSession(
          guestSessionId,
          "notification_delivery_lease_lost_after_send",
        )
      }
      return
    }
    sentRedacted = true
    if (guestSessionId) {
      const finalized = await service.finalizeNotificationGuestAccess({
        delivery_id: delivery.id,
        entitlement_id: entitlement.id,
        session_id: guestSessionId,
        expected_guest_access_epoch: expectedGuestAccessEpoch,
        worker_id: workerId,
        attempt: keys.attempt,
        provider_message_id: notification.external_id ?? notification.id,
      })
      if (finalized.outcome === "superseded") return
    } else {
      await transitionClaimedDelivery(service, delivery, workerId, {
        state: NotificationDeliveryState.SENT,
        attempt_count: keys.attempt,
        sent_at: new Date(),
        provider_message_id: notification.external_id ?? notification.id,
        lease_owner: null,
        lease_expires_at: null,
        next_retry_at: null,
        error_code: null,
        error_message: null,
      })
    }
  } catch (error) {
    if (isGuestAccessEpochSupersededError(error)) {
      await cancelSupersededGuestDelivery({
        service,
        container,
        logger,
        delivery,
        entitlement,
        checkpoint: checkpointFromDelivery(delivery),
        expectedEpoch: error.expectedEpoch,
        currentEpoch: error.currentEpoch,
        guestSessionId,
        notificationId,
        notificationIdempotencyKey: keys?.notification,
        workerId,
      })
      return
    }
    if (sentRedacted) {
      // The durable redaction checkpoint is enough for the next worker to
      // activate idempotently and mark the delivery sent without ever
      // re-sending the notification. Do not revoke here: the provider already
      // received this token and its persisted copy has been safely redacted.
      await markClaimedNotificationFailed(service, delivery, workerId, error, {
        reserveSentRecovery: true,
      })
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
        await quarantineDelivery(service, delivery, workerId, {
          phase: "provider_created",
          attempt: keys?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
          guest_access_epoch: guestAccessRequested
            ? expectedGuestAccessEpoch
            : undefined,
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
    const cleanupMetadata = guestSessionId
      ? metadataWithCheckpoint(delivery, {
          phase: "cleanup_revoked",
          attempt: keys?.attempt ?? Math.max(1, Number(delivery.attempt_count ?? 0)),
          guest_access_epoch: guestAccessRequested
            ? expectedGuestAccessEpoch
            : undefined,
          guest_session_id: guestSessionId,
          guest_session_idempotency_key: keys?.guestSession,
          notification_idempotency_key: keys?.notification,
          notification_id: notificationId,
        })
      : undefined
    await markClaimedNotificationFailed(
      service,
      delivery,
      workerId,
      safeError,
      { metadata: cleanupMetadata },
    )
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
