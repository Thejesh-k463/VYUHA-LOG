/**
 * VYUHA INTELLIGENCE — the insight contract.
 *
 * Every "second brain" line the app shows is an `Insight` produced by a pure
 * rule. The contract IS the honesty policy, enforced by
 * tests/intelligence-contract.test.ts:
 *
 *  1. DESCRIPTIVE, NEVER PRESCRIPTIVE. An insight states what the record
 *     shows ("your after-loss expectancy is negative"), never an instruction
 *     ("you should stop trading after a loss"). The cockpit's banned-phrase
 *     regex applies to every rule's output, not just Arjun's Eye.
 *  2. NO FINDING BELOW ITS SAMPLE FLOOR. A rule returns null rather than a
 *     confident claim on seven trades. Floors are per-rule and stated on the
 *     rule so the UI can say what would unlock the insight.
 *  3. COVERAGE IS PART OF THE CLAIM. A rule computed on a subset (only trades
 *     with a recorded stop, only timed trades) carries `coverage` and the UI
 *     renders it — "SL recorded on 12 of 40 losers" travels WITH the number.
 *  4. NUMBERS LIVE IN `evidence`, PROSE POINTS AT THEM. Any future narrator
 *     (template, local model, API) rephrases an Insight; it never computes.
 *     A narrator cannot hallucinate a rupee that isn't in the fact object.
 *  5. NO INSTRUMENT ADVICE. There is no rule shape that can emit "buy/sell
 *     <scrip>" or any forward-looking recommendation — insights describe the
 *     user's own recorded history (the same line lib/analytics/tax-levers.ts
 *     draws, and the SEBI IA/RA-safe one).
 *
 * This module is PURE (invariant 2): no DB, no React. Rule inputs are fetched
 * by pages/queries and passed in.
 */

export type InsightTone = "good" | "warn" | "info";

/** What a rule computed on a SUBSET, stated with the claim (contract rule 3). */
export interface InsightCoverage {
  /** Rows the rule could actually read (e.g. losers with a recorded SL). */
  have: number;
  /** Rows in the population the reader will assume. */
  of: number;
  /** What was counted — "losing trades with a stop recorded". */
  noun: string;
}

/** One evidence figure. `value` is pre-formatted — Insights cross the RSC
 *  boundary, so everything is strings (the KpiDetail convention). */
export interface InsightEvidence {
  label: string;
  value: string;
  tone?: InsightTone;
}

export interface Insight {
  /** Stable rule id, kebab-case — "tilt-after-loss", "sl-slippage". */
  id: string;
  tone: InsightTone;
  /** One sentence, descriptive. The claim. */
  headline: string;
  /** Optional second sentence of context — still descriptive. */
  detail?: string;
  evidence: InsightEvidence[];
  /** Historical observation phrased as fact, never instruction. */
  suggestion?: string;
  /** Closed observations the claim rests on. */
  sampleSize: number;
  coverage?: InsightCoverage;
}

/** A registered rule over some input shape. Rules are data — the registry is
 *  what lets one contract test hold every insight to the same bar. */
export interface InsightRule<I> {
  id: string;
  /** What the rule watches, for help surfaces — noun phrase. */
  watches: string;
  /** Below this many qualifying observations the rule refuses (returns null). */
  sampleFloor: number;
  compute: (input: I) => Insight | null;
}

/** Run a registry in order; rules refuse individually, order is presentation order. */
export function runRules<I>(rules: readonly InsightRule<I>[], input: I): Insight[] {
  const out: Insight[] = [];
  for (const r of rules) {
    const insight = r.compute(input);
    if (insight) out.push({ ...insight, id: r.id });
  }
  return out;
}

/** "12 of 40 losing trades" — the coverage sentence fragment, one way. */
export function coverageText(c: InsightCoverage): string {
  return `${c.have} of ${c.of} ${c.noun}`;
}

/**
 * The banned-phrase regex, shared with tests. Matches PRESCRIPTIVE language —
 * imperatives and advice verbs. Descriptive contrasts ("historically, …",
 * "your record shows…") pass.
 */
export const PRESCRIPTIVE_LANGUAGE = /\byou should\b|\bmust\b|\bstop doing\b|\bavoid\b|\bnever trade\b|\balways trade\b|\bwe recommend\b|\bconsider (?:buying|selling|exiting)\b/i;

/** Every text field a contract test should scan on an Insight. */
export function insightTexts(i: Insight): string[] {
  return [i.headline, i.detail ?? "", i.suggestion ?? "", ...i.evidence.map((e) => `${e.label} ${e.value}`)];
}
