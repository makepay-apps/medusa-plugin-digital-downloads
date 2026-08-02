import { Migration } from "@medusajs/framework/mikro-orm/migrations"

const ATTRIBUTION_LABEL =
  "Brought to you by MakePay.io — crypto payment gateway."
const LEGACY_ATTRIBUTION_LABEL =
  "Brought to you by MakePay.io — crypto payment gateway"

/**
 * Early v1 development builds used the attribution text without its final
 * period in both the row and its check constraint. The original migration may
 * already be recorded in a persistent Medusa database, so changing that file
 * cannot repair an existing installation. This forward migration makes the
 * released v1 contract explicit and keeps fresh and preview-upgraded databases
 * identical.
 */
export class Migration20260801114300 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "CK_digital_downloads_settings_attribution_label";`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "ck_digital_downloads_settings_attribution_label";`,
    )
    this.addSql(
      `update "digital_downloads_settings" set "attribution_label" = '${ATTRIBUTION_LABEL}', "updated_at" = now() where "attribution_label" = '${LEGACY_ATTRIBUTION_LABEL}';`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" alter column "attribution_label" set default '${ATTRIBUTION_LABEL}';`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" add constraint "CK_digital_downloads_settings_attribution_label" check ("attribution_label" = '${ATTRIBUTION_LABEL}');`,
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "CK_digital_downloads_settings_attribution_label";`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" drop constraint if exists "ck_digital_downloads_settings_attribution_label";`,
    )
    this.addSql(
      `update "digital_downloads_settings" set "attribution_label" = '${LEGACY_ATTRIBUTION_LABEL}', "updated_at" = now() where "attribution_label" = '${ATTRIBUTION_LABEL}';`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" alter column "attribution_label" set default '${LEGACY_ATTRIBUTION_LABEL}';`,
    )
    this.addSql(
      `alter table if exists "digital_downloads_settings" add constraint "ck_digital_downloads_settings_attribution_label" check ("attribution_label" = '${LEGACY_ATTRIBUTION_LABEL}');`,
    )
  }
}
