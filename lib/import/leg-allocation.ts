/**
 * WHICH LEGS each paired position consumed, and how much of each (v4.6.0 W9).
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * `pairLegs` (pair-legs.ts) reports a position's quantities and money but not
 * the legs behind them. Two callers need exactly that:
 *
 *   - a tradebook's EXECUTIONS. The ladder a commit writes (`trade_legs`) must
 *     sum to the parent row on each side (invariant 5). Filtering a symbol's
 *     fills by the position's DATE WINDOW over-counts whenever one day-leg is
 *     split across two positions (ALKEM on the real Fyers file: parent 125,
 *     window 250) — so fills are assigned by the quantity FIFO actually took,
 *     and a fill FIFO split is SLICED pro rata by quantity at its own price.
 *   - a stated bill's HEADS. The Nuvama report bills per day-leg; a position's
 *     brokerage/STT/… are the heads of the legs it consumed, a split leg
 *     contributing each head × consumed qty ÷ leg qty.
 *
 * The walk below replays pair-legs' QUANTITY rule exactly — chronological
 * (date, buys before sells, file order within a side), a sell consumes the
 * same day's lots first then the oldest, and a pre-file opening lot sized by a
 * seedless first pass is the oldest of all. Positions are then matched to
 * allocations on (kind, quantities, dates); a position that finds none gets
 * `null` and the caller must say so rather than guess.
 */

import type { Leg, PairedPosition } from "./pair-legs";
import type { Execution } from "@/lib/engine/types";

export interface LegSlice {
  leg: Leg;
  qty: number;
}

export interface Allocation {
  kind: PairedPosition["kind"];
  buys: LegSlice[];
  sell: LegSlice | null;
  buyDate: string | null;
  sellDate: string | null;
  buyQty: number;
  sellQty: number;
}

function chronological(a: Leg, b: Leg): number {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  if (a.side === b.side) return 0;
  return a.side === "buy" ? -1 : 1;
}

/** One symbol's legs → the allocations, in pair-legs' output order (closed, opening sells, open). */
export function allocateSymbolLegs(legsIn: Leg[]): Allocation[] {
  const legs = [...legsIn].sort(chronological);
  type Lot = { leg: Leg | null; date: string; qty: number };
  const run = (openingQty: number): { out: Allocation[]; orphanQty: number } => {
    const lots: Lot[] = [];
    const byDate = new Map<string, Lot[]>();
    if (openingQty > 0) lots.push({ leg: null, date: "", qty: openingQty });
    const closed: Allocation[] = [];
    const orphans: Allocation[] = [];
    let orphanQty = 0;
    for (const leg of legs) {
      if (leg.side === "buy") {
        if (leg.qty > 0) {
          const lot = { leg, date: leg.date, qty: leg.qty };
          lots.push(lot);
          byDate.set(leg.date, [...(byDate.get(leg.date) ?? []), lot]);
        }
        continue;
      }
      let remaining = leg.qty;
      let openingTaken = 0;
      const consumed: LegSlice[] = [];
      const takeFrom = (lot: Lot) => {
        const take = Math.min(remaining, lot.qty);
        if (take <= 0) return;
        if (lot.leg) consumed.push({ leg: lot.leg, qty: take });
        else openingTaken += take;
        lot.qty -= take;
        remaining -= take;
      };
      for (const lot of byDate.get(leg.date) ?? []) if (remaining > 0 && lot.qty > 0) takeFrom(lot);
      for (const lot of lots) if (remaining > 0 && lot.qty > 0) takeFrom(lot);
      if (consumed.length > 0) {
        const matched = consumed.reduce((s, c) => s + c.qty, 0);
        closed.push({
          kind: "closed",
          buys: consumed,
          sell: { leg, qty: matched },
          buyDate: consumed.reduce((d, c) => (c.leg.date < d ? c.leg.date : d), consumed[0].leg.date),
          sellDate: leg.date,
          buyQty: matched,
          sellQty: matched,
        });
      }
      const unmatched = openingTaken + remaining;
      if (unmatched > 0) {
        orphanQty += remaining;
        orphans.push({ kind: "opening-sell", buys: [], sell: { leg, qty: unmatched }, buyDate: null, sellDate: leg.date, buyQty: 0, sellQty: unmatched });
      }
    }
    const open: Allocation[] = lots
      .filter((l) => l.leg && l.qty > 0)
      .map((l) => ({ kind: "open" as const, buys: [{ leg: l.leg!, qty: l.qty }], sell: null, buyDate: l.date, sellDate: null, buyQty: l.qty, sellQty: 0 }));
    return { out: [...closed, ...orphans, ...open], orphanQty };
  };
  const first = run(0);
  return first.orphanQty <= 0 ? first.out : run(first.orphanQty).out;
}

const EPS = 1e-9;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/**
 * Each position's allocation, by (kind, quantities, dates) — first unused
 * match. `null` where none matches (the caller states it; never guesses).
 */
export function matchAllocations(paired: PairedPosition[], allocs: Allocation[]): (Allocation | null)[] {
  const used = new Set<Allocation>();
  return paired.map((p) => {
    const a = allocs.find(
      (x) => !used.has(x) && x.kind === p.kind && same(x.buyQty, p.buyQty) && same(x.sellQty, p.sellQty)
        && x.buyDate === p.buyDate && x.sellDate === p.sellDate,
    );
    if (!a) return null;
    used.add(a);
    return a;
  });
}

/**
 * The executions of every allocation, taken from each leg's fills in TIME order
 * by the quantity the allocation consumed — a fill split between two positions
 * is sliced pro rata by quantity at its own price. Allocations are walked in
 * their own order (the order FIFO consumed them), so a leg's earlier fills go
 * to its earlier consumer. Σ executions per side = the allocation's quantity.
 */
export function executionsByAllocation(allocs: Allocation[], fillsOf: Map<Leg, Execution[]>): Map<Allocation, Execution[]> {
  const cursor = new Map<Leg, { i: number; used: number }>();
  const take = (slice: LegSlice): Execution[] => {
    const fills = fillsOf.get(slice.leg) ?? [];
    const c = cursor.get(slice.leg) ?? { i: 0, used: 0 };
    cursor.set(slice.leg, c);
    const out: Execution[] = [];
    let need = slice.qty;
    while (need > EPS && c.i < fills.length) {
      const f = fills[c.i];
      const avail = f.qty - c.used;
      const q = Math.min(need, avail);
      out.push(same(q, f.qty) ? f : { ...f, qty: q });
      need -= q;
      c.used += q;
      if (c.used >= f.qty - EPS) {
        c.i++;
        c.used = 0;
      }
    }
    return out;
  };
  const result = new Map<Allocation, Execution[]>();
  for (const a of allocs) {
    const ex = [...a.buys.flatMap(take), ...(a.sell ? take(a.sell) : [])];
    ex.sort((x, y) => `${x.date ?? ""} ${x.time ?? ""}`.localeCompare(`${y.date ?? ""} ${y.time ?? ""}`));
    result.set(a, ex);
  }
  return result;
}
