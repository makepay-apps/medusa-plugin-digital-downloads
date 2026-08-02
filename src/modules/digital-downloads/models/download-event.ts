import { model } from "@medusajs/framework/utils"
import { DownloadEventType } from "../types"
import DigitalAsset from "./digital-asset"
import DigitalEntitlement from "./digital-entitlement"
import DownloadGrant from "./download-grant"

const DownloadEvent = model
  .define("download_event", {
    id: model.id({ prefix: "devent" }).primaryKey(),
    grant: model
      .belongsTo(() => DownloadGrant, { mappedBy: "events" })
      .nullable(),
    entitlement: model
      .belongsTo(() => DigitalEntitlement, { mappedBy: "download_events" })
      .nullable(),
    asset: model
      .belongsTo(() => DigitalAsset, { mappedBy: "download_events" })
      .nullable(),
    event_type: model.enum(DownloadEventType),
    success: model.boolean().default(true),
    denial_reason: model.text().nullable(),
    ip_hash: model.text().nullable(),
    user_agent_hash: model.text().nullable(),
    occurred_at: model.dateTime(),
    bytes_served: model.bigNumber().nullable(),
    range_start: model.bigNumber().nullable(),
    range_end: model.bigNumber().nullable(),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "IDX_download_event_entitlement_time",
      on: ["entitlement_id", "occurred_at"],
    },
    {
      name: "IDX_download_event_asset_time",
      on: ["asset_id", "occurred_at"],
    },
    { name: "IDX_download_event_type", on: ["event_type"] },
    {
      name: "UQ_download_event_denied_grant_reason",
      on: ["grant_id", "denial_reason"],
      unique: true,
      where: "event_type = 'denied' AND deleted_at IS NULL",
    },
  ])
  .checks([
    { name: "CK_download_event_bytes_served", expression: ({ bytes_served }) =>
      `(${bytes_served} IS NULL OR ${bytes_served} >= 0)` },
  ])

export default DownloadEvent
