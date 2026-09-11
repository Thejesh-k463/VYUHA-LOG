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

// v4.3.0: `leg()` still builds an option leg with `optionType` only — the field
// every caller predating `kind` uses. That it keeps working is part of the pin.

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

// ── v4.3.0 — catalogue-driven matcher, UL legs, multi-expiry ────────────────

describe("legacy names are byte-identical (a free strategy must not be re-gated)", () => {
  it("names every shape the pre-v4.3 if-chain named, character for character", () => {
    const cases: [string, OptionLeg[]][] = [
      ["Long Call", [leg("CE", 100, "long", 5)]],
      ["Long Put", [leg("PE", 100, "long", 5)]],
      ["Short Call", [leg("CE", 100, "short", 5)]],
      ["Short Put", [leg("PE", 100, "short", 5)]],
      ["Long Straddle", [leg("CE", 100, "long", 5), leg("PE", 100, "long", 5)]],
      ["Short Straddle", [leg("CE", 100, "short", 5), leg("PE", 100, "short", 5)]],
      ["Long Strangle", [leg("CE", 105, "long", 3), leg("PE", 95, "long", 3)]],
      ["Short Strangle", [leg("CE", 105, "short", 3), leg("PE", 95, "short", 3)]],
      ["Bull Call Spread", [leg("CE", 100, "long", 6), leg("CE", 110, "short", 2)]],
      ["Bear Call Spread", [leg("CE", 100, "short", 6), leg("CE", 110, "long", 2)]],
      ["Bull Put Spread", [leg("PE", 100, "short", 6), leg("PE", 90, "long", 2)]],
      ["Bear Put Spread", [leg("PE", 100, "long", 6), leg("PE", 90, "short", 2)]],
      ["Call Butterfly", [leg("CE", 95, "long", 7), leg("CE", 100, "short", 4, 2), leg("CE", 105, "long", 2)]],
      ["Put Butterfly", [leg("PE", 95, "long", 2), leg("PE", 100, "short", 4, 2), leg("PE", 105, "long", 7)]],
      [
        "Iron Butterfly",
        [leg("PE", 90, "long", 1), leg("PE", 100, "short", 4), leg("CE", 100, "short", 4), leg("CE", 110, "long", 1)],
      ],
      [
        "Iron Condor",
        [leg("PE", 90, "long", 1), leg("PE", 95, "short", 2), leg("CE", 105, "short", 2), leg("CE", 110, "long", 1)],
      ],
    ];
    expect(cases.length).toBe(16);
    for (const [name, legs] of cases) {
      expect(classifyStrategy(legs)).toBe(name);
      const s = computeStrategy("X", "2026-06-25", legs);
      expect(s.name, name).toBe(name);
      expect(s.displayName, name).toBe(name);
      expect(s.legacyFree, name).toBe(true);
      expect(s.strategyId, name).not.toBeNull();
    }
  });
});

describe("single-expiry cards render exactly as they did before v4.3", () => {
  // Golden numbers from the pre-v4.3 implementation, for every fixture this file
  // already had. Not a red-on-revert test by construction — it is the pin saying
  // the catalogue rewrite changed no money on an existing card.
  const golden = [
    {
      what: "long straddle",
      legs: [leg("CE", 100, "long", 5), leg("PE", 100, "long", 5)],
      netPremium: -10, maxProfit: null, maxLoss: -10, breakevens: [90, 110],
      first: { price: 50, pnl: 40 }, mid: { price: 100, pnl: -10 }, last: { price: 150, pnl: 40 },
    },
    {
      what: "bull call spread",
      legs: [leg("CE", 100, "long", 6), leg("CE", 110, "short", 2)],
      netPremium: -4, maxProfit: 6, maxLoss: -4, breakevens: [104],
      first: { price: 50, pnl: -4 }, mid: { price: 105, pnl: 1 }, last: { price: 160, pnl: 6 },
    },
    {
      what: "iron condor",
      legs: [leg("PE", 90, "long", 1), leg("PE", 95, "short", 2), leg("CE", 105, "short", 2), leg("CE", 110, "long", 1)],
      netPremium: 2, maxProfit: 2, maxLoss: -3, breakevens: [93, 107],
      first: { price: 40, pnl: -3 }, mid: { price: 100, pnl: 2 }, last: { price: 160, pnl: -3 },
    },
    {
      what: "call butterfly",
      legs: [leg("CE", 95, "long", 7), leg("CE", 100, "short", 4, 2), leg("CE", 105, "long", 2)],
      netPremium: -1, maxProfit: 4, maxLoss: -1, breakevens: [96, 104],
      first: { price: 45, pnl: -1 }, mid: { price: 100, pnl: 4 }, last: { price: 155, pnl: -1 },
    },
  ];
  for (const g of golden) {
    it(g.what, () => {
      const s = computeStrategy("X", "2026-06-25", g.legs);
      expect(s.netPremium).toBe(g.netPremium);
      expect(s.maxProfit).toBe(g.maxProfit);
      expect(s.maxLoss).toBe(g.maxLoss);
      expect([...s.breakevens].sort((a, b) => a - b)).toEqual(g.breakevens);
      expect(s.payoff.length).toBe(61);
      expect(s.payoff[0]).toEqual(g.first);
      expect(s.payoff[30]).toEqual(g.mid);
      expect(s.payoff[60]).toEqual(g.last);
      expect(s.expiry).toBe("2026-06-25");
      expect(s.expiries).toEqual(["2026-06-25"]);
      expect(s.nearestExpiry).toBe("2026-06-25");
      expect(s.notComputed).toEqual({ maxProfit: false, maxLoss: false });
    });
  }
});

describe("normalisation (§5.3)", () => {
  it("reduces quantities by their GCD: 2:4 reads as the 1x2 ratio spread", () => {
    expect(classifyStrategy([leg("CE", 100, "long", 6, 2), leg("CE", 105, "short", 2, 4)])).toBe(
      "Call Ratio Spread (1×2)",
    );
    // 1:1 at the same strikes is still the vertical, not the ratio.
    expect(classifyStrategy([leg("CE", 100, "long", 6, 2), leg("CE", 105, "short", 2, 2)])).toBe(
      "Bull Call Spread",
    );
  });

  it("nets off opposing identical contracts, and never touches the money", () => {
    const legs = [leg("CE", 100, "long", 5, 3), leg("CE", 100, "short", 7, 1)];
    expect(classifyStrategy(legs)).toBe("Long Call");
    const s = computeStrategy("X", "2026-06-25", legs);
    expect(s.strategyId).toBe("long-call");
    // 3 bought at 5, 1 written at 7 → −15 + 7. Netting is for matching only.
    expect(s.netPremium).toBe(-8);
    expect(payoffAt(legs, 120)).toBe(2 * 20 - 8);
  });

  it("collapses duplicate rows of the same contract", () => {
    expect(classifyStrategy([leg("PE", 100, "short", 4), leg("PE", 100, "short", 4)])).toBe("Short Put");
  });
});

describe("group key widens to the symbol, and splits only when the match fails", () => {
  it("keeps a real calendar as one group across two expiries", () => {
    const legs: PositionedLeg[] = [
      { symbol: "RELIANCE", expiry: "2026-09-24", optionType: "CE", strike: 100, side: "short", premium: 4, qty: 1 },
      { symbol: "RELIANCE", expiry: "2026-10-29", optionType: "CE", strike: 100, side: "long", premium: 7, qty: 1 },
    ];
    const groups = buildStrategies(legs);
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe("Call Calendar Spread");
    expect(groups[0].strategyId).toBe("call-calendar-spread");
    expect(groups[0].key).toBe("RELIANCE");
    expect(groups[0].expiries).toEqual(["2026-09-24", "2026-10-29"]);
    expect(groups[0].nearestExpiry).toBe("2026-09-24");
    expect(groups[0].expiry).toBeNull();
  });

  it("splits per expiry when the whole symbol only reads as Custom", () => {
    const legs: PositionedLeg[] = [
      { symbol: "NIFTY", expiry: "2026-09-24", optionType: "CE", strike: 100, side: "long", premium: 6, qty: 1 },
      { symbol: "NIFTY", expiry: "2026-09-24", optionType: "CE", strike: 110, side: "short", premium: 2, qty: 1 },
      { symbol: "NIFTY", expiry: "2026-10-29", optionType: "PE", strike: 95, side: "short", premium: 3, qty: 1 },
    ];
    expect(classifyStrategy(legs)).toBe("Custom (3 legs)");
    const groups = buildStrategies(legs);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.name)).toEqual(["Bull Call Spread", "Short Put"]);
    expect(groups.map((g) => g.key)).toEqual(["NIFTY|2026-09-24", "NIFTY|2026-10-29"]);
    expect(groups[0].expiry).toBe("2026-09-24");
    expect(groups[1].expiry).toBe("2026-10-29");
  });
});

describe("multi-expiry figures use notComputed, never a null maxProfit (§7)", () => {
  const calendar: OptionLeg[] = [
    { optionType: "CE", strike: 100, side: "short", premium: 4, qty: 1, expiry: "2026-09-24" },
    { optionType: "CE", strike: 100, side: "long", premium: 7, qty: 1, expiry: "2026-10-29" },
  ];
  it("flags max profit as model-dependent while leaving the number alone", () => {
    const s = computeStrategy("NIFTY", null, calendar);
    expect(s.notComputed).toEqual({ maxProfit: true, maxLoss: false });
    expect(s.maxProfit).not.toBeNull(); // null stays reserved for UNBOUNDED
    expect(s.maxProfit).toBe(-3);
    expect(s.capLabel.maxProfit).toBe("Not computed");
    expect(s.capLabel.maxLoss).toBe("At expiry");
    expect(s.maxLoss).toBe(-3); // every far leg is long → the net debit
  });

  it("also blanks max loss when a far leg is short", () => {
    const reverse: OptionLeg[] = [
      { optionType: "CE", strike: 100, side: "long", premium: 4, qty: 1, expiry: "2026-09-24" },
      { optionType: "CE", strike: 100, side: "short", premium: 7, qty: 1, expiry: "2026-10-29" },
    ];
    const s = computeStrategy("NIFTY", null, reverse);
    expect(s.notComputed).toEqual({ maxProfit: true, maxLoss: true });
    expect(s.capLabel.maxLoss).toBe("Not computed");
  });

  it("says nothing of the sort on a single-expiry group", () => {
    const s = computeStrategy("NIFTY", "2026-09-24", [leg("CE", 100, "short", 5)]);
    expect(s.notComputed).toEqual({ maxProfit: false, maxLoss: false });
    expect(s.maxLoss).toBeNull();
    expect(s.capLabel.maxLoss).toBe("Unlimited");
  });
});

describe("capLabel (§6) — a price floor is not a forecast", () => {
  const label = (legs: OptionLeg[]) => computeStrategy("X", "2026-06-25", legs).capLabel;
  it("labels a figure reached only at S = 0 with the exact §6 string", () => {
    expect(label([leg("PE", 100, "long", 5)]).maxProfit).toBe("Computed at underlying = 0");
    expect(label([leg("PE", 100, "short", 5)]).maxLoss).toBe("Computed at underlying = 0");
  });
  it("keeps Unlimited for an uncapped call side", () => {
    expect(label([leg("CE", 100, "long", 5)]).maxProfit).toBe("Unlimited");
    expect(label([leg("CE", 100, "short", 5)]).maxLoss).toBe("Unlimited");
  });
  it("uses At expiry for an ordinary bounded figure", () => {
    const c = label([leg("CE", 100, "long", 6), leg("CE", 110, "short", 2)]);
    expect(c).toEqual({ maxProfit: "At expiry", maxLoss: "At expiry" });
  });
});

describe("underlying legs", () => {
  const covered: OptionLeg[] = [
    { kind: "UL", strike: 0, side: "long", premium: 100, qty: 1 },
    { optionType: "CE", strike: 110, side: "short", premium: 5, qty: 1 },
  ];
  it("values a UL leg at S, with premium as its entry price", () => {
    expect(payoffAt(covered, 120)).toBe(15); // (120 − 100) + (5 − 10)
    expect(payoffAt(covered, 100)).toBe(5); // flat stock, call expires worthless
    expect(payoffAt(covered, 0)).toBe(-95); // −100 + 5
  });
  it("names the covered call and caps both sides", () => {
    const s = computeStrategy("INFY", "2026-06-25", covered);
    expect(s.name).toBe("Covered Call");
    expect(s.strategyId).toBe("covered-call");
    expect(s.legacyFree).toBe(false);
    expect(s.ulLegs.length).toBe(1);
    expect(s.maxProfit).toBe(15);
    expect(s.maxLoss).toBe(-95);
    expect(s.capLabel.maxLoss).toBe("Computed at underlying = 0");
  });
});

describe("a breakeven beyond the chart's right edge is still a breakeven (M-1)", () => {
  // The chart range is strikes ± a pad of max(spread × 0.6, maxStrike × 0.15, 50),
  // and the vertex scan used to stop there. Any position still under water at that
  // edge with a positive slope above the top strike lost its upper breakeven
  // silently: `breakevens: []`, printed as "—" — the same blank a box spread earns
  // for having none at all (invariant 6: a blank must mean "none exists").
  const deepItm = [leg("CE", 20000, "long", 4000, 50)];

  it("finds the deep-ITM long call's breakeven analytically (strike + premium)", () => {
    const s = computeStrategy("NIFTY", "2026-09-25", deepItm);
    expect(s.breakevens).toEqual([24000]);
    expect(s.maxProfit).toBeNull(); // still unbounded above
    expect(s.maxLoss).toBe(-200000); // the whole premium
  });

  it("widens the chart so the curve actually crosses zero", () => {
    const s = computeStrategy("NIFTY", "2026-09-25", deepItm);
    expect(s.payoff.length).toBe(61);
    expect(s.payoff[60].price).toBeGreaterThanOrEqual(24000);
    expect(s.payoff[60].pnl).toBeGreaterThan(0);
  });

  it("finds it on the short side too, with max loss still unbounded", () => {
    const s = computeStrategy("NIFTY", "2026-09-25", [leg("CE", 20000, "short", 4000, 50)]);
    expect(s.breakevens).toEqual([24000]);
    expect(s.maxLoss).toBeNull();
  });

  it("leaves a position whose breakeven was already inside the range untouched", () => {
    // 2999 is one rupee under the pad (20000 × 0.15 = 3000): the old vertex scan
    // found this one, and it must still read exactly the same, chart included.
    const s = computeStrategy("NIFTY", "2026-09-25", [leg("CE", 20000, "long", 2999, 50)]);
    expect(s.breakevens).toEqual([22999]);
    expect(s.payoff[60]).toEqual({ price: 23000, pnl: 50 });
  });

  it("still reports NO breakeven for a box spread, which genuinely has none", () => {
    const box = [
      leg("CE", 90, "long", 12), leg("PE", 90, "short", 1),
      leg("CE", 100, "short", 5), leg("PE", 100, "long", 2),
    ];
    const s = computeStrategy("X", "2026-06-25", box);
    expect(s.strategyId).toBe("box-spread");
    expect(s.breakevens).toEqual([]);
  });
});

describe("one crossing is listed once, whichever path found it (R4-M-1)", () => {
  /**
   * The analytic rescue above and the vertex scan can both see the SAME
   * crossing, and they reach it by different float paths: the scan interpolates
   * between two vertices, the rescue divides a total P&L by a total slope. Both
   * are then `r2()`-rounded, so a true crossing sitting on an `x.xx5` boundary
   * rounds to neighbouring paise 0.01 apart — and the 0.005 de-duplication that
   * was supposed to catch it cannot, because 0.01 is not < 0.005. The card then
   * printed one breakeven twice.
   *
   * The fix is not a wider tolerance (which would swallow two genuine crossings
   * a paisa apart). The vertex list ALREADY ends at `cHi`, and the payoff is a
   * straight line from the top strike to it, so every crossing BELOW `cHi` is
   * the scan's by construction. The rescue is needed only at or beyond `cHi` —
   * and `at` is not academic: the scan's `(a.pnl >= 0 && b.pnl < 0)` test cannot
   * see `b.pnl === 0`, so a crossing landing exactly on `cHi` belongs to the
   * rescue alone.
   */
  it("a long underlying against a short call: the crossing inside the range is the scan's, once", () => {
    const s = computeStrategy("X", "2026-09-25", [
      { optionType: "CE", strike: 10950, side: "short", premium: 2080.15, qty: 1 },
      { kind: "UL", strike: 0, side: "long", premium: 26550.94, qty: 3 } as OptionLeg,
    ]);
    // The true crossing is 33311.335 — the exact half-paisa that split the two
    // roundings into [33311.33, 33311.34].
    expect(s.breakevens, "the same crossing is listed twice").toHaveLength(1);
    expect(s.breakevens[0]).toBeCloseTo(33311.335, 1);
  });

  it("an all-options position whose upper crossing sits inside the range keeps ONE breakeven", () => {
    const s = computeStrategy("NIFTY", "2026-09-25", [
      leg("PE", 21200, "long", 821.92, 50),
      leg("CE", 23350, "long", 61.97, 50),
      leg("CE", 28850, "short", 1265.2, 150),
    ]);
    expect(s.breakevens, "the same crossing is listed twice").toHaveLength(1);
    expect(s.breakevens[0]).toBeCloseTo(33055.855, 1);
  });

  it("a crossing landing EXACTLY on the chart's right edge is still reported, once", () => {
    // Premium = 15 % of the strike puts the breakeven on cHi to the rupee
    // (pad = max(spread × 0.6, 20000 × 0.15, 50) = 3000). `pnl(cHi)` is 0, which
    // the scan's strict `b.pnl < 0` / `b.pnl > 0` tests both miss — so the guard
    // on the analytic value has to be `>= cHi - 0.005`, never `> cHi`.
    const s = computeStrategy("NIFTY", "2026-09-25", [leg("CE", 20000, "long", 3000, 50)]);
    expect(s.breakevens, "the crossing on the edge belongs to the analytic rescue").toEqual([23000]);
    expect(s.payoff[60].price).toBe(23000);
  });
});

describe("a split never states an uncovered leg the whole book does not have (R102)", () => {
  // 500 RELIANCE held under TWO short calls, one per expiry. The whole book is
  // covered (slope above the top strike: 500 − 250 − 250 = 0) and reads as
  // Custom, so the per-expiry fallback used to split it — parking the
  // underlying on the NEAREST expiry and leaving the October call alone on its
  // own card, where it read as an uncovered short call with an "Unlimited" loss.
  const legs: PositionedLeg[] = [
    { symbol: "RELIANCE", expiry: null, kind: "UL", strike: 0, side: "long", premium: 2900, qty: 500 },
    { symbol: "RELIANCE", expiry: "2026-09-24", optionType: "CE", strike: 3000, side: "short", premium: 40, qty: 250 },
    { symbol: "RELIANCE", expiry: "2026-10-29", optionType: "CE", strike: 3100, side: "short", premium: 55, qty: 250 },
  ];

  it("keeps the book whole rather than print an Unlimited the whole book contradicts", () => {
    const groups = buildStrategies(legs);
    expect(groups.map((g) => g.key)).toEqual(["RELIANCE"]);
    expect(groups.map((g) => g.capLabel.maxLoss)).not.toContain("Unlimited");
    expect(groups[0].maxLoss, "the whole book is bounded below").not.toBeNull();
  });
});

describe("an underlying FUTURE that expires before an option leg (R104)", () => {
  // A September future under an October short call: after the future settles
  // the call is uncovered, so a bounded worst case at the call's expiry is not
  // a fact the journal can state (invariant 6, research note §7).
  const legs = (ulExpiry: string | null): PositionedLeg[] => [
    { symbol: "NIFTY", expiry: ulExpiry, kind: "UL", strike: 0, side: "long", premium: 24000, qty: 75 },
    { symbol: "NIFTY", expiry: "2026-10-29", optionType: "CE", strike: 24500, side: "short", premium: 180, qty: 75 },
  ];

  it("blanks BOTH figures as Not computed, and keeps the name", () => {
    const [g] = buildStrategies(legs("2026-09-24"));
    expect(g.strategyId).toBe("covered-call");
    expect(g.notComputed).toEqual({ maxProfit: true, maxLoss: true });
    expect(g.capLabel.maxLoss).toBe("Not computed");
    expect(g.capLabel.maxProfit).toBe("Not computed");
  });

  it("a cash holding, or a future that lives as long as the option, keeps its figures", () => {
    for (const e of [null, "2026-10-29", "2026-11-26"]) {
      const [g] = buildStrategies(legs(e));
      expect(g.notComputed, String(e)).toEqual({ maxProfit: false, maxLoss: false });
      expect(g.capLabel.maxLoss, String(e)).not.toBe("Not computed");
    }
  });
});

describe("a payoff that lands on zero at a strike breaks even THERE, whatever the float noise (R69)", () => {
  // A 100/110 bull call spread bought for exactly its width: the payoff is 0 at
  // and above 110. Identical payoffs used to print [] or [110] depending on the
  // float residue of `hi − lo`, and a blank on the card means "no breakeven".
  it.each([
    [12, 2],
    [12.05, 2.05],
    [12.1, 2.1],
    [12.15, 2.15],
    [12.3, 2.3],
  ])("long 100 CE @%s, short 110 CE @%s → [110]", (lo, hi) => {
    const s = computeStrategy("NIFTY", "2026-09-24", [leg("CE", 100, "long", lo, 50), leg("CE", 110, "short", hi, 50)]);
    expect(s.breakevens).toEqual([110]);
  });

  it("a zero span between two strikes lists BOTH ends (decided, R69)", () => {
    // Long 110 CE @5 against short 90 PE @5: zero cost, and the payoff is
    // exactly 0 from 90 to 110 — the position stops losing at 90 and starts
    // gaining at 110, and both levels are stated.
    const s = computeStrategy("NIFTY", "2026-09-24", [leg("CE", 110, "long", 5, 50), leg("PE", 90, "short", 5, 50)]);
    expect(s.breakevens).toEqual([90, 110]);
  });
});
