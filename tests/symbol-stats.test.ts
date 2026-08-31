import { describe, expect, it } from "vitest";
import { computeSymbolStats, type SymbolTradeInput } from "@/lib/analytics/symbol-stats";

const TODAY = "2026-08-31";

const trade = (over: Partial<SymbolTradeInput> = {}): SymbolTradeInput => ({
  symbol: "RELIANCE",
  netPnl: 0,
  rMultiple: null,
  isOpen: false,
  buyDate: "2026-08-01",
  sellDate: "2026-08-02",
  segment: "equity_intraday",
  expiry: null,
  ...over,
});

describe("symbol stats — counting and P&L", () => {
  it("counts every trade but nets only the closed ones", () => {
    const s = computeSymbolStats([
      trade({ netPnl: 100 }),
      trade({ netPnl: -40 }),
      trade({ isOpen: true, netPnl: 9999 }),
    ], TODAY).get("RELIANCE")!;
    expect(s.tradeCount).toBe(3);
    expect(s.closedCount).toBe(2);
    expect(s.netPnl).toBe(60);
  });

  it("groups case-insensitively on the symbol", () => {
    const m = computeSymbolStats([trade({ symbol: "reliance" }), trade({ symbol: "RELIANCE" })], TODAY);
    expect(m.get("RELIANCE")!.tradeCount).toBe(2);
    expect(m.size).toBe(1);
  });

  it("a symbol never traded is simply absent — the caller renders 'no history'", () => {
    const m = computeSymbolStats([trade()], TODAY);
    expect(m.get("NIFTY")).toBeUndefined();
  });
});

describe("symbol stats — honest denominators", () => {
  it("win rate states its n and is null over zero closed trades, never 0", () => {
    const openOnly = computeSymbolStats([trade({ isOpen: true })], TODAY).get("RELIANCE")!;
    expect(openOnly.winRate).toBeNull();
    const s = computeSymbolStats([
      trade({ netPnl: 100 }),
      trade({ netPnl: 50 }),
      trade({ netPnl: -30 }),
    ], TODAY).get("RELIANCE")!;
    expect(s.winRate).toEqual({ pct: 66.67, n: 3 });
  });

  it("avg R averages ONLY trades that carry an rMultiple, and states that count", () => {
    const s = computeSymbolStats([
      trade({ rMultiple: 2 }),
      trade({ rMultiple: -1 }),
      trade({ rMultiple: null, netPnl: -5000 }),
    ], TODAY).get("RELIANCE")!;
    expect(s.avgR).toEqual({ value: 0.5, n: 2 });
  });

  it("avg R is null when no closed trade carries an R, never an invented 0", () => {
    const s = computeSymbolStats([trade({ rMultiple: null })], TODAY).get("RELIANCE")!;
    expect(s.avgR).toBeNull();
  });
});

describe("symbol stats — last traded", () => {
  it("is the most recent buy or sell date across the symbol's trades", () => {
    const s = computeSymbolStats([
      trade({ buyDate: "2026-08-01", sellDate: "2026-08-02" }),
      trade({ buyDate: "2026-08-10", sellDate: null, isOpen: true }),
    ], TODAY).get("RELIANCE")!;
    expect(s.lastTraded).toBe("2026-08-10");
  });

  it("is null when no trade carries any date", () => {
    const s = computeSymbolStats([trade({ buyDate: null, sellDate: null })], TODAY).get("RELIANCE")!;
    expect(s.lastTraded).toBeNull();
  });
});

describe("symbol stats — own-book expiry proximity", () => {
  it("reports days to the NEAREST open F&O expiry on or after today", () => {
    const s = computeSymbolStats([
      trade({ segment: "index_option", isOpen: true, expiry: "2026-09-04", sellDate: null }),
      trade({ segment: "index_option", isOpen: true, expiry: "2026-09-25", sellDate: null }),
    ], TODAY).get("RELIANCE")!;
    expect(s.expiryWithinDays).toBe(4);
  });

  it("ignores closed positions, past expiries and non-F&O segments", () => {
    const s = computeSymbolStats([
      trade({ segment: "index_option", isOpen: false, expiry: "2026-09-04" }),
      trade({ segment: "index_option", isOpen: true, expiry: "2026-08-28", sellDate: null }),
      trade({ segment: "equity_delivery", isOpen: true, expiry: "2026-09-04", sellDate: null }),
    ], TODAY).get("RELIANCE")!;
    expect(s.expiryWithinDays).toBeNull();
  });

  it("counts an expiry TODAY as 0 days out", () => {
    const s = computeSymbolStats([
      trade({ segment: "future", isOpen: true, expiry: TODAY, sellDate: null }),
    ], TODAY).get("RELIANCE")!;
    expect(s.expiryWithinDays).toBe(0);
  });
});
