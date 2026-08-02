import { model } from "@medusajs/framework/utils"
import { LicenseActivationStatus } from "../types"
import LicenseAssignment from "./license-assignment"

const LicenseActivation = model
  .define("license_activation", {
    id: model.id({ prefix: "dlact" }).primaryKey(),
    assignment: model.belongsTo(() => LicenseAssignment, {
      mappedBy: "activations",
    }),
    /** Keyed digest; the raw device identifier is never stored. */
    device_fingerprint: model.text(),
    device_name: model.text().nullable(),
    ip_hash: model.text().nullable(),
    user_agent_hash: model.text().nullable(),
    status: model
      .enum(LicenseActivationStatus)
      .default(LicenseActivationStatus.ACTIVE),
    activated_at: model.dateTime(),
    last_seen_at: model.dateTime(),
    deactivated_at: model.dateTime().nullable(),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "UQ_license_activation_assignment_device",
      on: ["assignment_id", "device_fingerprint"],
      unique: true,
    },
    { name: "IDX_license_activation_status", on: ["status"] },
  ])

export default LicenseActivation
