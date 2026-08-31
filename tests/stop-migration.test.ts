import { describe, expect, it } from "vitest";
import {
  classifyMove,
  stopMigration,
  stopMigrationFinding,
  MIN_WIDENED_SAMPLE,
  type StopEdit,
} from "@/lib/analytics/stop-migration";

/**
 * Widening a stop while a trade is against you converts a planned, sized loss
 * into an unplanned one — and it is invisible everywhere else, because the
 * journal stores the FINAL stop. The audit log is the only place the original
 * intention survives.
 */

const e = (o: Partial<StopEdit>): StopEdit => ({
  tradeId: 1, ts: "2026-05-01T10:00:00", before: 100, after: 95, direction: "long", ...o,
});

describe("classifyMove — widening is about RISK, not price direction", () => {
  it("a long stop moved DOWN is widened", () => {
    expect(classifyMove(e({ before: 100, after: 95, direction: "long" }))).toBe("widened");
    expect(classifyMove(e({ before: 100, after: 105, direction: "long" }))).toBe("tightened");
  });

  it("a short stop moved UP is widened", () => {
    expect(classifyMove(e({ before: 100, after: 105, direction: "short" }))).toBe("widened");
    expect(classifyMove(e({ before: 100, after: 95, direction: "short" }))).toBe("tightened");
  });

  it("distinguishes setting a stop from moving one, and removing from both", () => {
    expect(classifyMove(e({ before: null, after: 95 }))).toBe("set");
    expect(classifyMove(e({ before: 100, after: null }))).toBe("removed");
    expect(classifyMove(e({ before: null, after: null }))).toBe("unchanged");
    expect(classifyMove(e({ before: 100, after: 100 }))).toBe("unchanged");
  });
});

describe("stopMigration", () => {
  it("counts trades and events separately — one trade can be widened repeatedly", () => {
    const r = stopMigration(
      [
        e({ tradeId: 1, before: 100, after: 95 }),
        e({ tradeId: 1, before: 95, after: 90 }),
        e({ tradeId: 2, before: 100, after: 105 }),
      ],
      new Map([[1, -5000], [2, 2000]]),
    );
    expect(r.widenedTrades).toBe(1);
    expect(r.widenEvents).toBe(2);
    expect(r.worstTradeId).toBe(1);
    expect(r.worstTradeWidenings).toBe(2);
  });

  it("reports the expectancy GAP, never a counterfactual P&L", () => {
    const r = stopMigration(
      [e({ tradeId: 1, before: 100, after: 90 }), e({ tradeId: 2, before: 100, after: 110 })],
      new Map([[1, -4000], [2, 1000]]),
    );
    expect(r.expectancyWidened).toBe(-4000);
    expect(r.expectancyDisciplined).toBe(1000);
    expect(r.expectancyGap).toBe(-5000);
    // There is no field claiming what the trade "would have" made.
    expect(Object.keys(r)).not.toContain("counterfactualPnl");
  });

  it("returns null expectancies rather than 0 when a population is empty", () => {
    const r = stopMigration([e({ tradeId: 1, before: 100, after: 90 })], new Map());
    expect(r.expectancyWidened).toBeNull();
    expect(r.expectancyDisciplined).toBeNull();
    expect(r.expectancyGap).toBeNull();
  });

  it("ignores edits that changed nothing", () => {
    const r = stopMigration([e({ tradeId: 1, before: 100, after: 100 })], new Map([[1, 10]]));
    expect(r.measured).toBe(0);
    expect(r.widenedTrades).toBe(0);
  });
});

describe("stopMigrationFinding", () => {
  const many = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => e({ tradeId: from + i, before: 100, after: 90 }));

  it("says nothing at all when no stop was ever widened", () => {
    expect(stopMigrationFinding(stopMigration([], new Map([[1, 5]])))).toBeNull();
  });

  it("stays silent below the sample threshold rather than asserting on three trades", () => {
    const r = stopMigration(many(2, 1), new Map([[1, -100], [2, -100], [3, 50]]));
    expect(stopMigrationFinding(r, 10)).toBeNull();
  });

  it("refuses an n=1 expectancy claim — one widened trade in a ten-trade book stays silent (v3.5.0 regression)", () => {
    // The old gate summed widenedTrades + disciplinedTrades: 1 + 9 = 10 passed
    // minSample and the screen asserted "your widened stops average ₹X worse"
    // over a single trade. The floor now binds the widened wing itself.
    const pnl = new Map<number, number>();
    pnl.set(1, -9000);
    for (let i = 2; i <= 10; i++) pnl.set(i, 500);
    const r = stopMigration(many(1, 1), pnl);
    expect(r.widenedTrades).toBe(1);
    expect(r.widenedTrades + r.disciplinedTrades).toBeGreaterThanOrEqual(10); // total gate alone would pass
    expect(stopMigrationFinding(r, 10)).toBeNull();
  });

  it("concludes exactly at the widened-wing floor, and the floor is 5", () => {
    expect(MIN_WIDENED_SAMPLE).toBe(5);
    const pnl = new Map<number, number>();
    for (let i = 1; i <= 5; i++) pnl.set(i, -1000);
    for (let i = 6; i <= 12; i++) pnl.set(i, 400);
    expect(stopMigrationFinding(stopMigration(many(5, 1), pnl), 10)).toMatch(/WORSE per trade/);
    // One fewer widened trade, same total sample: silent.
    const pnl4 = new Map(pnl);
    const r4 = stopMigration(many(4, 1), pnl4);
    expect(r4.widenedTrades + r4.disciplinedTrades).toBe(12);
    expect(stopMigrationFinding(r4, 10)).toBeNull();
  });

  it("states the baseline for what it is — trades with no widening on record, not a verified untouched set", () => {
    const pnl = new Map<number, number>();
    for (let i = 1; i <= 6; i++) pnl.set(i, -1000);
    for (let i = 7; i <= 14; i++) pnl.set(i, 500);
    const msg = stopMigrationFinding(stopMigration(many(6, 1), pnl), 10)!;
    expect(msg).toMatch(/no widening on the audit record/);
    expect(msg).not.toMatch(/where the stop stood/);
  });

  it("states the cost when widening really is worse", () => {
    const pnl = new Map<number, number>();
    for (let i = 1; i <= 6; i++) pnl.set(i, -1000);
    for (let i = 7; i <= 14; i++) pnl.set(i, 500);
    const r = stopMigration(many(6, 1), pnl);
    const msg = stopMigrationFinding(r, 10)!;
    expect(msg).toMatch(/WORSE per trade/);
    expect(msg).toMatch(/6 trades/);
  });

  it("says so honestly when widening did NOT cost anything on this book", () => {
    const pnl = new Map<number, number>();
    for (let i = 1; i <= 6; i++) pnl.set(i, 800);
    for (let i = 7; i <= 14; i++) pnl.set(i, 100);
    const r = stopMigration(many(6, 1), pnl);
    expect(stopMigrationFinding(r, 10)!).toMatch(/not currently costing you/);
  });
});
