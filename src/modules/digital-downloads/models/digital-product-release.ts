import { model } from "@medusajs/framework/utils"
import { DigitalReleaseStatus } from "../types"
import DigitalAsset from "./digital-asset"
import DigitalEntitlement from "./digital-entitlement"
import DigitalProduct from "./digital-product"

const DigitalProductRelease = model
  .define("digital_product_release", {
    id: model.id({ prefix: "drel" }).primaryKey(),
    digital_product: model.belongsTo(() => DigitalProduct, {
      mappedBy: "releases",
    }),
    version: model.text(),
    title: model.text().nullable(),
    release_notes: model.text().nullable(),
    status: model
      .enum(DigitalReleaseStatus)
      .default(DigitalReleaseStatus.DRAFT),
    is_current: model.boolean().default(false),
    available_from: model.dateTime().nullable(),
    available_until: model.dateTime().nullable(),
    published_at: model.dateTime().nullable(),
    metadata: model.json().default({}),
    assets: model.hasMany(() => DigitalAsset, { mappedBy: "release" }),
    entitlements: model.hasMany(() => DigitalEntitlement, {
      mappedBy: "release",
    }),
  })
  .indexes([
    {
      name: "UQ_digital_product_release_version",
      on: ["digital_product_id", "version"],
      unique: true,
    },
    {
      name: "UQ_digital_product_release_current",
      on: ["digital_product_id"],
      unique: true,
      where: "is_current = true AND deleted_at IS NULL",
    },
    { name: "IDX_digital_product_release_status", on: ["status"] },
  ])
  .checks([
    { name: "CK_digital_product_release_availability", expression: ({ available_from, available_until }) =>
      `(${available_until} IS NULL OR ${available_from} IS NULL OR ${available_until} > ${available_from})` },
  ])

export default DigitalProductRelease
