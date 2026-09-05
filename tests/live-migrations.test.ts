import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Migrations 0064 (`risk_config` risk columns) and 0065 (the Atlas cache).
 *
 * ONE temp database for the whole file — `lib/db` caches its connection on
 * globalThis, so a second `openTempDb()` here would silently reuse this one and
 * every assertion after it would be meaningless.
 *
 * What is actually being protected:
 *   * `risk_pct_ppm` is the input every sizing method needs, and it is
 *     NULLABLE. A default of 2% would put a risk figure the user never chose on
 *     every risk column in the product (invariant 6).
 *   * `deploy_cap_ppm` is the one column WITH a default, because a cap that is
 *     off until switched on is not a cap.
 *   * the Atlas tables are a CACHE: no `account_id` (invariant 8 has nothing to
 *     own here) and deliberately outside BACKUP_TABLES.
 *   * the down path is exercised once, so the rollback in the wave card is a
 *     tested claim rather than a sentence.
 */

let t: TempDb;

const cols = (table: string) => t.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
const colNames = (table: string) => cols(table).map((c) => c.name);
const tableExists = (name: string) =>
  (t.sqlite.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(name) as { n: number }).n === 1;

beforeAll(async () => {
  t = await openTempDb("live-migrations");
});
afterAll(() => t?.cleanup());

describe("the drizzle journal", () => {
  it("registers 0064 and 0065, and each tag has a matching .sql file", () => {
    // Migrations 0027+ are hand-written: the .sql file plus a _journal.json
    // entry IS the convention (see how 0063 landed). A file with no entry never
    // runs; an entry with no file makes `migrate()` throw on every install.
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags).toContain("0064_live-desk-risk");
    expect(tags).toContain("0065_atlas-daily");
    for (const e of journal.entries) {
      expect(fs.existsSync(path.join(process.cwd(), "drizzle", `${e.tag}.sql`)), `${e.tag}.sql is missing`).toBe(true);
    }
    // Indexes are contiguous and ordered — a gap means a migration was dropped.
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });
});

describe("0064 — risk_config gains the sizing inputs", () => {
  it("adds all seven columns", () => {
    expect(colNames("risk_config")).toEqual(
      expect.arrayContaining([
        "risk_pct_ppm",
        "stop_method",
        "stop_atr_len",
        "stop_atr_mult_permille",
        "stop_default_pct_ppm",
        "deploy_cap_ppm",
        "heat_ceiling_ppm",
      ]),
    );
  });

  it("keeps every pre-existing column — the migration is purely additive", () => {
    expect(colNames("risk_config")).toEqual(
      expect.arrayContaining(["id", "scope", "key", "per_trade_max_loss", "max_open", "max_trades_day", "daily_loss_stop", "concentration_pct", "updated_at"]),
    );
  });

  it("ships risk_pct_ppm NULL, so the 'risk not set' call to action can fire", () => {
    t.sqlite.prepare("INSERT INTO risk_config (scope, key) VALUES ('global','')").run();
    const row = t.sqlite.prepare("SELECT * FROM risk_config WHERE scope='global' AND key=''").get() as Record<string, unknown>;
    expect(row.risk_pct_ppm).toBeNull();
    expect(row.stop_method).toBeNull();
    expect(row.stop_atr_len).toBeNull();
    expect(row.stop_atr_mult_permille).toBeNull();
    expect(row.stop_default_pct_ppm).toBeNull();
    // Vyuha asserts no heat ceiling of its own; the 6% figure is trading lore.
    expect(row.heat_ceiling_ppm).toBeNull();
  });

  it("defaults deploy_cap_ppm to 25%, because a cap that is off is not a cap", () => {
    const row = t.sqlite.prepare("SELECT deploy_cap_ppm FROM risk_config WHERE scope='global' AND key=''").get() as { deploy_cap_ppm: number };
    expect(row.deploy_cap_ppm).toBe(250_000);
    const meta = cols("risk_config").find((c) => c.name === "deploy_cap_ppm")!;
    expect(meta.notnull).toBe(1);
    expect(meta.dflt_value).toBe("250000");
  });

  it("stores percentages as INTEGER ppm, never REAL", () => {
    for (const name of ["risk_pct_ppm", "stop_default_pct_ppm", "deploy_cap_ppm", "heat_ceiling_ppm", "stop_atr_mult_permille", "stop_atr_len"]) {
      expect(cols("risk_config").find((c) => c.name === name)!.type.toLowerCase(), name).toBe("integer");
    }
  });

  it("the drizzle schema names the same columns the database has", async () => {
    const { getTableConfig } = await import("drizzle-orm/sqlite-core");
    const declared = getTableConfig(t.schema.riskConfig).columns.map((c) => c.name);
    for (const name of ["risk_pct_ppm", "stop_method", "stop_atr_len", "stop_atr_mult_permille", "stop_default_pct_ppm", "deploy_cap_ppm", "heat_ceiling_ppm"]) {
      expect(declared, `schema.ts is missing ${name}`).toContain(name);
    }
    // A schema describing columns the DB lacks typechecks and dies at runtime,
    // so assert the other direction too.
    for (const name of declared) expect(colNames("risk_config"), `the DB is missing ${name}`).toContain(name);
  });
});

describe("0065 — the Atlas cache", () => {
  it("creates all three tables", () => {
    expect(tableExists("atlas_daily")).toBe(true);
    expect(tableExists("atlas_metric")).toBe(true);
    expect(tableExists("atlas_staleness")).toBe(true);
  });

  it("atlas_daily is keyed on the ANCHOR session and carries its provenance", () => {
    expect(colNames("atlas_daily")).toEqual(
      expect.arrayContaining([
        "as_of",
        "generated_at",
        "spec_version",
        "source_mode",
        "input_checksum",
        "universe_included",
        "universe_excluded",
        "anchor_coverage",
        "anchor_coverage_ppm",
        "payload_json",
      ]),
    );
    expect(cols("atlas_daily").find((c) => c.name === "as_of")!.notnull).toBe(1);
    // spec_version is semver on the FORMULA SET; without it a redefinition
    // silently mixes two different metrics in one series.
    expect(cols("atlas_daily").find((c) => c.name === "spec_version")!.notnull).toBe(1);
    expect(cols("atlas_daily").find((c) => c.name === "input_checksum")!.notnull).toBe(1);
  });

  it("every atlas_metric row can carry its own denominator and coverage", () => {
    expect(colNames("atlas_metric")).toEqual(
      expect.arrayContaining(["as_of", "metric", "group_kind", "group_name", "value_ppm", "numerator", "denominator", "coverage_ppm", "insufficient_history"]),
    );
    // Nullable on purpose: a missing denominator makes the FIGURE null, and a
    // NOT NULL column here would have forced a 0 (invariant 6).
    expect(cols("atlas_metric").find((c) => c.name === "denominator")!.notnull).toBe(0);
    expect(cols("atlas_metric").find((c) => c.name === "value_ppm")!.notnull).toBe(0);
  });

  it("(as_of, metric, group_kind, group_name) is unique — one figure per cell", () => {
    const ins = t.sqlite.prepare("INSERT INTO atlas_metric (as_of, metric, group_kind, group_name, numerator, denominator) VALUES (?,?,?,?,?,?)");
    ins.run("2026-09-04", "A1", "market", "*", 1_200, 2_000);
    expect(() => ins.run("2026-09-04", "A1", "market", "*", 999, 2_000)).toThrow(/UNIQUE/i);
    // A different group is a different cell and is admitted.
    ins.run("2026-09-04", "A1", "sector", "IT", 40, 60);
    expect((t.sqlite.prepare("SELECT count(*) AS n FROM atlas_metric").get() as { n: number }).n).toBe(2);
  });

  it("group_name defaults to '*' for a market-wide figure", () => {
    t.sqlite.prepare("INSERT INTO atlas_metric (as_of, metric, group_kind) VALUES ('2026-09-05','A7','market')").run();
    const row = t.sqlite.prepare("SELECT group_name, insufficient_history FROM atlas_metric WHERE as_of='2026-09-05'").get() as {
      group_name: string;
      insufficient_history: number;
    };
    expect(row.group_name).toBe("*");
    expect(row.insufficient_history).toBe(0);
  });

  it("atlas_staleness records one reason per symbol, and the same symbol may have two", () => {
    const ins = t.sqlite.prepare("INSERT INTO atlas_staleness (as_of, symbol, reason, last_seen_date, sessions_behind) VALUES (?,?,?,?,?)");
    ins.run("2026-09-04", "TCS", "no_bar_on_anchor", "2026-09-01", 3);
    ins.run("2026-09-04", "TCS", "corporate_action_unreconciled", "2026-09-01", 3);
    expect(() => ins.run("2026-09-04", "TCS", "no_bar_on_anchor", "2026-09-01", 3)).toThrow(/UNIQUE/i);
  });

  it("carries NO account_id: market breadth is a property of the market, not a book", () => {
    for (const table of ["atlas_daily", "atlas_metric", "atlas_staleness"]) {
      expect(colNames(table), table).not.toContain("account_id");
    }
  });

  it("is deliberately OUTSIDE the backup: it is a cache, reproducible from price_history", async () => {
    const { BACKUP_TABLES } = await import("@/lib/backup-format");
    for (const table of ["atlas_daily", "atlas_metric", "atlas_staleness"]) {
      expect(BACKUP_TABLES as readonly string[], table).not.toContain(table);
    }
    // risk_config, which holds what the USER set, stays in the backup.
    expect(BACKUP_TABLES as readonly string[]).toContain("risk_config");
  });
});

describe("the down path", () => {
  it("drops cleanly and loses no journal data, because nothing in v3.9.1 read it", () => {
    const tradesBefore = (t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n;

    for (const c of ["risk_pct_ppm", "stop_method", "stop_atr_len", "stop_atr_mult_permille", "stop_default_pct_ppm", "deploy_cap_ppm", "heat_ceiling_ppm"]) {
      t.sqlite.exec(`ALTER TABLE risk_config DROP COLUMN ${c}`);
    }
    t.sqlite.exec("DROP TABLE atlas_staleness");
    t.sqlite.exec("DROP TABLE atlas_metric");
    t.sqlite.exec("DROP TABLE atlas_daily");

    for (const c of ["risk_pct_ppm", "deploy_cap_ppm", "heat_ceiling_ppm"]) expect(colNames("risk_config")).not.toContain(c);
    expect(tableExists("atlas_daily")).toBe(false);
    // The columns that existed before 0064 survive, and so does the book.
    expect(colNames("risk_config")).toEqual(expect.arrayContaining(["scope", "key", "per_trade_max_loss", "max_open"]));
    expect((t.sqlite.prepare("SELECT count(*) AS n FROM risk_config").get() as { n: number }).n).toBeGreaterThan(0);
    expect((t.sqlite.prepare("SELECT count(*) AS n FROM trades").get() as { n: number }).n).toBe(tradesBefore);
  });
});
