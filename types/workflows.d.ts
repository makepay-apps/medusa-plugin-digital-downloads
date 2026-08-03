import type {
  ReturnWorkflow,
  StepFunction,
} from "@medusajs/framework/workflows-sdk"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type UnknownRecord = Record<string, unknown>

export interface CreateDigitalProductWorkflowInput {
  variant_id?: string
  variantId?: string
  variant_ids?: string[]
  variantIds?: string[]
  product_id?: string
  productId?: string
  data?: UnknownRecord
  product?: UnknownRecord
  [key: string]: unknown
}

export interface UpdateDigitalProductWorkflowInput {
  id: string
  variant_ids?: string[]
  variantIds?: string[]
  product_id?: string
  productId?: string
  data?: UnknownRecord
  [key: string]: unknown
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
  [key: string]: unknown
}

export interface UpdateDigitalProductReleaseWorkflowInput {
  id: string
  asset_ids?: string[]
  assetIds?: string[]
  data?: UnknownRecord
  [key: string]: unknown
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
  expires_at?: string | null
  expiresAt?: string | null
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

export interface IssueOrderEntitlementsWorkflowOutput {
  order_id: string
  entitlements: UnknownRecord[]
  operations: UnknownRecord[]
  notification_events: UnknownRecord[]
  failures: UnknownRecord[]
  deferred: UnknownRecord[]
  skipped_line_item_ids: string[]
}

export declare const DIGITAL_DOWNLOAD_EVENTS: {
  readonly ENTITLEMENT_ISSUED: "digital_downloads.entitlement.issued"
  readonly ENTITLEMENT_REVOKED: "digital_downloads.entitlement.revoked"
  readonly ENTITLEMENT_REISSUED: "digital_downloads.entitlement.reissued"
  readonly ENTITLEMENT_EXPIRED: "digital_downloads.entitlement.expired"
  readonly FULFILLMENT_COMPLETED: "digital_downloads.fulfillment.completed"
  readonly FULFILLMENT_FAILED: "digital_downloads.fulfillment.failed"
  readonly NOTIFICATION_REQUESTED: "digital_downloads.notification.requested"
  readonly PRODUCT_CONFIG_CREATED: "digital_downloads.product.created"
  readonly PRODUCT_CONFIG_UPDATED: "digital_downloads.product.updated"
  readonly PRODUCT_CONFIG_DELETED: "digital_downloads.product.deleted"
  readonly RELEASE_CREATED: "digital_downloads.release.created"
  readonly RELEASE_UPDATED: "digital_downloads.release.updated"
  readonly RELEASE_PUBLISHED: "digital_downloads.release.published"
  readonly RELEASE_DELETED: "digital_downloads.release.deleted"
}

export type DigitalDownloadEventName =
  (typeof DIGITAL_DOWNLOAD_EVENTS)[keyof typeof DIGITAL_DOWNLOAD_EVENTS]

export declare const createDigitalProductWorkflow: ReturnWorkflow<
  CreateDigitalProductWorkflowInput,
  {
    digital_product: UnknownRecord
    product_id: string
    variant_ids: string[]
    created: boolean
  },
  []
>

export declare const updateDigitalProductWorkflow: ReturnWorkflow<
  UpdateDigitalProductWorkflowInput,
  { product_id: string; variant_ids: string[] },
  []
>

export declare const deleteDigitalProductWorkflow: ReturnWorkflow<
  DeleteDigitalProductWorkflowInput,
  { id: string; deleted: boolean },
  []
>

export declare const createDigitalProductReleaseWorkflow: ReturnWorkflow<
  CreateDigitalProductReleaseWorkflowInput,
  UnknownRecord,
  []
>

export declare const updateDigitalProductReleaseWorkflow: ReturnWorkflow<
  UpdateDigitalProductReleaseWorkflowInput,
  UnknownRecord,
  []
>

export declare const publishDigitalProductReleaseWorkflow: ReturnWorkflow<
  PublishDigitalProductReleaseWorkflowInput,
  UnknownRecord,
  []
>

export declare const deleteDigitalProductReleaseWorkflow: ReturnWorkflow<
  DeleteDigitalProductReleaseWorkflowInput,
  { id: string; deleted: boolean },
  []
>

export declare function fulfillmentStrategyReady(
  strategy: string,
  source: IssueOrderEntitlementsWorkflowInput["source"],
  order: UnknownRecord,
  force?: boolean,
): boolean

export declare function registeredCustomerId(order: UnknownRecord): string | null

export declare function aggregateRefunds(order: UnknownRecord): number

export declare function orderTotalForRefundPolicy(order: UnknownRecord): number

export declare const issueOrderEntitlementsStep: StepFunction<
  IssueOrderEntitlementsWorkflowInput & {
    line_item_ids?: string[]
    lineItemIds?: string[]
  },
  IssueOrderEntitlementsWorkflowOutput
>

export declare const issueOrderEntitlementsWorkflow: ReturnWorkflow<
  IssueOrderEntitlementsWorkflowInput,
  IssueOrderEntitlementsWorkflowOutput,
  []
>

export declare const fulfillDigitalItemsWorkflow: ReturnWorkflow<
  FulfillDigitalItemsWorkflowInput,
  IssueOrderEntitlementsWorkflowOutput,
  []
>

export declare const revokeOrderEntitlementsWorkflow: ReturnWorkflow<
  RevokeOrderEntitlementsWorkflowInput,
  {
    order_id: string
    revoked: UnknownRecord[]
    notification_events: UnknownRecord[]
    retained: boolean
    policy: RevocationPolicy
  },
  []
>

export declare const revokeEntitlementWorkflow: ReturnWorkflow<
  RevokeEntitlementWorkflowInput,
  {
    entitlement: UnknownRecord
    notification_events: Array<{ delivery_id: string }>
  },
  []
>

export declare const reissueEntitlementWorkflow: ReturnWorkflow<
  ReissueEntitlementWorkflowInput,
  {
    entitlement: UnknownRecord
    delivery?: UnknownRecord
    notification_events: Array<{ delivery_id: string }>
  },
  []
>

export declare const emitDigitalNotificationWorkflow: ReturnWorkflow<
  EmitDigitalNotificationWorkflowInput,
  {
    deliveries: UnknownRecord[]
    notification_events: Array<{ delivery_id: string }>
  },
  []
>

export declare function markNotificationFailed(
  service: unknown,
  delivery: UnknownRecord,
  error: unknown,
): Promise<void>

export declare const cleanupDigitalVariantWorkflow: ReturnWorkflow<
  CleanupDigitalVariantWorkflowInput,
  { variant_id: string; cleaned: UnknownRecord[] },
  []
>

export declare const cleanupOrphanedDigitalProductsWorkflow: ReturnWorkflow<
  CleanupOrphanedDigitalProductsWorkflowInput,
  { cleaned: UnknownRecord[]; expired_grant_ids: string[]; dry_run: boolean },
  []
>

export declare const expireEntitlementsWorkflow: ReturnWorkflow<
  ExpireEntitlementsWorkflowInput,
  {
    expired: UnknownRecord[]
    repaired: UnknownRecord[]
    notification_events: UnknownRecord[]
    as_of: string
  },
  []
>

export declare const retryDigitalOperationsWorkflow: ReturnWorkflow<
  RetryDigitalOperationsWorkflowInput,
  { claimed: UnknownRecord[]; order_ids: string[]; stale_operation_ids: string[] },
  []
>

export declare const retryNotificationDeliveriesWorkflow: ReturnWorkflow<
  RetryDigitalOperationsWorkflowInput,
  {
    claimed: UnknownRecord[]
    notification_events: UnknownRecord[]
    stale_delivery_ids: string[]
  },
  []
>
