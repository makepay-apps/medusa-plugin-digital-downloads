import { model } from "@medusajs/framework/utils"
import {
  NotificationChannel,
  NotificationDeliveryState,
} from "../types"
import DigitalEntitlement from "./digital-entitlement"

/** Durable, privacy-minimized notification outbox row. */
const NotificationDelivery = model
  .define("notification_delivery", {
    id: model.id({ prefix: "dnotif" }).primaryKey(),
    entitlement: model.belongsTo(() => DigitalEntitlement),
    idempotency_key: model
      .text()
      .unique("UQ_notification_delivery_idempotency_key"),
    channel: model.enum(NotificationChannel).default(NotificationChannel.EMAIL),
    template: model.text(),
    /** Keyed digest of the destination; no raw address is persisted here. */
    recipient_hash: model.text(),
    state: model
      .enum(NotificationDeliveryState)
      .default(NotificationDeliveryState.PENDING),
    attempt_count: model.number().default(0),
    max_attempts: model.number().default(8),
    next_retry_at: model.dateTime().nullable(),
    last_attempt_at: model.dateTime().nullable(),
    lease_owner: model.text().nullable(),
    lease_expires_at: model.dateTime().nullable(),
    sent_at: model.dateTime().nullable(),
    canceled_at: model.dateTime().nullable(),
    provider_message_id: model.text().nullable(),
    error_code: model.text().nullable(),
    error_message: model.text().nullable(),
    /** Template data must not contain bearer tokens or plaintext license keys. */
    payload: model.json().default({}),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "IDX_notification_delivery_natural_lookup",
      on: ["entitlement_id", "template", "recipient_hash"],
    },
    {
      name: "IDX_notification_delivery_claim",
      on: ["state", "next_retry_at", "lease_expires_at"],
    },
  ])
  .checks([
    { name: "CK_notification_delivery_attempt_count", expression: ({ attempt_count }) => `${attempt_count} >= 0` },
    { name: "CK_notification_delivery_max_attempts", expression: ({ max_attempts }) => `${max_attempts} > 0` },
  ])

export default NotificationDelivery
