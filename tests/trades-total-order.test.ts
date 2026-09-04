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
let page: typeof import("@/lib/queries/trades-page");

/**
 * Ids inserted OUT OF ORDER, inside the same tie block.
 *
 * The three rows above are inserted in id order, so `id DESC` and "reverse
 * insertion order" are the same list — and SQLite's own scan happens to
 * produce one of them either way, which is why reverting the `desc(trades.id)`
 * clauses left this file green. These three separate the two: insertion order
 * is 903, 901, 902 while id order is 901, 902, 903, so a projection that does
 * not sort on id cannot land on 903, 902, 901 by accident.
 */
const OUT_OF_ORDER_IDS = [903, 901, 902];

const TIED_SELL_DATE = "2026-03-31";
const TIED_CREATED_AT = "2026-04-01 09:15:00";

beforeAll(async () => {
  t = await openTempDb("total-order", { seed: true });
  trades = await import("@/lib/queries/trades");
  page = await import("@/lib/queries/trades-page");

  // One transaction, one `created_at`, one `sell_date` — an import batch.
  t.db.transaction((tx) => {
    tx.insert(t.schema.trades).values([
      tradeRow({ symbol: "AAA", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
      tradeRow({ symbol: "BBB", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
      tradeRow({ symbol: "CCC", isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }),
    ]).run();
  });

  // The same tie block, with EXPLICIT ids in an order that is not the
  // insertion order — inserted one statement at a time so the rowids really do
  // land 903, 901, 902.
  for (const id of OUT_OF_ORDER_IDS) {
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({ id, symbol: `X${id}`, isOpen: false, sellDate: TIED_SELL_DATE, createdAt: TIED_CREATED_AT }))
      .run();
  }
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

  it("sorts on the ID, not on insertion order — every projection AND getTradesPage", () => {
    // Insertion order was 903, 901, 902; id order is 901, 902, 903. Only a
    // sort on `id DESC` produces 903, 902, 901 — reverse-insertion order would
    // give 902, 901, 903 and a plain rowid scan 901, 902, 903.
    const expected = [...OUT_OF_ORDER_IDS].sort((a, b) => b - a);
    expect(expected).toEqual([903, 902, 901]);

    const head = (ids: number[]) => ids.filter((id) => OUT_OF_ORDER_IDS.includes(id));

    for (const [name, rows] of Object.entries({
      getJournalTrades: trades.getJournalTrades(),
      getSlimTrades: trades.getSlimTrades(),
      getLensTrades: trades.getLensTrades(),
      getArjunTrades: trades.getArjunTrades(),
      getTaxTrades: trades.getTaxTrades(),
      getHarvestTrades: trades.getHarvestTrades(),
      getTrackerTrades: trades.getTrackerTrades(),
      getTrades: trades.getTrades(),
    })) {
      expect(head((rows as { id: number }[]).map((r) => r.id)), `${name} does not order tied rows by id`).toEqual(expected);
    }

    // The keyset pager is the SAME order or the page boundary is wrong.
    const first = page.getTradesPage(page.EMPTY_TRADES_PAGE_FILTERS);
    expect(head(first.rows.map((r) => r.id)), "getTradesPage does not order tied rows by id").toEqual(expected);
    expect(page.getFilteredTradeIds(page.EMPTY_TRADES_PAGE_FILTERS).filter((id) => OUT_OF_ORDER_IDS.includes(id))).toEqual(expected);
    expect(page.getDeletableTrades().map((r) => r.id).filter((id) => OUT_OF_ORDER_IDS.includes(id))).toEqual(expected);
  });

  it("every ORDER BY the book issues ENDS on the id — the tiebreak, in the SQL that actually runs", () => {
    // The behavioural assertions above pin the CONTRACT, but they cannot on
    // their own falsify a missing tiebreak: every plan SQLite picks for these
    // queries is a DESCENDING index scan, and a descending scan happens to
    // hand back tied rows in reverse-rowid — i.e. id DESC — anyway. That
    // coincidence is exactly why `desc(trades.id)` could be reverted from BOTH
    // lib/queries/trades.ts and lib/queries/trades-page.ts with nothing going
    // red. It is a coincidence of the current indexes and the current row
    // count, not a guarantee: SQLite documents no order for tied rows, and the
    // owner's book demonstrably came back ASCENDING by id on one plan and
    // DESCENDING on another.
    //
    // So this asserts the SQL the app really issues, captured off the raw
    // connection — not a source regex (render-windowing.test.ts holds that
    // line) and not an order SQLite is free to change under us.
    const orig = t.sqlite.prepare.bind(t.sqlite);
    const seen: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t.sqlite as any).prepare = (sql: string) => {
      seen.push(sql);
      return orig(sql);
    };
    try {
      trades.getJournalTrades();
      trades.getSlimTrades();
      trades.getLensTrades();
      trades.getArjunTrades();
      trades.getTaxTrades();
      trades.getHarvestTrades();
      trades.getTrackerTrades();
      trades.getTrades();
      page.getTradesPage(page.EMPTY_TRADES_PAGE_FILTERS);
      page.getFilteredTradeIds(page.EMPTY_TRADES_PAGE_FILTERS);
      page.getDeletableTrades();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t.sqlite as any).prepare = orig;
    }

    const ordered = seen.filter((q) => /from "trades"/i.test(q) && /order by/i.test(q));
    expect(ordered.length, "no ordered query over `trades` was captured").toBeGreaterThanOrEqual(9);
    for (const q of ordered) {
      const tail = q.slice(q.toLowerCase().lastIndexOf("order by"));
      const cut = tail.toLowerCase().indexOf(" limit ");
      const clause = (cut === -1 ? tail : tail.slice(0, cut)).trim();
      expect(clause, `an ORDER BY over trades does not end on the id tiebreak: ${clause}`).toMatch(/"id"\s+desc\s*$/i);
    }
  });

  it("pages the tie block WITHOUT dropping or repeating a row (keyset needs the total order)", () => {
    const all = page.getFilteredTradeIds(page.EMPTY_TRADES_PAGE_FILTERS);
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const p: import("@/lib/queries/trades-page").TradesPage = page.getTradesPage(page.EMPTY_TRADES_PAGE_FILTERS, cursor, 2);
      seen.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(all);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
