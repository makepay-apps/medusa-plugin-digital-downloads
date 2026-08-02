import { model } from "@medusajs/framework/utils"
import { FulfillmentOperationState } from "../types"
import DigitalEntitlement from "./digital-entitlement"

/**
 * Durable fulfillment state. Workers claim rows with a short lease and can
 * safely resume after process termination without issuing duplicate access.
 */
const FulfillmentOperation = model
  .define("fulfillment_operation", {
    id: model.id({ prefix: "dfop" }).primaryKey(),
    entitlement: model.belongsTo(() => DigitalEntitlement).nullable(),
    idempotency_key: model
      .text()
      .unique("UQ_fulfillment_operation_idempotency_key"),
    order_id: model.text(),
    order_line_item_id: model.text(),
    unit_index: model.number().default(0),
    digital_product_id: model.text(),
    digital_product_release_id: model.text().nullable(),
    state: model
      .enum(FulfillmentOperationState)
      .default(FulfillmentOperationState.PENDING),
    lease_owner: model.text().nullable(),
    lease_expires_at: model.dateTime().nullable(),
    attempt_count: model.number().default(0),
    max_attempts: model.number().default(8),
    next_retry_at: model.dateTime().nullable(),
    last_attempt_at: model.dateTime().nullable(),
    completed_at: model.dateTime().nullable(),
    canceled_at: model.dateTime().nullable(),
    error_code: model.text().nullable(),
    error_message: model.text().nullable(),
    error_details: model.json().default({}),
    payload: model.json().default({}),
    metadata: model.json().default({}),
  })
  .indexes([
    {
      name: "UQ_fulfillment_operation_order_line_unit",
      on: ["order_id", "order_line_item_id", "unit_index"],
      unique: true,
    },
    {
      name: "IDX_fulfillment_operation_claim",
      on: ["state", "next_retry_at", "lease_expires_at"],
    },
    { name: "IDX_fulfillment_operation_order", on: ["order_id"] },
  ])
  .checks([
    { name: "CK_fulfillment_operation_unit_index", expression: ({ unit_index }) => `${unit_index} >= 0` },
    { name: "CK_fulfillment_operation_attempt_count", expression: ({ attempt_count }) => `${attempt_count} >= 0` },
    { name: "CK_fulfillment_operation_max_attempts", expression: ({ max_attempts }) => `${max_attempts} > 0` },
  ])

export default FulfillmentOperation
