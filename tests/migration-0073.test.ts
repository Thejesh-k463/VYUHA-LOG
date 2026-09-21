import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// PURE (no DB) — the resolver the migration's comment defers to.
import { resolvePerTradeCap, type CapRow } from "@/lib/risk/limits";

/**
 * Migration 0073 — the per-segment per-trade cap (D1) and the dated risk-free
 * setting (D5), applied to a database that is REALLY at 0072 with the rows a
 * v1–v4.3 install holds, not to a fresh one.
 *
 * What it must do, and what it must never do:
 *   - add `risk_config.cap_scheme` NULL on every existing row, so the legacy
 *     seed literal keeps reading as "inherit" — the resolver's rule, never a
 *     data rewrite: NO cap moves, and an EDITED cap is untouched;
 *   - insert the three segment rows the v1 seed never had (eq_delivery, eq_mtf,
 *     future) with a NULL cap and cap_scheme 1 — `INSERT OR IGNORE`, so a row
 *     that exists already is left exactly as it is;
 *   - add `trades.risk_source` NULL (the `risk-source-v1` data fix classifies);
 *   - add the risk-free pair: 70000 ppm (7%, nothing moves) and a NULL date;
 *   - apply ONCE: a second migrate is a no-op.
 *
 * No lib/db here at all: the database is a throwaway FILE migrated by drizzle's
 * own migrator from a copy of ./drizzle whose journal stops at 0072, then from
 * the real folder. Measured locally 2026-09-18: both migrate passes ~0.4 s.
 */

const REPO_DRIZZLE = path.join(process.cwd(), "drizzle");
let dir: string;
let sqlite: Database.Database;
let before: Record<string, unknown>[];

interface Journal { entries: { idx: number; tag: string; version: string; when: number; breakpoints: boolean }[] }
const journal = (): Journal => JSON.parse(fs.readFileSync(path.join(REPO_DRIZZLE, "meta", "_journal.json"), "utf8"));
const riskRows = () =>
  sqlite.prepare("SELECT scope, key, per_trade_max_loss AS cap, cap_scheme AS scheme FROM risk_config ORDER BY scope, key").all() as {
    scope: string; key: string; cap: number | null; scheme: number | null;
  }[];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-m0073-"));
  // A migrations folder that STOPS at 0072 — the install before this release.
  const pre = path.join(dir, "drizzle-0072");
  fs.mkdirSync(path.join(pre, "meta"), { recursive: true });
  const j = journal();
  const kept = j.entries.filter((e) => e.idx <= 72);
  for (const e of kept) fs.copyFileSync(path.join(REPO_DRIZZLE, `${e.tag}.sql`), path.join(pre, `${e.tag}.sql`));
  fs.writeFileSync(path.join(pre, "meta", "_journal.json"), JSON.stringify({ ...j, entries: kept }));

  sqlite = new Database(path.join(dir, "m0073.sqlite"));
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: pre });
  const cols0072 = sqlite.pragma("table_info(risk_config)") as { name: string }[];
  expect(cols0072.some((c) => c.name === "cap_scheme"), "the 0072 database predates the column").toBe(false);

  // What a v1–v4.3 install holds: the v1 seed's eight rows at the literal 9500,
  // ONE the user edited (index_option → 5000), and — the INSERT OR IGNORE case —
  // a `future` segment row somebody already has, with their own figure.
  const ins = sqlite.prepare("INSERT INTO risk_config (scope, key, per_trade_max_loss) VALUES (?, ?, ?)");
  for (const [scope, key, cap] of [
    ["global", "", 9500], ["bucket", "equity", 9500], ["bucket", "active", 9500],
    ["segment", "index_option", 5000], ["segment", "stock_option", 9500], ["segment", "eq_intraday", 9500],
    ["segment", "commodity_future", 9500], ["segment", "commodity_option", 9500], ["segment", "future", 7000],
  ] as const) ins.run(scope, key, cap);
  // The settings row as 0072 defines it: every NOT NULL column without a default filled.
  const required = (sqlite.pragma("table_info(settings)") as { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[])
    .filter((c) => c.notnull && c.dflt_value == null && !c.pk);
  sqlite
    .prepare(`INSERT INTO settings (${required.map((c) => `"${c.name}"`).join(", ")}) VALUES (${required.map(() => "?").join(", ")})`)
    .run(...required.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 0 : "2026-01-01")));
  sqlite.prepare("INSERT OR IGNORE INTO accounts (name, is_default) VALUES ('Primary', 1)").run();
  const acct = (sqlite.prepare("SELECT id FROM accounts ORDER BY id LIMIT 1").get() as { id: number }).id;
  sqlite.prepare(
    "INSERT INTO trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, dedup_hash, risk_amount_paise, r_multiple) VALUES (?, 'dhan', 'active', 'index_option', 'option', 'NSE', 'NIFTY', 'NIFTY', 'h1', 950000, -0.5)",
  ).run(acct);
  before = sqlite.prepare("SELECT scope, key, per_trade_max_loss AS cap FROM risk_config ORDER BY scope, key").all() as Record<string, unknown>[];

  migrate(db, { migrationsFolder: REPO_DRIZZLE });
}, 60_000);

afterAll(() => {
  sqlite?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 0073 is journalled", () => {
  it("has its .sql file, the next index, a later `when`, and breakpoints", () => {
    const j = journal();
    const e = j.entries.find((x) => x.tag === "0073_per-segment-cap-risk-free");
    expect(e, "0073 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect([e!.idx, e!.version, e!.breakpoints]).toEqual([73, "6", true]);
    expect(fs.existsSync(path.join(REPO_DRIZZLE, `${e!.tag}.sql`))).toBe(true);
    const prev = j.entries.find((x) => x.idx === 72)!;
    expect(e!.when, "drizzle applies by `when`: an earlier stamp would be skipped on every install").toBeGreaterThan(prev.when);
  });
});

describe("migration 0073 on a 0072 database", () => {
  it("adds cap_scheme NULL on every existing row and moves NO cap — the edited one included", () => {
    const after = riskRows();
    for (const b of before) {
      const a = after.find((r) => r.scope === b.scope && r.key === b.key)!;
      expect([a.cap, a.scheme], `${b.scope}:${b.key}`).toEqual([b.cap, null]);
    }
  });

  it("inserts the three missing segment rows as INHERIT (NULL cap, cap_scheme 1), and leaves an existing one exactly as it was", () => {
    const after = riskRows();
    expect(after.find((r) => r.key === "eq_delivery")).toEqual({ scope: "segment", key: "eq_delivery", cap: null, scheme: 1 });
    expect(after.find((r) => r.key === "eq_mtf")).toEqual({ scope: "segment", key: "eq_mtf", cap: null, scheme: 1 });
    expect(after.find((r) => r.key === "future"), "INSERT OR IGNORE: the user's own row survives").toEqual({ scope: "segment", key: "future", cap: 7000, scheme: null });
    expect(after).toHaveLength(before.length + 2);
  });

  it("reads through the resolver as it did before: legacy rows inherit, the edited cap stands, nothing reads as a new number", () => {
    const rows: CapRow[] = riskRows().map((r) => ({ scope: r.scope, key: r.key, perTradeMaxLoss: r.cap, capScheme: r.scheme }));
    expect(resolvePerTradeCap(rows, "active", "index_option")).toBe(5000);
    expect(resolvePerTradeCap(rows, "active", "stock_option")).toBe(9500);
    expect(resolvePerTradeCap(rows, "equity", "eq_delivery")).toBe(9500);
    expect(resolvePerTradeCap(rows, "active", "future")).toBe(7000);
  });

  it("adds trades.risk_source NULL (classified later, in code) and the risk-free pair at 7% · no date", () => {
    expect(sqlite.prepare("SELECT risk_source, risk_amount_paise FROM trades").get()).toEqual({ risk_source: null, risk_amount_paise: 950000 });
    expect(sqlite.prepare("SELECT risk_free_rate_ppm AS ppm, risk_free_as_of AS asOf FROM settings").get()).toEqual({ ppm: 70000, asOf: null });
  });

  it("applies once: a second migrate, and a replay of its INSERT OR IGNORE, change nothing", () => {
    const n = () => (sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
    const applied = n();
    const rows = JSON.stringify(riskRows());
    migrate(drizzle(sqlite), { migrationsFolder: REPO_DRIZZLE });
    expect(n()).toBe(applied);
    const sql = fs.readFileSync(path.join(REPO_DRIZZLE, "0073_per-segment-cap-risk-free.sql"), "utf8");
    const insert = sql.split("--> statement-breakpoint").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).find((s) => s.startsWith("INSERT OR IGNORE"));
    expect(insert, "the segment rows are inserted with INSERT OR IGNORE").toBeTruthy();
    expect(sqlite.prepare(insert!).run().changes).toBe(0);
    expect(JSON.stringify(riskRows())).toBe(rows);
  });
});
