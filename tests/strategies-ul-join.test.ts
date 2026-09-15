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
 *  - N16 (fix wave 2R): the P5 / D3 netting is per ACCOUNT, floored per account,
 *    then aggregated — All accounts is the sum of the single-account nettings.
 *  - N17 (fix wave 2R): a company-name holding takes the option-side symbol that
 *    admitted it, never the listing's other ticker for the ISIN.
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

// A PASS-THROUGH over the real engine: the page's own `buildStrategies` calls,
// recorded, so a test can assert the engine's actual output for the legs the
// page built — not a figure re-derived from rendered text.
// H6 (fix wave 2H): the page calls the engine ONCE PER ACCOUNT, so the record
// ACCUMULATES and `runPage` clears it before every page call.
const seen = vi.hoisted(() => ({ groups: [] as StrategyGroup[] }));
vi.mock("@/lib/analytics/strategies", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/analytics/strategies")>();
  return {
    ...real,
    buildStrategies: (legs: Parameters<typeof real.buildStrategies>[0]) => {
      const out = real.buildStrategies(legs);
      seen.groups.push(...out);
      return out;
    },
  };
});

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;
/** D3 (W2-FIXB): the basis predicate's fixtures, in a book of their own so no PRIMARY assertion moves. */
const BASIS = 3;
/** N16 (fix wave 2R): two books of their own for the per-account netting, so no PRIMARY or SWING assertion moves. */
const NET_A = 4;
const NET_B = 5;
/** N17 (fix wave 2R): company-name holdings whose ISIN is listed under a different ticker, in a book of their own. */
const NAMES = 6;
/** N17: both tickers of one ISIN carry an option leg — the listing's own ticker takes the holding. */
const NAMES_BOTH = 7;
/** L5 (fix wave 2G): two tickers of one ISIN, each in its OWN account — the admitting map is per account. */
const ADMIT_A = 8;
const ADMIT_B = 9;
/**
 * H6 (fix wave 2H): the wave-2G re-check's reproduce. FB is ADMIT_B above (a
 * short SAMMAANCAP 150 CE, 100 @ 5); FA holds the IBULHSGFIN company name with
 * NO option; RB is short RELIANCE 1500 CE; RA holds RELIANCE shares with NO option.
 */
const ALONE_NAME = 10;
const RB_CALL = 11;
const RA_SHARES = 12;
const EVERY_ACCOUNT = [PRIMARY, SWING, BASIS, NET_A, NET_B, NAMES, NAMES_BOTH, ADMIT_A, ADMIT_B, ALONE_NAME, RB_CALL, RA_SHARES];

let t: TempDb;
let trades: typeof import("@/lib/queries/trades");
let page: typeof import("@/app/strategies/page");

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");
/** One page call, with the engine record cleared first (the page builds per account). */
const runPage = (): React.ReactElement => {
  seen.groups = [];
  return page.default() as React.ReactElement;
};
const renderHtml = (): string => renderToStaticMarkup(runPage());
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

  t.db
    .insert(t.schema.accounts)
    .values([
      { id: SWING, name: "Swing", isDefault: false },
      { id: BASIS, name: "Basis", isDefault: false },
      { id: NET_A, name: "Net A", isDefault: false },
      { id: NET_B, name: "Net B", isDefault: false },
      { id: NAMES, name: "Names", isDefault: false },
      { id: NAMES_BOTH, name: "Names both", isDefault: false },
      { id: ADMIT_A, name: "Admit A", isDefault: false },
      { id: ADMIT_B, name: "Admit B", isDefault: false },
      { id: ALONE_NAME, name: "FA", isDefault: false },
      { id: RB_CALL, name: "RB", isDefault: false },
      { id: RA_SHARES, name: "RA", isDefault: false },
    ])
    .run();
  t.db
    .insert(t.schema.trades)
    .values([
      // N16 — AXISBANK: A holds 100 under 100 short calls; B sold 100 with the basis unknown and holds none.
      shortCall(NET_A, "AXISBANK", 1200, 100, 18),
      tradeRow({ accountId: NET_A, symbol: "AXISBANK", tradingsymbol: "AXISBANK", isOpen: true, buyQty: 100, avgBuyPrice: 1150 }),
      unknownSale(NET_B, "AXISBANK", 100, 1180),
      // N16 — KOTAKBANK: A holds 100 and sold 150 basis-unknown (A floors at 0); B holds 100 and sold nothing.
      shortCall(NET_A, "KOTAKBANK", 2000, 100, 25),
      tradeRow({ accountId: NET_A, symbol: "KOTAKBANK", tradingsymbol: "KOTAKBANK", isOpen: true, buyQty: 100, avgBuyPrice: 1900 }),
      unknownSale(NET_A, "KOTAKBANK", 150, 1950),
      tradeRow({ accountId: NET_B, symbol: "KOTAKBANK", tradingsymbol: "KOTAKBANK", isOpen: true, buyQty: 100, avgBuyPrice: 1880 }),
      // H6 (fix wave 2H): B's OWN call over its 100. Without it B alone shows no card, so on 0 B's shares are no leg
      // at all (a holding is a leg only where its own account's option legs admit it) and N16's case loses its B half.
      shortCall(NET_B, "KOTAKBANK", 2100, 100, 20),
      // N17 — a company-name holding whose ISIN the listing names under ANOTHER ticker than the option's.
      shortCall(NAMES, "TATAMOTORS", 1000, 550, 15),
      tradeRow({
        accountId: NAMES,
        symbol: "Tata Motors Ltd",
        tradingsymbol: "Tata Motors Ltd",
        isin: "INE155A01022",
        isOpen: true,
        buyQty: 550,
        avgBuyPrice: 950,
      }),
      // N17 — the old and the new ticker of ONE ISIN both carry a call; the holding is stored under the company name.
      shortCall(NAMES_BOTH, "AMARAJABAT", 1100, 100, 10),
      shortCall(NAMES_BOTH, "ARE&M", 1100, 100, 10),
      tradeRow({
        accountId: NAMES_BOTH,
        symbol: "Amara Raja Energy & Mobility Ltd",
        tradingsymbol: "Amara Raja Energy & Mobility Ltd",
        isin: bundledIsinBySymbol("ARE&M"),
        isOpen: true,
        buyQty: 100,
        avgBuyPrice: 1000,
      }),
      // L5 — IBULHSGFIN / SAMMAANCAP (one ISIN): A holds the company name under its own IBULHSGFIN call, B only a SAMMAANCAP call.
      shortCall(ADMIT_A, "IBULHSGFIN", 150, 100, 5),
      tradeRow({
        accountId: ADMIT_A,
        symbol: "Indiabulls Housing Finance Ltd",
        tradingsymbol: "Indiabulls Housing Finance Ltd",
        isin: bundledIsinBySymbol("IBULHSGFIN"),
        isOpen: true,
        buyQty: 100,
        avgBuyPrice: 140,
      }),
      shortCall(ADMIT_B, "SAMMAANCAP", 150, 100, 5),
      // L5 — the STORED-ticker branch: A holds "MINDAIND" (its ISIN) under its own UNOMINDA call, B only a MINDAIND call.
      shortCall(ADMIT_A, "UNOMINDA", 900, 100, 12),
      tradeRow({
        accountId: ADMIT_A,
        symbol: "MINDAIND",
        tradingsymbol: "MINDAIND",
        isin: bundledIsinBySymbol("MINDAIND"),
        isOpen: true,
        buyQty: 100,
        avgBuyPrice: 850,
      }),
      shortCall(ADMIT_B, "MINDAIND", 900, 100, 12),
      // H6 — FA: the IBULHSGFIN company name, 100 @ 140, and no option of FA's own (FB is ADMIT_B's SAMMAANCAP call).
      tradeRow({
        accountId: ALONE_NAME,
        symbol: "Indiabulls Housing Finance Ltd",
        tradingsymbol: "Indiabulls Housing Finance Ltd",
        isin: bundledIsinBySymbol("IBULHSGFIN"),
        isOpen: true,
        buyQty: 100,
        avgBuyPrice: 140,
      }),
      // H6 — RB: short RELIANCE 1500 CE, 100 @ 5; RA: RELIANCE shares 100 @ 1400, no option of RA's own.
      shortCall(RB_CALL, "RELIANCE", 1500, 100, 5),
      tradeRow({ accountId: RA_SHARES, symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true, buyQty: 100, avgBuyPrice: 1400 }),
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
 * N16 (v4.3.0 fix wave 2R, orchestrator decision). A sale only ever reduces the
 * lots of its OWN account: the page nets per account, floors each account at
 * zero, THEN aggregates. P5 / D3 keyed the netting by instrument alone, so in the
 * All-accounts view (0 is a view, invariant 9) account B's basis-unknown sale
 * came out of account A's demat and a covered call read as a naked short call.
 */
describe("N16 — in All accounts, a basis-unknown sale nets only its own account's lots", () => {
  const ulOf = (id: number, symbol: string) => {
    select(id);
    const gs = groupsFor(symbol);
    select(PRIMARY);
    return gs.flatMap((g) => g.ulLegs.map((l) => [l.side, l.qty, l.premium]));
  };

  it("A holds 100 under 100 short calls, B sold 100 basis-unknown: All accounts still reads a bounded Covered Call", () => {
    expect(ulOf(NET_A, "AXISBANK"), "A alone").toEqual([["long", 100, 1150]]);
    select(ALL);
    const [g, ...rest] = groupsFor("AXISBANK");
    select(PRIMARY);
    expect(rest).toEqual([]);
    // Measured before (pooled netting): ulLegs [] — B's 100 sold netted A's 100 away, and the calls read uncovered.
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium]), "B's sale never comes out of A's lot").toEqual([["long", 100, 1150]]);
    expect(g.strategyId).toBe("covered-call");
    expect(g.capLabel.maxLoss).not.toBe("Unlimited");
  });

  it("each account floors at zero BEFORE the aggregate: A sold more than it held, B's 100 still stands", () => {
    // Re-pinned (H6, fix wave 2H): one card per ACCOUNT on 0, so the UL legs are read per card. Was one card,
    // [["long", 100, 1880]] — B's 100 under A's call. B now holds its own call (fixture above).
    const perCard = (id: number) => {
      select(id);
      runPage(); // the markup is not needed (L5's measurement below)
      select(PRIMARY);
      return seen.groups.filter((g) => g.symbol === "KOTAKBANK").map((g) => g.ulLegs.map((l) => [l.side, l.qty, l.premium]));
    };
    expect(perCard(NET_A), "A alone floors at zero").toEqual([[]]);
    expect(perCard(NET_B), "B alone").toEqual([[["long", 100, 1880]]]);
    // Measured before N16: A's 150 sold netted against A's 100 AND B's 100 pooled.
    expect(perCard(ALL)).toEqual([[], [["long", 100, 1880]]]);
  });

  it("the aggregate HDFCBANK holding equals the sum of the single-account nettings (350 + 0)", () => {
    const perAccount = [PRIMARY, SWING].flatMap((id) => ulOf(id, "HDFCBANK"));
    expect(perAccount).toEqual([["long", 350, 1600]]);
    // Measured before: [["long", 50, 1600]] — SWING's 300 sold came out of PRIMARY's 550.
    expect(ulOf(ALL, "HDFCBANK")).toEqual(perAccount);
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

  // N17 (fix wave 2R, orchestrator decision): the leg takes the option-side
  // symbol that ADMITTED it. A holding stored under the company name is admitted
  // by bundledIsinBySymbol(optionSymbol); resolving it back through
  // bundledSymbolByIsin named the listing's newer ticker and split it off.
  it("the bundled listing names each of the four ISINs under a DIFFERENT ticker — asserted, not skipped", () => {
    for (const [option, listed] of [["TATAMOTORS", "TMPV"], ["AMARAJABAT", "ARE&M"], ["IBULHSGFIN", "SAMMAANCAP"], ["MINDAIND", "UNOMINDA"]]) {
      const isin = bundledIsinBySymbol(option);
      expect(isin, option).toMatch(/^INE/);
      expect(bundledSymbolByIsin(isin as string), option).toBe(listed);
    }
  });

  it("N17: 'Tata Motors Ltd' with TATAMOTORS' ISIN joins the TATAMOTORS calls as a Covered Call — no stray TMPV card", () => {
    select(NAMES);
    const text = renderPage();
    const [g, ...rest] = groupsFor("TATAMOTORS");
    const tmpv = seen.groups.filter((x) => x.symbol === "TMPV");
    select(PRIMARY);
    // Measured before: a "TMPV · Custom (1 legs)" card, and TATAMOTORS read "Short Call · Unlimited".
    expect(tmpv).toEqual([]);
    expect(text).not.toContain("|TMPV|");
    expect(text).toContain("|TATAMOTORS|Covered Call|");
    expect(rest).toEqual([]);
    expect(g.ulLegs.map((l) => [l.side, l.qty, l.premium])).toEqual([["long", 550, 950]]);
    expect(g.capLabel.maxLoss).not.toBe("Unlimited");
  });

  it("N17: when BOTH tickers of one ISIN carry a call, the listing's own ticker (ARE&M) takes the holding, once", () => {
    expect(bundledIsinBySymbol("AMARAJABAT")).toBe(bundledIsinBySymbol("ARE&M"));
    select(NAMES_BOTH);
    renderPage();
    const ul = seen.groups.filter((g) => g.ulLegs.length).map((g) => [g.symbol, g.ulLegs.map((l) => l.qty)]);
    select(PRIMARY);
    // Alphabetical first alone would hand it to AMARAJABAT.
    expect(ul).toEqual([["ARE&M", [100]]]);
  });
});

/**
 * L5 (v4.3.0 fix wave 2G, orchestrator decision: a per-account admitting map).
 * N17's admitting-symbol map was built over EVERY option leg in scope, so in the
 * All-accounts view (0 is a view, invariant 9) account B's ticker for the same
 * ISIN decided where account A's holding went: A's shares covered B's call and
 * A's own call read naked. Each account's cards in All accounts must be the cards
 * that account shows alone.
 */
describe("L5 — in All accounts, a holding resolves against its OWN account's option symbols", () => {
  /** [symbol, strategyId, ul legs] per card, for the symbols given, in the view selected. */
  const cardsIn = (id: number, symbols: string[]) => {
    select(id);
    // The page's own buildStrategies call is recorded when the page function
    // runs; the markup is not needed here (measured 2026-09-15: 189-242 ms per
    // `it` with renderToStaticMarkup, 13-21 ms without).
    runPage();
    const out = seen.groups
      .filter((g) => symbols.includes(g.symbol))
      .map((g) => [g.symbol, g.strategyId, g.ulLegs.map((l) => [l.side, l.qty, l.premium])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    select(PRIMARY);
    return out;
  };

  it("the fixtures are the trap: each pair is ONE ISIN under two tickers — asserted, not skipped", () => {
    expect(bundledIsinBySymbol("IBULHSGFIN")).toBe(bundledIsinBySymbol("SAMMAANCAP"));
    expect(bundledSymbolByIsin(bundledIsinBySymbol("IBULHSGFIN") as string)).toBe("SAMMAANCAP");
    expect(bundledIsinBySymbol("MINDAIND")).toMatch(/^INE/);
    expect(bundledIsinBySymbol("MINDAIND")).toBe(bundledIsinBySymbol("UNOMINDA"));
  });

  it("A's company-name holding covers A's own IBULHSGFIN call in All accounts; B's SAMMAANCAP call stays naked", () => {
    const syms = ["IBULHSGFIN", "SAMMAANCAP"];
    const alone = [...cardsIn(ADMIT_A, syms), ...cardsIn(ADMIT_B, syms)];
    expect(alone).toEqual([
      ["IBULHSGFIN", "covered-call", [["long", 100, 140]]],
      ["SAMMAANCAP", "short-call", []],
    ]);
    // Measured before (one in-scope map): IBULHSGFIN short-call with no UL, and
    // SAMMAANCAP covered-call with A's 100 — the listing ticker took A's shares.
    expect(cardsIn(ALL, syms), "B's option symbol changed A's routing").toEqual(alone);
  });

  it("the stored-ticker branch is per account too: A's MINDAIND shares go to A's UNOMINDA call, not B's MINDAIND call", () => {
    const syms = ["MINDAIND", "UNOMINDA"];
    const alone = [...cardsIn(ADMIT_B, syms), ...cardsIn(ADMIT_A, syms)];
    expect(alone).toEqual([
      ["MINDAIND", "short-call", []],
      ["UNOMINDA", "covered-call", [["long", 100, 850]]],
    ]);
    // Measured before: MINDAIND covered-call with A's 100 (B's call wore the
    // stored ticker), UNOMINDA short-call with no UL.
    expect(cardsIn(ALL, syms), "B's option symbol changed A's routing").toEqual(alone);
  });
});

/**
 * H6 (v4.3.0 fix wave 2H, orchestrator decision; the wave-2G re-check's "seams"
 * finding). In All accounts (0 is a view, invariant 9) each account's cards are
 * EXACTLY that account's single-account cards: N16's "per account, then
 * aggregate", applied to the join and the grouping as it already was to the
 * netting. Two cross-account joins survived L5: G5b's in-scope admitting fallback
 * (FA's company-name holding, whose own account holds no option, routed onto FB's
 * SAMMAANCAP call) and the stored-symbol grouping (RA's RELIANCE shares grouped
 * with RB's RELIANCE call). Both showed a bounded loss for a call that is naked in
 * every single-account view.
 */
describe("H6 — All accounts shows each account's own cards, and no card built across two accounts", () => {
  /** The `groups` prop the page hands the client — what reaches the RSC payload. */
  const clientGroups = (id: number): Array<StrategyGroup & { key: string }> => {
    select(id);
    const tree = runPage();
    select(PRIMARY);
    const find = (node: unknown): Record<string, unknown> | null => {
      if (!node || typeof node !== "object") return null;
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = find(child);
          if (hit) return hit;
        }
        return null;
      }
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return null;
      if (Array.isArray(props.groups) && props.charts) return props;
      return find(props.children);
    };
    const props = find(tree);
    expect(props, "the page no longer hands the client a groups prop").not.toBeNull();
    return (props as { groups: Array<StrategyGroup & { key: string }> }).groups;
  };
  /** A card as the user reads it: every field but the React key. */
  const faceOf = (g: StrategyGroup): string => JSON.stringify({ ...g, key: undefined });

  it("the re-check's reproduce: FB's SAMMAANCAP call and RB's RELIANCE 1500 call read Unlimited on 0, exactly as alone", () => {
    const loss = (gs: StrategyGroup[], pick: (g: StrategyGroup) => boolean) => gs.filter(pick).map((g) => g.capLabel.maxLoss);
    const sammaan = (g: StrategyGroup) => g.symbol === "SAMMAANCAP";
    // INFY holds a 1500 CE too, so RB's card is picked by symbol AND strike.
    const rb = (g: StrategyGroup) => g.symbol === "RELIANCE" && g.legs.some((l) => l.strike === 1500 && l.kind === "CE");
    // Each account alone: FB's and RB's calls are naked; FA and RA hold no option, so the query returns them nothing.
    expect([loss(clientGroups(ADMIT_B), sammaan), loss(clientGroups(RB_CALL), rb)]).toEqual([["Unlimited"], ["Unlimited"]]);
    expect([clientGroups(ALONE_NAME), clientGroups(RA_SHARES)]).toEqual([[], []]);
    const all = clientGroups(ALL);
    // Measured before (3feb22f): [["Computed at underlying = 0"], ["Computed at underlying = 0"]] — FA's 100 covered
    // FB's call through the in-scope fallback, and one RELIANCE card held PRIMARY's 3000 CE and RB's 1500 CE under
    // RA's 100, SWING's 100 and PRIMARY's 250 shares.
    expect([loss(all, sammaan), loss(all, rb)], "a naked call read covered by another account's shares").toEqual([["Unlimited"], ["Unlimited"]]);
    expect(all.filter(rb).map((g) => g.ulLegs)).toEqual([[]]);
    expect(all.map((g) => g.symbol), "no card FA alone does not show").not.toContain("INDIABULLS HOUSING FINANCE LTD");
  });

  it("on 0, the cards are exactly the union of every account's single-account cards", () => {
    const alone = EVERY_ACCOUNT.flatMap((id) => clientGroups(id).map(faceOf)).sort();
    const all = clientGroups(ALL).map(faceOf).sort();
    // Measured before (3feb22f): 24 cards on 0 against 27 alone. RELIANCE (PRIMARY + RB), TATAMOTORS (PRIMARY + NAMES)
    // and KOTAKBANK (NET_A + NET_B) were each one card across accounts; SAMMAANCAP read covered by FA's shares.
    expect(all.length).toBe(alone.length);
    expect(all).toEqual(alone);
  });

  it("two accounts' same-symbol cards carry distinct keys, and no account id reaches a group or a leg", () => {
    const all = clientGroups(ALL);
    const keys = all.map((g) => g.key);
    expect(all.filter((g) => g.symbol === "RELIANCE"), "PRIMARY's covered call and RB's naked call").toHaveLength(2);
    expect(new Set(keys).size, "a duplicate key merges two cards' charts and React identity").toBe(keys.length);
    expect(all.filter((g) => "accountId" in g || g.legs.some((l) => "accountId" in l) || g.ulLegs.some((l) => "accountId" in l))).toEqual([]);
    // A single account keeps the engine's own key, unchanged.
    expect(clientGroups(PRIMARY).find((g) => g.symbol === "RELIANCE")?.key).toBe("RELIANCE");
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
