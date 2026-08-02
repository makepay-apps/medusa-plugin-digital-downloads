import { model } from "@medusajs/framework/utils"
import { LicensePoolKeyStatus } from "../types"
import LicenseAssignment from "./license-assignment"
import LicensePolicy from "./license-policy"

const LicensePoolKey = model
  .define("license_pool_key", {
    id: model.id({ prefix: "dlkey" }).primaryKey(),
    license_policy: model.belongsTo(() => LicensePolicy, {
      mappedBy: "pool_keys",
    }),
    status: model
      .enum(LicensePoolKeyStatus)
      .default(LicensePoolKeyStatus.AVAILABLE),
    /** AES-256-GCM envelope. Store projections must never include this field. */
    key_ciphertext: model.text(),
    /** Keyed digest used for duplicate detection without retaining plaintext. */
    key_fingerprint: model
      .text()
      .unique("UQ_license_pool_key_fingerprint"),
    key_hint: model.text(),
    batch_id: model.text().nullable(),
    reserved_at: model.dateTime().nullable(),
    assigned_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    metadata: model.json().default({}),
    assignment: model
      .hasOne(() => LicenseAssignment, { mappedBy: "license_pool_key" })
      .nullable(),
  })
  .indexes([
    {
      name: "IDX_license_pool_key_available",
      on: ["license_policy_id", "status"],
    },
    { name: "IDX_license_pool_key_batch", on: ["batch_id"] },
  ])

export default LicensePoolKey
