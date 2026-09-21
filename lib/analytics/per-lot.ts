// v4.4.0 D3 — PER-LOT economics for F&O (PURE, no DB/React).
//
// A derivatives book states its P&L per TRADE, which is a number nobody sizes
// with: contracts trade in lots, and the lot changed twice in 2025. "₹3,100 per
// trade" says nothing until you know whether that trade was one lot or eleven.
//
// Two honesty rules, both invariant 6 (never fabricate a denominator):
//
//  1. ALL OR DASH. If ANY row in the population cannot be resolved to a whole
//     number of lots, the whole line is "—" plus "lot size unknown on k of N".
//     A per-lot figure computed over the subset we happen to know is a
//     different book from the one the headline states.
//  2. NO UNDATED LOT. The bundled index lots speak for INDEX_LOTS_AS_OF
//     (2026-01-01) and nothing earlier: NIFTY traded in 75s before Nov-2024 and
//     50s before that, so applying 65 to a Dec-2025 expiry manufactures lots
//     that never existed. An earlier expiry with no stored `lot_size` is
//     UNRESOLVED, and the line dashes.
//
// THE BLIND SPOT, stated rather than hidden: the wrong-lot guard is
// `qty % lot !== 0`, which cannot catch a quantity that divides by BOTH the
// right lot and a wrong one — 975 is 15 × 65 and 13 × 75, so a Dec-2025 NIFTY
// row carrying an explicit (wrong) lot_size of 65 passes the guard and reports
// 15 lots. Any common multiple of two candidate lots is invisible here; only a
// dated lot table per expiry closes it, and we do not ship one. The guard
// catches the far commoner case (a lot that simply does not divide) and the
// dated gate above catches the rest of the pre-2026 book.

import { INDEX_UNDERLYINGS } from "@/lib/domain/constants";
import { INDEX_LOTS_AS_OF, resolveIndexLot, type IndexUnderlying } from "@/lib/domain/index-contracts";

const INDEX_UNDERLYINGS_SET: ReadonlySet<string> = new Set(INDEX_UNDERLYINGS);

export interface PerLotTrade {
  /** Stored market lot on the row (`trades.lot_size`). The user's own number wins. */
  lotSize: number | null;
  /** Underlying ticker, upper-cased by the caller. */
  symbol: string;
  /** Contract expiry (ISO). Null on a row that carries none — unresolvable. */
  expiry: string | null;
  buyQty: number | null;
  sellQty: number | null;
  netPnl: number;
  /** The R denominator stored on the row (₹). Only rows carrying an R are averaged. */
  riskAmount: number | null;
  rMultiple: number | null;
}

/** One row's lot resolution. Every figure names its source AND the date it speaks for. */
export interface LotResolution {
  /** Market lot used. */
  lot: number;
  /** Whole lots traded: max(buyQty, sellQty) ÷ lot. */
  lots: number;
  source: "trade" | "instruments" | "bundled";
  /** ISO date the source speaks for; null for a number stored on the trade itself. */
  asOf: string | null;
}

/** The user's own fo_mktlots upload, keyed by underlying. */
export type InstrumentLotMap = Map<string, { lotSize: number | null; asOf?: string | null }>;

/**
 * Lots on one row, or null when the book cannot say.
 *
 * Chain: `trades.lot_size` → the dated index table (instruments upload, then
 * the bundled snapshot) for an expiry on or after INDEX_LOTS_AS_OF → null.
 */
export function lotsOf(t: PerLotTrade, instruments?: InstrumentLotMap): LotResolution | null {
  const qty = Math.max(t.buyQty ?? 0, t.sellQty ?? 0);
  if (!(qty > 0)) return null;

  let lot: number | null = null;
  let source: LotResolution["source"] = "trade";
  let asOf: string | null = null;

  if (t.lotSize != null && t.lotSize > 0) {
    lot = t.lotSize;
  } else {
    const sym = t.symbol.trim().toUpperCase();
    // The dated gate: no expiry, or an expiry BEFORE the snapshot speaks for, and
    // we refuse rather than apply today's lot to yesterday's contract.
    if (!INDEX_UNDERLYINGS_SET.has(sym) || t.expiry == null || t.expiry < INDEX_LOTS_AS_OF) return null;
    const row = instruments?.get(sym);
    // The upload beats the bundle only when it speaks for a date at least as
    // recent — an older upload is an older fact, not a better one.
    const usable = row && row.lotSize != null && row.lotSize > 0 && (row.asOf ?? "") >= INDEX_LOTS_AS_OF ? row : null;
    const r = resolveIndexLot(sym as IndexUnderlying, usable);
    lot = r.lot;
    source = r.source;
    asOf = r.asOf || INDEX_LOTS_AS_OF;
  }

  if (lot == null || lot <= 0) return null;
  // Wrong-lot guard (see the blind spot above): a quantity that is not a whole
  // number of lots means the lot is wrong, not that the trade was fractional.
  if (qty % lot !== 0) return null;
  return { lot, lots: qty / lot, source, asOf };
}

export interface PerLotAggregate {
  /** Rows in the population. */
  total: number;
  /** Rows whose lots could not be resolved. > 0 ⇒ every figure here is null. */
  unknown: number;
  /** Σ lots over the population; null when `unknown` > 0. */
  lots: number | null;
  /** Σ net P&L ÷ Σ lots; null when unresolved or no lots. */
  expectancyPerLot: number | null;
  /** Σ stored risk ÷ Σ lots, over the rows carrying an R — "1R = ₹X per lot".
   *  Null when no row in the population carries an R (invariant 6). */
  rupeesPerLotR: number | null;
  /** The distinct lot sources in play, each with the date it speaks for. */
  sources: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate over the SAME population the headline was taken over — the caller
 * passes the priced, closed F&O rows and nothing else. Nothing is re-priced:
 * this divides the STORED net and the STORED risk (D1).
 */
export function perLotAggregate(rows: readonly PerLotTrade[], instruments?: InstrumentLotMap): PerLotAggregate {
  let unknown = 0, lots = 0, net = 0, risk = 0, rLots = 0, rRows = 0;
  const sources = new Set<string>();
  for (const t of rows) {
    const res = lotsOf(t, instruments);
    if (res == null) { unknown++; continue; }
    lots += res.lots;
    net += t.netPnl;
    sources.add(res.asOf ? `${res.source} (${res.asOf})` : res.source);
    if (t.rMultiple != null && t.riskAmount != null && t.riskAmount > 0) {
      risk += t.riskAmount; rLots += res.lots; rRows++;
    }
  }
  const resolved = unknown === 0 && lots > 0;
  return {
    total: rows.length,
    unknown,
    lots: resolved ? lots : null,
    expectancyPerLot: resolved ? r2(net / lots) : null,
    rupeesPerLotR: resolved && rRows > 0 && rLots > 0 ? r2(risk / rLots) : null,
    sources: [...sources].sort(),
  };
}

/** The caveat that replaces the figures when a single row cannot be resolved. */
export function perLotUnknownNote(a: PerLotAggregate): string | null {
  return a.unknown > 0 ? `lot size unknown on ${a.unknown} of ${a.total}` : null;
}

/** "1R = ₹X per lot" (owner ruling OQ2) — "—" when the book cannot say. */
export function rPerLotLabel(a: PerLotAggregate): string {
  if (a.rupeesPerLotR == null) return "—";
  return `1R = ₹${a.rupeesPerLotR.toLocaleString("en-IN", { maximumFractionDigits: 0 })} per lot`;
}
