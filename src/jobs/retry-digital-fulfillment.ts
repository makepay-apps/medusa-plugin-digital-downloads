import type { MedusaContainer } from "@medusajs/framework/types"
import {
  issueOrderEntitlementsWorkflow,
  retryDigitalOperationsWorkflow,
} from "../workflows"

export default async function retryDigitalFulfillmentJob(
  container: MedusaContainer,
  context?: { scheduledFor: Date }
): Promise<void> {
  const scheduledFor = context?.scheduledFor ?? new Date()
  const runId = scheduledFor.toISOString()
  const { result } = await retryDigitalOperationsWorkflow(container).run({
    input: { as_of: runId, limit: 25 },
    context: { transactionId: `digital-downloads:retry-operations:${runId}` },
  })

  for (const orderId of result.order_ids) {
    await issueOrderEntitlementsWorkflow(container).run({
      input: {
        order_id: orderId,
        force: false,
        source: "reconciliation",
      },
      context: {
        transactionId: `digital-downloads:reconcile:${orderId}:${runId}`,
      },
    })
  }
}

export const config = {
  name: "digital-downloads-retry-fulfillment",
  schedule: { cron: "*/5 * * * *", concurrency: "forbid" as const },
}
