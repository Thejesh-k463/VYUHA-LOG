import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
// Pure — no DB in either graph, so static imports are safe before openTempDb().
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { STRATEGY_COPY } from "@/components/strategies/strategy-copy";

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
 *  - R104 (page half): a future's own expiry reaches the leg, so a future that
 *    settles before the short call blanks both figures.
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

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

let t: TempDb;
let trades: typeof import("@/lib/queries/trades");
let page: typeof import("@/app/strategies/page");

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const textOf = (html: string): string => html.replace(/<[^>]*>/g, "|").replace(/\|+/g, "|");
const renderPage = (): string => textOf(renderToStaticMarkup(page.default() as React.ReactElement));

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

  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", isDefault: false }).run();
  t.db
    .insert(t.schema.trades)
    .values([
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
      .filter((r) => r.instrumentType === "equity" && r.symbol !== "INFY")
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

describe("K3-M1 — a basis-unknown sale is not a short underlying", () => {
  it("is left out of the underlying read, so the holding reads as the whole buy", () => {
    select(PRIMARY);
    const infy = trades.getOpenUnderlyingPositions().filter((r) => r.symbol === "INFY");
    expect(infy.map((r) => [r.buyQty, r.sellQty])).toEqual([[250, 0]]);
  });

  it("the INFY card stays a Covered Call with a bounded loss — no phantom short, no Unlimited", () => {
    select(PRIMARY);
    const text = renderPage();
    expect(text).toContain("|INFY|Covered Call|");
    expect(text).not.toContain("|Unlimited|");
  });
});

describe("R104 (page half) — a future's own expiry reaches its leg", () => {
  it("the query carries the future's expiry, and the card blanks both figures and says why", () => {
    select(PRIMARY);
    const fut = trades.getOpenUnderlyingPositions().find((r) => r.instrumentType === "future");
    expect(fut?.expiry).toBe("2026-09-24");
    const text = renderPage();
    expect(text).toContain("|BANKNIFTY|Covered Call|");
    expect(text).toContain(STRATEGY_COPY.underlyingExpiresFirstNote);
  });
});
