import { describe, expect, it } from "vitest";
import { computeMaeMfe, type MaeBar, type MaeTradeInput } from "../lib/analytics/mae-mfe";

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
});
