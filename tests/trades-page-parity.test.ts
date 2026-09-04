import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { matchesTradeFilters, matchesTradeFiltersExceptView, type TradeFilters } from "@/lib/domain/trades-filter";
import { hasKnownBasis } from "@/lib/analytics/acquisition";
import { countViews, TRADE_VIEWS, type TradeView } from "@/lib/analytics/trade-status";

/**
 * THE SQL FILTER IS THE JS FILTER — v3.9.
 *
 * `/trades` now pages from the server, so the question "which rows belong in
 * this view?" is asked in SQL (`lib/queries/trades-page.ts`) instead of in the
 * browser over the whole book. That is only allowed if the SQL is a FAITHFUL
 * transcription: a predicate that is merely close silently under-counts, and a
 * table that quietly drops rows is worse than a slow one.
 *
 * So this file demands the two agree ID-FOR-ID — the SQL page against
 * `matchesTradeFilters` (lib/domain/trades-filter.ts, the pure predicate the
 * client itself runs) over the whole book — for every view the select offers
 * and every filter the URL contract carries, on a book seeded to hit every
 * arm: unmarked open positions, staged rows, null dates, a zero-cost sale
 * flagged `acquisition`, LIKE metacharacters in a ticker, and rows that tie on
 * (sell_date, created_at) so the keyset boundary is exercised.
 *
 * It also pages the whole book 3 rows at a time and demands the concatenation
 * equal the unpaginated order exactly — the property keyset pagination has
 * only because v3.9 made the order total.
 */

let t: TempDb;
let page: typeof import("@/lib/queries/trades-page");
let queries: typeof import("@/lib/queries/trades");

const TIED_CREATED = "2026-04-01 09:15:00";

/** Every row of the book in the shape both filters read. */
function book() {
  return queries.getJournalTrades();
}

function unknownBasisSet(): Set<number> {
  return new Set(book().filter((r) => !hasKnownBasis(r)).map((r) => r.id));
}

function jsIds(f: TradeFilters): number[] {
  const unknown = unknownBasisSet();
  return book()
    .filter((r) => matchesTradeFilters(r, f, (id) => unknown.has(id)))
    .map((r) => r.id);
}

function sqlIds(f: TradeFilters): number[] {
  return page.getTradesPage(f, null, 10_000).rows.map((r) => r.id);
}

const F = (over: Partial<TradeFilters> = {}): TradeFilters => ({
  q: "", broker: "", segment: "", bucket: "", view: "all",
  realised: false, basisUnknown: false, from: "", to: "", ...over,
});

beforeAll(async () => {
  t = await openTempDb("trades-page", { seed: true });
  page = await import("@/lib/queries/trades-page");
  queries = await import("@/lib/queries/trades");

  t.db.insert(t.schema.trades).values([
    // closed: profit / loss / flat
    tradeRow({ symbol: "TCS", tradingsymbol: "TCS", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 1200, buyDate: "2026-01-02", sellDate: "2026-01-09", setupTag: "orb", createdAt: TIED_CREATED }),
    tradeRow({ symbol: "INFY", tradingsymbol: "INFY", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: -400, buyDate: "2026-01-03", sellDate: "2026-01-09", createdAt: TIED_CREATED }),
    tradeRow({ symbol: "WIPRO", tradingsymbol: "WIPRO", broker: "zerodha", segment: "eq_intraday", bucket: "active", isOpen: false, netPnl: 0, buyDate: "2026-01-09", sellDate: "2026-01-09", createdAt: TIED_CREATED }),
    // open: marked gain / marked loss / marked flat / UNMARKED (neither view)
    tradeRow({ symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", broker: "groww", segment: "eq_delivery", bucket: "equity", isOpen: true, closingPrice: 1700, unrealisedPnl: 900, buyDate: "2026-02-01" }),
    tradeRow({ symbol: "SBIN", tradingsymbol: "SBIN", broker: "groww", segment: "eq_mtf", bucket: "equity", isOpen: true, closingPrice: 700, unrealisedPnl: -250, buyDate: "2026-02-02" }),
    tradeRow({ symbol: "ITC", tradingsymbol: "ITC", broker: "groww", segment: "eq_delivery", bucket: "equity", isOpen: true, closingPrice: 400, unrealisedPnl: 0, buyDate: "2026-02-03" }),
    tradeRow({ symbol: "LT", tradingsymbol: "LT", broker: "groww", segment: "eq_delivery", bucket: "equity", isOpen: true, closingPrice: null, unrealisedPnl: 0, buyDate: "2026-02-04" }),
    // a mark of 0 is NOT a mark (isMarked demands > 0)
    tradeRow({ symbol: "ZEROMARK", tradingsymbol: "ZEROMARK", broker: "groww", segment: "eq_delivery", bucket: "equity", isOpen: true, closingPrice: 0, unrealisedPnl: 0, buyDate: "2026-02-05" }),
    // staged, open and closed
    tradeRow({ symbol: "DIVISLAB", tradingsymbol: "DIVISLAB", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: true, staged: true, closingPrice: 5000, unrealisedPnl: 120, buyDate: "2026-03-01" }),
    tradeRow({ symbol: "CIPLA", tradingsymbol: "CIPLA", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, staged: true, netPnl: 55, buyDate: "2026-03-02", sellDate: "2026-03-06" }),
    // no dates at all — excluded the moment a window is set, by both filters
    tradeRow({ symbol: "NODATE", tradingsymbol: "NODATE", broker: "dhan", segment: "fno_futures", bucket: "active", isOpen: false, netPnl: 10, buyDate: null, sellDate: null }),
    // open with a sell date: the effective date is its ENTRY, not the exit
    tradeRow({ symbol: "PARTIAL", tradingsymbol: "PARTIAL", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: true, closingPrice: 100, unrealisedPnl: 5, buyDate: "2026-01-05", sellDate: "2026-12-31" }),
    // unknown cost basis: acquisition set, buyValue 0, no acquisitionPrice
    tradeRow({ symbol: "ORPHAN", tradingsymbol: "ORPHAN", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 900, buyValue: 0, acquisition: "unknown", acquisitionPrice: null, buyDate: null, sellDate: "2026-04-10" }),
    // …the same, but priced — a KNOWN basis
    tradeRow({ symbol: "ORPHANFIXED", tradingsymbol: "ORPHANFIXED", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 900, buyValue: 0, acquisition: "unknown", acquisitionPrice: 12.5, buyDate: null, sellDate: "2026-04-11" }),
    // …and an empty-string acquisition, which `!t.acquisition` calls known
    tradeRow({ symbol: "EMPTYACQ", tradingsymbol: "EMPTYACQ", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 5, buyValue: 0, acquisition: "", acquisitionPrice: null, sellDate: "2026-04-12" }),
    // LIKE metacharacters are literal text in a search box
    tradeRow({ symbol: "A%B", tradingsymbol: "A%B", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 1, sellDate: "2026-05-01" }),
    tradeRow({ symbol: "AXB", tradingsymbol: "AXB", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 1, sellDate: "2026-05-02" }),
    tradeRow({ symbol: "A_B", tradingsymbol: "A_B", broker: "dhan", segment: "eq_delivery", bucket: "equity", isOpen: false, netPnl: 1, sellDate: "2026-05-03" }),
    // a setup tag is part of the haystack; the symbol is not enough
    tradeRow({ symbol: "TATAMOTORS", tradingsymbol: "TATAMOTORS24JAN", broker: "dhan", segment: "fno_futures", bucket: "active", isOpen: false, netPnl: -70, setupTag: "pullback", sellDate: "2026-06-01" }),
  ]).run();
});

afterAll(() => t?.cleanup());

/** Every filter shape worth asking twice. */
const CASES: { name: string; f: TradeFilters }[] = [
  { name: "no filter", f: F() },
  ...TRADE_VIEWS.map((v) => ({ name: `view=${v.value}`, f: F({ view: v.value as TradeView }) })),
  { name: "broker", f: F({ broker: "dhan" }) },
  { name: "segment", f: F({ segment: "eq_delivery" }) },
  { name: "bucket", f: F({ bucket: "active" }) },
  { name: "realised", f: F({ realised: true }) },
  { name: "basisUnknown", f: F({ basisUnknown: true }) },
  { name: "from", f: F({ from: "2026-02-01" }) },
  { name: "to", f: F({ to: "2026-02-01" }) },
  { name: "window", f: F({ from: "2026-01-01", to: "2026-03-31" }) },
  { name: "window + open view (effective date is the ENTRY)", f: F({ view: "open", from: "2026-01-01", to: "2026-01-31" }) },
  { name: "text: symbol", f: F({ q: "tcs" }) },
  { name: "text: mixed case", f: F({ q: "TcS" }) },
  { name: "text: tradingsymbol only", f: F({ q: "24jan" }) },
  { name: "text: setup tag only", f: F({ q: "pullback" }) },
  { name: "text: literal %", f: F({ q: "a%b" }) },
  { name: "text: literal _", f: F({ q: "a_b" }) },
  { name: "text: no match", f: F({ q: "zzzznope" }) },
  { name: "everything at once", f: F({ broker: "dhan", segment: "eq_delivery", bucket: "equity", view: "closed", from: "2026-01-01", to: "2026-12-31", q: "s" }) },
  { name: "realised + basisUnknown + view", f: F({ realised: true, basisUnknown: true, view: "closed" }) },
];

describe("the SQL page filter is the JS filter", () => {
  it.each(CASES)("$name — same ids, same order", ({ f }) => {
    const js = jsIds(f);
    const sql = sqlIds(f);
    expect(sql).toEqual(js);
  });

  it("at least one row lands in every case, or the case proves nothing", () => {
    // A parity test that compares two empty arrays is a test that passes for
    // the wrong reason. Only the deliberately-empty case may be empty.
    for (const c of CASES) {
      const n = jsIds(c.f).length;
      if (c.name === "text: no match") expect(n).toBe(0);
      else expect(n, `${c.name} matched nothing`).toBeGreaterThan(0);
    }
  });

  it("view counts are the whole filtered set, not the page", () => {
    for (const c of CASES) {
      const unknown = unknownBasisSet();
      const base = book().filter((r) => matchesTradeFiltersExceptView(r, c.f, (id) => unknown.has(id)));
      expect(page.getViewCounts(c.f), c.name).toEqual(countViews(base));
      expect(page.countTrades(c.f), c.name).toBe(jsIds(c.f).length);
    }
  });

  it("`total` on a page of 3 still counts the whole set", () => {
    const p = page.getTradesPage(F(), null, 3);
    expect(p.rows).toHaveLength(3);
    expect(p.total).toBe(book().length);
    expect(p.viewCounts.all).toBe(book().length);
  });
});

describe("keyset pages concatenate to the unpaginated order", () => {
  it("pages the whole book 3 rows at a time with no gap and no repeat", () => {
    const expected = book().map((r) => r.id);
    const got: number[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const p: import("@/lib/queries/trades-page").TradesPage = page.getTradesPage(F(), cursor, 3);
      got.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
      if (++guard > 200) throw new Error("cursor never terminated");
    } while (cursor);
    expect(got).toEqual(expected);
    expect(new Set(got).size).toBe(got.length);
  });

  it("pages a FILTERED set the same way", () => {
    const f = F({ view: "closed" });
    const expected = jsIds(f);
    const got: number[] = [];
    let cursor: string | null = null;
    do {
      const p: import("@/lib/queries/trades-page").TradesPage = page.getTradesPage(f, cursor, 2);
      got.push(...p.rows.map((r) => r.id));
      cursor = p.nextCursor;
    } while (cursor);
    expect(got).toEqual(expected);
  });

  it("a malformed cursor is the first page, never an exception", () => {
    for (const bad of ["", "x", "a|b", "2026-01-01|x|y|z", "2026-01-01|2026|0"]) {
      expect(() => page.getTradesPage(F(), bad, 3)).not.toThrow();
      expect(page.getTradesPage(F(), bad, 3).rows.map((r) => r.id)).toEqual(book().slice(0, 3).map((r) => r.id));
    }
  });
});

describe("the whole-book delete scope is still the whole book", () => {
  it("returns every row in the account, in the canonical order", () => {
    expect(page.getDeletableTrades().map((r) => r.id)).toEqual(book().map((r) => r.id));
  });

  it("the 'this view' id list is the whole filtered set, not one page", () => {
    const f = F({ view: "closed" });
    expect(page.getFilteredTradeIds(f)).toEqual(jsIds(f));
    expect(page.getFilteredTradeIds(f).length).toBeGreaterThan(page.getTradesPage(f, null, 2).rows.length);
  });
});
