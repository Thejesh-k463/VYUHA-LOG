import { describe, it, expect } from "vitest";
import {
  sizeFixedRupee,
  sizeFixedFractional,
  sizeVolatilityUnit,
  sizePctVolatility,
  sizeKelly,
  sizeFixedRatio,
  sizeEqualWeight,
  applyDeployCap,
  lotRound,
  isqrt,
  compareAll,
  resolveIndexLotSize,
  type SizeResult,
  type SizingSetup,
} from "@/lib/risk/sizing";

/**
 * The owner's worked example (03-SIZING-RISK-RESEARCH §2), in paise:
 * capital Rs 10,00,000 - entry Rs 2,850 - stop Rs 2,600 - risk 2%.
 * riskPerShare = Rs 250, riskBudget = Rs 20,000, cash equity so lotSize = 1.
 * Assumed inputs (marked [I] in §2): ATR(20) Rs 85, win 45%, payoff 2R,
 * fixed-ratio delta Rs 50,000 on Rs 1,50,000 closed profit with an 80-share
 * block, deploy cap 25%, 8 portfolio slots.
 */
const CAPITAL_P = 100_000_000;
const ENTRY_P = 285_000;
const STOP_P = 260_000;
const RISK_PPM = 20_000;
const ATR_P3 = 8_500_000; // Rs 85.00 carried as paise x 1000
const FIXED_AMOUNT_P = 10_000_000; // Rs 1,00,000
const WIN_PPM = 450_000;
const PAYOFF_PPM = 2_000_000;
const DELTA_P = 5_000_000; // Rs 50,000
const CLOSED_PROFIT_P = 15_000_000; // Rs 1,50,000
const BLOCK_QTY = 80;
const SLOTS = 8;
const DEPLOY_CAP_PPM = 250_000; // 25%

const base = { entryP: ENTRY_P, stopP: STOP_P, lotSize: 1 };
const cap = { capitalP: CAPITAL_P, deployCapPpm: DEPLOY_CAP_PPM, entryP: ENTRY_P, lotSize: 1 };

describe("worked example - the eight figures from 03 §2", () => {
  it("row 1 - fixed rupee Rs 1,00,000 -> 35 shares", () => {
    const r = sizeFixedRupee({ ...base, amountP: FIXED_AMOUNT_P, capitalP: CAPITAL_P });
    expect(r.qty).toBe(35);
    expect(r.deployedP).toBe(9_975_000); // Rs 99,750
    expect(r.pctOfCapitalPpm).toBe(99_750); // 9.975%
    expect(r.riskAtStopP).toBe(875_000); // Rs 8,750
    expect(r.riskPctOfCapitalPpm).toBe(8_750); // 0.875%
  });

  it("row 2 - fixed fractional 2% -> 80 shares", () => {
    const r = sizeFixedFractional({ ...base, capitalP: CAPITAL_P, riskPpm: RISK_PPM });
    expect(r.qty).toBe(80);
    expect(r.deployedP).toBe(22_800_000); // Rs 2,28,000
    expect(r.pctOfCapitalPpm).toBe(228_000); // 22.8%
    expect(r.riskAtStopP).toBe(2_000_000); // Rs 20,000, the full budget
    expect(r.riskPctOfCapitalPpm).toBe(20_000); // exactly 2%
  });

  it("row 3 - the 25% deploy cap does not bind on fixed fractional", () => {
    const r = applyDeployCap(sizeFixedFractional({ ...base, capitalP: CAPITAL_P, riskPpm: RISK_PPM }), cap);
    expect(r.qty).toBe(80);
    expect(r.clippedBy).toBeNull();
    expect(r.flags).not.toContain("deploy-capped");
  });

  it("row 4 - Turtle unit, 1% of capital per N -> 117 shares", () => {
    const r = sizeVolatilityUnit({
      ...base,
      capitalP: CAPITAL_P,
      unitRiskPpm: 10_000,
      atrP3: ATR_P3,
      nStopMult: 2000,
    });
    expect(r.qty).toBe(117);
    expect(r.deployedP).toBe(33_345_000); // Rs 3,33,450
    expect(r.pctOfCapitalPpm).toBe(333_450); // 33.345%
    expect(r.riskAtStopP).toBe(2_925_000); // Rs 29,250 at the user's Rs 2,600 stop
    // The rulebook's own 2N stop is Rs 2,680, where the same 117 shares risk
    // Rs 19,890 = 1.99% of capital, which is the unit the method sized for.
    expect(r.turtleStopP).toBe(268_000);
    expect(r.qty * (ENTRY_P - (r.turtleStopP as number))).toBe(1_989_000);
  });

  it("row 5 - percentage volatility (Varsity), 2% divided by N -> 235 shares", () => {
    const r = sizePctVolatility({ ...base, capitalP: CAPITAL_P, riskPpm: RISK_PPM, atrP3: ATR_P3 });
    expect(r.qty).toBe(235);
    expect(r.deployedP).toBe(66_975_000); // Rs 6,69,750
    expect(r.riskAtStopP).toBe(5_875_000); // Rs 58,750
    // The two volatility variants differ by about 2x on the same inputs, which
    // is why the tab states which one produced the number.
    const turtle = sizeVolatilityUnit({ ...base, capitalP: CAPITAL_P, unitRiskPpm: 10_000, atrP3: ATR_P3 });
    expect(r.qty).toBeGreaterThan(turtle.qty * 2 - 1);
  });

  it("row 6 - Kelly at full fraction -> 700 shares, f = 17.5%", () => {
    const r = sizeKelly({
      ...base,
      capitalP: CAPITAL_P,
      winPpm: WIN_PPM,
      payoffPpm: PAYOFF_PPM,
      kellyFractionPpm: 1_000_000,
    });
    expect(r.kellyFPpm).toBe(175_000); // 17.5%
    expect(r.qty).toBe(700);
    expect(r.deployedP).toBe(199_500_000); // Rs 19,95,000
    expect(r.pctOfCapitalPpm).toBe(1_995_000); // 199.5% of capital
    expect(r.riskAtStopP).toBe(17_500_000); // Rs 1,75,000
  });

  it("rows 6a/6b - half and quarter Kelly -> 350 and 175 shares", () => {
    const half = sizeKelly({ ...base, capitalP: CAPITAL_P, winPpm: WIN_PPM, payoffPpm: PAYOFF_PPM, kellyFractionPpm: 500_000 });
    const quarter = sizeKelly({ ...base, capitalP: CAPITAL_P, winPpm: WIN_PPM, payoffPpm: PAYOFF_PPM, kellyFractionPpm: 250_000 });
    expect(half.qty).toBe(350);
    expect(quarter.qty).toBe(175);
    expect(quarter.kellyFUsedPpm).toBe(43_750); // 4.375%
  });

  it("row 6c - quarter Kelly clipped by the 25% deploy cap -> 87 shares", () => {
    const r = applyDeployCap(
      sizeKelly({ ...base, capitalP: CAPITAL_P, winPpm: WIN_PPM, payoffPpm: PAYOFF_PPM, kellyFractionPpm: 250_000 }),
      cap,
    );
    expect(r.qty).toBe(87);
    expect(r.deployedP).toBe(24_795_000); // Rs 2,47,950
    expect(r.pctOfCapitalPpm).toBe(247_950); // 24.795%, inside the 25% cap
    expect(r.riskAtStopP).toBe(2_175_000); // Rs 21,750
    expect(r.clippedBy).toBe("deployCap");
    expect(r.flags).toContain("deploy-capped");
  });

  it("row 7 - fixed ratio, delta Rs 50,000 on Rs 1,50,000 profit -> 3 units, 240 shares", () => {
    const r = sizeFixedRatio({
      ...base,
      capitalP: CAPITAL_P,
      deltaP: DELTA_P,
      closedProfitP: CLOSED_PROFIT_P,
      blockQty: BLOCK_QTY,
    });
    expect(r.units).toBe(3);
    expect(r.qty).toBe(240);
    expect(r.deployedP).toBe(68_400_000); // Rs 6,84,000
    expect(r.riskAtStopP).toBe(6_000_000); // Rs 60,000
  });

  it("row 8 - equal weight across 8 slots -> 43 shares", () => {
    const r = sizeEqualWeight({ ...base, capitalP: CAPITAL_P, slots: SLOTS });
    expect(r.qty).toBe(43);
    expect(r.deployedP).toBe(12_255_000); // Rs 1,22,550
    expect(r.pctOfCapitalPpm).toBe(122_550); // 12.255%
    expect(r.riskAtStopP).toBe(1_075_000); // Rs 10,750
  });
});

describe("the two traps from 03", () => {
  it("trap 1 - sized on N but stopped wider than 2N flags wider-than-n-stop", () => {
    // Rs 250 of stop distance over an Rs 85 N is 2.94 N, past the 2.0 N the
    // Turtle unit sized for, so the position carries more than one unit.
    const r = sizeVolatilityUnit({
      ...base,
      capitalP: CAPITAL_P,
      unitRiskPpm: 10_000,
      atrP3: ATR_P3,
      nStopMult: 2000,
    });
    expect(r.stopToNPermille).toBe(2941);
    expect(r.flags).toContain("wider-than-n-stop");

    // At the rulebook's own 2N stop the flag does not fire.
    const atTurtleStop = sizeVolatilityUnit({
      ...base,
      stopP: 268_000,
      capitalP: CAPITAL_P,
      unitRiskPpm: 10_000,
      atrP3: ATR_P3,
      nStopMult: 2000,
    });
    expect(atTurtleStop.stopToNPermille).toBe(2000);
    expect(atTurtleStop.flags).not.toContain("wider-than-n-stop");
  });

  it("trap 2 - full Kelly exceeds capital and the cap clips it", () => {
    const raw = sizeKelly({ ...base, capitalP: CAPITAL_P, winPpm: WIN_PPM, payoffPpm: PAYOFF_PPM });
    expect(raw.deployedP).toBeGreaterThan(CAPITAL_P);
    expect(raw.flags).toContain("exceeds-capital");

    const clipped = applyDeployCap(raw, cap);
    expect(clipped.qty).toBe(87);
    expect(clipped.deployedP).toBeLessThanOrEqual(Math.floor((CAPITAL_P * DEPLOY_CAP_PPM) / 1_000_000));
    expect(clipped.clippedBy).toBe("deployCap");
    expect(clipped.flags).toContain("deploy-capped");
    expect(clipped.flags).not.toContain("exceeds-capital");
  });
});

describe("paise-safe invariants across every method", () => {
  const setup: SizingSetup = {
    capitalP: CAPITAL_P,
    entryP: ENTRY_P,
    stopP: STOP_P,
    riskPpm: RISK_PPM,
    atrP3: ATR_P3,
    fixedAmountP: FIXED_AMOUNT_P,
    winPpm: WIN_PPM,
    payoffPpm: PAYOFF_PPM,
    deltaP: DELTA_P,
    closedProfitP: CLOSED_PROFIT_P,
    blockQty: BLOCK_QTY,
    slots: SLOTS,
  };

  const rows = compareAll(setup);

  it("compareAll returns one row per method, in catalogue order", () => {
    expect(rows.map((r) => r.method)).toEqual([
      "fixed-rupee",
      "fixed-fractional",
      "volatility-unit",
      "pct-volatility",
      "kelly",
      "fixed-ratio",
      "equal-weight",
    ]);
    expect(rows.map((r) => r.qty)).toEqual([35, 80, 117, 235, 700, 240, 43]);
  });

  it("every quantity is a non-negative integer", () => {
    for (const r of rows) {
      expect(Number.isInteger(r.qty)).toBe(true);
      expect(r.qty).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.deployedP)).toBe(true);
      expect(Number.isFinite(r.riskAtStopP)).toBe(true);
    }
  });

  it("the risk-budgeted methods never over-risk the budget through rounding", () => {
    const riskBudgetP = Math.floor((CAPITAL_P * RISK_PPM) / 1_000_000);
    const ff = rows.find((r) => r.method === "fixed-fractional") as SizeResult;
    expect(ff.qty * (ff.riskPerShareP as number)).toBeLessThanOrEqual(riskBudgetP);
    for (let entry = 100_000; entry <= 300_000; entry += 7_777) {
      for (let dist = 137; dist <= 40_000; dist += 4_321) {
        const r = sizeFixedFractional({ capitalP: CAPITAL_P, riskPpm: RISK_PPM, entryP: entry, stopP: entry - dist });
        expect(r.qty * dist).toBeLessThanOrEqual(riskBudgetP);
      }
    }
  });

  it("the deploy cap applied to every row never raises a quantity", () => {
    const capped = compareAll({ ...setup, deployCapPpm: DEPLOY_CAP_PPM });
    capped.forEach((c, idx) => {
      expect(c.qty).toBeLessThanOrEqual(rows[idx]!.qty);
      if (c.qty < rows[idx]!.qty) expect(c.clippedBy).toBe("deployCap");
    });
    expect(capped.map((r) => r.qty)).toEqual([35, 80, 87, 87, 87, 87, 43]);
  });

  it("a method with a missing input keeps its row and states a typed error", () => {
    const sparse = compareAll({ capitalP: CAPITAL_P, entryP: ENTRY_P, stopP: STOP_P, riskPpm: RISK_PPM });
    expect(sparse).toHaveLength(7);
    expect(sparse.find((r) => r.method === "kelly")).toMatchObject({ ok: false, qty: 0, error: "non-positive-payoff" });
    expect(sparse.find((r) => r.method === "volatility-unit")?.error).toBe("non-positive-atr");
    expect(sparse.find((r) => r.method === "fixed-fractional")?.ok).toBe(true);
  });
});

describe("typed errors, never Infinity or NaN", () => {
  it("a stop equal to entry is a typed error on every risk-based method", () => {
    const flat = { entryP: ENTRY_P, stopP: ENTRY_P, lotSize: 1 };
    for (const r of [
      sizeFixedRupee({ ...flat, amountP: FIXED_AMOUNT_P }),
      sizeFixedFractional({ ...flat, capitalP: CAPITAL_P, riskPpm: RISK_PPM }),
      sizeVolatilityUnit({ ...flat, capitalP: CAPITAL_P, unitRiskPpm: 10_000, atrP3: ATR_P3 }),
      sizePctVolatility({ ...flat, capitalP: CAPITAL_P, riskPpm: RISK_PPM, atrP3: ATR_P3 }),
      sizeKelly({ ...flat, capitalP: CAPITAL_P, winPpm: WIN_PPM, payoffPpm: PAYOFF_PPM }),
      sizeFixedRatio({ ...flat, deltaP: DELTA_P, closedProfitP: CLOSED_PROFIT_P, blockQty: BLOCK_QTY }),
      sizeEqualWeight({ ...flat, capitalP: CAPITAL_P, slots: SLOTS }),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe("non-positive-risk-per-share");
      expect(r.qty).toBe(0);
      expect(Number.isFinite(r.deployedP)).toBe(true);
    }
  });

  it("unconfigured capital is a typed error, and percentages stay null", () => {
    const r = sizeFixedFractional({ ...base, capitalP: 0, riskPpm: RISK_PPM });
    expect(r).toMatchObject({ ok: false, error: "capital-unconfigured", qty: 0 });
    expect(r.pctOfCapitalPpm).toBeNull();
    expect(r.riskPctOfCapitalPpm).toBeNull();
  });

  it("a method with no capital denominator reports null, not zero", () => {
    const r = sizeFixedRupee({ ...base, amountP: FIXED_AMOUNT_P });
    expect(r.ok).toBe(true);
    expect(r.qty).toBe(35);
    expect(r.pctOfCapitalPpm).toBeNull();
    expect(r.riskPctOfCapitalPpm).toBeNull();
  });

  it("a non-positive Kelly fraction returns no size and says so", () => {
    // 30% win rate at 2R: f = 0.30 - 0.70/2 = -0.05
    const r = sizeKelly({ ...base, capitalP: CAPITAL_P, winPpm: 300_000, payoffPpm: PAYOFF_PPM });
    expect(r.kellyFPpm).toBe(-50_000);
    expect(r.qty).toBe(0);
    expect(r.flags).toContain("non-positive-kelly");
    expect(r.flags).toContain("zero-size");
  });

  it("a stop distance past the risk budget returns zero size, not a fraction", () => {
    const r = sizeFixedFractional({ entryP: ENTRY_P, stopP: 1, capitalP: 1_000_000, riskPpm: 10_000, lotSize: 1 });
    expect(r.qty).toBe(0);
    expect(r.flags).toContain("zero-size");
  });
});

describe("lot rounding floors, never rounds", () => {
  it("lotRound(129, 65) -> 65", () => {
    expect(lotRound(129, 65)).toBe(65);
    expect(lotRound(130, 65)).toBe(130);
    expect(lotRound(64, 65)).toBe(0);
  });

  it("a NIFTY-lot position floors to whole lots and reports them", () => {
    // riskBudget Rs 20,000 over Rs 250 = 80 raw; one NIFTY lot is 65.
    const r = sizeFixedFractional({ ...base, lotSize: 65, capitalP: CAPITAL_P, riskPpm: RISK_PPM });
    expect(r.qty).toBe(65);
    expect(r.lots).toBe(1);
    expect(r.riskAtStopP).toBeLessThanOrEqual(2_000_000);
  });

  it("a lot size larger than the raw quantity yields zero, flagged", () => {
    const r = sizeFixedFractional({ ...base, lotSize: 120, capitalP: CAPITAL_P, riskPpm: RISK_PPM });
    expect(r.qty).toBe(0);
    expect(r.lots).toBe(0);
    expect(r.flags).toContain("zero-size");
  });
});

describe("fixed ratio keeps precision above Number.MAX_SAFE_INTEGER", () => {
  it("isqrt is exact where a float sqrt rounds up", () => {
    const x = BigInt(3_037_000_500); // x*x is about 9.22e18, past 2^63
    expect(isqrt(x * x)).toBe(x);
    expect(isqrt(x * x - BigInt(1))).toBe(x - BigInt(1));
    // The float route lands one whole unit high on the same input.
    expect(Math.floor(Math.sqrt(Number(x * x - BigInt(1))))).toBe(Number(x));
  });

  it("delta Rs 50 lakh on Rs 1 crore closed profit stays integer-exact", () => {
    const deltaP = 500_000_000; // Rs 50,00,000
    const closedProfitP = 1_000_000_000; // Rs 1,00,00,000
    // delta x (delta + 8P) = 4.25e18 -> past Number.MAX_SAFE_INTEGER (9.007e15).
    expect(deltaP * (deltaP + 8 * closedProfitP)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(isqrt(BigInt(deltaP) * BigInt(deltaP + 8 * closedProfitP))).toBe(BigInt(2_061_552_812));
    const r = sizeFixedRatio({ ...base, deltaP, closedProfitP, blockQty: 10 });
    expect(r.units).toBe(2);
    expect(r.qty).toBe(20);
  });
});

describe("dated lot table", () => {
  it("resolves the Jan-2026 NIFTY lot of 65 and names the revision", () => {
    const r = resolveIndexLotSize("NIFTY", "2026-09-05");
    expect(r.lotSize).toBe(65);
    expect(r.effectiveFrom).toBe("2026-01-01");
    expect(r.revision).toBe("Jan-2026 series");
  });

  it("a date before the revision resolves the lot that applied then", () => {
    expect(resolveIndexLotSize("NIFTY", "2025-12-31").lotSize).toBe(75);
    expect(resolveIndexLotSize("BANKNIFTY", "2025-12-31").lotSize).toBe(35);
    expect(resolveIndexLotSize("BANKNIFTY", "2026-09-05").lotSize).toBe(30);
  });

  it("an unknown symbol returns null, never a fabricated lot of 1", () => {
    expect(resolveIndexLotSize("NOTANINDEX", "2026-09-05").lotSize).toBeNull();
  });
});
