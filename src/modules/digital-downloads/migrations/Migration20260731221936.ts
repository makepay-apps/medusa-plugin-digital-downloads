import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260731221936 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "license_assignment" drop constraint if exists "license_assignment_license_pool_key_id_unique";`);
    this.addSql(`alter table if exists "license_policy" drop constraint if exists "license_policy_digital_product_id_unique";`);
    this.addSql(`create table if not exists "digital_downloads_settings" ("id" text not null, "singleton_key" text not null default 'global', "enabled" boolean not null default false, "default_delivery_type" text check ("default_delivery_type" in ('download', 'stream', 'license', 'mixed')) not null default 'download', "default_download_limit" integer null, "default_grant_ttl_seconds" integer not null default 900, "max_grant_ttl_seconds" integer not null default 86400, "max_upload_size_bytes" numeric not null default 5368709120, "allow_guest_access" boolean not null default true, "require_order_email_match" boolean not null default true, "event_retention_days" integer not null default 365, "storage_namespace_fingerprint" text null, "storage_namespace_version" integer not null default 1, "token_secret_fingerprint" text null, "encryption_key_fingerprint" text null, "show_makepay_attribution" boolean not null default true, "attribution_label" text not null default 'Brought to you by MakePay.io — crypto payment gateway.', "attribution_url" text not null default 'https://makepay.io', "metadata" jsonb not null default '{}', "raw_max_upload_size_bytes" jsonb not null default '{"value":"5368709120","precision":20}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_downloads_settings_pkey" primary key ("id"), constraint CK_digital_downloads_settings_download_limit check ((default_download_limit IS NULL OR default_download_limit >= 0)), constraint CK_digital_downloads_settings_default_ttl check (default_grant_ttl_seconds > 0), constraint CK_digital_downloads_settings_max_ttl check (max_grant_ttl_seconds >= default_grant_ttl_seconds), constraint CK_digital_downloads_settings_upload_size check (max_upload_size_bytes > 0), constraint CK_digital_downloads_settings_retention check (event_retention_days > 0), constraint CK_digital_downloads_settings_storage_namespace_version check (storage_namespace_version > 0), constraint CK_digital_downloads_settings_attribution_label check (attribution_label = 'Brought to you by MakePay.io — crypto payment gateway.'), constraint CK_digital_downloads_settings_attribution_url check (attribution_url = 'https://makepay.io'));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_downloads_settings_singleton" ON "digital_downloads_settings" ("singleton_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_downloads_settings_deleted_at" ON "digital_downloads_settings" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_product" ("id" text not null, "title" text not null, "handle" text not null, "description" text null, "status" text check ("status" in ('draft', 'active', 'archived')) not null default 'draft', "delivery_type" text check ("delivery_type" in ('download', 'stream', 'license', 'mixed')) not null default 'download', "fulfillment_required" boolean not null default true, "published_at" timestamptz null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_product_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_product_handle" ON "digital_product" ("handle") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_deleted_at" ON "digital_product" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_status" ON "digital_product" ("status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_published_at" ON "digital_product" ("published_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_product_release" ("id" text not null, "digital_product_id" text not null, "version" text not null, "title" text null, "release_notes" text null, "status" text check ("status" in ('draft', 'ready', 'published', 'retired')) not null default 'draft', "is_current" boolean not null default false, "available_from" timestamptz null, "available_until" timestamptz null, "published_at" timestamptz null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_product_release_pkey" primary key ("id"), constraint CK_digital_product_release_availability check ((available_until IS NULL OR available_from IS NULL OR available_until > available_from)));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_release_digital_product_id" ON "digital_product_release" ("digital_product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_release_deleted_at" ON "digital_product_release" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_product_release_version" ON "digital_product_release" ("digital_product_id", "version") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_product_release_current" ON "digital_product_release" ("digital_product_id") WHERE is_current = true AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_product_release_status" ON "digital_product_release" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_entitlement" ("id" text not null, "digital_product_id" text not null, "release_id" text not null, "status" text check ("status" in ('pending', 'active', 'suspended', 'revoked', 'expired', 'refunded')) not null default 'pending', "source" text check ("source" in ('order', 'manual', 'import')) not null default 'order', "order_id" text null, "order_line_item_id" text null, "fulfillment_id" text null, "customer_id" text null, "customer_email" text null, "customer_name" text null, "unit_index" integer not null default 0, "quantity" integer not null default 1, "available_at" timestamptz null, "expires_at" timestamptz null, "revoked_at" timestamptz null, "revoke_reason" text null, "download_limit" integer null, "download_count" integer not null default 0, "license_activation_limit" integer null, "idempotency_key" text not null, "snapshot" jsonb not null default '{}', "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_entitlement_pkey" primary key ("id"), constraint CK_digital_entitlement_quantity check (quantity > 0), constraint CK_digital_entitlement_unit_index check (unit_index >= 0), constraint CK_digital_entitlement_download_count check (download_count >= 0), constraint CK_digital_entitlement_download_limit check ((download_limit IS NULL OR download_limit >= 0)), constraint CK_digital_entitlement_activation_limit check ((license_activation_limit IS NULL OR license_activation_limit >= 0)));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_digital_product_id" ON "digital_entitlement" ("digital_product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_release_id" ON "digital_entitlement" ("release_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_entitlement_idempotency_key" ON "digital_entitlement" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_deleted_at" ON "digital_entitlement" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_order" ON "digital_entitlement" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_customer" ON "digital_entitlement" ("customer_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_email" ON "digital_entitlement" ("customer_email", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_product" ON "digital_entitlement" ("digital_product_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_entitlement_order_line_unit" ON "digital_entitlement" ("order_id", "order_line_item_id", "unit_index") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_entitlement_expires" ON "digital_entitlement" ("expires_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_asset" ("id" text not null, "release_id" text null, "name" text not null, "role" text check ("role" in ('download', 'stream', 'preview', 'cover', 'manual', 'license')) not null default 'download', "kind" text check ("kind" in ('file', 'pdf', 'audio', 'video', 'image', 'archive', 'license')) not null default 'file', "status" text check ("status" in ('staged', 'processing', 'ready', 'quarantined', 'failed', 'retired')) not null default 'staged', "delivery_type" text check ("delivery_type" in ('download', 'stream', 'license', 'mixed')) not null default 'download', "storage_provider" text check ("storage_provider" in ('local', 's3')) not null, "storage_key" text not null, "storage_bucket" text null, "original_filename" text not null, "mime_type" text not null, "size_bytes" numeric not null, "checksum_sha256" text not null, "version" text not null default '1', "sort_order" integer not null default 0, "is_enabled" boolean not null default true, "metadata" jsonb not null default '{}', "raw_size_bytes" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_asset_pkey" primary key ("id"), constraint CK_digital_asset_size_bytes check (size_bytes >= 0), constraint CK_digital_asset_sort_order check (sort_order >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_asset_release_id" ON "digital_asset" ("release_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_asset_deleted_at" ON "digital_asset" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_asset_storage_object" ON "digital_asset" ("storage_provider", "storage_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_asset_release_sort" ON "digital_asset" ("release_id", "sort_order") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_asset_checksum" ON "digital_asset" ("checksum_sha256") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_asset_status" ON "digital_asset" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "digital_upload" ("id" text not null, "release_id" text null, "asset_id" text null, "status" text check ("status" in ('pending', 'uploaded', 'completed', 'failed', 'expired')) not null default 'pending', "purpose" text check ("purpose" in ('download', 'stream', 'asset', 'preview', 'cover', 'manual', 'license', 'key_import')) not null default 'download', "storage_provider" text check ("storage_provider" in ('local', 's3')) not null, "storage_key" text not null, "storage_bucket" text null, "original_filename" text not null, "mime_type" text not null, "expected_size_bytes" numeric not null, "expected_checksum_sha256" text null, "actual_size_bytes" numeric null, "actual_checksum_sha256" text null, "upload_token_hash" text null, "expires_at" timestamptz not null, "uploaded_at" timestamptz null, "completed_at" timestamptz null, "error_message" text null, "metadata" jsonb not null default '{}', "raw_expected_size_bytes" jsonb not null, "raw_actual_size_bytes" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "digital_upload_pkey" primary key ("id"), constraint CK_digital_upload_expected_size check (expected_size_bytes > 0), constraint CK_digital_upload_actual_size check ((actual_size_bytes IS NULL OR actual_size_bytes >= 0)));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_upload_release_id" ON "digital_upload" ("release_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_digital_upload_storage_key" ON "digital_upload" ("storage_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_upload_deleted_at" ON "digital_upload" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_upload_status_expiry" ON "digital_upload" ("status", "expires_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_digital_upload_release" ON "digital_upload" ("release_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "download_grant" ("id" text not null, "entitlement_id" text not null, "asset_id" text not null, "status" text check ("status" in ('active', 'exhausted', 'revoked', 'expired')) not null default 'active', "token_hash" text not null, "token_prefix" text not null, "idempotency_key" text not null, "max_uses" integer not null default 1, "use_count" integer not null default 0, "expires_at" timestamptz not null, "last_used_at" timestamptz null, "reservation_id" text null, "reserved_at" timestamptz null, "continuation_started_at" timestamptz null, "continuation_expires_at" timestamptz null, "revoked_at" timestamptz null, "revoke_reason" text null, "bound_ip_hash" text null, "bound_user_agent_hash" text null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "download_grant_pkey" primary key ("id"), constraint CK_download_grant_max_uses check (max_uses > 0), constraint CK_download_grant_use_count check (use_count >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_grant_entitlement_id" ON "download_grant" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_grant_asset_id" ON "download_grant" ("asset_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_download_grant_token_hash" ON "download_grant" ("token_hash") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_download_grant_idempotency_key" ON "download_grant" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_grant_deleted_at" ON "download_grant" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_grant_entitlement" ON "download_grant" ("entitlement_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_grant_expiry" ON "download_grant" ("expires_at", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "download_event" ("id" text not null, "grant_id" text null, "entitlement_id" text null, "asset_id" text null, "event_type" text check ("event_type" in ('granted', 'transfer_started', 'transfer_completed', 'transfer_failed', 'downloaded', 'streamed', 'denied', 'expired', 'revoked')) not null, "success" boolean not null default true, "denial_reason" text null, "ip_hash" text null, "user_agent_hash" text null, "occurred_at" timestamptz not null, "bytes_served" numeric null, "range_start" numeric null, "range_end" numeric null, "metadata" jsonb not null default '{}', "raw_bytes_served" jsonb null, "raw_range_start" jsonb null, "raw_range_end" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "download_event_pkey" primary key ("id"), constraint CK_download_event_bytes_served check ((bytes_served IS NULL OR bytes_served >= 0)));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_grant_id" ON "download_event" ("grant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_entitlement_id" ON "download_event" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_asset_id" ON "download_event" ("asset_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_deleted_at" ON "download_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_entitlement_time" ON "download_event" ("entitlement_id", "occurred_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_asset_time" ON "download_event" ("asset_id", "occurred_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_download_event_type" ON "download_event" ("event_type") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_download_event_denied_grant_reason" ON "download_event" ("grant_id", "denial_reason") WHERE event_type = 'denied' AND deleted_at IS NULL;`);

    this.addSql(`create table if not exists "entitlement_access_session" ("id" text not null, "entitlement_id" text not null, "status" text check ("status" in ('pending', 'active', 'revoked', 'expired')) not null default 'active', "token_hash" text not null, "token_prefix" text not null, "idempotency_key" text not null, "expires_at" timestamptz not null, "last_used_at" timestamptz null, "use_count" integer not null default 0, "bound_ip_hash" text null, "bound_user_agent_hash" text null, "revoked_at" timestamptz null, "revoke_reason" text null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "entitlement_access_session_pkey" primary key ("id"), constraint CK_entitlement_access_session_use_count check (use_count >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_entitlement_access_session_entitlement_id" ON "entitlement_access_session" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_entitlement_access_session_token" ON "entitlement_access_session" ("token_hash") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_entitlement_access_session_idempotency" ON "entitlement_access_session" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_entitlement_access_session_deleted_at" ON "entitlement_access_session" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_entitlement_access_session_entitlement" ON "entitlement_access_session" ("entitlement_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_entitlement_access_session_expiry" ON "entitlement_access_session" ("expires_at", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "fulfillment_operation" ("id" text not null, "entitlement_id" text null, "idempotency_key" text not null, "order_id" text not null, "order_line_item_id" text not null, "unit_index" integer not null default 0, "digital_product_id" text not null, "digital_product_release_id" text null, "state" text check ("state" in ('pending', 'processing', 'completed', 'failed', 'dead_letter', 'canceled')) not null default 'pending', "lease_owner" text null, "lease_expires_at" timestamptz null, "attempt_count" integer not null default 0, "max_attempts" integer not null default 8, "next_retry_at" timestamptz null, "last_attempt_at" timestamptz null, "completed_at" timestamptz null, "canceled_at" timestamptz null, "error_code" text null, "error_message" text null, "error_details" jsonb not null default '{}', "payload" jsonb not null default '{}', "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fulfillment_operation_pkey" primary key ("id"), constraint CK_fulfillment_operation_unit_index check (unit_index >= 0), constraint CK_fulfillment_operation_attempt_count check (attempt_count >= 0), constraint CK_fulfillment_operation_max_attempts check (max_attempts > 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fulfillment_operation_entitlement_id" ON "fulfillment_operation" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fulfillment_operation_idempotency_key" ON "fulfillment_operation" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fulfillment_operation_deleted_at" ON "fulfillment_operation" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fulfillment_operation_order_line_unit" ON "fulfillment_operation" ("order_id", "order_line_item_id", "unit_index") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fulfillment_operation_claim" ON "fulfillment_operation" ("state", "next_retry_at", "lease_expires_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_fulfillment_operation_order" ON "fulfillment_operation" ("order_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "license_policy" ("id" text not null, "digital_product_id" text not null, "strategy" text check ("strategy" in ('none', 'pool', 'generated', 'external')) not null default 'none', "license_pattern" text null, "activation_limit" integer null, "validity_days" integer null, "allow_offline_activation" boolean not null default false, "require_device_id" boolean not null default true, "is_enabled" boolean not null default true, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "license_policy_pkey" primary key ("id"), constraint CK_license_policy_activation_limit check ((activation_limit IS NULL OR activation_limit >= 0)), constraint CK_license_policy_validity_days check ((validity_days IS NULL OR validity_days > 0)));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_license_policy_digital_product_id_unique" ON "license_policy" ("digital_product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_policy_deleted_at" ON "license_policy" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "license_pool_key" ("id" text not null, "license_policy_id" text not null, "status" text check ("status" in ('available', 'reserved', 'assigned', 'revoked')) not null default 'available', "key_ciphertext" text not null, "key_fingerprint" text not null, "key_hint" text not null, "batch_id" text null, "reserved_at" timestamptz null, "assigned_at" timestamptz null, "revoked_at" timestamptz null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "license_pool_key_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_pool_key_license_policy_id" ON "license_pool_key" ("license_policy_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_license_pool_key_fingerprint" ON "license_pool_key" ("key_fingerprint") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_pool_key_deleted_at" ON "license_pool_key" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_pool_key_available" ON "license_pool_key" ("license_policy_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_pool_key_batch" ON "license_pool_key" ("batch_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "license_assignment" ("id" text not null, "entitlement_id" text not null, "license_policy_id" text not null, "license_pool_key_id" text null, "status" text check ("status" in ('active', 'revoked')) not null default 'active', "idempotency_key" text not null, "activation_count" integer not null default 0, "assigned_at" timestamptz not null, "revealed_at" timestamptz null, "expires_at" timestamptz null, "revoked_at" timestamptz null, "revoke_reason" text null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "license_assignment_pkey" primary key ("id"), constraint CK_license_assignment_activation_count check (activation_count >= 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_assignment_entitlement_id" ON "license_assignment" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_assignment_license_policy_id" ON "license_assignment" ("license_policy_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_license_assignment_license_pool_key_id_unique" ON "license_assignment" ("license_pool_key_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_license_assignment_idempotency_key" ON "license_assignment" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_assignment_deleted_at" ON "license_assignment" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_license_assignment_entitlement_policy" ON "license_assignment" ("entitlement_id", "license_policy_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_assignment_status" ON "license_assignment" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "license_audit_event" ("id" text not null, "assignment_id" text null, "action" text check ("action" in ('key_imported', 'key_assigned', 'key_revealed', 'activated', 'deactivated', 'revoked', 'validation_failed')) not null, "success" boolean not null default true, "actor_type" text null, "actor_id" text null, "ip_hash" text null, "error_code" text null, "occurred_at" timestamptz not null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "license_audit_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_audit_event_assignment_id" ON "license_audit_event" ("assignment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_audit_event_deleted_at" ON "license_audit_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_audit_assignment_time" ON "license_audit_event" ("assignment_id", "occurred_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_audit_action" ON "license_audit_event" ("action") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "license_activation" ("id" text not null, "assignment_id" text not null, "device_fingerprint" text not null, "device_name" text null, "ip_hash" text null, "user_agent_hash" text null, "status" text check ("status" in ('active', 'deactivated', 'blocked')) not null default 'active', "activated_at" timestamptz not null, "last_seen_at" timestamptz not null, "deactivated_at" timestamptz null, "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "license_activation_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_activation_assignment_id" ON "license_activation" ("assignment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_activation_deleted_at" ON "license_activation" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_license_activation_assignment_device" ON "license_activation" ("assignment_id", "device_fingerprint") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_license_activation_status" ON "license_activation" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "notification_delivery" ("id" text not null, "entitlement_id" text not null, "idempotency_key" text not null, "channel" text check ("channel" in ('email', 'webhook')) not null default 'email', "template" text not null, "recipient_hash" text not null, "state" text check ("state" in ('pending', 'processing', 'sent', 'failed', 'dead_letter', 'canceled')) not null default 'pending', "attempt_count" integer not null default 0, "max_attempts" integer not null default 8, "next_retry_at" timestamptz null, "last_attempt_at" timestamptz null, "lease_owner" text null, "lease_expires_at" timestamptz null, "sent_at" timestamptz null, "canceled_at" timestamptz null, "provider_message_id" text null, "error_code" text null, "error_message" text null, "payload" jsonb not null default '{}', "metadata" jsonb not null default '{}', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "notification_delivery_pkey" primary key ("id"), constraint CK_notification_delivery_attempt_count check (attempt_count >= 0), constraint CK_notification_delivery_max_attempts check (max_attempts > 0));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_notification_delivery_entitlement_id" ON "notification_delivery" ("entitlement_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_delivery_idempotency_key" ON "notification_delivery" ("idempotency_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_notification_delivery_deleted_at" ON "notification_delivery" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_notification_delivery_natural_key" ON "notification_delivery" ("entitlement_id", "template", "recipient_hash") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_notification_delivery_claim" ON "notification_delivery" ("state", "next_retry_at", "lease_expires_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "digital_product_release" add constraint "digital_product_release_digital_product_id_foreign" foreign key ("digital_product_id") references "digital_product" ("id") on update cascade;`);

    this.addSql(`alter table if exists "digital_entitlement" add constraint "digital_entitlement_digital_product_id_foreign" foreign key ("digital_product_id") references "digital_product" ("id") on update cascade;`);
    this.addSql(`alter table if exists "digital_entitlement" add constraint "digital_entitlement_release_id_foreign" foreign key ("release_id") references "digital_product_release" ("id") on update cascade;`);

    this.addSql(`alter table if exists "digital_asset" add constraint "digital_asset_release_id_foreign" foreign key ("release_id") references "digital_product_release" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "digital_upload" add constraint "digital_upload_release_id_foreign" foreign key ("release_id") references "digital_product_release" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "download_grant" add constraint "download_grant_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade;`);
    this.addSql(`alter table if exists "download_grant" add constraint "download_grant_asset_id_foreign" foreign key ("asset_id") references "digital_asset" ("id") on update cascade;`);

    this.addSql(`alter table if exists "download_event" add constraint "download_event_grant_id_foreign" foreign key ("grant_id") references "download_grant" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table if exists "download_event" add constraint "download_event_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade on delete set null;`);
    this.addSql(`alter table if exists "download_event" add constraint "download_event_asset_id_foreign" foreign key ("asset_id") references "digital_asset" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "entitlement_access_session" add constraint "entitlement_access_session_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade;`);

    this.addSql(`alter table if exists "fulfillment_operation" add constraint "fulfillment_operation_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "license_policy" add constraint "license_policy_digital_product_id_foreign" foreign key ("digital_product_id") references "digital_product" ("id") on update cascade;`);

    this.addSql(`alter table if exists "license_pool_key" add constraint "license_pool_key_license_policy_id_foreign" foreign key ("license_policy_id") references "license_policy" ("id") on update cascade;`);

    this.addSql(`alter table if exists "license_assignment" add constraint "license_assignment_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade;`);
    this.addSql(`alter table if exists "license_assignment" add constraint "license_assignment_license_policy_id_foreign" foreign key ("license_policy_id") references "license_policy" ("id") on update cascade;`);
    this.addSql(`alter table if exists "license_assignment" add constraint "license_assignment_license_pool_key_id_foreign" foreign key ("license_pool_key_id") references "license_pool_key" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "license_audit_event" add constraint "license_audit_event_assignment_id_foreign" foreign key ("assignment_id") references "license_assignment" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "license_activation" add constraint "license_activation_assignment_id_foreign" foreign key ("assignment_id") references "license_assignment" ("id") on update cascade;`);

    this.addSql(`alter table if exists "notification_delivery" add constraint "notification_delivery_entitlement_id_foreign" foreign key ("entitlement_id") references "digital_entitlement" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "digital_product_release" drop constraint if exists "digital_product_release_digital_product_id_foreign";`);

    this.addSql(`alter table if exists "digital_entitlement" drop constraint if exists "digital_entitlement_digital_product_id_foreign";`);

    this.addSql(`alter table if exists "license_policy" drop constraint if exists "license_policy_digital_product_id_foreign";`);

    this.addSql(`alter table if exists "digital_entitlement" drop constraint if exists "digital_entitlement_release_id_foreign";`);

    this.addSql(`alter table if exists "digital_asset" drop constraint if exists "digital_asset_release_id_foreign";`);

    this.addSql(`alter table if exists "digital_upload" drop constraint if exists "digital_upload_release_id_foreign";`);

    this.addSql(`alter table if exists "download_grant" drop constraint if exists "download_grant_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "download_event" drop constraint if exists "download_event_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "entitlement_access_session" drop constraint if exists "entitlement_access_session_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "fulfillment_operation" drop constraint if exists "fulfillment_operation_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "license_assignment" drop constraint if exists "license_assignment_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "notification_delivery" drop constraint if exists "notification_delivery_entitlement_id_foreign";`);

    this.addSql(`alter table if exists "download_grant" drop constraint if exists "download_grant_asset_id_foreign";`);

    this.addSql(`alter table if exists "download_event" drop constraint if exists "download_event_asset_id_foreign";`);

    this.addSql(`alter table if exists "download_event" drop constraint if exists "download_event_grant_id_foreign";`);

    this.addSql(`alter table if exists "license_pool_key" drop constraint if exists "license_pool_key_license_policy_id_foreign";`);

    this.addSql(`alter table if exists "license_assignment" drop constraint if exists "license_assignment_license_policy_id_foreign";`);

    this.addSql(`alter table if exists "license_assignment" drop constraint if exists "license_assignment_license_pool_key_id_foreign";`);

    this.addSql(`alter table if exists "license_audit_event" drop constraint if exists "license_audit_event_assignment_id_foreign";`);

    this.addSql(`alter table if exists "license_activation" drop constraint if exists "license_activation_assignment_id_foreign";`);

    this.addSql(`drop table if exists "digital_downloads_settings" cascade;`);

    this.addSql(`drop table if exists "digital_product" cascade;`);

    this.addSql(`drop table if exists "digital_product_release" cascade;`);

    this.addSql(`drop table if exists "digital_entitlement" cascade;`);

    this.addSql(`drop table if exists "digital_asset" cascade;`);

    this.addSql(`drop table if exists "digital_upload" cascade;`);

    this.addSql(`drop table if exists "download_grant" cascade;`);

    this.addSql(`drop table if exists "download_event" cascade;`);

    this.addSql(`drop table if exists "entitlement_access_session" cascade;`);

    this.addSql(`drop table if exists "fulfillment_operation" cascade;`);

    this.addSql(`drop table if exists "license_policy" cascade;`);

    this.addSql(`drop table if exists "license_pool_key" cascade;`);

    this.addSql(`drop table if exists "license_assignment" cascade;`);

    this.addSql(`drop table if exists "license_audit_event" cascade;`);

    this.addSql(`drop table if exists "license_activation" cascade;`);

    this.addSql(`drop table if exists "notification_delivery" cascade;`);
  }

}
