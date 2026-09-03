import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Migration 0060 — `trades_fts` (FTS5, external content, trigram) kept in
 * step with `trades` by triggers, plus three lookup indexes.
 *
 * Rows go in through the ordinary Drizzle insert/update/delete path — the
 * same path every import, journal save and account purge uses — so what is
 * asserted here is what the app will see. One temp database per FILE.
 */

const migrationsDir = path.join(process.cwd(), "drizzle");
let t: TempDb;

/** rowids matching an FTS5 query — the exact statement Search v1 will run. */
const search = (q: string) =>
  (t.sqlite.prepare("SELECT rowid AS id FROM trades_fts WHERE trades_fts MATCH ? ORDER BY rowid").all(q) as { id: number }[]).map((r) => r.id);

const insert = (over: Record<string, unknown>) =>
  t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get()!.id;

beforeAll(async () => {
  t = await openTempDb("m0060", { seed: true });
});

afterAll(() => t?.cleanup());

describe("migration 0060 applies", () => {
  it("is journalled — a hand-written migration with no entry is silently skipped", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string; version: string; breakpoints: boolean }[];
    };
    const entry = journal.entries.find((e) => e.tag === "0060_trades-fts");
    expect(entry, "0060 is not in _journal.json — nothing would apply it").toBeTruthy();
    expect(entry!.idx).toBe(60);
    expect(entry!.version).toBe("6");
    expect(entry!.breakpoints).toBe(true);
    const idxs = journal.entries.map((e) => e.idx);
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
    expect(new Set(idxs).size).toBe(idxs.length);
  });

  it("creates trades_fts, its content view and the four sync triggers", () => {
    const objects = t.sqlite
      .prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'trades_fts%' ORDER BY name")
      .all() as { type: string; name: string }[];
    const byName = Object.fromEntries(objects.map((o) => [o.name, o.type]));
    expect(byName.trades_fts).toBe("table");
    expect(byName.trades_fts_src).toBe("view");
    expect(byName.trades_fts_ai).toBe("trigger");
    expect(byName.trades_fts_au).toBe("trigger");
    expect(byName.trades_fts_bd).toBe("trigger");
    expect(byName.trades_fts_bu).toBe("trigger");
  });

  it("ends with the rebuild that indexes rows present before the upgrade", () => {
    const sql = fs.readFileSync(path.join(migrationsDir, "0060_trades-fts.sql"), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.trim());
    expect(statements.at(-1)).toMatch(/^INSERT INTO `trades_fts`\(`trades_fts`\) VALUES \('rebuild'\);$/);
    // Every trigger is its own breakpoint chunk: drizzle hands each chunk to
    // better-sqlite3's prepare(), which takes ONE statement — a BEGIN…END
    // trigger body is one statement, two of them in a chunk is an error.
    const triggerChunks = statements.filter((s) => /CREATE TRIGGER/.test(s));
    expect(triggerChunks).toHaveLength(4);
    for (const c of triggerChunks) expect(c.match(/CREATE TRIGGER/g)).toHaveLength(1);
  });

  it("creates the three lookup indexes, and schema.ts mirrors them", () => {
    const names = (t.sqlite.prepare("PRAGMA index_list('trades')").all() as { name: string }[]).map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["trades_symbol_idx", "trades_isin_idx", "trades_tradingsymbol_idx"]));
    const declared = getTableConfig(t.schema.trades).indexes.map((i) => i.config.name);
    expect(declared).toEqual(expect.arrayContaining(["trades_symbol_idx", "trades_isin_idx", "trades_tradingsymbol_idx"]));
  });
});

describe("trades_fts follows the Drizzle write path", () => {
  it("a mid-word trigram finds a freshly inserted note", () => {
    const id = insert({ notes: "breakout retest" });
    expect(search("kou")).toEqual([id]);
    expect(search("retest")).toEqual([id]);
  });

  it("an update drops the old term and indexes the new one", () => {
    const id = insert({ notes: "pullback entry" });
    expect(search("pullback")).toEqual([id]);
    t.db.update(t.schema.trades).set({ notes: "gap fill" }).where(eq(t.schema.trades.id, id)).run();
    expect(search("pullback")).toEqual([]);
    expect(search("gap fill")).toEqual([id]);
  });

  it("a delete removes the row from the index", () => {
    const id = insert({ notes: "capitulation candle" });
    expect(search("capitul")).toEqual([id]);
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, id)).run();
    expect(search("capitul")).toEqual([]);
  });

  it("mistake_tags JSON is indexed as its words, not its punctuation", () => {
    const id = insert({ mistakeTags: ["fomo", "chased"] });
    expect(t.sqlite.prepare("SELECT mistake_tags AS m FROM trades WHERE id = ?").get(id)).toEqual({ m: '["fomo","chased"]' });
    expect(search("fomo")).toEqual([id]);
    expect(search("chased")).toEqual([id]);
    expect(search('"[""f"')).toEqual([]);
    // FTS5 string syntax: a doubled quote inside "…" is a literal quote, so
    // this asks for the raw JSON fragment  fomo","  and must find nothing.
    expect(search('"fomo"","""'), "the JSON separator must not be indexed").toEqual([]);
  });

  it("an invalid-JSON mistake_tags value does not break the insert and is indexed raw", () => {
    const stmt = t.sqlite.prepare(
      `INSERT INTO trades (account_id, broker, bucket, segment, instrument_type, exchange, symbol, tradingsymbol, dedup_hash, mistake_tags)
       VALUES (1, 'dhan', 'equity', 'eq_delivery', 'equity', 'NSE', 'TCS', 'TCS', 'fts-invalid-json', 'not json at all')`,
    );
    expect(() => stmt.run()).not.toThrow();
    const id = (t.sqlite.prepare("SELECT id FROM trades WHERE dedup_hash = 'fts-invalid-json'").get() as { id: number }).id;
    expect(search("not json")).toEqual([id]);
  });

  it("searches symbol, tradingsymbol, isin, broker and the journal tags", () => {
    const id = insert({
      symbol: "RELIANCE", tradingsymbol: "RELIANCE-EQ", isin: "INE002A01018", broker: "zerodha",
      setupTag: "vcp", emotionTag: "anxious", exitTrigger: "trailing stop",
    });
    expect(search("relian")).toEqual([id]);
    expect(search('"NCE-EQ"'), "a hyphen is an FTS5 operator unless the term is quoted").toEqual([id]);
    expect(search("002A0")).toEqual([id]);
    expect(search("zerodha")).toEqual([id]);
    expect(search("vcp")).toEqual([id]);
    expect(search("anxious")).toEqual([id]);
    expect(search("trailing")).toEqual([id]);
  });

  it("the index passes FTS5's own integrity check after all of the above", () => {
    expect(() => t.sqlite.prepare("INSERT INTO trades_fts(trades_fts) VALUES ('integrity-check')").run()).not.toThrow();
  });
});
