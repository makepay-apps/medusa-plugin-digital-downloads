import { model } from "@medusajs/framework/utils"
import { LicenseStrategy } from "../types"
import DigitalProduct from "./digital-product"
import LicenseAssignment from "./license-assignment"
import LicensePoolKey from "./license-pool-key"

const LicensePolicy = model
  .define("license_policy", {
    id: model.id({ prefix: "dlpol" }).primaryKey(),
    digital_product: model.belongsTo(() => DigitalProduct, {
      mappedBy: "license_policy",
    }),
    strategy: model.enum(LicenseStrategy).default(LicenseStrategy.NONE),
    license_pattern: model.text().nullable(),
    activation_limit: model.number().nullable(),
    validity_days: model.number().nullable(),
    allow_offline_activation: model.boolean().default(false),
    require_device_id: model.boolean().default(true),
    is_enabled: model.boolean().default(true),
    metadata: model.json().default({}),
    pool_keys: model.hasMany(() => LicensePoolKey, {
      mappedBy: "license_policy",
    }),
    assignments: model.hasMany(() => LicenseAssignment, {
      mappedBy: "license_policy",
    }),
  })
  .checks([
    { name: "CK_license_policy_activation_limit", expression: ({ activation_limit }) =>
      `(${activation_limit} IS NULL OR ${activation_limit} >= 0)` },
    { name: "CK_license_policy_validity_days", expression: ({ validity_days }) =>
      `(${validity_days} IS NULL OR ${validity_days} > 0)` },
  ])

export default LicensePolicy
