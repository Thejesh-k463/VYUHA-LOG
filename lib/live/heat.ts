/**
 * Live Desk — portfolio heat, exposure and concentration. PURE (invariant 2).
 * Spec §2.3, 03 §1.9, §10.3.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE (invariant 6): a portfolio-level
 * percentage has a denominator the user supplies, and when they have not
 * supplied it the answer is `null`. Not 0, not "0%", not a house default.
 * "0% of capital at risk" and "capital not configured" are opposite statements
 * and the desk must never print the first when it means the second — this is
 * the same rule `components/targets/target-equity-client.tsx:29-37` already
 * follows for the concentration meter.
 *
 * ROUNDING: heat FLOORS (spec §2.3 writes it as `Σ floor(openRiskP_i × 1e6 /
 * capitalP)`), and it floors PER ROW before summing, not once at the end. That
 * is deliberate and it is not the same number: flooring per row can only
 * understate heat, so the ceiling tick is never crossed by a rounding artefact.
 * All arithmetic is BigInt inside `ppmFloor` — `riskP × 1e6` leaves IEEE-754
 * integer range at a ~₹90 lakh risk figure.
 *
 * VYUHA ASSERTS NO CEILING. `heat_ceiling_ppm` ships NULL and stays NULL until
 * the user sets it; the familiar "6% portfolio heat" figure is trading lore,
 * not regulation. With no ceiling, `overCeiling` is null and the strip draws no
 * tick — an absent opinion, rendered as an absent mark.
 */

import { ppmFloor } from "./tracker-row";
import type { Paise, Ppm, Ratio } from "./types";

/** The minimum a row must expose to take part in heat and concentration. */
export interface HeatRow {
  id: number;
  /** `qty × (avgEntry − stop)`. null when the row has no stop recorded. */
  riskAtStopP: Paise | null;
  /** `qty × avgEntry` — what is deployed, regardless of any stop. */
  investedP: Paise;
  sector: string | null;
  sectorTier: string | null;
}

export interface HeatView {
  /** Σ floor(riskP_i / capitalP). null when capital is unconfigured. */
  heatPpm: Ppm | null;
  /** Σ riskAtStopP over the rows that HAVE a stop. Always a fact, never null. */
  openRiskP: Paise;
  /** Σ investedP over every row. */
  exposureP: Paise;
  /** exposureP / capitalP. null when capital is unconfigured. */
  exposure: Ratio;
  capitalP: Paise | null;
  /** The user's ceiling, or null when they have not set one. */
  ceilingPpm: Ppm | null;
  /** null when either heat or the ceiling is unknown — never a default `false`. */
  overCeiling: boolean | null;
  rowsCounted: number;
  /**
   * Rows with no stop recorded. They are EXCLUDED from heat and the count is
   * published: heat computed over a book where half the rows have no stop is
   * not "low heat", it is an incomplete measurement, and the strip says so.
   */
  rowsWithoutStop: number;
}

/**
 * Portfolio heat: the fraction of capital at risk if every open stop fills.
 *
 * @param rows      open positions, already reduced to `HeatRow`
 * @param capitalP  bucket/account capital in paise; null ⇒ heat is null
 * @param ceilingPpm the USER's ceiling, or null (the shipped state)
 */
export function portfolioHeat(rows: readonly HeatRow[], capitalP: Paise | null, ceilingPpm: Ppm | null = null): HeatView {
  const capital = capitalP !== null && capitalP > 0 ? capitalP : null;

  let openRiskP = 0;
  let exposureP = 0;
  let rowsWithoutStop = 0;
  let heatPpm: Ppm | null = capital === null ? null : 0;

  for (const r of rows) {
    exposureP += r.investedP;
    if (r.riskAtStopP === null) {
      rowsWithoutStop += 1;
      continue;
    }
    openRiskP += r.riskAtStopP;
    if (capital !== null && heatPpm !== null) {
      // Floor PER ROW, per spec §2.3, then sum. See the header note.
      heatPpm += ppmFloor(r.riskAtStopP, capital) ?? 0;
    }
  }

  const exposure: Ratio = { ppm: ppmFloor(exposureP, capital), denominator: capital };

  return {
    heatPpm,
    openRiskP,
    exposureP,
    exposure,
    capitalP: capital,
    ceilingPpm,
    overCeiling: heatPpm === null || ceilingPpm === null ? null : heatPpm > ceilingPpm,
    rowsCounted: rows.length,
    rowsWithoutStop,
  };
}

/** One concentration node, published with the constituent count and the tier. */
export interface ConcentrationRow {
  /** The sector/industry name, or null for the unclassified bucket. */
  group: string | null;
  /** `user | <taxonomy confidence> | index` — shown as a badge, never hidden. */
  tier: string | null;
  exposureP: Paise;
  /** exposureP / Σ exposureP. null when the book has no exposure at all. */
  share: Ratio;
  constituents: number;
}

/**
 * Sector/industry concentration: `Σ exposureP by node / Σ exposureP`.
 *
 * The denominator is the BOOK's own exposure, not capital — concentration
 * answers "how lopsided is what I hold", which is a question about the holdings.
 * An empty book, or a book whose rows all carry zero invested value, has no
 * denominator, so every share is null and the panel says the book is empty
 * rather than drawing an even split (invariant 6).
 *
 * Unclassified rows are their OWN node with `group: null`, never spread across
 * the classified ones and never silently dropped: dropping them would inflate
 * every other share, which is exactly the number a concentration meter exists
 * to be honest about.
 *
 * Rows are returned sorted by exposure descending, then group name, so the
 * order is stable for a virtualised list.
 */
export function sectorConcentration(rows: readonly HeatRow[]): ConcentrationRow[] {
  const totalP = rows.reduce((s, r) => s + r.investedP, 0);
  const byGroup = new Map<string, { group: string | null; tier: string | null; exposureP: Paise; constituents: number }>();

  for (const r of rows) {
    const key = r.sector ?? "\0unclassified";
    const node = byGroup.get(key) ?? { group: r.sector, tier: r.sectorTier, exposureP: 0, constituents: 0 };
    node.exposureP += r.investedP;
    node.constituents += 1;
    // Keep the FIRST tier seen for a node; a mixed-tier node keeps the tier of
    // its first row rather than inventing a blended confidence that has no
    // meaning in `lib/analytics/instruments.ts`.
    if (node.tier === null) node.tier = r.sectorTier;
    byGroup.set(key, node);
  }

  const denominator = totalP > 0 ? totalP : null;
  return [...byGroup.values()]
    .map((n) => ({
      group: n.group,
      tier: n.tier,
      exposureP: n.exposureP,
      share: { ppm: ppmFloor(n.exposureP, denominator), denominator } as Ratio,
      constituents: n.constituents,
    }))
    .sort((a, b) => b.exposureP - a.exposureP || (a.group ?? "").localeCompare(b.group ?? ""));
}
