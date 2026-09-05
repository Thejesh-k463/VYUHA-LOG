import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import nseIndexMap from "@/lib/data/nse-index-map.json";

/**
 * getCapBandMap() — ISIN → SEBI-style cap band, read-only reference data.
 *
 * Keyed by ISIN and not by symbol because the callers that need a cap band
 * (position rows, Atlas) already carry an ISIN, and a ticker is not an
 * identity — NSE reuses them across a rename.
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

describe("getCapBandMap", () => {
  const map = nseIndexMap as unknown as {
    symbols: Record<string, { isin: string | null; capBand?: string }>;
  };

  it("is keyed by ISIN and covers every classified symbol that has one", () => {
    const m = q.getCapBandMap();
    const classified = Object.values(map.symbols).filter((v) => v.isin && v.capBand && v.capBand !== "unclassified");
    expect(m.size).toBe(classified.length);
    for (const k of m.keys()) expect(k).toMatch(/^[A-Z]{2}[A-Z0-9]{10}$/);
  });

  it("puts a Nifty 50 name in the large bucket and a Smallcap 250 name in small", () => {
    const m = q.getCapBandMap();
    expect(m.get("INE002A01018")).toBe("large"); // RELIANCE
    expect(m.get("INE467B01029")).toBe("large"); // TCS
    const smallIsin = Object.values(map.symbols).find((v) => v.capBand === "small" && v.isin)!.isin!;
    expect(m.get(smallIsin)).toBe("small");
  });

  it("never invents a band — every value comes from the bundled map", () => {
    const m = q.getCapBandMap();
    const byIsin = new Map(
      Object.values(map.symbols).filter((v) => v.isin).map((v) => [v.isin!, v.capBand]),
    );
    for (const [isin, band] of m) expect(band, isin).toBe(byIsin.get(isin));
    expect([...new Set(m.values())].sort()).toEqual(["large", "micro", "mid", "small"]);
  });

  it("is a fresh map each call — a caller cannot poison the bundled data", () => {
    const a = q.getCapBandMap();
    a.set("INE000000000", "micro");
    expect(q.getCapBandMap().has("INE000000000")).toBe(false);
  });
});
