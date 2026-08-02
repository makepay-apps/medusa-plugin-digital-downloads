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
migration-backed persistence.

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

### Browser E2E

Playwright drives a real Medusa Admin and Next.js storefront:

- merchant login, digital variant setup, upload, release publication, license
  configuration, order inspection, revoke/reissue, and settings;
- customer registration/login, product preview, checkout, account library,
  download/stream, key reveal, activation, and error states;
- guest checkout and capability-based purchase access;
- desktop and mobile viewport, keyboard access, screenshots, and browser trace
  on failure.

## Required commands

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration:modules
npm run test:integration:http
npm run build
npm run pack:dry-run
```

PostgreSQL integration tests must fail with a clear prerequisite message when
the database is unavailable. They must never silently skip while reporting a
green integration suite.

## Repetition and release gate

The complete unit/integration/build/package suite runs at least twice after the
last functional fix. Stateful E2E scenarios reset to a known seed between
rounds. The release is blocked by flakes, unreviewed snapshots, test-only skips,
TypeScript errors, lint errors, package warnings, migration drift, audit findings,
or a mismatch among package version, changelog, tag, and release artifact.
