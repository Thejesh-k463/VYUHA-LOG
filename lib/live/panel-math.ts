/**
 * Live Desk — the expanded panel's summary arithmetic. PURE (invariant 2).
 *
 * WHY THIS FILE EXISTS. Every figure on the panel's summary strip used to be
 * computed inside `position-chart-panel.tsx`, where nothing could test it
 * without React — and two of them were wrong:
 *
 *  * SIDE WAS INFERRED. `deriveSide()` read the direction off the stop ("a stop
 *    below entry is a long") and fell back to the target. A short whose stop
 *    tree returned `risk-not-set` and which carried no target therefore
 *    rendered as a LONG: unrealised, Open R and the structure stop all flipped
 *    sign, silently, on the screen the user reads to decide what to do. `side`
 *    is a field on the position. It is passed in, never derived.
 *  * R WAS RE-DERIVED FROM TODAY'S STOP. Open R and the R ladder used the
 *    distance to whatever stop the method control had selected, so a trail that
 *    moved changed what "1R" meant and the panel and the row disagreed about
 *    the same position. R IS FROZEN AT FIRST ENTRY (invariant 4): it is
 *    `riskAmount`, and when that was never recorded R is NULL, never 0 and
 *    never back-derived (invariant 6).
 *
 * Only the stop LINE follows the method control. Everything with an R in it
 * comes from the frozen amount.
 *
 * UNITS: integer paise in, integer paise out; `openR` is the one deliberate
 * ratio and is a plain multiple (1.5 means 1.5R), rendered with one decimal.
 */

import type { Paise, Side } from "./types";

/** +1 for a long, −1 for a short. The mirror is written once, here. */
export function directionOf(side: Side): 1 | -1 {
  return side === "short" ? -1 : 1;
}

/**
 * One R per share, from the FROZEN risk amount (invariant 4).
 *
 * Null — never 0 — when no risk was recorded or the position has no quantity:
 * an R ladder without an R is not a ladder with zero rungs, it is no ladder.
 * The division rounds to whole paise because every level it produces is a
 * price, and a price is paise.
 */
export function frozenRiskPerShareP(riskAmountP: Paise | null, qty: number): Paise | null {
  if (riskAmountP === null || riskAmountP <= 0 || qty <= 0) return null;
  return Math.round(riskAmountP / qty);
}

export interface PanelStatsInput {
  /** The position's OWN side, from the row. Never inferred from a level. */
  side: Side;
  qty: number;
  /** The per-unit entry LEVEL, for the distance arithmetic and the display. */
  entryP: Paise;
  /**
   * `round(qty × avgPrice)` — the product rounded once, from the REAL average
   * (invariant 1). Absent ⇒ `qty × entryP`, which re-rounds the level first and
   * drifts a few paise from the row's own figure on a fractional average. The
   * panel and the row must print the same unrealised P&L for one position.
   */
  investedP?: Paise;
  /** null before the first mark of the day — the ordinary case, not an error. */
  markP: Paise | null;
  /** R frozen at first entry. null ⇒ `openR` is null. */
  riskAmountP: Paise | null;
  /** The stop the CHOSEN METHOD produces. Only `atRiskP` follows it. */
  stopP: Paise | null;
}

export interface PanelStats {
  /** `qty × (mark − entry)`, mirrored for shorts. null with no mark. */
  unrealisedP: Paise | null;
  /** `unrealisedP / riskAmountP`. null when R was never recorded. */
  openR: number | null;
  /**
   * `qty × (mark − stop)`, mirrored, CLAMPED AT 0. Once the mark has passed the
   * stop the position is not at negative risk; it is at no further risk on this
   * level, which is what 0 says.
   */
  atRiskP: Paise | null;
}

/** The four figures the summary strip prints, from the position's own facts. */
export function panelStats(input: PanelStatsInput): PanelStats {
  const { side, qty, entryP, investedP, markP, riskAmountP, stopP } = input;
  const dirn = directionOf(side);

  const investedValueP = investedP ?? qty * entryP;
  const unrealisedP = markP === null ? null : dirn * (qty * markP - investedValueP);
  const openR =
    unrealisedP === null || riskAmountP === null || riskAmountP <= 0 ? null : unrealisedP / riskAmountP;
  const atRiskP = markP === null || stopP === null ? null : qty * Math.max(dirn * (markP - stopP), 0);

  return { unrealisedP, openR, atRiskP };
}
