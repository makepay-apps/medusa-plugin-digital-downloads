# Digital Downloads workflows

The exported Medusa workflows are grouped by responsibility:

- product workflows manage product configurations, releases, assets, uploads,
  license policies, and publication;
- fulfillment workflows issue quantity-aware customer or guest entitlements;
- revocation workflows apply refund, chargeback, cancellation, and manual
  revocation policy;
- maintenance workflows expire entitlements, reconcile missing terminal
  lifecycle outboxes, retry bounded work, and clean
  orphaned state.

Steps use deterministic idempotency keys and compensation where an external
side effect can be reversed. Domain events are declared in `events.ts` and are
the only supported notification integration surface.
