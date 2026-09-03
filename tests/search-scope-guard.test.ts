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

  it("every account-scoped source in the registry is covered by the filter proof above", () => {
    const proven = new Set(scoped.map((s) => s.key));
    for (const key of SOURCE_KEYS) {
      if (SOURCES[key].scope === "account") expect(proven.has(key), `${key} is account-scoped but has no filter proof in this file`).toBe(true);
    }
  });
});
