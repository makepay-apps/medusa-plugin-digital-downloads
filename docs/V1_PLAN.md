# Version 1.0 delivery plan

## Product goal

`@makecrypto/medusa-plugin-digital-downloads` makes digital goods feel like a
native Medusa product capability. A merchant continues to use Medusa products,
variants, pricing, sales channels, orders, customers, payments, notifications,
and the Admin dashboard. The plugin adds the digital-specific concepts that
Medusa does not provide: protected assets, releases, purchase entitlements,
download grants, license keys, activations, and a customer library.

The plugin is payment-provider agnostic and works with MakePay's Medusa payment
provider without coupling fulfillment to MakePay-specific data. Version 1 is
developed and host-tested against Medusa v2.18 and declares the supported
runtime range `>=2.18 <3`.

## Definition of done

Version 1.0 is complete only when all of the following are true:

1. The package installs as a standard Medusa plugin and migrations run on a
   clean PostgreSQL database.
2. A merchant can attach a digital configuration to a product variant from the
   Medusa Admin, upload private files, publish a release, configure delivery and
   license rules, and inspect fulfillment on an order.
3. A customer or guest can complete a normal Medusa checkout and receive an
   idempotent entitlement for every purchased digital line and quantity.
4. Access checks always bind an asset or license to the authenticated customer
   or a valid guest capability, a non-revoked entitlement, and the purchased
   release snapshot.
5. Local protected storage and private S3-compatible storage both work. A
   private object is never exposed as a permanent public URL.
6. Downloads support expiry, limits, revocation, optional first-IP binding,
   checksums, safe filenames, and single byte ranges for seekable media.
7. Generated and imported software licenses support secure recovery, expiry,
   activation limits, activation/deactivation/heartbeat, and audit history.
8. Mixed physical/digital carts, guest and registered buyers, free orders,
   quantity greater than one, retries, duplicate events, cancellation, refund,
   deleted catalog records, and expired access are covered by tests.
9. Admin routes/widgets, a typed storefront client, accessible React UI
   primitives, a Next.js starter example, and an OpenAPI 3.1 document ship in
   the package.
10. Lint, strict type checking, unit tests, PostgreSQL module/API integration
    tests, plugin build, package-content validation, clean-install validation,
    and real-browser scenarios pass in repeated runs.

## Scope and feature backlog

### P0 — release-blocking commerce capabilities

- One digital configuration per Medusa product variant, while preserving the
  standard Product and Variant records as the merchant-facing source of truth.
- Mixed physical and digital orders without replacing Medusa's cart completion
  endpoint or forcing a MakePay-only checkout.
- Multiple protected and preview assets per product release.
- Product types: generic file/archive, PDF or ebook, audio, video, photo or art,
  and software license.
- Delivery modes: download, protected stream, license only, or content plus a
  license (`mixed`).
- Draft, published, superseded, and retired releases; immutable fulfillment
  snapshots so later catalog edits cannot redirect an old purchase.
- Protected local filesystem storage and private S3/S3-compatible storage,
  including AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, and Supabase's S3
  endpoint when configured with compatible credentials.
- Admin upload, server-side filename normalization, declared and detected MIME
  metadata, byte size, SHA-256 checksum, sort order, label, version, and preview
  classification.
- Idempotent entitlement issuance for registered customers and guest email
  purchases. An order event may be delivered more than once without producing
  duplicate ownership or license keys.
- Entitlement lifecycle: pending, active, suspended, expired, refunded, revoked.
- Per-product or store-default download count, grant lifetime, entitlement
  lifetime, streaming policy, first-IP lock, and refund/cancellation behavior.
- Opaque, short-lived, asset-bound download grants. Stored data contains only a
  hash of a live bearer token.
- Generated license patterns and imported license pools, encrypted recoverable
  values, normalized lookup hashes, per-purchase assignments, expiration,
  activation limits, and lifecycle controls.
- Customer-authenticated library and guest-capability access with safe
  projections and `Cache-Control: private, no-store` on secret-bearing replies.
- Product detail and order detail Admin widgets plus complete Digital Downloads
  list, detail, create/edit, entitlement, license-pool, and settings pages.
- A restrained, accessible “Brought to you by MakePay.io — crypto payment
  gateway.” attribution in the plugin Admin and supplied storefront UI, using a
  fixed safe `https://makepay.io` destination and never altering checkout.

### P1 — production operations and customer experience

- Preview metadata and public preview retrieval without exposing master assets.
- Audio/video single-range streaming and standards-compliant `206`,
  `Content-Range`, `Accept-Ranges`, and unsatisfiable-range behavior.
- Protected content is `GET`-only in version 1. A future `HEAD` route must have
  explicit grant authorization and non-consuming semantics; it must not rely
  on an implicit Express fallback that could reserve or count a download.
- Typed storefront client with pluggable `fetch`, publishable-key support,
  customer bearer/session support, guest capability support, and normalized
  errors.
- Accessible Digital Library, Product Preview, Download Action, License Reveal,
  and License Activation React primitives with loading, empty, error, revoked,
  expired, and limit-reached states.
- Next.js Medusa starter integration showing product previews and an account
  library without replacing core checkout code.
- Optional Notification Module delivery driven by plugin events and merchant
  template identifiers. Email failure never rolls back ownership and is visible
  for retry.
- Admin filters, search, stable pagination, status totals, bulk revoke/reactivate,
  resend/reissue, license-pool capacity, and storage-health indicators.
- Scheduled cleanup of expired one-time grants, stale upload reservations,
  bounded audit data, and orphaned unreferenced files after a safety delay.
- OpenAPI 3.1 contracts and copy-ready environment/configuration examples.

### P2 — included where safe and testable

- Download and license audit exports without bearer tokens, decrypted keys,
  full IP addresses, storage credentials, or private object keys.
- Optimistic or lock-backed allocation so concurrent license issuance and
  activation cannot exceed inventory or activation limits.
- Admin manual entitlement issuance for support cases with an explicit actor,
  reason, and audit event.
- Entitlement update policy allowing access to the purchased release only or to
  newer published releases within an optional update window.
- Idempotency keys for mutation APIs in addition to workflow-level natural keys.
- Storage verification that confirms an uploaded asset exists and matches the
  persisted size/checksum before publication.

### Explicit v1 non-goals

- DRM. Protected streaming reduces casual sharing but cannot prevent recording.
- Arbitrary remote origin URLs. They require a complete SSRF, redirect, DNS
  rebinding, proxy, authentication-header, and availability threat model. Local
  and S3-compatible storage cover the requested v1 storage scope safely.
- A second catalog, cart, checkout, price engine, customer account system, or
  payment page. Medusa remains responsible for all core commerce behavior.
- Editing Medusa's built-in Admin layout. The plugin uses supported routes,
  widgets, Medusa UI, and Admin SDK injection zones.
- Permanent plaintext storage of license keys, guest access secrets, download
  bearer tokens, storage secrets, or full client IP addresses.

## Work breakdown

### Phase 1 — comparative analysis

- Audit the existing MakePay provider's packaging and Medusa compatibility.
- Inventory BTCPay Digital Products features, security invariants, migrations,
  operations, UX, tests, and known architectural limitations.
- Use the official Medusa digital-products recipe as a starting reference, not
  as a production implementation: remove its custom cart-completion override,
  make delivery idempotent, snapshot purchased terms, and add revocation.
- Pin implementation decisions to current official Medusa plugin, module, File
  Module, Admin extension, workflow, and test documentation.

### Phase 2 — architecture and contracts

- Finalize model names, natural idempotency keys, indexes, and link directions.
- Define workflow inputs/outputs/compensation and event payload schemas.
- Define safe Admin and Store projections independently of persistence models.
- Define plugin options, database-managed settings, secret precedence, and
  storage-driver interfaces.
- Threat-model every route that returns or accepts a capability or license.

### Phase 3 — repository foundation

- Scaffold with `create-medusa-app@2.18.0 --plugin`.
- Add package exports, npm metadata, lint/type/test/build/package gates, Node
  20/22 CI, PostgreSQL CI, release-tag validation, changelog, security policy,
  architecture, configuration, API, storefront, and testing documentation.

### Phase 4 — module and database

- Implement models and relations inside the Digital Downloads module.
- Generate and inspect MikroORM migrations and snapshots.
- Exercise up/down/clean migration behavior on PostgreSQL.
- Add indexes for variant lookup, order-line idempotency, entitlement library,
  token hashes, license hashes, release publication, and audit pagination.

### Phase 5 — storage and cryptography

- Implement a common protected-storage interface with local and S3 drivers.
- Validate configuration at startup; keep local roots out of web-static paths.
- Use CSPRNG bearer secrets, SHA-256 lookup hashes, timing-safe comparisons, and
  AES-256-GCM envelopes for data that must be recovered.
- Verify file boundaries, canonical paths, S3 prefixes, checksums, content type,
  byte ranges, response headers, and deletion safety.

### Phase 6 — workflows and lifecycle

- Product/release/asset creation, publication, retirement, and deletion.
- Entitlement issuance keyed by order and line item; license assignment keyed by
  entitlement and unit index.
- Cancellation/refund/revoke/reactivate and manual support flows.
- Download grant creation/consumption and license activation transactions.
- Event emission, notifications, retry state, and scheduled cleanup.

### Phase 7 — HTTP APIs

- Admin CRUD, uploads, publication, entitlements, licenses, audit, settings,
  storage health, manual support actions, and pagination.
- Store previews, authenticated library, guest library, entitlement detail,
  download/stream grant and content delivery, license reveal, validate, activate,
  deactivate, and heartbeat.
- Zod validation, actor checks, rate limiting, no-store headers, error mapping,
  safe projections, idempotency, range parsing, and OpenAPI coverage.

### Phase 8 — Admin and storefront

- Medusa UI routes, product/order widgets, form validation, tables, filters,
  upload progress, license capacity, destructive-action confirmations, and i18n.
- Typed client, React primitives, and Next.js integration.
- Keyboard, focus, label, status, loading, empty, error, responsive, and dark-mode
  checks.

### Phase 9 — verification rounds

1. Pure unit tests for parsing, validation, tokens, encryption, patterns,
   projections, limits, ranges, filenames, paths, and edge cases.
2. Service/module integration tests with a real PostgreSQL database.
3. HTTP integration tests covering authentication, authorization, persistence,
   range delivery, no-store behavior, and idempotency.
4. Packed-plugin install into a clean Medusa application, migrations, seed data,
   local storage, and a MinIO S3-compatible test.
5. Real-browser merchant and customer flows against Admin and storefront.
6. Adversarial cases: cross-customer IDs, forged guest tokens, altered asset IDs,
   traversal names, malformed ranges, reused grants, revoked access, expired
   access, duplicate events, concurrent activations, and missing storage objects.
7. Clean checkout plus MakePay provider simulation, free order, guest order,
   registered order, mixed cart, quantity, cancellation, partial/full refund,
   catalog deletion, and re-published releases.
8. Re-run lint/type/build/test/package, dependency audit, security scan, clean
   install, and regression suites after all fixes.

### Phase 10 — 1.0 release

- Synchronize package, changelog, docs, git tag, and GitHub release versions.
- Require green Node and PostgreSQL checks and a conflict-free release PR.
- Inspect the packed tarball; install it into a clean fixture from the tarball.
- Merge the verified PR to `main`, tag `v0.3.0`, create the GitHub release, and
  publish to npm when the repository's `NPM_TOKEN` permission is available.

## Acceptance scenarios

The automated and manual test ledger must include at least:

- One variant with two protected files and one public preview.
- PDF preview plus protected ebook download.
- Seekable audio and video with valid, suffix, open-ended, malformed, and
  unsatisfiable byte ranges.
- Photo preview metadata with a protected original.
- Generated-license product with two purchased units and two distinct keys.
- Imported-license pool exhaustion and safe rollback.
- Concurrent attempts to claim the final pool key.
- Activation limit reached, deactivate then reactivate, expired, suspended, and
  revoked license responses.
- Customer A attempting every Customer B entitlement, asset, grant, and license
  identifier.
- Guest token creation, use, rotation/reissue, expiry, revocation, and leakage
  checks in logs, URLs, caches, and API projections.
- Download limit zero/unlimited, one, and many; a range continuation must not
  consume a second entitlement download unexpectedly.
- Duplicate `order.placed`, retry after a mid-workflow failure, and two workers
  processing the same order.
- Full and partial cancellation/refund policies.
- Product edits and deletion after purchase; the original purchase remains
  understandable and never points at a different file.
- Local and S3 upload, retrieve, range, missing object, checksum mismatch,
  invalid credentials, and cleanup failure.
- Admin loading/empty/error/pagination/filter/bulk flows and storefront
  loading/empty/error/expired/revoked/limit-reached flows at desktop and mobile.
