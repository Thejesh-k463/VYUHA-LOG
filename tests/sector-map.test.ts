import { describe, expect, it } from "vitest";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import sectorMapFile from "@/lib/data/sector-map.json";
import {
  buildSectorMap,
  buildSectorResolution,
  canonicalSector,
  SECTOR_ALIASES,
  SECTOR_MAP_AS_OF,
  SECTOR_MAP_COUNT,
  taxonomyByIsin,
  taxonomyEntries,
  taxonomySectors,
  type SectorSources,
} from "@/lib/analytics/instruments";
import { sectorConcentration } from "@/lib/analytics/exposure";

/**
 * The bundled sector taxonomy (lib/data/sector-map.json) and the chain that
 * consumes it: user tag → taxonomy by ISIN → index map industry, with the
 * legacy/punctuation forks of NSE's sector labels collapsed onto one spelling.
 *
 * Two things are pinned deliberately:
 *   • the snapshot is a DATED, PROVENANCED file — a hand-edited row would
 *     have no sha256 to stand behind it;
 *   • adding the confidence summary to sectorConcentration changed NO
 *     existing number — the fixture and expectations below are copied from
 *     tests/exposure.test.ts verbatim.
 */

const file = sectorMapFile as {
  asOf: string;
  provenance: { file: string; sha256: string; rows: number; classified: number; excluded: number; dropped: number; legend: Record<string, string>; sources: { byConfidence: Record<string, number> } };
  fields: { taxonomy: string[]; byIsin: string[] };
  taxonomy: Record<string, string[]>;
  byIsin: Record<string, string[]>;
  sectorAliases: Record<string, string>;
};

describe("sector-map.json — a dated, provenanced snapshot", () => {
  it("records where it came from", () => {
    expect(SECTOR_MAP_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(file.provenance.file).toBe("classification-reconciliation-multisource.csv");
    expect(file.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.provenance.rows).toBe(file.provenance.classified + file.provenance.excluded + file.provenance.dropped);
    expect(file.fields.byIsin).toEqual(["sym", "bse", "code", "conf", "src"]);
    expect(file.fields.taxonomy).toEqual(["macro", "sector", "industry", "basic"]);
  });

  it("classifies the whole reconciled universe, every row expandable", () => {
    expect(SECTOR_MAP_COUNT).toBe(file.provenance.classified);
    expect(SECTOR_MAP_COUNT).toBeGreaterThanOrEqual(2200);
    const legend = new Set(Object.values(file.provenance.legend));
    let n = 0;
    for (const e of taxonomyEntries()) {
      n++;
      expect(e.sector).toBeTruthy();
      expect(["high", "medium_high", "medium"]).toContain(e.confidence);
      expect(legend.has(e.source)).toBe(true);
      expect(e.symbol).toMatch(/^[A-Z0-9&*-]+$/);
    }
    expect(n).toBe(SECTOR_MAP_COUNT);
    // Every confidence tier on the sheet is represented.
    expect(Object.keys(file.provenance.sources.byConfidence).sort()).toEqual(["high", "medium", "medium_high"]);
  });

  it("expands a row through the normalised taxonomy table", () => {
    // ABB India: a high-visibility name whose four labels are stable.
    const abb = taxonomyByIsin("ine117a01022");
    expect(abb).toMatchObject({ symbol: "ABB", bseCode: "500002", sector: "Capital Goods", industry: "Electrical Equipment" });
    expect(abb?.code).toMatch(/^IN\d+$/);
    expect(taxonomyByIsin("INE000000000")).toBeNull();
    expect(taxonomyByIsin("")).toBeNull();
  });
});

describe("sectorAliases — the forks collapse onto the taxonomy's spelling", () => {
  const sectors = new Set(taxonomySectors());

  it("maps every alias onto a real taxonomy sector, and no alias key is one", () => {
    expect(Object.keys(SECTOR_ALIASES).length).toBeGreaterThanOrEqual(8);
    for (const [from, to] of Object.entries(SECTOR_ALIASES)) {
      expect(sectors.has(to), `${from} → ${to}`).toBe(true);
      expect(sectors.has(from), `${from} is itself a sector`).toBe(false);
    }
  });

  it("canonicalises the legacy, punctuation and case forks", () => {
    expect(canonicalSector("AUTOMOBILE")).toBe("Automobile and Auto Components");
    expect(canonicalSector("CEMENT & CEMENT PRODUCTS")).toBe("Construction Materials");
    expect(canonicalSector("Oil Gas & Consumable Fuels")).toBe("Oil, Gas & Consumable Fuels");
    expect(canonicalSector("Media Entertainment & Publication")).toBe("Media, Entertainment & Publication");
    expect(canonicalSector("POWER")).toBe("Power");
    expect(canonicalSector(" power ")).toBe("Power");
    expect(canonicalSector("financial services")).toBe("Financial Services");
  });

  it("passes a user's own label through untouched", () => {
    expect(canonicalSector("IT")).toBe("IT");
    expect(canonicalSector("  Energy ")).toBe("Energy");
    expect(canonicalSector("")).toBeNull();
    expect(canonicalSector(null)).toBeNull();
  });

  it("covers every industry label the bundled index map carries", () => {
    const symbols = (nseIndexMap as { symbols: Record<string, { industry: string | null }> }).symbols;
    const stray = new Set<string>();
    for (const m of Object.values(symbols)) {
      if (m.industry && !sectors.has(canonicalSector(m.industry)!)) stray.add(m.industry);
    }
    expect([...stray]).toEqual([]);
  });
});

describe("the sector chain: user → taxonomy → index", () => {
  const sources: SectorSources = {
    taxonomy: [
      { isin: "INE0000A0001", symbol: "AAA", sector: "Power", confidence: "medium" },
      { isin: "INE0000B0002", symbol: "BBB", sector: "Oil, Gas & Consumable Fuels", confidence: "high" },
      { isin: "INE0000E0005", symbol: "EEE", sector: "Textiles", confidence: "medium_high" },
    ],
    index: {
      AAA: { industry: "POWER" },
      BBB: { industry: "OIL & GAS" },
      CCC: { industry: "Media Entertainment & Publication" },
    },
    // The listing snapshot knows BBB under a newer ticker.
    symbolByIsin: (isin) => (isin === "INE0000B0002" ? "BBB2" : null),
    isinBySymbol: (symbol) => (symbol === "EEE" ? "INE0000E0005" : null),
  };
  const rows = [
    { symbol: "aaa", sector: "My Own Bucket", isin: null },
    { symbol: "DDD", sector: null, isin: "INE0000A0001" }, // untagged, reaches the taxonomy via its ISIN
    { symbol: "EEE", sector: null, isin: null }, // untagged, no ISIN stated — found via isinBySymbol
    { symbol: "FFF", sector: "automobile", isin: null }, // user tag in a legacy spelling
  ];
  const r = buildSectorResolution(rows, sources);

  it("lets the user's own tag win, canonicalised but never replaced", () => {
    expect(r.get("AAA")).toEqual({ sector: "My Own Bucket", tier: "user", source: "user", raw: "My Own Bucket" });
    expect(r.get("FFF")).toEqual({ sector: "Automobile and Auto Components", tier: "user", source: "user", raw: "automobile" });
  });

  it("re-keys a taxonomy ISIN to the ticker the app uses, taxonomy over index", () => {
    expect(r.get("BBB2")).toEqual({ sector: "Oil, Gas & Consumable Fuels", tier: "high", source: "taxonomy", raw: "Oil, Gas & Consumable Fuels" });
    // The index map's BBB entry stays as the weakest tier for that spelling.
    expect(r.get("BBB")).toMatchObject({ sector: "Oil, Gas & Consumable Fuels", tier: "index" });
  });

  it("reaches the taxonomy for an untagged row through its ISIN, stated or found", () => {
    expect(r.get("DDD")).toMatchObject({ sector: "Power", tier: "medium", source: "taxonomy" });
    expect(r.get("EEE")).toMatchObject({ sector: "Textiles", tier: "medium_high", source: "taxonomy" });
  });

  it("falls back to the index map, with the fork collapsed", () => {
    expect(r.get("CCC")).toEqual({ sector: "Media, Entertainment & Publication", tier: "index", source: "index", raw: "Media Entertainment & Publication" });
  });

  it("buildSectorMap without sources is the pre-v3.8 behaviour; with sources it runs the chain", () => {
    expect([...buildSectorMap(rows).entries()]).toEqual([["AAA", "My Own Bucket"], ["FFF", "automobile"]]);
    const full = buildSectorMap(rows, sources);
    expect(full.get("CCC")).toBe("Media, Entertainment & Publication");
    expect(full.get("DDD")).toBe("Power");
    expect(full.get("FFF")).toBe("Automobile and Auto Components");
  });
});

describe("sectorConcentration — confidence summary changes no existing number", () => {
  const capital = 1_000_000;
  // Verbatim from tests/exposure.test.ts: two banks (60k + 40k) vs one IT (50k) and one unmapped (50k).
  const legacy = [
    { invested: 60000, sector: "Financials" },
    { invested: 40000, sector: "Financials" },
    { invested: 50000, sector: "IT" },
    { invested: 50000, sector: null },
  ];
  const pin = (s: ReturnType<typeof sectorConcentration>) => {
    expect(s.totalInvested).toBe(200000);
    expect(s.slices.map((x) => x.sector)).toEqual(["Financials", "IT", "Unclassified"]);
    expect(s.slices[0]).toMatchObject({ invested: 100000, allocPct: 10, sharePct: 50, positions: 2 });
    expect(s.topSector).toBe("Financials");
    expect(s.topAllocPct).toBe(10);
    expect(s.classifiedPct).toBe(75);
    expect(s.hhi).toBeCloseTo(0.375, 4);
  };

  it("a caller that states no tiers gets the same numbers and an 'unknown' tier", () => {
    const s = sectorConcentration(legacy, capital);
    pin(s);
    expect(s.confidence.tierPct.unknown).toBe(75);
    expect(s.confidence.mediumPct).toBe(0);
    expect(s.confidence.weakestTier).toBe("unknown");
    expect(s.slices.map((x) => x.minTier)).toEqual(["unknown", "unknown", null]);
  });

  it("attributes classified capital to the tier its sector rests on", () => {
    const tiered = [
      { invested: 60000, sector: "Financials", sectorTier: "user" as const },
      { invested: 40000, sector: "Financials", sectorTier: "medium" as const },
      { invested: 50000, sector: "IT", sectorTier: "high" as const },
      { invested: 50000, sector: null, sectorTier: null },
    ];
    const s = sectorConcentration(tiered, capital);
    pin(s);
    expect(s.confidence.tierPct).toEqual({ user: 30, high: 25, medium_high: 0, medium: 20, index: 0, unknown: 0 });
    expect(s.confidence.mediumPct).toBe(20);
    expect(s.confidence.weakestTier).toBe("medium");
    // A bucket is only as strong as its weakest position.
    expect(s.slices[0].minTier).toBe("medium");
    expect(s.slices[1].minTier).toBe("high");
    expect(s.slices[2].minTier).toBeNull();
  });
});
