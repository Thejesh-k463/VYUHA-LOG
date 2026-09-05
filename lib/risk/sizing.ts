/**
 * Position-sizing method catalogue (PURE — no DB, no React, no clock, no fetch).
 *
 * Each function computes the quantity ONE named rulebook produces from numbers
 * the user supplied. Nothing here picks a method, ranks methods, or persists a
 * default: the compare table is a map over the same result shape, and the
 * caller states which method it displayed.
 *
 * Units (invariant 1 — money is integer paise):
 *   capitalP, entryP, stopP, amountP : integer paise    (Rs 2,850 -> 285_000)
 *   atrP3                            : paise x 1000     (ATR Rs 85 -> 8_500_000)
 *   *Ppm                             : ppm integers     (2% -> 20_000)
 *   *Permille                        : per-thousand     (2.0 N -> 2000)
 *
 * Paise-safety rules, applied without exception (03 §1):
 *   1. never divide until the last step — multiply first, then one Math.floor;
 *   2. percentages are ppm integers, never floats;
 *   3. risk per share must be > 0, else a typed error (never Infinity/NaN);
 *   4. lot rounding is floor, never round;
 *   5. BigInt wherever a product can pass Number.MAX_SAFE_INTEGER (fixed ratio's
 *      delta x (delta + 8P), and the MTF interest product);
 *   6. every method returns the same shape, so the compare table is a pure map.
 *
 * Layering: rupee formatting (Intl.NumberFormat('en-IN')) happens at the render
 * edge only — this file emits integers and a symbolic formula with the values
 * that were substituted into it, so a printed formula cannot drift from the
 * number beside it.
 *
 * Charges (invariant 3): `chargesAdjustedRisk` takes a rates object as INPUT
 * and delegates to the existing engine (`lib/engine/charges.ts`). No rate is
 * embedded here; `lib/data/charge-rates-defaults.json` is a dated reference
 * table this module never feeds to the engine on its own.
 *
 * Reuse: `lib/risk/calculators.ts` keeps the rupee-API position sizing, option
 * lot and MTF break-even calculators used by the existing pages. This file is
 * the paise-native catalogue the Live Desk and Sizing Lab compute from;
 * `mtfInterestDrag` is the paise-native statement of `mtfBreakeven`, and
 * `tests/sizing-charges.test.ts` pins the two to the same figure.
 */

import type { Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";
import { computeChargesPaise, type ChargeBreakdownPaise } from "@/lib/engine/charges";
import { stopDistanceInNPermille, type Paise } from "@/lib/risk/stops";
import lotData from "@/lib/data/fno-lots.json";

export type { Paise };

// ---------------------------------------------------------------------------
// Shared result shape
// ---------------------------------------------------------------------------

export type SizingMethodId =
  | "fixed-rupee"
  | "fixed-fractional"
  | "volatility-unit"
  | "pct-volatility"
  | "kelly"
  | "fixed-ratio"
  | "equal-weight";

/** Typed failures. A method never returns Infinity, NaN or a silent zero. */
export type SizingErrorCode =
  | "non-positive-entry"
  | "non-positive-risk-per-share"
  | "capital-unconfigured"
  | "non-positive-amount"
  | "non-positive-atr"
  | "non-positive-lot-size"
  | "non-positive-payoff"
  | "non-positive-delta"
  | "non-positive-block-qty"
  | "non-positive-slots";

/** Non-fatal observations. Every one is a fact about the arithmetic. */
export type SizingFlag =
  | "deploy-capped"
  | "wider-than-n-stop"
  | "exceeds-capital"
  | "non-positive-kelly"
  | "zero-size";

/** Symbolic form plus the values substituted into it, formatted at the edge. */
export interface SizingFormula {
  symbolic: string;
  values: Record<string, number>;
}

export interface SizeResult {
  method: SizingMethodId;
  ok: boolean;
  error: SizingErrorCode | null;
  qty: number;
  /** Whole lots when the instrument trades in lots; null for cash equity. */
  lots: number | null;
  lotSize: number;
  deployedP: Paise;
  /** null when capital is unconfigured — a missing denominator is not zero. */
  pctOfCapitalPpm: number | null;
  riskPerShareP: Paise | null;
  riskAtStopP: Paise;
  riskPctOfCapitalPpm: number | null;
  clippedBy: "deployCap" | null;
  flags: SizingFlag[];
  /** Volatility methods: the 2N stop the rulebook itself would place. */
  turtleStopP: Paise | null;
  /** Stop distance in units of N, per-thousand: Rs 250 over an Rs 85 N = 2941. */
  stopToNPermille: number | null;
  /** Kelly: the raw fraction and the fraction actually used. */
  kellyFPpm: number | null;
  kellyFUsedPpm: number | null;
  /** Fixed ratio: units before the block multiplier. */
  units: number | null;
  formula: SizingFormula;
}

const NO_FORMULA: SizingFormula = { symbolic: "", values: {} };

function failure(method: SizingMethodId, error: SizingErrorCode, lotSize = 1): SizeResult {
  return {
    method,
    ok: false,
    error,
    qty: 0,
    lots: null,
    lotSize,
    deployedP: 0,
    pctOfCapitalPpm: null,
    riskPerShareP: null,
    riskAtStopP: 0,
    riskPctOfCapitalPpm: null,
    clippedBy: null,
    flags: [],
    turtleStopP: null,
    stopToNPermille: null,
    kellyFPpm: null,
    kellyFUsedPpm: null,
    units: null,
    formula: NO_FORMULA,
  };
}

/** Floor a raw quantity onto the lot grid. Floor, never round (03 §1 rule 4). */
export function lotRound(rawQty: number, lotSize = 1): number {
  if (!(lotSize > 0)) return 0;
  if (!(rawQty > 0)) return 0;
  return Math.floor(rawQty / lotSize) * lotSize;
}

interface FinaliseCtx {
  method: SizingMethodId;
  qty: number;
  lotSize: number;
  entryP: Paise;
  riskPerShareP: Paise;
  capitalP: Paise | null;
  atrP3?: number | null;
  nStopMult?: number | null;
  turtleStopP?: Paise | null;
  kellyFPpm?: number | null;
  kellyFUsedPpm?: number | null;
  units?: number | null;
  extraFlags?: SizingFlag[];
  formula: SizingFormula;
}

function finalise(c: FinaliseCtx): SizeResult {
  const deployedP = c.qty * c.entryP;
  const riskAtStopP = c.qty * c.riskPerShareP;
  const hasCapital = c.capitalP != null && c.capitalP > 0;
  const flags: SizingFlag[] = [...(c.extraFlags ?? [])];

  const stopToNPermille =
    c.atrP3 != null && c.atrP3 > 0 ? stopDistanceInNPermille(c.riskPerShareP, c.atrP3) : null;
  if (stopToNPermille != null && c.nStopMult != null && stopToNPermille > c.nStopMult) {
    // Sized on N but stopped further out than the rulebook's own N-stop: the
    // position carries more than the unit risk the method computed.
    flags.push("wider-than-n-stop");
  }
  if (hasCapital && deployedP > (c.capitalP as number)) flags.push("exceeds-capital");
  if (c.qty === 0) flags.push("zero-size");

  return {
    method: c.method,
    ok: true,
    error: null,
    qty: c.qty,
    lots: c.lotSize > 1 ? Math.floor(c.qty / c.lotSize) : null,
    lotSize: c.lotSize,
    deployedP,
    pctOfCapitalPpm: hasCapital ? Math.floor((deployedP * 1_000_000) / (c.capitalP as number)) : null,
    riskPerShareP: c.riskPerShareP,
    riskAtStopP,
    riskPctOfCapitalPpm: hasCapital
      ? Math.floor((riskAtStopP * 1_000_000) / (c.capitalP as number))
      : null,
    clippedBy: null,
    flags,
    turtleStopP: c.turtleStopP ?? null,
    stopToNPermille,
    kellyFPpm: c.kellyFPpm ?? null,
    kellyFUsedPpm: c.kellyFUsedPpm ?? null,
    units: c.units ?? null,
    formula: c.formula,
  };
}

/**
 * Risk per share = |entry - stop|. Orientation (a long's stop below entry) is
 * validated in `lib/risk/stops.ts`; here a zero distance is a typed error,
 * because it is the denominator of every risk-based method.
 */
function riskPerShare(entryP: Paise, stopP: Paise): number {
  return Math.abs(entryP - stopP);
}

// ---------------------------------------------------------------------------
// 1. Fixed rupee amount
// ---------------------------------------------------------------------------

export interface FixedRupeeInput {
  amountP: Paise;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  capitalP?: Paise | null;
  atrP3?: number | null;
  nStopMult?: number | null;
}

/**
 * A flat rupee amount per position. Stop distance and volatility play no part
 * in the quantity — the stop only prices the risk that results.
 *
 * `qty = floor(floor(amount / entry) / lotSize) x lotSize`
 */
export function sizeFixedRupee(i: FixedRupeeInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  if (!(i.entryP > 0)) return failure("fixed-rupee", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("fixed-rupee", "non-positive-lot-size", lotSize);
  if (!(i.amountP > 0)) return failure("fixed-rupee", "non-positive-amount", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("fixed-rupee", "non-positive-risk-per-share", lotSize);

  const rawQty = Math.floor(i.amountP / i.entryP);
  const qty = lotRound(rawQty, lotSize);
  return finalise({
    method: "fixed-rupee",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP ?? null,
    atrP3: i.atrP3,
    nStopMult: i.nStopMult,
    formula: {
      symbolic: "qty = floor(floor(amount / entry) / lotSize) x lotSize",
      values: { amountP: i.amountP, entryP: i.entryP, lotSize, rawQty, qty },
    },
  });
}

// ---------------------------------------------------------------------------
// 2. Fixed fractional (% of capital risked)
// ---------------------------------------------------------------------------

export interface FixedFractionalInput {
  capitalP: Paise;
  /** Risk per trade as ppm of capital: 2% -> 20_000. */
  riskPpm: number;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  atrP3?: number | null;
  nStopMult?: number | null;
}

/**
 * The quantity at which a stop-out costs the risk budget the user set.
 *
 * `riskBudget = floor(capital x riskPpm / 1e6)`
 * `qty = floor(floor(riskBudget / (entry - stop)) / lotSize) x lotSize`
 */
export function sizeFixedFractional(i: FixedFractionalInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  if (!(i.entryP > 0)) return failure("fixed-fractional", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("fixed-fractional", "non-positive-lot-size", lotSize);
  if (!(i.capitalP > 0)) return failure("fixed-fractional", "capital-unconfigured", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("fixed-fractional", "non-positive-risk-per-share", lotSize);

  const riskBudgetP = Math.floor((i.capitalP * Math.max(0, i.riskPpm)) / 1_000_000);
  const rawQty = Math.floor(riskBudgetP / rps);
  const qty = lotRound(rawQty, lotSize);
  return finalise({
    method: "fixed-fractional",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP,
    atrP3: i.atrP3,
    nStopMult: i.nStopMult,
    formula: {
      symbolic:
        "riskBudget = floor(capital x riskPpm / 1e6); qty = floor(floor(riskBudget / riskPerShare) / lotSize) x lotSize",
      values: {
        capitalP: i.capitalP,
        riskPpm: i.riskPpm,
        riskBudgetP,
        riskPerShareP: rps,
        lotSize,
        rawQty,
        qty,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 3 & 4. Volatility sizing — Turtle unit and percentage-volatility
// ---------------------------------------------------------------------------

export interface VolatilityUnitInput {
  capitalP: Paise;
  /** Account fraction one N of movement equals. Turtle: 1% -> 10_000 ppm. */
  unitRiskPpm: number;
  /** ATR carried as paise x 1000. */
  atrP3: number;
  entryP: Paise;
  /** The stop the position will actually use, for the risk figure and the flag. */
  stopP: Paise;
  lotSize?: number;
  /** N multiple of the rulebook's own stop, per-thousand. Turtle: 2000. */
  nStopMult?: number;
}

/**
 * Turtle unit: one N of movement equals `unitRiskPpm` of the account. The
 * rulebook's own stop sits at `nStopMult` N; when the stop passed in is wider
 * than that, the `wider-than-n-stop` flag fires, because the position then
 * carries more than one unit of risk.
 *
 * `unitRisk = floor(capital x unitRiskPpm / 1e6)`
 * `qty = floor(floor(unitRisk x 1000 / atrP3) / lotSize) x lotSize`
 * `turtleStop = entry - floor(atrP3 x nStopMult / 1e6)`
 */
export function sizeVolatilityUnit(i: VolatilityUnitInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  const nStopMult = i.nStopMult ?? 2000;
  if (!(i.entryP > 0)) return failure("volatility-unit", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("volatility-unit", "non-positive-lot-size", lotSize);
  if (!(i.capitalP > 0)) return failure("volatility-unit", "capital-unconfigured", lotSize);
  if (!(i.atrP3 > 0)) return failure("volatility-unit", "non-positive-atr", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("volatility-unit", "non-positive-risk-per-share", lotSize);

  const unitRiskP = Math.floor((i.capitalP * Math.max(0, i.unitRiskPpm)) / 1_000_000);
  const rawQty = Math.floor((unitRiskP * 1000) / i.atrP3);
  const qty = lotRound(rawQty, lotSize);
  const turtleStopP = i.entryP - Math.floor((i.atrP3 * nStopMult) / 1_000_000);
  return finalise({
    method: "volatility-unit",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP,
    atrP3: i.atrP3,
    nStopMult,
    turtleStopP,
    formula: {
      symbolic:
        "unitRisk = floor(capital x unitRiskPpm / 1e6); qty = floor(floor(unitRisk x 1000 / atrP3) / lotSize) x lotSize",
      values: {
        capitalP: i.capitalP,
        unitRiskPpm: i.unitRiskPpm,
        unitRiskP,
        atrP3: i.atrP3,
        lotSize,
        rawQty,
        qty,
        turtleStopP,
      },
    },
  });
}

export interface PctVolatilityInput {
  capitalP: Paise;
  /** Full risk budget as ppm of capital: 2% -> 20_000. */
  riskPpm: number;
  atrP3: number;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  nStopMult?: number;
}

/**
 * Percentage-volatility sizing (Varsity): the whole risk budget divided by one
 * ATR, rather than the Turtle unit fraction. At the same inputs this returns a
 * quantity around twice the Turtle unit, which is why the tab states which
 * variant produced the number.
 *
 * `qty = floor(floor(riskBudget x 1000 / atrP3) / lotSize) x lotSize`
 */
export function sizePctVolatility(i: PctVolatilityInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  const nStopMult = i.nStopMult ?? 2000;
  if (!(i.entryP > 0)) return failure("pct-volatility", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("pct-volatility", "non-positive-lot-size", lotSize);
  if (!(i.capitalP > 0)) return failure("pct-volatility", "capital-unconfigured", lotSize);
  if (!(i.atrP3 > 0)) return failure("pct-volatility", "non-positive-atr", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("pct-volatility", "non-positive-risk-per-share", lotSize);

  const riskBudgetP = Math.floor((i.capitalP * Math.max(0, i.riskPpm)) / 1_000_000);
  const rawQty = Math.floor((riskBudgetP * 1000) / i.atrP3);
  const qty = lotRound(rawQty, lotSize);
  return finalise({
    method: "pct-volatility",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP,
    atrP3: i.atrP3,
    nStopMult,
    turtleStopP: i.entryP - Math.floor((i.atrP3 * nStopMult) / 1_000_000),
    formula: {
      symbolic:
        "riskBudget = floor(capital x riskPpm / 1e6); qty = floor(floor(riskBudget x 1000 / atrP3) / lotSize) x lotSize",
      values: {
        capitalP: i.capitalP,
        riskPpm: i.riskPpm,
        riskBudgetP,
        atrP3: i.atrP3,
        lotSize,
        rawQty,
        qty,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 5. Kelly and fractional Kelly
// ---------------------------------------------------------------------------

export interface KellyInput {
  capitalP: Paise;
  /** Win rate in ppm: 45% -> 450_000. */
  winPpm: number;
  /** Payoff in R, in ppm: 2R -> 2_000_000. */
  payoffPpm: number;
  /** Fraction of Kelly used: full 1_000_000, half 500_000, quarter 250_000. */
  kellyFractionPpm?: number;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  atrP3?: number | null;
  nStopMult?: number | null;
}

/**
 * The Kelly formula, with the win rate and payoff the user supplied:
 *
 * `f = win - floor((1e6 - win) x 1e6 / payoff)`
 * `fUsed = floor(f x kellyFraction / 1e6)`
 * `riskBudget = floor(capital x max(fUsed, 0) / 1e6)`, then fixed-fractional.
 *
 * A non-positive `f` returns no size and the `non-positive-kelly` flag. Full
 * Kelly routinely produces a deployment larger than the account, which is what
 * `applyDeployCap` is for — the Lab keeps that clip on for this method.
 */
export function sizeKelly(i: KellyInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  const fractionPpm = i.kellyFractionPpm ?? 1_000_000;
  if (!(i.entryP > 0)) return failure("kelly", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("kelly", "non-positive-lot-size", lotSize);
  if (!(i.capitalP > 0)) return failure("kelly", "capital-unconfigured", lotSize);
  if (!(i.payoffPpm > 0)) return failure("kelly", "non-positive-payoff", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("kelly", "non-positive-risk-per-share", lotSize);

  const fPpm = i.winPpm - Math.floor(((1_000_000 - i.winPpm) * 1_000_000) / i.payoffPpm);
  const fUsedPpm = Math.floor((fPpm * fractionPpm) / 1_000_000);
  const usablePpm = Math.max(fUsedPpm, 0);
  const riskBudgetP = Math.floor((i.capitalP * usablePpm) / 1_000_000);
  const rawQty = Math.floor(riskBudgetP / rps);
  const qty = lotRound(rawQty, lotSize);

  return finalise({
    method: "kelly",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP,
    atrP3: i.atrP3,
    nStopMult: i.nStopMult,
    kellyFPpm: fPpm,
    kellyFUsedPpm: fUsedPpm,
    extraFlags: fPpm <= 0 ? ["non-positive-kelly"] : [],
    formula: {
      symbolic:
        "f = win - floor((1e6 - win) x 1e6 / payoff); fUsed = floor(f x fraction / 1e6); qty = floor(floor(capital x fUsed / 1e6 / riskPerShare) / lotSize) x lotSize",
      values: {
        winPpm: i.winPpm,
        payoffPpm: i.payoffPpm,
        fPpm,
        kellyFractionPpm: fractionPpm,
        fUsedPpm,
        capitalP: i.capitalP,
        riskBudgetP,
        riskPerShareP: rps,
        lotSize,
        rawQty,
        qty,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 6. Fixed ratio (Ryan Jones)
// ---------------------------------------------------------------------------

// tsconfig targets ES2017, where BigInt LITERALS (0n) are a syntax error, so
// every constant here is built with the BigInt() call form.
const BIG_ZERO = BigInt(0);
const BIG_ONE = BigInt(1);
const BIG_TWO = BigInt(2);
const BIG_EIGHT = BigInt(8);

/**
 * Integer square root over BigInt. `delta x (delta + 8P)` passes
 * Number.MAX_SAFE_INTEGER at ordinary Indian account sizes (delta Rs 50 lakh,
 * profit Rs 1 crore, in paise, is 4.25e18), where a float sqrt can land one
 * unit high and silently add a whole unit to the position.
 */
export function isqrt(n: bigint): bigint {
  if (n < BIG_ZERO) throw new RangeError("isqrt of a negative value");
  if (n < BIG_TWO) return n;
  let x = n;
  let y = (x + BIG_ONE) / BIG_TWO;
  while (y < x) {
    x = y;
    y = (x + n / x) / BIG_TWO;
  }
  return x;
}

export interface FixedRatioInput {
  /** Profit needed to add one unit, in paise. */
  deltaP: Paise;
  /** Closed profit accumulated so far, in paise. */
  closedProfitP: Paise;
  /** Quantity one unit represents. */
  blockQty: number;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  capitalP?: Paise | null;
  atrP3?: number | null;
  nStopMult?: number | null;
}

/**
 * Fixed ratio: units grow with the square root of accumulated closed profit.
 *
 * `units = floor((isqrt(delta x (delta + 8 x profit)) + delta) / (2 x delta))`
 * `qty = floor(units x blockQty / lotSize) x lotSize`
 *
 * The one method here that is not stateless — it reads a closed-profit figure
 * from the journal, so the number moves as the book does.
 */
export function sizeFixedRatio(i: FixedRatioInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  if (!(i.entryP > 0)) return failure("fixed-ratio", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("fixed-ratio", "non-positive-lot-size", lotSize);
  if (!(i.deltaP > 0)) return failure("fixed-ratio", "non-positive-delta", lotSize);
  if (!(i.blockQty > 0)) return failure("fixed-ratio", "non-positive-block-qty", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("fixed-ratio", "non-positive-risk-per-share", lotSize);

  const delta = BigInt(i.deltaP);
  const profit = BigInt(Math.max(0, i.closedProfitP));
  const units = Number((isqrt(delta * (delta + BIG_EIGHT * profit)) + delta) / (BIG_TWO * delta));
  const qty = lotRound(units * i.blockQty, lotSize);

  return finalise({
    method: "fixed-ratio",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP ?? null,
    atrP3: i.atrP3,
    nStopMult: i.nStopMult,
    units,
    formula: {
      symbolic:
        "units = floor((isqrt(delta x (delta + 8 x profit)) + delta) / (2 x delta)); qty = floor(units x blockQty / lotSize) x lotSize",
      values: {
        deltaP: i.deltaP,
        closedProfitP: i.closedProfitP,
        units,
        blockQty: i.blockQty,
        lotSize,
        qty,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 7. Equal weight
// ---------------------------------------------------------------------------

export interface EqualWeightInput {
  capitalP: Paise;
  /** Number of portfolio slots the capital is divided into. */
  slots: number;
  entryP: Paise;
  stopP: Paise;
  lotSize?: number;
  atrP3?: number | null;
  nStopMult?: number | null;
}

/**
 * Capital split into equal slots; the stop prices the risk that results but
 * plays no part in the quantity.
 *
 * `slotP = floor(capital / slots); qty = floor(floor(slotP / entry) / lotSize) x lotSize`
 */
export function sizeEqualWeight(i: EqualWeightInput): SizeResult {
  const lotSize = i.lotSize ?? 1;
  if (!(i.entryP > 0)) return failure("equal-weight", "non-positive-entry", lotSize);
  if (!(lotSize > 0)) return failure("equal-weight", "non-positive-lot-size", lotSize);
  if (!(i.capitalP > 0)) return failure("equal-weight", "capital-unconfigured", lotSize);
  if (!(i.slots > 0)) return failure("equal-weight", "non-positive-slots", lotSize);
  const rps = riskPerShare(i.entryP, i.stopP);
  if (!(rps > 0)) return failure("equal-weight", "non-positive-risk-per-share", lotSize);

  const slotP = Math.floor(i.capitalP / Math.floor(i.slots));
  const rawQty = Math.floor(slotP / i.entryP);
  const qty = lotRound(rawQty, lotSize);
  return finalise({
    method: "equal-weight",
    qty,
    lotSize,
    entryP: i.entryP,
    riskPerShareP: rps,
    capitalP: i.capitalP,
    atrP3: i.atrP3,
    nStopMult: i.nStopMult,
    formula: {
      symbolic: "slot = floor(capital / slots); qty = floor(floor(slot / entry) / lotSize) x lotSize",
      values: { capitalP: i.capitalP, slots: i.slots, slotP, entryP: i.entryP, lotSize, rawQty, qty },
    },
  });
}

// ---------------------------------------------------------------------------
// Deploy cap — a clip applied after any method, not a method
// ---------------------------------------------------------------------------

export interface DeployCapInput {
  capitalP: Paise;
  /** Share of capital this position may occupy, ppm: 25% -> 250_000. */
  deployCapPpm: number;
  entryP: Paise;
  lotSize?: number;
}

/**
 * Clip a computed quantity to the share of capital the user allows one
 * position to occupy. The clip never raises a quantity; when it binds, the
 * result carries `clippedBy:"deployCap"` and the `deploy-capped` flag, so the
 * table can state which number the user is looking at.
 *
 * `maxDeploy = floor(capital x deployCapPpm / 1e6)`
 * `qtyCap = floor(floor(maxDeploy / entry) / lotSize) x lotSize`
 */
export function applyDeployCap(result: SizeResult, cap: DeployCapInput): SizeResult {
  if (!result.ok) return result;
  const lotSize = cap.lotSize ?? result.lotSize ?? 1;
  if (!(cap.capitalP > 0) || !(cap.entryP > 0) || !(lotSize > 0) || !(cap.deployCapPpm > 0)) return result;

  const maxDeployP = Math.floor((cap.capitalP * cap.deployCapPpm) / 1_000_000);
  const qtyCap = lotRound(Math.floor(maxDeployP / cap.entryP), lotSize);
  if (result.qty <= qtyCap) return result;

  const qty = qtyCap;
  const deployedP = qty * cap.entryP;
  const riskPerShareP = result.riskPerShareP ?? 0;
  const riskAtStopP = qty * riskPerShareP;
  const flags: SizingFlag[] = result.flags.filter((f) => f !== "exceeds-capital" && f !== "zero-size");
  flags.push("deploy-capped");
  if (qty === 0) flags.push("zero-size");

  return {
    ...result,
    qty,
    lots: lotSize > 1 ? Math.floor(qty / lotSize) : null,
    deployedP,
    pctOfCapitalPpm: Math.floor((deployedP * 1_000_000) / cap.capitalP),
    riskAtStopP,
    riskPctOfCapitalPpm: Math.floor((riskAtStopP * 1_000_000) / cap.capitalP),
    clippedBy: "deployCap",
    flags,
    formula: {
      symbolic:
        result.formula.symbolic +
        "; qtyCap = floor(floor(capital x deployCapPpm / 1e6 / entry) / lotSize) x lotSize; qty = min(qty, qtyCap)",
      values: {
        ...result.formula.values,
        deployCapPpm: cap.deployCapPpm,
        maxDeployP,
        qtyCap,
        qty,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Charges-adjusted risk (invariant 3: rates are an INPUT)
// ---------------------------------------------------------------------------

export interface ChargesAdjustedRiskInput {
  segment: Segment;
  qty: number;
  entryP: Paise;
  /** Where the position is exited for this figure — usually the stop. */
  stopP: Paise;
  capitalP?: Paise | null;
  buyOrderCount?: number;
  sellOrderCount?: number;
  mtf?: { fundedAmount: Paise; daysHeld: number; pledgeScrips?: number } | null;
}

export interface ChargesAdjustedRiskResult {
  /** Price risk alone: qty x |entry - stop|. */
  riskAtStopP: Paise;
  chargesP: Paise;
  breakdownP: ChargeBreakdownPaise;
  /** Price risk plus the round-trip charges. */
  effectiveRiskP: Paise;
  effectiveRiskPctOfCapitalPpm: number | null;
  /** Charges as ppm of the price risk. */
  chargeUpliftPpm: number | null;
}

/**
 * The round-trip charge on a position exited at its stop, added to the price
 * risk. Rates arrive as an argument and the arithmetic is the shipped charges
 * engine — this module holds no rate of its own (invariant 3), and a rate row
 * carries its own effective window, so a trade dated before a statutory change
 * is priced at the rate that applied then.
 *
 * Figures exclude nothing the engine models, and assume the exit fills at the
 * level passed in.
 */
export function chargesAdjustedRisk(
  i: ChargesAdjustedRiskInput,
  rates: ChargeRates,
): ChargesAdjustedRiskResult {
  const buyValue = i.qty * i.entryP;
  const sellValue = i.qty * i.stopP;
  const breakdownP = computeChargesPaise(
    {
      segment: i.segment,
      buyValue,
      sellValue,
      buyQty: i.qty,
      sellQty: i.qty,
      buyOrderCount: i.buyOrderCount,
      sellOrderCount: i.sellOrderCount,
      mtf: i.mtf ?? null,
    },
    rates,
  );
  const riskAtStopP = Math.abs(buyValue - sellValue);
  const chargesP = breakdownP.total;
  const effectiveRiskP = riskAtStopP + chargesP;
  const hasCapital = i.capitalP != null && i.capitalP > 0;
  return {
    riskAtStopP,
    chargesP,
    breakdownP,
    effectiveRiskP,
    effectiveRiskPctOfCapitalPpm: hasCapital
      ? Math.floor((effectiveRiskP * 1_000_000) / (i.capitalP as number))
      : null,
    chargeUpliftPpm: riskAtStopP > 0 ? Math.floor((chargesP * 1_000_000) / riskAtStopP) : null,
  };
}

// ---------------------------------------------------------------------------
// MTF interest drag
// ---------------------------------------------------------------------------

export interface MtfInterestDragInput {
  /** Funded (borrowed) amount, in paise. */
  fundedP: Paise;
  /** Total position value, for the break-even move; null leaves it null. */
  positionValueP?: Paise | null;
  /** Brokerage and statutory charges to carry into the break-even, in paise. */
  otherChargesP?: Paise;
}

export interface MtfInterestDragResult {
  interestP: Paise;
  dailyInterestP: Paise;
  totalCostP: Paise;
  /** Price move needed to cover the cost, ppm of position value; null with no denominator. */
  breakevenMovePpm: number | null;
}

/**
 * MTF interest accrued over a holding period and the move that covers it.
 * `ratePpm` is the ANNUAL rate in ppm (14.6% p.a. -> 146_000) and arrives as an
 * argument — broker rates move, and `lib/data/charge-rates-defaults.json`
 * carries them as dated presets the user picks from and edits.
 *
 * `interest = floor(funded x ratePpm x days / (1e6 x 365))`, in BigInt: at a
 * one-crore funded book the product passes Number.MAX_SAFE_INTEGER.
 */
export function mtfInterestDrag(
  i: MtfInterestDragInput,
  ratePpm: number,
  days: number,
): MtfInterestDragResult {
  const d = Math.max(0, Math.floor(days));
  const funded = BigInt(Math.max(0, Math.floor(i.fundedP)));
  const rate = BigInt(Math.max(0, Math.floor(ratePpm)));
  const denom = BigInt(1_000_000) * BigInt(365);
  const interestP = Number((funded * rate * BigInt(d)) / denom);
  const dailyInterestP = Number((funded * rate) / denom);
  const totalCostP = interestP + (i.otherChargesP ?? 0);
  const pv = i.positionValueP;
  return {
    interestP,
    dailyInterestP,
    totalCostP,
    breakevenMovePpm: pv != null && pv > 0 ? Math.floor((totalCostP * 1_000_000) / pv) : null,
  };
}

// ---------------------------------------------------------------------------
// Compare table
// ---------------------------------------------------------------------------

export interface SizingSetup {
  capitalP: Paise;
  entryP: Paise;
  stopP: Paise;
  /** Risk per trade, ppm of capital. */
  riskPpm: number;
  lotSize?: number;
  atrP3?: number | null;
  /** Turtle unit risk, ppm of capital. Default 10_000 (1%). */
  unitRiskPpm?: number;
  /** The rulebook's own N-stop multiple, per-thousand. Default 2000 (2.0 N). */
  nStopMult?: number;
  /** Fixed-rupee amount, in paise. */
  fixedAmountP?: Paise | null;
  winPpm?: number | null;
  payoffPpm?: number | null;
  kellyFractionPpm?: number;
  deltaP?: Paise | null;
  closedProfitP?: Paise | null;
  blockQty?: number | null;
  slots?: number | null;
  /** When set, the clip is applied to every row. Null leaves rows unclipped. */
  deployCapPpm?: number | null;
}

/**
 * Every method computed from one setup, in a fixed order, with the same result
 * shape — a method whose inputs are missing returns `ok:false` with its error
 * code rather than disappearing, so the table keeps its rows. The order is the
 * catalogue order; it is not a ranking, and no row is marked as preferred.
 */
export function compareAll(setup: SizingSetup): SizeResult[] {
  const lotSize = setup.lotSize ?? 1;
  const atrP3 = setup.atrP3 ?? null;
  const nStopMult = setup.nStopMult ?? 2000;
  const common = { entryP: setup.entryP, stopP: setup.stopP, lotSize, atrP3, nStopMult };

  const rows: SizeResult[] = [
    setup.fixedAmountP != null
      ? sizeFixedRupee({ ...common, amountP: setup.fixedAmountP, capitalP: setup.capitalP })
      : failure("fixed-rupee", "non-positive-amount", lotSize),
    sizeFixedFractional({ ...common, capitalP: setup.capitalP, riskPpm: setup.riskPpm }),
    atrP3 != null && atrP3 > 0
      ? sizeVolatilityUnit({
          ...common,
          atrP3,
          capitalP: setup.capitalP,
          unitRiskPpm: setup.unitRiskPpm ?? 10_000,
        })
      : failure("volatility-unit", "non-positive-atr", lotSize),
    atrP3 != null && atrP3 > 0
      ? sizePctVolatility({ ...common, atrP3, capitalP: setup.capitalP, riskPpm: setup.riskPpm })
      : failure("pct-volatility", "non-positive-atr", lotSize),
    setup.winPpm != null && setup.payoffPpm != null
      ? sizeKelly({
          ...common,
          capitalP: setup.capitalP,
          winPpm: setup.winPpm,
          payoffPpm: setup.payoffPpm,
          kellyFractionPpm: setup.kellyFractionPpm,
        })
      : failure("kelly", "non-positive-payoff", lotSize),
    setup.deltaP != null && setup.blockQty != null
      ? sizeFixedRatio({
          ...common,
          capitalP: setup.capitalP,
          deltaP: setup.deltaP,
          closedProfitP: setup.closedProfitP ?? 0,
          blockQty: setup.blockQty,
        })
      : failure("fixed-ratio", "non-positive-delta", lotSize),
    setup.slots != null
      ? sizeEqualWeight({ ...common, capitalP: setup.capitalP, slots: setup.slots })
      : failure("equal-weight", "non-positive-slots", lotSize),
  ];

  if (setup.deployCapPpm == null) return rows;
  const cap: DeployCapInput = {
    capitalP: setup.capitalP,
    deployCapPpm: setup.deployCapPpm,
    entryP: setup.entryP,
    lotSize,
  };
  return rows.map((r) => applyDeployCap(r, cap));
}

// ---------------------------------------------------------------------------
// Dated contract-grid lookups
// ---------------------------------------------------------------------------

interface LotRevision {
  effectiveFrom: string;
  label: string;
  lots: Record<string, number>;
}

const LOT_REVISIONS: LotRevision[] = lotData.indexLotRevisions.map((r) => ({
  effectiveFrom: r.effectiveFrom,
  label: r.label,
  lots: r.lots as Record<string, number>,
}));

export interface LotResolution {
  lotSize: number | null;
  /** Which dated revision produced the figure, for the UI to state. */
  revision: string;
  effectiveFrom: string;
}

/**
 * Index derivative lot size on a date. Dated, because NSE revises the grid
 * roughly half-yearly — the Jan-2026 series cut NIFTY from 75 to 65 — and a
 * quantity computed against the wrong revision is off by a whole lot. Returns
 * `lotSize: null` for a symbol the bundled table does not carry, never a
 * fabricated 1.
 */
export function resolveIndexLotSize(symbol: string, onDate: string): LotResolution {
  const key = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  let best: LotRevision | null = null;
  for (const r of LOT_REVISIONS) {
    if (r.effectiveFrom > onDate) continue;
    if (best == null || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  // A date before every revision falls back to the earliest one on file.
  if (best == null) {
    for (const r of LOT_REVISIONS) if (best == null || r.effectiveFrom < best.effectiveFrom) best = r;
  }
  const rev = best!;
  return {
    lotSize: rev.lots[key] ?? null,
    revision: rev.label,
    effectiveFrom: rev.effectiveFrom,
  };
}
