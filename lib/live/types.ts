/**
 * Live Desk — shared pure types (v4.0).
 *
 * PURITY (AGENTS.md invariant 2). Nothing under `lib/live/` imports a database,
 * React, `node:*` or `fetch`, and nothing here calls `Date.now()`. Clocks,
 * capital, tick sizes, lot sizes and bars are DATA PASSED IN. That is what makes
 * a golden test possible: the same inputs give the same answer on any machine at
 * any hour, and the desk's numbers can be reproduced from a fixture.
 *
 * UNITS (invariant 1). There are exactly three numeric conventions here and
 * mixing them is the bug this comment exists to prevent:
 *
 *   `Paise`  integer paise. ₹2,500.00 is 250_000. Never a float, never rupees.
 *   `Ppm`    integer parts-per-million. 2% is 20_000, 1.0× is 1_000_000.
 *   `AtrP3`  ATR in paise × 1000, so a 0.001-paise ATR step is still exact.
 *
 * Rupees exist only at the render edge (`Intl.NumberFormat('en-IN')`), never
 * inside this folder.
 *
 * NULL IS A FIRST-CLASS VALUE (invariant 6). Every figure whose denominator can
 * be missing is typed `| null` and RETURNS null — never 0, never NaN, never
 * Infinity. A 0 where capital is unconfigured is a claim about the user's
 * account that Vyuha is not entitled to make.
 */

/** ₹ amount as an integer number of paise. ₹2,500.00 → 250_000. */
export type Paise = number;

/** Parts per million, integer. 2% → 20_000; a ratio of 1.0 → 1_000_000. */
export type Ppm = number;

/** ATR carried as paise × 1000, so Wilder smoothing keeps sub-paise precision. */
export type AtrP3 = number;

/** PPM = 1e6. The single named constant; no bare `1e6` in a formula. */
export const PPM = 1_000_000;

/** ATR scale factor: `atrP3 / ATR_SCALE` is the ATR in paise. */
export const ATR_SCALE = 1000;

/** Permille = 1e3, the unit of `stop_atr_mult_permille` (2000 → 2.0×). */
export const PERMILLE = 1000;

/** Which way the open position leans. Shorts mirror every P&L formula. */
export type Side = "long" | "short";

/**
 * How true the mark is. ALWAYS rendered beside the number — a price with no
 * staleness badge is a price with no provenance, and the desk shows neither.
 */
export type Staleness = "tick" | "delayed" | "eod" | "manual";

/** One end-of-day bar, paise-native. `volume` is null when the source had none. */
export interface Bar {
  /** ISO `YYYY-MM-DD`. Sorting is the caller's job; helpers assert ascending. */
  date: string;
  openP: Paise | null;
  highP: Paise | null;
  lowP: Paise | null;
  closeP: Paise;
  volume: number | null;
}

/** The mark, plus the provenance that entitles the desk to print it. */
export interface Mark {
  /** null when no quote, no MTM row and no stored closing price exist. */
  markP: Paise | null;
  staleness: Staleness | null;
  /** When the price was TRUE AT THE SOURCE — not when we received it. */
  asOf: string | null;
}

/**
 * An open position, flattened to exactly what the desk arithmetic needs.
 *
 * Deliberately NOT the `OpenPosition` shape from `lib/analytics/positions.ts`:
 * that one is rupee-denominated and DB-shaped. The caller (a `lib/queries/*`
 * wrapper, W1) converts once, at the boundary, so nothing in here ever sees a
 * rupee. `accountId` rides along from the start — retrofitting a grouping key
 * through a live view later is the expensive version (invariant 8).
 */
export interface LivePosition {
  id: number;
  accountId: number;
  symbol: string;
  tradingsymbol: string;
  /** One of `lib/domain/constants.ts` SEGMENTS; an unknown value renders raw. */
  segment: string;
  instrumentType: string | null;
  side: Side;
  /** Net open quantity, always positive; `side` carries the direction. */
  qty: number;
  avgEntryP: Paise;
  /** ISO date of the first entry, for holding days. */
  entryDate: string | null;
  slPlannedP: Paise | null;
  trailingSlP: Paise | null;
  targetPlannedP: Paise | null;
  /** R FROZEN AT FIRST ENTRY (invariant 4). null ⇒ open-R is null, never 0. */
  riskAmountP: Paise | null;
  lotSize: number | null;
  /** From `getSectorResolution()`; the tier is shown as a badge, never hidden. */
  sector: string | null;
  sectorTier: string | null;
}

/** Broker product code the row displays. `raw` when the segment is unknown. */
export type ProductCode = "CNC" | "MIS" | "MTF" | "NRML" | "raw";

/** A ratio published together with the denominator that produced it. */
export interface Ratio {
  ppm: Ppm | null;
  /** The denominator actually used. null ⇒ `ppm` is null, and says why. */
  denominator: number | null;
}

/** 52-week distance carries the honest label: `52w` only with 252 sessions. */
export interface HighDistance {
  ppm: Ppm | null;
  /** `52w` with a full year of sessions, else `{n}d`. */
  label: string;
  sessions: number;
}

/** Which stop the row is actually measuring against. */
export type EffectiveStopSource = "trailing" | "planned" | null;

/** The computed tracker row. Every `| null` below is a denominator rule. */
export interface TrackerRow {
  id: number;
  accountId: number;
  symbol: string;
  tradingsymbol: string;
  side: Side;
  qty: number;
  avgEntryP: Paise;
  product: ProductCode;
  /** The raw segment, so an unknown one can be rendered verbatim. */
  segment: string;
  markP: Paise | null;
  staleness: Staleness | null;
  markAsOf: string | null;
  /** `(closeP[t] − closeP[t−1]) / closeP[t−1]`. null with < 2 stored sessions. */
  dayChangePpm: Ppm | null;
  /** `qty × (markP − avgEntryP)`, mirrored for shorts. null when mark is null. */
  unrealisedP: Paise | null;
  /** Denominator is INVESTED VALUE (`qty × avgEntryP`), never capital. */
  unrealisedPctPpm: Ppm | null;
  investedP: Paise;
  /** Calendar days since entry. null when the entry date is unknown. */
  holdingDays: number | null;
  effectiveStopP: Paise | null;
  effectiveStopSource: EffectiveStopSource;
  targetP: Paise | null;
  /** `markP − stopP`, mirrored for shorts. null with no stop or no mark. */
  distanceToStopP: Paise | null;
  distanceToStopPpm: Ppm | null;
  distanceToTargetP: Paise | null;
  distanceToTargetPpm: Ppm | null;
  /** Stop distance in ATR units × 100. null with < len+1 sessions or no stop. */
  distanceToStopAtrX100: number | null;
  atrP3: AtrP3 | null;
  /** Sessions actually held, so the badge can say how short the history is. */
  atrSessions: number;
  /** `vol[t] / mean(vol[t−20..t−1])`, current bar EXCLUDED. null with < 21. */
  rvol: Ratio;
  highDistance: HighDistance;
  /** `qty × (avgEntryP − stopP)`, mirrored. null when there is no stop. */
  riskAtStopP: Paise | null;
  /** `unrealisedP / riskAmountP` in ppm. null when `riskAmountP` is null. */
  openRPpm: Ppm | null;
  /** `riskAtStopP / capitalP`. null when capital is unconfigured. */
  pctOfCapital: Ratio;
  sector: string | null;
  sectorTier: string | null;
}

/** Everything the row arithmetic needs from outside the position itself. */
export interface TrackerContext {
  /** IST today as `YYYY-MM-DD` (`todayIstIso()` at the caller). */
  today: string;
  /** Bucket/account capital in paise. null ⇒ every %-of-capital figure is null. */
  capitalP: Paise | null;
  /** Ascending EOD bars for this symbol. Empty is fine; it yields nulls. */
  bars?: readonly Bar[];
  /** Wilder ATR length. Defaults to 21 (`stop_atr_len`'s shipped default). */
  atrLength?: number;
  /** RVOL baseline length, current bar excluded. Defaults to 20. */
  rvolLookback?: number;
}
