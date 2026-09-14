import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure — no DB in either graph, so static imports are safe before openTempDb().
import { bundledIsinBySymbol, bundledSymbolByIsin } from "@/lib/import/isin-symbol";
import { STRATEGY_COPY, underlyingExpiryNote } from "@/components/strategies/strategy-copy";
import type { StrategyGroup } from "@/lib/analytics/strategies";

/**
 * /strategies — the UNDERLYING JOIN, on a real database (v4.3.0 fix wave 1).
 *
 * `getOpenUnderlyingPositions()` adds an equity/future row to a symbol's
 * option legs so a covered call or a protective put can be named at all. Three
 * defects lived in that join, and each one is invisible on screen — the card
 * just reads as a plain short call, or as Custom:
 *
 *  - R105: the join compared stored symbols byte-for-byte. Option symbols are
 *    upper-cased at import; an equity row is stored as the broker wrote it, so
 *    "reliance" never met "RELIANCE", and a Groww row stored under the COMPANY
 *    NAME never met its ticker at all. Now: case-folded, OR the equity row's
 *    ISIN equals the bundled ISIN of an option-side symbol — read time only,
 *    no stored symbol changes — and the page resolves the leg's symbol through
 *    that ISIN so `buildStrategies` groups it with the option legs.
 *  - K3-M1: a basis-unknown sale (`acquisition = 'unknown'`, stored open) was
 *    read as a SHORT underlying: it netted the holding into a phantom short
 *    and the card printed Custom with an "Unlimited" loss.
 *  - P5 (fix wave 2): K3-M1's exclusion then let a PARTLY SOLD holding cover
 *    naked calls. Now the query returns the basis-unknown sales too, and the
 *    page nets them against the same holding, floored at zero: never a short,
 *    never a covered call the book does not hold.
 *  - R104 (page half): a future's own expiry reaches the leg, so a future that
 *    settles before the short call blanks both figures.
 *  - P13: the stored ticker wins when an option leg already wears it; the ISIN
 *    is only R105's fallback (TATAMOTORS' ISIN is listed as TMPV).
 *  - P14 (page half): a compact future stored without an expiry is marked, and
 *    only a stated month strictly before or after the call's month places it.
 *
 * ONE temp database for this file (AGENTS.md Testing). The server page and
 * the query are imported DYNAMICALLY after `openTempDb()` sets VYUHA_DB_PATH.
 */

// `PageHeader` → `BackButton` → `useRouter`; the shelf strip calls it too.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, refresh: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/strategies",
  useSearchParams: () => new URLSearchParams(),
  useSelectedLayoutSegment: () => null,
}));

// Pro, so a Covered Call keeps its name on the card (it is not legacyFree).
vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ({ state: "trial", pro: true, payload: null, trialDaysLeft: 7 }),
}));

// A PASS-THROUGH over the real engine: the page's own `buildStrategies` call,
// recorded, so a test can assert the engine's actual output for the legs the
// page built — not a figure re-derived from rendered text.
const seen = vi.hoisted(() => ({ groups: [] as StrategyGroup[] }));
vi.mock("@/lib/analytics/strategies", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/analytics/strategies")>();
  return {
    ...real,
    buildStrategies: (legs: Parameters<typeof real.buildStrategies>[0]) => (seen.groups = real.buildStrategies(legs)),
  };
});

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;
/** D3 (W2-FIXB): the basis predicate's fixtures, in a book of their own so no PRIMARY assertion moves. */
const BASIS = 3;

let t: TempDb;
let trades: typeof import("@/lib/queries/trades");
let page: typeof import("@/app/strategies/page");

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");
const renderHtml = (): string => renderToStaticMarkup(page.default() as React.ReactElement);
const renderPage = (): string => textOf(renderHtml());
/** The engine's groups for one symbol, as the page just computed them. */
const groupsFor = (symbol: string): StrategyGroup[] => {
  renderPage();
  return seen.groups.filter((g) => g.symbol === symbol);
};
/** P5 / P13 / P14 fixtures: every symbol here is PRIMARY and new to this file. */
const NEW_SYMBOLS = ["HDFCBANK", "SBIN", "WIPRO", "TATAMOTORS"];
const future = (symbol: string, tradingsymbol: string, qty: number, price: number) =>
  tradeRow({
    accountId: PRIMARY,
    symbol,
    tradingsymbol,
    instrumentType: "future",
    segment: "fno_fut",
    expiry: null,
    isOpen: true,
    buyQty: qty,
    avgBuyPrice: price,
  });
const unknownSale = (accountId: number, symbol: string, qty: number, price: number) =>
  tradeRow({
    accountId,
    symbol,
    tradingsymbol: symbol,
    isOpen: true,
    buyQty: 0,
    sellQty: qty,
    avgSellPrice: price,
    acquisition: "unknown",
  });

const shortCall = (accountId: number, symbol: string, strike: number, qty: number, premium: number, expiry = "2026-09-24") =>
  tradeRow({
    accountId,
    symbol,
    tradingsymbol: `${symbol}${strike}CE`,
    instrumentType: "option",
    optionType: "CE",
    strike,
    expiry,
    isOpen: true,
    sellQty: qty,
    avgSellPrice: premium,
  });

beforeAll(async () => {
  t = await openTempDb("strategies-ul-join", { seed: true });
  trades = await import("@/lib/queries/trades");
  page = await import("@/app/strategies/page");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing", isDefault: false }, { id: BASIS, name: "Basis", isDefault: false }]).run();
  t.db
    .insert(t.schema.trades)
    .values([
      // D3 (W2-FIXB) — one delivery holding of 100 under 100 short calls per symbol, and a sale beside it.
      // ITC: a v4.2.0 Angel One / Upstox sale, acquisition NULL, no price — basis NOT recorded: nets.
      shortCall(BASIS, "ITC", 450, 100, 5),
      tradeRow({ accountId: BASIS, symbol: "ITC", tradingsymbol: "ITC", isOpen: true, buyQty: 100, avgBuyPrice: 400 }),
      tradeRow({ accountId: BASIS, symbol: "ITC", tradingsymbol: "ITC", isOpen: true, sellQty: 60, avgSellPrice: 420, acquisition: null }),
      // BEL: a sale of recorded BONUS shares — excluded: no short, and the lot keeps its 100.
      shortCall(BASIS, "BEL", 400, 100, 6),
      tradeRow({ accountId: BASIS, symbol: "BEL", tradingsymbol: "BEL", isOpen: true, buyQty: 100, avgBuyPrice: 380 }),
      tradeRow({ accountId: BASIS, symbol: "BEL", tradingsymbol: "BEL", isOpen: true, sellQty: 100, avgSellPrice: 390, acquisition: "bonus" }),
      // LT: acquisition NULL but an acquisition PRICE recorded — a recorded basis too: excluded.
      shortCall(BASIS, "LT", 3600, 100, 30),
      tradeRow({ accountId: BASIS, symbol: "LT", tradingsymbol: "LT", isOpen: true, buyQty: 100, avgBuyPrice: 3500 }),
      tradeRow({ accountId: BASIS, symbol: "LT", tradingsymbol: "LT", isOpen: true, sellQty: 40, avgSellPrice: 3550, acquisition: null, acquisitionPrice: 3000 }),
      // MARUTI: an MTF sale with no basis recorded is a delivery-segment sale too: nets, never a short.
      shortCall(BASIS, "MARUTI", 12500, 100, 90),
      tradeRow({ accountId: BASIS, symbol: "MARUTI", tradingsymbol: "MARUTI", isOpen: true, buyQty: 100, avgBuyPrice: 12000 }),
      tradeRow({ accountId: BASIS, symbol: "MARUTI", tradingsymbol: "MARUTI", segment: "eq_mtf", isOpen: true, sellQty: 30, avgSellPrice: 12100, acquisition: null }),
      // ADANIENT: a FUTURES sell-only row a pull stored as basis-unknown (M-3) under a long call — a genuine short.
      tradeRow({
        accountId: BASIS,
        symbol: "ADANIENT",
        tradingsymbol: "ADANIENT2500CE",
        instrumentType: "option",
        optionType: "CE",
        strike: 2500,
        expiry: "2026-09-24",
        isOpen: true,
        buyQty: 300,
        avgBuyPrice: 40,
      }),
      tradeRow({
        accountId: BASIS,
        symbol: "ADANIENT",
        tradingsymbol: "ADANIENT26SEPFUT",
        instrumentType: "future",
        segment: "fno_fut",
        expiry: "2026-09-24",
        isOpen: true,
        sellQty: 300,
        avgSellPrice: 2450,
        acquisition: "unknown",
      }),
      // R105, case: the holding stored lower-case under an upper-case option leg.
      shortCall(PRIMARY, "RELIANCE", 3000, 250, 40),
      tradeRow({ accountId: PRIMARY, symbol: "reliance", tradingsymbol: "reliance", isOpen: true, buyQty: 250, avgBuyPrice: 2900 }),
      // R105, ISIN: the holding stored under the COMPANY NAME, carrying the ISIN.
      shortCall(PRIMARY, "TCS", 4200, 175, 50),
      tradeRow({
        accountId: PRIMARY,
        symbol: "Tata Consultancy Services Ltd",
        tradingsymbol: "Tata Consultancy Services Ltd",
        isin: "INE467B01029",
        isOpen: true,
        buyQty: 175,
        avgBuyPrice: 4100,
      }),
      // K3-M1: a covered call plus a basis-unknown SALE stored open — the
      // opening-sell shape the open count already excludes (trades.ts).
      shortCall(PRIMARY, "INFY", 1500, 250, 30),
      tradeRow({ accountId: PRIMARY, symbol: "INFY", tradingsymbol: "INFY", isOpen: true, buyQty: 250, avgBuyPrice: 1450 }),
      tradeRow({
        accountId: PRIMARY,
        symbol: "INFY",
        tradingsymbol: "INFY",
        isOpen: true,
        buyQty: 0,
        sellQty: 100,
        avgSellPrice: 1500,
        acquisition: "unknown",
      }),
      // R104: a September FUTURE under an October short call.
      shortCall(PRIMARY, "BANKNIFTY", 54000, 30, 400, "2026-10-29"),
      tradeRow({
        accountId: PRIMARY,
        symbol: "BANKNIFTY",
        tradingsymbol: "BANKNIFTY26SEPFUT",
        instrumentType: "future",
        segment: "fno_fut",
        expiry: "2026-09-24",
        isOpen: true,
        buyQty: 30,
        avgBuyPrice: 53500,
      }),
      // THE OTHER BOOK: rows that would join the PRIMARY option legs through
      // either new branch if that branch forgot its account scope (invariant 8).
      tradeRow({
        accountId: SWING,
        symbol: "Reliance Industries Ltd",
        tradingsymbol: "Reliance Industries Ltd",
        isin: "INE002A01018",
        isOpen: true,
        buyQty: 100,
        avgBuyPrice: 2800,
      }),
      tradeRow({ accountId: SWING, symbol: "tcs", tradingsymbol: "tcs", isOpen: true, buyQty: 50, avgBuyPrice: 4000 }),
      // P5: 550 held, 200 of them sold with the basis unknown (auto-close OFF:
      // the lot stays at 550), and 550 short calls — 200 calls are uncovered.
      shortCall(PRIMARY, "HDFCBANK", 1700, 550, 20),
      tradeRow({ accountId: PRIMARY, symbol: "HDFCBANK", tradingsymbol: "HDFCBANK", isOpen: true, buyQty: 550, avgBuyPrice: 1600 }),
      unknownSale(PRIMARY, "HDFCBANK", 200, 1650),
      // …and the OTHER book's basis-unknown sale of the same ticker, which would
      // net the PRIMARY holding to 50 if the new half of the read lost its scope.
      unknownSale(SWING, "HDFCBANK", 300, 1650),
      // P5: a sale LARGER than the holding — floored at zero, never a short.
      shortCall(PRIMARY, "SBIN", 800, 750, 12),
      tradeRow({ accountId: PRIMARY, symbol: "SBIN", tradingsymbol: "SBIN", isOpen: true, buyQty: 90, avgBuyPrice: 780 }),
      unknownSale(PRIMARY, "SBIN", 250, 790),
      // K3-M1's phantom: a basis-unknown sale with no holding at all.
      shortCall(PRIMARY, "WIPRO", 300, 3000, 4),
      unknownSale(PRIMARY, "WIPRO", 120, 290),
      // P13: TATAMOTORS' ISIN is listed under TMPV; the stored ticker matches the call.
      shortCall(PRIMARY, "TATAMOTORS", 1000, 550, 15),
      tradeRow({
        accountId: PRIMARY,
        symbol: "TATAMOTORS",
        tradingsymbol: "TATAMOTORS",
        isin: "INE155A01022",
        isOpen: true,
        buyQty: 550,
        avgBuyPrice: 950,
      }),
      // P14: compact futures stored with NO expiry, each under an October call.
      shortCall(PRIMARY, "NIFTY", 25000, 75, 150, "2026-10-29"),
      future("NIFTY", "NIFTY26OCTFUT", 75, 24800), // the call's own month: unknown
      shortCall(PRIMARY, "FINNIFTY", 24000, 65, 120, "2026-10-27"),
      future("FINNIFTY", "FINNIFTY26SEPFUT", 65, 23800), // strictly before: settles first
      shortCall(PRIMARY, "MIDCPNIFTY", 13000, 120, 90, "2026-10-27"),
      future("MIDCPNIFTY", "MIDCPNIFTY26NOVFUT", 120, 12900), // strictly after: outlives the call
    ])
    .run();
  select(PRIMARY);
});

afterAll(() => t?.cleanup());

describe("R105 — an equity row joins its option legs through case and ISIN, never across books", () => {
  it("the bundled snapshot knows TCS — asserted, not skipped (the snapshot is committed)", () => {
    expect(bundledIsinBySymbol("TCS")).toBe("INE467B01029");
    expect(bundledIsinBySymbol("RELIANCE")).toBe("INE002A01018");
  });

  it("a lower-case symbol and a company-name symbol both join their option legs", () => {
    select(PRIMARY);
    const joined = trades
      .getOpenUnderlyingPositions()
      // The P5/P13 fixtures are equity rows too; this case is about the two R105 spellings.
      .filter((r) => r.instrumentType === "equity" && r.symbol !== "INFY" && !NEW_SYMBOLS.includes(r.symbol))
      .map((r) => r.symbol)
      .sort();
    expect(joined).toEqual(["Tata Consultancy Services Ltd", "reliance"]);
  });

  it("the page groups each joined holding with its option leg and names the Covered Call", () => {
    select(PRIMARY);
    const text = renderPage();
    expect(text).toContain("|RELIANCE|Covered Call|");
    expect(text).toContain("|TCS|Covered Call|");
    expect(text).toContain("250 × underlying");
    expect(text).toContain("175 × underlying");
    // The stored spellings never become cards of their own.
    expect(text).not.toContain("|reliance|");
    expect(text).not.toContain("|Tata Consultancy Services Ltd|");
  });

  it("the other book's rows never join a PRIMARY view, through either branch", () => {
    select(PRIMARY);
    const symbols = trades.getOpenUnderlyingPositions().map((r) => r.symbol);
    expect(symbols).not.toContain("Reliance Industries Ltd");
    expect(symbols).not.toContain("tcs");
    const text = renderPage();
    expect(text, "the SWING holding of 100 merged into the PRIMARY covered call").not.toContain("100 × underlying");
    // The SWING book holds no option leg at all, so it has no underlying to show.
    select(SWING);
    expect(trades.getOpenUnderlyingPositions()).toEqual([]);
    // 0 is a view: it widens the option legs and the underlyings together.
    select(ALL);
    expect(trades.getOpenUnderlyingPositions().map((r) => r.symbol)).toEqual(
      expect.arrayContaining(["Reliance Industries Ltd", "tcs", "reliance"]),
    );
    select(PRIMARY);
  });
});

describe("K3-M1 + P5 — a basis-unknown sale is never a short underlying, and never leaves calls falsely covered", () => {
  it("the read returns the basis-unknown sale beside the holding, in the same account scope", () => {
    select(PRIMARY);
    const rowsOf = (symbol: string) =>
      trades
        .getOpenUnderlyingPositions()
        .filter((r) => r.symbol === symbol)
        .map((r) => [r.buyQty, r.sellQty, r.acquisition])
        .sort();
    // Re-pinned (P5): was [[250, 0]] with the sale excluded outright (K3-M1),
    // which let the holding cover calls on shares already sold.
    expect(rowsOf("INFY")).toEqual([[0, 100, "unknown"], [250, 0, null]]);
    // The SWING book's sale of 300 HDFCBANK never reaches the PRIMARY read.
    expect(rowsOf("HDFCBANK")).toEqual([[0, 200, "unknown"], [550, 0, null]]);
  });

  it("550 held, 200 sold with the basis unknown, 550 short calls: 350 × underlying and an unbounded loss", () => {
    select(PRIMARY);
    const [g, ...rest] = groupsFor("HDFCBANK");
    expect(rest).toEqual([]);
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium]), "the sale nets against the holding").toEqual([["long", 350, 1600]]);
    expect(g.strategyId, "350 shares do not cover 550 calls").not.toBe("covered-call");
    expect(g.maxLoss, "200 calls are uncovered: the loss is unbounded").toBeNull();
    expect(g.capLabel.maxLoss).toBe("Unlimited");
    const text = renderPage();
    expect(text).not.toContain("|HDFCBANK|Covered Call|");
    expect(text).toContain("350 × underlying");
  });

  it("INFY: 250 held and 100 sold with the basis unknown is 150 × underlying under 250 calls", () => {
    select(PRIMARY);
    // Re-pinned (P5): was "|INFY|Covered Call|" with all 250 shares and a bounded loss.
    const [g] = groupsFor("INFY");
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 150, 1450]]);
    expect(g.strategyId).not.toBe("covered-call");
    expect(g.maxLoss).toBeNull();
  });

  it("a sale larger than the holding leaves NO underlying leg and never a short (floored at zero)", () => {
    select(PRIMARY);
    const [g] = groupsFor("SBIN");
    expect(g.ulLegs).toEqual([]);
    expect(g.name).toBe("Short Call");
  });

  it("K3-M1's phantom stays fixed: a basis-unknown sale with no holding adds no leg", () => {
    select(PRIMARY);
    const [g] = groupsFor("WIPRO");
    expect(g.ulLegs).toEqual([]);
    expect(g.name).toBe("Short Call");
    // Nowhere on the page does a basis-unknown sale become a SHORT underlying.
    expect(seen.groups.flatMap((x) => x.ulLegs).filter((l) => l.side === "short")).toEqual([]);
  });
});

/**
 * D3 (v4.3.0 fix wave 2, W2-FIXB — seam defect, orchestrator decision). One
 * basis predicate for the underlying join, the one Data Quality reads
 * (`hasRecordedBasis`): acquisition NULL or 'unknown' with no acquisition price
 * = basis NOT recorded. P5 netted only 'unknown', so a NULL-acquisition sale
 * (how v4.2.0 stored every Angel One / Upstox sale) was a SHORT underlying, and
 * a recorded 'bonus' sale was one too.
 *  - A delivery-segment sell-only row, basis not recorded → nets the long, floored at 0.
 *  - A delivery-segment sell-only row WITH a recorded basis → excluded from the join.
 *  - A futures sell-only row → a genuine short, whatever its acquisition.
 */
describe("D3 — the underlying join reads Data Quality's basis predicate: a delivery sale is never a short", () => {
  const ulOf = (symbol: string) => {
    select(BASIS);
    const [g, ...rest] = groupsFor(symbol);
    select(PRIMARY);
    expect(rest).toEqual([]);
    return g;
  };

  it("ITC: 100 held, 60 sold with acquisition NULL — the sale nets the holding to 40, never a short 60", () => {
    const g = ulOf("ITC");
    // Measured before: [["short", 60, 420], ["long", 100, 400]].
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 40, 400]]);
  });

  it("BEL: a sale of recorded bonus shares is excluded — the held 100 still covers the call, and no card reads Unlimited", () => {
    const g = ulOf("BEL");
    // Measured before: [["short", 100, 390], ["long", 100, 380]] — the two cancel and the call reads naked.
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 100, 380]]);
    expect(g.strategyId).toBe("covered-call");
    expect(g.capLabel.maxLoss).not.toBe("Unlimited");
  });

  it("LT: acquisition NULL with an acquisition PRICE is a recorded basis too — excluded, the lot keeps its 100", () => {
    const g = ulOf("LT");
    // Measured before: [["short", 40, 3550], ["long", 100, 3500]].
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 100, 3500]]);
    expect(g.strategyId).toBe("covered-call");
  });

  it("MARUTI: an MTF sale with no basis recorded nets like a delivery one — 70 × underlying, no short", () => {
    const g = ulOf("MARUTI");
    // Measured before: [["short", 30, 12100], ["long", 100, 12000]].
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 70, 12000]]);
  });

  it("ADANIENT: a FUTURES sell-only row stays a genuine short, even stored basis-unknown", () => {
    const g = ulOf("ADANIENT");
    // Measured before: [] — P5 netted every 'unknown' row, a future's short included.
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["short", 300, 2450]]);
  });

  it("nowhere in the book does a DELIVERY-segment row become a short underlying (M-3, invariant 6)", () => {
    select(BASIS);
    renderPage();
    select(PRIMARY);
    // Measured before: ["BEL", "ITC", "LT", "MARUTI"] — and not ADANIENT's real short.
    expect(seen.groups.flatMap((x) => x.ulLegs.filter((l) => l.side === "short").map(() => x.symbol))).toEqual(["ADANIENT"]);
  });
});

describe("P13 — the stored ticker wins when an option leg already wears it", () => {
  it("the bundled listing names TATAMOTORS' ISIN as TMPV — asserted, not skipped", () => {
    expect(bundledSymbolByIsin("INE155A01022")).toBe("TMPV");
  });

  it("TATAMOTORS reads Covered Call with its holding, and no TMPV card appears", () => {
    select(PRIMARY);
    const text = renderPage();
    expect(text).toContain("|TATAMOTORS|Covered Call|");
    expect(text).not.toContain("|TMPV|");
    const [g] = groupsFor("TATAMOTORS");
    expect(g.ulLegs.map((l) => l.qty)).toEqual([550]);
    expect(g.maxLoss).not.toBeNull();
  });
});

describe("P14 (page half) — a compact future stored without an expiry", () => {
  it("in the call's own month: both tiles Not computed, with its own note on the card and in each tile's title", () => {
    select(PRIMARY);
    const [g] = groupsFor("NIFTY");
    expect(g.strategyId).toBe("covered-call");
    expect(g.capLabel).toEqual({ maxProfit: "Not computed", maxLoss: "Not computed" });
    expect(underlyingExpiryNote(g)).toBe(STRATEGY_COPY.underlyingExpiryUnknownNote);
    const html = renderHtml();
    expect(textOf(html)).toContain(STRATEGY_COPY.underlyingExpiryUnknownNote);
    // The title path on the two blank tiles — and only NIFTY's card carries it.
    expect(html.split(`title="${STRATEGY_COPY.underlyingExpiryUnknownNote}"`)).toHaveLength(3);
  });

  it("a month strictly before settles first (R104's note); strictly after keeps its figures", () => {
    select(PRIMARY);
    const [fin] = groupsFor("FINNIFTY");
    expect(fin.capLabel).toEqual({ maxProfit: "Not computed", maxLoss: "Not computed" });
    expect(underlyingExpiryNote(fin)).toBe(STRATEGY_COPY.underlyingExpiresFirstNote);
    const [mid] = groupsFor("MIDCPNIFTY");
    expect(mid.notComputed).toEqual({ maxProfit: false, maxLoss: false });
    expect(underlyingExpiryNote(mid)).toBeNull();
  });
});

describe("R104 (page half) — a future's own expiry reaches its leg", () => {
  it("the query carries the future's expiry, and the card blanks both figures and says why", () => {
    select(PRIMARY);
    // By symbol: the P14 compact futures above are futures too.
    const fut = trades.getOpenUnderlyingPositions().find((r) => r.symbol === "BANKNIFTY");
    expect(fut?.expiry).toBe("2026-09-24");
    const text = renderPage();
    expect(text).toContain("|BANKNIFTY|Covered Call|");
    expect(text).toContain(STRATEGY_COPY.underlyingExpiresFirstNote);
  });
});
