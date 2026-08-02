import { model } from "@medusajs/framework/utils"
import { LicenseAssignmentStatus } from "../types"
import DigitalEntitlement from "./digital-entitlement"
import LicenseActivation from "./license-activation"
import LicenseAuditEvent from "./license-audit-event"
import LicensePolicy from "./license-policy"
import LicensePoolKey from "./license-pool-key"

const LicenseAssignment = model
  .define("license_assignment", {
    id: model.id({ prefix: "dlassn" }).primaryKey(),
    entitlement: model.belongsTo(() => DigitalEntitlement, {
      mappedBy: "license_assignments",
    }),
    license_policy: model.belongsTo(() => LicensePolicy, {
      mappedBy: "assignments",
    }),
    license_pool_key: model
      .belongsTo(() => LicensePoolKey, { mappedBy: "assignment" })
      .nullable(),
    status: model
      .enum(LicenseAssignmentStatus)
      .default(LicenseAssignmentStatus.ACTIVE),
    idempotency_key: model
      .text()
      .unique("UQ_license_assignment_idempotency_key"),
    activation_count: model.number().default(0),
    assigned_at: model.dateTime(),
    revealed_at: model.dateTime().nullable(),
    expires_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoke_reason: model.text().nullable(),
    metadata: model.json().default({}),
    activations: model.hasMany(() => LicenseActivation, {
      mappedBy: "assignment",
    }),
    audit_events: model.hasMany(() => LicenseAuditEvent, {
      mappedBy: "assignment",
    }),
  })
  .indexes([
    {
      name: "UQ_license_assignment_entitlement_policy",
      on: ["entitlement_id", "license_policy_id"],
      unique: true,
    },
    { name: "IDX_license_assignment_status", on: ["status"] },
  ])
  .checks([
    { name: "CK_license_assignment_activation_count", expression: ({ activation_count }) => `${activation_count} >= 0` },
  ])

export default LicenseAssignment
