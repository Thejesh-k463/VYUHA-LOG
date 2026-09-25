import { describe, expect, it } from "vitest";
import { buildClassificationResolution, buildSectorResolution } from "@/lib/analytics/instruments";
import { cohortLevelsFor, groupByLabel, groupByLevel, levelLabel, type ClassificationRef } from "@/lib/atlas/levels";
import { groupBySector } from "@/lib/atlas/groups";
import type { Series } from "@/lib/atlas/types";

/**
 * The levels-aware classification (v4.6.0 W5, AQ21 / contract §1.6).
 *
 * Two halves: `buildClassificationResolution` (lib/analytics, pure) carries the
 * exchanges' four levels where the source states them and leaves a user tag
 * sector-only so the cohort falls UP; `groupByLevel` (lib/atlas) groups an
 * aligned universe at one level and lists what has no label there.
 * `buildSectorResolution` is UNCHANGED — the parity case pins that.
 */

const DAY = 86_400_000;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + i * DAY).toISOString().slice(0, 10);
const series = (symbol: string, closes: number[]): Series => ({
  symbol,
  bars: closes.map((c, i) => ({ symbol, date: iso(i), high: c, low: c, close: c, volume: 1000 })),
});

const REFS: Record<string, ClassificationRef> = {
  HDFCBANK: { macro: "Financial Services", sector: "Financial Services", industry: "Banks", basic: "Private Sector Bank", tier: "high", source: "taxonomy" },
  ICICIBANK: { macro: "Financial Services", sector: "Financial Services", industry: "Banks", basic: "Private Sector Bank", tier: "high", source: "taxonomy" },
  BAJFINANCE: { macro: "Financial Services", sector: "Financial Services", industry: "Finance", basic: "Non Banking Financial Company (NBFC)", tier: "high", source: "taxonomy" },
  // A user's own tag: sector only.
  MYPICK: { macro: null, sector: "Financial Services", industry: null, basic: null, tier: "user", source: "user" },
};
const resolve = (s: string) => REFS[s] ?? null;
const universe = ["HDFCBANK", "ICICIBANK", "BAJFINANCE", "MYPICK", "NOBODY"].map((s) => series(s, [100, 101]));

describe("groupByLevel", () => {
  it("groups at the asked level and lists a symbol with no label THERE as unclassified", () => {
    const sector = groupByLevel(universe, "sector", resolve);
    expect(sector.level).toBe("sector");
    expect(sector.groups.map((g) => g.group)).toEqual(["Financial Services"]);
    expect(sector.groups[0].members.map((m) => m.symbol)).toEqual(["BAJFINANCE", "HDFCBANK", "ICICIBANK", "MYPICK"]);
    expect(sector.unclassified).toEqual(["NOBODY"]);

    const industry = groupByLevel(universe, "industry", resolve);
    expect(industry.groups.map((g) => g.group)).toEqual(["Banks", "Finance"]);
    // The user-tagged symbol has no industry: it is NOT pushed into a sector-named row among industries.
    expect(industry.unclassified).toEqual(["MYPICK", "NOBODY"]);
    expect(industry.groups[0].tiers).toEqual({ high: 2 });
  });

  it("groupBySector delegates to it — the shipped grouping is unchanged", () => {
    const viaSector = groupBySector(universe, (s) => (REFS[s] ? { sector: REFS[s].sector!, tier: REFS[s].tier } : null));
    const viaLevel = groupByLevel(universe, "sector", resolve);
    expect(viaSector.groups.map((g) => [g.group, g.members.map((m) => m.symbol), g.tiers])).toEqual(
      viaLevel.groups.map((g) => [g.group, g.members.map((m) => m.symbol), g.tiers]),
    );
    expect(viaSector.unclassified).toEqual(viaLevel.unclassified);
  });

  it("groupByLabel groups by a caller label (the AMFI band) and says so", () => {
    const g = groupByLabel(universe, (s) => (s === "HDFCBANK" || s === "ICICIBANK" ? "large" : s === "BAJFINANCE" ? "mid" : null), "cap");
    expect(g.level).toBe("cap");
    expect(g.groups.map((x) => [x.group, x.members.length])).toEqual([["large", 2], ["mid", 1]]);
    expect(g.unclassified).toEqual(["MYPICK", "NOBODY"]);
  });

  it("cohortLevelsFor lists industry then sector, and a user tag has only the sector to fall up to", () => {
    expect(cohortLevelsFor(REFS.HDFCBANK)).toEqual(["industry", "sector"]);
    expect(cohortLevelsFor(REFS.MYPICK)).toEqual(["sector"]);
    expect(cohortLevelsFor(null)).toEqual([]);
    expect(levelLabel(REFS.HDFCBANK, "basic")).toBe("Private Sector Bank");
    expect(levelLabel({ macro: null, sector: "  ", industry: null, basic: null }, "sector")).toBeNull();
  });
});

describe("buildClassificationResolution (lib/analytics)", () => {
  const taxonomy = [
    { isin: "INE040A01034", symbol: "HDFCBANK", sector: "Financial Services", confidence: "high" as const, macro: "Financial Services", industry: "Banks", basic: "Private Sector Bank" },
    { isin: "INE090A01021", symbol: "ICICIBANK", sector: "Financial Services", confidence: "high" as const, macro: "Financial Services", industry: "Banks", basic: "Private Sector Bank" },
    // A BSE-only company sharing a ticker with an Emerge one; the listing snapshot ranks the OTHER company first.
    { isin: "INE000B00001", symbol: "MAL", sector: "Chemicals", confidence: "medium" as const, macro: "Commodities", industry: "Chemicals & Petrochemicals", basic: "Specialty Chemicals" },
  ];
  const index = { KOTAKBANK: { industry: "Financial Services", isin: "INE237A01028" } };
  const sources = {
    taxonomy,
    index,
    isinBySymbol: (s: string) => (s === "MAL" ? "INE000A00009" : null), // MAL belongs to another issuer
  };

  it("carries the four levels from the taxonomy and only a sector from the index map", () => {
    const r = buildClassificationResolution([], sources);
    expect(r.get("HDFCBANK")).toEqual({
      macro: "Financial Services",
      sector: "Financial Services",
      industry: "Banks",
      basic: "Private Sector Bank",
      tier: "high",
      source: "taxonomy",
      raw: "Financial Services",
    });
    expect(r.get("KOTAKBANK")).toEqual({ macro: null, sector: "Financial Services", industry: null, basic: null, tier: "index", source: "index", raw: "Financial Services" });
  });

  it("a user tag is SECTOR ONLY — its industry is null, so the cohort falls up (AQ21)", () => {
    const r = buildClassificationResolution([{ symbol: "HDFCBANK", sector: "My Banks" }], sources);
    const hit = r.get("HDFCBANK")!;
    expect(hit.source).toBe("user");
    expect(hit.sector).toBe("My Banks");
    expect(hit.industry).toBeNull();
    expect(hit.basic).toBeNull();
    expect(hit.macro).toBeNull();
    expect(cohortLevelsFor(hit)).toEqual(["sector"]);
  });

  it("an untagged user row reaches the taxonomy through its ISIN, with all four levels", () => {
    const r = buildClassificationResolution([{ symbol: "HDFCBK-RENAMED", sector: null, isin: "INE040A01034" }], sources);
    expect(r.get("HDFCBK-RENAMED")?.industry).toBe("Banks");
  });

  it("the Emerge ticker collision stays issuer-guarded: another company's classification never lands on the ticker", () => {
    const r = buildClassificationResolution([], sources);
    expect(r.has("MAL")).toBe(false);
  });

  it("agrees with buildSectorResolution on every sector it resolves (the shipped chain is unchanged)", () => {
    const rows = [{ symbol: "HDFCBANK", sector: "My Banks" }, { symbol: "ZZZ", sector: null, isin: "INE090A01021" }];
    const sectors = buildSectorResolution(rows, sources);
    const levels = buildClassificationResolution(rows, sources);
    expect([...levels.keys()].sort()).toEqual([...sectors.keys()].sort());
    for (const [symbol, s] of sectors) {
      const l = levels.get(symbol)!;
      expect([l.sector, l.tier, l.source, l.raw]).toEqual([s.sector, s.tier, s.source, s.raw]);
    }
  });
});
