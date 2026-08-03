# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-08-03

### Added

- Added the order-scoped `DigitalOrderDownloads` storefront component and
  copy-ready Medusa starter integrations for customer libraries, order details,
  guest recovery, protected files, streams, and explicit license reveal.
- Added a copy-ready SMTP notification-provider renderer for delivery,
  revocation, reissue, and expiration messages, including safe registered-order
  deep links and fragment-based guest recovery links.
- Added real packed-fixture customer, order-history, license, download, and
  delivery-email browser surfaces for release screenshots and end-to-end checks.

### Changed

- Separated durable guest purchase-access lifetime from short-lived asset grant
  lifetime with a bounded, persisted 30-day default and forward migration.
- Made post-purchase notification delivery, retry reconciliation, repeated
  reissues, and guest capability handoff deterministic and fail-closed.
- Added an internal entitlement generation fence for guest recovery: reissue
  advances it atomically, while stale notification attempts revoke their
  capability and cancel/redact their delivery state before they can reactivate.
- Preserved friendly Medusa order display IDs in entitlement snapshots and
  allowed zero-asset license releases only when an enabled generated or pooled
  license policy can fulfill them.
- Expanded Admin readiness, Store API, OpenAPI, configuration, migration,
  storefront, testing, architecture, and release documentation.
- Allowed an explicit internal digital-product handle so repeatable imports can
  keep stable customer-facing titles without handle collisions.

### Fixed

- Kept the resolved `guestAccessTtlSeconds` module option as a hard ceiling for
  persisted settings and explicit session TTLs, including upgraded databases
  whose migration initially seeds the 30-day default.
- Fixed partial entitlement hydration that could dead-letter valid delivery
  emails, and prevented duplicate provider sends after checkpoint failures.
- Fixed upgrades from pre-v0.4 databases so guest capabilities can remain
  unusable until their delivery provider succeeds.
- Propagated the configured Medusa publishable key into protected-byte grant
  requests so the built-in browser download and stream actions pass the Store
  API boundary.
- Prevented discarded active guest capabilities during issuance/reissue and
  removed the natural-key constraint that incorrectly blocked later reissue
  notifications for the same entitlement.
- Rejected unsupported existing-customer publication notifications instead of
  silently accepting an unimplemented update-policy operation.
- Renewed expired entitlements from their recorded purchase term on reissue,
  and assigned a distinct retryable notification idempotency key to every
  later expiration cycle while preserving legacy cycle rows.
- Serialized fulfillment and revocation on one order lock and made each
  order-wide revoke/refund, capability/license invalidation, and notification
  outbox batch atomic, including repair-safe single Admin revocation.
- Added bounded hourly repair for missing expired/revoked/refunded lifecycle
  outboxes, with stable cutoffs, under-lock stale-status/deadline guards,
  legacy-recipient sanitization, and soft-delete/current-cycle reconciliation.
- Serialized license lifecycle writes in entitlement-to-assignment order,
  rejected crossed guest capabilities before acquiring a foreign entitlement
  graph, and revalidated capabilities after locking the matching graph.
- Made entitlement reissue rotate even an active license assignment, refresh
  its expiry, and deactivate prior devices before assigning the replacement
  key.

## [0.3.2] - 2026-08-02

### Changed

- Made consumer installation examples version-neutral so they follow npm's
  current `latest` release while production deployments can remain locked or
  explicitly pinned.
- Added real Medusa Admin screenshots for the Digital Downloads overview,
  product configuration, native product and order widgets, and settings.
- Made release-maintainer examples reusable across future versions and
  synchronized package, API, OpenAPI, and packed-fixture metadata for `0.3.2`.

## [0.3.1] - 2026-08-02

### Changed

- Removed pre-release status language from the public README and clarified the
  architecture, installation, and product-roadmap wording.
- Synchronized package, API, OpenAPI, test-fixture, and release-documentation
  metadata for the `0.3.1` patch release.
- Changed npm publication to use the already checked and attested release
  tarball, keeping the npm and GitHub package artifacts byte-identical.

## [0.3.0] - 2026-08-02

### Added

- Initial Medusa v2 digital-products plugin with protected file delivery,
  entitlements, software-license lifecycle management, native Admin extensions,
  storefront primitives, local/S3-compatible storage, and full test tooling.
- Immutable releases, resumable uploads, previews, byte-range streaming,
  revocation/refund handling, download limits, guest sessions, license
  activation limits, audit trails, reconciliation, and bounded retry queues.
- Hardened product configuration, topology-safe Admin diagnostics, fail-closed
  guest-notification capability cleanup, and an explicit packed export surface.
- Reproducible release packaging with checksums, CycloneDX SBOMs, provenance
  attestations, PostgreSQL/MinIO integration coverage, and local/S3 lifecycle
  simulations.
- A forward-compatible settings migration normalizes the exact MakePay
  attribution constraint for databases created by early v1 development builds.
