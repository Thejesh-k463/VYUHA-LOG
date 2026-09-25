/**
 * Regime thresholds as a SETTING (v4.6.0 W5, owner ruling AQ13): parse the
 * stored JSON, validate an edit, serialise for the column.
 *
 * Stored shape: `settings.atlas_regime_thresholds`, a versioned envelope
 * `{v:1, expansionAboveSma50Ppm, expansionNetHighLow, contractionAboveSma50Ppm,
 * contractionNetHighLow}` or NULL (= `DEFAULT_REGIME_THRESHOLDS`). A shape from
 * another version is DISCARDED, never half-read (the AGENTS.md stored-JSON rule).
 *
 * The label itself is never stored under a threshold: `getVerifiedSnapshot()`
 * re-derives it from the payload's inputs with the CURRENT thresholds (design
 * review A3), so an edit here changes the screen on the next read without a
 * recompute, and the page and GET /api/atlas agree.
 *
 * PURE: no DB, no React.
 */
import { DEFAULT_REGIME_THRESHOLDS, type RegimeThresholds } from "./regime";

export const REGIME_THRESHOLDS_VERSION = 1 as const;

/** Both ppm figures live on [0, 1_000_000]. */
export const REGIME_PPM_MAX = 1_000_000;

const KEYS: readonly (keyof RegimeThresholds)[] = [
  "expansionAboveSma50Ppm",
  "expansionNetHighLow",
  "contractionAboveSma50Ppm",
  "contractionNetHighLow",
];

/** Coerce one field from a stored blob or a request body: a finite number, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The four numbers out of any object, or null when one is missing or not a number. */
export function thresholdsFromObject(o: unknown): RegimeThresholds | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const out: Partial<RegimeThresholds> = {};
  for (const k of KEYS) {
    const n = num(r[k]);
    if (n === null) return null;
    out[k] = n;
  }
  return out as RegimeThresholds;
}

/** The stored column → thresholds, or null (= defaults) for NULL, alien or corrupt. */
export function parseRegimeThresholds(json: string | null | undefined): RegimeThresholds | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { v?: unknown };
    if (parsed?.v !== REGIME_THRESHOLDS_VERSION) return null;
    const t = thresholdsFromObject(parsed);
    return t && validateRegimeThresholds(t) === null ? t : null;
  } catch {
    return null;
  }
}

/**
 * Why an edit is refused, in the user's words, or null when it is sound:
 * both ppm figures on [0, 1_000_000]; the net high-low bounds integers; and
 * each contraction bound strictly BELOW its expansion bound, or the two rules
 * overlap and a market could be both at once.
 */
export function validateRegimeThresholds(t: RegimeThresholds): string | null {
  for (const k of ["expansionAboveSma50Ppm", "contractionAboveSma50Ppm"] as const) {
    if (!Number.isFinite(t[k]) || t[k] < 0 || t[k] > REGIME_PPM_MAX) {
      return `${k} must be between 0 and ${REGIME_PPM_MAX.toLocaleString("en-IN")} ppm (0% to 100%).`;
    }
  }
  for (const k of ["expansionNetHighLow", "contractionNetHighLow"] as const) {
    if (!Number.isInteger(t[k])) return `${k} must be a whole number of symbols.`;
  }
  if (!(t.contractionAboveSma50Ppm < t.expansionAboveSma50Ppm)) {
    return "The contraction ceiling for above-SMA50 must be below the expansion floor, or a market could be both at once.";
  }
  if (!(t.contractionNetHighLow < t.expansionNetHighLow)) {
    return "The contraction ceiling for net high-low must be below the expansion floor, or a market could be both at once.";
  }
  return null;
}

/** The column value for a set of thresholds — always the versioned envelope. */
export function serializeRegimeThresholds(t: RegimeThresholds): string {
  return JSON.stringify({
    v: REGIME_THRESHOLDS_VERSION,
    expansionAboveSma50Ppm: t.expansionAboveSma50Ppm,
    expansionNetHighLow: t.expansionNetHighLow,
    contractionAboveSma50Ppm: t.contractionAboveSma50Ppm,
    contractionNetHighLow: t.contractionNetHighLow,
  });
}

/** True when the thresholds equal the shipped defaults (so the UI can say "defaults"). */
export function isDefaultRegimeThresholds(t: RegimeThresholds): boolean {
  return KEYS.every((k) => t[k] === DEFAULT_REGIME_THRESHOLDS[k]);
}
