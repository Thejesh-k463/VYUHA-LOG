/**
 * A8 / A9 / A12 — equal-weighted group return, group breadth, classification
 * coverage. The grouping key is whatever `getSectorResolution()` resolved for
 * the symbol (user tag > taxonomy > index label); this module never resolves a
 * sector itself, it is handed a lookup.
 *
 * Every row publishes its CONSTITUENT COUNT and its COVERAGE over the group's
 * members, because "Pharma +3.1%" computed from 2 of 41 constituents is a
 * different claim from the same number over 39 of 41.
 *
 * Current classification only. `sector-map.json` carries ONE clock (`asOf`)
 * and no per-row `effective_at`, so a historical replay of these rows would be
 * survivorship-biased — which is why A11 replays price metrics only.
 */
import { computeBreadth, type BreadthResult } from "./breadth";
import { computeReturns, type CaGap } from "./returns";
import { meanMetric, shareMetric, type Metric, type ReturnWindowKey, type SectorRef, type Series } from "./types";

export interface GroupMembers {
  group: string;
  members: Series[];
  /** Tier counts (`user` / taxonomy confidence / `index`) for the row's badge. */
  tiers: Record<string, number>;
}

export interface GroupingResult {
  groups: GroupMembers[];
  unclassified: string[];
}

/** Group an anchor-aligned universe by resolved sector, ascending by name. */
export function groupBySector(series: Series[], sectorOf: (symbol: string) => SectorRef | null): GroupingResult {
  const byGroup = new Map<string, GroupMembers>();
  const unclassified: string[] = [];
  for (const s of series) {
    const ref = sectorOf(s.symbol);
    if (!ref || !ref.sector) {
      unclassified.push(s.symbol);
      continue;
    }
    let g = byGroup.get(ref.sector);
    if (!g) {
      g = { group: ref.sector, members: [], tiers: {} };
      byGroup.set(ref.sector, g);
    }
    g.members.push(s);
    const tier = ref.tier ?? "unknown";
    g.tiers[tier] = (g.tiers[tier] ?? 0) + 1;
  }
  const groups = [...byGroup.values()].sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  for (const g of groups) g.members.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { groups, unclassified: unclassified.sort() };
}

export interface GroupReturnRow {
  group: string;
  window: ReturnWindowKey;
  sessions: number;
  /** Equal-weighted arithmetic mean of the valid constituent returns. */
  metric: Metric;
  /** Constituents that produced a return. */
  constituents: number;
  /** Members of the group at the anchor. */
  members: number;
  tiers: Record<string, number>;
  corporateActionExcluded: string[];
  insufficient: string[];
}

/** A8 for one window. Coverage is over the group's own membership, not the market. */
export function computeGroupReturns(
  grouping: GroupingResult,
  window: { key: ReturnWindowKey; sessions: number },
  gapsBySymbol: Map<string, CaGap[]> = new Map(),
): GroupReturnRow[] {
  const rows: GroupReturnRow[] = [];
  for (const g of grouping.groups) {
    const per = computeReturns(g.members, g.members.length, gapsBySymbol, [window])[window.key];
    rows.push({
      group: g.group,
      window: window.key,
      sessions: window.sessions,
      metric: per.metric,
      constituents: per.metric.denominator,
      members: g.members.length,
      tiers: g.tiers,
      corporateActionExcluded: per.corporateActionExcluded,
      insufficient: per.insufficient,
    });
  }
  return rows;
}

export interface GroupBreadthRow {
  group: string;
  /** A9: advancing / (advancing + declining + unchanged) valid constituents. */
  advancing: Metric;
  breadth: BreadthResult;
  members: number;
  tiers: Record<string, number>;
}

/** A9 per group. */
export function computeGroupBreadth(grouping: GroupingResult): GroupBreadthRow[] {
  return grouping.groups.map((g) => {
    const breadth = computeBreadth(g.members, g.members.length);
    return { group: g.group, advancing: breadth.advancing, breadth, members: g.members.length, tiers: g.tiers };
  });
}

export interface ClassificationCoverage {
  /** A12: classified share of the anchor-aligned universe. */
  classified: Metric;
  groups: number;
  unclassified: string[];
  tiers: Record<string, number>;
}

/** A12 — how much of the universe the bundled map could name, and from where. */
export function classificationCoverage(grouping: GroupingResult, universe: number): ClassificationCoverage {
  const tiers: Record<string, number> = {};
  let classified = 0;
  for (const g of grouping.groups) {
    classified += g.members.length;
    for (const [tier, n] of Object.entries(g.tiers)) tiers[tier] = (tiers[tier] ?? 0) + n;
  }
  return {
    classified: shareMetric(classified, universe, universe),
    groups: grouping.groups.length,
    unclassified: grouping.unclassified,
    tiers,
  };
}

/** The market-wide equal-weighted mean of a set of group values, for a rotation summary. */
export function meanOfGroups(rows: GroupReturnRow[]): Metric {
  const values = rows.map((r) => r.metric.value_ppm).filter((v): v is number => v !== null);
  return meanMetric(values, rows.length);
}
