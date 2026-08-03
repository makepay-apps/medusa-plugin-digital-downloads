import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const DEFAULT_GUEST_ACCESS_TTL_SECONDS = 30 * 24 * 60 * 60
const MIN_GUEST_ACCESS_TTL_SECONDS = 24 * 60 * 60
const MAX_GUEST_ACCESS_TTL_SECONDS = 365 * 24 * 60 * 60

/**
 * Guest purchase-access capabilities outlive short asset grants. Existing
 * installations receive the same 30-day default as fresh installations.
 */
export class Migration20260803090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "digital_downloads_settings" add column if not exists "guest_access_ttl_seconds" integer not null default ${DEFAULT_GUEST_ACCESS_TTL_SECONDS};`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "CK_digital_downloads_settings_guest_access_ttl";`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" add constraint "CK_digital_downloads_settings_guest_access_ttl" check ("guest_access_ttl_seconds" >= ${MIN_GUEST_ACCESS_TTL_SECONDS} and "guest_access_ttl_seconds" <= ${MAX_GUEST_ACCESS_TTL_SECONDS});`,
    )
    // Reissue notifications are intentionally versioned by idempotency_key.
    // The original natural-key uniqueness allowed only one reissue email for
    // the lifetime of an entitlement, so retain it solely as a lookup index.
    this.addSql(
      `drop index if exists "UQ_notification_delivery_natural_key";`,
    )
    this.addSql(
      `create index if not exists "IDX_notification_delivery_natural_lookup" on "notification_delivery" ("entitlement_id", "template", "recipient_hash") where deleted_at is null;`,
    )
  }

  override async down(): Promise<void> {
    // The v0.4 schema permits multiple independently idempotent lifecycle
    // messages for one natural key. Restoring the older unique index is only
    // possible after an operator has reconciled those live rows. Fail before
    // changing the schema and preserve every notification record for that
    // reconciliation.
    this.addSql(`
      do $migration$
      begin
        if exists (
          select 1
          from "notification_delivery"
          where "deleted_at" is null
          group by "entitlement_id", "template", "recipient_hash"
          having count(*) > 1
        ) then
          raise exception using
            errcode = '23505',
            message = 'Migration20260803090000 rollback blocked: duplicate live notification_delivery rows share (entitlement_id, template, recipient_hash).',
            detail = 'UQ_notification_delivery_natural_key requires at most one live row for each natural key.',
            hint = 'Reconcile each duplicate group without hard-deleting notification history, then retry the rollback.';
        end if;
      end
      $migration$;
    `)
    this.addSql(
      `drop index if exists "IDX_notification_delivery_natural_lookup";`,
    )
    this.addSql(
      `create unique index if not exists "UQ_notification_delivery_natural_key" on "notification_delivery" ("entitlement_id", "template", "recipient_hash") where deleted_at is null;`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "CK_digital_downloads_settings_guest_access_ttl";`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop column if exists "guest_access_ttl_seconds";`,
    )
  }
}
