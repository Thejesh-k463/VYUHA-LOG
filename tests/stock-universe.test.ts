import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import ics from "../scripts/ics-structure-2023-07.json";
import universeJson from "@/lib/data/stock-universe.json";
import isinSymbols from "@/lib/data/isin-symbols.json";
import {
  readUniverse,
  universeClassification,
  universeCap,
  universeEntries,
  UNIVERSE,
  type Universe,
} from "@/lib/analytics/stock-universe";
import { buildSectorResolution, classificationByIsin, classificationEntries, taxonomyEntries } from "@/lib/analytics/instruments";
import { bundledSymbolByIsin, bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import * as buildModule from "../scripts/stock-universe-build.mjs";

// The build module is plain JS: its inferred shapes are too narrow for synthetic inputs, so the tests drive it untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const B: any = buildModule;

/**
 * v4.6.0 W2 — the bundled stock universe (rulings U1–U4).
 *
 * Three layers, each asserted against a DIFFERENT source than the one it
 * produced (a check must not agree with itself): the structure against its own
 * published counts, the build's rules against synthetic crawl answers, and the
 * committed snapshot against the structure file and the listing snapshot it was
 * built from.
 */

type Labels = { macro: string | null; sector: string | null; industry: string | null; basic: string | null };
const lab = (macro: string | null, sector: string | null, industry: string | null, basic: string | null): Labels => ({ macro, sector, industry, basic });

// Real structure rows used throughout (RELIANCE's chain, and a second sector for the disagreement case).
const REFINERIES = lab("Energy", "Oil Gas & Consumable Fuels", "Petroleum Products", "Refineries & Marketing");
const REFINERIES_BSE = lab("Energy", "Oil, Gas & Consumable Fuels", "Petroleum Products", "Refineries & Marketing");
const SOFTWARE = lab("Information Technology", "Information Technology", "IT - Software", "Computers - Software & Consulting");

describe("the structure file — NSE Indices, July 2023", () => {
  it("has exactly the published 12 / 22 / 59 / 197, every code nested under its parent", () => {
    expect(ics.counts).toEqual({ macro: 12, sector: 22, industry: 59, basic: 197 });
    const codes = new Set([...ics.macro, ...ics.sector, ...ics.industry, ...ics.basic].map((r) => r.code));
    for (const r of [...ics.sector, ...ics.industry, ...ics.basic] as { code: string; parent: string }[]) expect(codes.has(r.parent)).toBe(true);
    expect(ics.provenance.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries no label broken by the PDF's layout (a page-break or a mid-word wrap)", () => {
    const labels = [...ics.macro, ...ics.sector, ...ics.industry, ...ics.basic].map((r) => r.label);
    expect(labels).toContain("Telecommunication");
    expect(labels).toContain("Dealers – Commercial Vehicles, Tractors, Construction Vehicles");
    for (const l of labels) {
      expect(l).not.toMatch(/[,–-]$/);
      expect(l.length).toBeLessThan(80); // the disclaimer page once leaked into "Diversified"
    }
  });
});

describe("reconcile — one side, both sides, and the refusals", () => {
  const idx = B.indexStructure(ics);

  it("validates after folding punctuation, and emits the STRUCTURE's code", () => {
    const n = B.resolveSide(REFINERIES, idx);
    const b = B.resolveSide(REFINERIES_BSE, idx);
    expect(n.code).toBe("IN030103001");
    expect(b.code).toBe(n.code);
    expect(B.reconcileSides(n, b)).toEqual({ code: "IN030103001", source: "nse+bse" });
  });

  it("NSE wins a disagreement, and it is reported", () => {
    const r = B.reconcileSides(B.resolveSide(REFINERIES, idx), B.resolveSide(SOFTWARE, idx));
    expect(r.source).toBe("nse");
    expect(r.code).toBe("IN030103001");
    expect(r.disagreement).toBe(true);
  });

  it("an ancestor and its descendant AGREE — the deeper code is kept", () => {
    const shallow = B.resolveSide(lab("Energy", "Oil, Gas & Consumable Fuels", null, null), idx);
    expect(B.reconcileSides(shallow, B.resolveSide(REFINERIES_BSE, idx))).toEqual({ code: "IN030103001", source: "nse+bse" });
  });

  it("NSE's ALL-CAPS legacy scheme is never used — the other exchange's label wins", () => {
    const legacy = B.resolveSide(lab("SERVICES", "SERVICES", null, "HOTELS/ RESORTS AND OTHER RECREATIONAL ACTIVITIES"), idx);
    expect(legacy.legacy).toBe(true);
    expect(legacy.code).toBeNull();
    expect(B.reconcileSides(legacy, B.resolveSide(SOFTWARE, idx)).source).toBe("bse");
  });

  it("a basic label whose stated parents contradict the tree falls back to the deepest consistent level", () => {
    const s = B.resolveSide(lab("Energy", "Oil Gas & Consumable Fuels", "Petroleum Products", "Computers - Software & Consulting"), idx);
    expect(s.code).toBe("IN030103"); // the industry, never the contradicting basic
  });

  const snap = {
    asOf: "2026-09-25",
    byIsin: {
      INE002A01018: ["RELIANCE", "Reliance", "nse", "500325", "EQ"],
      INE467B01029: ["TCS", "TCS", "nse", "532540", "EQ"],
      INE11Z001019: ["SUMAX", "Sumax", "sme", "", "SM"],
      INF204KB14I2: ["NIFTYBEES", "Nifty BeES", "nse", "", "EQ"],
      INE999Z01011: ["NEWIPO", "New IPO", "nse", "", "EQ"],
    },
  };
  const nse = new Map<string, unknown>([
    ["RELIANCE", { k: "RELIANCE", st: "ok", labels: REFINERIES, meta: { isin: "INE002A01018" } }],
    ["TCS", { k: "TCS", st: "ok", labels: SOFTWARE, meta: { isin: "INE467B01029" } }],
    ["SUMAX", { k: "SUMAX", st: "ok", labels: SOFTWARE, meta: { isin: "INE11Z001019" } }],
    ["NEWIPO", { k: "NEWIPO", st: "ok", labels: SOFTWARE, listingDate: "15-Aug-2026 00:00:00" }],
  ]);
  const bse = new Map<string, unknown>([
    ["500325", { k: "500325", st: "ok", labels: REFINERIES_BSE, bseIsin: "INE002A01018", securityId: "RELIANCE" }],
    ["532540", { k: "532540", st: "ok", labels: SOFTWARE, bseIsin: "INE467B01029", securityId: "TCS" }],
  ]);
  const amfi = {
    periodEnd: "2026-06-30",
    rows: 2,
    byIsin: new Map([["INE002A01018", { isin: "INE002A01018", rank: 1, band: "large", nse: "RELIANCE", bse: "RELIANCE" }]]),
    // TCS stated under its PREVIOUS ISIN — joined by symbol, and the old ISIN becomes an alias
    byNse: new Map([
      ["RELIANCE", { isin: "INE002A01018", rank: 1, band: "large", nse: "RELIANCE", bse: "RELIANCE" }],
      ["TCS", { isin: "INE467B01011", rank: 2, band: "large", nse: "TCS", bse: "TCS" }],
    ]),
    byBse: new Map(),
  };
  const run = (over: Record<string, unknown> = {}) =>
    B.reconcile({ snap, nse, bse, amfi, ics, prev: null, capturedAt: "2026-09-25", provenance: [], ...over });

  it("emits one row per listing-snapshot ISIN — ETFs unclassified and unbanded, Emerge never banded (U3)", () => {
    const { json, failures } = run();
    expect(failures).toEqual([]);
    expect(Object.keys(json.byIsin).sort()).toEqual(Object.keys(snap.byIsin).sort());
    const [cls, source, assetClass, , band, rank, reason] = json.byIsin.INE002A01018;
    expect([cls, source, assetClass, band, rank, reason]).toEqual(["IN030103001", "nse+bse", "equity", "large", 1, null]);
    expect(json.byIsin.INE11Z001019.slice(2, 7)).toEqual(["sme-equity", "active", null, null, "nse-emerge"]);
    expect(json.cap.reasons["nse-emerge"]).toBe("SME — not ranked by AMFI");
    expect(json.byIsin.INF204KB14I2.slice(0, 3)).toEqual([null, null, "etf"]);
    expect(json.byIsin.INF204KB14I2[4]).toBeNull();
    expect(json.byIsin.INE999Z01011[6]).toBe("post-period-listing");
  });

  it("joins a reissued ISIN by symbol and keeps the old one as an alias", () => {
    const { json } = run();
    expect(json.byIsin.INE467B01029[4]).toBe("large");
    expect(json.aliases).toEqual({ INE467B01011: "INE467B01029" });
    expect(json.dq.capFallback.nse).toBe(1);
  });

  it("a mixed-case label outside the structure FAILS THE BUILD (a new taxonomy must fail loudly)", () => {
    const odd = new Map(nse);
    odd.set("RELIANCE", { k: "RELIANCE", st: "ok", labels: lab("Energy", "Oil Gas & Consumable Fuels", "Petroleum Products", "Hydrogen Refining") });
    const { failures } = run({ nse: odd });
    expect(failures.join("\n")).toMatch(/label outside the structure \(basic\): "Hydrogen Refining"/);
  });

  it("a fallback join never crosses issuers — a reused ticker gets no band and no alias (skeptic B)", () => {
    const reused = { ...amfi, byNse: new Map([...amfi.byNse, ["TCS", { isin: "INE999X01011", rank: 7, band: "large", nse: "TCS", bse: "TCS" }]]) };
    const { json } = run({ amfi: reused });
    expect(json.byIsin.INE467B01029[4]).toBeNull();
    expect(json.aliases).toEqual({});
    expect(json.dq.capFallback.rejected).toBe(1);
    expect(B.sameIssuer("INE887D01016", "INE887D01024")).toBe(true);
    expect(B.sameIssuer("INE887D01016", "INE888D01024")).toBe(false);
  });

  it("refuses when the exchanges agree on fewer than 90% of dual-classified ISINs (skeptic D)", () => {
    const many = { asOf: "2026-09-25", byIsin: {} as Record<string, string[]> };
    const n2 = new Map<string, unknown>();
    const b2 = new Map<string, unknown>();
    for (let i = 0; i < 60; i++) {
      const isin = `INE${String(100 + i)}A01010`;
      many.byIsin[isin] = [`S${i}`, `Co ${i}`, "nse", String(500000 + i), "EQ"];
      n2.set(`S${i}`, { k: `S${i}`, st: "ok", labels: REFINERIES });
      b2.set(String(500000 + i), { k: String(500000 + i), st: "ok", labels: i < 10 ? REFINERIES_BSE : SOFTWARE });
    }
    const { failures } = run({ snap: many, nse: n2, bse: b2 });
    expect(failures.join("\n")).toMatch(/exchange agreement 16\.7% over 60 .* below the 90% floor/);
  });

  it("an ALLOWLISTED out-of-structure label passes the build and the other side's label is used", () => {
    const odd = new Map(nse);
    odd.set("RELIANCE", { k: "RELIANCE", st: "ok", labels: lab("Energy", "Oil Gas & Consumable Fuels", "Petroleum Products", "Industrial Equipments") });
    const { json, failures } = run({ nse: odd });
    expect(failures).toEqual([]);
    expect(json.byIsin.INE002A01018.slice(0, 2)).toEqual(["IN030103001", "nse+bse"]);
  });

  it("refuses a crawl below the coverage floor, and an AMFI list older than seven months", () => {
    expect(run({ nse: new Map(), bse: new Map() }).failures.join("\n")).toMatch(/below the 95% floor/);
    expect(run({ amfi: { ...amfi, periodEnd: "2025-12-31" }, capturedAt: "2026-09-25" }).failures.join("\n")).toMatch(/months before/);
  });

  it("dates a changed classification or band at the capture that first saw it (history)", () => {
    const first = run().json;
    const moved = new Map(nse);
    moved.set("TCS", { k: "TCS", st: "ok", labels: REFINERIES });
    const noBse = new Map(bse);
    noBse.delete("532540");
    const second = run({ nse: moved, bse: noBse, prev: first, capturedAt: "2026-12-25" }).json;
    expect(second.history).toContainEqual({ isin: "INE467B01029", field: "cls", from: first.byIsin.INE467B01029[0], to: "IN030103001", effectiveFrom: "2026-12-25", source: "nse" });
  });
});

describe("a ticker is not an identity — the sector chain gives a symbol ITS OWNER's sector (skeptic A)", () => {
  it("the company the listing ranks first keeps the ticker, whichever entry arrives last", () => {
    const emerge = { isin: "INE0AAA01011", symbol: "", sector: "Capital Goods", confidence: "high" as const };
    const bseOnly = { isin: "INE0BBB01011", symbol: "", sector: "Consumer Durables", confidence: "high" as const };
    const sources = (order: (typeof emerge)[]) => ({
      taxonomy: order,
      symbolByIsin: () => "MAL",
      isinBySymbol: (s: string) => (s === "MAL" ? "INE0AAA01011" : null),
    });
    expect(buildSectorResolution([], sources([emerge, bseOnly])).get("MAL")?.sector).toBe("Capital Goods");
    expect(buildSectorResolution([], sources([bseOnly, emerge])).get("MAL")?.sector).toBe("Capital Goods");
    // an unclassified owner leaves the ticker unclassified — never another company's sector
    expect(buildSectorResolution([], sources([bseOnly])).has("MAL")).toBe(false);
  });

  it("the five tickers the 2026-09-25 universe shares across boards resolve to the listing's owner", () => {
    const res = buildSectorResolution([], {
      taxonomy: classificationEntries(),
      symbolByIsin: bundledSymbolByIsin,
      isinBySymbol: bundledIsinBySymbol,
    });
    for (const sym of ["MAL", "GSTL", "SEL", "ZEAL", "RAJPUTANA", "FOCUS"]) {
      const owner = bundledIsinBySymbol(sym)!;
      const want = classificationByIsin(owner)?.sector ?? null;
      expect(res.get(sym)?.sector ?? null, sym).toBe(want);
    }
  });
});

describe("the listing snapshot records SUPERSEDED ISINs by comparing with the one it replaces (skeptic C)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-superseded-"));
  fs.writeFileSync(path.join(dir, "EQUITY_L.csv"), [
    "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE",
    "ABC,A New Company Limited, EQ, 13-MAR-2026, 2, 1, INE999Z01018, 2",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "bse-scrips.json"), JSON.stringify([
    { SCRIP_CD: "526570", Scrip_Name: "Midwest Energy", Status: "Active", GROUP: "X", ISIN_NUMBER: "INE519N01022", scrip_id: "REMAGNET", Segment: "Equity", Issuer_Name: "MIDWEST ENERGY LIMITED" },
  ]));
  const out = path.join(dir, "out.json");
  // The snapshot being replaced: REMAGNET under its pre-split ISIN, an older record pointing at it, and an ABC
  // that was a DIFFERENT issuer's ticker.
  fs.writeFileSync(out, JSON.stringify({
    asOf: "2026-09-04",
    superseded: { INE519N01006: "INE519N01014" },
    byIsin: {
      INE519N01014: ["REMAGNET", "MIDWEST ENERGY LIMITED", "bse", "526570", "X"],
      INE123A01011: ["ABC", "Old ABC Limited", "nse", "", "EQ"],
    },
  }));
  execFileSync(process.execPath, [path.resolve("scripts/build-isin-symbols.mjs"), "--src", dir, "--as-of", "2026-09-25", "--out", out], { stdio: "pipe" });
  const built = JSON.parse(fs.readFileSync(out, "utf8")) as { superseded: Record<string, string>; byIsin: Record<string, string[]> };

  it("links a dropped ISIN to the same issuer's new ISIN by BSE code, and re-points an older record", () => {
    expect(built.superseded).toEqual({ INE519N01006: "INE519N01022", INE519N01014: "INE519N01022" });
  });

  it("never links a reused ticker across issuers", () => {
    expect(built.superseded.INE123A01011).toBeUndefined();
  });

  it("the committed snapshot links REMAGNET's pre-split ISIN, and every record stays inside one issuer", () => {
    const sup = (isinSymbols as unknown as { superseded: Record<string, string> }).superseded;
    expect(sup.INE519N01014).toBe("INE519N01022");
    expect(bundledSymbolByIsin("INE519N01014")).toBe("REMAGNET");
    for (const [from, to] of Object.entries(sup)) expect(B.sameIssuer(from, to), `${from} → ${to}`).toBe(true);
  });
});

describe("the reader — an absent or empty snapshot is NO universe, never a throw", () => {
  it("returns null for absent, empty and foreign shapes", () => {
    expect(readUniverse(null)).toBeNull();
    expect(readUniverse({})).toBeNull();
    expect(readUniverse({ schema: 1, byIsin: {} })).toBeNull();
    expect(readUniverse({ schema: 2, byIsin: { X: [] } })).toBeNull();
    expect(universeClassification("INE002A01018", null)).toBeNull();
    expect(universeCap("INE002A01018", null)).toBeNull();
    expect([...universeEntries(null)]).toEqual([]);
  });

  const fake = readUniverse({
    schema: 1,
    asOf: "2026-09-25",
    taxonomy: { nodes: { IN03: "Energy", IN0301: "Oil, Gas & Consumable Fuels", IN030103: "Petroleum Products", IN030103001: "Refineries & Marketing" } },
    cap: { periodEnd: "2026-06-30", effectiveFrom: "2026-07-01", reasons: { "nse-emerge": "SME — not ranked by AMFI" } },
    byIsin: {
      INE002A01018: ["IN030103001", "nse+bse", "equity", "active", "large", 1, null],
      INE11Z001019: [null, null, "sme-equity", "active", null, null, "nse-emerge"],
      INF204KB14I2: [null, null, "etf", "active", null, null, null],
    },
    aliases: { INE002A01000: "INE002A01018" },
  }) as Universe;

  it("decodes a code into four labels, through an alias for a reissued ISIN", () => {
    expect(universeClassification("ine002a01000", fake)).toEqual({
      isin: "INE002A01018",
      code: "IN030103001",
      macro: "Energy",
      sector: "Oil, Gas & Consumable Fuels",
      industry: "Petroleum Products",
      basic: "Refineries & Marketing",
      source: "nse+bse",
    });
  });

  it("says WHY an Emerge stock has no band, and has no cap answer at all for an ETF", () => {
    expect(universeCap("INE11Z001019", fake)).toMatchObject({ band: null, reason: "nse-emerge", reasonText: "SME — not ranked by AMFI" });
    expect(universeCap("INE002A01018", fake)).toMatchObject({ band: "large", rank: 1, periodEnd: "2026-06-30", effectiveFrom: "2026-07-01" });
    expect(universeCap("INF204KB14I2", fake)).toBeNull();
  });

  it("the sector chain: the user's tag wins, the universe outranks the sheet, the sheet fills the rest", () => {
    // user tag vs universe
    const res = buildSectorResolution([{ symbol: "RELIANCE", sector: "My Energy Bucket", isin: "INE002A01018" }], {
      taxonomy: classificationEntries(fake),
      symbolByIsin: (isin) => (isin === "INE002A01018" ? "RELIANCE" : null),
    });
    expect(res.get("RELIANCE")).toMatchObject({ sector: "My Energy Bucket", tier: "user" });
    // no tag → the universe's label, at the official tier
    const res2 = buildSectorResolution([{ symbol: "RELIANCE", sector: null, isin: "INE002A01018" }], {
      taxonomy: classificationEntries(fake),
      symbolByIsin: (isin) => (isin === "INE002A01018" ? "RELIANCE" : null),
    });
    expect(res2.get("RELIANCE")).toMatchObject({ sector: "Oil, Gas & Consumable Fuels", tier: "high", source: "taxonomy" });
    // every sheet ISIN the fake universe does not classify is still yielded, exactly once
    const sheet = [...taxonomyEntries()].map((e) => e.isin).filter((i) => i !== "INE002A01018");
    const chain = [...classificationEntries(fake)].map((e) => e.isin);
    expect(new Set(chain).size).toBe(chain.length);
    for (const i of sheet.slice(0, 200)) expect(chain).toContain(i);
    expect(classificationByIsin("INE002A01018", fake)?.source).toBe("NSE + BSE classification (both exchanges agree)");
  });
});

describe("the bundled snapshot", () => {
  const raw = universeJson as unknown as {
    listsAsOf: string;
    taxonomy: { nodes: Record<string, string> };
    byIsin: Record<string, (string | number | null)[]>;
    aliases: Record<string, string>;
    digest: string;
    dq: { coverage: number; equity: number; classified: number };
    provenance: { id: string; sha256?: string; url?: string | null }[];
  };
  const snap = isinSymbols as unknown as { asOf: string; byIsin: Record<string, string[]> };

  it("is present — W2 committed it (a missing snapshot is a regression, not a skip)", () => {
    expect(UNIVERSE).not.toBeNull();
  });

  it("was built from THIS listing snapshot, ISIN for ISIN — the two cannot disagree on a symbol", () => {
    expect(raw.listsAsOf).toBe(snap.asOf);
    expect(Object.keys(raw.byIsin).sort()).toEqual(Object.keys(snap.byIsin).sort());
  });

  it("classifies at least 95% of listed equities (the build refuses below it)", () => {
    expect(raw.dq.coverage).toBeGreaterThanOrEqual(0.95);
    const equity = Object.values(raw.byIsin).filter((r) => r[2] !== "etf");
    const classified = equity.filter((r) => r[0]).length;
    expect(classified / equity.length).toBeGreaterThanOrEqual(0.95);
    expect(classified).toBe(raw.dq.classified);
  });

  it("every code decodes, and every label is the STRUCTURE's own spelling for that code", () => {
    const structure = new Map([...ics.macro, ...ics.sector, ...ics.industry, ...ics.basic].map((r) => [r.code, r.label]));
    for (const [code, label] of Object.entries(raw.taxonomy.nodes)) expect(structure.get(code)).toBe(label);
    for (const r of Object.values(raw.byIsin)) if (r[0]) expect(raw.taxonomy.nodes[r[0] as string]).toBeDefined();
  });

  it("no NSE Emerge stock carries a band; each says why (U3); no ETF is classified or banded (U4)", () => {
    for (const [isin, row] of Object.entries(snap.byIsin)) {
      const u = raw.byIsin[isin];
      if (row[2] === "sme") expect([u[4], u[6]]).toEqual([null, "nse-emerge"]);
      if (isin.startsWith("INF")) expect([u[0], u[4]]).toEqual([null, null]);
    }
  });

  it("AMFI's bands have AMFI's shape: at most 100 large and 150 mid, ranks inside each band's range", () => {
    const rows = Object.values(raw.byIsin);
    const large = rows.filter((r) => r[4] === "large");
    const mid = rows.filter((r) => r[4] === "mid");
    expect(large.length).toBeLessThanOrEqual(100);
    expect(large.length).toBeGreaterThan(90);
    expect(mid.length).toBeLessThanOrEqual(150);
    for (const r of large) expect(r[5] as number).toBeLessThanOrEqual(100);
    for (const r of mid) expect((r[5] as number) > 100 && (r[5] as number) <= 250).toBe(true);
    expect(universeCap("INE002A01018")?.band).toBe("large"); // RELIANCE, AMFI rank 1
  });

  it("the digest recomputes, and every source names its URL (and sha256 where it is a file)", () => {
    const d = crypto.createHash("sha256").update(JSON.stringify({ taxonomy: raw.taxonomy, byIsin: raw.byIsin, aliases: raw.aliases })).digest("hex");
    expect(raw.digest).toBe(d);
    const amfi = raw.provenance.find((p) => p.id === "amfi")!;
    expect(amfi.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(amfi.url).toMatch(/^https:\/\/portal\.amfiindia\.com\//);
    expect(raw.provenance.find((p) => p.id === "structure")!.sha256).toBe(ics.provenance.sha256);
  });

  it("a SUPERSEDED ISIN still resolves to its company's ticker through the universe's alias (R3 §5)", () => {
    // INE887D01016 (scrip 512038) was reissued as INE887D01024 by 2026-09-25; the owner's demo book states the old one.
    expect(raw.aliases.INE887D01016).toBe("INE887D01024");
    expect(snap.byIsin.INE887D01016).toBeUndefined();
    const successor = snap.byIsin.INE887D01024[0];
    expect(bundledSymbolByIsin("INE887D01016")).toBe(successor);
    // every alias points at a live listing, and never at a DIFFERENT company's row by accident of order
    for (const [from, to] of Object.entries(raw.aliases)) {
      expect(B.sameIssuer(from, to), `${from} → ${to} crosses issuers`).toBe(true);
      expect(snap.byIsin[to], `${from} → ${to}`).toBeDefined();
      expect(snap.byIsin[from], `${from} is still live — not an alias`).toBeUndefined();
    }
  });

  it("/instruments (row 10) states the universe's and the index map's as-of and sha256 — from the modules, never as literals", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const src = strip(fs.readFileSync(path.resolve("app/instruments/page.tsx"), "utf8"));
    expect(src).toMatch(/import\s*\{[^}]*UNIVERSE_AS_OF[^}]*\}\s*from\s*"@\/lib\/analytics\/stock-universe"/);
    expect(src).toMatch(/import\s*\{[^}]*getMapDigests[^}]*\}\s*from\s*"@\/lib\/queries\/atlas"/);
    for (const id of ["stock-universe-provenance", "index-map-provenance", "market-calendar-provenance"]) expect(src).toContain(`data-testid="${id}"`);
    expect(src).toContain("universeDigest.sha256");
    expect(src).toContain("indexDigest.sha256");
    expect(src).not.toContain(raw.digest);
    expect(src).not.toContain(snap.asOf);
    expect(src).toMatch(/manually, once per minor release/);
  });

  it("the app issues no network request for classification — the hosts live only in scripts/", () => {
    const hosts = /nseindia\.com\/api|api\.bseindia\.com|amfiindia\.com/;
    const scan = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "data" ? [] : scan(p);
        return /\.(ts|tsx)$/.test(e.name) && hosts.test(fs.readFileSync(p, "utf8")) ? [p] : [];
      });
    const hits = ["lib", "app", "components"].flatMap((d) => scan(path.resolve(d)));
    // lib/data holds snapshots whose provenance NAMES the hosts; code must not dial them.
    expect(hits.filter((p) => !/lib[\\/]data[\\/]/.test(p))).toEqual([]);
  });
});
