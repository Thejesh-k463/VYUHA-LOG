"use client";

import { formatPaise } from "@/lib/money";
import { num } from "@/lib/format";
import type { SizeResult, SizingFormula } from "@/lib/risk/sizing";

/**
 * The formula-with-substitution block (03 §6.3) — the single element that
 * makes the Lab a calculator rather than a black box.
 *
 * Two monospace lines: the symbolic form, then the SAME form with the user's
 * own figures substituted. Both come from `SizeResult.formula`, which
 * `lib/risk/sizing.ts` emits from the very expression it computed with — so a
 * printed formula cannot drift from the number beside it. Nothing is
 * re-derived here; this file only decides how each value is written down.
 */

/** Keys whose values are integer paise (the `P` suffix convention in lib/risk). */
const PAISE_KEY = /P$/;
/** Keys carried as ppm integers. */
const PPM_KEY = /Ppm$/;
/** Keys carried per-thousand. */
const PERMILLE_KEY = /Permille$/;
/** ATR is carried as paise × 1000. */
const P3_KEY = /^atrP3$/;

function renderValue(key: string, value: number): string {
  if (P3_KEY.test(key)) return formatPaise(Math.floor(value / 1000));
  if (PAISE_KEY.test(key)) return formatPaise(value, { decimals: 0 });
  if (PPM_KEY.test(key)) return `${num(value / 10_000, 2)}%`;
  if (PERMILLE_KEY.test(key)) return `${num(value / 1000, 2)} N`;
  return num(value, 0);
}

/**
 * The substituted line: `key = value` pairs in the order the pure module put
 * them in, which is the order they appear in the symbolic expression.
 */
export function substitutedLine(formula: SizingFormula): string {
  return Object.entries(formula.values)
    .map(([k, v]) => `${k} = ${renderValue(k, v)}`)
    .join("   ");
}

const ERROR_COPY: Record<string, string> = {
  "non-positive-entry": "Entry price has to be above zero for this arithmetic to exist.",
  "non-positive-risk-per-share":
    "Entry and stop are the same price, so risk per share is zero and there is nothing to divide by.",
  "capital-unconfigured": "Capital is not set, so there is no denominator to take a fraction of.",
  "non-positive-amount": "This method needs a rupee amount to allocate.",
  "non-positive-atr": "This method needs an ATR above zero.",
  "non-positive-lot-size": "Lot size has to be at least 1.",
  "non-positive-payoff": "Kelly needs a payoff in R above zero.",
  "non-positive-delta": "Fixed ratio needs a delta above zero.",
  "non-positive-block-qty": "Fixed ratio needs a block quantity above zero.",
  "non-positive-slots": "Equal weight needs at least one slot.",
};

export function FormulaBlock({ result }: { result: SizeResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-md border border-border bg-muted/[0.06] p-3 font-mono text-xs text-muted-foreground">
        {ERROR_COPY[result.error ?? ""] ?? "This method cannot be computed from the numbers entered."}
      </div>
    );
  }
  return (
    <div className="select-text space-y-1 rounded-md border border-border bg-muted/[0.06] p-3 font-mono text-xs">
      <div className="text-muted-foreground">{result.formula.symbolic}</div>
      <div className="text-foreground">{substitutedLine(result.formula)}</div>
    </div>
  );
}
