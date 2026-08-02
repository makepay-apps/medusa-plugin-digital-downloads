export const DIGITAL_DOWNLOAD_EVENTS = {
  ENTITLEMENT_ISSUED: "digital_downloads.entitlement.issued",
  ENTITLEMENT_REVOKED: "digital_downloads.entitlement.revoked",
  ENTITLEMENT_REISSUED: "digital_downloads.entitlement.reissued",
  ENTITLEMENT_EXPIRED: "digital_downloads.entitlement.expired",
  FULFILLMENT_COMPLETED: "digital_downloads.fulfillment.completed",
  FULFILLMENT_FAILED: "digital_downloads.fulfillment.failed",
  NOTIFICATION_REQUESTED: "digital_downloads.notification.requested",
  PRODUCT_CONFIG_CREATED: "digital_downloads.product.created",
  PRODUCT_CONFIG_UPDATED: "digital_downloads.product.updated",
  PRODUCT_CONFIG_DELETED: "digital_downloads.product.deleted",
  RELEASE_CREATED: "digital_downloads.release.created",
  RELEASE_UPDATED: "digital_downloads.release.updated",
  RELEASE_PUBLISHED: "digital_downloads.release.published",
  RELEASE_DELETED: "digital_downloads.release.deleted",
} as const

export type DigitalDownloadEventName =
  (typeof DIGITAL_DOWNLOAD_EVENTS)[keyof typeof DIGITAL_DOWNLOAD_EVENTS]
