import { model } from "@medusajs/framework/utils"
import { DigitalDeliveryMode } from "../types"

export const DIGITAL_DOWNLOADS_SETTINGS_KEY = "global"
export const MAKEPAY_ATTRIBUTION_LABEL =
  "Brought to you by MakePay.io — crypto payment gateway."
export const MAKEPAY_ATTRIBUTION_URL = "https://makepay.io"

const DigitalDownloadsSettings = model
  .define("digital_downloads_settings", {
    id: model.id({ prefix: "ddset" }).primaryKey(),
    singleton_key: model
      .text()
      .default(DIGITAL_DOWNLOADS_SETTINGS_KEY)
      .unique("UQ_digital_downloads_settings_singleton"),
    enabled: model.boolean().default(false),
    default_delivery_type: model
      .enum(DigitalDeliveryMode)
      .default(DigitalDeliveryMode.DOWNLOAD),
    default_download_limit: model.number().nullable(),
    default_grant_ttl_seconds: model.number().default(900),
    max_grant_ttl_seconds: model.number().default(86400),
    max_upload_size_bytes: model.bigNumber().default(5368709120),
    allow_guest_access: model.boolean().default(true),
    require_order_email_match: model.boolean().default(true),
    event_retention_days: model.number().default(365),
    /** Hash of immutable storage roots/buckets/prefixes (never credentials). */
    storage_namespace_fingerprint: model.text().nullable(),
    storage_namespace_version: model.number().default(1),
    /** Detects unsupported secret rotation without persisting either secret. */
    token_secret_fingerprint: model.text().nullable(),
    encryption_key_fingerprint: model.text().nullable(),
    show_makepay_attribution: model.boolean().default(true),
    /** Fixed plain text copied into settings for consistent admin/store rendering. */
    attribution_label: model.text().default(MAKEPAY_ATTRIBUTION_LABEL),
    /** HTTPS link only; arbitrary HTML is intentionally unsupported. */
    attribution_url: model.text().default(MAKEPAY_ATTRIBUTION_URL),
    metadata: model.json().default({}),
  })
  .checks([
    { name: "CK_digital_downloads_settings_download_limit", expression: ({ default_download_limit }) =>
      `(${default_download_limit} IS NULL OR ${default_download_limit} >= 0)` },
    { name: "CK_digital_downloads_settings_default_ttl", expression: ({ default_grant_ttl_seconds }) =>
      `${default_grant_ttl_seconds} > 0` },
    { name: "CK_digital_downloads_settings_max_ttl", expression: ({ max_grant_ttl_seconds, default_grant_ttl_seconds }) =>
      `${max_grant_ttl_seconds} >= ${default_grant_ttl_seconds}` },
    { name: "CK_digital_downloads_settings_upload_size", expression: ({ max_upload_size_bytes }) =>
      `${max_upload_size_bytes} > 0` },
    { name: "CK_digital_downloads_settings_retention", expression: ({ event_retention_days }) =>
      `${event_retention_days} > 0` },
    { name: "CK_digital_downloads_settings_storage_namespace_version", expression: ({ storage_namespace_version }) =>
      `${storage_namespace_version} > 0` },
    { name: "CK_digital_downloads_settings_attribution_label", expression: ({ attribution_label }) =>
      `${attribution_label} = 'Brought to you by MakePay.io — crypto payment gateway.'` },
    { name: "CK_digital_downloads_settings_attribution_url", expression: ({ attribution_url }) =>
      `${attribution_url} = 'https://makepay.io'` },
  ])

export default DigitalDownloadsSettings
