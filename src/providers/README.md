# Digital fulfillment provider

`digital-fulfillment` adapts Medusa's fulfillment contract to entitlement
issuance. It reports digital-only capabilities, creates idempotent fulfillment
operations, and delegates issuance/revocation to the plugin workflows.

The provider does not ship physical items, expose protected asset locations, or
perform storage access directly. Commerce events remain the source of truth for
payment, refund, chargeback, and cancellation decisions.
