# Database migrations

The plugin's data models live in an isolated Medusa module and use the host
application's PostgreSQL database. Medusa discovers the packaged module
migrations after the plugin is installed and registered.

This guide covers operator workflow. The migration files shipped in the
installed package are the source of truth for the exact SQL and module name.

## Version 1 schema inventory

The version 1 source baseline is generated in
`Migration20260731221936.ts`, alongside
`.snapshot-medusa-digital-downloads.json`; the npm package contains its compiled
migration output. It creates these 16 module tables:

- catalog and storage: `digital_product`, `digital_product_release`,
  `digital_asset`, and `digital_upload`;
- ownership and delivery: `digital_entitlement`, `download_grant`,
  `download_event`, and `entitlement_access_session`;
- fulfillment operations: `fulfillment_operation` and
  `notification_delivery`;
- licensing: `license_policy`, `license_pool_key`, `license_assignment`,
  `license_activation`, and `license_audit_event`;
- module configuration: `digital_downloads_settings`.

`Migration20260801114300.ts` is a non-destructive compatibility migration for
persistent databases that ran an early v1 development build. It replaces the
historic attribution-label check constraint, normalizes the fixed MakePay label
to its released text (including the final period), and aligns the column
default. Fresh installations apply it after the schema baseline as well, so
fresh and upgraded v1 databases have the same constraint contract.
Its `down` path restores the early development punctuation and is intended only
for disposable preview databases used with the matching older package; current
v1 workers must not run against the downgraded constraint.

`Migration20260803090000.ts` is the non-destructive version 0.4 settings
migration. It adds the required `guest_access_ttl_seconds` column with a
2,592,000-second (30-day) default and a database constraint permitting values
from 86,400 through 31,536,000 seconds (1 through 365 days). Existing settings
rows receive the default. The setting controls newly issued guest
purchase-recovery capabilities; it is independent of short-lived asset/content
grants and does not rewrite already-issued access-session expirations. The same
migration replaces the notification outbox's unique entitlement/template/
recipient index with a non-unique lookup index so separately idempotent reissue
and revocation lifecycle messages can coexist. The unique `idempotency_key`
index remains authoritative. Its `down` path can recreate the older natural-key
uniqueness only when no two live rows share the same `entitlement_id`,
`template`, and `recipient_hash`, so use that inverse only on disposable preview
data. Before changing any schema, the rollback checks that prerequisite and
stops with this deterministic diagnostic when reconciliation is required:

```text
Migration20260803090000 rollback blocked: duplicate live notification_delivery rows share (entitlement_id, template, recipient_hash).
```

The cycle-aware expiration/reissue and atomic revocation behavior requires no
additional columns or data rewrite. Existing `:expired:v1` and `:revoked:v1`
outbox rows remain valid for their original cycle. Apply this migration before
starting upgraded workers so later lifecycle cycles can create independent rows.

Stop notification writers and run the following query. The rollback
prerequisite is that it returns zero rows:

```sql
select
  "entitlement_id",
  "template",
  "recipient_hash",
  count(*) as "live_row_count"
from "notification_delivery"
where "deleted_at" is null
group by "entitlement_id", "template", "recipient_hash"
having count(*) > 1
order by "entitlement_id", "template", "recipient_hash";
```

If the query returns rows, review each independently idempotent lifecycle
delivery and choose the one row that can remain live under the old schema.
Reconcile superseded rows with an audited soft-delete (`deleted_at`) operation
so their notification history remains stored; do not hard-delete records. Retry
the rollback only after the query returns no rows. Restoring the pre-migration
backup is the preferred production rollback when that semantic reconciliation
is not appropriate.

`Migration20260803183000.ts` completes the version 0.4 guest-delivery upgrade
path. It extends an existing installation's access-session status constraint
with the fail-closed `pending` state used while an email provider is processing
a guest capability. Fresh databases already receive the same status domain
from the initial schema. Its rollback revokes any still-pending capability
before restoring the older constraint.

`Migration20260803200000.ts` adds the internal, non-negative
`digital_entitlement.guest_access_epoch` generation fence. Existing entitlement
rows are assigned the legacy generation `0`; new rows also default to `0`.
Guest-token reissue advances the value atomically with entitlement rotation so
an in-flight notification from an older generation cannot activate its stale
capability. Such an attempt's access session is revoked immediately; the
delivery is canceled after provider-data redaction succeeds. Redaction failures
remain cleanup-only retries and can dead-letter without restoring capability
access. The epoch is orchestration state only and is deliberately omitted from
the notification-provider payload.
The migration's `down` path removes the constraint and column, so it must not be
used while version 0.4 workers still rely on generation fencing.

The entitlement-to-release foreign key is required and uses `NO ACTION` on
delete; an asset or unfinished upload may have no release yet. The generated
`down` method drops all 16 tables and is therefore destructive. It exists for
disposable development databases, not as the preferred production rollback.

## Before the first migration

1. Install a plugin version compatible with the host application's Medusa v2
   version.
2. Register the plugin in `medusa-config.ts` with valid options.
3. Confirm the application can read `DATABASE_URL` and the plugin's encryption
   and storage configuration.
4. Back up PostgreSQL before running migrations in a persistent environment.
5. Snapshot storage configuration and, where practical, the protected local or
   S3 prefix. Database backups do not contain protected file bytes.

The encryption key is not database schema. Preserve it separately in the
deployment secret manager; losing it can make existing encrypted license
material unrecoverable.

## Apply migrations

Run migration commands from the Medusa host application, not from the installed
package directory:

```bash
npx medusa db:migrate
```

Medusa's `db:migrate` applies pending module migrations, synchronizes module
links, and runs eligible data-migration scripts. Review interactive link
changes rather than automatically approving destructive operations. In
non-interactive deployment automation, choose Medusa's safe-link option unless
an explicitly reviewed release requires otherwise:

```bash
npx medusa db:migrate --execute-safe-links
```

See Medusa's current
[database command reference](https://docs.medusajs.com/resources/medusa-cli/commands/db)
for CLI flags supported by the host version.

Restart all API and worker processes on the same package/configuration version
after the migration. Do not leave old and new workers writing different schema
contracts for longer than the release notes explicitly allow.

## Clean installation verification

For a new environment:

1. Create an empty database or schema using the host application's normal
   procedure.
2. Install and register the plugin.
3. Run `npx medusa db:migrate`.
4. Start the Medusa backend and confirm the Digital Downloads module resolves.
5. Create a disposable digital product/release, then remove it through the
   supported application workflow.

Never use an automatic schema-sync mode as a substitute for packaged
migrations in production.

## Upgrade procedure

For every plugin upgrade:

1. Read `CHANGELOG.md`, the GitHub release notes, and this guide before changing
   the package.
2. Record the currently deployed plugin and Medusa versions.
3. Back up PostgreSQL and retain the exact prior package artifact.
4. Deploy the new package to a staging copy of production data.
5. Run migrations and exercise entitlement lookup, grant creation, license
   reveal/activation, refund/revocation, and Admin queries.
6. Stop or drain production workers if the release notes require an atomic
   cutover.
7. Deploy the package and configuration, apply migrations once, then start
   workers/API processes on the new version.
8. Run reconciliation/health checks before replaying failed commerce events.

Migration commands should have one deployment owner. Concurrent application
starts must not each run ad-hoc schema changes.

## Rollback strategy

Treat code, schema, encrypted data, and protected objects as four related but
separate layers.

### Preferred production rollback

For a failed migration with uncertain backward compatibility:

1. Stop API writes and event workers.
2. Preserve logs, failed job identifiers, and the new package version.
3. Restore the pre-migration PostgreSQL backup.
4. Restore the previous package and its configuration.
5. Keep the same encryption key.
6. Reconcile any external payment/order events and storage objects created
   after the backup before accepting traffic.

This is safer than assuming a down migration can reconstruct dropped or
transformed data.

### Medusa rollback command

Medusa also provides `db:rollback` for reverting the latest migration of a
specified module. The v1 module identifier is `digitalDownloads`; confirm the
syntax against the installed host's command help:

```bash
npx medusa db:rollback --help
npx medusa db:rollback --modules digitalDownloads
```

Use a module rollback only when the release notes and inspected migration
explicitly state that its `down` path is non-destructive and tested. A rollback
that drops entitlement, license, audit, or grant tables is not a production
recovery plan.

## Storage and migration boundaries

- Database migration does not move local files into S3 or S3 objects into a
  different prefix.
- Changing a storage driver does not rewrite existing asset references unless
  a documented migration tool does so.
- The module stores a non-secret namespace fingerprint and refuses startup
  when the local root or S3 endpoint/bucket/prefix changes while assets/uploads
  exist. Do not edit the fingerprint to bypass this guard.
- Do not delete an old local root, bucket, or prefix while any release snapshot
  or entitlement still references it.
- Upload cleanup and orphan garbage collection are application jobs, not a
  substitute for relational migration.
- A database restore may refer to objects created before the backup; verify
  object-version/retention policy when point-in-time consistency matters.

## Encryption-key changes

Do not replace `encryptionKey` as an ordinary configuration rollout. Records
encrypted under the old key require a deliberate re-encryption migration that
can read the old key, authenticate every value, write with the new key, and
resume safely after interruption.

If the installed release does not ship such a workflow, key rotation is not
implemented. Keep the original key and follow the security-response plan
rather than changing it and losing recoverability.

## Troubleshooting

### No plugin migration is discovered

- Confirm the plugin is installed in the Medusa host, not only in the
  storefront.
- Confirm `plugins` in `medusa-config.ts` resolves the package name exactly.
- Inspect the packed/installed package for its `.medusa/server` module and
  migration output.
- Run the host on a Medusa version inside the package's peer range.
- Rebuild/reinstall a local development package after adding migrations.

### Migration fails before changing data

Fix the database connection, permissions, package/configuration mismatch, or
invalid plugin option, then rerun. Do not manually mark a migration as applied.

### Migration fails after partial work

Stop rollout automation and inspect PostgreSQL's migration history plus the
actual schema. PostgreSQL usually makes transactional DDL recoverable, but data
scripts or external storage operations may have separate effects. Restore the
backup when the migration's documented retry behavior is not sufficient.

### Backend starts but routes fail after migration

- Verify every API and worker process runs the same package version.
- Check that module links were synchronized rather than skipped.
- Check encryption/storage secrets in the runtime process, not only the shell
  used to migrate.
- Inspect the server log using a correlation/request ID; do not log or paste
  bearer capabilities or decrypted keys.
