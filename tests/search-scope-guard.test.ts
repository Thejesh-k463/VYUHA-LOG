import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { SOURCE_KEYS, SOURCES, type SourceKey } from "@/lib/domain/search-scope";

/**
 * Search v1 — the scope guard (invariant 8, applied to search).
 *
 * The registry in lib/domain/search-scope.ts says which sources are account
 * data. Nothing in the type system ties that to the schema, so this file
 * joins the two: every source whose table carries an `account_id` column must
 * declare `scope: "account"`, every account source's reader must take the
 * account id AND be shown to apply it against a real database, and a source
 * with no recognisable scope fails outright. A search that merged two books
 * would look perfectly normal on screen — that is the whole reason for this
 * test.
 *
 * One temp database per FILE; every import of lib/queries/* is dynamic.
 */

let t: TempDb;
let search: typeof import("@/lib/queries/search");
let schema: typeof import("@/lib/db/schema");

const PRIMARY = 1;
const SWING = 2;

beforeAll(async () => {
  t = await openTempDb("search-scope", { seed: true });
  search = await import("@/lib/queries/search");
  schema = await import("@/lib/db/schema");

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: PRIMARY, symbol: "TCS", notes: "clean breakout retest" }),
      tradeRow({ accountId: SWING, symbol: "INFY", notes: "breakout retest, chased" }),
    ])
    .run();
  t.db
    .insert(t.schema.tradingSessions)
    .values([
      { accountId: PRIMARY, sessionDate: "2026-07-01", thesis: "gap fade on banks" },
      { accountId: SWING, sessionDate: "2026-07-01", thesis: "gap fade on IT" },
    ])
    .run();
  t.db
    .insert(t.schema.advanceTaxChallans)
    .values([
      { accountId: PRIMARY, fy: "2026-27", paidOn: "2026-06-14", amount: 15000, note: "june instalment" },
      { accountId: SWING, fy: "2026-27", paidOn: "2026-06-15", amount: 5000, note: "june instalment" },
    ])
    .run();
  // Ledger (v3.9, Search v2) — account-scoped, and the FIRST source whose
  // scope is enforced by a JOIN rather than a drizzle `where`: `ledger_fts`
  // deliberately carries no account_id (migration 0061), so the reader must
  // join back to `ledger_entries` for it. That is exactly the kind of filter
  // that can be dropped without anything on screen looking wrong.
  t.db
    .insert(t.schema.ledgerEntries)
    .values([
      { accountId: PRIMARY, date: "2026-06-01", type: "charge", amountPaise: -5000, note: "brokerage truing-up alpha" },
      { accountId: SWING, date: "2026-06-02", type: "charge", amountPaise: -7000, note: "brokerage truing-up beta" },
    ])
    .run();
  // Audit is GLOBAL — audit_log has no account_id at all (0061 says so in as
  // many words), so it has nothing to scope by and must not pretend to.
  t.db
    .insert(t.schema.auditLog)
    .values([
      { ts: "2026-06-01T10:00:00.000Z", entity: "ledger", action: "create", summary: "recorded brokerage truing-up" },
    ])
    .run();
});

afterAll(() => t?.cleanup());

/** table name → its drizzle table, from the schema module's exports. */
function schemaTables(): Map<string, SQLiteTable> {
  const out = new Map<string, SQLiteTable>();
  for (const v of Object.values(schema)) if (is(v, SQLiteTable)) out.set(getTableName(v), v);
  return out;
}

const hasAccountColumn = (table: SQLiteTable) => Object.values(getTableColumns(table)).some((c) => c.name === "account_id");

describe("registry ↔ schema", () => {
  it("every source declares a scope the registry understands", () => {
    for (const key of SOURCE_KEYS) {
      const spec = SOURCES[key] as { scope?: unknown };
      expect(["account", "global"], `${key} has no scope`).toContain(spec.scope);
    }
    expect(SOURCE_KEYS.length).toBeGreaterThan(0);
  });

  it("a source whose table has account_id is scope 'account'; one without is 'global'", () => {
    const tables = schemaTables();
    for (const key of SOURCE_KEYS) {
      const spec = SOURCES[key];
      if (!spec.table) {
        expect(spec.scope, `${key} reads no table, so it cannot be account data`).toBe("global");
        continue;
      }
      const table = tables.get(spec.table);
      expect(table, `${key} names table '${spec.table}', which lib/db/schema.ts does not export`).toBeDefined();
      const scoped = hasAccountColumn(table!);
      expect(spec.scope, `${key}: table '${spec.table}' ${scoped ? "HAS" : "has no"} account_id — the registry disagrees`).toBe(scoped ? "account" : "global");
    }
  });

  it("the tables this test relies on really carry account_id (guards the guard)", () => {
    const tables = schemaTables();
    expect(hasAccountColumn(tables.get("trades")!)).toBe(true);
    expect(hasAccountColumn(tables.get("trading_sessions")!)).toBe(true);
    expect(hasAccountColumn(tables.get("advance_tax_challans")!)).toBe(true);
    expect(hasAccountColumn(tables.get("playbooks")!)).toBe(false);
    expect(hasAccountColumn(tables.get("instruments")!)).toBe(false);
  });
});

describe("readers", () => {
  it("there is one reader per source, and every reader takes (q, accountId)", () => {
    for (const key of SOURCE_KEYS) {
      const reader = search.SOURCE_READERS[key];
      expect(typeof reader, `${key} has no reader`).toBe("function");
      expect(reader.length, `${key}'s reader must accept (q, accountId)`).toBe(2);
    }
    expect(Object.keys(search.SOURCE_READERS).sort()).toEqual([...SOURCE_KEYS].sort());
  });

  const scoped: { key: SourceKey; q: string }[] = [
    { key: "trades", q: "kou" },
    { key: "sessions", q: "gap fade" },
    { key: "challans", q: "june" },
    { key: "ledger", q: "truing" },
  ];

  it.each(scoped)("$key reader filters by the account id it is handed, and 0 means every account", ({ key, q }) => {
    expect(SOURCES[key].scope).toBe("account");
    const primary = search.SOURCE_READERS[key](q, PRIMARY);
    const swing = search.SOURCE_READERS[key](q, SWING);
    const all = search.SOURCE_READERS[key](q, 0);
    expect(primary, `${key}: nothing found for account ${PRIMARY}`).toHaveLength(1);
    expect(swing, `${key}: nothing found for account ${SWING}`).toHaveLength(1);
    expect(primary[0].id).not.toBe(swing[0].id);
    expect(all.map((r) => r.id).sort()).toEqual([primary[0].id, swing[0].id].sort());
  });

  it("the ledger reader's ids are the FTS's own rowids, which are ledger_entries.id", () => {
    const rows = t.sqlite
      .prepare("SELECT l.id AS id FROM ledger_fts f JOIN ledger_entries l ON l.id = f.rowid WHERE ledger_fts MATCH ? AND l.account_id = ?")
      .all('"truing"', PRIMARY) as { id: number }[];
    expect(rows).toHaveLength(1);
    expect(search.SOURCE_READERS.ledger("truing", PRIMARY).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("audit is global: its ids are audit_fts rowids and every account sees them", () => {
    const rows = t.sqlite
      .prepare("SELECT a.id AS id FROM audit_fts f JOIN audit_log a ON a.id = f.rowid WHERE audit_fts MATCH ?")
      .all('"truing"') as { id: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(SOURCES.audit.scope).toBe("global");
    for (const id of [PRIMARY, SWING, 0]) {
      expect(search.SOURCE_READERS.audit("truing", id).map((r) => r.id), `account ${id}`).toEqual(rows.map((r) => r.id));
    }
  });

  it("every account-scoped source in the registry is covered by the filter proof above", () => {
    const proven = new Set(scoped.map((s) => s.key));
    for (const key of SOURCE_KEYS) {
      if (SOURCES[key].scope === "account") expect(proven.has(key), `${key} is account-scoped but has no filter proof in this file`).toBe(true);
    }
  });
});
