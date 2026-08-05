import { describe, expect, it } from "vitest";
import { scalingQuality, type ScalingTradeInput } from "@/lib/analytics/scaling-quality";
import type { Leg } from "@/lib/domain/staged";

/**
 * B1 — did adding to the position actually help?
 *
 * The comparison is against a CLEARLY LABELLED counterfactual: what the first
 * tranche alone would have netted, exited at the same blended average. That is
 * an assumption, not a fact — the user might have sized differently, or the
 * fill might have moved the price — which is why the module reports it as
 * `firstEntryOnlyNet` rather than claiming "you would have made X".
 *
 * The dead-band matters as much as the sign: max(₹10, 1% of the baseline)
 * keeps rounding noise and a two-rupee charge difference from being reported
 * as a scaling edge.
 */

const leg = (over: Partial<Leg> & Pick<Leg, "id" | "kind" | "seq" | "qty" | "price">): Leg => ({
  tradeDate: "2026-01-01",
  chargesTotal: 0,
  ...over,
});

const staged = (legs: Leg[], over: Partial<ScalingTradeInput> = {}): ScalingTradeInput => ({
  id: 1,
  symbol: "ABC",
  direction: "long",
  legs,
  ...over,
});

describe("scaling quality — verdicts", () => {
  it("calls a winning pyramid an improvement", () => {
    // Added at 110, exited everything at 120: the second tranche made money.
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100, chargesTotal: 1 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 110, chargesTotal: 1 }),
        leg({ id: 3, kind: "exit", seq: 3, qty: 20, price: 120, chargesTotal: 2 }),
      ]),
    ]);
    expect(r.closed).toBe(1);
    expect(r.improved).toBe(1);
    expect(r.rows[0].scalingImpact).toBeGreaterThan(0);
    expect(r.rows[0].entries).toBe(2);
    expect(r.rows[0].exits).toBe(1);
  });

  it("calls averaging down into a loser a harm", () => {
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 90 }),
        leg({ id: 3, kind: "exit", seq: 3, qty: 20, price: 80 }),
      ]),
    ]);
    expect(r.harmed).toBe(1);
    expect(r.rows[0].verdict).toBe("harmed");
    expect(r.rows[0].scalingImpact).toBeLessThan(0);
  });

  it("calls a single-entry position neutral — there was no scaling to judge", () => {
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 2, kind: "exit", seq: 2, qty: 10, price: 120 }),
      ]),
    ]);
    expect(r.rows[0].verdict).toBe("neutral");
    expect(r.rows[0].scalingImpact).toBe(0);
    expect(r.neutral).toBe(1);
  });

  it("keeps a difference inside the dead-band out of the verdict", () => {
    // A tiny second tranche moves the number by rupees, not by edge.
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 1000, price: 100 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 1, price: 100 }),
        leg({ id: 3, kind: "exit", seq: 3, qty: 1001, price: 100.5 }),
      ]),
    ]);
    expect(r.rows[0].verdict).toBe("neutral");
  });
});

describe("scaling quality — direction", () => {
  it("prices a short ladder in the direction that makes it money", () => {
    // Sold at 100, added at 110 (against the position), covered at 90.
    const r = scalingQuality([
      staged(
        [
          leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
          leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 110 }),
          leg({ id: 3, kind: "exit", seq: 3, qty: 20, price: 90 }),
        ],
        { direction: "short" },
      ),
    ]);
    // First tranche alone: sold 100, covered 90 → +10 × 10 = +100.
    expect(r.rows[0].firstEntryOnlyNet).toBe(100);
    // The whole ladder did better: the 110 tranche gained 20/unit.
    expect(r.rows[0].scalingImpact).toBeGreaterThan(0);
  });

  it("a long and a short with mirrored prices produce mirrored baselines", () => {
    const legs = [
      leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
      leg({ id: 2, kind: "exit", seq: 2, qty: 10, price: 110 }),
    ];
    const long = scalingQuality([staged(legs, { direction: "long" })]);
    const short = scalingQuality([staged(legs, { direction: "short" })]);
    expect(long.rows[0].firstEntryOnlyNet).toBe(100);
    expect(short.rows[0].firstEntryOnlyNet).toBe(-100);
  });
});

describe("scaling quality — what it refuses to judge", () => {
  it("marks a still-open position open, with no counterfactual", () => {
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 110 }),
      ]),
    ]);
    expect(r.rows[0].verdict).toBe("open");
    expect(r.rows[0].firstEntryOnlyNet).toBeNull();
    expect(r.rows[0].scalingImpact).toBeNull();
    expect(r.closed).toBe(0);
  });

  it("marks a partially-exited position open too", () => {
    const r = scalingQuality([
      staged([
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 110 }),
        leg({ id: 3, kind: "exit", seq: 3, qty: 5, price: 120 }),
      ]),
    ]);
    expect(r.rows[0].verdict).toBe("open");
  });

  it("keeps open positions out of every aggregate", () => {
    const r = scalingQuality([
      staged([leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 })], { id: 1 }),
      staged(
        [
          leg({ id: 2, kind: "entry", seq: 1, qty: 10, price: 100 }),
          leg({ id: 3, kind: "exit", seq: 2, qty: 10, price: 120 }),
        ],
        { id: 2 },
      ),
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.closed).toBe(1);
    expect(r.avgImpact).toBe(r.totalImpact); // averaged over the 1 closed row
  });

  it("returns an empty report rather than dividing by zero", () => {
    const r = scalingQuality([]);
    expect(r.rows).toEqual([]);
    expect(r.closed).toBe(0);
    expect(r.totalImpact).toBe(0);
    expect(r.avgImpact).toBeNull();
  });
});

describe("scaling quality — aggregates", () => {
  it("totals and averages impact over closed rows only", () => {
    const win = staged(
      [
        leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 2, kind: "entry", seq: 2, qty: 10, price: 110 }),
        leg({ id: 3, kind: "exit", seq: 3, qty: 20, price: 120 }),
      ],
      { id: 1 },
    );
    const lose = staged(
      [
        leg({ id: 4, kind: "entry", seq: 1, qty: 10, price: 100 }),
        leg({ id: 5, kind: "entry", seq: 2, qty: 10, price: 90 }),
        leg({ id: 6, kind: "exit", seq: 3, qty: 20, price: 80 }),
      ],
      { id: 2 },
    );
    const r = scalingQuality([win, lose]);
    expect(r.closed).toBe(2);
    expect(r.improved).toBe(1);
    expect(r.harmed).toBe(1);
    expect(r.totalImpact).toBe(Math.round((r.rows[0].scalingImpact! + r.rows[1].scalingImpact!) * 100) / 100);
    expect(r.avgImpact).toBe(Math.round((r.totalImpact / 2) * 100) / 100);
  });

  it("verdict counts always add up to the closed count", () => {
    const r = scalingQuality([
      staged([leg({ id: 1, kind: "entry", seq: 1, qty: 10, price: 100 }), leg({ id: 2, kind: "exit", seq: 2, qty: 10, price: 120 })], { id: 1 }),
      staged([leg({ id: 3, kind: "entry", seq: 1, qty: 10, price: 100 }), leg({ id: 4, kind: "entry", seq: 2, qty: 10, price: 110 }), leg({ id: 5, kind: "exit", seq: 3, qty: 20, price: 130 })], { id: 2 }),
      staged([leg({ id: 6, kind: "entry", seq: 1, qty: 10, price: 100 })], { id: 3 }),
    ]);
    expect(r.improved + r.harmed + r.neutral).toBe(r.closed);
  });
});
