import { describe, it, expect } from "vitest";
import {
  summarise,
  markToMarket,
  validateLegs,
  parentAggregate,
  legChargeShapes,
  effectiveStop,
  sortLegs,
  type Leg,
} from "@/lib/domain/staged";

let nextId = 1;
function entry(qty: number, price: number, opts: Partial<Leg> = {}): Leg {
  return {
    id: opts.id ?? nextId++,
    kind: "entry",
    seq: opts.seq ?? nextId,
    tradeDate: opts.tradeDate ?? "2026-01-01",
    qty,
    price,
    ...opts,
  };
}
function exit(qty: number, price: number, opts: Partial<Leg> = {}): Leg {
  return {
    id: opts.id ?? nextId++,
    kind: "exit",
    seq: opts.seq ?? nextId,
    tradeDate: opts.tradeDate ?? "2026-01-01",
    qty,
    price,
    ...opts,
  };
}
/** Deterministic ladder: seq follows array order. */
function ladder(...legs: Leg[]): Leg[] {
  return legs.map((l, i) => ({ ...l, seq: i + 1 }));
}

describe("effectiveStop", () => {
  it("prefers the trailing stop when one is set", () => {
    expect(effectiveStop({ slPlanned: 95, trailingSl: 102 })).toBe(102);
    expect(effectiveStop({ slPlanned: 95, trailingSl: null })).toBe(95);
    expect(effectiveStop({ slPlanned: null, trailingSl: null })).toBeNull();
  });

  it("honours a trailing stop that is WIDER than the original, without second-guessing the user", () => {
    // Vyuha records what you actually did; it does not silently 'fix' a stop
    // you widened. The discipline report is where that gets called out.
    expect(effectiveStop({ slPlanned: 95, trailingSl: 90 })).toBe(90);
  });
});

describe("sortLegs", () => {
  it("orders by seq then id", () => {
    const legs: Leg[] = [
      { id: 9, kind: "entry", seq: 2, tradeDate: "2026-01-02", qty: 1, price: 1 },
      { id: 3, kind: "entry", seq: 1, tradeDate: "2026-01-01", qty: 1, price: 1 },
      { id: 1, kind: "entry", seq: 2, tradeDate: "2026-01-02", qty: 1, price: 1 },
    ];
    expect(sortLegs(legs).map((l) => l.id)).toEqual([3, 1, 9]);
  });
});

describe("weighted-average pricing", () => {
  it("blends two entries into one average cost", () => {
    const legs = ladder(entry(100, 100), entry(100, 110));
    const s = summarise(legs, "long");
    expect(s.openQty).toBe(200);
    expect(s.avgOpenPrice).toBe(105);
    expect(s.avgEntryPrice).toBe(105);
    expect(s.invested).toBe(21000);
  });

  it("books a partial exit against the blended average, not the first lot", () => {
    // The FIFO answer would be (120-100)*100 = 2000. Weighted average is the
    // rule we chose, so it must be 1500.
    const legs = ladder(entry(100, 100), entry(100, 110), exit(100, 120));
    const s = summarise(legs, "long");
    expect(s.fills).toHaveLength(1);
    expect(s.fills[0].avgCostAtExit).toBe(105);
    expect(s.fills[0].grossPnl).toBe(1500);
  });

  it("leaves the remaining cost basis unchanged after a partial exit", () => {
    const legs = ladder(entry(100, 100), entry(100, 110), exit(100, 120));
    const s = summarise(legs, "long");
    expect(s.openQty).toBe(100);
    expect(s.avgOpenPrice).toBe(105); // moving average, not the 110 tranche price
    expect(s.invested).toBe(10500);
  });

  it("totals gross P&L identically whether you exit in one go or in three", () => {
    const oneShot = summarise(ladder(entry(300, 100), exit(300, 130)), "long");
    const scaled = summarise(
      ladder(entry(300, 100), exit(100, 130), exit(100, 130), exit(100, 130)),
      "long",
    );
    expect(scaled.realisedGross).toBeCloseTo(oneShot.realisedGross, 6);
    expect(scaled.realisedGross).toBe(9000);
  });

  it("handles three entries and two partial exits without drift", () => {
    const legs = ladder(
      entry(100, 100),
      entry(100, 120),
      entry(100, 140), // avg 120 over 300
      exit(150, 150),
      exit(150, 160),
    );
    const s = summarise(legs, "long");
    expect(s.avgEntryPrice).toBe(120);
    // Both exits price against 120 — the moving average never moves on exits.
    expect(s.fills[0].grossPnl).toBe(4500); // (150-120)*150
    expect(s.fills[1].grossPnl).toBe(6000); // (160-120)*150
    expect(s.realisedGross).toBe(10500);
    expect(s.openQty).toBe(0);
    expect(s.isClosed).toBe(true);
  });
});

describe("FIFO quantity consumption", () => {
  it("retires the oldest tranche first", () => {
    const a = entry(100, 100, { id: 1 });
    const b = entry(100, 110, { id: 2 });
    const s = summarise(ladder(a, b, exit(100, 120, { id: 3 })), "long");
    expect(s.fills[0].consumed).toEqual([{ legId: 1, qty: 100 }]);
    expect(s.openTranches).toHaveLength(1);
    expect(s.openTranches[0].legId).toBe(2);
    expect(s.openTranches[0].openQty).toBe(100);
  });

  it("spans an exit across two tranches when it is bigger than the first", () => {
    const a = entry(100, 100, { id: 1 });
    const b = entry(100, 110, { id: 2 });
    const s = summarise(ladder(a, b, exit(150, 120, { id: 3 })), "long");
    expect(s.fills[0].consumed).toEqual([
      { legId: 1, qty: 100 },
      { legId: 2, qty: 50 },
    ]);
    expect(s.openTranches).toHaveLength(1);
    expect(s.openTranches[0].legId).toBe(2);
    expect(s.openTranches[0].openQty).toBe(50);
  });

  it("keeps the surviving tranche's own stop, not the retired one's", () => {
    const a = entry(100, 100, { id: 1, slPlanned: 95 });
    const b = entry(100, 110, { id: 2, slPlanned: 106 });
    const s = summarise(ladder(a, b, exit(100, 120, { id: 3 })), "long");
    expect(s.openTranches[0].effectiveSl).toBe(106);
  });

  it("preserves the documented divergence between tranche prices and cost basis", () => {
    // Remaining tranche was filled at 110; the cost basis is 105. Both are
    // correct and they answer different questions. This is asserted so nobody
    // 'fixes' it later.
    const s = summarise(ladder(entry(100, 100), entry(100, 110), exit(100, 120)), "long");
    expect(s.openTranches[0].price).toBe(110);
    expect(s.avgOpenPrice).toBe(105);
  });
});

describe("R is frozen at the first entry", () => {
  it("computes initial risk from entry one only", () => {
    const legs = ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 110, { slPlanned: 106 }));
    const s = summarise(legs, "long");
    expect(s.initialRisk).toBe(500); // |100-95| * 100 — the second entry does not move it
  });

  it("sums fractional R across partial exits", () => {
    // Risk 500. Half out at +2R (1000), half at +3R (1500) => +2.5R total.
    const legs = ladder(
      entry(100, 100, { slPlanned: 95 }),
      exit(50, 120, { chargesTotal: 0 }), // (120-100)*50 = 1000 = 2R
      exit(50, 130, { chargesTotal: 0 }), // (130-100)*50 = 1500 = 3R
    );
    const s = summarise(legs, "long");
    expect(s.initialRisk).toBe(500);
    expect(s.fills[0].rContribution).toBe(2);
    expect(s.fills[1].rContribution).toBe(3);
    expect(s.realisedR).toBe(5); // 2500 / 500
  });

  it("does not re-baseline R when a tranche is added", () => {
    const single = summarise(ladder(entry(100, 100, { slPlanned: 95 }), exit(100, 105)), "long");
    const scaled = summarise(
      ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 102, { slPlanned: 99 }), exit(200, 105)),
      "long",
    );
    expect(single.initialRisk).toBe(500);
    expect(scaled.initialRisk).toBe(500); // unchanged by the add
  });

  it("reports null R when the first entry carried no stop", () => {
    const s = summarise(ladder(entry(100, 100), exit(100, 120)), "long");
    expect(s.initialRisk).toBeNull();
    expect(s.realisedR).toBeNull();
    expect(s.fills[0].rContribution).toBeNull();
    expect(s.warnings.some((w) => w.code === "no_initial_stop")).toBe(true);
  });

  it("nets charges out of the R contribution", () => {
    const legs = ladder(entry(100, 100, { slPlanned: 95 }), exit(100, 110, { chargesTotal: 500 }));
    const s = summarise(legs, "long");
    expect(s.fills[0].grossPnl).toBe(1000);
    expect(s.fills[0].netPnl).toBe(500);
    expect(s.fills[0].rContribution).toBe(1); // 500 net / 500 risk, not 2R gross
  });
});

describe("short positions", () => {
  it("makes money when price falls", () => {
    const s = summarise(ladder(entry(100, 100), exit(100, 90)), "short");
    expect(s.realisedGross).toBe(1000);
  });

  it("blends short entries and prices exits off the average", () => {
    const s = summarise(ladder(entry(100, 100), entry(100, 120), exit(100, 90)), "short");
    expect(s.avgOpenPrice).toBe(110);
    expect(s.fills[0].grossPnl).toBe(2000); // (110-90)*100
  });

  it("flags averaging UP as averaging down for a short", () => {
    const s = summarise(ladder(entry(100, 100), entry(100, 120)), "short");
    expect(s.warnings.some((w) => w.code === "averaging_down")).toBe(true);
  });

  it("computes initial risk with the stop above entry", () => {
    const s = summarise(ladder(entry(100, 100, { slPlanned: 105 })), "short");
    expect(s.initialRisk).toBe(500);
  });
});

describe("mark to market", () => {
  it("values the open remainder at the moving-average basis", () => {
    const s = summarise(ladder(entry(100, 100), entry(100, 110)), "long");
    const m = markToMarket(s, 115);
    expect(m.unrealised).toBe(2000); // (115-105)*200
  });

  it("adds realised and open R into a total", () => {
    const s = summarise(
      ladder(entry(100, 100, { slPlanned: 95 }), exit(50, 120, { chargesTotal: 0 })),
      "long",
    );
    const m = markToMarket(s, 110);
    expect(s.realisedR).toBe(2); // 1000/500
    expect(m.openR).toBe(1); // (110-100)*50 = 500 => 1R
    expect(m.totalR).toBe(3);
  });

  it("sums open risk across tranches with different stops", () => {
    const s = summarise(
      ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 110, { slPlanned: 108 })),
      "long",
    );
    const m = markToMarket(s, 112);
    // (112-95)*100 + (112-108)*100
    expect(m.openRiskAtSl).toBe(2100);
  });

  it("floors a tranche whose stop is already through the mark", () => {
    const s = summarise(ladder(entry(100, 100, { slPlanned: 110 })), "long");
    const m = markToMarket(s, 105); // stop above the mark: nothing further to lose
    expect(m.openRiskAtSl).toBe(0);
  });

  it("reports a NEGATIVE loss-if-stopped once stops are trailed into profit", () => {
    const s = summarise(ladder(entry(100, 100, { slPlanned: 95, trailingSl: 108 })), "long");
    const m = markToMarket(s, 115);
    expect(m.lossIfAllStopsHit).toBe(-800); // (100-108)*100 — profit locked in
  });

  it("treats an unstopped tranche as fully at risk", () => {
    const s = summarise(ladder(entry(100, 100)), "long");
    const m = markToMarket(s, 120);
    expect(m.unstoppedQty).toBe(100);
    expect(m.openRiskAtSl).toBe(12000);
  });

  it("returns zeros for a fully closed position", () => {
    const s = summarise(ladder(entry(100, 100), exit(100, 120)), "long");
    const m = markToMarket(s, 130);
    expect(m.unrealised).toBe(0);
    expect(m.openRiskAtSl).toBe(0);
  });

  it("survives a missing mark without inventing one", () => {
    const s = summarise(ladder(entry(100, 100)), "long");
    const m = markToMarket(s, null);
    expect(m.unrealised).toBe(0);
    expect(m.openRiskAtSl).toBeNull();
  });
});

describe("warnings", () => {
  it("flags averaging down but not pyramiding", () => {
    const down = summarise(ladder(entry(100, 100), entry(100, 90)), "long");
    const up = summarise(ladder(entry(100, 100), entry(100, 110)), "long");
    expect(down.warnings.some((w) => w.code === "averaging_down")).toBe(true);
    expect(up.warnings.some((w) => w.code === "averaging_down")).toBe(false);
  });

  it("never flags the first entry as averaging down", () => {
    const s = summarise(ladder(entry(100, 100)), "long");
    expect(s.warnings.some((w) => w.code === "averaging_down")).toBe(false);
  });

  it("flags a tranche added without a stop", () => {
    const s = summarise(ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 110)), "long");
    const w = s.warnings.filter((x) => x.code === "unstopped_tranche");
    expect(w).toHaveLength(1);
  });

  it("flags when adds push open risk past the frozen initial risk", () => {
    // Entry 1 risks 500. Adding a big unstopped tranche blows past it.
    const s = summarise(
      ladder(entry(100, 100, { slPlanned: 95 }), entry(500, 100, { slPlanned: 90 })),
      "long",
    );
    expect(s.warnings.some((w) => w.code === "risk_exceeds_initial")).toBe(true);
  });

  it("stays quiet when the add is funded by trailing the original stop up", () => {
    // The professional pyramid: price ran to 110, so you add there AND trail
    // the first tranche's stop up to the new one. Total risk goes to zero and
    // the warning correctly stays silent.
    const s = summarise(
      ladder(
        entry(100, 100, { slPlanned: 95, trailingSl: 105 }),
        entry(100, 110, { slPlanned: 105 }),
      ),
      "long",
    );
    expect(s.warnings.some((w) => w.code === "risk_exceeds_initial")).toBe(false);
  });

  it("fires on an add that does NOT raise the original stop — the whole point", () => {
    // Adding without trailing always increases total exposure, because the
    // blended cost pulls away from the first tranche's stop. This warning is
    // how you notice you have quietly doubled your planned loss.
    const s = summarise(
      ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 104, { slPlanned: 103 })),
      "long",
    );
    expect(s.warnings.some((w) => w.code === "risk_exceeds_initial")).toBe(true);
  });
});

describe("validateLegs", () => {
  it("passes a well-formed ladder", () => {
    expect(validateLegs(ladder(entry(100, 100), entry(50, 110), exit(150, 120)))).toEqual([]);
  });

  it("rejects an exit larger than what is open", () => {
    const p = validateLegs(ladder(entry(100, 100), exit(150, 120)));
    expect(p).toHaveLength(1);
    expect(p[0].message).toMatch(/exceeds/);
  });

  it("rejects a ladder that opens with an exit", () => {
    const p = validateLegs(ladder(exit(100, 120)));
    expect(p.some((x) => /must start with an entry/.test(x.message))).toBe(true);
  });

  it("rejects zero and negative quantities", () => {
    expect(validateLegs(ladder(entry(0, 100))).length).toBeGreaterThan(0);
    expect(validateLegs(ladder(entry(-5, 100))).length).toBeGreaterThan(0);
  });

  it("allows re-entering after a full exit", () => {
    expect(validateLegs(ladder(entry(100, 100), exit(100, 120), entry(100, 130)))).toEqual([]);
  });

  it("clamps rather than throws when summarising an over-exit", () => {
    const s = summarise(ladder(entry(100, 100), exit(150, 120)), "long");
    expect(s.openQty).toBe(0);
    expect(s.fills[0].qty).toBe(100); // clamped to what was actually open
  });
});

describe("legChargeShapes", () => {
  it("prices a long's entry as a buy and its exit as a sell", () => {
    const shapes = legChargeShapes(ladder(entry(100, 100), exit(100, 120)), "long");
    expect(shapes[0].buyValue).toBe(10000);
    expect(shapes[0].sellValue).toBe(0);
    expect(shapes[1].sellValue).toBe(12000);
    expect(shapes[1].buyValue).toBe(0);
  });

  it("inverts the sides for a short", () => {
    const shapes = legChargeShapes(ladder(entry(100, 100), exit(100, 90)), "short");
    expect(shapes[0].sellValue).toBe(10000); // a short's entry IS a sell
    expect(shapes[1].buyValue).toBe(9000);
  });

  it("charges DP once per exit date, not once per exit leg", () => {
    const shapes = legChargeShapes(
      ladder(
        entry(300, 100, { tradeDate: "2026-01-01" }),
        exit(100, 120, { tradeDate: "2026-02-01" }),
        exit(100, 121, { tradeDate: "2026-02-01" }), // same day => suppressed
        exit(100, 122, { tradeDate: "2026-02-02" }), // new day => charged
      ),
      "long",
    );
    const exits = shapes.filter((s) => s.sellValue > 0);
    expect(exits.map((e) => e.suppressDp)).toEqual([false, true, false]);
  });

  it("counts every fill as its own order for brokerage", () => {
    const shapes = legChargeShapes(ladder(entry(100, 100), entry(100, 110)), "long");
    expect(shapes.every((s) => s.buyOrderCount === 1)).toBe(true);
    expect(shapes).toHaveLength(2);
  });
});

describe("parentAggregate", () => {
  it("collapses a long ladder into the flat trade shape", () => {
    const legs = ladder(
      entry(100, 100, { tradeDate: "2026-01-01", tradeTime: "09:20" }),
      entry(100, 110, { tradeDate: "2026-01-02" }),
      exit(200, 130, { tradeDate: "2026-01-05", tradeTime: "15:10" }),
    );
    const a = parentAggregate(legs, "long");
    expect(a.buyQty).toBe(200);
    expect(a.avgBuyPrice).toBe(105);
    expect(a.buyValue).toBe(21000);
    expect(a.buyOrderCount).toBe(2);
    expect(a.sellQty).toBe(200);
    expect(a.avgSellPrice).toBe(130);
    expect(a.buyDate).toBe("2026-01-01");
    expect(a.sellDate).toBe("2026-01-05");
    expect(a.entryTime).toBe("09:20");
    expect(a.exitTime).toBe("15:10");
    expect(a.isOpen).toBe(false);
  });

  it("puts a short's entries on the SELL side", () => {
    const legs = ladder(
      entry(100, 120, { tradeDate: "2026-01-01" }),
      exit(100, 100, { tradeDate: "2026-01-05" }),
    );
    const a = parentAggregate(legs, "short");
    expect(a.sellQty).toBe(100);
    expect(a.avgSellPrice).toBe(120); // the entry
    expect(a.buyQty).toBe(100);
    expect(a.avgBuyPrice).toBe(100); // the cover
    expect(a.buyDate).toBe("2026-01-05");
    expect(a.sellDate).toBe("2026-01-01");
  });

  it("reports the WIDEST open stop so risk is never understated", () => {
    const legs = ladder(entry(100, 100, { slPlanned: 95 }), entry(100, 110, { slPlanned: 108 }));
    const a = parentAggregate(legs, "long");
    expect(a.slPlanned).toBe(95); // not 108 — 95 is the one hit last
  });

  it("reports the widest trailing stop for a short as the HIGHEST", () => {
    const legs = ladder(
      entry(100, 100, { slPlanned: 105, trailingSl: 103 }),
      entry(100, 98, { slPlanned: 104, trailingSl: 106 }),
    );
    const a = parentAggregate(legs, "short");
    expect(a.trailingSl).toBe(106);
  });

  it("leaves trailingSl null when no tranche has one", () => {
    const a = parentAggregate(ladder(entry(100, 100, { slPlanned: 95 })), "long");
    expect(a.trailingSl).toBeNull();
  });

  it("carries the frozen initial risk onto the parent", () => {
    const a = parentAggregate(
      ladder(entry(100, 100, { slPlanned: 95 }), entry(200, 110, { slPlanned: 100 })),
      "long",
    );
    expect(a.riskAmount).toBe(500);
  });

  it("marks the parent open while any quantity remains", () => {
    const a = parentAggregate(ladder(entry(100, 100), exit(40, 120)), "long");
    expect(a.isOpen).toBe(true);
    expect(a.sellQty).toBe(40);
  });

  it("never reports an order count below 1", () => {
    const a = parentAggregate(ladder(entry(100, 100)), "long");
    expect(a.sellOrderCount).toBe(1);
  });
});

describe("round-trip consistency with the classic single-entry model", () => {
  it("a one-entry one-exit ladder matches a plain trade exactly", () => {
    const legs = ladder(
      entry(50, 200, { tradeDate: "2026-03-01", slPlanned: 190 }),
      exit(50, 240, { tradeDate: "2026-03-10", chargesTotal: 120 }),
    );
    const a = parentAggregate(legs, "long");
    const s = summarise(legs, "long");
    expect(a.buyQty).toBe(50);
    expect(a.avgBuyPrice).toBe(200);
    expect(a.sellQty).toBe(50);
    expect(a.avgSellPrice).toBe(240);
    expect(s.realisedGross).toBe(2000);
    expect(s.realisedNet).toBe(1880);
    expect(s.realisedR).toBe(r(1880 / 500));
    expect(a.isOpen).toBe(false);
  });
});

function r(n: number) {
  return Math.round(n * 100) / 100;
}
