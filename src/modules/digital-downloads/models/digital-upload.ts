import { model } from "@medusajs/framework/utils"
import {
  DigitalStorageProvider,
  DigitalUploadPurpose,
  DigitalUploadStatus,
} from "../types"
import DigitalProductRelease from "./digital-product-release"

/** Durable upload intent; bearer upload tokens are stored as keyed hashes only. */
const DigitalUpload = model
  .define("digital_upload", {
    id: model.id({ prefix: "dupl" }).primaryKey(),
    release: model.belongsTo(() => DigitalProductRelease).nullable(),
    asset_id: model.text().nullable(),
    status: model.enum(DigitalUploadStatus).default(DigitalUploadStatus.PENDING),
    purpose: model
      .enum(DigitalUploadPurpose)
      .default(DigitalUploadPurpose.DOWNLOAD),
    storage_provider: model.enum(DigitalStorageProvider),
    storage_key: model.text().unique("UQ_digital_upload_storage_key"),
    storage_bucket: model.text().nullable(),
    original_filename: model.text(),
    mime_type: model.text(),
    expected_size_bytes: model.bigNumber(),
    expected_checksum_sha256: model.text().nullable(),
    actual_size_bytes: model.bigNumber().nullable(),
    actual_checksum_sha256: model.text().nullable(),
    upload_token_hash: model.text().nullable(),
    expires_at: model.dateTime(),
    uploaded_at: model.dateTime().nullable(),
    completed_at: model.dateTime().nullable(),
    error_message: model.text().nullable(),
    metadata: model.json().default({}),
  })
  .indexes([
    { name: "IDX_digital_upload_status_expiry", on: ["status", "expires_at"] },
    { name: "IDX_digital_upload_release", on: ["release_id"] },
  ])
  .checks([
    { name: "CK_digital_upload_expected_size", expression: ({ expected_size_bytes }) =>
      `${expected_size_bytes} > 0` },
    { name: "CK_digital_upload_actual_size", expression: ({ actual_size_bytes }) =>
      `(${actual_size_bytes} IS NULL OR ${actual_size_bytes} >= 0)` },
  ])

export default DigitalUpload
