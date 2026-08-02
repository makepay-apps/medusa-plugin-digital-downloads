import { model } from "@medusajs/framework/utils"
import { DownloadGrantStatus } from "../types"
import DigitalAsset from "./digital-asset"
import DigitalEntitlement from "./digital-entitlement"
import DownloadEvent from "./download-event"

const DownloadGrant = model
  .define("download_grant", {
    id: model.id({ prefix: "dgrant" }).primaryKey(),
    entitlement: model.belongsTo(() => DigitalEntitlement, {
      mappedBy: "grants",
    }),
    asset: model.belongsTo(() => DigitalAsset, { mappedBy: "grants" }),
    status: model
      .enum(DownloadGrantStatus)
      .default(DownloadGrantStatus.ACTIVE),
    /** Keyed digest only. The bearer token is returned once and never stored. */
    token_hash: model.text().unique("UQ_download_grant_token_hash"),
    token_prefix: model.text(),
    idempotency_key: model.text().unique("UQ_download_grant_idempotency_key"),
    max_uses: model.number().default(1),
    use_count: model.number().default(0),
    expires_at: model.dateTime(),
    last_used_at: model.dateTime().nullable(),
    /** Durable in-flight transfer reservation; cleared on commit or failure. */
    reservation_id: model.text().nullable(),
    reserved_at: model.dateTime().nullable(),
    /** Bounded HTTP range-resume window for the same bearer-grant session. */
    continuation_started_at: model.dateTime().nullable(),
    continuation_expires_at: model.dateTime().nullable(),
    revoked_at: model.dateTime().nullable(),
    revoke_reason: model.text().nullable(),
    bound_ip_hash: model.text().nullable(),
    bound_user_agent_hash: model.text().nullable(),
    metadata: model.json().default({}),
    events: model.hasMany(() => DownloadEvent, { mappedBy: "grant" }),
  })
  .indexes([
    {
      name: "IDX_download_grant_entitlement",
      on: ["entitlement_id", "status"],
    },
    { name: "IDX_download_grant_expiry", on: ["expires_at", "status"] },
  ])
  .checks([
    { name: "CK_download_grant_max_uses", expression: ({ max_uses }) => `${max_uses} > 0` },
    { name: "CK_download_grant_use_count", expression: ({ use_count }) => `${use_count} >= 0` },
  ])

export default DownloadGrant
