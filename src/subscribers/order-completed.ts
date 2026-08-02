import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"
import { issueOrderEntitlementsWorkflow } from "../workflows"

type OrderEvent = { id: string }

export default async function orderCompletedHandler({
  event,
  container,
}: SubscriberArgs<OrderEvent>): Promise<void> {
  await issueOrderEntitlementsWorkflow(container).run({
    input: { order_id: event.data.id, source: "order.completed" },
    context: {
      transactionId: `digital-downloads:order-completed:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.COMPLETED,
  context: { subscriberId: "digital-downloads-order-completed" },
}
