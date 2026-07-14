import { describe, expect, it } from "vitest";
import { computeMaeMfe, stopTuningReport, type MaeBar, type MaeTradeInput, type MaeMfeRow } from "../lib/analytics/mae-mfe";

const bars = new Map<string, MaeBar[]>([
  [
    "ATGL",
    [
      { date: "2026-07-01", high: 105, low: 95, close: 100 },
      { date: "2026-07-02", high: 120, low: 98, close: 118 },
      { date: "2026-07-03", high: 119, low: 90, close: 92 },
      { date: "2026-07-04", high: 111, low: 101, close: 110 },
    ],
  ],
]);

const t = (over: Partial<MaeTradeInput>): MaeTradeInput => ({
  id: 1,
  symbol: "ATGL",
  ticker: "ATGL",
  side: "long",
  qty: 100,
  entry: 100,
  exit: 110,
  entryDate: "2026-07-01",
  exitDate: "2026-07-04",
  netPnl: 950,
  isOpen: false,
  ...over,
});

describe("computeMaeMfe", () => {
  it("computes MAE/MFE for a long over the holding window", () => {
    const r = computeMaeMfe([t({})], bars);
    expect(r.covered).toBe(1);
    const row = r.rows[0];
    // window hi 120, lo 90; entry 100 → MFE (120−100)×100 = 2000, MAE (100−90)×100 = 1000
    expect(row.mfeRs).toBe(2000);
    expect(row.maeRs).toBe(1000);
    // exit 110 captured (110−100)×100 = 1000 of the 2000 favorable → 50%
    expect(row.capturedPct).toBe(50);
    expect(row.edgeRatio).toBe(2);
  });

  it("flips favorable/adverse for a short", () => {
    const r = computeMaeMfe([t({ side: "short", entry: 110, exit: 95 })], bars);
    const row = r.rows[0];
    // short from 110: favorable = 110−90 = 20/unit → 2000; adverse = 120−110 = 10/unit → 1000
    expect(row.mfeRs).toBe(2000);
    expect(row.maeRs).toBe(1000);
    expect(row.capturedPct).toBe(75); // (110−95)×100 / 2000
  });

  it("respects the date window (excludes bars outside it)", () => {
    const r = computeMaeMfe([t({ entryDate: "2026-07-01", exitDate: "2026-07-02" })], bars);
    const row = r.rows[0];
    expect(row.barsUsed).toBe(2);
    expect(row.maeRs).toBe(500); // lo 95 only
  });

  it("buckets uncovered symbols and undated trades separately", () => {
    const r = computeMaeMfe(
      [t({ id: 1, ticker: "NOPE" }), t({ id: 2, entryDate: null }), t({ id: 3, isOpen: true })],
      bars,
    );
    expect(r.covered).toBe(0);
    expect(r.uncovered).toBe(1);
    expect(r.undated).toBe(1);
  });

  it("clamps negative capture to 0% and averages summary stats", () => {
    const r = computeMaeMfe([t({ id: 1, exit: 96 }), t({ id: 2 })], bars);
    const worst = r.rows.find((x) => x.id === 1)!;
    expect(worst.capturedPct).toBe(0);
    expect(r.avgCapturedPct).toBe(25); // (0 + 50) / 2
  });

  it("normalizes MAE/MFE to R when a risk amount is recorded", () => {
    const r = computeMaeMfe([t({ riskAmount: 2000 })], bars);
    expect(r.rows[0].maeR).toBe(0.5); // 1000 / 2000
    expect(r.rows[0].mfeR).toBe(1); // 2000 / 2000
    const noRisk = computeMaeMfe([t({})], bars);
    expect(noRisk.rows[0].maeR).toBeNull();
  });
});

describe("stopTuningReport", () => {
  const row = (over: Partial<MaeMfeRow>): MaeMfeRow => ({
    id: 1, symbol: "X", side: "long", qty: 100, entry: 100, exit: 110,
    entryDate: "2026-07-01", exitDate: "2026-07-04", barsUsed: 4,
    maeRs: 0, mfeRs: 0, capturedPct: null, edgeRatio: null, netPnl: 0,
    maeR: null, mfeR: null,
    ...over,
  });

  it("splits winners/losers and averages MAE in R", () => {
    const rep = stopTuningReport([
      row({ netPnl: 1000, maeR: 0.9 }),
      row({ netPnl: 1000, maeR: 0.3 }),
      row({ netPnl: -1000, maeR: 1.0 }),
      row({ netPnl: -1000, maeR: 1.5 }), // ran past the stop
      row({ netPnl: 1000, maeR: null }), // no recorded risk → excluded
    ]);
    expect(rep.sampled).toBe(4);
    expect(rep.winners).toBe(2);
    expect(rep.losers).toBe(2);
    expect(rep.avgWinnerMaeR).toBe(0.6);
    expect(rep.winnersHeatOver80Pct).toBe(50);
    expect(rep.losersBeyond1RPct).toBe(50);
  });

  it("small samples always carry a noise warning", () => {
    const rep = stopTuningReport([row({ netPnl: 500, maeR: 0.2 })]);
    expect(rep.suggestions.some((s) => s.includes("noise"))).toBe(true);
  });

  it("high winner heat warns against tightening the stop", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: i, netPnl: 1000, maeR: 0.9 }));
    const rep = stopTuningReport(rows);
    expect(rep.suggestions.some((s) => s.includes("cautious about tightening"))).toBe(true);
  });

  it("stop slippage on losers is flagged as behavioral, not placement", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: i, netPnl: -1000, maeR: 1.6 }));
    const rep = stopTuningReport(rows);
    expect(rep.suggestions.some((s) => s.includes("behavioral"))).toBe(true);
  });
});
