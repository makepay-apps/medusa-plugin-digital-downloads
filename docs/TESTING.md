# Testing strategy

## Test layers

### Unit

Unit tests isolate deterministic policy and security behavior:

- option/settings validation and default resolution;
- filename, MIME, size, checksum, path, S3 key, and byte-range handling;
- local/S3 Node `Readable` full/range delivery, exact-length enforcement,
  abort cleanup, sanitized late provider errors, and bounded-memory behavior
  with a 256 MiB sparse local object;
- token generation/hash/encryption/decryption/rotation and timing-safe checks;
- license patterns, normalized hashes, pool selection, validity, activation
  limits, signatures, timestamps, nonces, and audit bounds;
- entitlement state transitions, limits, release/update access, refund policy,
  idempotency keys, snapshots, and safe response projections;
- Admin/store query normalization and storefront client error behavior.

### Module integration

`@medusajs/test-utils` runs the Digital Downloads module against PostgreSQL to
exercise generated repositories, relations, unique/index constraints,
transactions, concurrent license allocation/activation, soft deletion, and
migration-backed persistence. A forced PostgreSQL lock interleaving proves that
revocation cannot miss a racing activation, and assignment-reuse coverage proves
that rotated keys cannot inherit stale active devices.

### HTTP integration

A Medusa test application installs the plugin and exercises Admin/Store routes,
auth middleware, Query links, workflows, duplicate events, upload/download,
ranges, streaming disconnect/failure accounting, no-store headers,
cross-customer access, guest capabilities, revocation, and error mapping.

### Packed-plugin integration

The built npm tarball is installed into a clean Medusa v2 application. The test
runs migrations, seed data, Admin build, server build, and a smoke purchase. It
catches missing package exports/files and dependency-resolution differences
that source tests cannot detect.

### Retained packed-fixture browser verification

Browser automation runs against the same built tarball after the packed Medusa
and Next.js fixture is retained with `--keep-running`. The fixture exposes only
sanitized browser URLs and public IDs in its result receipt; customer
credentials remain in its private runtime files, and raw guest capabilities,
content grants, and license keys are not written to the public receipt.

The browser release gate must:

- authenticate the seeded customer against Medusa's live email/password Store
  API from the packaged storefront fixture;
- render the account-wide library and order-scoped
  `DigitalOrderDownloads` view for the seeded order;
- request and complete one protected download, exercise one protected stream,
  and verify the transferred fixture bytes;
- reveal a disposable fixture license only after the explicit buyer action and
  confirm it was absent from the initial HTML and URLs;
- open the sanitized customer delivery-email preview produced through the
  configured fixture Notification Module provider;
- capture the documented desktop screenshots and perform a mobile viewport and
  keyboard/focus smoke check.

The lifecycle runner remains responsible for the deeper HTTP/storage ledger:
cross-customer isolation, guest capability exchange/revocation, download limits,
byte-range continuation, concurrency, refund/cancellation, notification retry,
and local/S3 parity. Module regressions additionally failure-inject a multi-row
refund outbox insert to prove the whole order rolls back, then retry it to prove
exactly-once repair, and run expire/reissue/expire to prove distinct cycle keys.
They also repair no-cycle expired/revoked/refunded legacy rows, inject a failed
repair outbox write, verify soft-deleted and older-cycle selection, exercise
parallel replay, and prove a stale expiry scan cannot revoke renewed access.
License regressions also force assignment reuse and active reissue through key
rotation, verify refreshed expiry and device cleanup, and submit crossed guest
assignment/token requests concurrently to prove they are rejected before either
entitlement graph is locked.
A successful page render alone is not an E2E pass.

## Required commands

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:e2e-harness
npm run test:integration:modules
npm run test:integration:http
npm run build
npm run test:packed-types
npm run pack:dry-run
```

Then install and exercise the exact candidate tarball as a consumer. Use a
marked disposable fixture; these commands never target the long-running Medusa
installation on port 9000:

```bash
export E2E_FIXTURE_ROOT=/absolute/path/to/marked-disposable-fixture
export TARBALL=/absolute/path/to/candidate-package.tgz

scripts/e2e/run-packed-e2e.sh \
  --tarball "$TARBALL" \
  --storage local \
  --keep-running

# Run the browser gates against the retained :8000/:9100 fixture, then stop it
# using the exact private run directory printed by the command above.

scripts/e2e/run-packed-e2e.sh \
  --tarball "$TARBALL" \
  --storage s3
```

The local retained run must produce a passed lifecycle receipt, browser-ready
customer/order/email routes, and a sent fixture delivery notification before
screenshots are accepted. The S3 run must pass the same commerce and storefront
consumer assertions against private MinIO storage.

PostgreSQL integration tests must fail with a clear prerequisite message when
the database is unavailable. They must never silently skip while reporting a
green integration suite.

## Repetition and release gate

The complete unit/integration/build/package suite runs at least twice after the
last functional fix. Stateful E2E scenarios reset to a known seed between
rounds. The release is blocked by flakes, unreviewed snapshots, test-only skips,
TypeScript errors, lint errors, package warnings, migration drift, audit findings,
or a mismatch among package version, changelog, tag, and release artifact.
