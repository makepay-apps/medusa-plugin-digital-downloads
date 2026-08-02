import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { revokeOrderEntitlementsWorkflow } from "../workflows"
import { eventTransactionId } from "./_utils"

type ChargebackEvent = { id?: string; payment_id?: string; order_id?: string }

export default async function paymentChargebackHandler({
  event,
  container,
}: SubscriberArgs<ChargebackEvent>): Promise<void> {
  const paymentId = event.data.payment_id ?? event.data.id
  const resourceId = event.data.order_id ?? paymentId
  if (!resourceId) {
    return
  }

  await revokeOrderEntitlementsWorkflow(container).run({
    input: {
      order_id: event.data.order_id,
      payment_id: paymentId,
      trigger: "chargeback",
      policy: "all",
      reason: "Payment was disputed or charged back",
    },
    context: {
      transactionId: eventTransactionId(
        "digital-downloads:chargeback",
        event,
        resourceId
      ),
    },
  })
}

export const config: SubscriberConfig = {
  // Provider integrations use different dispute names. Listening to both is
  // harmless because entitlement revocation is idempotent.
  event: ["payment.chargeback_created", "payment.dispute.created"],
  context: { subscriberId: "digital-downloads-payment-chargeback" },
}
