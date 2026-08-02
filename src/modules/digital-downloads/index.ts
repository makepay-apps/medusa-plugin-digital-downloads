import { Module } from "@medusajs/framework/utils"
import digitalDownloadsLoader from "./loaders/index"
import DigitalDownloadsModuleService from "./service"

export const DIGITAL_DOWNLOADS_MODULE = "digitalDownloads"

export default Module(DIGITAL_DOWNLOADS_MODULE, {
  service: DigitalDownloadsModuleService,
  loaders: [digitalDownloadsLoader],
})

export { DigitalDownloadsModuleService }
export * from "./models"
export * from "./storage"
export * from "./types"
export * from "./utils"
