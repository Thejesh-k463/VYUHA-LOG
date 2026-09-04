import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Migration 0062 — `broker_reference`, the table that holds the figures the
 * BROKER states so they can sit beside the ones Vyuha derives.
 *
 * The assertions that matter are the two the table exists FOR:
 *   1. account_id is NOT NULL — this table is account-scoped (invariant 8).
 *   2. re-importing the same statement OVERWRITES the figure it restates.
 *      SQLite treats NULLs in a unique index as DISTINCT, so an FY total
 *      (as_of NULL) imported twice would be admitted twice and the broker's
 *      side of a reconciliation would silently double. The index coalesces.
 *
 * One temp database per FILE.
 */

const migrationsDir = path.join(process.cwd(), "drizzle");
let t: TempDb;

const cols = () => t.sqlite.prepare("PRAGMA table_info('broker_reference')").all() as { name: string; notnull: number; type: string; dflt_value: string | null }[];

/** The INSERT the commit path uses: replace on conflict, keeping id/created_at. */
function put(row: Record<string, unknown>) {
  const v = {
    accountId: 1, broker: "paytm", sourceId: "paytm-realised-pnl", scope: "fy",
    key: "2026-27", isin: null, symbol: null, fy: "2026-27", asOf: null,
    figuresJson: "{}", note: null, importBatchId: null, ...row,
  };
  t.sqlite.prepare(
    `INSERT INTO broker_reference (account_id, broker, source_id, scope, "key", isin, symbol, fy, as_of, figures_json, note, import_batch_id)
     VALUES (@accountId, @broker, @sourceId, @scope, @key, @isin, @symbol, @fy, @asOf, @figuresJson, @note, @importBatchId)
     ON CONFLICT (account_id, broker, source_id, scope, "key", coalesce(as_of, '')) DO UPDATE SET
       isin = excluded.isin, symbol = excluded.symbol, fy = excluded.fy,
       figures_json = excluded.figures_json, note = excluded.note,
       import_batch_id = excluded.import_batch_id`,
  ).run(v);
}

const all = () => t.sqlite.prepare(`SELECT id, "key", as_of, figures_json FROM broker_reference ORDER BY id`).all() as { id: number; key: string; as_of: string | null; figures_json: string }[];

beforeAll(async () => {
  t = await openTempDb("m0062", { seed: true });
});

afterAll(() => t?.cleanup());

describe("migration 0062 applies", () => {
  it("is journalled — a hand-written migration with no entry is silently skipped", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0062_broker-reference");
    expect(entry, "0062 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect(entry!.idx).toBe(62);
    expect(entry!.version).toBe("6");
    expect(entry!.breakpoints).toBe(true);
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it("creates every column the reference contract needs", () => {
    const names = cols().map((c) => c.name);
    expect(names).toEqual([
      "id", "account_id", "broker", "source_id", "scope", "key", "isin", "symbol",
      "fy", "as_of", "figures_json", "note", "import_batch_id", "created_at",
    ]);
  });

  it("makes account_id NOT NULL with no default — this table is account-scoped", () => {
    const acct = cols().find((c) => c.name === "account_id")!;
    expect(acct.notnull).toBe(1);
    expect(acct.dflt_value, "a default account_id lets an unscoped write look correct").toBeNull();
    expect(() =>
      t.sqlite.prepare(`INSERT INTO broker_reference (broker, source_id, scope, "key") VALUES ('dhan', 'x', 'fy', '2026-27')`).run(),
    ).toThrow(/NOT NULL/);
  });

  it("creates the unique identity index and the two lookup indexes, and schema.ts mirrors them", () => {
    const names = (t.sqlite.prepare("PRAGMA index_list('broker_reference')").all() as { name: string; unique: number }[]);
    const byName = Object.fromEntries(names.map((i) => [i.name, i.unique]));
    expect(byName.broker_reference_uq).toBe(1);
    expect(byName).toHaveProperty("broker_reference_fy_idx");
    expect(byName).toHaveProperty("broker_reference_isin_idx");
    const declared = getTableConfig(t.schema.brokerReference).indexes.map((i) => i.config.name);
    expect(declared).toEqual(expect.arrayContaining(["broker_reference_uq", "broker_reference_fy_idx", "broker_reference_isin_idx"]));
  });
});

describe("re-importing the same statement overwrites rather than duplicates", () => {
  it("a second import of the same FY total replaces the first, keeping one row and its id", () => {
    put({ figuresJson: JSON.stringify({ grossPnl: 100 }) });
    const first = all();
    expect(first).toHaveLength(1);
    put({ figuresJson: JSON.stringify({ grossPnl: 21371252.57 }) });
    const second = all();
    expect(second, "an FY total imported twice must not be admitted twice — as_of is NULL on both").toHaveLength(1);
    expect(second[0].id, "ON CONFLICT DO UPDATE keeps the row, so nothing referencing it dangles").toBe(first[0].id);
    expect(JSON.parse(second[0].figures_json)).toEqual({ grossPnl: 21371252.57 });
  });

  it("the same scrip on two different sell dates is two figures, not one", () => {
    put({ scope: "scrip", key: "INE600Y01019", asOf: "2026-07-20", figuresJson: JSON.stringify({ qty: 300 }) });
    put({ scope: "scrip", key: "INE600Y01019", asOf: "2026-08-12", figuresJson: JSON.stringify({ qty: 500 }) });
    const scrips = all().filter((r) => r.key === "INE600Y01019");
    expect(scrips.map((r) => r.as_of)).toEqual(["2026-07-20", "2026-08-12"]);
  });

  it("the same figure in another account is a separate row", () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).onConflictDoNothing().run();
    put({ accountId: 2, figuresJson: JSON.stringify({ grossPnl: -1 }) });
    const fyRows = all().filter((r) => r.key === "2026-27");
    expect(fyRows, "one book's broker figure must never overwrite another's").toHaveLength(2);
  });

  it("the same key under a different source_id is a separate row — two statements, two claims", () => {
    put({ sourceId: "dhan-realised-pnl", broker: "dhan", figuresJson: JSON.stringify({ grossPnl: 7 }) });
    expect(all().filter((r) => r.key === "2026-27")).toHaveLength(3);
  });
});
