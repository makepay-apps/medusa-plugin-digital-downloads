import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { PaymentEvents } from "@medusajs/framework/utils"
import { revokeOrderEntitlementsWorkflow } from "../workflows"
import {
  eventTransactionId,
  subscriberRevocationPolicies,
} from "./_utils"

type PaymentEvent = { id: string }

export default async function paymentRefundedHandler({
  event,
  container,
  pluginOptions,
}: SubscriberArgs<PaymentEvent>): Promise<void> {
  const policy = subscriberRevocationPolicies(
    container,
    pluginOptions
  ).refundPolicy
  await revokeOrderEntitlementsWorkflow(container).run({
    input: {
      payment_id: event.data.id,
      trigger: "refund",
      policy,
      reason: "Payment was refunded",
    },
    context: {
      transactionId: eventTransactionId(
        "digital-downloads:payment-refunded",
        event,
        event.data.id
      ),
    },
  })
}

export const config: SubscriberConfig = {
  event: PaymentEvents.REFUNDED,
  context: { subscriberId: "digital-downloads-payment-refunded" },
}
