import { Migration20260731221936 } from "../src/modules/digital-downloads/migrations/Migration20260731221936"
import { Migration20260801114300 } from "../src/modules/digital-downloads/migrations/Migration20260801114300"
import { Migration20260803090000 } from "../src/modules/digital-downloads/migrations/Migration20260803090000"
import { Migration20260803183000 } from "../src/modules/digital-downloads/migrations/Migration20260803183000"
import { Migration20260803200000 } from "../src/modules/digital-downloads/migrations/Migration20260803200000"

type SnapshotTable = {
  name: string
  columns: Record<
    string,
    {
      type?: string
      nullable?: boolean
      default?: string | null
      enumItems?: string[]
      mappedType?: string
    }
  >
  indexes: Array<{ keyName: string; expression?: string }>
  checks: Array<{ name: string; expression: string; definition: string }>
}

const migrationSnapshot = require(
  "../src/modules/digital-downloads/migrations/.snapshot-medusa-digital-downloads.json",
) as { tables: SnapshotTable[] }

describe("initial migration schema invariants", () => {
  async function statements(): Promise<string[]> {
    const sql: string[] = []
    const migration = {
      addSql: (statement: string) => sql.push(statement),
    }
    await (Migration20260731221936.prototype.up as any).call(migration)
    return sql
  }

  it("keeps denied-event idempotency and pending access sessions aligned with the snapshot", async () => {
    const sql = await statements()
    const deniedIndex = sql.find((statement) =>
      statement.includes('"UQ_download_event_denied_grant_reason"'),
    )
    expect(deniedIndex).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_download_event_denied_grant_reason" ON "download_event" ("grant_id", "denial_reason") WHERE event_type = \'denied\' AND deleted_at IS NULL;',
    )

    const accessSessionTable = sql.find((statement) =>
      statement.startsWith('create table if not exists "entitlement_access_session"'),
    )
    expect(accessSessionTable).toContain(
      '"status" text check ("status" in (\'pending\', \'active\', \'revoked\', \'expired\'))',
    )

    const downloadEventSnapshot = migrationSnapshot.tables.find(
      (table) => table.name === "download_event",
    )
    const deniedIndexSnapshot = downloadEventSnapshot?.indexes.find(
      (index) => index.keyName === "UQ_download_event_denied_grant_reason",
    )
    expect(deniedIndexSnapshot?.expression).toBe(deniedIndex?.replace(/;$/, ""))

    const accessSessionSnapshot = migrationSnapshot.tables.find(
      (table) => table.name === "entitlement_access_session",
    )
    expect(accessSessionSnapshot?.columns.status.enumItems).toEqual([
      "pending",
      "active",
      "revoked",
      "expired",
    ])
  })
})

describe("v1 settings attribution compatibility migration", () => {
  function statements(method: "up" | "down"): Promise<string[]> {
    const sql: string[] = []
    const migration = {
      addSql: (statement: string) => sql.push(statement),
    }
    return (Migration20260801114300.prototype[method] as any)
      .call(migration)
      .then(() => sql)
  }

  it("replaces either historic constraint name before normalizing the v1 label", async () => {
    const sql = await statements("up")
    const combined = sql.join("\n")

    expect(sql).toHaveLength(5)
    expect(combined).toContain(
      'drop constraint if exists "CK_digital_downloads_settings_attribution_label"',
    )
    expect(combined).toContain(
      'drop constraint if exists "ck_digital_downloads_settings_attribution_label"',
    )
    expect(combined).toContain(
      "Brought to you by MakePay.io — crypto payment gateway.",
    )
    expect(combined).toContain('"updated_at" = now()')
    expect(combined).toContain(
      `where "attribution_label" = 'Brought to you by MakePay.io — crypto payment gateway'`,
    )
    expect(combined).toContain(
      'add constraint "CK_digital_downloads_settings_attribution_label"',
    )
    expect(combined.indexOf("drop constraint")).toBeLessThan(
      combined.indexOf('update "digital_downloads_settings"'),
    )
  })

  it("has a bounded inverse for disposable preview databases", async () => {
    const sql = await statements("down")
    const combined = sql.join("\n")

    expect(sql).toHaveLength(5)
    expect(combined).toContain(
      "Brought to you by MakePay.io — crypto payment gateway'",
    )
    expect(combined).toContain(
      'add constraint "ck_digital_downloads_settings_attribution_label"',
    )
  })
})

describe("durable guest-access settings migration", () => {
  function statements(method: "up" | "down"): Promise<string[]> {
    const sql: string[] = []
    const migration = {
      addSql: (statement: string) => sql.push(statement),
    }
    return (Migration20260803090000.prototype[method] as any)
      .call(migration)
      .then(() => sql)
  }

  it("adds a bounded 30-day setting without changing short grant TTLs", async () => {
    const sql = await statements("up")
    const combined = sql.join("\n")

    expect(sql).toHaveLength(5)
    expect(combined).toContain(
      '"guest_access_ttl_seconds" integer not null default 2592000',
    )
    expect(combined).toContain(
      '"guest_access_ttl_seconds" >= 86400 and "guest_access_ttl_seconds" <= 31536000',
    )
    expect(combined).not.toContain('alter column "max_grant_ttl_seconds"')
    expect(combined).toContain(
      'drop index if exists "UQ_notification_delivery_natural_key"',
    )
    expect(combined).toContain(
      'create index if not exists "IDX_notification_delivery_natural_lookup"',
    )

    const settingsSnapshot = migrationSnapshot.tables.find(
      (table) => table.name === "digital_downloads_settings",
    )
    expect(settingsSnapshot?.columns.guest_access_ttl_seconds?.default).toBe(
      "2592000",
    )
    const deliverySnapshot = migrationSnapshot.tables.find(
      (table) => table.name === "notification_delivery",
    )
    expect(
      deliverySnapshot?.indexes.find(
        (index) =>
          index.keyName === "IDX_notification_delivery_natural_lookup",
      )?.expression,
    ).not.toContain("UNIQUE")
  })

  it("diagnoses duplicate live natural keys before changing rollback schema", async () => {
    const sql = await statements("down")

    expect(sql).toHaveLength(5)
    const combined = sql.join("\n")
    expect(sql[0]).toContain('from "notification_delivery"')
    expect(sql[0]).toContain('where "deleted_at" is null')
    expect(sql[0]).toContain(
      'group by "entitlement_id", "template", "recipient_hash"',
    )
    expect(sql[0]).toContain("having count(*) > 1")
    expect(sql[0]).toContain("errcode = '23505'")
    expect(sql[0]).toContain(
      "Migration20260803090000 rollback blocked: duplicate live notification_delivery rows share (entitlement_id, template, recipient_hash).",
    )
    expect(sql[0]).toContain(
      "Reconcile each duplicate group without hard-deleting notification history, then retry the rollback.",
    )
    expect(sql[0]).not.toMatch(/\bdelete\s+from\b/i)
    expect(sql[0]).not.toMatch(/\bupdate\s+"notification_delivery"\b/i)
    expect(sql[1]).toContain(
      'drop index if exists "IDX_notification_delivery_natural_lookup"',
    )
    expect(sql[2]).toContain(
      'create unique index if not exists "UQ_notification_delivery_natural_key"',
    )
    expect(combined).toContain(
      'drop column if exists "guest_access_ttl_seconds"',
    )
  })
})

describe("pending guest-access upgrade migration", () => {
  function statements(method: "up" | "down"): Promise<string[]> {
    const sql: string[] = []
    const migration = {
      addSql: (statement: string) => sql.push(statement),
    }
    return (Migration20260803183000.prototype[method] as any)
      .call(migration)
      .then(() => sql)
  }

  it("adds pending to the access-session status domain for existing databases", async () => {
    const sql = await statements("up")

    expect(sql).toHaveLength(2)
    expect(sql[0]).toContain(
      'drop constraint if exists "entitlement_access_session_status_check"',
    )
    expect(sql[1]).toContain(
      '"status" in (\'pending\', \'active\', \'revoked\', \'expired\')',
    )
  })

  it("fails pending capabilities closed before restoring the earlier domain", async () => {
    const sql = await statements("down")

    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain('set "status" = \'revoked\'')
    expect(sql[0]).toContain('where "status" = \'pending\'')
    expect(sql[2]).toContain(
      '"status" in (\'active\', \'revoked\', \'expired\')',
    )
  })
})

describe("guest-access epoch migration", () => {
  function statements(method: "up" | "down"): Promise<string[]> {
    const sql: string[] = []
    const migration = {
      addSql: (statement: string) => sql.push(statement),
    }
    return (Migration20260803200000.prototype[method] as any)
      .call(migration)
      .then(() => sql)
  }

  it("adds a first-class nonnegative entitlement epoch", async () => {
    const sql = await statements("up")

    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain(
      'add column if not exists "guest_access_epoch" integer not null default 0',
    )
    expect(sql[1]).toContain(
      'drop constraint if exists "CK_digital_entitlement_guest_access_epoch"',
    )
    expect(sql[2]).toContain(
      'add constraint "CK_digital_entitlement_guest_access_epoch" check ("guest_access_epoch" >= 0)',
    )

    const entitlementSnapshot = migrationSnapshot.tables.find(
      (table) => table.name === "digital_entitlement",
    )
    expect(entitlementSnapshot?.columns.guest_access_epoch).toMatchObject({
      type: "integer",
      nullable: false,
      default: "0",
      mappedType: "integer",
    })
    expect(
      entitlementSnapshot?.checks.find(
        (check) =>
          check.name === "CK_digital_entitlement_guest_access_epoch",
      ),
    ).toMatchObject({
      expression: "guest_access_epoch >= 0",
      definition: "check ((guest_access_epoch >= 0))",
    })
  })

  it("removes the constraint before the epoch column on rollback", async () => {
    const sql = await statements("down")

    expect(sql).toHaveLength(2)
    expect(sql[0]).toContain(
      'drop constraint if exists "CK_digital_entitlement_guest_access_epoch"',
    )
    expect(sql[1]).toContain(
      'drop column if exists "guest_access_epoch"',
    )
  })
})
