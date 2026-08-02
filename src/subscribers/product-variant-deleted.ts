import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ProductVariantWorkflowEvents } from "@medusajs/framework/utils"
import { cleanupDigitalVariantWorkflow } from "../workflows"

type VariantEvent = { id: string }

export default async function productVariantDeletedHandler({
  event,
  container,
}: SubscriberArgs<VariantEvent>): Promise<void> {
  await cleanupDigitalVariantWorkflow(container).run({
    input: { variant_id: event.data.id },
    context: {
      transactionId: `digital-downloads:variant-deleted:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: ProductVariantWorkflowEvents.DELETED,
  context: { subscriberId: "digital-downloads-variant-deleted" },
}
