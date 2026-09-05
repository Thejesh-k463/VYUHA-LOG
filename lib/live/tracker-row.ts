/**
 * Live Desk — one tracker row, computed. PURE (invariant 2): no DB, no React,
 * no clock. Spec §2.1–2.3.
 *
 * ROUNDING, STATED ONCE AND OBEYED EVERYWHERE IN THIS FILE:
 *
 *  * Multiply first, divide LAST, exactly once. No intermediate quotient is
 *    ever fed into another formula — that is how a paise-native product grows a
 *    ₹0.03 discrepancy between the row and the report.
 *  * Every ratio goes through `ppmTrunc`/`ppmFloor`, which do the arithmetic in
 *    BigInt. `pnlP × 1e6` overflows IEEE-754 integers at a ~₹90 lakh position
 *    (9.007e15 / 1e6 = 9.007e9 paise), which is an ordinary holding, not an
 *    exotic one. Number arithmetic here would be silently wrong for real users.
 *  * SIGNED ratios (day change, unrealised %, distances, 52w) TRUNCATE toward
 *    zero. Truncation never overstates the magnitude of a move in either
 *    direction; `Math.floor` would round a −1.5% loss to −1.6% and a +1.5% gain
 *    to +1.4%, i.e. it would flatter gains and exaggerate losses.
 *  * BUDGET ratios (portfolio heat, in heat.ts) FLOOR, because there the round
 *    must never overstate how much room is left. Both rules are deliberate and
 *    both are asserted in `tests/live-tracker.test.ts`.
 *
 * NULL, NEVER ZERO (invariant 6). No mark ⇒ null P&L. No `riskAmount` ⇒ null R,
 * because R is frozen at the first entry (invariant 4) and cannot be
 * back-derived. No capital configured ⇒ null %-of-capital. Fewer sessions than
 * a window needs ⇒ null, with the session count published so the badge can say
 * how short the history is.
 */

import {
  ATR_SCALE,
  PPM,
  type AtrP3,
  type Bar,
  type HighDistance,
  type LivePosition,
  type Mark,
  type Paise,
  type Ppm,
  type ProductCode,
  type Ratio,
  type Side,
  type TrackerContext,
  type TrackerRow,
} from "./types";

/** Sessions required before a distance may be labelled "52w" rather than "{n}d". */
export const FULL_YEAR_SESSIONS = 252;

/** Wilder ATR default length; mirrors `risk_config.stop_atr_len`'s intent. */
export const DEFAULT_ATR_LENGTH = 21;

/** RVOL baseline length. The CURRENT bar is excluded from its own baseline. */
export const DEFAULT_RVOL_LOOKBACK = 20;

// `BigInt(n)` calls rather than `0n` literals: tsconfig targets below ES2020,
// where a BigInt literal is a compile error but the constructor is fine.
const BIG_PPM = BigInt(PPM);
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);

/**
 * `numerator / denominator` in ppm, truncated toward zero, in BigInt.
 * Returns null — never 0, never Infinity, never NaN — when the denominator is
 * missing or zero. That null is the whole of invariant 6 in one function.
 */
export function ppmTrunc(numerator: number | null, denominator: number | null): Ppm | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const n = BigInt(Math.trunc(numerator)) * BIG_PPM;
  const d = BigInt(Math.trunc(denominator));
  return Number(n / d); // BigInt division truncates toward zero
}

/**
 * `numerator / denominator` in ppm, FLOORED (toward −∞), in BigInt.
 * Used where the result is a consumed budget: flooring can only understate how
 * much has been used, never overstate how much is left.
 */
export function ppmFloor(numerator: number | null, denominator: number | null): Ppm | null {
  if (numerator === null || denominator === null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return null;
  const n = BigInt(Math.trunc(numerator)) * BIG_PPM;
  const d = BigInt(Math.trunc(denominator));
  let q = n / d;
  // BigInt division truncates; correct it to a floor when the signs disagree.
  if (q * d !== n && n < BIG_ZERO !== d < BIG_ZERO) q -= BIG_ONE;
  return Number(q);
}

/**
 * Broker product code from `segment` + `instrumentType` (spec §2.1).
 * An UNKNOWN segment returns `"raw"` and the row renders the segment verbatim —
 * guessing a product changes what the user believes their margin is.
 */
export function productOf(segment: string, instrumentType: string | null): ProductCode {
  switch (segment) {
    case "eq_delivery":
      return "CNC";
    case "eq_intraday":
      return "MIS";
    case "eq_mtf":
      return "MTF";
    case "index_option":
    case "stock_option":
    case "commodity_option":
    case "commodity_future":
    case "future":
      return "NRML";
    default:
      // instrumentType is a weaker signal than segment, but an option or future
      // with an unrecognised segment is still carried, never intraday.
      if (instrumentType === "option" || instrumentType === "future") return "NRML";
      return "raw";
  }
}

/** True range of `bars[i]` in paise. A bar with no high/low is |close − prevClose|. */
function trueRangeP(bars: readonly Bar[], i: number): Paise {
  const b = bars[i];
  const prevClose = bars[i - 1].closeP;
  const gapUp = Math.abs(b.closeP - prevClose);
  if (b.highP === null || b.lowP === null) return gapUp;
  return Math.max(b.highP - b.lowP, Math.abs(b.highP - prevClose), Math.abs(b.lowP - prevClose));
}

/**
 * Wilder ATR over the whole series, as `atrP3` (paise × 1000).
 *
 * `out[i]` is the ATR **as of the close of bar i**, and is null for every index
 * before `length` — the first Wilder value needs `length` true ranges, and a
 * true range needs a previous close, so `length + 1` bars is the real minimum.
 * Callers that must not peek at the current bar (trailing stops) read `out[i-1]`.
 *
 * Kept in P3 units end to end so the smoothing recursion floors at the
 * thousandth of a paise rather than at the paise: over 250 sessions, flooring at
 * the paise walks the ATR down by a visible amount.
 */
export function wilderAtrSeriesP3(bars: readonly Bar[], length: number): (AtrP3 | null)[] {
  const out: (AtrP3 | null)[] = new Array(bars.length).fill(null);
  if (length < 1 || bars.length < length + 1) return out;
  let sum3 = 0;
  for (let i = 1; i <= length; i++) sum3 += trueRangeP(bars, i) * ATR_SCALE;
  let atr3 = Math.floor(sum3 / length);
  out[length] = atr3;
  for (let i = length + 1; i < bars.length; i++) {
    atr3 = Math.floor((atr3 * (length - 1) + trueRangeP(bars, i) * ATR_SCALE) / length);
    out[i] = atr3;
  }
  return out;
}

/** The latest Wilder ATR, or null with fewer than `length + 1` bars. */
export function latestAtrP3(bars: readonly Bar[], length: number): AtrP3 | null {
  const s = wilderAtrSeriesP3(bars, length);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Day change in ppm: `(closeP[t] − closeP[t−1]) / closeP[t−1]`.
 * null with fewer than 2 stored sessions — a single bar cannot describe a change.
 */
export function dayChangePpm(bars: readonly Bar[]): Ppm | null {
  if (bars.length < 2) return null;
  const t = bars[bars.length - 1].closeP;
  const p = bars[bars.length - 2].closeP;
  return ppmTrunc(t - p, p);
}

/**
 * RVOL: `vol[t] ÷ mean(vol[t−lookback..t−1])`, the CURRENT bar excluded from its
 * own baseline (spec §2.2 / 04 §1 A7). Including it drags every reading toward
 * 1.0 exactly on the days the number is supposed to be interesting.
 *
 * Published as a `Ratio` so the denominator (the baseline volume, floored to an
 * integer) travels with the figure. null with fewer than `lookback + 1` sessions
 * or when any bar in the window has no volume — an absent volume is not a zero.
 */
export function rvolRatio(bars: readonly Bar[], lookback = DEFAULT_RVOL_LOOKBACK): Ratio {
  if (bars.length < lookback + 1) return { ppm: null, denominator: null };
  const current = bars[bars.length - 1].volume;
  if (current === null) return { ppm: null, denominator: null };
  let sum = 0;
  for (let i = bars.length - 1 - lookback; i < bars.length - 1; i++) {
    const v = bars[i].volume;
    if (v === null) return { ppm: null, denominator: null };
    sum += v;
  }
  const baseline = Math.floor(sum / lookback);
  if (baseline <= 0) return { ppm: null, denominator: null };
  return { ppm: ppmTrunc(Math.trunc(current), baseline), denominator: baseline };
}

/**
 * Distance from the running high: `(closeP − highP) / highP`.
 *
 * The label is the honest part. "52w" is asserted ONLY with a full
 * `FULL_YEAR_SESSIONS` of stored bars; with fewer the label is `{n}d`, because
 * calling a 43-session high a 52-week high is a false statement about the data
 * even when the arithmetic is right.
 */
export function highDistance(bars: readonly Bar[], window = FULL_YEAR_SESSIONS): HighDistance {
  const n = Math.min(bars.length, window);
  if (n === 0) return { ppm: null, label: "0d", sessions: 0 };
  let high = -Infinity;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i];
    high = Math.max(high, b.highP ?? b.closeP);
  }
  const label = n >= window ? "52w" : `${n}d`;
  if (!Number.isFinite(high) || high <= 0) return { ppm: null, label, sessions: n };
  return { ppm: ppmTrunc(bars[bars.length - 1].closeP - high, high), label, sessions: n };
}

/** Calendar days between two ISO dates. null when the start date is unknown. */
export function holdingDays(entryDate: string | null, today: string): number | null {
  if (!entryDate) return null;
  const a = Date.parse(`${entryDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** Signed P&L in paise, mirrored for shorts. `qty × (mark − entry)` for a long. */
function unrealised(side: Side, qty: number, entryP: Paise, markP: Paise): Paise {
  return side === "short" ? qty * (entryP - markP) : qty * (markP - entryP);
}

/**
 * How far the mark sits from a level, in the direction that helps the position:
 * positive means the stop is still below a long (or above a short). Shorts
 * mirror, exactly as the P&L does; a shared sign convention is what lets one
 * cell render both sides without a second formula.
 */
function distance(side: Side, markP: Paise, levelP: Paise): Paise {
  return side === "short" ? levelP - markP : markP - levelP;
}

/**
 * Compute one tracker row.
 *
 * `mark.markP` null is the ordinary case before the first bhavcopy of the day,
 * not an error: the row still renders identity, quantity and entry, and every
 * mark-derived figure is null with a staleness badge saying why.
 */
export function computeTrackerRow(position: LivePosition, mark: Mark, ctx: TrackerContext): TrackerRow {
  const bars = ctx.bars ?? [];
  const atrLength = ctx.atrLength ?? DEFAULT_ATR_LENGTH;
  const { side, qty, avgEntryP } = position;

  const investedP = qty * avgEntryP;
  const markP = mark.markP;
  const unrealisedP = markP === null ? null : unrealised(side, qty, avgEntryP, markP);
  // Denominator is INVESTED VALUE, never capital (spec §2.1). Using capital
  // here would make two positions of different size look identically good.
  const unrealisedPctPpm = ppmTrunc(unrealisedP, investedP === 0 ? null : investedP);

  // A trailing stop supersedes the planned one — it is the level actually in
  // force — and the row publishes WHICH, so the chart can label its line.
  const effectiveStopP = position.trailingSlP ?? position.slPlannedP;
  const effectiveStopSource = position.trailingSlP !== null ? "trailing" : position.slPlannedP !== null ? "planned" : null;
  const targetP = position.targetPlannedP;

  const distanceToStopP = markP === null || effectiveStopP === null ? null : distance(side, markP, effectiveStopP);
  const distanceToTargetP = markP === null || targetP === null ? null : -distance(side, markP, targetP);

  const atrP3 = latestAtrP3(bars, atrLength);
  const atrSessions = bars.length;

  // Stop distance in ATR units × 100: (paise × 1000) / atrP3 gives ATR units, so
  // × 100 first keeps two decimals as an integer. Divide once, at the end.
  const distanceToStopAtrX100 =
    distanceToStopP === null || atrP3 === null || atrP3 <= 0
      ? null
      : Math.trunc((distanceToStopP * ATR_SCALE * 100) / atrP3);

  // Risk at stop is a property of the LEVEL, not of the mark: it is what the
  // position loses if the stop fills, and it exists before the first quote.
  const riskAtStopP = effectiveStopP === null ? null : qty * (side === "short" ? effectiveStopP - avgEntryP : avgEntryP - effectiveStopP);

  // R is frozen at first entry (invariant 4). If `riskAmount` was never
  // recorded, open-R is NULL — it cannot be re-derived from today's stop
  // without silently redefining what R meant when the trade was taken.
  const openRPpm = position.riskAmountP === null ? null : ppmTrunc(unrealisedP, position.riskAmountP);

  const capitalP = ctx.capitalP !== null && ctx.capitalP > 0 ? ctx.capitalP : null;
  const pctOfCapital: Ratio = { ppm: ppmTrunc(riskAtStopP, capitalP), denominator: capitalP };

  return {
    id: position.id,
    accountId: position.accountId,
    symbol: position.symbol,
    tradingsymbol: position.tradingsymbol,
    side,
    qty,
    avgEntryP,
    product: productOf(position.segment, position.instrumentType),
    segment: position.segment,
    markP,
    staleness: mark.staleness,
    markAsOf: mark.asOf,
    dayChangePpm: dayChangePpm(bars),
    unrealisedP,
    unrealisedPctPpm,
    investedP,
    holdingDays: holdingDays(position.entryDate, ctx.today),
    effectiveStopP,
    effectiveStopSource,
    targetP,
    distanceToStopP,
    distanceToStopPpm: markP === null ? null : ppmTrunc(distanceToStopP, markP),
    distanceToTargetP,
    distanceToTargetPpm: markP === null ? null : ppmTrunc(distanceToTargetP, markP),
    distanceToStopAtrX100,
    atrP3,
    atrSessions,
    rvol: rvolRatio(bars, ctx.rvolLookback ?? DEFAULT_RVOL_LOOKBACK),
    highDistance: highDistance(bars),
    riskAtStopP,
    openRPpm,
    pctOfCapital,
    sector: position.sector,
    sectorTier: position.sectorTier,
  };
}
