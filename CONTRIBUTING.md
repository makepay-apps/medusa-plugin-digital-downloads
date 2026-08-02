# Contributing

Thank you for helping improve `@makecrypto/medusa-plugin-digital-downloads`.
This repository is a Medusa v2 plugin, so changes must preserve Medusa's
product, cart, order, customer, payment, and Admin ownership boundaries.

## Prerequisites

- Node.js 20 or 22
- npm 10
- PostgreSQL 16 for module and HTTP integration tests
- A Medusa v2 application for packed-plugin or interactive Admin testing

Use npm for dependency and lockfile changes:

```bash
npm ci
```

Do not commit production credentials, customer data, download capabilities,
license keys, private object keys, or local upload contents.

## Development workflow

Create a focused branch from the current default branch, make the smallest
coherent change, and include tests and documentation with behavior changes.

The normal source checks are:

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run build
npm run pack:dry-run
```

`npm run check` runs that source-quality sequence. It does not replace the two
PostgreSQL-backed integration suites:

```bash
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/medusa_digital_downloads_test
export DB_HOST=localhost
export DB_PORT=5432
export DB_USERNAME=postgres
export DB_PASSWORD=postgres
export JWT_SECRET=local-integration-secret
export COOKIE_SECRET=local-integration-secret
export DIGITAL_DOWNLOADS_ENCRYPTION_KEY="$(openssl rand -hex 32)"

npm run test:integration:modules
npm run test:integration:http
```

Use a disposable PostgreSQL server and database. Medusa host tests read
`DATABASE_URL`; Medusa's module test runner reads the separate `DB_*` values
when it creates isolated per-suite databases. Integration tests may create,
migrate, truncate, or delete test records.

The real S3-compatible suite is opt-in. Point it at a disposable MinIO bucket:

```bash
export DIGITAL_DOWNLOADS_MINIO_ENDPOINT=http://127.0.0.1:9001
export DIGITAL_DOWNLOADS_MINIO_BUCKET=medusa-digital-downloads-test
export DIGITAL_DOWNLOADS_MINIO_ACCESS_KEY_ID=minio-test-access
export DIGITAL_DOWNLOADS_MINIO_SECRET_ACCESS_KEY=minio-test-secret
export DIGITAL_DOWNLOADS_MINIO_REGION=us-east-1

npm run test:integration:modules
```

The suite is explicitly skipped when those four required MinIO values are
absent. A skipped run is useful for ordinary contributors but is not evidence
that a storage release passed real S3-compatible integration testing.

For interactive plugin development, publish/install the package into a local
Medusa application using the Medusa plugin development flow, then run:

```bash
npm run dev
```

The command watches and republishes plugin changes through Medusa's local
plugin tooling. See the official
[Medusa plugin development guide](https://docs.medusajs.com/learn/fundamentals/plugins/create)
for the matching host-application setup.

## Design rules

- Keep Medusa Product/Variant and Order/Line Item records authoritative for
  commerce data. The plugin owns only digital releases, assets, entitlements,
  grants, and licenses.
- Treat an entitlement as durable ownership. A short-lived download grant is
  never the ownership record.
- Snapshot purchased asset versions and license terms. Catalog edits must not
  redirect an old order to different content.
- Make commerce-event handling idempotent. Duplicate events, retries, and
  concurrent workers must not issue duplicate entitlements or keys.
- Authorize from the authenticated customer or guest capability toward the
  requested resource. Never authorize from an untrusted asset ID alone.
- Keep master files private. Public previews must be explicitly classified.
- Keep raw bearer tokens out of persistence, URLs, logs, analytics, and error
  details. Store token hashes where lookup is required.
- Encrypt recoverable license material with authenticated encryption and keep
  the configured encryption key stable.
- Validate and canonicalize local paths and S3 prefixes. A user-controlled
  filename is display metadata, not a storage path.
- Use bounded pagination and redact persistence-only fields from API
  projections.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[SECURITY.md](SECURITY.md) before changing a trust boundary.

## Database changes

Update module models first, generate a migration using Medusa's migration
tooling, and inspect the SQL before committing it. A pull request that changes
models must include:

- a forward migration;
- a tested rollback or an explicit explanation of why restore-from-backup is
  required;
- clean-install and upgrade-path tests;
- documentation for any operator action or configuration dependency.

Never edit a migration that has shipped in a published package. Add a new
migration instead. See [docs/MIGRATIONS.md](docs/MIGRATIONS.md).

## API and storefront changes

When changing an HTTP contract, update route validation, safe response types,
the typed storefront client, API documentation, and authorization tests in the
same pull request. Sensitive Store responses must remain `private, no-store`.

Admin changes should use supported Medusa Admin SDK extension points and
`@medusajs/ui`. Include keyboard, loading, empty, error, and destructive-action
states. Storefront primitives should remain style-light and overridable.

## Pull requests

A pull request should state:

- the problem and intended behavior;
- affected trust boundaries or migrations;
- tests run and their results;
- screenshots for visible Admin/storefront changes;
- rollout and rollback notes when data or storage behavior changes.

Keep generated build output, local package artifacts, coverage output, test
uploads, and secrets out of commits. Maintainers may request repeated
integration runs for concurrency, event-processing, storage, or migration
changes.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow the private
reporting process in [SECURITY.md](SECURITY.md).
