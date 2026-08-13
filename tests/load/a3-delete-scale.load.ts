import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "../helpers/temp-db";
import { countStatements, report, time } from "./helpers/measure";

/**
 * A3 — deleting at scale.
 *
 * `deleteTradesByIds` passes the id list straight into eight `inArray(...)`
 * calls with no chunking. Drizzle expands `inArray` to one bound parameter per
 * element, and SQLite has a hard ceiling on parameters per statement
 * (`SQLITE_MAX_VARIABLE_NUMBER`, 32,766 on a modern build) — above it the
 * statement does not run slowly, it THROWS.
 *
 * That ceiling is reachable through the UI, not just in theory: the
 * "delete by account" and "delete by broker" scopes resolve client-side to a
 * full id list and arrive as one comma-separated field, so nothing bounds the
 * array except how many trades the user has. A trader with 40,000 rows who
 * picks "delete everything in this account" is above it.
 *
 * The limit is READ FROM THE LINKED BUILD rather than hard-coded: better-sqlite3
 * vendors its own SQLite and the number is a compile-time choice, so asserting
 * against a literal 32766 would be asserting about a different library than the
 * one actually running.
 */

let t: TempDb;
let del: typeof import("@/lib/queries/delete");
let paramLimit: number;

beforeAll(async () => {
  t = await openTempDb("a3-delete-scale", { seed: true });
  del = await import("@/lib/queries/delete");

  // SQLITE_LIMIT_VARIABLE_NUMBER is id 9. better-sqlite3 does not expose
  // sqlite3_limit(), so probe it: bind N parameters and grow until it refuses.
  paramLimit = (() => {
    let lo = 1;
    let hi = 1_000_000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try {
        t.sqlite.prepare(`SELECT 1 WHERE 1 IN (${new Array(mid).fill("?").join(",")})`);
        lo = mid;
      } catch {
        hi = mid - 1;
      }
    }
    return lo;
  })();
  console.log(`    SQLite parameter ceiling on this build: ${paramLimit.toLocaleString()}`);
});
afterAll(() => t?.cleanup());

function seedTrades(count: number): number[] {
  const ids: number[] = [];
  // One transaction — seeding must not dominate the measurement. Drizzle's
  // better-sqlite3 transaction() runs the callback immediately (it is not the
  // curried better-sqlite3 form), so there is no trailing call here.
  t.db.transaction((tx) => {
    for (let i = 0; i < count; i++) {
      const row = tx.insert(t.schema.trades).values(tradeRow({ symbol: `S${i}` })).returning({ id: t.schema.trades.id }).get();
      ids.push(row.id);
    }
  });
  return ids;
}

describe("A3 · bulk delete against the SQLite parameter ceiling", () => {
  it("deletes more trades than SQLite allows bound parameters", () => {
    // Deliberately just over the ceiling — the smallest book that proves it,
    // rather than a 250k seed that spends the budget on setup.
    const count = paramLimit + 50;
    const ids = seedTrades(count);
    expect(ids.length).toBe(count);

    const t0 = performance.now();
    let result: ReturnType<typeof del.deleteTradesByIds> | null = null;
    let threw: Error | null = null;
    try {
      result = del.deleteTradesByIds(ids, "load test: whole-account delete");
    } catch (e) {
      threw = e as Error;
    }
    report(time(`delete ${count.toLocaleString()} trades (ceiling ${paramLimit.toLocaleString()})`, count, () => {}), {
      test: "a3-ceiling",
      paramLimit,
      ms: performance.now() - t0,
      threw: threw?.message ?? null,
    });

    expect(
      threw,
      `deleting ${count.toLocaleString()} trades threw: "${threw?.message}". ` +
        "deleteTradesByIds passes the whole id list into inArray() with no chunking, and the " +
        "delete-by-account and delete-by-broker scopes resolve to an unbounded id list in the UI.",
    ).toBeNull();
    expect(result?.ok, result?.message).toBe(true);
    expect(result?.deleted).toBe(count);
    expect(t.db.select().from(t.schema.trades).all().length).toBe(0);
  });

  it("does not issue one statement per trade", () => {
    const ids = seedTrades(2_000);
    const { statements } = countStatements(t.sqlite, () => del.deleteTradesByIds(ids, "load test: statement count"));
    console.log(`    statements for a 2,000-trade delete: ${statements}`);
    report(time("statements for 2,000-trade delete", 2_000, () => {}), { test: "a3-statements", statements });

    // Generous: the operation legitimately touches trades, legs, attachments,
    // ledger, ipos, audit and the trash snapshot. What it must NOT do is scale
    // with the number of trades.
    expect(
      statements,
      `${statements} statements for 2,000 trades — that is per-row work in a bulk path.`,
    ).toBeLessThan(300);
  });
});
