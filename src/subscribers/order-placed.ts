import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"
import { issueOrderEntitlementsWorkflow } from "../workflows"

type OrderEvent = { id: string }

export default async function orderPlacedHandler({
  event,
  container,
}: SubscriberArgs<OrderEvent>): Promise<void> {
  await issueOrderEntitlementsWorkflow(container).run({
    input: { order_id: event.data.id, source: "order.placed" },
    context: {
      transactionId: `digital-downloads:order-placed:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.PLACED,
  context: { subscriberId: "digital-downloads-order-placed" },
}
