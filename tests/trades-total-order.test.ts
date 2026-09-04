import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * (sell_date, created_at) IS NOT A TOTAL ORDER — v3.9.
 *
 * `created_at` defaults to `datetime('now')`, which has SECOND resolution, and
 * `lib/import/commit.ts` never sets it — so every row of one import batch
 * carries the SAME `created_at`. On the owner's book that is 842 of 905 rows
 * sitting in 174 tie blocks, the largest 36 rows wide.
 *
 * Ordering by (sell_date DESC, created_at DESC) therefore leaves the order
 * WITHIN a batch unspecified: SQLite is free to return those rows in any
 * order, and it demonstrably returns different orders for different plans
 * (the /trades first page of the owner's primary account came back
 * ASCENDING by id, while the all-accounts view of the same rows came back
 * DESCENDING). Row order feeds visible row order AND float-summation order,
 * so "unspecified" is not acceptable on a page that states money.
 *
 * v3.9 ends every projection in `lib/queries/trades.ts` on `id DESC` —
 * AUTOINCREMENT, therefore unique, therefore a total order — which makes the
 * order within a batch INSERTION order, newest first.
 *
 * This test inserts three rows that tie on both keys in ONE transaction and
 * pins the projection order to id DESC.
 */

let t: TempDb;
let trades: typeof import("@/lib/queries/trades");

const TIED_SELL_DATE = "2026-03-31";
const TIED_CREATED_AT = "2026-04-01 09:15:00";

beforeAll(async () => {
  t = await openTempDb("total-order", { seed: true });
  trades = await import("@/lib/queries/trades");

  // One transaction, one `created_at`, one `sell_date` — an import batch.
  t.db.transaction((tx) => {
    tx.insert(t.schema.trades).values([
      tradeRow({ symbol: "AAA", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
      tradeRow({ symbol: "BBB", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
      tradeRow({ symbol: "CCC", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
    ]).run();
  });
});

afterAll(() => t?.cleanup());

describe("the book has a total order", () => {
  it("all three rows really do tie on (sell_date, created_at)", () => {
    const row = t.sqlite
      .prepare(
        `select count(*) as c from (select sell_date, created_at, count(*) n from trades
           group by sell_date, created_at having n > 1)`,
      )
      .get() as { c: number };
    expect(row.c).toBe(1);
  });

  it("orders tied rows by id DESC in every projection", () => {
    const ids = t.sqlite.prepare("select id from trades order by id").all().map((r) => (r as { id: number }).id);
    const newestFirst = [...ids].reverse();

    expect(trades.getJournalTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getSlimTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getLensTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getArjunTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getTaxTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getHarvestTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getTrackerTrades().map((r) => r.id)).toEqual(newestFirst);
    expect(trades.getTrades().map((r) => r.id)).toEqual(newestFirst);
  });
});
