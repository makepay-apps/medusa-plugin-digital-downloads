import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import digitalNotificationRequestedHandler from "../subscribers/digital-notification-requested"
import { retryNotificationDeliveriesWorkflow } from "../workflows"
import { DIGITAL_DOWNLOAD_EVENTS } from "../workflows/digital-downloads/events"

export const NOTIFICATION_RETRY_BATCH_SIZE = 10

export default async function retryDigitalNotificationsJob(
  container: MedusaContainer,
  context?: { scheduledFor: Date }
): Promise<void> {
  const runId = (context?.scheduledFor ?? new Date()).toISOString()
  const { result } = await retryNotificationDeliveriesWorkflow(container).run({
    input: { as_of: runId, limit: NOTIFICATION_RETRY_BATCH_SIZE },
    context: { transactionId: `digital-downloads:retry-notifications:${runId}` },
  })

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  for (const delivery of result.claimed) {
    try {
      // The local event bus schedules subscribers without awaiting them. Calling
      // the same locked delivery path directly keeps retry concurrency at one.
      await digitalNotificationRequestedHandler({
        event: {
          name: DIGITAL_DOWNLOAD_EVENTS.NOTIFICATION_REQUESTED,
          data: {
            delivery_id: delivery.id,
            lease_owner: delivery.lease_owner,
          },
        },
        container,
      } as any)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(
        `Digital download notification retry ${delivery.id} could not start: ${message}`
      )
    }
  }
}

export const config = {
  name: "digital-downloads-retry-notifications",
  schedule: { cron: "*/2 * * * *", concurrency: "forbid" as const },
}
