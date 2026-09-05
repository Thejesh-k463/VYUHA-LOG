/**
 * Sizing Lab — the shared, PURE description of the lab's inputs, its seven
 * method tabs, and the ranges the write-back route enforces.
 *
 * No DB, no React, no fetch, no clock. It sits under `components/sizing`
 * rather than `lib/` on purpose: `lib/risk` already owns the arithmetic
 * (`compareAll`, `applyDeployCap`, `chargesAdjustedRisk`) and this module adds
 * nothing mathematical — it is the lab's own vocabulary. The route
 * (`app/api/risk/live-desk/route.ts`) imports the RANGES from here so the
 * slider bounds the user drags and the bounds the server enforces are one
 * definition; two copies drift and the 400 then contradicts the UI.
 *
 * Units follow migration 0064 exactly: ppm integers for percentages (0.25% =
 * 2500), per-thousand for ATR multiples (2.0 N = 2000), integer paise for
 * money. Rupee figures live only in `LabInputs`, which is what the form binds
 * to; `buildSetup` converts once, at the edge.
 */

import { toPaise } from "@/lib/money";
import type { Segment } from "@/lib/domain/constants";
import { compareAll } from "@/lib/risk/sizing";
import type { SizeResult, SizingMethodId, SizingSetup } from "@/lib/risk/sizing";

// ---------------------------------------------------------------------------
// Ranges — one definition, shared by the slider and the route's 400
// ---------------------------------------------------------------------------

export interface IntRange {
  min: number;
  max: number;
}

/**
 * The bounds the Live Desk write-back accepts. Every one is an INTEGER range
 * in the column's own unit, so a value that passes here is storable verbatim.
 *
 * `riskPctPpm` 1000–50000 is the slider's own 0.1%–5% (owner Q38b: the
 * per-trade default is 0.25% of capital and 2% is only a point on the way to
 * the 5% top, not a house figure). `deployCapPpm` 50000–1000000 is 5%–100%:
 * a cap below 5% cannot hold a single lot of most instruments, and above 100%
 * it is not a cap. ATR length 5–100 sessions and multiple 0.5–5.0 N are the
 * window in which an ATR stop is arithmetic rather than a typo.
 */
export const LIVE_DESK_RANGES = {
  riskPctPpm: { min: 1_000, max: 50_000 },
  deployCapPpm: { min: 50_000, max: 1_000_000 },
  stopAtrLen: { min: 5, max: 100 },
  stopAtrMultPermille: { min: 500, max: 5_000 },
  /** A percent stop between 0.1% and 50% of entry. */
  stopDefaultPctPpm: { min: 1_000, max: 500_000 },
  /** Portfolio heat ceiling, 0.5%–50% of capital. User-set only, never shipped. */
  heatCeilingPpm: { min: 5_000, max: 500_000 },
} as const satisfies Record<string, IntRange>;

export const STOP_METHODS = ["manual", "structure", "atr", "percent"] as const;
export type StopMethod = (typeof STOP_METHODS)[number];

/**
 * Owner Q38b. The per-trade slider opens at 0.25% of capital, NOT at 2% —
 * 2% is only the neighbourhood of the slider's upper range. This is the one
 * number the Lab may put on screen before the user has stored anything, and
 * it is labelled as the lab default beside the stored chip so the two are
 * never confused (invariant 6: Vyuha does not assert a figure as the user's).
 */
export const DEFAULT_RISK_PCT_PPM = 2_500;

/** Migration 0064's NOT NULL DEFAULT — 25%, on by default (owner Q39). */
export const DEFAULT_DEPLOY_CAP_PPM = 250_000;

export const DEFAULT_STOP_ATR_LEN = 21;
export const DEFAULT_STOP_ATR_MULT_PERMILLE = 2_000;

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const LAB_PRODUCTS = ["cnc", "mtf", "intraday", "fno"] as const;
export type LabProduct = (typeof LAB_PRODUCTS)[number];

export const LAB_PRODUCT_LABELS: Record<LabProduct, string> = {
  cnc: "CNC",
  mtf: "MTF",
  intraday: "Intraday",
  fno: "F&O",
};

/** Which charge schedule prices a product. MTF is its own segment (0050). */
export const LAB_PRODUCT_SEGMENT: Record<LabProduct, Segment> = {
  cnc: "eq_delivery",
  mtf: "eq_mtf",
  intraday: "eq_intraday",
  fno: "future",
};

// ---------------------------------------------------------------------------
// Method catalogue — order, labels, keyboard hint, neutral description
// ---------------------------------------------------------------------------

export interface LabMethod {
  id: SizingMethodId;
  label: string;
  /** 1..7 — the key that switches to this tab. */
  keyHint: string;
  /** What the rulebook does and what it leaves out. Never a ranking. */
  description: string;
}

/**
 * The seven rows `compareAll` returns, in ITS order — index i here is index i
 * there, which is what lets the rail, the body and the table share one array
 * without a lookup that could fall out of step. Descriptions state what each
 * rulebook computes and what it ignores; none of them ranks another, and none
 * carries a colour that would rank them (WCAG 1.4.1 and owner Q32 both).
 */
export const LAB_METHODS: readonly LabMethod[] = [
  {
    id: "fixed-rupee",
    label: "Fixed rupee amount",
    keyHint: "1",
    description:
      "Every position gets the same rupee allocation, whatever the price or the stop distance. Volatility plays no part in the quantity; the stop only prices the risk that results.",
  },
  {
    id: "fixed-fractional",
    label: "Fixed fractional (% risk)",
    keyHint: "2",
    description:
      "A fixed share of capital is put at risk on each position. The stop distance sets the size, so a wider stop buys fewer shares for the same rupee risk.",
  },
  {
    id: "volatility-unit",
    label: "Volatility · Turtle unit (N)",
    keyHint: "3",
    description:
      "One unit is sized so a one-N move equals a slice of the account you set, where N is the ATR. The rulebook's own stop sits at the N multiple below entry.",
  },
  {
    id: "pct-volatility",
    label: "% volatility",
    keyHint: "4",
    description:
      "The same risk budget, divided by the ATR instead of the stop distance. At identical inputs it returns a larger quantity than the Turtle unit.",
  },
  {
    id: "kelly",
    label: "Kelly / fractional Kelly",
    keyHint: "5",
    description:
      "The Kelly formula, with the win rate and payoff you supplied, returns a fraction of capital. Raw Kelly routinely returns a deployment larger than the account, which is what the deploy cap clips.",
  },
  {
    id: "fixed-ratio",
    label: "Fixed ratio",
    keyHint: "6",
    description:
      "Units grow with the square root of realised profit rather than with account size. The one method here that is not stateless — it reads a closed-profit figure you enter.",
  },
  {
    id: "equal-weight",
    label: "Equal weight",
    keyHint: "7",
    description:
      "Capital split into a fixed number of slots. It says nothing about risk: two positions of the same weight can carry very different rupee losses at their stops.",
  },
] as const;

export function methodByKey(key: string): LabMethod | null {
  return LAB_METHODS.find((m) => m.keyHint === key) ?? null;
}

// ---------------------------------------------------------------------------
// The lab's inputs
// ---------------------------------------------------------------------------

/**
 * Everything the left-hand setup card and the per-method extras bind to.
 * Rupee fields are rupees because that is what the user types; every one of
 * them is converted exactly once, in `buildSetup`.
 */
export interface LabInputs {
  capitalRupees: number;
  entryRupees: number;
  stopRupees: number;
  /** Risk per trade, ppm of capital (the slider). */
  riskPctPpm: number;
  atrRupees: number;
  atrLen: number;
  nStopMultPermille: number;
  lotSize: number;
  product: LabProduct;
  direction: "long" | "short";
  /** MTF only: days the funded amount is carried, and the own-funds share. */
  mtfDaysHeld: number;
  mtfOwnPctPpm: number;
  // Per-method extras
  fixedAmountRupees: number;
  unitRiskPpm: number;
  winPpm: number;
  payoffPpm: number;
  kellyFractionPpm: number;
  deltaRupees: number;
  closedProfitRupees: number;
  blockQty: number;
  slots: number;
  // Clips and toggles
  deployCapOn: boolean;
  deployCapPpm: number;
  chargesOn: boolean;
}

/**
 * The sample trade the lab opens with — a RELIANCE-sized swing, labelled as a
 * sample on screen. It is a worked example, not a position and not a symbol
 * the lab suggests: every field is editable and nothing about it is stored.
 */
export function sampleInputs(over: Partial<LabInputs> = {}): LabInputs {
  return {
    capitalRupees: 10_00_000,
    entryRupees: 2850,
    stopRupees: 2600,
    riskPctPpm: DEFAULT_RISK_PCT_PPM,
    atrRupees: 85,
    atrLen: DEFAULT_STOP_ATR_LEN,
    nStopMultPermille: DEFAULT_STOP_ATR_MULT_PERMILLE,
    lotSize: 1,
    product: "cnc",
    direction: "long",
    mtfDaysHeld: 20,
    mtfOwnPctPpm: 250_000,
    fixedAmountRupees: 1_00_000,
    unitRiskPpm: 10_000,
    winPpm: 450_000,
    payoffPpm: 2_000_000,
    kellyFractionPpm: 250_000,
    deltaRupees: 50_000,
    closedProfitRupees: 1_50_000,
    blockQty: 80,
    slots: 8,
    deployCapOn: true,
    deployCapPpm: DEFAULT_DEPLOY_CAP_PPM,
    chargesOn: false,
    ...over,
  };
}

/** ATR in rupees → the paise × 1000 carry `lib/risk` computes in. */
export function atrToP3(atrRupees: number): number {
  return Math.round(atrRupees * 100_000);
}

/**
 * `LabInputs` → the pure `SizingSetup` every method is computed from.
 *
 * A SHORT flips entry and stop only in the sense that the stop sits above
 * entry; `lib/risk/sizing.ts` takes |entry − stop| as the risk per share, so
 * the direction needs no arithmetic here — it is the validity check the chip
 * makes, and a stop on the wrong side leaves risk-per-share at zero, which
 * every method already reports as a typed error rather than an Infinity.
 */
export function buildSetup(i: LabInputs): SizingSetup {
  const atrP3 = i.atrRupees > 0 ? atrToP3(i.atrRupees) : null;
  return {
    capitalP: toPaise(i.capitalRupees),
    entryP: toPaise(i.entryRupees),
    stopP: toPaise(i.stopRupees),
    riskPpm: Math.round(i.riskPctPpm),
    lotSize: Math.max(1, Math.floor(i.lotSize)),
    atrP3,
    unitRiskPpm: Math.round(i.unitRiskPpm),
    nStopMult: Math.round(i.nStopMultPermille),
    fixedAmountP: i.fixedAmountRupees > 0 ? toPaise(i.fixedAmountRupees) : null,
    winPpm: Math.round(i.winPpm),
    payoffPpm: Math.round(i.payoffPpm),
    kellyFractionPpm: Math.round(i.kellyFractionPpm),
    deltaP: i.deltaRupees > 0 ? toPaise(i.deltaRupees) : null,
    closedProfitP: toPaise(Math.max(0, i.closedProfitRupees)),
    blockQty: i.blockQty > 0 ? Math.floor(i.blockQty) : null,
    slots: i.slots > 0 ? Math.floor(i.slots) : null,
    deployCapPpm: i.deployCapOn ? Math.round(i.deployCapPpm) : null,
  };
}

/** True when the stop sits on the side the direction implies. */
export function stopIsOriented(i: LabInputs): boolean {
  if (!(i.entryRupees > 0) || !(i.stopRupees > 0)) return false;
  return i.direction === "long" ? i.stopRupees < i.entryRupees : i.stopRupees > i.entryRupees;
}

// ---------------------------------------------------------------------------
// The stored risk_config row, resolved
// ---------------------------------------------------------------------------

/** The 0064 columns as the lab reads them — nulls preserved, never coalesced. */
export interface StoredLiveDeskRisk {
  riskPctPpm: number | null;
  stopMethod: string | null;
  stopAtrLen: number | null;
  stopAtrMultPermille: number | null;
  stopDefaultPctPpm: number | null;
  deployCapPpm: number;
  heatCeilingPpm: number | null;
}

export interface ResolvedLiveDeskRisk {
  /** What the lab opens the slider at. */
  riskPctPpm: number;
  /** Where that number came from — the chip states it. */
  riskSource: "stored" | "lab-default";
  deployCapPpm: number;
  stopAtrLen: number;
  stopAtrMultPermille: number;
  stored: StoredLiveDeskRisk | null;
}

/**
 * Open the lab at the STORED figure when there is one, at the lab default
 * (0.25%) when there is not — and say which. A null `risk_pct_ppm` is "the
 * user has not chosen" (migration 0064), so it is never silently rendered as
 * though it were a stored setting; `riskSource` is what the chip prints.
 */
export function resolveLiveDeskRisk(stored: StoredLiveDeskRisk | null): ResolvedLiveDeskRisk {
  const riskStored = stored?.riskPctPpm ?? null;
  return {
    riskPctPpm: riskStored ?? DEFAULT_RISK_PCT_PPM,
    riskSource: riskStored == null ? "lab-default" : "stored",
    deployCapPpm: stored?.deployCapPpm ?? DEFAULT_DEPLOY_CAP_PPM,
    stopAtrLen: stored?.stopAtrLen ?? DEFAULT_STOP_ATR_LEN,
    stopAtrMultPermille: stored?.stopAtrMultPermille ?? DEFAULT_STOP_ATR_MULT_PERMILLE,
    stored,
  };
}

/**
 * The seven `compareAll` rows for the lab's own sample setup, at whatever the
 * caller overrides. Pure — it is the loader's contract in one call: the Lab
 * opens on SEVEN rows, one per rulebook, including the ones whose extra inputs
 * are missing (those carry a typed error instead of vanishing, so the reader
 * never sees six methods today and seven tomorrow).
 */
export function compareAll_forSample(over: Partial<LabInputs> = {}): SizeResult[] {
  return compareAll(buildSetup(sampleInputs(over)));
}
