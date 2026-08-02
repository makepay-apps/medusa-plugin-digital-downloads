import { defineLink } from "@medusajs/framework/utils"
import CustomerModule from "@medusajs/medusa/customer"
import DigitalDownloadsModule from "../modules/digital-downloads"

/**
 * Authenticated purchases are linked to their Medusa customer. Guest ownership
 * remains represented by the immutable order/email snapshot on the entitlement.
 */
export default defineLink(CustomerModule.linkable.customer, {
  linkable: DigitalDownloadsModule.linkable.digitalEntitlement,
  isList: true,
})
