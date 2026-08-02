import { model } from "@medusajs/framework/utils"
import {
  DigitalAssetKind,
  DigitalAssetRole,
  DigitalAssetStatus,
  DigitalDeliveryMode,
  DigitalStorageProvider,
} from "../types"
import DigitalProductRelease from "./digital-product-release"
import DownloadEvent from "./download-event"
import DownloadGrant from "./download-grant"

const DigitalAsset = model
  .define("digital_asset", {
    id: model.id({ prefix: "dasset" }).primaryKey(),
    release: model.belongsTo(() => DigitalProductRelease, {
      mappedBy: "assets",
    }).nullable(),
    name: model.text().searchable(),
    role: model.enum(DigitalAssetRole).default(DigitalAssetRole.DOWNLOAD),
    kind: model.enum(DigitalAssetKind).default(DigitalAssetKind.FILE),
    status: model.enum(DigitalAssetStatus).default(DigitalAssetStatus.STAGED),
    delivery_type: model
      .enum(DigitalDeliveryMode)
      .default(DigitalDeliveryMode.DOWNLOAD),
    storage_provider: model.enum(DigitalStorageProvider),
    /** Private provider key. Never include this field in a store-facing projection. */
    storage_key: model.text(),
    /** Private bucket override, primarily for imported S3 objects. */
    storage_bucket: model.text().nullable(),
    original_filename: model.text(),
    mime_type: model.text(),
    size_bytes: model.bigNumber(),
    checksum_sha256: model.text(),
    version: model.text().default("1"),
    sort_order: model.number().default(0),
    is_enabled: model.boolean().default(true),
    metadata: model.json().default({}),
    grants: model.hasMany(() => DownloadGrant, { mappedBy: "asset" }),
    download_events: model.hasMany(() => DownloadEvent, { mappedBy: "asset" }),
  })
  .indexes([
    {
      name: "UQ_digital_asset_storage_object",
      on: ["storage_provider", "storage_key"],
      unique: true,
    },
    {
      name: "IDX_digital_asset_release_sort",
      on: ["release_id", "sort_order"],
    },
    { name: "IDX_digital_asset_checksum", on: ["checksum_sha256"] },
    { name: "IDX_digital_asset_status", on: ["status"] },
  ])
  .checks([
    { name: "CK_digital_asset_size_bytes", expression: ({ size_bytes }) => `${size_bytes} >= 0` },
    { name: "CK_digital_asset_sort_order", expression: ({ sort_order }) => `${sort_order} >= 0` },
  ])

export default DigitalAsset
