import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Adds a durable generation counter for guest capabilities. Incrementing the
 * entitlement epoch lets the service invalidate capabilities issued under an
 * earlier lifecycle without relying on mutable token metadata alone.
 */
export class Migration20260803200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "digital_entitlement" add column if not exists "guest_access_epoch" integer not null default 0;`,
    )
    this.addSql(
      `alter table if exists "digital_entitlement" drop constraint if exists "CK_digital_entitlement_guest_access_epoch";`,
    )
    this.addSql(
      `alter table if exists "digital_entitlement" add constraint "CK_digital_entitlement_guest_access_epoch" check ("guest_access_epoch" >= 0);`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "digital_entitlement" drop constraint if exists "CK_digital_entitlement_guest_access_epoch";`,
    )
    this.addSql(
      `alter table if exists "digital_entitlement" drop column if exists "guest_access_epoch";`,
    )
  }
}
