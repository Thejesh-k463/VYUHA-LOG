import { describe, expect, it } from "vitest";
import {
  turnoverOf,
  turnoverContribution,
  TURNOVER_BASIS,
  FNO_SEGMENTS,
  OPTION_SEGMENTS,
  DELIVERY_SEGMENTS,
  SPECULATIVE_SEGMENT,
  type TurnoverTrade,
} from "@/lib/analytics/turnover";

const t = (over: Partial<TurnoverTrade> = {}): TurnoverTrade => ({
  segment: "index_option",
  grossPnl: 0,
  sellValue: 0,
  isOpen: false,
  ...over,
});

describe("turnoverContribution — ICAI GN 11th ed. para 5.11(b)", () => {
  it("(i) counts the ABSOLUTE difference, so a loss adds turnover", () => {
    expect(turnoverContribution(t({ segment: "future", grossPnl: -7000 }))).toBe(7000);
    expect(turnoverContribution(t({ segment: "future", grossPnl: 7000 }))).toBe(7000);
  });

  it("(ii) adds option sell premium ON TOP of the difference", () => {
    // THE defect: this returned 5000 before, omitting ₹2,00,000 of premium.
    expect(turnoverContribution(t({ segment: "index_option", grossPnl: 5000, sellValue: 200000 }))).toBe(
      205000,
    );
  });

  it("(ii) premium applies to every option segment, and to none other", () => {
    for (const segment of OPTION_SEGMENTS) {
      expect(turnoverContribution(t({ segment, grossPnl: 100, sellValue: 5000 }))).toBe(5100);
    }
    // Futures are non-speculative business too, but carry no premium.
    expect(turnoverContribution(t({ segment: "future", grossPnl: 100, sellValue: 5000 }))).toBe(100);
    expect(turnoverContribution(t({ segment: "commodity_future", grossPnl: 100, sellValue: 5000 }))).toBe(100);
    // Intraday equity is speculative: differences only.
    expect(turnoverContribution(t({ segment: SPECULATIVE_SEGMENT, grossPnl: 100, sellValue: 5000 }))).toBe(100);
  });

  it("(iv) an OPEN position contributes nothing — it counts when squared off", () => {
    expect(turnoverContribution(t({ grossPnl: 9999, sellValue: 9999, isOpen: true }))).toBe(0);
  });

  it("uses GROSS, not net — turnover is a difference, before charges", () => {
    // A caller passing netPnl would silently understate turnover by the charges.
    expect(turnoverContribution(t({ segment: "future", grossPnl: 1000 }))).toBe(1000);
  });

  it("never treats a negative consideration as negative premium", () => {
    expect(turnoverContribution(t({ segment: "index_option", grossPnl: 100, sellValue: -50 }))).toBe(100);
  });
});

describe("turnoverOf — workings", () => {
  it("separates differences from premium and totals them", () => {
    const r = turnoverOf([
      t({ segment: "index_option", grossPnl: 5000, sellValue: 200000 }),
      t({ segment: "index_option", grossPnl: -3000, sellValue: 150000 }),
      t({ segment: "future", grossPnl: 2000, sellValue: 999999 }),
    ]);
    expect(r.differences).toBe(10000); // 5000 + 3000 + 2000
    expect(r.optionPremium).toBe(350000); // futures contribute none
    expect(r.total).toBe(360000);
    expect(r.trades).toBe(3);
    expect(r.openExcluded).toBe(0);
  });

  it("reports how many open positions it excluded rather than hiding them", () => {
    const r = turnoverOf([t({ grossPnl: 100 }), t({ grossPnl: 500, isOpen: true })]);
    expect(r.trades).toBe(1);
    expect(r.openExcluded).toBe(1);
    expect(r.total).toBe(100);
  });

  it("an empty book is zero, not a fabricated figure", () => {
    const r = turnoverOf([]);
    expect(r).toEqual({ differences: 0, optionPremium: 0, total: 0, trades: 0, openExcluded: 0 });
  });

  it("premium can dominate — the reason the old method could hide an audit", () => {
    // A seller with tiny net P&L but large premium turnover.
    const r = turnoverOf(
      Array.from({ length: 100 }, () => t({ segment: "index_option", grossPnl: 500, sellValue: 500000 })),
    );
    expect(r.differences).toBe(50000);
    expect(r.optionPremium).toBe(50000000);
    // The superseded method would have reported ₹50,000 for a ₹5 Cr book.
    expect(r.total / r.differences).toBeGreaterThan(1000);
  });
});

describe("segment sets are the single source", () => {
  it("options are a strict subset of F&O", () => {
    for (const s of OPTION_SEGMENTS) expect(FNO_SEGMENTS.has(s)).toBe(true);
    expect(OPTION_SEGMENTS.size).toBeLessThan(FNO_SEGMENTS.size);
  });

  it("delivery and speculative are disjoint from F&O — heads must not overlap", () => {
    for (const s of DELIVERY_SEGMENTS) expect(FNO_SEGMENTS.has(s)).toBe(false);
    expect(FNO_SEGMENTS.has(SPECULATIVE_SEGMENT)).toBe(false);
    expect(DELIVERY_SEGMENTS.has(SPECULATIVE_SEGMENT)).toBe(false);
  });
});

describe("the basis is disclosed, not buried", () => {
  it("names the edition and admits it is guidance rather than statute", () => {
    expect(TURNOVER_BASIS).toContain("11th edition");
    expect(TURNOVER_BASIS).toContain("5.11(b)");
    expect(TURNOVER_BASIS).toContain("not statute");
  });
});
