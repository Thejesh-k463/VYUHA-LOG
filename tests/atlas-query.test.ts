import { describe, it, expect, beforeAll, afterAll } from "vitest";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import { toSeries } from "@/lib/atlas";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * lib/queries/atlas — the server wrapper around the pure `lib/atlas` library.
 *
 * The library's arithmetic is already pinned by tests/atlas-*.test.ts. What is
 * NOT covered there, and is exactly what this file exists for, is everything
 * the wrapper adds: the checksum that decides whether to recompute at all, the
 * three cache tables, the ISIN join behind cap bands, the cohort gate, and the
 * honest empty states each of those has to produce instead of a zero.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");

const SESSION_DATES = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1 + i));
  return d.toISOString().slice(0, 10);
});

/** A symbol the bundled map calls small-cap, so the ISIN join has three bands. */
const MAP = nseIndexMap as unknown as {
  symbols: Record<string, { isin: string | null; capBand?: string }>;
};
const SMALL = Object.entries(MAP.symbols).find(([, v]) => v.capBand === "small" && v.isin)!;
const SMALL_SYMBOL = SMALL[0].toUpperCase();

const UNIVERSE: { symbol: string; isin: string | null; base: number; drift: number }[] = [
  { symbol: "RELIANCE", isin: "INE002A01018", base: 1000, drift: 5 },
  { symbol: "TCS", isin: "INE467B01029", base: 3000, drift: -4 },
  { symbol: SMALL_SYMBOL, isin: SMALL[1].isin, base: 200, drift: 2 },
  { symbol: "NOTLISTED", isin: null, base: 50, drift: 1 },
];

function seedBars(sessions: number) {
  const insert = t.sqlite.prepare(
    "INSERT INTO price_history (symbol, date, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,'bhavcopy')",
  );
  for (const date of SESSION_DATES.slice(0, sessions)) {
    const i = SESSION_DATES.indexOf(date);
    for (const u of UNIVERSE) {
      const close = u.base + u.drift * i;
      insert.run(u.symbol, date, close - 1, close + 2, close - 3, close, 1_000 + i * 10);
    }
    // An index row NSE publishes in the same file. Not an equity, and it must
    // never sit in a breadth denominator.
    insert.run("NIFTY 50", date, 24_000, 24_100, 23_900, 24_000 + i, 0);
  }
}

beforeAll(async () => {
  t = await openTempDb("atlas-query", { seed: true });
  q = await import("@/lib/queries/atlas");
  seedBars(30);
});

afterAll(() => t?.cleanup());

describe("the universe read", () => {
  it("counts the sessions actually stored", () => {
    expect(q.storedSessionCount()).toBe(30);
  });

  it("keeps ETFs and equities but never an index row", () => {
    expect(q.isEquitySymbol("TCS")).toBe(true);
    expect(q.isEquitySymbol("NIFTYBEES")).toBe(true);
    expect(q.isEquitySymbol("NIFTY 50")).toBe(false);
    expect(q.isEquitySymbol("INDIA VIX")).toBe(false);
  });

  it("reads bars ascending, and the index row is dropped by the compute, not the read", () => {
    const bars = q.readUniverseBars();
    expect(bars.length).toBe(30 * (UNIVERSE.length + 1));
    expect(bars.some((b) => b.symbol === "NIFTY 50")).toBe(true);
  });
});

describe("refreshAtlasSnapshot — checksum in, cache tables out", () => {
  it("computes once and persists the snapshot, its metrics and its staleness rows", () => {
    const first = q.refreshAtlasSnapshot({ now: new Date("2026-07-31T12:00:00Z") });
    expect(first.recomputed).toBe(true);
    expect(first.reason).toBe("computed");
    const snap = first.snapshot!;
    expect(snap.asOf).toBe(SESSION_DATES[29]);
    expect(snap.inputChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.universeIncluded).toBe(UNIVERSE.length); // the index row excluded
    expect(snap.payload?.market_pulse.breadth.advancing.denominator).toBe(UNIVERSE.length);
    const metrics = t.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_metric").get() as { n: number };
    expect(metrics.n).toBeGreaterThan(0);
  });

  it("does NOT recompute when the bars have not moved", () => {
    const again = q.refreshAtlasSnapshot();
    expect(again.recomputed).toBe(false);
    expect(again.reason).toBe("checksum_unchanged");
  });

  it("recomputes on force — the one case that is a spec change, not a data change", () => {
    const forced = q.refreshAtlasSnapshot({ force: true });
    expect(forced.recomputed).toBe(true);
    expect(forced.reason).toBe("forced");
  });

  it("recomputes once when a new session lands, and the checksum moves with it", () => {
    const before = q.getStoredSnapshot()!.inputChecksum;
    t.sqlite
      .prepare("INSERT INTO price_history (symbol, date, close, source) VALUES ('RELIANCE','2026-08-05',1200,'bhavcopy')")
      .run();
    const after = q.refreshAtlasSnapshot();
    expect(after.recomputed).toBe(true);
    expect(after.snapshot!.inputChecksum).not.toBe(before);
    t.sqlite.prepare("DELETE FROM price_history WHERE date = '2026-08-05'").run();
    q.refreshAtlasSnapshot();
  });
});

describe("cap bands — the ISIN join, and its two different empties", () => {
  it("says the instrument list is missing rather than reporting an empty market", () => {
    const view = q.getCapBands(seriesForTest(), SESSION_DATES[29]);
    expect(view.available).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.reason).toContain("no instrument list");
    expect(view.classificationNote).toContain("Current classification, not point-in-time");
  });

  it("buckets by NSE's own membership once ISINs can be matched to symbols", () => {
    const insert = t.sqlite.prepare("INSERT INTO instruments (symbol, isin) VALUES (?, ?)");
    for (const u of UNIVERSE) if (u.isin) insert.run(u.symbol, u.isin);
    const view = q.getCapBands(seriesForTest(), SESSION_DATES[29]);
    expect(view.available).toBe(true);
    const large = view.rows.find((r) => r.band === "large")!;
    expect(large.label).toBe("Large cap");
    expect(large.members).toBe(2); // RELIANCE + TCS
    expect(large.denominator).toBe(2);
    expect(large.advancing).toBe(1); // RELIANCE drifts up, TCS down
    expect(large.advancePpm).toBe(500_000);
    expect(view.rows.map((r) => r.band)).toEqual(["large", "small"]);
    // The name no size index claims is counted, and counted NOWHERE else.
    expect(view.unclassified).toBe(1);
  });
});

describe("my names — dark until the window is real (Q51)", () => {
  it("stays dark under 21 sessions and says how to enable it", () => {
    const view = q.getMyNames([], { groups: [], unclassified: [] } as never, 12);
    expect(view.enabled).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.reason).toContain("you have 12");
    expect(view.reason).toContain("Run the backfill to enable it");
  });

  it("with enough sessions and no positions, says so instead of showing an empty table", () => {
    const v = q.getAtlasView();
    expect(v.myNames.enabled).toBe(true);
    expect(v.myNames.reason).toBe("No open equity positions to attribute.");
  });

  it("attributes an open position against its own sector cohort", () => {
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, symbol: "RELIANCE", tradingsymbol: "RELIANCE", isOpen: true, buyQty: 10 }) as never)
      .run();
    const v = q.getAtlasView();
    const row = v.myNames.rows.find((r) => r.symbol === "RELIANCE");
    expect(row).toBeDefined();
    expect(row!.stock1wPpm).not.toBeNull();
    // diff = stock - cohort, and it is null whenever either side is null.
    if (row!.cohort1wPpm === null) expect(row!.diff1wPpm).toBeNull();
    else expect(row!.diff1wPpm).toBe(row!.stock1wPpm! - row!.cohort1wPpm);
  });
});

describe("the one read the page makes", () => {
  it("carries both footer lines, the spec version and the backfill state", () => {
    const v = q.getAtlasView();
    expect(v.provenanceLine).toBe(q.NO_CHARTINK_LINE);
    expect(v.notAdviceLine).toBe(q.NOT_ADVICE_LINE);
    expect(v.sessions).toBe(30);
    expect(v.backfillConsented).toBe(false);
    expect(v.backfill.status).toBe("idle");
    expect(v.backfillDefaultDays).toBe(252);
    expect(v.volumeLeaders.length).toBeGreaterThan(0);
    // A leader board is a ranking: it is sorted, and it never includes an
    // index row that was excluded from every denominator.
    const ppms = v.volumeLeaders.map((l) => l.expansionPpm);
    expect([...ppms].sort((a, b) => b - a)).toEqual(ppms);
    expect(v.volumeLeaders.some((l) => l.symbol === "NIFTY 50")).toBe(false);
  });
});

/** The equity series the page hands to getCapBands, built the same way. */
function seriesForTest() {
  // lib/atlas is PURE (invariant 2), so a test may import it directly: this is
  // the library's own grouping of the same bars the wrapper reads, not a
  // second, divergent shape.
  return toSeries(q.readUniverseBars()).filter((s) => q.isEquitySymbol(s.symbol));
}
