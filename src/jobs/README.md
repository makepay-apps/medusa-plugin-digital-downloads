# Digital Downloads scheduled jobs

The plugin registers four Medusa jobs:

- `retry-digital-notifications` claims at most 10 due deliveries every two
  minutes and processes them sequentially under per-delivery locks.
- `retry-digital-fulfillment` retries recoverable fulfillment operations every
  five minutes.
- `expire-digital-entitlements` expires due entitlements hourly.
- `cleanup-digital-orphans` retires abandoned uploads and grants daily.

Every job uses deterministic run identifiers, bounded batches, idempotent
workflows, and `concurrency: "forbid"`. Jobs must never load protected object
bytes or secret values into logs.
