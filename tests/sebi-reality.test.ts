import { describe, it, expect } from "vitest";
import { computeFnoReality, isFnoSegment, type FnoTradeInput } from "@/lib/analytics/sebi-reality";

const t = (segment: string, netPnl: number, grossPnl: number, chargesTotal: number, isOpen = false): FnoTradeInput => ({
  segment, netPnl, grossPnl, chargesTotal, isOpen,
});

describe("isFnoSegment", () => {
  it("recognises derivative segments only", () => {
    expect(isFnoSegment("stock_option")).toBe(true);
    expect(isFnoSegment("index_option")).toBe(true);
    expect(isFnoSegment("future")).toBe(true);
    expect(isFnoSegment("commodity_future")).toBe(true);
    expect(isFnoSegment("eq_delivery")).toBe(false);
    expect(isFnoSegment("eq_intraday")).toBe(false);
  });
});

describe("computeFnoReality", () => {
  it("filters to closed F&O trades and computes win rate + net", () => {
    const r = computeFnoReality([
      t("stock_option", 5000, 5200, 200),
      t("index_option", -3000, -2800, 200),
      t("future", -2000, -1850, 150),
      t("eq_delivery", 9000, 9100, 100), // ignored (not F&O)
      t("stock_option", 1000, 1100, 100, true), // ignored (open)
    ]);
    expect(r.closed).toBe(3);
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(2);
    expect(r.winRatePct).toBeCloseTo(33.33, 1);
    expect(r.netPnl).toBe(0); // 5000 − 3000 − 2000
  });

  it("flags a net-negative book against the SEBI backdrop", () => {
    const r = computeFnoReality([
      t("index_option", -8000, -7700, 300),
      t("stock_option", 2000, 2200, 200),
    ]);
    expect(r.profitable).toBe(false);
    expect(r.netPnl).toBe(-6000);
    expect(r.biggestLoss).toBe(-8000);
    expect(r.verdict).toMatch(/91\.1%/);
    expect(r.verdict).toMatch(/net negative/i);
  });

  it("recognises a profitable minority and computes profit factor", () => {
    const r = computeFnoReality([
      t("future", 10000, 10300, 300),
      t("future", 6000, 6200, 200),
      t("stock_option", -4000, -3800, 200),
    ]);
    expect(r.profitable).toBe(true);
    expect(r.netPnl).toBe(12000);
    // gross win 16000 ÷ |loss| 4000 = 4
    expect(r.profitFactor).toBe(4);
    expect(r.verdict).toMatch(/minority/i);
  });

  it("reports charge drag relative to gross", () => {
    const r = computeFnoReality([t("index_option", 800, 1000, 200)]);
    expect(r.chargesTotal).toBe(200);
    expect(r.chargeDragPct).toBe(20); // 200 / 1000
  });

  it("empty F&O history → no data, neutral copy", () => {
    const r = computeFnoReality([t("eq_delivery", 5000, 5100, 100)]);
    expect(r.hasData).toBe(false);
    expect(r.closed).toBe(0);
    expect(r.verdict).toMatch(/No closed F&O/i);
  });
});
