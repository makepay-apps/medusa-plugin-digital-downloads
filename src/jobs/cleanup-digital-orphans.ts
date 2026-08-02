import type { MedusaContainer } from "@medusajs/framework/types"
import { cleanupOrphanedDigitalProductsWorkflow } from "../workflows"

export default async function cleanupDigitalOrphansJob(
  container: MedusaContainer,
  context?: { scheduledFor: Date }
): Promise<void> {
  const runId = (context?.scheduledFor ?? new Date()).toISOString()
  await cleanupOrphanedDigitalProductsWorkflow(container).run({
    input: { limit: 1000 },
    context: { transactionId: `digital-downloads:cleanup-orphans:${runId}` },
  })
}

export const config = {
  name: "digital-downloads-cleanup-orphans",
  schedule: { cron: "43 3 * * *", concurrency: "forbid" as const },
}
