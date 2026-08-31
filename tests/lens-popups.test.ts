import { describe, expect, it } from "vitest";
import {
  lensChargeHeads,
  toLensRow,
  GROUP_INSIGHT_CAP,
  type LensChargeTrade,
} from "@/lib/domain/lens-edge";
import { computeKpis, type AnalyticsTrade } from "@/lib/analytics/metrics";
import type { Insight } from "@/lib/intelligence/insight";

/**
 * U2 — the lens drill-down popups. What crosses the wire per group is a
 * SERVER-side aggregation: ~10 charge-head sums plus at most three insights.
 * These tests pin the two honesty rails the popups rest on:
 *
 *   1. the charge-head split reconciles with the Charges KPI (closed trades
 *      only, same rounding), so the card and its popup can never disagree;
 *   2. a group with nothing closed gets `null`, not a row of zeroes — ten
 *      zeroes would read as "this group cost nothing" (invariant 6).
 */

const chargeRow = (over: Partial<LensChargeTrade> = {}): LensChargeTrade => ({
  isOpen: false,
  segment: "eq_delivery",
  sellDate: "2026-07-10",
  buyValue: 10000,
  sellValue: 11000,
  grossPnl: 1000,
  netPnl: 940,
  brokerage: 20,
  sttCtt: 11,
  exchangeTxn: 0.7,
  sebi: 0.02,
  stampDuty: 1.5,
  ipft: 0.02,
  gst: 3.8,
  dpCharges: 15.34,
  mtfInterest: 0,
  pledgeCharges: 0,
  chargesTotal: 52.38,
  ...over,
});

describe("lensChargeHeads", () => {
  it("sums every head over closed trades and derives breakeven from turnover", () => {
    const h = lensChargeHeads([chargeRow(), chargeRow()])!;
    expect(h.brokerage).toBe(40);
    expect(h.sttCtt).toBe(22);
    expect(h.statutory).toBeCloseTo(2 * (0.02 + 1.5 + 0.02), 2); // sebi + stamp + ipft
    expect(h.gst).toBeCloseTo(7.6, 2);
    expect(h.dpCharges).toBeCloseTo(30.68, 2);
    expect(h.total).toBeCloseTo(104.76, 2);
    expect(h.turnover).toBe(42000);
    expect(h.breakevenPct).toBeCloseTo((104.76 / 42000) * 100, 2);
  });

  it("keeps to CLOSED trades so the split reconciles with the Charges KPI", () => {
    // computeKpis sums charges over closed trades only; a head split that
    // counted the open leg would total more than the card it explains.
    const h = lensChargeHeads([
      chargeRow(),
      chargeRow({ isOpen: true, sellDate: null, brokerage: 999, chargesTotal: 999 }),
    ])!;
    expect(h.brokerage).toBe(20);
    expect(h.total).toBeCloseTo(52.38, 2);
  });

  it("returns null — not ten zeroes — when nothing is closed", () => {
    expect(lensChargeHeads([])).toBeNull();
    expect(lensChargeHeads([chargeRow({ isOpen: true })])).toBeNull();
  });
});

describe("toLensRow extras", () => {
  const trade = (over: Partial<AnalyticsTrade> = {}): AnalyticsTrade => ({
    broker: "dhan", bucket: "equity", segment: "eq_delivery",
    netPnl: 500, grossPnl: 520, chargesTotal: 20, rMultiple: 1.5,
    isOpen: false, sellDate: "2026-07-10", buyDate: "2026-07-01",
    setupTag: null, buyValue: 1000,
    ...over,
  } as AnalyticsTrade);

  const insight = (id: string): Insight => ({
    id, tone: "info", headline: `headline ${id}`, evidence: [], sampleSize: 12,
  });

  it("chargeHeads ride the FREE side — present for an unlicensed row", () => {
    const heads = lensChargeHeads([chargeRow()]);
    const row = toLensRow(computeKpis([trade()]), false, { chargeHeads: heads });
    expect(row.edge).toBeNull();
    expect(row.totals.chargeHeads).toEqual(heads);
  });

  it("caps insights at the presentation budget, in rule order", () => {
    const five = ["a", "b", "c", "d", "e"].map(insight);
    const row = toLensRow(computeKpis([trade()]), true, { insights: five });
    expect(row.insights).toHaveLength(GROUP_INSIGHT_CAP);
    expect(row.insights!.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("omits the insights key entirely for an empty list — no decoy field", () => {
    const row = toLensRow(computeKpis([trade()]), true, { insights: [] });
    expect("insights" in row).toBe(false);
  });

  it("pro edge carries the streak and average figures computeKpis measured", () => {
    const trades = [
      trade({ netPnl: 400, sellDate: "2026-07-08" }),
      trade({ netPnl: 600, sellDate: "2026-07-09" }),
      trade({ netPnl: -200, sellDate: "2026-07-10" }),
    ];
    const k = computeKpis(trades);
    const row = toLensRow(k, true);
    expect(row.edge!.maxWinStreak).toBe(2);
    expect(row.edge!.maxLossStreak).toBe(1);
    expect(row.edge!.currentStreak).toBe(-1);
    expect(row.edge!.avgWin).toBe(500);
    expect(row.edge!.avgLoss).toBe(-200);
  });
});
