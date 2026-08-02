import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { PaymentEvents } from "@medusajs/framework/utils"
import { issueOrderEntitlementsWorkflow } from "../workflows"
import { orderIdForPayment } from "./_utils"

type PaymentEvent = { id: string }

export default async function paymentCapturedHandler({
  event,
  container,
}: SubscriberArgs<PaymentEvent>): Promise<void> {
  const orderId = await orderIdForPayment(container, event.data.id)
  if (!orderId) {
    return
  }

  await issueOrderEntitlementsWorkflow(container).run({
    input: { order_id: orderId, source: "payment.captured" },
    context: {
      transactionId: `digital-downloads:payment-captured:${event.data.id}`,
    },
  })
}

export const config: SubscriberConfig = {
  event: PaymentEvents.CAPTURED,
  context: { subscriberId: "digital-downloads-payment-captured" },
}
