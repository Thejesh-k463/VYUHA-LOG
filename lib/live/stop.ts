/**
 * Live Desk — `computeStop`. PURE (invariant 2). 03 §5, spec §4.3.
 *
 * THE STOP IS COMPUTED ONCE, HERE. A stop recomputed in a render path diverges
 * from the journal's number and then only the chart is wrong — visibly, to a
 * paying user, with no error anywhere. Every surface (row, chart line, risk
 * tile, Sizing Lab) reads the result of this function.
 *
 * THE DECISION TREE, in order: manual → structure → ATR → percent. The user's
 * own number always wins; a level they marked on the chart beats one Vyuha
 * derived; a volatility-derived stop beats a flat percentage; the flat
 * percentage is the last resort and SHIPS UNSET, so it only ever fires for a
 * user who configured it. `source` travels with the result so the chart line
 * can be labelled with where its number came from — an unlabelled level is
 * indistinguishable from a level the user set themselves.
 *
 * If `risk_pct_ppm` is unset there is nothing to size against, and this returns
 * `{kind:"risk-not-set"}` rather than defaulting to 2%. A defaulted risk
 * percentage would put a number the user never chose on every risk column in
 * the product (invariant 6).
 *
 * THE CLIP ORDER IS NORMATIVE — (a)…(h), and reordering it changes results:
 *   (a) the stop must be on the correct side of entry, else a TYPED ERROR.
 *       `entryP === stopP` is an error too, not a division producing Infinity.
 *   (b) round to the instrument tick AWAY from entry — wider, never tighter. A
 *       stop rounded toward entry is an unfillable price that also understates
 *       risk; rounding away is at worst one tick of extra honesty.
 *   (c) fixed-fractional quantity from the risk budget.
 *   (d) clip to the deploy cap, recording `clippedBy`.
 *   (e) floor to whole lots — FLOOR, never round: rounding up buys a lot the
 *       risk budget did not pay for.
 *   (f) a zero quantity is a RESULT, not an error: the stop is simply wider
 *       than the budget, and the desk says so in words.
 *   (g) flag a stop wider than N ATRs.
 *   (h) flag a stop outside today's circuit band, where the level cannot trade.
 *
 * ROUNDING: every quantity FLOORS, so a rounding step can never make the
 * position risk more than the budget. `qty × riskPerShareP ≤ riskBudgetP` holds
 * by construction and is asserted in `tests/live-stop.test.ts`.
 */

import { PERMILLE, PPM, type AtrP3, type Paise, type Ppm, type Side } from "./types";

/** Where the stop came from. Always rendered next to the level. */
export type StopSource = "manual" | "structure" | "atr" | "percent";

/** Non-fatal observations about an otherwise valid stop. */
export type StopFlag = "wider-than-n-stop" | "outside-circuit-band" | "tick-rounded";

/** Why no stop could be produced. Typed, so no caller ever sees NaN/Infinity. */
export type StopErrorCode =
  /** long: stop ≥ entry, or short: stop ≤ entry. */
  | "stop-wrong-side"
  /** stop exactly at entry — risk per share would be 0 and the quotient ∞. */
  | "stop-at-entry"
  /** tick rounding pushed the stop to or below zero. */
  | "stop-not-positive"
  /** entry price is not a positive paise amount. */
  | "entry-not-positive";

export interface StopSetup {
  side: Side;
  entryP: Paise;
  /** Instrument tick in paise (NSE cash equity is 5). ≤ 0 disables rounding. */
  tickP: number;
  /** Contract/lot size; 1 for cash equity. Quantities floor to a multiple. */
  lotSize: number;
  /** The user's own stop. Wins outright when present. */
  manualStopP?: Paise | null;
  /** A structural level the user marked (swing low for a long). */
  structureStopP?: Paise | null;
  /** Wilder ATR as paise × 1000, for the ATR branch. */
  atrP3?: AtrP3 | null;
}

export interface StopSettings {
  /** `risk_config.risk_pct_ppm`. null ⇒ `{kind:"risk-not-set"}`. */
  riskPpm: Ppm | null;
  /** Bucket/account capital in paise. null ⇒ `{kind:"risk-not-set"}`. */
  capitalP: Paise | null;
  /** Force a branch. When its input is missing, the tree falls through. */
  stopMethod?: StopSource | null;
  /** `risk_config.stop_atr_mult_permille`; 2000 = 2.0 × ATR. */
  atrMultPermille?: number | null;
  /** `risk_config.stop_default_pct_ppm`; SHIPPED UNSET. */
  defaultPctPpm?: Ppm | null;
  /** `risk_config.deploy_cap_ppm`; 250000 = 25%. null disables the clip. */
  deployCapPpm?: Ppm | null;
  /** Flag threshold in permille of ATR: 3000 flags a stop wider than 3 N. */
  nStopMultPermille?: number | null;
}

export interface StopChartCtx {
  /** Today's lower circuit in paise, when the caller knows it. */
  circuitLowP?: Paise | null;
  circuitHighP?: Paise | null;
}

export interface StopOk {
  kind: "ok";
  stopP: Paise;
  source: StopSource;
  qty: number;
  riskPerShareP: Paise;
  riskBudgetP: Paise;
  /** `qty × entryP` — what the position costs at entry. */
  deployedP: Paise;
  /** `qty × riskPerShareP` — never greater than `riskBudgetP`. */
  riskAtStopP: Paise;
  clippedBy: "deployCap" | "lotSize" | null;
  flags: StopFlag[];
}

export interface StopZero {
  kind: "zero";
  stopP: Paise;
  source: StopSource;
  riskPerShareP: Paise;
  riskBudgetP: Paise;
  clippedBy: "deployCap" | "lotSize" | null;
  flags: StopFlag[];
}

export type StopResult =
  | StopOk
  | StopZero
  /** No risk percentage or no capital: the "risk not set" call to action. */
  | { kind: "risk-not-set" }
  /** Every branch of the tree was out of inputs. Not an error — a gap. */
  | { kind: "no-stop" }
  | { kind: "error"; code: StopErrorCode; source: StopSource };

/** Round a level to the tick AWAY from entry: wider for both sides, never tighter. */
export function roundStopToTick(stopP: Paise, entryP: Paise, tickP: number): Paise {
  if (!Number.isFinite(tickP) || tickP <= 0) return stopP;
  // Below entry (a long's stop) rounds DOWN; above entry (a short's) rounds UP.
  return stopP < entryP ? Math.floor(stopP / tickP) * tickP : Math.ceil(stopP / tickP) * tickP;
}

/** The ordered tree. Exported so the Sizing Lab can show which branch fired. */
const TREE: StopSource[] = ["manual", "structure", "atr", "percent"];

function levelFor(source: StopSource, setup: StopSetup, settings: StopSettings): Paise | null {
  const { side, entryP } = setup;
  const away = (distanceP: number) => (side === "short" ? entryP + distanceP : entryP - distanceP);
  switch (source) {
    case "manual":
      return setup.manualStopP ?? null;
    case "structure":
      return setup.structureStopP ?? null;
    case "atr": {
      const atrP3 = setup.atrP3;
      const mult = settings.atrMultPermille;
      if (atrP3 === null || atrP3 === undefined || atrP3 <= 0) return null;
      if (mult === null || mult === undefined || mult <= 0) return null;
      // atrP3 is paise × 1000 and mult is × 1000, so one division by 1e6 gives
      // paise. Multiply first, divide once, floor — the tick rounding in (b) is
      // what guarantees the level ends up wider rather than tighter.
      return away(Math.floor((atrP3 * mult) / (PERMILLE * PERMILLE)));
    }
    case "percent": {
      const pct = settings.defaultPctPpm;
      if (pct === null || pct === undefined || pct <= 0) return null;
      return away(Math.floor((entryP * pct) / PPM));
    }
  }
}

/**
 * Compute the stop and the quantity it implies.
 *
 * @param setup     the instrument and the levels available for it
 * @param settings  the user's risk configuration (`risk_config`)
 * @param chartCtx  optional circuit band for flag (h)
 */
export function computeStop(setup: StopSetup, settings: StopSettings, chartCtx: StopChartCtx = {}): StopResult {
  const { side, entryP, tickP, lotSize } = setup;

  // The missing input, checked before anything is computed: with no risk
  // percentage or no capital there is no budget, and every number below would
  // be derived from a figure the user never supplied.
  const riskPpm = settings.riskPpm;
  const capitalP = settings.capitalP;
  if (riskPpm === null || riskPpm <= 0 || capitalP === null || capitalP <= 0) return { kind: "risk-not-set" };

  // Walk the tree, honouring an explicit `stopMethod` first and then falling
  // through the remaining branches in order — a forced method whose input is
  // absent must not dead-end the desk.
  const order = settings.stopMethod ? [settings.stopMethod, ...TREE.filter((s) => s !== settings.stopMethod)] : TREE;
  let source: StopSource | null = null;
  let rawStopP: Paise | null = null;
  for (const s of order) {
    const lvl = levelFor(s, setup, settings);
    if (lvl !== null) {
      source = s;
      rawStopP = lvl;
      break;
    }
  }
  if (source === null || rawStopP === null) return { kind: "no-stop" };

  if (!Number.isFinite(entryP) || entryP <= 0) return { kind: "error", code: "entry-not-positive", source };

  // (a) side check — BEFORE any division, so `riskPerShareP` can never be 0.
  if (rawStopP === entryP) return { kind: "error", code: "stop-at-entry", source };
  if (side === "long" ? rawStopP > entryP : rawStopP < entryP) return { kind: "error", code: "stop-wrong-side", source };

  // (b) tick rounding, away from entry.
  const stopP = roundStopToTick(rawStopP, entryP, tickP);
  const flags: StopFlag[] = [];
  if (stopP !== rawStopP) flags.push("tick-rounded");
  if (stopP <= 0) return { kind: "error", code: "stop-not-positive", source };
  if (stopP === entryP) return { kind: "error", code: "stop-at-entry", source };

  const riskPerShareP = Math.abs(entryP - stopP);

  // (c) fixed-fractional quantity. Multiply, then one floor: a budget rounded
  // up is a budget the user did not authorise.
  const riskBudgetP = Math.floor((capitalP * riskPpm) / PPM);
  let qty = Math.floor(riskBudgetP / riskPerShareP);
  let clippedBy: "deployCap" | "lotSize" | null = null;

  // (d) deploy cap. A clip, never a sizing method — it only ever reduces.
  const deployCapPpm = settings.deployCapPpm;
  if (deployCapPpm !== null && deployCapPpm !== undefined && deployCapPpm > 0) {
    const maxDeployP = Math.floor((capitalP * deployCapPpm) / PPM);
    const capQty = Math.floor(maxDeployP / entryP);
    if (capQty < qty) {
      qty = capQty;
      clippedBy = "deployCap";
    }
  }

  // (e) whole lots, floored.
  const lot = Number.isFinite(lotSize) && lotSize >= 1 ? Math.floor(lotSize) : 1;
  const lotted = Math.floor(qty / lot) * lot;
  if (lotted !== qty) clippedBy = clippedBy ?? "lotSize";
  qty = lotted;

  // (g) a stop wider than N ATRs is a fact about the setup, not a failure.
  const atrP3 = setup.atrP3;
  const nStop = settings.nStopMultPermille;
  if (atrP3 !== null && atrP3 !== undefined && atrP3 > 0 && nStop !== null && nStop !== undefined && nStop > 0) {
    // riskPerShareP (paise) ÷ (atrP3/1000) in permille = riskPerShareP × 1e6 / atrP3.
    if ((riskPerShareP * PPM) / atrP3 > nStop) flags.push("wider-than-n-stop");
  }

  // (h) a level outside the band cannot trade today; the desk says so.
  const { circuitLowP, circuitHighP } = chartCtx;
  if ((circuitLowP !== null && circuitLowP !== undefined && stopP < circuitLowP) || (circuitHighP !== null && circuitHighP !== undefined && stopP > circuitHighP)) {
    flags.push("outside-circuit-band");
  }

  // (f) zero is a result with an explanation, not an error.
  if (qty <= 0) return { kind: "zero", stopP, source, riskPerShareP, riskBudgetP, clippedBy, flags };

  return {
    kind: "ok",
    stopP,
    source,
    qty,
    riskPerShareP,
    riskBudgetP,
    deployedP: qty * entryP,
    riskAtStopP: qty * riskPerShareP,
    clippedBy,
    flags,
  };
}
