import { describe, expect, it } from "vitest";
import { planLotCloses, splitByRemainder, type IncomingRow, type OpenLot } from "@/lib/import/close-open-lots";

/**
 * R5 (v4.2.1) — the PURE FIFO planner behind wave 1's auto-close.
 *
 * SWITCHED OFF FOR 4.3.0 (owner ruling 2026-09-11, 06-ANSWERS "v4.3.0
 * release-level-audit rulings", row 1): lib/import/commit.ts is v4.2.0 again,
 * and no production code calls `planLotCloses`. The planner is kept, dormant,
 * for the 4.3.1 rebuild, and so are these tests.
 *
 * The DB cases 1–11 this file carried while auto-close was live were MOVED to
 * tests/auto-close-off.test.ts and rewritten to assert v4.2.0's outcome for the
 * same inputs (nothing was deleted). Where a case carried PLANNER meaning (2, 3,
 * 7, 9, 10) its expectation is restated below as a pure case, so 4.3.1 loses
 * nothing. Case 10's exclusions were the CALLER's, not the planner's; the pure
 * case says so, so the rebuild keeps them in the caller.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

const lot = (over: Partial<OpenLot> & { id: number }): OpenLot => ({
  accountId: 1,
  broker: "dhan",
  tradingsymbol: "TCS",
  segment: "eq_delivery",
  exchange: "NSE",
  side: "long",
  qty: 100,
  price: 100,
  value: 10000,
  charges: 20,
  date: "2026-04-01",
  ...over,
});
const row = (over: Partial<IncomingRow> & { key: string }): IncomingRow => ({
  accountId: 1,
  broker: "dhan",
  tradingsymbol: "TCS",
  segment: "eq_delivery",
  exchange: "NSE",
  side: "sell",
  qty: 40,
  price: 120,
  value: 4800,
  charges: 10,
  date: "2026-05-01",
  ...over,
});

// ───────────────────────────── the pure planner ─────────────────────────────

describe("planLotCloses — the decision, with no database in sight", () => {
  it("takes the OLDEST lot first, and splits it by quantity", () => {
    const plan = planLotCloses(
      [lot({ id: 2, qty: 50, value: 5500, price: 110, date: "2026-04-10" }), lot({ id: 1, qty: 50, value: 5000 })],
      [row({ key: "s1", qty: 70, value: 8400 })],
    );
    expect(plan.closes.map((c) => [c.lotId, c.qty])).toEqual([[1, 50], [2, 20]]);
    expect(plan.closes[0].fullyConsumed).toBe(true);
    expect(plan.closes[1].fullyConsumed).toBe(false);
    expect(plan.remainders).toEqual([
      { lotId: 1, qty: 0, value: 0, charges: 0 },
      { lotId: 2, qty: 30, value: 3300, charges: 12 },
    ]);
    expect(plan.untouched).toEqual([]);
  });

  it("only ever matches the OPPOSITE side", () => {
    expect(planLotCloses([lot({ id: 1 })], [row({ key: "b1", side: "buy" })]).closes).toEqual([]);
    expect(planLotCloses([lot({ id: 1, side: "short", qty: 40 })], [row({ key: "s1" })]).closes).toEqual([]);
    expect(planLotCloses([lot({ id: 1, side: "short", qty: 40 })], [row({ key: "b1", side: "buy" })]).closes)
      .toHaveLength(1);
  });

  it("never crosses an account, a broker, a symbol or a segment", () => {
    const l = lot({ id: 1 });
    expect(planLotCloses([l], [row({ key: "a", accountId: 2 })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "b", broker: "zerodha" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "c", tradingsymbol: "INFY" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "d", segment: "eq_intraday" })]).closes).toEqual([]);
    expect(planLotCloses([l], [row({ key: "e", exchange: "BSE" })]).closes).toEqual([]);
  });

  it("reports the quantity that closed nothing, and leaves the input untouched", () => {
    const lots = [lot({ id: 1, qty: 30, value: 3000 })];
    const plan = planLotCloses(lots, [row({ key: "s1", qty: 100, value: 12000 })]);
    expect(plan.closes).toHaveLength(1);
    expect(plan.untouched).toEqual([{ key: "s1", qty: 70 }]);
    expect(lots[0].qty, "the planner is pure — it may not mutate the book").toBe(30);
  });
});

describe("splitByRemainder — one component, two parts, never a paisa invented", () => {
  it("the slice takes its rounded share and the remainder takes what is LEFT", () => {
    // The two figures the round-2 audit named: independent rounding turned
    // ₹1.25 sold half into ₹1.26, and a ₹0.01 SEBI fee into ₹0.02.
    expect(splitByRemainder(1.25, 0.5)).toEqual({ slice: 0.63, keep: 0.62 });
    expect(splitByRemainder(0.01, 0.5)).toEqual({ slice: 0.01, keep: 0 });
    expect(splitByRemainder(20, 0.4)).toEqual({ slice: 8, keep: 12 });
    expect(splitByRemainder(0.01, 1), "a whole take leaves nothing behind").toEqual({ slice: 0.01, keep: 0 });
    expect(splitByRemainder(0, 0.5)).toEqual({ slice: 0, keep: 0 });
  });

  it("holds for EVERY paise figure a 50/50 split can meet", () => {
    for (let paise = 0; paise <= 500; paise++) {
      const total = r2(paise / 100);
      const { slice, keep } = splitByRemainder(total, 0.5);
      expect(r2(slice + keep), `${total} split in half`).toBe(total);
    }
  });
});

// ──────── the planner meaning of the DB cases moved to auto-close-off ────────

describe("the moved DB cases, as the PLANNER sees them (kept for the 4.3.1 rebuild)", () => {
  it("case 2 — lots of 50 @100 (older) and 50 @110, SELL 70 @120: the older whole, 20 of the newer, realised 1000 + 200", () => {
    const plan = planLotCloses(
      [lot({ id: 2, qty: 50, price: 110, value: 5500, date: "2026-04-10" }), lot({ id: 1, qty: 50, price: 100, value: 5000 })],
      [row({ key: "s", qty: 70, price: 120, value: 8400, charges: 14 })],
    );
    expect(
      plan.closes.map((c) => ({ lotId: c.lotId, qty: c.qty, openPrice: c.openPrice, openValue: c.openValue, fullyConsumed: c.fullyConsumed })),
    ).toEqual([
      { lotId: 1, qty: 50, openPrice: 100, openValue: 5000, fullyConsumed: true },
      { lotId: 2, qty: 20, openPrice: 110, openValue: 2200, fullyConsumed: false },
    ]);
    expect(plan.closes.map((c) => r2((c.price - c.openPrice) * c.qty))).toEqual([1000, 200]);
    // The incoming row's bill, apportioned by quantity — never whole on each slice.
    expect(plan.closes.map((c) => c.charges)).toEqual([10, 4]);
    expect(plan.remainders).toEqual([
      { lotId: 1, qty: 0, value: 0, charges: 0 },
      { lotId: 2, qty: 30, value: 3300, charges: 12 },
    ]);
  });

  it("case 3 — a short 100 @100 covered by a BUY 100 @90: one close, the cover dated as the exit, realised +1000", () => {
    const plan = planLotCloses(
      [lot({ id: 7, side: "short", qty: 100, price: 100, value: 10000, date: "2026-04-01" })],
      [row({ key: "b", side: "buy", qty: 100, price: 90, value: 9000, date: "2026-04-02" })],
    );
    expect(plan.closes).toHaveLength(1);
    const c = plan.closes[0];
    expect([c.side, c.qty, c.price, c.openPrice, c.date, c.openDate, c.fullyConsumed]).toEqual([
      "short", 100, 90, 100, "2026-04-02", "2026-04-01", true,
    ]);
    expect(r2((c.openPrice - c.price) * c.qty), "a short that made money").toBe(1000);
    expect(plan.untouched).toEqual([]);
  });

  it("case 7 — the planner never pairs two INCOMING rows; a same-file BUY is a lot only when the caller folds it in", () => {
    const buy = row({ key: "b", side: "buy", qty: 100, price: 100, value: 10000, date: "2026-09-07" });
    const sell = row({ key: "s", side: "sell", qty: 100, price: 120, value: 12000, date: "2026-09-09" });
    const alone = planLotCloses([], [buy, sell]);
    expect(alone.closes).toEqual([]);
    expect(alone.untouched).toEqual([{ key: "b", qty: 100 }, { key: "s", qty: 100 }]);

    // Folded in as a lot (what d0eda00's commit did after writing the BUY): the SELL closes it whole.
    const folded = planLotCloses([lot({ id: 9, qty: 100, price: 100, value: 10000, date: "2026-09-07" })], [sell]);
    expect(folded.closes.map((c) => [c.lotId, c.qty, c.fullyConsumed, c.openDate, c.date])).toEqual([
      [9, 100, true, "2026-09-07", "2026-09-09"],
    ]);
    expect(r2((folded.closes[0].price - folded.closes[0].openPrice) * folded.closes[0].qty)).toBe(2000);
  });

  it("case 9 — half a lot whose charges are one odd paisa: the lot share is 0.5 and the paisa is conserved", () => {
    const plan = planLotCloses([lot({ id: 1, qty: 100, value: 10000, charges: 0.01 })], [row({ key: "s", qty: 50, value: 6000 })]);
    expect(plan.closes[0].lotShare).toBe(0.5);
    expect(r2(plan.closes[0].openCharges + plan.remainders[0].charges), "never ₹0.01 twice").toBe(0.01);
    // The per-component rule settles that same paisa the same way.
    expect(splitByRemainder(0.01, plan.closes[0].lotShare)).toEqual({ slice: 0.01, keep: 0 });
  });

  it("case 10 — the planner has no notion of MTF or an unknown basis: those exclusions belong to the CALLER", () => {
    // An MTF lot and an MTF sale in one book DO match here. Only closePosition
    // prices a funded position's accrued interest, so the caller (d0eda00's
    // lotFromNewRow / incomingFromParsed) must never pass them; 4.3.1 keeps that.
    expect(planLotCloses([lot({ id: 1, segment: "eq_mtf" })], [row({ key: "s", segment: "eq_mtf" })]).closes).toHaveLength(1);
    // A basis-unknown sale handed over AS a short lot would be covered by a buy
    // (invariant 6 says it must not be) — again, the caller's filter, not this one's.
    expect(
      planLotCloses(
        [lot({ id: 2, side: "short", qty: 40, price: 250, value: 10000 })],
        [row({ key: "b", side: "buy", qty: 40, price: 240, value: 9600 })],
      ).closes,
    ).toHaveLength(1);
  });
});
