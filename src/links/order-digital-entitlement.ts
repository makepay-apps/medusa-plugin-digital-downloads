import { defineLink } from "@medusajs/framework/utils"
import OrderModule from "@medusajs/medusa/order"
import DigitalDownloadsModule from "../modules/digital-downloads"

/** An order owns zero or more durable digital entitlements. */
export default defineLink(OrderModule.linkable.order, {
  linkable: DigitalDownloadsModule.linkable.digitalEntitlement,
  isList: true,
})
