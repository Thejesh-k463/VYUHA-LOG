/**
 * Three-state regime label, from two figures the screen already shows.
 *
 * It is a LABEL over printed thresholds, not a score. Vyuha never ships a
 * proprietary 0-100 regime number: it would be the one opaque figure in a
 * product whose whole pitch is that every number shows its formula. The
 * thresholds are an INPUT object, defaulted here and rendered on screen, so
 * they can never become a private rule buried in a function body.
 *
 * Expansion:   % above SMA50 >= 55% AND net high-low > 0
 * Contraction: % above SMA50 <= 40% OR  net high-low < -50
 * Neutral:     anything else, with both inputs present
 * Unknown:     an input is null (never fabricate a denominator, invariant 6)
 */
import type { CountMetric, Metric } from "./types";

export type Regime = "expansion" | "contraction" | "neutral" | "unknown";

export interface RegimeThresholds {
  /** Expansion floor for % above SMA50, ppm. 55% = 550_000. */
  expansionAboveSma50Ppm: number;
  /** Expansion floor for net high-low, exclusive. */
  expansionNetHighLow: number;
  /** Contraction ceiling for % above SMA50, ppm. 40% = 400_000. */
  contractionAboveSma50Ppm: number;
  /** Contraction ceiling for net high-low, exclusive. */
  contractionNetHighLow: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  expansionAboveSma50Ppm: 550_000,
  expansionNetHighLow: 0,
  contractionAboveSma50Ppm: 400_000,
  contractionNetHighLow: -50,
};

export interface RegimeInput {
  aboveSma50: Pick<Metric, "value_ppm" | "denominator"> | null;
  netHighLow: Pick<CountMetric, "value" | "denominator"> | null;
}

export interface RegimeResult {
  regime: Regime;
  /** Both inputs as used, so the label can be re-derived from the screen. */
  inputs: { aboveSma50Ppm: number | null; netHighLow: number | null };
  thresholds: RegimeThresholds;
  /** The rule, substituted — printed next to the label. */
  formula: string;
  /** Present only when the label is `unknown`. */
  reason?: "missing_sma50" | "missing_net_high_low";
}

/** Classify. Pure, total, and null-honest in both inputs. */
export function classifyRegime(
  input: RegimeInput,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): RegimeResult {
  const above = input.aboveSma50?.value_ppm ?? null;
  const net = input.netHighLow?.value ?? null;
  const inputs = { aboveSma50Ppm: above, netHighLow: net };

  const contraction =
    (above !== null && above <= thresholds.contractionAboveSma50Ppm) ||
    (net !== null && net < thresholds.contractionNetHighLow);

  if (contraction) {
    return { regime: "contraction", inputs, thresholds, formula: formulaLine(inputs, thresholds) };
  }
  if (above === null) {
    return {
      regime: "unknown",
      inputs,
      thresholds,
      formula: formulaLine(inputs, thresholds),
      reason: "missing_sma50",
    };
  }
  if (net === null) {
    return {
      regime: "unknown",
      inputs,
      thresholds,
      formula: formulaLine(inputs, thresholds),
      reason: "missing_net_high_low",
    };
  }
  const expansion = above >= thresholds.expansionAboveSma50Ppm && net > thresholds.expansionNetHighLow;
  return {
    regime: expansion ? "expansion" : "neutral",
    inputs,
    thresholds,
    formula: formulaLine(inputs, thresholds),
  };
}

function pct(ppm: number | null): string {
  return ppm === null ? "n/a" : `${(ppm / 10_000).toFixed(1)}%`;
}

/** The substituted rule, one line, for the panel to print verbatim. */
export function formulaLine(
  inputs: { aboveSma50Ppm: number | null; netHighLow: number | null },
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): string {
  return (
    `Expansion when above-SMA50 >= ${pct(thresholds.expansionAboveSma50Ppm)} and net high-low > ` +
    `${thresholds.expansionNetHighLow}; Contraction when above-SMA50 <= ${pct(thresholds.contractionAboveSma50Ppm)} ` +
    `or net high-low < ${thresholds.contractionNetHighLow}; otherwise Neutral. ` +
    `Yours: above-SMA50 ${pct(inputs.aboveSma50Ppm)}, net high-low ${inputs.netHighLow ?? "n/a"}.`
  );
}
