import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ProductWorkflowEvents } from "@medusajs/framework/utils"
import { cleanupOrphanedDigitalProductsWorkflow } from "../workflows"

type ProductEvent = { id: string }

export default async function productDeletedHandler({
  event,
  container,
}: SubscriberArgs<ProductEvent>): Promise<void> {
  await cleanupOrphanedDigitalProductsWorkflow(container).run({
    input: { limit: 1000 },
    context: {
      transactionId: `digital-downloads:product-deleted:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: ProductWorkflowEvents.DELETED,
  context: { subscriberId: "digital-downloads-product-deleted" },
}
