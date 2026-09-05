import { describe, expect, it } from "vitest";
import { parseInstrumentsFile, indexLabelFromFilename } from "@/lib/import/instruments-file";
import { themeEdge, THEME_MIN_SAMPLE } from "@/lib/analytics/theme-edge";
import nseIndexMap from "@/lib/data/nse-index-map.json";

// ─── index-constituent format ───────────────────────────────────────────────

const CONSTITUENTS = `Company Name,Industry,Symbol,Series,ISIN Code
AU Small Finance Bank Ltd.,Financial Services,AUBANK,EQ,INE949L01017
Axis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034
"Some, Commas Ltd.",Capital Goods,SOMECO,EQ,INE000A01010`;

describe("parseInstrumentsFile — index constituents", () => {
  it("reads sector + name + ISIN, including quoted comma names", () => {
    const r = parseInstrumentsFile(CONSTITUENTS);
    expect(r.format).toBe("index-constituents");
    expect(r.fields).toEqual(["name", "isin", "sector"]);
    expect(r.count).toBe(3);
    expect(r.rows[0]).toMatchObject({ symbol: "AUBANK", sector: "Financial Services", isin: "INE949L01017" });
    expect(r.rows[2].name).toBe("Some, Commas Ltd.");
  });

  it("does not shadow the securities list (which has no Industry column)", () => {
    const eq = parseInstrumentsFile("SYMBOL,NAME OF COMPANY, SERIES, ISIN NUMBER\nRELIANCE,Reliance Industries, EQ, INE002A01018");
    expect(eq.format).toBe("securities-list");
  });
});

// ─── filename → index label ─────────────────────────────────────────────────

describe("indexLabelFromFilename", () => {
  it("derives readable labels from the standard naming", () => {
    expect(indexLabelFromFilename("ind_niftybanklist.csv")).toBe("Nifty Bank");
    expect(indexLabelFromFilename("ind_niftyIndiaRailwaysPSU_list.csv")).toBe("Nifty India Railways PSU");
    expect(indexLabelFromFilename("ind_niftyEv_NewAgeAutomotive_list.csv")).toBe("Nifty EV New Age Automotive");
  });

  it("refuses non-standard filenames — no membership is better than a wrong one", () => {
    expect(indexLabelFromFilename("my-watchlist.csv")).toBeNull();
    expect(indexLabelFromFilename("EQUITY_L.csv")).toBeNull();
  });
});

// ─── bundled map contract ───────────────────────────────────────────────────

describe("bundled nse-index-map.json", () => {
  const map = nseIndexMap as { asOf: string; symbols: Record<string, { industry: string | null; isin: string | null; indices: string[] }> };

  it("carries an as-of date and a four-digit symbol universe", () => {
    expect(map.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const n = Object.keys(map.symbols).length;
    expect(n).toBeGreaterThan(1000);
  });

  it("every symbol has an industry and a valid ISIN — no partial junk shipped", () => {
    let noIndustry = 0, badIsin = 0;
    for (const v of Object.values(map.symbols)) {
      if (!v.industry) noIndustry += 1;
      if (v.isin && !/^[A-Z]{2}[A-Z0-9]{10}$/.test(v.isin)) badIsin += 1;
    }
    expect(noIndustry).toBe(0);
    expect(badIsin).toBe(0);
  });

  it("legacy taxonomy variants are normalised away", () => {
    const industries = new Set(Object.values(map.symbols).map((v) => v.industry));
    expect(industries.has("AUTOMOBILE")).toBe(false);
    expect(industries.has("FINANCIAL SERVICES")).toBe(false);
    expect(industries.has("Oil, Gas & Consumable Fuels")).toBe(false);
  });
});

// ─── theme edge ─────────────────────────────────────────────────────────────

describe("themeEdge", () => {
  const membership = new Map<string, string[]>([
    ["IRCTC", ["Nifty India Railways PSU", "Nifty Indiatourism"]],
    ["HAL", ["Nifty Indiadefence"]],
  ]);
  const trades = [
    { symbol: "IRCTC", isOpen: false, netPnl: 1000 },
    { symbol: "IRCTC", isOpen: false, netPnl: -400 },
    { symbol: "HAL", isOpen: false, netPnl: 2500 },
    { symbol: "HAL", isOpen: true, netPnl: 999999 }, // open — must not count
    { symbol: "NOTAGS", isOpen: false, netPnl: 50 },
  ];

  it("counts a trade in EVERY theme its symbol belongs to, closed only", () => {
    const r = themeEdge(trades, membership);
    const rail = r.rows.find((x) => x.theme === "Nifty India Railways PSU")!;
    const tour = r.rows.find((x) => x.theme === "Nifty Indiatourism")!;
    expect(rail.trades).toBe(2);
    expect(tour.trades).toBe(2); // same trades, second lens — overlap by design
    expect(rail.netPnl).toBe(600);
    expect(r.rows.find((x) => x.theme === "Nifty Indiadefence")!.netPnl).toBe(2500); // open trade excluded
  });

  it("reports the untagged remainder instead of hiding it", () => {
    const r = themeEdge(trades, membership);
    expect(r.closedTrades).toBe(4);
    expect(r.taggedTrades).toBe(3);
    expect(r.untaggedTrades).toBe(1);
    expect(r.overlapping).toBe(true);
  });

  it("flags thin samples rather than suppressing them", () => {
    const r = themeEdge(trades, membership);
    for (const row of r.rows) expect(row.trustworthy).toBe(row.trades >= THEME_MIN_SAMPLE);
  });
});

// ─── size indices + cap bands (Q46/Q47/Q50) ─────────────────────────────────

/**
 * The 2026-08-06 map carried the 54 sectoral/thematic lists and NOT one size
 * index, so nothing in the app could say "large cap" without guessing. Q46
 * added all eight; Q47 fixed the buckets as SEBI-style index membership; Q50
 * made effective_at + captured_at a standing rule on every membership row.
 *
 * The sectoral half must come through the rebuild BYTE-identical — these pins
 * are what proves the size work did not quietly re-sector anything.
 */
describe("nse-index-map — size indices", () => {
  const map = nseIndexMap as unknown as {
    indexCount: number;
    provenance?: { sizeIndicesReason?: string };
    sizeIndices?: Record<string, { asOf: string; effective_at: string; captured_at: string; source: string; symbols: string[] }>;
    symbols: Record<string, { indices: string[]; capBand?: string }>;
  };

  const EIGHT = [
    "Nifty 50", "Nifty Next 50", "Nifty 100", "Nifty 200",
    "Nifty 500", "Nifty Midcap 150", "Nifty Smallcap 250", "Nifty Microcap 250",
  ];

  it("ships exactly the eight size indices, none of them empty", () => {
    const si = map.sizeIndices ?? {};
    expect(Object.keys(si).sort()).toEqual([...EIGHT].sort());
    for (const [label, v] of Object.entries(si)) {
      expect(v.symbols.length, label).toBeGreaterThan(40);
      expect(new Set(v.symbols).size, label).toBe(v.symbols.length);
    }
    expect(si["Nifty 50"].symbols.length).toBe(50);
    expect(si["Nifty 100"].symbols.length).toBe(100);
  });

  it("every size index is effective-dated AND capture-dated (Q50 standing rule)", () => {
    // Counted first so the loop below can never pass vacuously on an empty map.
    expect(Object.keys(map.sizeIndices ?? {}).length).toBe(8);
    for (const [label, v] of Object.entries(map.sizeIndices ?? {})) {
      expect(v.effective_at, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.captured_at, label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.asOf, label).toBe(v.effective_at);
      expect(v.source, label).toBeTruthy();
      // A membership cannot have become effective after it was captured.
      expect(v.effective_at <= v.captured_at, label).toBe(true);
    }
  });

  it("capBand is SEBI-style and the LARGEST band wins an overlap", () => {
    const si = map.sizeIndices!;
    const band = (s: string) => map.symbols[s]?.capBand;
    for (const s of si["Nifty 50"].symbols) expect(band(s), s).toBe("large");
    for (const s of si["Nifty 100"].symbols) expect(band(s), s).toBe("large");
    // Midcap 150 and Nifty 100 do not overlap, but Midcap/Smallcap files can
    // both name a symbol at a rebalance — mid must win there.
    for (const s of si["Nifty Midcap 150"].symbols) {
      if (!si["Nifty 100"].symbols.includes(s)) expect(band(s), s).toBe("mid");
    }
    for (const s of si["Nifty Microcap 250"].symbols) {
      const bigger = ["Nifty 100", "Nifty Midcap 150", "Nifty Smallcap 250"].some((k) => si[k].symbols.includes(s));
      if (!bigger) expect(band(s), s).toBe("micro");
    }
    const bands = new Set(Object.values(map.symbols).map((v) => v.capBand));
    expect([...bands].sort()).toEqual(["large", "micro", "mid", "small", "unclassified"]);
  });

  it("the sectoral half is unchanged: 54 labels, 1155 symbols, 1985 membership rows", () => {
    const labels = new Set<string>();
    let rows = 0, withSectoral = 0;
    for (const v of Object.values(map.symbols)) {
      rows += v.indices.length;
      if (v.indices.length) withSectoral += 1;
      for (const i of v.indices) labels.add(i);
    }
    expect(labels.size).toBe(54);
    expect(withSectoral).toBe(1155);
    expect(rows).toBe(1985);
    // No size index leaked into the sectoral membership array.
    for (const e of EIGHT) expect(labels.has(e)).toBe(false);
    expect(map.indexCount).toBe(62); // 54 sectoral + 8 size
  });

  it("records WHY the size indices were absent, and stays inside the 300 KB gz budget", async () => {
    expect(map.provenance?.sizeIndicesReason ?? "").toMatch(/sectoral|thematic/i);
    const fs = await import("node:fs");
    const zlib = await import("node:zlib");
    const url = await import("node:url");
    const bytes = fs.readFileSync(
      url.fileURLToPath(new URL("../lib/data/nse-index-map.json", import.meta.url)),
    );
    const gz = zlib.gzipSync(bytes).length;
    expect(gz, `${(gz / 1024).toFixed(1)} KB gz`).toBeLessThan(300 * 1024);
  });
});
