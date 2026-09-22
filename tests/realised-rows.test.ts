import { describe, it, expect } from "vitest";
import { summarise, parentAggregate, type Direction, type Leg } from "@/lib/domain/staged";
import {
  realisedRows,
  reconcileStagedSplit,
  splitStagedRow,
  type LadderInput,
  type RealisedParent,
} from "@/lib/analytics/realised-rows";

/**
 * THE REALISED BOOK (v4.5.0 wave 3b-ii, P1) — pure, no database.
 *
 * `lib/analytics/realised-rows.ts` decides WHICH rows are realised and, for a
 * staged ladder, splits the parent into one row per (exit fill × consumed FIFO
 * tranche). The defect it fixes: a partly-sold STAGED position is `isOpen` on
 * the parent, so every realised consumer skipped its booked fills entirely —
 * and then filed the whole aggregate in the FY the ladder finally closed in.
 *
 * WHAT THIS FILE PINS, and why each is stated as arithmetic on the fixture's
 * own numbers rather than re-derived from the module under test:
 *
 *   (a) a CLOSED ladder reconciles to the parent's stored aggregate on all
 *       eight money fields, to the paisa (invariant 5) — including a ladder
 *       engineered so naive 2-dp rounding would be a paisa short;
 *   (b) an OPEN ladder books exactly the realised half, and the difference is
 *       what the still-open tranches carry;
 *   (c) one fill consuming two tranches bought on different dates takes the
 *       DATE from the tranche and the PRICE from the moving average
 *       (invariant 4) — the two rules are independent;
 *   (d) a null whole-trade charge column stays null on every row;
 *   (e) a SHORT ladder mirrors the two dates and keeps the gross sign;
 *   (f) the three-way rule of `realisedRows`;
 *   (g) `fmv31Jan2018` stays PER SHARE;
 *   (h) every row names its parent and its two legs.
 *
 * The ladders are replayed by the product's OWN `summarise` (the FIFO and
 * moving-average engine, invariant 4) and collapsed by its own
 * `parentAggregate`, so the fixtures cannot drift away from what
 * `rebuildStagedTrade` stores — only the money literals are this file's.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (ns: number[]) => r2(ns.reduce((a, b) => a + b, 0));

type LegSpec = Omit<Leg, "id" | "seq">;
const entry = (qty: number, price: number, tradeDate: string, chargesTotal = 0): LegSpec =>
  ({ kind: "entry", qty, price, tradeDate, chargesTotal });
const exit = (qty: number, price: number, tradeDate: string, chargesTotal = 0): LegSpec =>
  ({ kind: "exit", qty, price, tradeDate, chargesTotal });

/** Ids and seqs follow the array order, which is the ladder's execution order. */
const ladder = (...legs: LegSpec[]): Leg[] => legs.map((l, i) => ({ ...l, id: i + 1, seq: i + 1 }));

/**
 * The parent row a ladder collapses into — the SAME collapse
 * `lib/queries/staged.ts#rebuildStagedTrade` performs (step 4): the aggregate
 * from `parentAggregate`, the realised gross from the replay, and charges
 * SUMMED OVER EVERY LEG (a position filled in five tranches really does pay
 * five lots of brokerage). Stating it here rather than by hand is what makes
 * "the split reconciles to the parent" a claim about the product.
 */
function build(legs: Leg[], direction: Direction = "long", over: Partial<RealisedParent> = {}) {
  const position = summarise(legs, direction);
  const agg = parentAggregate(legs, direction);
  const chargesTotal = r2(legs.reduce((s, l) => s + (l.chargesTotal ?? 0), 0));
  const grossPnl = r2(position.realisedGross);
  const parent: RealisedParent & { id: number } = {
    id: 42,
    isOpen: agg.isOpen,
    staged: true,
    buyDate: agg.buyDate,
    sellDate: agg.sellDate,
    buyQty: agg.buyQty,
    sellQty: agg.sellQty,
    buyValue: agg.buyValue,
    sellValue: agg.sellValue,
    grossPnl,
    chargesTotal,
    netPnl: r2(grossPnl - chargesTotal),
    sttCtt: null,
    mtfInterest: null,
    pledgeCharges: null,
    fmv31Jan2018: null,
    ...over,
  };
  return { legs, position, parent, rows: splitStagedRow(parent, legs, position) };
}

// ── (a) a CLOSED 3-entry / 2-exit long ladder ───────────────────────────────

/**
 * e1  100 @ 10  2025-04-10  charges 12
 * e2   50 @ 12  2025-06-20  charges  6
 * x1  120 @ 15  2025-09-15  charges  9   <- FY 2025-26
 * e3   50 @ 14  2026-02-05  charges  7
 * x2   80 @ 20  2026-05-10  charges  8   <- FY 2026-27
 *
 * Moving average at x1: (100x10 + 50x12) / 150 = 10.666..  -> 10.67 stored
 *   gross  (15 - 10.6667) x 120 = 520.00 ; FIFO takes e1's 100 and 20 of e2's 50
 * After x1 the remaining 30 still cost 10.6667; e3 lifts the basis to
 *   (30x10.6667 + 50x14) / 80 = 12.75
 *   gross  (20 - 12.75) x 80 = 580.00 ; FIFO takes e2's last 30 and all of e3
 *
 * parent: buyValue 2300, sellValue 3400, gross 1100, charges 42, net 1058.
 */
const CLOSED = ladder(
  entry(100, 10, "2025-04-10", 12),
  entry(50, 12, "2025-06-20", 6),
  exit(120, 15, "2025-09-15", 9),
  entry(50, 14, "2026-02-05", 7),
  exit(80, 20, "2026-05-10", 8),
);

describe("a closed ladder splits into its fills and reconciles to the parent", () => {
  const { parent, rows } = build(CLOSED);

  it("states the parent the collapse states", () => {
    expect([parent.isOpen, parent.buyQty, parent.sellQty], "200 in, 200 out — closed").toEqual([false, 200, 200]);
    expect([parent.buyValue, parent.sellValue, parent.grossPnl, parent.chargesTotal, parent.netPnl])
      .toEqual([2300, 3400, 1100, 42, 1058]);
  });

  it("emits one row per (fill x consumed tranche), with the tranche's own date", () => {
    expect(rows.length, "x1 consumed two tranches, x2 the other two").toBe(4);
    expect(rows.map((r) => [r.realisedQty, r.buyDate, r.sellDate])).toEqual([
      [100, "2025-04-10", "2025-09-15"], // x1 x e1
      [20, "2025-06-20", "2025-09-15"], //  x1 x e2
      [30, "2025-06-20", "2026-05-10"], //  x2 x e2 — the SAME tranche, a LATER FY
      [50, "2026-02-05", "2026-05-10"], //  x2 x e3
    ]);
    // THE defect this wave fixes: 520.00 of the 1,100 belongs to FY 2025-26 and
    // never used to be filed in any year at all.
    expect(sum(rows.filter((r) => r.sellDate === "2025-09-15").map((r) => r.grossPnl!)))
      .toBe(520);
  });

  it("reconciles to the parent's stored aggregate on all eight money fields", () => {
    expect(reconcileStagedSplit(parent, rows).map((d) => [d.field, d.diff])).toEqual([
      ["buyValue", 0], ["sellValue", 0], ["grossPnl", 0], ["chargesTotal", 0], ["netPnl", 0],
      // A null parent column states nothing, so its rows are null and its sum
      // is 0 against a parent of null — diff 0, not an invented apportionment.
      ["sttCtt", 0], ["mtfInterest", 0], ["pledgeCharges", 0],
    ]);
  });

  it("sums exactly, with the rounding remainder on the last row", () => {
    // Raw buyValue = 120 x 10.67 + 30 x 12.75 + 50 x 12.75 = 1280.40 + 1020.00
    // = 2300.40, because `avgCostAtExit` is stored to the paisa. The remainder
    // (-0.40) lands on the LAST row, so the column sums to the parent's 2300
    // rather than to 2300.40 — the last row reads 637.10, not 50 x 12.75.
    expect(rows.map((r) => r.buyValue)).toEqual([1067, 213.4, 382.5, 637.1]);
    expect(sum(rows.map((r) => r.buyValue!))).toBe(parent.buyValue);
    expect(rows.map((r) => r.sellValue)).toEqual([1500, 300, 600, 1000]);
    // gross: 520 x 100/120, 520 x 20/120, 580 x 30/80, 580 x 50/80
    expect(rows.map((r) => r.grossPnl)).toEqual([433.33, 86.67, 217.5, 362.5]);
    // charges: the fill's own share by quantity PLUS the consumed tranche's
    //   x1 x e1  9 x 100/120 + 12 x 100/100 = 19.50
    //   x1 x e2  9 x  20/120 +  6 x  20/50  =  3.90
    //   x2 x e2  8 x  30/80  +  6 x  30/50  =  6.60
    //   x2 x e3  8 x  50/80  +  7 x  50/50  = 12.00
    expect(rows.map((r) => r.chargesTotal)).toEqual([19.5, 3.9, 6.6, 12]);
    expect(rows.map((r) => r.netPnl)).toEqual([413.83, 82.77, 210.9, 350.5]);
    expect(sum(rows.map((r) => r.netPnl!))).toBe(parent.netPnl);
  });

  it("marks every row realised and leaves the parent's own isOpen alone", () => {
    expect(rows.map((r) => r.isOpen)).toEqual([false, false, false, false]);
  });

  // (h)
  it("names the parent and both legs on every row", () => {
    expect(rows.map((r) => [r.id, r.fillLegId, r.entryLegId])).toEqual([
      [42, 3, 1], [42, 3, 2], [42, 5, 2], [42, 5, 4],
    ]);
  });

  // (g) — fmv31Jan2018 is PER SHARE in the schema and stays per share here.
  it("keeps fmv31Jan2018 per share, so fmv x buyQty sums to the parent's", () => {
    const { parent: p, rows: rs } = build(CLOSED, "long", { fmv31Jan2018: 7.5 });
    expect(rs.map((r) => r.fmv31Jan2018), "not apportioned — a price is a level, not money")
      .toEqual([7.5, 7.5, 7.5, 7.5]);
    expect(sum(rs.map((r) => r.fmv31Jan2018! * r.buyQty!)), "7.5 x 200")
      .toBe(r2(p.fmv31Jan2018! * p.buyQty!));
  });
});

describe("the last row carries the rounding remainder a naive round would lose", () => {
  // Three tranches of 1, one fill of 3, and a gross of exactly 0.10. Each row's
  // raw share is 0.0333..., which rounds to 0.03 — three of them sum to 0.09,
  // a paisa short of the parent's 0.10. `settle` puts the missing paisa on the
  // last row instead of letting the column drift.
  const legs = ladder(
    entry(1, 100, "2025-04-01"),
    entry(1, 100, "2025-04-02"),
    entry(1, 100, "2025-04-03"),
    exit(3, 100 + 0.1 / 3, "2025-05-01"),
  );
  const { parent, rows } = build(legs);

  it("is a paisa short if each row is simply rounded", () => {
    expect(parent.grossPnl, "(100.03333 - 100) x 3").toBe(0.1);
    expect(sum([r2(0.1 / 3), r2(0.1 / 3), r2(0.1 / 3)]), "the naive answer").toBe(0.09);
  });

  it("but the split sums to the parent exactly", () => {
    expect(rows.map((r) => r.grossPnl)).toEqual([0.03, 0.03, 0.04]);
    expect(sum(rows.map((r) => r.grossPnl!))).toBe(parent.grossPnl);
    expect(reconcileStagedSplit(parent, rows).every((d) => d.diff === 0), "every field, diff 0").toBe(true);
  });
});

// ── (b) an OPEN ladder ──────────────────────────────────────────────────────

describe("an open ladder books the realised half, and only that", () => {
  /**
   * e1 100 @ 10  2025-04-10  charges 12
   * e2  50 @ 13  2025-06-20  charges  6
   * x1 120 @ 15  2025-09-15  charges  9
   *
   * Moving average at x1: (1000 + 650) / 150 = 11.00 exactly.
   *   gross (15 - 11) x 120 = 480 ; FIFO takes e1's 100 and 20 of e2's 50.
   * 30 shares remain open, still costing 11.00 -> 330 invested.
   */
  const legs = ladder(
    entry(100, 10, "2025-04-10", 12),
    entry(50, 13, "2025-06-20", 6),
    exit(120, 15, "2025-09-15", 9),
  );
  const { parent, position, rows } = build(legs);

  it("the parent is OPEN and states the WHOLE position", () => {
    expect([parent.isOpen, parent.buyQty, parent.sellQty]).toEqual([true, 150, 120]);
    expect([parent.buyValue, parent.sellValue, parent.grossPnl, parent.chargesTotal, parent.netPnl])
      .toEqual([1650, 1800, 480, 27, 453]);
  });

  it("books the realised gross whole, and the realised sale whole", () => {
    expect(sum(rows.map((r) => r.grossPnl!)), "every fill is realised, so gross is the parent's")
      .toBe(parent.grossPnl);
    expect(sum(rows.map((r) => r.sellValue!)), "120 of the 120 sold").toBe(parent.sellValue);
  });

  it("books only the cost and the charges the sold quantity carries", () => {
    // 120 x 11.00 = 1320 of the parent's 1650 — the other 330 is the 30 shares
    // still open at their unchanged moving-average basis (`invested`).
    expect(sum(rows.map((r) => r.buyValue!))).toBe(1320);
    expect(r2(parent.buyValue! - sum(rows.map((r) => r.buyValue!))), "what the open tranches still carry")
      .toBe(r2(position.invested));
    // charges: 9 x 100/120 + 12 = 19.50, and 9 x 20/120 + 6 x 20/50 = 3.90.
    expect(sum(rows.map((r) => r.chargesTotal!))).toBe(23.4);
  });

  it("nets MORE than the open parent states, by exactly the unsold tranche's charges", () => {
    // The parent deducts all 27 of charges against a sale of 120 of 150 — this
    // is the A1STG shape in tests/helpers/oracle-book.ts (196.67, not 194.00).
    // e2's unsold 30 still carry 6 x 30/50 = 3.60, which realises when they sell.
    expect(sum(rows.map((r) => r.netPnl!))).toBe(456.6);
    expect(r2(sum(rows.map((r) => r.netPnl!)) - parent.netPnl!)).toBe(3.6);
    expect(r2(parent.chargesTotal! - sum(rows.map((r) => r.chargesTotal!)))).toBe(3.6);
  });

  it("does not pretend to reconcile — an open parent is not the target", () => {
    const diff = new Map(reconcileStagedSplit(parent, rows).map((d) => [d.field, d.diff]));
    expect([diff.get("grossPnl"), diff.get("sellValue")], "realised in full").toEqual([0, 0]);
    expect(diff.get("buyValue"), "-330: the open tranches' basis").toBe(-330);
    expect(diff.get("chargesTotal"), "-3.60: their charges").toBe(-3.6);
    expect(diff.get("netPnl"), "+3.60: those charges are not this sale's").toBe(3.6);
  });
});

// ── (c) one fill, two tranches: the DATE is the tranche's, the PRICE is not ──

describe("a fill that consumes two tranches takes the date from each and the basis from neither", () => {
  /**
   * e1 100 @ 10  2025-04-10   e2 100 @ 20  2025-07-15   x1 150 @ 30  2025-11-20
   * Moving average at x1: (1000 + 2000) / 200 = 15.00, so BOTH rows cost 15.00
   * a share — invariant 4's first rule. FIFO gives e1's 100 and 50 of e2, so the
   * two rows are acquired on two different days — invariant 4's second rule.
   */
  const legs = ladder(
    entry(100, 10, "2025-04-10"),
    entry(100, 20, "2025-07-15"),
    exit(150, 30, "2025-11-20"),
  );
  const { rows } = build(legs);

  it("emits two rows with the two entry dates", () => {
    expect(rows.map((r) => [r.realisedQty, r.buyDate, r.sellDate])).toEqual([
      [100, "2025-04-10", "2025-11-20"],
      [50, "2025-07-15", "2025-11-20"],
    ]);
  });

  it("prices both rows at the moving average, NEVER at the tranche's own fill price", () => {
    expect(rows.map((r) => r.buyValue), "100 x 15 and 50 x 15").toEqual([1500, 750]);
    expect(sum(rows.map((r) => r.buyValue!)), "= qty x avgCostAtExit").toBe(150 * 15);
    // The wrong answer, spelled out so a future "fix" has to argue with it:
    // 100 x 10 + 50 x 20 = 2000, which would report a 1,000 larger gain on the
    // older lot and a 250 smaller one on the newer.
    expect(sum(rows.map((r) => r.buyValue!))).not.toBe(100 * 10 + 50 * 20);
  });
});

// ── (d) the whole-trade charge columns ──────────────────────────────────────

describe("a null whole-trade charge column stays null; a stated one apportions by quantity", () => {
  it("null in, null out — on every row", () => {
    const { rows } = build(CLOSED, "long", { sttCtt: null, mtfInterest: null, pledgeCharges: null });
    expect(rows.map((r) => [r.sttCtt, r.mtfInterest, r.pledgeCharges])).toEqual([
      [null, null, null], [null, null, null], [null, null, null], [null, null, null],
    ]);
  });

  it("apportions a stated column by take / totalEntryQty and sums to the parent", () => {
    // totalEntryQty is 200; the takes are 100, 20, 30, 50.
    const { parent, rows } = build(CLOSED, "long", { sttCtt: 3.6, mtfInterest: null, pledgeCharges: 1.2 });
    expect(rows.map((r) => r.sttCtt), "3.6 x 100/200, 20/200, 30/200, 50/200").toEqual([1.8, 0.36, 0.54, 0.9]);
    expect(rows.map((r) => r.pledgeCharges), "1.2 x the same shares").toEqual([0.6, 0.12, 0.18, 0.3]);
    expect(rows.map((r) => r.mtfInterest), "the null one is untouched beside them")
      .toEqual([null, null, null, null]);
    expect([sum(rows.map((r) => r.sttCtt!)), sum(rows.map((r) => r.pledgeCharges!))])
      .toEqual([parent.sttCtt, parent.pledgeCharges]);
    const diff = new Map(reconcileStagedSplit(parent, rows).map((d) => [d.field, d.diff]));
    expect([diff.get("sttCtt"), diff.get("pledgeCharges"), diff.get("mtfInterest")]).toEqual([0, 0, 0]);
  });
});

// ── (e) a SHORT ladder ──────────────────────────────────────────────────────

describe("a short ladder mirrors the two dates and keeps the gross sign", () => {
  /**
   * The entries are the SALES and the fills are the covering BUYS.
   * e1 60 @ 50  2025-05-02 charges 6 ; e2 40 @ 55 2025-06-02 charges 4
   * x1 100 @ 40 2025-08-04 charges 8
   * Moving average at x1: (3000 + 2200) / 100 = 52.00
   *   gross (52 - 40) x 100 = 1200, charges 18, net 1182.
   */
  const legs = ladder(
    entry(60, 50, "2025-05-02", 6),
    entry(40, 55, "2025-06-02", 4),
    exit(100, 40, "2025-08-04", 8),
  );
  const { parent, rows } = build(legs, "short");

  it("the parent reads buy = the cover, sell = the short sale", () => {
    expect([parent.buyDate, parent.sellDate], "bought back after it was sold")
      .toEqual(["2025-08-04", "2025-05-02"]);
    expect([parent.buyValue, parent.sellValue, parent.grossPnl, parent.chargesTotal, parent.netPnl])
      .toEqual([4000, 5200, 1200, 18, 1182]);
  });

  it("mirrors the dates on every row: the fill is the purchase, the tranche the sale", () => {
    expect(rows.map((r) => [r.realisedQty, r.buyDate, r.sellDate])).toEqual([
      [60, "2025-08-04", "2025-05-02"],
      [40, "2025-08-04", "2025-06-02"],
    ]);
  });

  it("keeps the sign and reconciles", () => {
    expect(rows.map((r) => [r.buyValue, r.sellValue, r.grossPnl])).toEqual([
      [2400, 3120, 720], // 60 x 40 bought back, 60 x 52 sold, +720
      [1600, 2080, 480],
    ]);
    expect(rows.every((r) => r.grossPnl! > 0), "a short covered lower is a gain").toBe(true);
    expect(reconcileStagedSplit(parent, rows).map((d) => d.diff)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("a short covered HIGHER books a loss on every row", () => {
    const losing = ladder(entry(100, 40, "2025-05-02", 5), exit(100, 50, "2025-08-04", 5));
    const { parent: p, rows: rs } = build(losing, "short");
    expect([p.grossPnl, p.netPnl]).toEqual([-1000, -1010]);
    expect(rs.map((r) => [r.grossPnl, r.netPnl])).toEqual([[-1000, -1010]]);
    expect(reconcileStagedSplit(p, rs).map((d) => d.diff)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// ── (f) the three-way rule ──────────────────────────────────────────────────

describe("realisedRows: staged+ladder -> fills, flat closed -> the parent, flat open -> nothing", () => {
  const openLadder = ladder(
    entry(100, 10, "2025-04-10", 12),
    entry(50, 13, "2025-06-20", 6),
    exit(120, 15, "2025-09-15", 9),
  );
  const laddersFor = (id: number, legs: Leg[], direction: Direction = "long"): Map<number, LadderInput> =>
    new Map([[id, { legs, position: summarise(legs, direction) }]]);

  const flatClosed: RealisedParent & { id: number; symbol: string } = {
    id: 7, symbol: "FLAT", isOpen: false, staged: false,
    buyDate: "2025-04-01", sellDate: "2025-09-01", buyQty: 10, sellQty: 10,
    buyValue: 1000, sellValue: 1500, grossPnl: 500, chargesTotal: 10, netPnl: 490,
    sttCtt: null, mtfInterest: null, pledgeCharges: null,
  };
  const flatPartlySold = { ...flatClosed, id: 8, symbol: "PART", isOpen: true, sellQty: 6, sellValue: 900 };

  it("splits a staged ladder that is still OPEN — the fills are already booked", () => {
    const parent = { ...build(openLadder).parent, id: 3 };
    const out = realisedRows([parent], laddersFor(3, openLadder));
    expect(out.length, "one row per (fill x tranche), on an open parent").toBe(2);
    expect(out.every((r) => r.isOpen === false), "each row is a realised row").toBe(true);
  });

  it("splits a CLOSED ladder too — folding only the open ones would double count", () => {
    const parent = { ...build(CLOSED).parent, id: 3 };
    const out = realisedRows([parent], laddersFor(3, CLOSED));
    expect(out.length).toBe(4);
    expect(out.map((r) => r.fillLegId), "never the parent row beside them").toEqual([3, 3, 5, 5]);
  });

  it("returns a flat CLOSED trade untouched, field for field", () => {
    const [row] = realisedRows([flatClosed], new Map());
    const { fillLegId, entryLegId, realisedQty, ...rest } = row;
    expect(rest, "not re-derived, not re-rounded — the same row").toEqual(flatClosed);
    expect([fillLegId, entryLegId, realisedQty], "no legs behind it, and the whole sale").toEqual([null, null, 10]);
  });

  it("returns NOTHING for a flat, partly sold trade", () => {
    // Design review item 17: it has no legs, so nothing says WHEN the sold part
    // was sold beyond the one sellDate the row states. It is not folded in.
    expect(realisedRows([flatPartlySold], new Map())).toEqual([]);
  });

  it("falls back to the flat rule for a staged row with NO ladder", () => {
    const stagedClosedNoLegs = { ...flatClosed, id: 9, staged: true };
    const stagedOpenNoLegs = { ...flatPartlySold, id: 10, staged: true };
    const out = realisedRows([stagedClosedNoLegs, stagedOpenNoLegs], new Map());
    expect(out.map((r) => r.id), "the closed one counts once; the open one not at all").toEqual([9]);
    expect([out[0].fillLegId, out[0].entryLegId]).toEqual([null, null]);
  });

  it("falls back to the flat rule for a staged ladder that books nothing", () => {
    // A ladder with entries and no exit realises nothing, so an inconsistent
    // staged row cannot vanish from a CLOSED book by having bad legs.
    const entriesOnly = ladder(entry(100, 10, "2025-04-10", 12));
    const closedButLegless = { ...flatClosed, id: 11, staged: true };
    const out = realisedRows([closedButLegless], laddersFor(11, entriesOnly));
    expect(out.map((r) => [r.id, r.fillLegId, r.netPnl])).toEqual([[11, null, 490]]);
  });

  it("keeps the input order, and the ladder's own execution order within a trade", () => {
    const staged = { ...build(CLOSED).parent, id: 3 };
    const out = realisedRows([flatClosed, staged, flatPartlySold], laddersFor(3, CLOSED));
    expect(out.map((r) => [r.id, r.realisedQty])).toEqual([
      [7, 10], [3, 100], [3, 20], [3, 30], [3, 50],
    ]);
  });

  it("counts a staged sale ONCE — the fills, or the parent, never both", () => {
    const staged = { ...build(CLOSED).parent, id: 3 };
    const out = realisedRows([staged], laddersFor(3, CLOSED));
    expect(sum(out.map((r) => r.netPnl!)), "the parent's own 1058, split four ways").toBe(1058);
    expect(sum(out.map((r) => r.sellValue!)), "and its 3400 of sale consideration").toBe(3400);
  });
});
