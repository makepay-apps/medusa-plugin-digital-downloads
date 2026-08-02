import { model } from "@medusajs/framework/utils"
import { LicenseAuditAction } from "../types"
import LicenseAssignment from "./license-assignment"

const LicenseAuditEvent = model
  .define("license_audit_event", {
    id: model.id({ prefix: "dlaud" }).primaryKey(),
    assignment: model
      .belongsTo(() => LicenseAssignment, { mappedBy: "audit_events" })
      .nullable(),
    action: model.enum(LicenseAuditAction),
    success: model.boolean().default(true),
    actor_type: model.text().nullable(),
    actor_id: model.text().nullable(),
    ip_hash: model.text().nullable(),
    error_code: model.text().nullable(),
    occurred_at: model.dateTime(),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "IDX_license_audit_assignment_time",
      on: ["assignment_id", "occurred_at"],
    },
    { name: "IDX_license_audit_action", on: ["action"] },
  ])

export default LicenseAuditEvent
