import { model } from "@medusajs/framework/utils"
import {
  DigitalEntitlementSource,
  DigitalEntitlementStatus,
} from "../types"
import DigitalProduct from "./digital-product"
import DigitalProductRelease from "./digital-product-release"
import DownloadEvent from "./download-event"
import DownloadGrant from "./download-grant"
import LicenseAssignment from "./license-assignment"
import EntitlementAccessSession from "./entitlement-access-session"

const DigitalEntitlement = model
  .define("digital_entitlement", {
    id: model.id({ prefix: "dent" }).primaryKey(),
    digital_product: model.belongsTo(() => DigitalProduct, {
      mappedBy: "entitlements",
    }),
    release: model.belongsTo(() => DigitalProductRelease, {
      mappedBy: "entitlements",
    }),
    status: model
      .enum(DigitalEntitlementStatus)
      .default(DigitalEntitlementStatus.PENDING),
    source: model
      .enum(DigitalEntitlementSource)
      .default(DigitalEntitlementSource.ORDER),
    order_id: model.text().nullable(),
    order_line_item_id: model.text().nullable(),
    fulfillment_id: model.text().nullable(),
    customer_id: model.text().nullable(),
    customer_email: model.text().nullable(),
    customer_name: model.text().nullable(),
    unit_index: model.number().default(0),
    quantity: model.number().default(1),
    available_at: model.dateTime().nullable(),
    expires_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoke_reason: model.text().nullable(),
    download_limit: model.number().nullable(),
    download_count: model.number().default(0),
    license_activation_limit: model.number().nullable(),
    idempotency_key: model
      .text()
      .unique("UQ_digital_entitlement_idempotency_key"),
    /** Immutable purchase/product/customer snapshot used for audit and display. */
    snapshot: model.json().default({}),
    metadata: model.json().default({}),
    grants: model.hasMany(() => DownloadGrant, { mappedBy: "entitlement" }),
    download_events: model.hasMany(() => DownloadEvent, {
      mappedBy: "entitlement",
    }),
    license_assignments: model.hasMany(() => LicenseAssignment, {
      mappedBy: "entitlement",
    }),
    access_sessions: model.hasMany(() => EntitlementAccessSession, {
      mappedBy: "entitlement",
    }),
  })
  .indexes([
    { name: "IDX_digital_entitlement_order", on: ["order_id"] },
    {
      name: "IDX_digital_entitlement_customer",
      on: ["customer_id", "status"],
    },
    {
      name: "IDX_digital_entitlement_email",
      on: ["customer_email", "status"],
    },
    {
      name: "IDX_digital_entitlement_product",
      on: ["digital_product_id", "status"],
    },
    {
      name: "UQ_digital_entitlement_order_line_unit",
      on: ["order_id", "order_line_item_id", "unit_index"],
      unique: true,
    },
    { name: "IDX_digital_entitlement_expires", on: ["expires_at"] },
  ])
  .checks([
    { name: "CK_digital_entitlement_quantity", expression: ({ quantity }) => `${quantity} > 0` },
    { name: "CK_digital_entitlement_unit_index", expression: ({ unit_index }) => `${unit_index} >= 0` },
    { name: "CK_digital_entitlement_download_count", expression: ({ download_count }) => `${download_count} >= 0` },
    { name: "CK_digital_entitlement_download_limit", expression: ({ download_limit }) =>
      `(${download_limit} IS NULL OR ${download_limit} >= 0)` },
    { name: "CK_digital_entitlement_activation_limit", expression: ({ license_activation_limit }) =>
      `(${license_activation_limit} IS NULL OR ${license_activation_limit} >= 0)` },
  ])

export default DigitalEntitlement
