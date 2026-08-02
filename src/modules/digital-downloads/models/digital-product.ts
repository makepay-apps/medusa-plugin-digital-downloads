import { model } from "@medusajs/framework/utils"
import {
  DigitalDeliveryMode,
  DigitalProductStatus,
} from "../types"
import DigitalEntitlement from "./digital-entitlement"
import DigitalProductRelease from "./digital-product-release"
import LicensePolicy from "./license-policy"

const DigitalProduct = model
  .define("digital_product", {
    id: model.id({ prefix: "dprod" }).primaryKey(),
    title: model.text().searchable(),
    handle: model.text().unique("UQ_digital_product_handle"),
    description: model.text().nullable(),
    status: model.enum(DigitalProductStatus).default(DigitalProductStatus.DRAFT),
    delivery_type: model
      .enum(DigitalDeliveryMode)
      .default(DigitalDeliveryMode.DOWNLOAD),
    fulfillment_required: model.boolean().default(true),
    published_at: model.dateTime().nullable(),
    metadata: model.json().default({}),
    releases: model.hasMany(() => DigitalProductRelease, {
      mappedBy: "digital_product",
    }),
    entitlements: model.hasMany(() => DigitalEntitlement, {
      mappedBy: "digital_product",
    }),
    license_policy: model
      .hasOne(() => LicensePolicy, { mappedBy: "digital_product" })
      .nullable(),
  })
  .indexes([
    { name: "IDX_digital_product_status", on: ["status"] },
    { name: "IDX_digital_product_published_at", on: ["published_at"] },
  ])

export default DigitalProduct
