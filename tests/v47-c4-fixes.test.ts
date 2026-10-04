import { describe, expect, it } from "vitest";
import { buildClassificationResolution, buildSectorResolution } from "@/lib/analytics/instruments";
import { changedFields } from "@/components/risk/risk-edit-dialog";

/**
 * v4.7.0 wave C4 fix 3 — the risk editor posts ONLY the fields the user changed.
 *
 * The `/live` card holds levels as paise and pre-fills a stored REAL 1450.125 as
 * "1450.13"; posting every level on every save rewrote it although the user
 * typed nothing (invariant 1). The route writes only the keys present, so an
 * unsent field keeps its stored value exactly. The end-to-end proof (real card →
 * real dialog → real route → temp DB) is S1/S2 in tests/seams-v47-c4.test.ts.
 */
describe("changedFields — the risk editor's POST body", () => {
  const initial = { originalSl: "1450.13", trailingSl: "1475.56", target: "1600.01" };

  it("untouched: null — the dialog sends no request at all", () => {
    expect(changedFields({ tradeId: 303, ...initial }, initial)).toBeNull();
  });

  it("a target-only edit sends ONLY the target (the rounded stops are never re-posted)", () => {
    expect(changedFields({ tradeId: 303, ...initial, target: "1650" }, initial)).toEqual({ tradeId: 303, target: "1650" });
  });

  it("a cleared field is sent as \"\" (the route's clear); an edit typed back to the original is not a change", () => {
    expect(changedFields({ tradeId: 7, ...initial, trailingSl: "" }, initial)).toEqual({ tradeId: 7, trailingSl: "" });
    expect(changedFields({ tradeId: 7, ...initial, originalSl: "1450.13" }, initial)).toBeNull();
  });

  it("/risk's mark and IV follow the same rule", () => {
    const withMark = { ...initial, mtmPrice: "1500", impliedVol: "" };
    expect(changedFields({ tradeId: 9, ...withMark }, withMark)).toBeNull();
    expect(changedFields({ tradeId: 9, ...withMark, mtmPrice: "1512.5" }, withMark)).toEqual({ tradeId: 9, mtmPrice: "1512.5" });
    expect(changedFields({ tradeId: 9, ...withMark, impliedVol: "18", originalSl: "1440" }, withMark)).toEqual({
      tradeId: 9,
      originalSl: "1440",
      impliedVol: "18",
    });
  });
});

/**
 * v4.7.0 wave C4 fix 4 — an AGREEING sector tag keeps the taxonomy's levels.
 *
 * The NSE-map merge (`app/api/instruments/route.ts`, COALESCE) writes the index
 * map's label into `instruments.sector`; on the owner's real journal every one
 * of 1,379 instruments carries such a value, so treating EVERY tag as a user
 * override made the Industry view fall up to the sector for every symbol (and
 * the Atlas's industry cohorts with it). W5's rule (DECISIONS: "a user tag
 * REPLACES the taxonomy row — never the taxonomy's industry under a sector the
 * user DISAGREED with") is about disagreement: a tag whose CANONICAL sector
 * equals the taxonomy's for the row's ISIN keeps the taxonomy row. A tag that
 * differs stays the user's sector-only override. Nothing in the DB changes.
 */

const taxonomy = [
  { isin: "INE467B01029", symbol: "TCS", sector: "Information Technology", confidence: "high" as const, macro: "Information Technology", industry: "IT - Services", basic: "Computers - Software & Consulting" },
  { isin: "INE040A01034", symbol: "HDFCBANK", sector: "Financial Services", confidence: "high" as const, macro: "Financial Services", industry: "Banks", basic: "Private Sector Bank" },
];
// The legacy ALL-CAPS label is an alias of the modern one — the tag the index map wrote.
const aliases = { "INFORMATION TECHNOLOGY": "Information Technology", IT: "Information Technology" } as Record<string, string>;
const sources = {
  taxonomy,
  aliases,
  isinBySymbol: (s: string) => (s === "TCS" ? "INE467B01029" : s === "HDFCBANK" ? "INE040A01034" : null),
};

describe("buildClassificationResolution — a tag that agrees with the taxonomy keeps its levels", () => {
  it("agree (by the snapshot's ISIN, through an alias): the taxonomy row, industry kept", () => {
    const r = buildClassificationResolution([{ symbol: "TCS", sector: "IT" }], sources);
    expect(r.get("TCS")).toEqual({
      macro: "Information Technology",
      sector: "Information Technology",
      industry: "IT - Services",
      basic: "Computers - Software & Consulting",
      tier: "high",
      source: "taxonomy",
      raw: "Information Technology",
    });
  });

  it("agree by the ROW's own ISIN (a ticker the snapshot does not know)", () => {
    const r = buildClassificationResolution([{ symbol: "HDFC-OLD", sector: "Financial Services", isin: "INE040A01034" }], sources);
    expect(r.get("HDFC-OLD")?.industry).toBe("Banks");
    expect(r.get("HDFC-OLD")?.source).toBe("taxonomy");
  });

  it("disagree: the user's sector-only row, exactly as before", () => {
    const r = buildClassificationResolution([{ symbol: "TCS", sector: "My Own Bucket" }], sources);
    expect(r.get("TCS")).toEqual({ macro: null, sector: "My Own Bucket", industry: null, basic: null, tier: "user", source: "user", raw: "My Own Bucket" });
  });

  it("no ISIN anywhere: a tag stays the user's row (nothing to agree with)", () => {
    const r = buildClassificationResolution([{ symbol: "ZZNOISIN", sector: "Information Technology" }], sources);
    expect(r.get("ZZNOISIN")).toEqual({
      macro: null,
      sector: "Information Technology",
      industry: null,
      basic: null,
      tier: "user",
      source: "user",
      raw: "Information Technology",
    });
  });

  it("an agreeing tag resolves to the SAME sector as the shipped sector chain", () => {
    const rows = [{ symbol: "TCS", sector: "IT" }];
    expect(buildClassificationResolution(rows, sources).get("TCS")?.sector).toBe(buildSectorResolution(rows, sources).get("TCS")?.sector);
  });
});
