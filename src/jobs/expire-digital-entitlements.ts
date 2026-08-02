import type { MedusaContainer } from "@medusajs/framework/types"
import { expireEntitlementsWorkflow } from "../workflows"

export default async function expireDigitalEntitlementsJob(
  container: MedusaContainer,
  context?: { scheduledFor: Date }
): Promise<void> {
  const runId = (context?.scheduledFor ?? new Date()).toISOString()
  await expireEntitlementsWorkflow(container).run({
    input: { as_of: runId, limit: 500 },
    context: { transactionId: `digital-downloads:expire:${runId}` },
  })
}

export const config = {
  name: "digital-downloads-expire-entitlements",
  schedule: { cron: "17 * * * *", concurrency: "forbid" as const },
}
