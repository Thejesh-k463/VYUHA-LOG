/**
 * WHICH ROWS ARE "REALISED" — the one place that rule is decided.
 *
 * ZERO DB and ZERO React imports (invariant 2): everything here is a pure
 * function over plain data. The server wrapper that feeds it the ladders is
 * `lib/queries/realised-rows.ts`.
 *
 * ── The defect this module exists to fix (v4.5.0 wave 3b-ii, P1) ───────────
 *
 * A partly-sold STAGED position (`trades.staged`, legs in `trade_legs`) is
 * `isOpen` on the parent row, because quantity is still open. Every realised
 * consumer — the tax base, the ITR export, /reports/itr, /reports/harvest,
 * /reports/advance-tax and the AIS sale side — filtered `!t.isOpen`, so the
 * fills already booked were in NO financial year at all. Worse, when the
 * ladder finally closed, the parent's aggregate landed WHOLE in the later FY:
 * a gain booked in March was filed a year late, and the AIS sale
 * consideration never matched the broker's statement for either year.
 *
 * The rule, per trade:
 *
 *   staged AND a ladder is known      -> ONE row per (exit fill × FIFO tranche
 *                                        it consumed), open OR closed. A
 *                                        CLOSED ladder is split too — folding
 *                                        only the open ones would count the
 *                                        same gain once as fills and again as
 *                                        the parent when it closes.
 *   not staged (or no legs) and closed -> the parent row, unchanged.
 *   otherwise (open, flat)             -> nothing.
 *
 * A FLAT row that is partly sold (`sellQty < buyQty`, `isOpen`) is NOT folded
 * in: it has no legs, so nothing says WHEN the sold part was sold beyond the
 * one `sellDate` the row states (design review item 17).
 *
 * ── How a fill is priced (invariants 4 and 5) ──────────────────────────────
 *
 * - The COST BASIS of a fill is the moving average in force when it was booked
 *   (`fill.avgCostAtExit`), NEVER the consumed tranche's own fill price —
 *   invariant 4's first rule. The tranche is used for the DATE only.
 * - The DATE of acquisition is the consumed entry leg's own trade date — FIFO
 *   quantity consumption, invariant 4's second rule. That is what fixes the
 *   holding period when one exit consumes tranches bought months apart.
 * - Entry-side charges are realised with the quantity they belong to
 *   (`leg.chargesTotal × take / leg.qty`), so a half-sold ladder deducts half
 *   of the first tranche's brokerage and not all of it.
 * - The whole-trade charge columns (`sttCtt`, `mtfInterest`, `pledgeCharges`)
 *   are apportioned by quantity. A NULL column stays null on every row —
 *   never 0 (tests/readers-follow-writers.test.ts: a null states nothing).
 * - For a CLOSED ladder the split RECONCILES to the parent to the paisa: the
 *   parent's stored aggregate is the target and the rounding remainder is
 *   pushed onto the last row, so invariant 5 still holds after the split.
 */

import { dayOf } from "@/lib/domain/trading-day";
import type { Leg, StagedPosition } from "@/lib/domain/staged";

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The parent-row fields the split reads or rewrites. All optional but `id` and
 * `isOpen`: the projections that use this (`TaxPageTrade`, `HarvestTrade`, the
 * whole `Trade`) each carry a different subset, and a field the parent does
 * not carry is never invented on the rows.
 */
export interface RealisedParent {
  id: number;
  isOpen: boolean;
  staged?: boolean | null;
  buyDate?: string | null;
  sellDate?: string | null;
  buyQty?: number;
  sellQty?: number;
  buyValue?: number;
  sellValue?: number;
  grossPnl?: number;
  chargesTotal?: number;
  netPnl?: number;
  sttCtt?: number | null;
  mtfInterest?: number | null;
  pledgeCharges?: number | null;
  /** PER SHARE in the schema, and left per share here — consumers multiply it
   *  by `buyQty`, which on a split row is the tranche quantity. */
  fmv31Jan2018?: number | null;
}

/** Traceability, so a split row can always be walked back to its two legs. */
export interface RealisedFillFields {
  /** The exit leg this row was booked from. Null on an unsplit parent row. */
  fillLegId: number | null;
  /** The entry leg (FIFO tranche) whose quantity it consumed. */
  entryLegId: number | null;
  /** The quantity this row realises. */
  realisedQty: number;
}

export type RealisedRow<T> = T & RealisedFillFields;

/** The money columns apportioned across the split rows. */
const MONEY_FIELDS = [
  "buyValue", "sellValue", "grossPnl", "chargesTotal", "netPnl",
  "sttCtt", "mtfInterest", "pledgeCharges",
] as const;
type MoneyField = (typeof MONEY_FIELDS)[number];

/**
 * Round a column to 2 dp and push the ROUNDING REMAINDER onto the last row, so
 * the rows sum to `target` exactly rather than to `target ± a few paise`.
 */
function settle(raw: number[], target: number): number[] {
  const out = raw.map(r2);
  if (out.length === 0) return out;
  const sum = out.reduce((s, v) => s + v, 0);
  out[out.length - 1] = r2(out[out.length - 1] + (r2(target) - r2(sum)));
  return out;
}

/**
 * ONE row per (exit fill × consumed FIFO tranche) for a staged ladder.
 *
 * NEVER throws: an inconsistent ladder (no fills, no consumed quantity) yields
 * an empty array, and the caller then treats the trade by the flat rule.
 */
export function splitStagedRow<T extends RealisedParent>(
  parent: T,
  legs: Leg[],
  position: StagedPosition,
): RealisedRow<T>[] {
  const entryById = new Map<number, Leg>();
  for (const l of legs) if (l.kind === "entry") entryById.set(l.id, l);

  const isLong = position.direction === "long";
  const totalEntryQty = position.totalEntryQty;

  interface Draft {
    fillLegId: number;
    entryLegId: number;
    take: number;
    buyDate: string | null;
    sellDate: string | null;
    raw: Record<MoneyField, number>;
  }
  const drafts: Draft[] = [];

  for (const fill of position.fills) {
    if (!(fill.qty > 0)) continue;
    for (const c of fill.consumed) {
      const take = c.qty;
      if (!(take > 0)) continue;
      const entry = entryById.get(c.legId);
      const share = take / fill.qty;
      // The entry leg's own charges, realised with the quantity consumed.
      const entryCharges =
        entry && entry.qty > 0 ? (entry.chargesTotal ?? 0) * (take / entry.qty) : 0;
      // On a SHORT the ladder's entries are the sales and the fills are the
      // covering buys — exactly how `parentAggregate` reports the same ladder.
      const costSide = take * fill.avgCostAtExit;
      const exitSide = take * fill.price;
      const gross = fill.grossPnl * share;
      const charges = fill.charges * share + entryCharges;
      /** A whole-trade column apportioned by quantity; null contributes 0 and
       *  is dropped entirely when the row is built. */
      const byQty = (v: number | null | undefined): number =>
        v == null || !(totalEntryQty > 0) ? 0 : v * (take / totalEntryQty);
      const entryDay = dayOf(entry?.tradeDate);
      const fillDay = dayOf(fill.tradeDate);

      drafts.push({
        fillLegId: fill.legId,
        entryLegId: c.legId,
        take,
        buyDate: (isLong ? entryDay : fillDay) ?? parent.buyDate ?? null,
        sellDate: (isLong ? fillDay : entryDay) ?? parent.sellDate ?? null,
        raw: {
          buyValue: isLong ? costSide : exitSide,
          sellValue: isLong ? exitSide : costSide,
          grossPnl: gross,
          chargesTotal: charges,
          netPnl: gross - charges,
          sttCtt: byQty(parent.sttCtt),
          mtfInterest: byQty(parent.mtfInterest),
          pledgeCharges: byQty(parent.pledgeCharges),
        },
      });
    }
  }
  if (drafts.length === 0) return [];

  // THE TARGET each column settles to. For a CLOSED ladder it is the parent's
  // own stored aggregate — invariant 5 says that row IS the truth of the
  // position, so the split reproduces it to the paisa rather than replacing it
  // with a re-derivation. For an OPEN ladder there is no parent figure to hit
  // (its charges include tranches still open), so the column settles to its
  // own exact sum and is <= the parent by construction.
  const closed = position.isClosed;
  const settled = {} as Record<MoneyField, number[]>;
  for (const f of MONEY_FIELDS) {
    const raw = drafts.map((d) => d.raw[f]);
    const parentVal = parent[f];
    const exact = raw.reduce((s, v) => s + v, 0);
    settled[f] = settle(raw, closed && parentVal != null ? parentVal : exact);
  }

  return drafts.map((d, i) => {
    const row = { ...parent } as unknown as Record<string, unknown>;
    row.isOpen = false;
    if ("buyDate" in parent) row.buyDate = d.buyDate;
    if ("sellDate" in parent) row.sellDate = d.sellDate;
    if ("buyQty" in parent) row.buyQty = d.take;
    if ("sellQty" in parent) row.sellQty = d.take;
    for (const f of MONEY_FIELDS) {
      // A null column on the parent states nothing, so it is never apportioned
      // into a 0 — the writer's rule survives the split.
      if (!(f in parent) || parent[f] == null) continue;
      row[f] = settled[f][i];
    }
    row.fillLegId = d.fillLegId;
    row.entryLegId = d.entryLegId;
    row.realisedQty = d.take;
    return row as unknown as RealisedRow<T>;
  });
}

export interface SplitDifference {
  field: MoneyField;
  /** The parent's stored column, or null when it carries none. */
  parent: number | null;
  /** What the split rows sum to. */
  rows: number;
  /** rows − parent. Zero on every field for a closed ladder. */
  diff: number;
}

/**
 * The per-field difference between a parent row and its split — pure, so a
 * test can pin "the fills sum to the parent" (design review item 17) without
 * re-implementing the apportionment.
 */
export function reconcileStagedSplit<T extends RealisedParent>(
  parent: T,
  rows: RealisedRow<T>[],
): SplitDifference[] {
  return MONEY_FIELDS.map((f) => {
    const p = parent[f] ?? null;
    const sum = r2(rows.reduce((s, r) => s + ((r[f] as number | null | undefined) ?? 0), 0));
    return { field: f, parent: p, rows: sum, diff: r2(sum - (p ?? 0)) };
  });
}

/** The ladder of one staged trade, as the server wrapper hands it over. */
export interface LadderInput {
  legs: Leg[];
  position: StagedPosition;
}

/**
 * The realised book: per-fill rows for every staged ladder that has one, the
 * parent row for every closed flat trade, and nothing for an open flat one.
 *
 * Row order follows the input order, and the fills of one trade follow the
 * ladder's own execution order — so a consumer's float summation order is
 * stable between renders.
 */
export function realisedRows<T extends RealisedParent>(
  trades: readonly T[],
  ladders: ReadonlyMap<number, LadderInput>,
): RealisedRow<T>[] {
  const out: RealisedRow<T>[] = [];
  for (const t of trades) {
    const ladder = t.staged ? ladders.get(t.id) : undefined;
    if (ladder) {
      const rows = splitStagedRow(t, ladder.legs, ladder.position);
      if (rows.length > 0) {
        out.push(...rows);
        continue;
      }
      // A staged row whose ladder books nothing realised falls through to the
      // flat rule below, so a closed one is still counted exactly once.
    }
    if (!t.isOpen) {
      out.push({ ...t, fillLegId: null, entryLegId: null, realisedQty: t.sellQty ?? t.buyQty ?? 0 });
    }
  }
  return out;
}
