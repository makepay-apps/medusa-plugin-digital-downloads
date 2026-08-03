import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Upgrades pre-v0.4 databases so a guest capability can remain unusable until
 * its delivery provider succeeds. Fresh installs already include `pending` in
 * the initial schema; the guarded replacement makes the upgrade path match it.
 */
export class Migration20260803183000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "entitlement_access_session" drop constraint if exists "entitlement_access_session_status_check";`,
    )
    this.addSql(
      `alter table if exists "entitlement_access_session" add constraint "entitlement_access_session_status_check" check ("status" in ('pending', 'active', 'revoked', 'expired'));`,
    )
  }

  override async down(): Promise<void> {
    // A pending capability was never usable. Fail it closed before restoring
    // the earlier status domain so rollback cannot accidentally activate it.
    this.addSql(
      `update "entitlement_access_session" set "status" = 'revoked', "revoked_at" = coalesce("revoked_at", now()), "revoke_reason" = coalesce("revoke_reason", 'v0.4 migration rollback'), "updated_at" = now() where "status" = 'pending';`,
    )
    this.addSql(
      `alter table if exists "entitlement_access_session" drop constraint if exists "entitlement_access_session_status_check";`,
    )
    this.addSql(
      `alter table if exists "entitlement_access_session" add constraint "entitlement_access_session_status_check" check ("status" in ('active', 'revoked', 'expired'));`,
    )
  }
}
