import { Migration20260731221936 } from "../src/modules/digital-downloads/migrations/Migration20260731221936"
import { Migration20260801114300 } from "../src/modules/digital-downloads/migrations/Migration20260801114300"

type SnapshotTable = {
  name: string
  columns: Record<string, { enumItems?: string[] }>
  indexes: Array<{ keyName: string; expression?: string }>
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
