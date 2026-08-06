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
