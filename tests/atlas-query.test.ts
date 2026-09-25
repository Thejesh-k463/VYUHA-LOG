import { describe, it, expect, beforeAll, afterAll } from "vitest";
import nseIndexMap from "@/lib/data/nse-index-map.json";
import universeJson from "@/lib/data/stock-universe.json";
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

function seedBars(sessions: number, from = 0) {
  const insert = t.sqlite.prepare(
    "INSERT INTO price_history (symbol, date, open, high, low, close, volume, source) VALUES (?,?,?,?,?,?,?,'bhavcopy')",
  );
  for (const date of SESSION_DATES.slice(from, sessions)) {
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

describe("the anchor can move BACKWARDS, and a later snapshot must not survive it", () => {
  /**
   * The restore case. `getStoredSnapshot()` reads max(as_of), so a snapshot for
   * a session the CURRENT bars cannot produce out-ranks the one just computed:
   * `/atlas` recomputed on every render and served the older market forever.
   * Migration 0065 already ruled on it — a snapshot whose inputs are gone is
   * stale EVIDENCE and is never re-served as data.
   */
  it("serves the snapshot it just recomputed, not a newer row about bars that are gone", () => {
    q.refreshAtlasSnapshot({ force: true });
    const wide = q.getStoredSnapshot()!;
    expect(wide.asOf).toBe(SESSION_DATES[29]);

    // The bars go BACK to session 20 — what restoring an older backup does.
    const cutoff = SESSION_DATES[19];
    t.sqlite.prepare("DELETE FROM price_history WHERE date > ?").run(cutoff);

    const after = q.refreshAtlasSnapshot();
    expect(after.recomputed).toBe(true);
    expect(after.snapshot!.asOf).toBe(cutoff);
    // The served row and the recomputed row are the same row.
    expect(q.getStoredSnapshot()!.asOf).toBe(cutoff);
    expect(q.getAtlasView().snapshot!.asOf).toBe(cutoff);
    // …and the orphaned long-form rows went with it, or the Coverage tab would
    // read a denominator from a session the market no longer has.
    const newer = t.sqlite
      .prepare("SELECT (SELECT COUNT(*) FROM atlas_daily WHERE as_of > ?) AS d, (SELECT COUNT(*) FROM atlas_metric WHERE as_of > ?) AS m, (SELECT COUNT(*) FROM atlas_staleness WHERE as_of > ?) AS s")
      .get(cutoff, cutoff, cutoff) as { d: number; m: number; s: number };
    expect(newer).toEqual({ d: 0, m: 0, s: 0 });
  });

  it("getVerifiedSnapshot refuses to publish a row whose checksum no longer matches", () => {
    expect(q.getVerifiedSnapshot().stale).toBe(false);
    expect(q.getVerifiedSnapshot().snapshot).not.toBeNull();

    // Change the bars WITHOUT recomputing — exactly the window a read sits in.
    t.sqlite
      .prepare("INSERT INTO price_history (symbol, date, close, source) VALUES ('ZZNEWCO','2026-07-19',1234,'bhavcopy')")
      .run();
    const v = q.getVerifiedSnapshot();
    expect(v.stale).toBe(true);
    expect(v.snapshot).toBeNull();
    // The raw row is still there — this is a refusal to SERVE, not a delete.
    expect(q.getStoredSnapshot()).not.toBeNull();

    t.sqlite.prepare("DELETE FROM price_history WHERE symbol = 'ZZNEWCO'").run();
    expect(q.getVerifiedSnapshot().stale).toBe(false);
  });

  it("restores the 30-session universe for the tests below", () => {
    seedBars(30, 20); // only the ten sessions the test above deleted
    q.refreshAtlasSnapshot({ force: true });
    expect(q.storedSessionCount()).toBe(30);
    expect(q.getStoredSnapshot()!.asOf).toBe(SESSION_DATES[29]);
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

  it("buckets by AMFI's categorisation once ISINs can be matched to symbols (U2)", () => {
    const insert = t.sqlite.prepare("INSERT INTO instruments (symbol, isin) VALUES (?, ?)");
    for (const u of UNIVERSE) if (u.isin) insert.run(u.symbol, u.isin);
    const view = q.getCapBands(seriesForTest(), SESSION_DATES[29]);
    expect(view.available).toBe(true);
    const large = view.rows.find((r) => r.band === "large")!;
    expect(large.label).toBe("Large cap");
    expect(large.members).toBe(2); // RELIANCE + TCS, AMFI large
    expect(large.denominator).toBe(2);
    expect(large.advancing).toBe(1); // RELIANCE drifts up, TCS down
    expect(large.advancePpm).toBe(500_000);
    // The index map's small-cap name takes whatever band AMFI gives it (read from the universe, not assumed):
    // the two definitions disagree on some names, which is exactly why they are two tables.
    const smallAmfi = (universeJson as unknown as { byIsin: Record<string, (string | null)[]> }).byIsin[SMALL[1].isin!]?.[4] ?? null;
    expect(view.rows.map((r) => r.band)).toEqual(smallAmfi && smallAmfi !== "large" ? ["large", smallAmfi] : ["large"]);
    expect(view.rows.some((r) => r.band === "micro")).toBe(false);
    // the list names its OWN period — the view's asOf is the price snapshot, a different clock
    expect(view.classificationNote).toContain("AMFI's list: the six months ended 2026-06-30.");
    // A name no band claims is counted, and counted NOWHERE else.
    expect(view.unclassified).toBe(smallAmfi ? 1 : 2);
  });

  it("the index-membership lens buckets by NSE's own size indices, labelled as membership (Q47)", () => {
    const view = q.getIndexBands(seriesForTest(), SESSION_DATES[29]);
    expect(view.available).toBe(true);
    expect(view.classificationNote).toMatch(/^Index membership, not a cap band/);
    const large = view.rows.find((r) => r.band === "large")!;
    expect(large.label).toBe("Nifty 100");
    expect(large.members).toBe(2);
    expect(view.rows.map((r) => r.band)).toEqual(["large", "small"]);
    expect(view.rows.find((r) => r.band === "small")!.label).toBe("Nifty Smallcap 250");
    expect(view.unclassified).toBe(1);
  });
});

describe("my names — dark until the window is real (Q51)", () => {
  it("stays dark under 21 sessions and says how to enable it", () => {
    const view = q.getMyNames([], 12);
    expect(view.enabled).toBe(false);
    expect(view.cohorts).toEqual([]);
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
    // v4.6.0 W5 phase 2 (Q51 #5): the legacy `rows` projection is gone; the
    // cohort row is the ONLY shape. A four-symbol universe has no cohort wide
    // enough (AQ26: ≥ 5 priced), so the row says so in the AQ26 sentence rather
    // than printing a two-member "median".
    expect("rows" in v.myNames).toBe(false);
    const cohort = v.myNames.cohorts.find((c) => c.symbol === "RELIANCE")!;
    expect(cohort).toBeDefined();
    expect(cohort.windows["1w"].own).not.toBeNull();
    // diff = own − cohort, and it is null whenever either side is null.
    const w1 = cohort.windows["1w"];
    if (w1.cohort?.value_ppm == null) expect(w1.diff).toBeNull();
    else expect(w1.diff).toBe(w1.own! - w1.cohort.value_ppm);
    expect(cohort.thin).toBe(true);
    expect(cohort.thinLine).toMatch(/^cohort too thin to compare \(\d+ of \d+ priced\)$/);
    expect(cohort.windows["1m"].cohort).toBeNull();
    expect(cohort.decidedOn?.window).toBe("1m");
    expect(v.myNames.statistic).toBe("median");
    expect(v.myNames.spans["1m"]?.stored).toBe(22);
  });

  it("hands the rotation table its sparse-history spans, computed server-side (Q51 #7)", () => {
    const v = q.getAtlasView();
    // The seeded universe holds 22 sessions: 1w and 1m have a span, 3m does not.
    expect(v.windowSpans["1w"]?.stored).toBe(6);
    expect(v.windowSpans["1m"]?.stored).toBe(22);
    expect(v.windowSpans["3m"]).toBeNull();
    for (const key of ["1w", "1m"] as const) {
      const s = v.windowSpans[key]!;
      // The seed's dates are synthetic, not all trading days, so the calendar may count FEWER
      // sessions than the store holds; `missing` is documented as never negative.
      expect(s.missing).toBe(Math.max(0, s.expected - s.stored));
      if (s.missing === 0) expect(s.gapLine).toBeNull();
      else expect(s.gapLine).toContain(`${s.missing} missing session`);
    }
  });
});

describe("rank Δ reads ONE spec_version (design review A1)", () => {
  const D = (i: number) => SESSION_DATES[i];
  const seedSnapshot = (asOf: string, spec: string, rs: Record<string, number>) => {
    t.sqlite
      .prepare(
        "INSERT INTO atlas_daily (as_of, generated_at, spec_version, source_mode, input_checksum, universe_included, universe_excluded, anchor_coverage, anchor_coverage_ppm, payload_json) VALUES (?, ?, ?, 'bhavcopy_local', ?, 4, 0, 4, 1000000, NULL)",
      )
      .run(asOf, `${asOf}T14:00:00.000Z`, spec, `chk-${asOf}-${spec}`);
    const ins = t.sqlite.prepare(
      "INSERT INTO atlas_metric (as_of, metric, group_kind, group_name, value_ppm, numerator, denominator, coverage_ppm, insufficient_history) VALUES (?, 'group_rs_ppm', 'sector', ?, ?, ?, 8, 1000000, 0)",
    );
    for (const [group, value] of Object.entries(rs)) ins.run(asOf, group, value, value);
  };

  it("1.0.0 rows for an earlier as_of never enter a 2.0.0 rank Δ", () => {
    const today = q.getStoredSnapshot()!.asOf;
    expect(today).toBe(D(29));
    // Earlier tests in this file left a snapshot at session 19 (the anchor
    // moved back and forward again); start from today's row alone.
    t.sqlite.prepare("DELETE FROM atlas_metric WHERE as_of <> ?").run(today);
    t.sqlite.prepare("DELETE FROM atlas_daily WHERE as_of <> ?").run(today);
    // Today's real snapshot is 2.0.0 and has no sector wide enough to rank
    // (four symbols), so give it two rankable sector rows of its own.
    t.sqlite.prepare("DELETE FROM atlas_metric WHERE as_of = ? AND metric = 'group_rs_ppm'").run(today);
    const ins = t.sqlite.prepare(
      "INSERT INTO atlas_metric (as_of, metric, group_kind, group_name, value_ppm, numerator, denominator, coverage_ppm, insufficient_history) VALUES (?, 'group_rs_ppm', 'sector', ?, ?, ?, 8, 1000000, 0)",
    );
    ins.run(today, "Alpha", 10_000, 10_000);
    ins.run(today, "Beta", 5_000, 5_000);

    // Four older 2.0.0 snapshots (D1..D4) → with today that is five: the 1w
    // window (5 sessions) can read its past rank from the OLDEST of them, D1.
    seedSnapshot(D(21), "atlas-core/2.0.0", { Alpha: 1_000, Beta: 9_000 }); // D1: Beta ranked 1, Alpha 2
    seedSnapshot(D(23), "atlas-core/2.0.0", { Alpha: 9_000, Beta: 1_000 });
    seedSnapshot(D(25), "atlas-core/2.0.0", { Alpha: 9_000, Beta: 1_000 });
    seedSnapshot(D(27), "atlas-core/2.0.0", { Alpha: 9_000, Beta: 1_000 });
    // Two 1.0.0 leftovers: one older than everything, one BETWEEN D4 and today.
    // Without the spec filter the between-row would be counted as a snapshot
    // and the oldest-of-five would move from D1 to D2.
    seedSnapshot(D(3), "atlas-core/1.0.0", { Alpha: 9_000, Beta: 1_000 });
    seedSnapshot(D(28), "atlas-core/1.0.0", { Alpha: 9_000, Beta: 1_000 });

    const view = q.getRankDeltas(today, "sector");
    expect(view.rank).toEqual({ Alpha: 1, Beta: 2 });
    const w1 = view.windows.find((w) => w.key === "1w")!;
    expect(w1.have).toBe(5); // five 2.0.0 snapshots; the two 1.0.0 rows are not counted
    expect(w1.pastAsOf).toBe(D(21));
    expect(w1.shortfall).toBeNull();
    // Alpha was rank 2 at D1 and is rank 1 today: climbed one. Beta the reverse.
    expect(w1.delta).toEqual({ Alpha: 1, Beta: -1 });

    const m1 = view.windows.find((w) => w.key === "1m")!;
    expect(m1.pastAsOf).toBeNull();
    expect(m1.shortfall).toBe("rank Δ needs 21 daily snapshots under this formula set; you have 5 (one is written each day Atlas is opened with new bars)");
    expect(m1.delta).toEqual({});

    t.sqlite.prepare("DELETE FROM atlas_metric WHERE as_of <> ?").run(today);
    t.sqlite.prepare("DELETE FROM atlas_daily WHERE as_of <> ?").run(today);
  });

  it("hides a group under the 8-eligible floor from the ranking and counts it", () => {
    const today = q.getStoredSnapshot()!.asOf;
    t.sqlite
      .prepare(
        "INSERT INTO atlas_metric (as_of, metric, group_kind, group_name, value_ppm, numerator, denominator, coverage_ppm, insufficient_history) VALUES (?, 'group_rs_ppm', 'sector', 'Thin', 99000, 99000, 3, 1000000, 0)",
      )
      .run(today);
    const view = q.getRankDeltas(today, "sector");
    expect(view.rank.Thin).toBeUndefined();
    expect(view.hiddenBelowFloor).toBe(1);
    expect(view.minRank).toBe(8);
    t.sqlite.prepare("DELETE FROM atlas_metric WHERE as_of = ? AND metric = 'group_rs_ppm'").run(today);
    q.refreshAtlasSnapshot({ force: true });
  });
});

describe("the trades join (design review A7) — breadth on the entry days, days outside the replay NAMED", () => {
  it("reads the session's %>SMA50 and advance share from the replay, and counts the days it cannot", () => {
    // RELIANCE was opened above with no buyDate; give it one inside the replay,
    // and add a closed winner opened long before any stored bar.
    t.sqlite.prepare("UPDATE trades SET buy_date = ? WHERE symbol = 'RELIANCE'").run(SESSION_DATES[25]);
    t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: 1, symbol: "TCS", tradingsymbol: "TCS", isOpen: false, buyQty: 5, sellQty: 5, buyDate: "2026-01-05", sellDate: "2026-02-05", netPnl: 1500 }) as never)
      .run();
    const v = q.getAtlasView();
    const j = v.entryDayBreadth;
    expect(j.replaySessions).toBe(30);
    expect(j.open.entryDays).toBe(1);
    expect(j.open.withFigure).toBe(1);
    expect(j.open.outsideReplay).toBe(0);
    expect(j.open.advanceMeanPpm).toBe(v.payload!.history.find((h) => h.as_of === SESSION_DATES[25])!.advance_pct_ppm);
    expect(j.open.sentence).toMatch(/^On 1 of 1 entry days, /);
    expect(j.open.sentence).not.toMatch(/\bwill\b|\bshould\b/);
    expect(j.closedWinners.entryDays).toBe(1);
    expect(j.closedWinners.withFigure).toBe(0);
    expect(j.closedWinners.outsideReplay).toBe(1);
    expect(j.closedWinners.sentence).toContain("None of the 1 entry days of closed winners fall inside the 30-session replay");
    expect(j.closedLosers.entryDays).toBe(0);
    expect(j.closedLosers.sentence).toBe("No entry days of closed losers to look up.");
    t.sqlite.prepare("DELETE FROM trades WHERE symbol = 'TCS'").run();
  });
});

describe("the index-membership filter (design review A8) — in memory, never the cache", () => {
  it("restricts the universe to the bundled index's members and states the denominator", () => {
    const before = (t.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_daily").get() as { n: number }).n;
    const view = q.getAtlasIndexView("Nifty 50");
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.members).toBe(50);
    expect(view.priced).toBe(2); // RELIANCE + TCS of our four
    expect(view.header).toBe("restricted to Nifty 50 (2 of 50 priced)");
    expect(view.payload!.universe.included).toBe(2);
    expect(view.specVersion).toBe("atlas-core/2.0.0");
    // NOTHING was written: the filtered market is a view, not a snapshot.
    expect((t.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_daily").get() as { n: number }).n).toBe(before);
    expect(q.getStoredSnapshot()!.universeIncluded).toBe(UNIVERSE.length);
  });

  it("lists the filters the map exposes, and refuses a name it does not know", () => {
    const f = q.listIndexFilters();
    expect(f.size).toContain("Nifty 500");
    expect(f.size).toHaveLength(8);
    expect(f.sectoral.length).toBeGreaterThan(20);
    expect(q.indexMembers("Nifty 50")!.has("RELIANCE")).toBe(true);
    const bad = q.getAtlasIndexView("Nifty Imaginary");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("Nifty Imaginary");
  });
});

describe("the W5 additions on the one read (catch-up status, thresholds, honesty list)", () => {
  it("carries the catch-up count, the stored thresholds and the honesty registry", () => {
    const v = q.getAtlasView();
    expect(v.statistic).toBe("median");
    expect(v.regimeThresholds.isDefault).toBe(true);
    expect(v.coverageFloorPpm).toBe(300_000);
    expect(v.groupMinRank).toBe(8);
    expect(v.catchup.windowDays).toBe(252);
    expect(v.catchup.perOpen).toBe(10);
    expect(v.catchup.automatic).toBe(false);
    expect(v.catchup.line).toMatch(/sessions missing in your 252-day window — run the backfill\.$/);
    expect(v.notComputed.length).toBeGreaterThan(5);
    expect(v.rankDeltas.sector.windows.map((w) => w.key)).toEqual(["1w", "1m", "3m"]);
    // The page's payload and GET's payload are the same re-derived regime (A3).
    expect(v.payload!.regime).toEqual(q.getVerifiedSnapshot().snapshot!.payload!.regime);
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
