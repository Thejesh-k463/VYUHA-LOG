import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import universeJson from "@/lib/data/stock-universe.json";

/**
 * getCapBandMap() — ISIN → AMFI cap band (ruling U2, v4.6.0 W2), and
 * getIndexBandMap() — ISIN → Nifty size-index membership, the SEPARATE lens.
 *
 * Keyed by ISIN and not by symbol because a ticker is not an identity — NSE
 * reuses them across a rename. Each map is checked against a DIFFERENT file
 * than the one its function reads would make trivially true: the AMFI band
 * against the universe's raw rows, the index lens against the index map.
 *
 * Own file + dynamic import because lib/queries/instruments.ts is
 * `server-only` and pulls lib/db into the graph; the helper must set
 * VYUHA_DB_PATH before that binding happens.
 */
let t: TempDb;
let q: typeof import("@/lib/queries/instruments");

beforeAll(async () => {
  t = await openTempDb("cap-band", { seed: true });
  q = await import("@/lib/queries/instruments");
});

afterAll(() => t?.cleanup());

const universe = universeJson as unknown as { cap: { periodEnd: string }; byIsin: Record<string, (string | number | null)[]> };

describe("getCapBandMap — AMFI's categorisation is THE cap band (U2)", () => {
  it("covers exactly the universe's AMFI-banded ISINs, with AMFI's band, rank and period", () => {
    const m = q.getCapBandMap();
    const banded = Object.entries(universe.byIsin).filter(([, r]) => r[4]);
    expect(m.size).toBe(banded.length);
    for (const [isin, r] of banded) expect(m.get(isin)).toEqual({ band: r[4], rank: r[5], asOf: universe.cap.periodEnd });
    for (const k of m.keys()) expect(k).toMatch(/^[A-Z]{2}[A-Z0-9]{10}$/);
  });

  it("has three bands and no micro — micro is index membership, never a cap band", () => {
    expect([...new Set([...q.getCapBandMap().values()].map((v) => v.band))].sort()).toEqual(["large", "mid", "small"]);
    expect(q.getCapBandMap().get("INE002A01018")).toMatchObject({ band: "large", rank: 1 }); // RELIANCE
  });

  it("omits every NSE Emerge stock (U3: blank, never guessed)", () => {
    const m = q.getCapBandMap();
    const emerge = Object.entries(universe.byIsin).filter(([, r]) => r[6] === "nse-emerge");
    expect(emerge.length).toBeGreaterThan(100);
    for (const [isin] of emerge) expect(m.has(isin)).toBe(false);
  });

  it("is a fresh map each call — a caller cannot poison the bundled data", () => {
    const a = q.getCapBandMap();
    a.set("INE000000000", { band: "small", rank: null, asOf: null });
    expect(q.getCapBandMap().has("INE000000000")).toBe(false);
  });
});

describe("getIndexBandMap — Nifty size-index membership, the separate lens (Q47)", () => {
  const map = nseIndexMap as unknown as {
    symbols: Record<string, { isin: string | null; capBand?: string }>;
  };

  it("is keyed by ISIN and covers every index-map symbol with a size band", () => {
    const m = q.getIndexBandMap();
    const classified = Object.values(map.symbols).filter((v) => v.isin && v.capBand && v.capBand !== "unclassified");
    expect(m.size).toBe(classified.length);
  });

  it("never invents a band — every value is the index map's, micro included", () => {
    const m = q.getIndexBandMap();
    const byIsin = new Map(Object.values(map.symbols).filter((v) => v.isin).map((v) => [v.isin!, v.capBand]));
    for (const [isin, band] of m) expect(band, isin).toBe(byIsin.get(isin));
    expect([...new Set(m.values())].sort()).toEqual(["large", "micro", "mid", "small"]);
    expect(m.get("INE002A01018")).toBe("large"); // RELIANCE is in Nifty 100
  });

  it("is a fresh map each call", () => {
    const a = q.getIndexBandMap();
    a.set("INE000000000", "micro");
    expect(q.getIndexBandMap().has("INE000000000")).toBe(false);
  });
});
