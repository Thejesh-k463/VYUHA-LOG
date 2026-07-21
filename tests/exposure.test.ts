import { describe, it, expect } from "vitest";
import { computeExposure, sectorConcentration, type ExposureInput } from "@/lib/analytics/exposure";

function pos(p: Partial<ExposureInput>): ExposureInput {
  return {
    id: 1, symbol: "X", tradingsymbol: "X", broker: "groww", bucket: "equity",
    segment: "eq_delivery", exchange: "NSE", optionType: null, strike: null, expiry: null,
    qty: 0, entry: 0, mtm: 0, originalSl: null, trailingSl: null, target: null,
    daysHeld: null, dte: null, ...p,
  };
}

describe("computeExposure", () => {
  const capital = 1_000_000;
  const inputs: ExposureInput[] = [
    pos({ id: 1, qty: 100, entry: 1000, mtm: 1100, originalSl: 950, target: 1200 }),
    pos({ id: 2, qty: 50, entry: 2000, mtm: 1900, originalSl: 1850, target: 2300 }),
    pos({ id: 3, qty: 10, entry: 5000, mtm: 5500 }), // no stop, no target
  ];
  const e = computeExposure(inputs, capital);

  it("per-position math (position A)", () => {
    const a = e.positions[0];
    expect(a.invested).toBe(100000);
    expect(a.allocPct).toBe(10);
    expect(a.unrealised).toBe(10000);
    expect(a.runningImpactPct).toBe(1);
    expect(a.returnPct).toBe(10);
    expect(a.effectiveStop).toBe(950);
    expect(a.openRiskAmt).toBe(15000); // (1100-950)*100
    expect(a.openRiskPct).toBe(1.5);
    expect(a.initialRiskPct).toBe(0.5); // (1000-950)*100 / 1e6
    expect(a.rr).toBe(4); // (1200-1000)/(1000-950)
  });

  it("trailing SL overrides original SL for open risk", () => {
    const t = computeExposure([pos({ qty: 100, entry: 1000, mtm: 1100, originalSl: 950, trailingSl: 1050 })], capital);
    expect(t.positions[0].effectiveStop).toBe(1050);
    expect(t.positions[0].openRiskAmt).toBe(5000); // (1100-1050)*100
    // capital at risk below cost is 0 because stop (1050) is above entry (1000)
    expect(t.positions[0].capitalAtRiskAmt).toBe(0);
  });

  it("unstopped position counts full invested as capital-at-risk", () => {
    const c = e.positions[2];
    expect(c.hasStop).toBe(false);
    expect(c.openRiskPct).toBeNull();
    expect(c.capitalAtRiskAmt).toBe(50000);
  });

  it("portfolio summary aggregates correctly", () => {
    expect(e.allocatedPct).toBe(25); // 10+10+5
    expect(e.openPnlPct).toBe(1); // 1 - 0.5 + 0.5
    expect(e.openRiskPct).toBe(1.75); // 1.5 + 0.25 + 0
    expect(e.initialRiskPct).toBe(1.25); // 0.5 + 0.75
    expect(e.capitalAtRiskPct).toBe(6.25); // 0.5 + 0.75 + 5.0
    expect(e.unstoppedCount).toBe(1);
    expect(e.riskLevel).toBe("high"); // capitalAtRisk > 5
  });

  it("risk level is low when stops lock in profit", () => {
    const safe = computeExposure(
      [pos({ qty: 100, entry: 1000, mtm: 1200, originalSl: 1000, trailingSl: 1150, target: 1400 })],
      capital,
    );
    expect(safe.capitalAtRiskPct).toBe(0);
    expect(safe.riskLevel).toBe("low");
  });
});

describe("computeExposure — short (sell-to-open) positions", () => {
  const capital = 1_000_000;
  // A written (sold) option: entry = premium collected @ 100, SL @ 130 (above
  // entry — correct for a short), target @ 60 (below entry — profit direction).
  const short = pos({ qty: 100, entry: 100, mtm: 80, originalSl: 130, target: 60, side: "short" });

  it("profits when price falls below entry (opposite of long)", () => {
    const e = computeExposure([short], capital);
    const s = e.positions[0];
    expect(s.unrealised).toBe(2000); // (100-80)*100, price fell = profit for the seller
    expect(s.returnPct).toBeCloseTo(20, 6); // 2000 / (100*100 invested)
  });

  it("loses when price rises above entry", () => {
    const up = computeExposure([pos({ qty: 100, entry: 100, mtm: 120, side: "short" })], capital);
    expect(up.positions[0].unrealised).toBe(-2000); // (100-120)*100
  });

  it("open risk / capital-at-risk use the stop-above-entry convention", () => {
    const e = computeExposure([short], capital);
    const s = e.positions[0];
    // give-back if price rises from 80 back up to the 130 stop: (130-80)*100
    expect(s.openRiskAmt).toBe(5000);
    // capital at risk vs cost if stopped: (130-100)*100
    expect(s.capitalAtRiskAmt).toBe(3000);
    // initial risk taken at entry: (130-100)*100
    expect(s.initialRiskAmt).toBe(3000);
  });

  it("reward:risk ratio is direction-invariant (same value as the equivalent long)", () => {
    const e = computeExposure([short], capital);
    // reward 40 (100->60), risk 30 (130-100) => 40/30, rounded to 2dp like the engine does
    expect(e.positions[0].rr).toBeCloseTo(40 / 30, 2);
  });

  it("a mis-entered stop (wrong side of entry for a short) invalidates rr, not crashes", () => {
    const bad = computeExposure([pos({ qty: 100, entry: 100, mtm: 90, originalSl: 90, target: 60, side: "short" })], capital);
    expect(bad.positions[0].rr).toBeNull();
  });

  it("toTargetPct reads positive while more favorable move is still needed", () => {
    const e = computeExposure([short], capital);
    // mtm=80, target=60 — still needs to fall further to reach target
    expect(e.positions[0].toTargetPct).toBeGreaterThan(0);
  });

  it("defaults to long when side is omitted", () => {
    const e = computeExposure([pos({ qty: 100, entry: 100, mtm: 110 })], capital);
    expect(e.positions[0].unrealised).toBe(1000); // long: price up = profit
  });
});

describe("sectorConcentration", () => {
  const capital = 1_000_000;
  // Two banks (60k + 40k = 100k Financials) vs one IT (50k) and one unmapped (50k).
  const positions = [
    { invested: 60000, sector: "Financials" },
    { invested: 40000, sector: "Financials" },
    { invested: 50000, sector: "IT" },
    { invested: 50000, sector: null },
  ];
  const s = sectorConcentration(positions, capital);

  it("aggregates invested by sector, sorted desc", () => {
    expect(s.totalInvested).toBe(200000);
    expect(s.slices.map((x) => x.sector)).toEqual(["Financials", "IT", "Unclassified"]);
    expect(s.slices[0]).toMatchObject({ invested: 100000, allocPct: 10, sharePct: 50, positions: 2 });
  });

  it("reports the top sector and classified coverage", () => {
    expect(s.topSector).toBe("Financials");
    expect(s.topAllocPct).toBe(10); // 100k / 1M
    expect(s.classifiedPct).toBe(75); // 150k of 200k carry a sector
  });

  it("HHI rises with concentration", () => {
    // shares 0.5/0.25/0.25 → 0.25+0.0625+0.0625 = 0.375
    expect(s.hhi).toBeCloseTo(0.375, 4);
    const all = sectorConcentration([{ invested: 100000, sector: "IT" }], capital);
    expect(all.hhi).toBe(1); // single sector
  });

  it("handles no positions", () => {
    const empty = sectorConcentration([], capital);
    expect(empty.totalInvested).toBe(0);
    expect(empty.topSector).toBeNull();
    expect(empty.slices).toEqual([]);
  });
});

describe("staged positions — risk summed across tranches", () => {
  it("sums open risk over tranches instead of using one stop", () => {
    // 100 @ 100 stopped at 95, plus 100 @ 110 stopped at 108, marked at 112.
    // (112-95)*100 + (112-108)*100 = 1700 + 400 = 2100.
    const e = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 112, originalSl: 95, tranches: [
        { qty: 100, price: 100, stop: 95 },
        { qty: 100, price: 110, stop: 108 },
      ] })],
      100000,
    );
    expect(e.positions[0].openRiskAmt).toBe(2100);
  });

  it("is LESS exposed than the widest stop alone would imply", () => {
    const tranched = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 112, originalSl: 95, tranches: [
        { qty: 100, price: 100, stop: 95 },
        { qty: 100, price: 110, stop: 108 },
      ] })],
      100000,
    );
    const widestOnly = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 112, originalSl: 95 })],
      100000,
    );
    expect(widestOnly.positions[0].openRiskAmt).toBe(3400); // (112-95)*200
    expect(tranched.positions[0].openRiskAmt!).toBeLessThan(widestOnly.positions[0].openRiskAmt!);
  });

  it("sums initial risk from each tranche's own fill price", () => {
    const e = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 112, originalSl: 95, tranches: [
        { qty: 100, price: 100, stop: 95 },  // 500
        { qty: 100, price: 110, stop: 108 }, // 200
      ] })],
      100000,
    );
    expect(e.positions[0].initialRiskAmt).toBe(700);
  });

  it("treats an unstopped tranche as fully at risk and marks the position unstopped", () => {
    const e = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 110, originalSl: 95, tranches: [
        { qty: 100, price: 100, stop: 95 },
        { qty: 100, price: 110, stop: null },
      ] })],
      100000,
    );
    expect(e.positions[0].hasStop).toBe(false);
    // (110-95)*100 = 1500 stopped, plus 110*100 = 11000 unstopped.
    expect(e.positions[0].openRiskAmt).toBe(12500);
  });

  it("handles a short's tranches with stops ABOVE the fills", () => {
    const e = computeExposure(
      [pos({ qty: 200, entry: 105, mtm: 100, side: "short", originalSl: 112, tranches: [
        { qty: 100, price: 100, stop: 105 },
        { qty: 100, price: 110, stop: 112 },
      ] })],
      100000,
    );
    // (105-100)*100 + (112-100)*100 = 500 + 1200
    expect(e.positions[0].openRiskAmt).toBe(1700);
    expect(e.positions[0].initialRiskAmt).toBe(700); // (105-100)*100 + (112-110)*100
  });

  it("falls back to the single-stop path when no tranches are supplied", () => {
    const withNull = computeExposure([pos({ qty: 100, entry: 100, mtm: 110, originalSl: 95, tranches: null })], 100000);
    const without = computeExposure([pos({ qty: 100, entry: 100, mtm: 110, originalSl: 95 })], 100000);
    expect(withNull.positions[0].openRiskAmt).toBe(without.positions[0].openRiskAmt);
    expect(without.positions[0].openRiskAmt).toBe(1500);
  });

  it("matches the classic path exactly for a one-tranche ladder", () => {
    const staged = computeExposure(
      [pos({ qty: 100, entry: 100, mtm: 110, originalSl: 95, tranches: [{ qty: 100, price: 100, stop: 95 }] })],
      100000,
    );
    const classic = computeExposure([pos({ qty: 100, entry: 100, mtm: 110, originalSl: 95 })], 100000);
    expect(staged.positions[0].openRiskAmt).toBe(classic.positions[0].openRiskAmt);
    expect(staged.positions[0].initialRiskAmt).toBe(classic.positions[0].initialRiskAmt);
    expect(staged.positions[0].capitalAtRiskAmt).toBe(classic.positions[0].capitalAtRiskAmt);
  });
});
