# Commerce and notification subscribers

Subscribers translate Medusa order/payment/product events into idempotent
Digital Downloads workflows. Issuance listens to placed/completed/captured
events; refunds, chargebacks, and cancellations invoke policy-aware revocation;
product and variant deletion retire associated digital configuration.

`digital-notification-requested` claims a delivery transactionally before
calling the host notification module. Duplicate or stale events are safe
no-ops, expired leases are recoverable, and attempt limits are enforced in the
database service.
