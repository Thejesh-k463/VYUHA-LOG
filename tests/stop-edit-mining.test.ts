import { describe, expect, it } from "vitest";
import { extractStopEdits, type TradeAuditEntry } from "@/lib/analytics/stop-edit-mining";
import { classifyMove, stopMigration } from "@/lib/analytics/stop-migration";

/**
 * The audit log is the only place a trade's ORIGINAL stop survives, and it is
 * mined, never inferred: a leg_edit whose patch touched the stop is a real
 * before → after pair; leg_stop_all has no before-image and can only ever be a
 * SET; the plain trade "update" audit carries no stop fields at all and is
 * skipped entirely rather than read optimistically.
 */

const entry = (o: Partial<TradeAuditEntry>): TradeAuditEntry => ({
  tradeId: 1,
  ts: "2026-06-01T10:00:00",
  action: "leg_edit",
  before: { qty: 10, price: 100, slPlanned: 95, trailingSl: null },
  after: { slPlanned: 90 },
  ...o,
});

const LONG = new Map<number, "long" | "short">([[1, "long"]]);

describe("extractStopEdits", () => {
  it("mines a leg_edit whose patch carries slPlanned as a before → after pair", () => {
    const { edits, noDirection } = extractStopEdits([entry({})], LONG);
    expect(noDirection).toBe(0);
    expect(edits).toEqual([{ tradeId: 1, ts: "2026-06-01T10:00:00", before: 95, after: 90, direction: "long" }]);
    expect(classifyMove(edits[0])).toBe("widened");
  });

  it("skips a leg_edit whose patch did NOT touch the stop — qty/price edits are not stop edits", () => {
    const { edits } = extractStopEdits([entry({ after: { qty: 20 } })], LONG);
    expect(edits).toEqual([]);
  });

  it("mines leg_stop_all as a SET (no before-image on record), never a widening", () => {
    const { edits } = extractStopEdits(
      [entry({ action: "leg_stop_all", before: null, after: { slPlanned: 88 } })],
      LONG,
    );
    expect(edits).toEqual([{ tradeId: 1, ts: "2026-06-01T10:00:00", before: null, after: 88, direction: "long" }]);
    expect(classifyMove(edits[0])).toBe("set");
  });

  it("reads an explicit null in the patch as a REMOVED stop", () => {
    const { edits } = extractStopEdits([entry({ after: { slPlanned: null } })], LONG);
    expect(edits[0].after).toBeNull();
    expect(classifyMove(edits[0])).toBe("removed");
  });

  it("skips actions that never carry stop levels — the plain update audit records no stop", () => {
    const { edits } = extractStopEdits(
      [entry({ action: "update", before: { netPnl: -100 }, after: { netPnl: -200, slPlanned: 90 } })],
      LONG,
    );
    expect(edits).toEqual([]);
  });

  it("drops and COUNTS entries whose trade has no known direction — the account-scope join", () => {
    const { edits, noDirection } = extractStopEdits([entry({ tradeId: 99 })], LONG);
    expect(edits).toEqual([]);
    expect(noDirection).toBe(1);
  });

  it("ignores entries without a trade id, and non-numeric stop values", () => {
    const { edits, noDirection } = extractStopEdits(
      [
        entry({ tradeId: null }),
        entry({ after: { slPlanned: "95" } }), // a stop-touching patch with an unreadable level
      ],
      LONG,
    );
    expect(noDirection).toBe(0);
    // The string level maps to null — indistinguishable from a removal is the
    // conservative reading; what matters is it can never mint a number.
    expect(edits).toHaveLength(1);
    expect(edits[0].after).toBeNull();
  });

  it("EXCLUDES a fully-closed short rather than misclassifying its widening (v3.5.0 regression)", () => {
    // A short entered at 120 with a stop at 130, raised to 160 — a REAL
    // widening — then fully closed. The flat row has buyQty === sellQty, so
    // direction is unknowable from it; the page used to guess "long"
    // (sellQty > buyQty ? short : long), and under "long" the same edit
    // classifies as a TIGHTENING. The fix leaves flat rows out of the
    // direction map entirely, so the edit falls to the drop path and is
    // COUNTED, never inverted.
    const raise = entry({ tradeId: 7, before: { slPlanned: 130 }, after: { slPlanned: 160 } });

    // The inversion the old guess produced, pinned so nobody reintroduces it:
    expect(classifyMove({ tradeId: 7, ts: raise.ts, before: 130, after: 160, direction: "short" })).toBe("widened");
    expect(classifyMove({ tradeId: 7, ts: raise.ts, before: 130, after: 160, direction: "long" })).toBe("tightened");

    // Page rule after the fix: a flat row (sellQty === buyQty) never enters the map.
    const flatRows = [{ id: 7, buyQty: 50, sellQty: 50 }];
    const directionByTrade = new Map<number, "long" | "short">();
    for (const t of flatRows) {
      if (t.sellQty !== t.buyQty) directionByTrade.set(t.id, t.sellQty > t.buyQty ? "short" : "long");
    }

    const { edits, noDirection } = extractStopEdits([raise], directionByTrade);
    expect(edits).toEqual([]);
    expect(noDirection).toBe(1);

    const r = stopMigration(edits, new Map([[7, -2500]]));
    expect(r.widenedTrades).toBe(0); // excluded — not counted as widened, and NOT as tightened either
    expect(r.measured).toBe(0);
  });

  it("feeds stopMigration end to end — a long stop moved down twice is one widened trade, two events", () => {
    const { edits } = extractStopEdits(
      [
        entry({ before: { slPlanned: 95 }, after: { slPlanned: 92 } }),
        entry({ before: { slPlanned: 92 }, after: { slPlanned: 88 } }),
      ],
      LONG,
    );
    const r = stopMigration(edits, new Map([[1, -4000], [2, 900]]));
    expect(r.widenedTrades).toBe(1);
    expect(r.widenEvents).toBe(2);
    expect(r.expectancyWidened).toBe(-4000);
    expect(r.expectancyDisciplined).toBe(900);
  });
});
