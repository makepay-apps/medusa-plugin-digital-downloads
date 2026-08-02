import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { OrderWorkflowEvents } from "@medusajs/framework/utils"
import { revokeOrderEntitlementsWorkflow } from "../workflows"
import { subscriberRevocationPolicies } from "./_utils"

type OrderEvent = { id: string }

export default async function orderCanceledHandler({
  event,
  container,
  pluginOptions,
}: SubscriberArgs<OrderEvent>): Promise<void> {
  const policy = subscriberRevocationPolicies(
    container,
    pluginOptions
  ).cancellationPolicy
  await revokeOrderEntitlementsWorkflow(container).run({
    input: {
      order_id: event.data.id,
      trigger: "cancellation",
      policy,
      reason: "Order was canceled",
    },
    context: {
      transactionId: `digital-downloads:order-canceled:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: OrderWorkflowEvents.CANCELED,
  context: { subscriberId: "digital-downloads-order-canceled" },
}
