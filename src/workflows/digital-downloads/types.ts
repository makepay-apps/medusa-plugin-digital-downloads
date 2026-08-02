export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type UnknownRecord = Record<string, any>

export interface CreateDigitalProductWorkflowInput {
  variant_id?: string
  variantId?: string
  variant_ids?: string[]
  variantIds?: string[]
  product_id?: string
  productId?: string
  data?: UnknownRecord
  product?: UnknownRecord
  [key: string]: any
}

export interface UpdateDigitalProductWorkflowInput {
  id: string
  variant_ids?: string[]
  variantIds?: string[]
  product_id?: string
  productId?: string
  data?: UnknownRecord
  [key: string]: any
}

export interface DeleteDigitalProductWorkflowInput {
  id: string
}

export interface CreateDigitalProductReleaseWorkflowInput {
  digital_product_id?: string
  digitalProductId?: string
  asset_ids?: string[]
  assetIds?: string[]
  data?: UnknownRecord
  release?: UnknownRecord
  [key: string]: any
}

export interface UpdateDigitalProductReleaseWorkflowInput {
  id: string
  asset_ids?: string[]
  assetIds?: string[]
  data?: UnknownRecord
  [key: string]: any
}

export interface DeleteDigitalProductReleaseWorkflowInput {
  id: string
}

export interface PublishDigitalProductReleaseWorkflowInput {
  id: string
  make_active?: boolean
  makeActive?: boolean
  notify_existing_customers?: boolean
  notifyExistingCustomers?: boolean
}

export interface IssueOrderEntitlementsWorkflowInput {
  order_id?: string
  orderId?: string
  force?: boolean
  source?:
    | "order.placed"
    | "order.completed"
    | "payment.captured"
    | "reconciliation"
    | "manual"
}

export type RevocationPolicy =
  | "retain"
  | "any_refund"
  | "full_refund"
  | "refunded_items"
  | "all"

export interface RevokeOrderEntitlementsWorkflowInput {
  order_id?: string
  orderId?: string
  payment_id?: string
  paymentId?: string
  line_item_ids?: string[]
  lineItemIds?: string[]
  reason: string
  policy?: RevocationPolicy
  trigger?: "refund" | "cancellation" | "chargeback" | "manual"
  refunded_amount?: number | string
}

export interface RevokeEntitlementWorkflowInput {
  entitlement_id?: string
  entitlementId?: string
  reason: string
  actor?: string
  invalidate_sessions?: boolean
  invalidateSessions?: boolean
  notify?: boolean
}

export interface ReissueEntitlementWorkflowInput {
  entitlement_id?: string
  entitlementId?: string
  reason?: string
  reset_downloads?: boolean
  resetDownloads?: boolean
  rotate_guest_token?: boolean
  rotateGuestToken?: boolean
  notify?: boolean
}

export interface FulfillDigitalItemsWorkflowInput {
  order_id?: string
  orderId?: string
  line_item_ids?: string[]
  lineItemIds?: string[]
  force?: boolean
}

export type DigitalNotificationType =
  | "delivery"
  | "revoked"
  | "reissued"
  | "expired"
  | "fulfillment_failed"

export interface EmitDigitalNotificationWorkflowInput {
  entitlement_id?: string
  entitlementId?: string
  order_id?: string
  orderId?: string
  type: DigitalNotificationType
  to?: string
  data?: UnknownRecord
}

export interface CleanupDigitalVariantWorkflowInput {
  variant_id?: string
  variantId?: string
}

export interface CleanupOrphanedDigitalProductsWorkflowInput {
  limit?: number
  dry_run?: boolean
}

export interface ExpireEntitlementsWorkflowInput {
  as_of?: string
  limit?: number
}

export interface RetryDigitalOperationsWorkflowInput {
  as_of?: string
  limit?: number
  operation_ids?: string[]
}
