import { model } from "@medusajs/framework/utils"
import { AccessSessionStatus } from "../types"
import DigitalEntitlement from "./digital-entitlement"

/** Durable hashed guest capability for entitlement-level storefront access. */
const EntitlementAccessSession = model
  .define("entitlement_access_session", {
    id: model.id({ prefix: "daccess" }).primaryKey(),
    entitlement: model.belongsTo(() => DigitalEntitlement, {
      mappedBy: "access_sessions",
    }),
    status: model
      .enum(AccessSessionStatus)
      .default(AccessSessionStatus.ACTIVE),
    token_hash: model.text().unique("UQ_entitlement_access_session_token"),
    token_prefix: model.text(),
    idempotency_key: model
      .text()
      .unique("UQ_entitlement_access_session_idempotency"),
    expires_at: model.dateTime(),
    last_used_at: model.dateTime().nullable(),
    use_count: model.number().default(0),
    bound_ip_hash: model.text().nullable(),
    bound_user_agent_hash: model.text().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoke_reason: model.text().nullable(),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "IDX_entitlement_access_session_entitlement",
      on: ["entitlement_id", "status"],
    },
    {
      name: "IDX_entitlement_access_session_expiry",
      on: ["expires_at", "status"],
    },
  ])
  .checks([
    { name: "CK_entitlement_access_session_use_count", expression: ({ use_count }) => `${use_count} >= 0` },
  ])

export default EntitlementAccessSession
