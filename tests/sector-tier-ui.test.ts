import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  sectorConcentration,
  sectorConfidenceSentence,
  sectorTierMarker,
  SECTOR_CONFIDENCE_PREFIX,
  SECTOR_TIER_ORDER,
} from "@/lib/analytics/exposure";

/**
 * v3.8 Wave 3 — the sector confidence tier reaches the screen.
 *
 * Wave 2 taught sectorConcentration to carry a tier per position and to
 * summarise them (`confidence`), but nothing passed `sectorTier`, so every
 * tier read "unknown". Owner ruling: show the tier WHERE concentration is
 * displayed, no new screens. That is the risk cockpit — a server page
 * (app/risk/page.tsx) resolves sectors and hands the client component the
 * inputs, so the query call lives on the page and the words are a pure
 * formatter the client renders. This file pins both halves.
 */

const capital = 1_000_000;

describe("sectorConfidenceSentence — pure, derived from tierPct, never invented", () => {
  it("says so when nothing is classified (0%)", () => {
    const s = sectorConcentration([{ invested: 100000, sector: null }], capital);
    expect(s.classifiedPct).toBe(0);
    const line = sectorConfidenceSentence(s);
    expect(line.startsWith(SECTOR_CONFIDENCE_PREFIX)).toBe(true);
    expect(line).toBe("Sector labels: none — 100% of invested capital is unclassified.");
  });

  it("says so when there is no open capital at all", () => {
    expect(sectorConfidenceSentence(sectorConcentration([], capital))).toBe("Sector labels: no open capital to classify.");
  });

  it("mixed: official + taxonomy (medium) + unclassified, each figure a tierPct", () => {
    const s = sectorConcentration(
      [
        { invested: 50000, sector: "IT", sectorTier: "high" },
        { invested: 30000, sector: "Financials", sectorTier: "medium" },
        { invested: 20000, sector: null },
      ],
      capital,
    );
    expect(s.confidence.tierPct.high).toBe(50);
    expect(s.confidence.mediumPct).toBe(30);
    expect(sectorConfidenceSentence(s)).toBe(
      "Sector labels: 50% from official filings, 30% from the bundled taxonomy (30% medium confidence), 20% unclassified.",
    );
  });

  it("mixed with medium_high: the taxonomy figure is medium_high + medium, the bracket is medium alone", () => {
    const s = sectorConcentration(
      [
        { invested: 25000, sector: "IT", sectorTier: "medium_high" },
        { invested: 25000, sector: "Financials", sectorTier: "medium" },
        { invested: 50000, sector: "Auto", sectorTier: "high" },
      ],
      capital,
    );
    expect(sectorConfidenceSentence(s)).toBe(
      "Sector labels: 50% from official filings, 50% from the bundled taxonomy (25% medium confidence), 0% unclassified.",
    );
  });

  it("all official: 100% from filings, 0% taxonomy, 0% unclassified", () => {
    const s = sectorConcentration(
      [
        { invested: 60000, sector: "IT", sectorTier: "high" },
        { invested: 40000, sector: "Financials", sectorTier: "high" },
      ],
      capital,
    );
    expect(s.classifiedPct).toBe(100);
    expect(sectorConfidenceSentence(s)).toBe(
      "Sector labels: 100% from official filings, 0% from the bundled taxonomy (0% medium confidence), 0% unclassified.",
    );
  });

  it("names the user's tags, the index map and unstated tiers only when they carry capital", () => {
    const s = sectorConcentration(
      [
        { invested: 40000, sector: "IT", sectorTier: "user" },
        { invested: 30000, sector: "Auto", sectorTier: "index" },
        { invested: 30000, sector: "Pharma" }, // tier unstated → unknown
      ],
      capital,
    );
    expect(sectorConfidenceSentence(s)).toBe(
      "Sector labels: 40% your own tags, 0% from official filings, 0% from the bundled taxonomy (0% medium confidence), 30% from the NSE index map, 30% of unstated source, 0% unclassified.",
    );
  });

  it("a real sliver prints as <1%, never as a rounded-away 0%", () => {
    const s = sectorConcentration(
      [
        { invested: 999700, sector: "IT", sectorTier: "high" },
        { invested: 300, sector: "Auto", sectorTier: "medium" },
      ],
      capital,
    );
    expect(sectorConfidenceSentence(s)).toContain("<1% from the bundled taxonomy (<1% medium confidence)");
  });
});

describe("sectorTierMarker — a marker only below the best tiers", () => {
  it("is silent for the user's tag, an official filing and the Unclassified bucket", () => {
    expect(sectorTierMarker("user")).toBeNull();
    expect(sectorTierMarker("high")).toBeNull();
    expect(sectorTierMarker(null)).toBeNull();
  });

  it("names every weaker tier", () => {
    expect(sectorTierMarker("medium_high")).toBe("medium-high confidence");
    expect(sectorTierMarker("medium")).toBe("medium confidence");
    expect(sectorTierMarker("index")).toBe("index-list label");
    expect(sectorTierMarker("unknown")).toBe("source unstated");
    // Every tier below "high" in the order has a marker; nothing is left unnamed.
    for (const t of SECTOR_TIER_ORDER.slice(SECTOR_TIER_ORDER.indexOf("high") + 1)) expect(sectorTierMarker(t)).toBeTruthy();
  });

  it("follows the bucket's WEAKEST position", () => {
    const s = sectorConcentration(
      [
        { invested: 60000, sector: "Financials", sectorTier: "user" },
        { invested: 40000, sector: "Financials", sectorTier: "medium" },
      ],
      capital,
    );
    expect(s.slices[0].minTier).toBe("medium");
    expect(sectorTierMarker(s.slices[0].minTier)).toBe("medium confidence");
  });
});

describe("source pin — the risk page resolves tiers and the cockpit shows them", () => {
  const page = readFileSync("app/risk/page.tsx", "utf8");
  const cockpit = readFileSync("components/risk/risk-cockpit-client.tsx", "utf8");

  it("app/risk/page.tsx calls getSectorResolution() (not the tier-less getSectorMap) and passes sectorTier", () => {
    expect(page).toMatch(/getSectorResolution\(\)/);
    expect(page).not.toMatch(/\bgetSectorMap\b/);
    expect(page).toMatch(/sectorTier:\s*sectorFor\(t\.symbol\)\?\.tier/);
  });

  it("the cockpit renders the confidence sentence and the per-slice marker", () => {
    expect(cockpit).toMatch(/sectorConfidenceSentence\(s\)/);
    expect(cockpit).toMatch(/sectorTierMarker\(slice\.minTier\)/);
  });
});
