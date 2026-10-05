import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { BACKUP_TABLES, SETTINGS_MACHINE_COLUMNS, settingsMachineBlank } from "@/lib/backup-format";
import { BASELINE_SETTINGS_FIELDS } from "@/lib/domain/settings-baseline";

/**
 * Migration 0080 — Telegram stop/target alerts (v4.7.0 C5, design D6/D7 as
 * amended by review R6/R7). On the pattern of migration-0076:
 *
 *   1. registered in the journal right after 0079 with a matching .sql file;
 *   2. four settings columns — the toggle NOT NULL DEFAULT 0, the rest nullable;
 *   3. `telegram_alerts_sent`: no account_id, the CHECK on kind, the unique
 *      (trade_id, symbol, kind, ist_date) unit, REAL prices;
 *   4. machine state: all four columns redacted from backups, the toggle blanks
 *      to OFF, the table outside BACKUP_TABLES, none of it a baseline choice.
 *
 * ONE temp database per file.
 */

let t: TempDb;
const MIGRATION = path.join(process.cwd(), "drizzle", "0080_telegram-alerts.sql");

beforeAll(async () => {
  t = await openTempDb("migration-0080", { seed: true });
});
afterAll(() => t?.cleanup());

type Col = { name: string; type: string; notnull: number; dflt_value: string | null };
const cols = (table: string) => t.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Col[];

describe("migration 0080 — telegram alerts", () => {
  it("is registered in the journal right after 0079, with a matching .sql file", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const entry = journal.entries.find((e) => e.idx === 80);
    expect(entry?.tag).toBe("0080_telegram-alerts");
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 79)!.when);
    // v4.8.0 P2: 0080 is no longer the newest (0081 adds clinic_cache.summary_json, and pins "newest" itself in
    // tests/clinic-card-summary.test.ts) — what stays 0080's own is its place: directly before whatever follows it.
    const next = journal.entries.find((e) => e.idx === 81);
    if (next) expect(next.when).toBeGreaterThan(entry!.when);
    expect(journal.entries.filter((e) => e.idx === 80)).toHaveLength(1);
    expect(fs.existsSync(MIGRATION)).toBe(true);
  });

  it("adds the four settings columns — the toggle NOT NULL DEFAULT 0, the rest nullable with no default", () => {
    const s = cols("settings");
    const by = (n: string) => s.find((c) => c.name === n);
    expect(by("telegram_alerts_enabled")).toMatchObject({ notnull: 1, dflt_value: "0" });
    for (const n of ["telegram_alert_from", "telegram_alert_to", "last_telegram_alert_summary_date"]) {
      expect(by(n), n).toMatchObject({ notnull: 0, dflt_value: null });
      expect(by(n)!.type.toLowerCase()).toBe("text");
    }
    const row = t.sqlite.prepare("SELECT telegram_alerts_enabled AS on_, telegram_alert_from AS f FROM settings").get() as { on_: number; f: string | null };
    expect(row).toEqual({ on_: 0, f: null });
  });

  it("creates telegram_alerts_sent with NO account_id and REAL prices", () => {
    const c = cols("telegram_alerts_sent");
    expect(c.map((x) => x.name)).toEqual(["id", "trade_id", "symbol", "kind", "ist_date", "level", "mark", "sent_at"]);
    expect(c.find((x) => x.name === "level")!.type.toLowerCase()).toBe("real");
    expect(c.find((x) => x.name === "mark")!.type.toLowerCase()).toBe("real");
    expect(c.filter((x) => x.name !== "id").every((x) => x.notnull === 1)).toBe(true);
  });

  it("the unit is (trade_id, symbol, kind, ist_date) and kind is CHECKed", () => {
    const ins = t.sqlite.prepare(
      "INSERT INTO telegram_alerts_sent (trade_id, symbol, kind, ist_date, level, mark, sent_at) VALUES (?, ?, ?, ?, 1.5, 1.25, 'x') ON CONFLICT DO NOTHING",
    );
    expect(ins.run(1, "AAA", "sl", "2026-10-07").changes).toBe(1);
    expect(ins.run(1, "AAA", "sl", "2026-10-07").changes).toBe(0);
    expect(ins.run(1, "BBB", "sl", "2026-10-07").changes).toBe(1); // R6: a different symbol under the same id
    expect(ins.run(1, "AAA", "target", "2026-10-07").changes).toBe(1);
    expect(ins.run(1, "AAA", "sl", "2026-10-08").changes).toBe(1);
    expect(() => ins.run(1, "AAA", "exit", "2026-10-09")).toThrow(/CHECK/);
    const r = t.sqlite.prepare("SELECT level, mark FROM telegram_alerts_sent LIMIT 1").get() as { level: number; mark: number };
    expect(r).toEqual({ level: 1.5, mark: 1.25 });
  });

  it("is machine state: redacted columns, the toggle blanks to OFF, the table is never backed up, nothing is a baseline choice", () => {
    for (const col of ["telegramAlertsEnabled", "telegramAlertFrom", "telegramAlertTo", "lastTelegramAlertSummaryDate"]) {
      expect(SETTINGS_MACHINE_COLUMNS as readonly string[], col).toContain(col);
      expect(BASELINE_SETTINGS_FIELDS as readonly string[], col).not.toContain(col);
    }
    expect(settingsMachineBlank("telegramAlertsEnabled")).toBe(false);
    expect(settingsMachineBlank("telegramAlertFrom")).toBeNull();
    expect(BACKUP_TABLES as readonly string[]).not.toContain("telegram_alerts_sent");
  });

  it("the schema declares the table and the columns, so drizzle reads them through the table objects", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "lib", "db", "schema.ts"), "utf8");
    expect(schema).toMatch(/sqliteTable\(\s*"telegram_alerts_sent"/);
    expect(schema).toContain('uniqueIndex("telegram_alerts_sent_uq").on(t.tradeId, t.symbol, t.kind, t.istDate)');
    expect(schema).toContain('telegramAlertsEnabled: integer("telegram_alerts_enabled", { mode: "boolean" }).notNull().default(false)');
  });
});
