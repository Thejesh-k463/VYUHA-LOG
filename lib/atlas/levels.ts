/**
 * Grouping by classification LEVEL (v4.6.0 W5, owner rulings AQ6 / AQ21).
 *
 * Since W2 the taxonomy is the exchanges' own four levels (macro 12 / sector
 * 22 / industry 59 / basic 197). `groupByLevel` generalises `groupBySector`:
 * the caller hands in a levels-aware resolution (`getClassificationResolution()`
 * in lib/queries/instruments.ts, or a synthetic one in tests) and names the
 * level; this module never resolves a label itself.
 *
 * A symbol that carries NO label at the asked level is UNCLASSIFIED at that
 * level and is listed as such — it is never pushed into a group named by a
 * different level (a user's own sector tag has no industry, so at "industry"
 * it is unclassified rather than a sector-named row among industries). The
 * cohort's fall-UP from industry to sector is a different rule and lives in
 * `cohort.ts`, where the row says which level it used.
 *
 * PURE: no DB, no React, no clock.
 */
import type { GroupMembers, GroupingResult } from "./groups";
import type { ClassificationLevel, Series } from "./types";

/** What the levels-aware chain returns for one symbol. Any level may be blank. */
export interface ClassificationRef {
  macro: string | null;
  sector: string | null;
  industry: string | null;
  basic: string | null;
  /** `getClassificationResolution()`'s tier — "user" | taxonomy confidence | "index". */
  tier?: string;
  source?: string;
}

/** The label at one level, or null when the source stated none. */
export function levelLabel(ref: ClassificationRef | null | undefined, level: ClassificationLevel): string | null {
  if (!ref) return null;
  const v = ref[level];
  return v && v.trim() ? v.trim() : null;
}

/** The cohort levels a symbol CAN have, deepest first (AQ21: industry, falling up to sector). */
export function cohortLevelsFor(ref: ClassificationRef | null | undefined): ("industry" | "sector")[] {
  const out: ("industry" | "sector")[] = [];
  if (levelLabel(ref, "industry")) out.push("industry");
  if (levelLabel(ref, "sector")) out.push("sector");
  return out;
}

/** Group an anchor-aligned universe by the label at `level`, ascending by name. */
export function groupByLevel(
  series: Series[],
  level: ClassificationLevel,
  resolve: (symbol: string) => ClassificationRef | null,
): GroupingResult {
  const byGroup = new Map<string, GroupMembers>();
  const unclassified: string[] = [];
  for (const s of series) {
    const ref = resolve(s.symbol);
    const label = levelLabel(ref, level);
    if (!label) {
      unclassified.push(s.symbol);
      continue;
    }
    let g = byGroup.get(label);
    if (!g) {
      g = { group: label, members: [], tiers: {} };
      byGroup.set(label, g);
    }
    g.members.push(s);
    const tier = ref?.tier ?? "unknown";
    g.tiers[tier] = (g.tiers[tier] ?? 0) + 1;
  }
  const groups = [...byGroup.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  for (const g of groups) g.members.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { level, groups, unclassified: unclassified.sort() };
}

/** Group by a caller-supplied single label (the AMFI cap band, keyed by symbol). */
export function groupByLabel(
  series: Series[],
  labelOf: (symbol: string) => string | null,
  level: GroupingResult["level"],
): GroupingResult {
  const g = groupByLevel(series, "sector", (symbol) => {
    const label = labelOf(symbol);
    return label ? { macro: null, sector: label, industry: null, basic: null } : null;
  });
  return { ...g, level };
}
