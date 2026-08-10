import { describe, it, expect } from "vitest";
import {
  computeTradeCalc,
  marginForTrade,
  solveTargetForNetRR,
  type ReverseTargetInput,
  type TradeCalcInput,
} from "@/lib/analytics/trade-calc";
import { seedRatesMap, findRates } from "@/lib/engine/rates";
import { marginKey, type MarginRates } from "@/lib/risk/margin";
import { toRupees } from "@/lib/money";

const rates = (broker: string, segment: string, exchange = "NSE") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findRates(seedRatesMap(), broker as any, segment as any, exchange as any);

describe("computeTradeCalc — equity delivery (long)", () => {
  const input: TradeCalcInput = {
    segment: "eq_delivery", side: "long", entry: 100, sl: 95, target: 110, qty: 100, numTrades: 1,
  };
  const r = computeTradeCalc(input, rates("zerodha", "eq_delivery"));

  it("computes gross P&L per scenario", () => {
    expect(toRupees(r.target.grossPaise)).toBe(1000); // (110-100)*100
    expect(toRupees(r.sl.grossPaise)).toBe(-500); // (95-100)*100
  });

  it("nets out real charges and a gross 2:1 reward:risk", () => {
    expect(r.chargesPerTradePaise).toBeGreaterThan(0);
    expect(r.target.netPaise).toBeLessThan(r.target.grossPaise); // charges eat in
    expect(r.rrGross).toBe(2); // 1000 / 500
    expect(r.breakevenPrice).toBeGreaterThan(100); // above entry for a long
  });
});

describe("computeTradeCalc — index option (long), × N trades", () => {
  const input: TradeCalcInput = {
    segment: "index_option", side: "long", entry: 100, sl: 60, target: 180, qty: 75, numTrades: 20,
  };
  const r = computeTradeCalc(input, rates("dhan", "index_option"));

  it("scales charges and P&L across N trades", () => {
    expect(r.numTrades).toBe(20);
    expect(r.totalChargesPaise).toBe(r.chargesPerTradePaise * 20);
    expect(r.totalSttPaise).toBe(r.target.charges.sttCtt * 20);
    expect(r.totalNetTargetPaise).toBe(r.target.netPaise * 20);
    expect(r.totalNetSlPaise).toBe(r.sl.netPaise * 20);
  });

  it("charges a non-zero STT on the option sell leg", () => {
    expect(r.target.charges.sttCtt).toBeGreaterThan(0);
  });
});

describe("computeTradeCalc — short future puts STT on the sell (entry) leg", () => {
  const long = computeTradeCalc(
    { segment: "future", side: "long", entry: 3000, sl: 2950, target: 3100, qty: 250 },
    rates("dhan", "future"),
  );
  const short = computeTradeCalc(
    { segment: "future", side: "short", entry: 3000, sl: 3050, target: 2900, qty: 250 },
    rates("dhan", "future"),
  );
  it("profits when a short's exit is below entry; breakeven below entry", () => {
    expect(toRupees(short.target.grossPaise)).toBe(25000); // (3000-2900)*250
    expect(short.breakevenPrice).toBeLessThan(3000);
    expect(long.breakevenPrice).toBeGreaterThan(3000);
  });
});

describe("computeTradeCalc — equity MTF interest grows with holding days", () => {
  const base = { segment: "eq_mtf" as const, side: "long" as const, entry: 1000, sl: 950, target: 1100, qty: 500 };
  const d10 = computeTradeCalc({ ...base, mtf: { fundedAmount: 500000, daysHeld: 10 } }, rates("dhan", "eq_mtf"));
  const d40 = computeTradeCalc({ ...base, mtf: { fundedAmount: 500000, daysHeld: 40 } }, rates("dhan", "eq_mtf"));
  it("longer holding ⇒ more MTF interest ⇒ higher total charges", () => {
    expect(d40.target.charges.mtfInterest).toBeGreaterThan(d10.target.charges.mtfInterest);
    expect(d40.chargesPerTradePaise).toBeGreaterThan(d10.chargesPerTradePaise);
  });
});

// ───────────────────────────── MTF breakeven move % ─────────────────────────

describe("computeTradeCalc — mtfCost (breakeven MOVE % and daily carry)", () => {
  const base = { segment: "eq_mtf" as const, side: "long" as const, entry: 1000, sl: 950, target: 1100, qty: 500 };
  const r = computeTradeCalc({ ...base, mtf: { fundedAmount: 375000, daysHeld: 30 } }, rates("dhan", "eq_mtf"));

  it("agrees with the charges engine on the interest it reports", () => {
    expect(r.mtfCost).not.toBeNull();
    // Same formula, two roundings — they must not disagree by more than a paisa.
    expect(Math.abs(r.mtfCost!.interestPaise - r.target.charges.mtfInterest)).toBeLessThanOrEqual(1);
  });

  it("splits carry from the other charges without double-counting", () => {
    const m = r.mtfCost!;
    expect(m.otherChargesPaise).toBe(r.chargesPerTradePaise - r.target.charges.mtfInterest);
    expect(Math.abs(m.totalCostPaise - r.chargesPerTradePaise)).toBeLessThanOrEqual(1);
  });

  it("states the breakeven MOVE % against the position value", () => {
    const m = r.mtfCost!;
    expect(m.positionValue).toBe(500000); // 1000 × 500
    expect(m.breakevenMovePct).toBeCloseTo((m.totalCostPaise / 100 / m.positionValue) * 100, 2);
    expect(m.breakevenMovePct).toBeGreaterThan(0);
    // A 30-day carry: the daily rate × 30 is the interest, give or take rounding.
    expect(m.dailyInterestPaise * 30).toBeCloseTo(m.interestPaise, -2);
  });

  it("is null for a trade with no broker funding — not a zero", () => {
    expect(computeTradeCalc({ ...base, segment: "eq_delivery", mtf: null }, rates("dhan", "eq_delivery")).mtfCost).toBeNull();
    expect(computeTradeCalc({ ...base, mtf: { fundedAmount: 0, daysHeld: 30 } }, rates("dhan", "eq_mtf")).mtfCost).toBeNull();
  });
});

// ─────────────────────── reverse solve: target for a net R:R ────────────────

/** Feed a solved target back through the forward calculator. */
const roundTrip = (i: ReverseTargetInput, broker: string) => {
  const card = rates(broker, i.segment);
  const solved = solveTargetForNetRR(i, card);
  if (!solved) return null;
  const forward = computeTradeCalc(
    { segment: i.segment, side: i.side, entry: i.entry, sl: i.sl, target: solved.target, qty: i.qty, mtf: i.mtf ?? null },
    card,
  );
  return { solved, forward };
};

describe("solveTargetForNetRR — round-trips through computeTradeCalc", () => {
  it("a long equity delivery target hits the requested 2:1 net", () => {
    const rt = roundTrip({ segment: "eq_delivery", side: "long", entry: 100, sl: 95, qty: 100, desiredRR: 2 }, "zerodha")!;
    expect(rt).not.toBeNull();
    expect(rt.forward.rrNet).toBeGreaterThanOrEqual(2);
    expect(rt.forward.rrNet! - 2).toBeLessThan(0.01);
    // The solver's own view of the trade matches the forward engine exactly.
    expect(rt.solved.netRewardPaise).toBe(rt.forward.target.netPaise);
    expect(rt.solved.netRiskPaise).toBe(rt.forward.sl.netPaise);
  });

  it("holds at 1:1, 3:1 and 5:1 across segments, and the target rises with the ask", () => {
    for (const [broker, segment, entry, sl, qty] of [
      ["zerodha", "eq_delivery", 100, 95, 100],
      ["dhan", "eq_intraday", 2500, 2450, 40],
      ["dhan", "index_option", 100, 60, 75],
      ["dhan", "future", 3000, 2950, 250],
    ] as const) {
      let previous = 0;
      for (const desiredRR of [1, 3, 5]) {
        const rt = roundTrip({ segment, side: "long", entry, sl, qty, desiredRR }, broker);
        expect(rt, `${broker}/${segment} @ ${desiredRR}R`).not.toBeNull();
        expect(rt!.forward.rrNet, `${broker}/${segment} @ ${desiredRR}R`).toBeGreaterThanOrEqual(desiredRR);
        expect(rt!.forward.rrNet! - desiredRR).toBeLessThan(0.02);
        expect(rt!.solved.target).toBeGreaterThan(previous); // more reward ⇒ further target
        previous = rt!.solved.target;
      }
    }
  });

  it("solves a SHORT below entry and still delivers the net ratio", () => {
    const rt = roundTrip({ segment: "future", side: "short", entry: 3000, sl: 3050, qty: 250, desiredRR: 2 }, "dhan")!;
    expect(rt).not.toBeNull();
    expect(rt.solved.target).toBeLessThan(3000);
    expect(rt.forward.rrNet).toBeGreaterThanOrEqual(2);
    expect(rt.forward.rrNet! - 2).toBeLessThan(0.01);
  });

  it("clears the required reward exactly, never quoting a target that under-delivers", () => {
    const card = rates("zerodha", "eq_delivery");
    const s = solveTargetForNetRR({ segment: "eq_delivery", side: "long", entry: 100, sl: 95, qty: 100, desiredRR: 2.5 }, card)!;
    expect(s.netRewardPaise).toBeGreaterThanOrEqual(s.requiredNetRewardPaise);
    expect(s.achievedRR).toBeGreaterThanOrEqual(2.5);
    // One paisa lower must MISS — i.e. the answer is the cheapest target that works.
    const cheaper = computeTradeCalc(
      { segment: "eq_delivery", side: "long", entry: 100, sl: 95, target: s.target - 0.01, qty: 100 },
      card,
    );
    expect(cheaper.target.netPaise).toBeLessThan(s.requiredNetRewardPaise);
  });

  it("is deterministic", () => {
    const i: ReverseTargetInput = { segment: "eq_delivery", side: "long", entry: 100, sl: 95, qty: 100, desiredRR: 2 };
    expect(solveTargetForNetRR(i, rates("zerodha", "eq_delivery"))).toEqual(
      solveTargetForNetRR(i, rates("zerodha", "eq_delivery")),
    );
  });
});

describe("solveTargetForNetRR — never returns a target on the wrong side of entry", () => {
  it("a long's target is always ABOVE entry, at every ratio", () => {
    const card = rates("zerodha", "eq_delivery");
    for (const desiredRR of [0.25, 0.5, 1, 2, 10, 50]) {
      const s = solveTargetForNetRR({ segment: "eq_delivery", side: "long", entry: 100, sl: 95, qty: 100, desiredRR }, card);
      expect(s, `${desiredRR}R`).not.toBeNull();
      expect(s!.target, `${desiredRR}R`).toBeGreaterThan(100);
    }
  });

  it("a tiny ratio still clears the charges, not just the entry price", () => {
    const card = rates("zerodha", "eq_delivery");
    const s = solveTargetForNetRR({ segment: "eq_delivery", side: "long", entry: 100, sl: 95, qty: 100, desiredRR: 0.01 }, card)!;
    const forward = computeTradeCalc({ segment: "eq_delivery", side: "long", entry: 100, sl: 95, target: s.target, qty: 100 }, card);
    expect(forward.target.netPaise).toBeGreaterThan(0);
    expect(s.target).toBeGreaterThan(forward.breakevenPrice); // past breakeven, by construction
  });
});

describe("solveTargetForNetRR — returns null rather than a number it cannot justify", () => {
  it("an impossible ask: a short cannot make 25R when a 100% move to zero is its ceiling", () => {
    const card = rates("dhan", "eq_intraday");
    const base = { segment: "eq_intraday" as const, side: "short" as const, entry: 100, sl: 105, qty: 100 };
    // Max gross for the short is ₹10,000 (price → 0); risk is ≥ ₹500 + charges,
    // so 25R needs > ₹12,500 of reward. No target price exists.
    expect(solveTargetForNetRR({ ...base, desiredRR: 25 }, card)).toBeNull();
    // …and the same trade at a reachable ratio still solves, so the null above
    // is the ask being impossible, not the solver refusing to work.
    expect(solveTargetForNetRR({ ...base, desiredRR: 1 }, card)).not.toBeNull();
  });

  it("a stop on the wrong side of entry has no risk to scale against", () => {
    const card = rates("zerodha", "eq_delivery");
    expect(solveTargetForNetRR({ segment: "eq_delivery", side: "long", entry: 100, sl: 100, qty: 100, desiredRR: 2 }, card)).toBeNull();
    expect(solveTargetForNetRR({ segment: "eq_delivery", side: "long", entry: 100, sl: 105, qty: 100, desiredRR: 2 }, card)).toBeNull();
    expect(solveTargetForNetRR({ segment: "future", side: "short", entry: 3000, sl: 2950, qty: 250, desiredRR: 2 }, rates("dhan", "future"))).toBeNull();
  });

  it("rejects nonsense asks instead of coercing them", () => {
    const card = rates("zerodha", "eq_delivery");
    const ok = { segment: "eq_delivery" as const, side: "long" as const, entry: 100, sl: 95, qty: 100 };
    expect(solveTargetForNetRR({ ...ok, desiredRR: 0 }, card)).toBeNull();
    expect(solveTargetForNetRR({ ...ok, desiredRR: -2 }, card)).toBeNull();
    expect(solveTargetForNetRR({ ...ok, qty: 0, desiredRR: 2 }, card)).toBeNull();
    expect(solveTargetForNetRR({ ...ok, entry: 0, desiredRR: 2 }, card)).toBeNull();
  });
});

describe("solveTargetForNetRR — MTF carry has to be earned back", () => {
  it("a funded position needs a further target than the same unfunded one", () => {
    const card = rates("dhan", "eq_mtf");
    const base = { segment: "eq_mtf" as const, side: "long" as const, entry: 1000, sl: 950, qty: 500, desiredRR: 2 };
    const unfunded = solveTargetForNetRR({ ...base, mtf: null }, card)!;
    const funded = solveTargetForNetRR({ ...base, mtf: { fundedAmount: 375000, daysHeld: 60 } }, card)!;
    expect(funded.target).toBeGreaterThan(unfunded.target);
    const forward = computeTradeCalc(
      { ...base, target: funded.target, mtf: { fundedAmount: 375000, daysHeld: 60 } },
      card,
    );
    expect(forward.rrNet).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────── margin / capital blocked ───────────────────────

const marginRates = (): MarginRates =>
  new Map([
    [marginKey("dhan", "index_option"), 12],
    [marginKey("dhan", "future"), 15],
    [marginKey("dhan", "eq_intraday"), 20],
    [marginKey("dhan", "eq_mtf"), 25],
    [marginKey("dhan", "eq_delivery"), 100],
  ]);

describe("marginForTrade — a short option without an underlying level says so", () => {
  it("refuses to price a short option off the premium", () => {
    const m = marginForTrade(
      { broker: "dhan", segment: "index_option", side: "short", qty: 75, entry: 120, optionType: "CE" },
      marginRates(),
    );
    expect(m.marginPaise).toBeNull();
    expect(m.needs).toMatch(/strike or spot/i);
  });

  it("computes against the strike when that is all the user has", () => {
    const m = marginForTrade(
      { broker: "dhan", segment: "index_option", side: "short", qty: 75, entry: 120, optionType: "CE", strike: 24000 },
      marginRates(),
    );
    expect(m.needs).toBeNull();
    expect(m.marginPaise).toBe(Math.round(0.12 * 75 * 24000 * 100)); // ₹2,16,000
    expect(m.rateUsed).toBe(12);
  });

  it("prefers spot over strike when both are given", () => {
    const m = marginForTrade(
      { broker: "dhan", segment: "index_option", side: "short", qty: 75, entry: 120, optionType: "PE", strike: 24000, spot: 24500 },
      marginRates(),
    );
    expect(m.marginPaise).toBe(Math.round(0.12 * 75 * 24500 * 100)); // ₹2,20,500
  });
});

describe("marginForTrade — the instruments that need no underlying level", () => {
  it("a LONG option blocks the premium and nothing else", () => {
    const m = marginForTrade(
      { broker: "dhan", segment: "index_option", side: "long", qty: 75, entry: 120, optionType: "CE" },
      marginRates(),
    );
    expect(m.needs).toBeNull();
    expect(m.marginPaise).toBe(75 * 120 * 100); // ₹9,000
    expect(m.rateUsed).toBeNull(); // no percentage was applied
  });

  it("a future blocks a % of contract value at entry", () => {
    const m = marginForTrade({ broker: "dhan", segment: "future", side: "long", qty: 250, entry: 3000 }, marginRates());
    expect(m.marginPaise).toBe(Math.round(0.15 * 250 * 3000 * 100)); // ₹1,12,500
  });

  it("MTF prefers the per-stock margin over the broker-level rate", () => {
    const brokerLevel = marginForTrade({ broker: "dhan", segment: "eq_mtf", side: "long", qty: 500, entry: 1000 }, marginRates());
    const perStock = marginForTrade(
      { broker: "dhan", segment: "eq_mtf", side: "long", qty: 500, entry: 1000, symbol: "RELIANCE", mtfStockPct: 45 },
      marginRates(),
    );
    expect(brokerLevel.marginPaise).toBe(Math.round(0.25 * 500 * 1000 * 100)); // ₹1,25,000
    expect(perStock.marginPaise).toBe(Math.round(0.45 * 500 * 1000 * 100)); // ₹2,25,000
    expect(perStock.basis).toMatch(/stock list/);
  });

  it("flags an unconfigured segment rather than hiding the 100% assumption", () => {
    const m = marginForTrade({ broker: "upstox", segment: "future", side: "long", qty: 250, entry: 3000 }, marginRates());
    expect(m.marginPaise).toBe(250 * 3000 * 100); // assumed 100%
    expect(m.missingRate).toContain("upstox|future");
  });

  it("needs a quantity and a price before it computes anything", () => {
    expect(marginForTrade({ broker: "dhan", segment: "future", side: "long", qty: 0, entry: 3000 }, marginRates()).needs).toBeTruthy();
    expect(marginForTrade({ broker: "dhan", segment: "future", side: "long", qty: 250, entry: 0 }, marginRates()).needs).toBeTruthy();
  });
});
