import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import DigitalFulfillmentProviderService from "./service"

export { default as DigitalFulfillmentProviderService } from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [DigitalFulfillmentProviderService],
})
