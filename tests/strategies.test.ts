import { describe, it, expect } from "vitest";
import {
  payoffAt,
  netPremium,
  classifyStrategy,
  computeStrategy,
  buildStrategies,
  type OptionLeg,
  type PositionedLeg,
} from "@/lib/analytics/strategies";

const leg = (optionType: "CE" | "PE", strike: number, side: "long" | "short", premium: number, qty = 1): OptionLeg => ({
  optionType, strike, side, premium, qty,
});

describe("payoffAt & netPremium", () => {
  it("long call: pays premium, profits above strike", () => {
    const legs = [leg("CE", 100, "long", 5)];
    expect(payoffAt(legs, 90)).toBe(-5);
    expect(payoffAt(legs, 105)).toBe(0);
    expect(payoffAt(legs, 120)).toBe(15);
    expect(netPremium(legs)).toBe(-5); // debit
  });

  it("short put: collects premium (credit)", () => {
    const legs = [leg("PE", 100, "short", 4)];
    expect(netPremium(legs)).toBe(4);
    expect(payoffAt(legs, 110)).toBe(4); // expires worthless, keep premium
    expect(payoffAt(legs, 90)).toBe(-6); // -10 intrinsic + 4 premium
  });
});

describe("classifyStrategy", () => {
  it("names singles, straddle/strangle, spreads, condor, butterfly", () => {
    expect(classifyStrategy([leg("CE", 100, "long", 5)])).toBe("Long Call");
    expect(classifyStrategy([leg("CE", 100, "long", 5), leg("PE", 100, "long", 5)])).toBe("Long Straddle");
    expect(classifyStrategy([leg("CE", 105, "long", 3), leg("PE", 95, "long", 3)])).toBe("Long Strangle");
    expect(classifyStrategy([leg("CE", 100, "long", 6), leg("CE", 110, "short", 2)])).toBe("Bull Call Spread");
    expect(classifyStrategy([leg("PE", 100, "long", 6), leg("PE", 90, "short", 2)])).toBe("Bear Put Spread");
    expect(
      classifyStrategy([
        leg("PE", 90, "long", 1), leg("PE", 95, "short", 2),
        leg("CE", 105, "short", 2), leg("CE", 110, "long", 1),
      ]),
    ).toBe("Iron Condor");
    expect(
      classifyStrategy([leg("CE", 95, "long", 7), leg("CE", 100, "short", 4, 2), leg("CE", 105, "long", 2)]),
    ).toBe("Call Butterfly");
  });
});

describe("computeStrategy — long straddle", () => {
  const s = computeStrategy("NIFTY", "2026-06-25", [leg("CE", 100, "long", 5), leg("PE", 100, "long", 5)]);
  it("is a net debit with unbounded profit and capped loss", () => {
    expect(s.name).toBe("Long Straddle");
    expect(s.netPremium).toBe(-10);
    expect(s.isCredit).toBe(false);
    expect(s.maxProfit).toBeNull(); // unbounded (long call leg)
    expect(s.maxLoss).toBe(-10); // both expire ATM
  });
  it("breaks even at strike ± total premium", () => {
    expect(s.breakevens.sort((a, b) => a - b)).toEqual([90, 110]);
  });
});

describe("computeStrategy — bull call spread", () => {
  const s = computeStrategy("RELIANCE", "2026-06-25", [leg("CE", 100, "long", 6), leg("CE", 110, "short", 2)]);
  it("caps both profit and loss", () => {
    expect(s.name).toBe("Bull Call Spread");
    expect(s.netPremium).toBe(-4); // debit
    expect(s.maxLoss).toBe(-4); // net debit
    expect(s.maxProfit).toBe(6); // width 10 − debit 4
    expect(s.breakevens).toEqual([104]);
  });
});

describe("computeStrategy — iron condor", () => {
  const s = computeStrategy("NIFTY", "2026-07-30", [
    leg("PE", 90, "long", 1), leg("PE", 95, "short", 2),
    leg("CE", 105, "short", 2), leg("CE", 110, "long", 1),
  ]);
  it("credit received, capped profit and loss, two breakevens", () => {
    expect(s.name).toBe("Iron Condor");
    expect(s.netPremium).toBe(2); // credit
    expect(s.isCredit).toBe(true);
    expect(s.maxProfit).toBe(2); // keep the credit
    expect(s.maxLoss).toBe(-3); // 5 wide − 2 credit
    expect(s.breakevens.sort((a, b) => a - b)).toEqual([93, 107]);
  });
  it("emits a payoff curve for charting", () => {
    expect(s.payoff.length).toBeGreaterThan(20);
    expect(s.payoff[0]).toHaveProperty("price");
    expect(s.payoff[0]).toHaveProperty("pnl");
  });
});

describe("buildStrategies", () => {
  it("groups legs by underlying + expiry", () => {
    const legs: PositionedLeg[] = [
      { symbol: "NIFTY", expiry: "2026-06-25", optionType: "CE", strike: 100, side: "long", premium: 5, qty: 1 },
      { symbol: "NIFTY", expiry: "2026-06-25", optionType: "PE", strike: 100, side: "long", premium: 5, qty: 1 },
      { symbol: "BANKNIFTY", expiry: "2026-06-25", optionType: "CE", strike: 500, side: "short", premium: 8, qty: 1 },
    ];
    const groups = buildStrategies(legs);
    expect(groups.length).toBe(2);
    expect(groups.find((g) => g.symbol === "NIFTY")!.name).toBe("Long Straddle");
    expect(groups.find((g) => g.symbol === "BANKNIFTY")!.name).toBe("Short Call");
  });
});
