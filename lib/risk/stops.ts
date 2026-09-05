/**
 * Stop-level primitives (PURE — no DB, no React, no clock, no fetch).
 *
 * Every level here is arithmetic on numbers the user supplied: an entry price,
 * an ATR the caller computed from stored bars, a pivot the user marked, a
 * percentage the user set. Nothing in this file picks a stop for anyone; it
 * computes the level a named method produces and labels it with its `source`
 * so the caller can state which arithmetic produced the line.
 *
 * Units (invariant 1 — money is integer paise):
 *   entryP, stopP, pivotP : integer paise            (Rs 2,850 -> 285_000)
 *   atrP3                 : paise x 1000             (Rs 85.00 ATR -> 8_500_000)
 *   *Ppm                  : parts-per-million integers (2% -> 20_000)
 *   *Permille             : parts-per-thousand integers (2.0 N -> 2000)
 *
 * Divisions happen last, once, with Math.floor. A stop distance derived from
 * atrP3 divides by 1_000_000 (1000 for the paise x 1000 carry, 1000 for the
 * permille multiplier) — 03 §1.4 prints `/1000` for that expression, which is
 * off by the atrP3 carry: at ATR Rs 85 and 2.0 N the Turtle stop is Rs 2,680
 * (03 §2 footnote), which only `/1_000_000` reproduces. Deviation logged here.
 *
 * Related: `lib/risk/sizing.ts` turns a stop into a quantity; the W0 wave's
 * `lib/live/stop.ts` composes these primitives into the 03 §5 decision tree.
 * This file holds the primitives only, so both callers share one arithmetic.
 */

import { roundStopToTick } from "@/lib/live/stop";
import lotData from "@/lib/data/fno-lots.json";

/** An integer number of paise (see lib/money.ts). */
export type Paise = number;

/** Which arithmetic produced the level — the caller labels the line with it. */
export type StopSource = "manual" | "structure" | "atr" | "percent" | "turtle";

/** Direction of the position the stop belongs to. */
export type StopSide = "long" | "short";

/**
 * Typed failure codes. A stop calculation never returns Infinity or NaN:
 * a level that cannot exist comes back as `ok:false` with one of these.
 */
export type StopErrorCode =
  | "non-positive-entry"
  | "non-positive-atr"
  | "non-positive-tick"
  | "stop-not-below-entry" // long
  | "stop-not-above-entry" // short
  | "stop-equals-entry"
  | "non-positive-percent";

/** Non-fatal observations about a level that still exists. */
export type StopFlag = "wider-than-n-stop" | "outside-price-band";

export interface StopResult {
  ok: boolean;
  /** null whenever `ok` is false. */
  stopP: Paise | null;
  source: StopSource;
  error: StopErrorCode | null;
  flags: StopFlag[];
  /** Distance from entry in paise; null when the level does not exist. */
  distanceP: Paise | null;
}

function fail(source: StopSource, error: StopErrorCode): StopResult {
  return { ok: false, stopP: null, source, error, flags: [], distanceP: null };
}

/**
 * Validate a candidate level against its side. A long's stop sits strictly
 * below entry, a short's strictly above; equality is a typed error rather than
 * a division by zero one layer up.
 */
export function validateStop(entryP: Paise, stopP: Paise, side: StopSide, source: StopSource): StopResult {
  if (!(entryP > 0)) return fail(source, "non-positive-entry");
  if (stopP === entryP) return fail(source, "stop-equals-entry");
  if (side === "long" && stopP > entryP) return fail(source, "stop-not-below-entry");
  if (side === "short" && stopP < entryP) return fail(source, "stop-not-above-entry");
  return {
    ok: true,
    stopP,
    source,
    error: null,
    flags: [],
    distanceP: side === "long" ? entryP - stopP : stopP - entryP,
  };
}

export interface StopAtrInput {
  entryP: Paise;
  /** ATR carried as paise x 1000. */
  atrP3: number;
  /** Multiple of ATR in parts-per-thousand: 2000 = 2.0 x ATR. */
  multPermille: number;
  side?: StopSide;
  source?: Extract<StopSource, "atr" | "turtle">;
}

/**
 * ATR-multiple stop: `entry -/+ floor(atrP3 x multPermille / 1e6)`.
 * The Turtle 2N stop is this function at `multPermille = 2000`; pass
 * `source:"turtle"` when that is the rulebook being followed, so the label
 * states which one.
 */
export function stopAtr(i: StopAtrInput): StopResult {
  const side = i.side ?? "long";
  const source = i.source ?? "atr";
  if (!(i.entryP > 0)) return fail(source, "non-positive-entry");
  if (!(i.atrP3 > 0)) return fail(source, "non-positive-atr");
  if (!(i.multPermille > 0)) return fail(source, "non-positive-percent");
  const distanceP = Math.floor((i.atrP3 * i.multPermille) / 1_000_000);
  const stopP = side === "long" ? i.entryP - distanceP : i.entryP + distanceP;
  return validateStop(i.entryP, stopP, side, source);
}

export interface StopStructureInput {
  entryP: Paise;
  /** The swing low (long) or swing high (short) the user marked. */
  pivotP: Paise;
  /**
   * Buffer beyond the pivot, in paise. When omitted and `atrP3` is given the
   * quarter-ATR convention applies: `floor(atrP3 / 4000)`.
   */
  bufferP?: Paise;
  atrP3?: number;
  side?: StopSide;
}

/**
 * Structure stop: the pivot the user marked, pushed one buffer further from
 * entry. The quarter-ATR buffer is a convention (03 §3, marked [I] there), not
 * a rule — pass `bufferP` explicitly to use your own.
 */
export function stopStructure(i: StopStructureInput): StopResult {
  const side = i.side ?? "long";
  if (!(i.entryP > 0)) return fail("structure", "non-positive-entry");
  const bufferP = i.bufferP ?? (i.atrP3 && i.atrP3 > 0 ? Math.floor(i.atrP3 / 4000) : 0);
  const stopP = side === "long" ? i.pivotP - bufferP : i.pivotP + bufferP;
  return validateStop(i.entryP, stopP, side, "structure");
}

export interface StopPercentInput {
  entryP: Paise;
  /** Percentage of entry, in ppm: 8% -> 80_000. */
  pctPpm: number;
  side?: StopSide;
}

/** Percentage stop: `entry -/+ floor(entry x pctPpm / 1e6)`. */
export function stopPercent(i: StopPercentInput): StopResult {
  const side = i.side ?? "long";
  if (!(i.entryP > 0)) return fail("percent", "non-positive-entry");
  if (!(i.pctPpm > 0)) return fail("percent", "non-positive-percent");
  const distanceP = Math.floor((i.entryP * i.pctPpm) / 1_000_000);
  const stopP = side === "long" ? i.entryP - distanceP : i.entryP + distanceP;
  return validateStop(i.entryP, stopP, side, "percent");
}

// ---------------------------------------------------------------------------
// Tick grid
// ---------------------------------------------------------------------------

export interface TickBand {
  /** Upper bound of the band, exclusive, in paise; null = open-ended. */
  belowPriceP: number | null;
  tickP: number;
}

interface TickRevision {
  effectiveFrom: string;
  label: string;
  bands: TickBand[];
}

const TICK_REVISIONS: TickRevision[] = lotData.equityTickRevisions.map((r) => ({
  effectiveFrom: r.effectiveFrom,
  label: r.label,
  bands: r.bands as TickBand[],
}));

/** As-of date of the bundled contract-grid tables (lib/data/fno-lots.json). */
export const CONTRACT_GRID_AS_OF: string = lotData.asOf;

/**
 * The tick revision in force on `onDate` (YYYY-MM-DD). Dated, because NSE cut
 * the sub-Rs 250 tick to 1 paisa on 10 Jun 2024 and a level computed for an
 * earlier date sat on the 5-paisa grid.
 */
export function tickRevisionOn(onDate: string): TickRevision {
  let best: TickRevision | null = null;
  for (const r of TICK_REVISIONS) {
    if (r.effectiveFrom > onDate) continue;
    if (best == null || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  // A date before every revision falls back to the earliest one on file.
  if (best == null) {
    for (const r of TICK_REVISIONS) if (best == null || r.effectiveFrom < best.effectiveFrom) best = r;
  }
  return best!;
}

/**
 * Tick size in paise for a price, from a dated band table. ETFs are outside
 * this grid (03 §8.4); the caller passes its own bands for those.
 */
export function tickSizeForPrice(priceP: Paise, bands: TickBand[] = tickRevisionOn(CONTRACT_GRID_AS_OF).bands): number {
  for (const b of bands) {
    if (b.belowPriceP == null || priceP < b.belowPriceP) return b.tickP;
  }
  return bands[bands.length - 1]!.tickP;
}

export interface RoundTickInput {
  stopP: Paise;
  entryP: Paise;
  /** Tick size in paise; resolve it with `tickSizeForPrice` when unknown. */
  tickP: number;
}

/**
 * Snap a stop to the instrument's tick grid AWAY from entry — wider, never
 * tighter. Rounding toward entry would quietly shrink the distance the size
 * was computed from, so the position would carry more than the risk figure
 * printed beside it.
 *
 * Returns the level unchanged when it already sits on the grid.
 *
 * The snapping itself is `roundStopToTick` in `lib/live/stop.ts`, imported
 * rather than restated: the desk's stop line and the Lab's quantity have to be
 * rounded by one function or they disagree by a tick. This wrapper adds the
 * typed-error contract and the side check the primitives here all share.
 */
export function roundTickAwayFromEntry(i: RoundTickInput): StopResult {
  if (!(i.entryP > 0)) return fail("manual", "non-positive-entry");
  if (!(i.tickP > 0)) return fail("manual", "non-positive-tick");
  if (i.stopP === i.entryP) return fail("manual", "stop-equals-entry");
  const below = i.stopP < i.entryP;
  const snapped = roundStopToTick(i.stopP, i.entryP, i.tickP);
  return validateStop(i.entryP, snapped, below ? "long" : "short", "manual");
}

// ---------------------------------------------------------------------------
// Circuit / price band
// ---------------------------------------------------------------------------

export interface CircuitBandInput {
  /** Previous close, in paise — the band is measured off it. */
  prevCloseP: Paise;
  /** Band width in ppm: the 2/5/10/20% bands are 20_000 / 50_000 / 100_000 / 200_000. */
  bandPpm: number;
  /** The level being checked (usually the stop). */
  priceP: Paise;
}

export interface CircuitBandResult {
  lowerP: Paise;
  upperP: Paise;
  withinBand: boolean;
  flags: StopFlag[];
}

/**
 * Where a level sits against today's price band. F&O stocks carry no fixed
 * circuit, only a dynamic operating range, so the caller passes the band it
 * knows about; a level outside it is flagged, never blocked — an unfillable
 * level is still a level the user chose to record.
 */
export function circuitBandFlag(i: CircuitBandInput): CircuitBandResult {
  const half = Math.floor((i.prevCloseP * i.bandPpm) / 1_000_000);
  const lowerP = i.prevCloseP - half;
  const upperP = i.prevCloseP + half;
  const withinBand = i.priceP >= lowerP && i.priceP <= upperP;
  return { lowerP, upperP, withinBand, flags: withinBand ? [] : ["outside-price-band"] };
}

// ---------------------------------------------------------------------------
// Stop distance measured in N
// ---------------------------------------------------------------------------

/**
 * Stop distance expressed in units of N (ATR), as parts-per-thousand:
 * Rs 250 against an Rs 85 ATR returns 2941 (2.94 N). Returns null when ATR is
 * unavailable, never 0 — a missing denominator is not a ratio of zero.
 */
export function stopDistanceInNPermille(distanceP: Paise, atrP3: number): number | null {
  if (!(atrP3 > 0)) return null;
  return Math.floor((distanceP * 1_000_000) / atrP3);
}
