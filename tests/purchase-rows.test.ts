import { describe, it, expect } from "vitest";
import { summarise, parentAggregate, type Direction, type Leg } from "@/lib/domain/staged";
import { purchaseRows, type LadderInput, type RealisedParent } from "@/lib/analytics/realised-rows";
import { fyOfDate } from "@/lib/analytics/ais";

/**
 * v4.6.0 W7 (D1) — THE AIS PURCHASE SIDE, one row per purchase leg. Pure.
 *
 * AIS SFT-18 states purchases per TRANSACTION, so a staged ladder bought across
 * two financial years must state a purchase in each, at the leg's own
 * consideration (qty × price, charges excluded), settling to the parent's
 * stored buyValue to the paisa. And — the R-1 guard — ONLY while the legs still
 * state the parent: a basis write or a corporate-action split rewrites the
 * parent alone, and splitting then would state a purchase in a SALE's year.
 *
 * Ladders are replayed by the product's own `summarise` / `parentAggregate`,
 * so the parent here is what `rebuildStagedTrade` stores.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (ns: number[]) => r2(ns.reduce((a, b) => a + b, 0));

type LegSpec = Omit<Leg, "id" | "seq">;
const entry = (qty: number, price: number, tradeDate: string): LegSpec => ({ kind: "entry", qty, price, tradeDate, chargesTotal: 7 });
const exit = (qty: number, price: number, tradeDate: string): LegSpec => ({ kind: "exit", qty, price, tradeDate, chargesTotal: 7 });
const ladder = (...legs: LegSpec[]): Leg[] => legs.map((l, i) => ({ ...l, id: i + 1, seq: i + 1 }));

function build(legs: Leg[], direction: Direction = "long", over: Partial<RealisedParent> = {}) {
  const position = summarise(legs, direction);
  const agg = parentAggregate(legs, direction);
  const parent = {
    id: 42,
    isOpen: agg.isOpen,
    staged: true,
    buyDate: agg.buyDate,
    sellDate: agg.sellDate,
    buyQty: agg.buyQty,
    sellQty: agg.sellQty,
    buyValue: agg.buyValue,
    sellValue: agg.sellValue,
    ...over,
  };
  const ladders = new Map<number, LadderInput>([[parent.id, { legs, position }]]);
  return { parent, ladders };
}

const fy = (d: string | null) => (d ? fyOfDate(d, 4) : null);

describe("purchaseRows — a staged ladder states each purchase in its own year", () => {
  it("a long ladder bought across two FYs: 1,200 in 2025-26 and 840 in 2026-27, summing to the parent", () => {
    const { parent, ladders } = build(
      ladder(entry(60, 20, "2026-03-20"), entry(40, 21, "2026-04-10"), exit(50, 25, "2026-05-01")),
    );
    expect(parent.buyValue, "the fixture's parent").toBe(2040);
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, fy(r.buyDate), r.buyQty, r.buyValue, r.entryLegId, r.purchaseQty])).toEqual([
      ["2026-03-20", "2025-26", 60, 1200, 1, 60],
      ["2026-04-10", "2026-27", 40, 840, 2, 40],
    ]);
    expect(sum(rows.map((r) => r.buyValue)), "Σ rows = parent.buyValue").toBe(parent.buyValue);
    // Consideration only — the exit leg is not a purchase, and no charge is in it.
    expect(rows.every((r) => r.id === 42 && r.staged === true)).toBe(true);
  });

  it("a three-leg float remainder settles to the parent to the paisa", () => {
    const { parent, ladders } = build(
      ladder(entry(1, 100.336, "2026-04-02"), entry(1, 100.336, "2026-04-03"), entry(1, 100.336, "2026-04-06")),
    );
    expect(parent.buyValue).toBe(301.01);
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => r.buyValue)).toEqual([100.34, 100.34, 100.33]);
    expect(sum(rows.map((r) => r.buyValue))).toBe(parent.buyValue);
  });

  it("a SHORT ladder's purchases are its covering exits", () => {
    const { parent, ladders } = build(
      ladder(entry(100, 50, "2026-01-10"), exit(60, 45, "2026-03-10"), exit(40, 44, "2026-05-11")),
      "short",
    );
    expect(parent.buyValue).toBe(4460);
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.buyQty, r.buyValue, r.entryLegId])).toEqual([
      ["2026-03-10", 60, 2700, 2],
      ["2026-05-11", 40, 1760, 3],
    ]);
  });

  it("a day-first leg date states its ISO day", () => {
    const { parent, ladders } = build(ladder(entry(10, 5, "2026-03-02"), entry(10, 6, "10-04-2026")));
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => r.buyDate)).toEqual(["2026-03-02", "2026-04-10"]);
  });

  it("a flat row — open or closed — is its own purchase, unchanged", () => {
    const flat = { id: 7, isOpen: true, staged: false, buyDate: "2026-02-01", buyQty: 10, buyValue: 1000 };
    const closed = { ...flat, id: 8, isOpen: false, sellDate: "2026-06-01", sellQty: 10, sellValue: 1100 };
    const rows = purchaseRows([flat, closed], new Map());
    expect(rows).toEqual([
      { ...flat, entryLegId: null, purchaseQty: 10 },
      { ...closed, entryLegId: null, purchaseQty: 10 },
    ]);
  });

  it("a staged row with no ladder, or a ladder with no legs, keeps the flat rule", () => {
    const parent = { id: 9, isOpen: true, staged: true, buyDate: "2026-02-01", buyQty: 10, buyValue: 1000 };
    expect(purchaseRows([parent], new Map())).toEqual([{ ...parent, entryLegId: null, purchaseQty: 10 }]);
    const empty = new Map<number, LadderInput>([[9, { legs: [], position: summarise([], "long") }]]);
    expect(purchaseRows([parent], empty)).toEqual([{ ...parent, entryLegId: null, purchaseQty: 10 }]);
  });
});

describe("purchaseRows — R-1: split ONLY while the legs still state the parent", () => {
  it("a basis write (two SELL executions as entries under a flat-long parent) is ONE row at the parent's value and date", () => {
    // setAcquisitionAction rewrote buyQty/buyValue/buyDate to the stated basis
    // (₹100 × 100 on 2025-01-15) and left the legs: the two sales, 50@300 and
    // 50@310, written as entries. The naive split would settle [15,000, 15,500]
    // to 10,000 as [15,000, −5,000] and state a 15,000 purchase in the SALE's FY.
    const legs = ladder(entry(50, 300, "2026-05-05"), entry(50, 310, "2026-06-05"));
    const { parent, ladders } = build(legs, "long", { buyQty: 100, buyValue: 10000, buyDate: "2025-01-15" });
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.buyQty, r.buyValue, r.entryLegId, r.purchaseQty])).toEqual([
      ["2025-01-15", 100, 10000, null, 100],
    ]);
  });

  it("a corporate-action split (parent rescaled, legs not) is ONE row at the parent", () => {
    const legs = ladder(entry(60, 20, "2026-03-20"), entry(40, 21, "2026-04-10"));
    const { parent, ladders } = build(legs, "long", { buyQty: 200 });
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.buyQty, r.buyValue, r.entryLegId])).toEqual([["2026-03-20", 200, 2040, null]]);
  });

  it("zero purchase legs under a parent with buyValue > 0: the purchase never disappears", () => {
    const legs = ladder(entry(100, 50, "2026-01-10"));
    const { parent, ladders } = build(legs, "short", { buyQty: 100, buyValue: 5000, buyDate: "2026-01-10" });
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.buyValue, r.entryLegId, r.purchaseQty])).toEqual([["2026-01-10", 5000, null, 100]]);
  });

  it("an UNREADABLE purchase-leg date is a guard failure: the parent row whole, never an invented year", () => {
    // `dayOf` hands an unreadable date back raw and `fyOfDate` would file it
    // under a year it made up; `normalizeDate` says null, and null refuses.
    const { parent, ladders } = build(ladder(entry(10, 5, "2026-03-02"), entry(10, 6, "garbage")));
    expect(parent.buyDate, "the fixture's parent").toBe("2026-03-02");
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.buyQty, r.buyValue, r.entryLegId, r.purchaseQty])).toEqual([
      ["2026-03-02", 20, 110, null, 20],
    ]);
  });

  it("a DD-MM-YYYY purchase-leg date reads as its ISO day", () => {
    const { parent, ladders } = build(ladder(entry(10, 5, "2026-03-02"), entry(10, 6, "20-04-2026")));
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, r.entryLegId])).toEqual([["2026-03-02", 1], ["2026-04-20", 2]]);
  });

  it("the DATE condition: legs that sum to the parent but do not state its buyDate are ONE row at the parent", () => {
    // The skeptic's probe: a flat-long basis write (100 @ ₹100 on 2025-01-10)
    // over two SELL executions stored as entries, 50@100 on 2026-05-01 and
    // 50@100 on 2026-05-02 — Σ qty = 100 and Σ value = 10,000 = parent.buyValue,
    // so the qty and value conditions both pass. Only the date says the legs are
    // not this parent's purchases: parentAggregate would write 2026-05-01.
    const legs = ladder(entry(50, 100, "2026-05-01"), entry(50, 100, "2026-05-02"));
    const { parent, ladders } = build(legs, "long", { buyQty: 100, buyValue: 10000, buyDate: "2025-01-10" });
    const rows = purchaseRows([parent], ladders);
    expect(rows.map((r) => [r.buyDate, fy(r.buyDate), r.buyQty, r.buyValue, r.entryLegId])).toEqual([
      ["2025-01-10", "2024-25", 100, 10000, null],
    ]);
  });

  it("the DATE condition on a SHORT ladder reads the LAST cover (parentAggregate's buyDate there)", () => {
    const legs = ladder(entry(100, 50, "2026-01-10"), exit(60, 45, "2026-03-10"), exit(40, 44, "2026-05-11"));
    const ok = build(legs, "short");
    expect(ok.parent.buyDate, "the fixture's parent").toBe("2026-05-11");
    expect(purchaseRows([ok.parent], ok.ladders)).toHaveLength(2);
    const moved = build(legs, "short", { buyDate: "2026-03-10" });
    expect(purchaseRows([moved.parent], moved.ladders).map((r) => [r.buyDate, r.buyValue, r.entryLegId])).toEqual([
      ["2026-03-10", 4460, null],
    ]);
  });
});
