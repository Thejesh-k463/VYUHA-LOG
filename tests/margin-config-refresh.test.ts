import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// Plain ESM with no DB import of its own (it takes an open connection).
import { refreshMarginRows } from "../scripts/rate-card-refresh.mjs";

/**
 * SM-1 (v4.6.0 fix wave) — the Fyers and Nuvama `margin_config` rows reach an
 * UPGRADED install, a restored 4.5.0 backup, a 4.5.0 default-settings baseline
 * and the desktop launch refresh — not only a fresh seed.
 *
 * Without them `capitalBlocked` (lib/risk/margin.ts) assumes 100% of notional
 * for a Fyers/Nuvama future or short option and ROM is off by up to 6.7×.
 *
 * ONE temp database for the file (AGENTS.md § Testing). The first block runs on
 * the MIGRATED, UNSEEDED database, so what it sees is exactly what 0078 wrote.
 */

let t: TempDb;
let seedCore: typeof import("@/lib/db/seed-core");
const ROOT = process.cwd();
const SQL_FILE = path.join(ROOT, "drizzle", "0078_margin-config-fyers-nuvama.sql");
const NEW = ["fyers", "nuvama"];

type Row = { broker: string; segment: string; marginPct: number; note: string | null };
const rowsOf = (brokers = NEW): Row[] =>
  (t.sqlite
    .prepare(`SELECT broker, segment, margin_pct AS marginPct, note FROM margin_config WHERE broker IN (${brokers.map(() => "?").join(",")}) ORDER BY broker, segment`)
    .all(...brokers) as Row[]);
const byKey = (rs: readonly Row[]) => [...rs].map((r) => ({ ...r })).sort((a, b) => `${a.broker}|${a.segment}`.localeCompare(`${b.broker}|${b.segment}`));
const dropNew = () => t.sqlite.prepare("DELETE FROM margin_config WHERE broker IN ('fyers', 'nuvama')").run().changes;
const count = () => (t.sqlite.prepare("SELECT count(*) AS n FROM margin_config WHERE broker IN ('fyers', 'nuvama')").get() as { n: number }).n;

beforeAll(async () => {
  t = await openTempDb("margin-config-refresh"); // migrated, NOT seeded
  seedCore = await import("@/lib/db/seed-core");
});
afterAll(() => t?.cleanup());

describe("migration 0078 — the 16 rows, equal to the seed's", () => {
  it("0078 holds exactly SEED_MARGIN_ROWS for fyers + nuvama, and a migrated unseeded database carries them", () => {
    const seed = byKey(seedCore.SEED_MARGIN_ROWS.filter((r) => NEW.includes(r.broker)) as Row[]);
    expect(seed).toHaveLength(16);
    // The SQL file's own VALUES, parsed — the file and the seed cannot drift.
    const sql = fs.readFileSync(SQL_FILE, "utf8");
    const values = [...sql.matchAll(/\('([a-z]+)', '([a-z_]+)', (\d+(?:\.\d+)?), '((?:[^']|'')*)'\)/g)].map((m) => ({
      broker: m[1], segment: m[2], marginPct: Number(m[3]), note: m[4].replace(/''/g, "'"),
    }));
    expect(byKey(values)).toEqual(seed);
    expect(sql).toMatch(/INSERT OR IGNORE INTO `margin_config`/);
    // …and it is what the migrator actually wrote (the seed has not run here).
    expect(byKey(rowsOf())).toEqual(seed);
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, "drizzle", "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 78)?.tag).toBe("0078_margin-config-fyers-nuvama");
  });

  it("a 4.5.0-shaped database (no 0078, no Fyers/Nuvama rows) migrates +1 → 16 rows; a second run applies +0 and adds 0", async () => {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const applied = () => (t.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n;
    // Back to the 4.5.0 shape: 0078's ledger row and its rows gone. A hand-added
    // Fyers row the user already has must WIN over the migration.
    const last = t.sqlite.prepare("SELECT max(created_at) AS c FROM __drizzle_migrations").get() as { c: number };
    t.sqlite.prepare("DELETE FROM __drizzle_migrations WHERE created_at = ?").run(last.c);
    expect(dropNew()).toBe(16);
    t.sqlite.prepare("INSERT INTO margin_config (broker, segment, margin_pct, note) VALUES ('fyers', 'future', 18, 'mine')").run();
    const before = applied();
    migrate(t.db, { migrationsFolder: "./drizzle" });
    expect(applied() - before, "run 1 applies 0078").toBe(1);
    expect(count()).toBe(16);
    expect(rowsOf(["fyers"]).find((r) => r.segment === "future"), "the user's own row wins").toMatchObject({ marginPct: 18, note: "mine" });
    migrate(t.db, { migrationsFolder: "./drizzle" });
    expect(applied() - before, "run 2 applies nothing").toBe(1);
    expect(count()).toBe(16);
    t.sqlite.prepare("UPDATE margin_config SET margin_pct = 15, note = 'SPAN+exposure approx' WHERE broker = 'fyers' AND segment = 'future'").run();
  });
});

describe("refreshMarginConfig — the seed, and the one pass both restores run", () => {
  it("the seed adds only what 0078 did not (64 of 80), and a second pass adds 0", () => {
    expect(seedCore.SEED_MARGIN_ROWS).toHaveLength(80);
    expect(seedCore.seedDatabase().marginAdded).toBe(64);
    expect(seedCore.refreshMarginConfig()).toBe(0);
  });

  it("a 4.5.0 BACKUP (no Fyers/Nuvama margin rows) restores with all 16 back, the backup's own rows untouched", async () => {
    const backup = await import("@/lib/backup");
    t.sqlite.prepare("UPDATE margin_config SET margin_pct = 22 WHERE broker = 'zerodha' AND segment = 'eq_mtf'").run();
    const dump = backup.dumpDatabase(false);
    dump.tables.margin_config = (dump.tables.margin_config as { broker: string }[]).filter((r) => !NEW.includes(r.broker));
    const res = backup.restoreDatabase(dump);
    expect(res.ok, res.message).toBe(true);
    expect(count()).toBe(16);
    expect(rowsOf(["zerodha"]).find((r) => r.segment === "eq_mtf")?.marginPct, "a restored row stands").toBe(22);
  });

  it("a 4.5.0 default-settings BASELINE (its DELETE wipes the table) restores with all 16 back", async () => {
    const base = await import("@/lib/queries/settings-baseline");
    expect(base.saveCurrentAsBaseline().ok).toBe(true);
    // The baseline as 4.5.0 saved it: no Fyers / Nuvama margin rows.
    const row = t.sqlite.prepare("SELECT id, payload FROM settings_baseline").get() as { id: number; payload: string };
    const payload = JSON.parse(row.payload) as { marginConfig: { broker: string }[] };
    payload.marginConfig = payload.marginConfig.filter((r) => !NEW.includes(r.broker));
    t.sqlite.prepare("UPDATE settings_baseline SET payload = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    const res = base.restoreBaseline();
    expect(res.ok, res.message).toBe(true);
    expect(count()).toBe(16);
  });
});

describe("scripts/rate-card-refresh.mjs — the desktop launch refresh's margin half", () => {
  it("copies the template's missing rows (16), then adds 0; an existing row is never touched", () => {
    // The template IS a seeded database (build-desktop.mjs generates it by running the seed).
    const tpl = path.join(t.dir, "seed-template.sqlite");
    fs.writeFileSync(tpl, t.sqlite.serialize());
    expect(dropNew()).toBe(16);
    t.sqlite.prepare("INSERT INTO margin_config (broker, segment, margin_pct, note) VALUES ('nuvama', 'eq_mtf', 40, 'mine')").run();
    const log: string[] = [];
    expect(refreshMarginRows(t.sqlite, tpl, (s: string) => log.push(s))).toEqual({ added: 15 });
    expect(count()).toBe(16);
    expect(rowsOf(["nuvama"]).find((r) => r.segment === "eq_mtf")).toMatchObject({ marginPct: 40, note: "mine" });
    expect(refreshMarginRows(t.sqlite, tpl, (s: string) => log.push(s))).toEqual({ added: 0 });
    expect(log).toEqual(["[vyuha] margin rates: 15 added (existing rows kept)", "[vyuha] margin rates: 0 added (existing rows kept)"]);
    expect(refreshMarginRows(t.sqlite, path.join(t.dir, "absent.sqlite"), () => {})).toEqual({ skipped: "no seed template bundled" });
  });
});
