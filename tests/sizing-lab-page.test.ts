/**
 * The Sizing Lab's SERVER LOAD — `loadSizingLab()` in app/sizing-lab/page.tsx.
 *
 * The page component itself is one line; everything that can be wrong lives in
 * the loader, and all of it is invisible from the browser:
 *
 *   1. SEVEN rows, always. `compareAll` returns one row per rulebook including
 *      the ones whose extra inputs are missing — those carry a typed error
 *      rather than disappearing. A loader that filtered them would show six
 *      methods today and seven tomorrow, and the rail's 1–7 keys would point
 *      at different tabs on different setups.
 *   2. The 0.25% DEFAULT (ruling Q38b). Migration 0064's `risk_pct_ppm` is
 *      nullable and null means "the user has not chosen" — so the Lab opens at
 *      2500 ppm and has to SAY that the figure is the lab default. Coalescing
 *      the null into a stored-looking number is the failure invariant 6
 *      exists to prevent.
 *   3. Charge rates come from the engine, not from a constant (invariant 3),
 *      and a row that fell back to `lib/data/charge-rates-defaults.json` is
 *      marked `default-schedule` so the UI can label it.
 *
 * One temp database for the FILE (lib/db caches its connection on globalThis),
 * and the page module is imported dynamically AFTER the helper has set
 * VYUHA_DB_PATH — a static import would bind lib/db to the real file first.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { eq } from "drizzle-orm";
// Pure (invariant 2), so a static import binds no database connection.
import { todayIstIso } from "@/lib/domain/trading-day";
import {
  DEFAULT_DEPLOY_CAP_PPM,
  DEFAULT_RISK_PCT_PPM,
  LAB_METHODS,
  sampleInputs,
  seedFromParams,
  stopIsOriented,
} from "@/components/sizing/lab-config";

let t: TempDb;
let page: typeof import("@/app/sizing-lab/page");

beforeAll(async () => {
  t = await openTempDb("sizing-lab-page", { seed: true });
  page = await import("@/app/sizing-lab/page");
});

afterAll(() => t?.cleanup());

function setGlobalRisk(patch: Record<string, unknown>) {
  const row = t.db
    .select()
    .from(t.schema.riskConfig)
    .all()
    .find((r) => r.scope === "global" && r.key === "")!;
  t.db.update(t.schema.riskConfig).set(patch).where(eq(t.schema.riskConfig.id, row.id)).run();
}

describe("the Lab opens on all seven rulebooks", () => {
  it("sampleCompare returns exactly seven results, in the catalogue's order", () => {
    const rows = page.sampleCompare();
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.method)).toEqual(LAB_METHODS.map((m) => m.id));
  });

  it("keeps a method whose extra inputs are absent as an errored row, never drops it", () => {
    const rows = page.sampleCompare({ slots: 0, deltaRupees: 0, atrRupees: 0 });
    expect(rows).toHaveLength(7);
    const equal = rows.find((r) => r.method === "equal-weight")!;
    expect(equal.ok).toBe(false);
    expect(equal.error).toBe("non-positive-slots");
    // The methods that still have their inputs are unaffected by the others.
    expect(rows.find((r) => r.method === "fixed-fractional")!.ok).toBe(true);
  });

  it("the seven keyboard hints are 1–7, one per row — the rail and compareAll share an order", () => {
    expect(LAB_METHODS.map((m) => m.keyHint)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });
});

describe("risk per trade: null is 'not chosen', not zero and not a stored figure", () => {
  it("opens at the 0.25% lab default when risk_pct_ppm is null, and says so", () => {
    const data = page.loadSizingLab("2025-06-02");
    expect(data.risk.riskPctPpm).toBe(2500);
    expect(DEFAULT_RISK_PCT_PPM).toBe(2500);
    expect(data.risk.riskSource).toBe("lab-default");
    // The stored row is still handed through untouched, so the write-back
    // dialog can print old → new against what is really on disk.
    expect(data.risk.stored?.riskPctPpm ?? null).toBeNull();
  });

  it("the deploy cap comes from the row's NOT NULL DEFAULT — 25%, on from row one", () => {
    const data = page.loadSizingLab("2025-06-02");
    expect(data.risk.deployCapPpm).toBe(DEFAULT_DEPLOY_CAP_PPM);
    expect(DEFAULT_DEPLOY_CAP_PPM).toBe(250_000);
  });

  it("opens at the STORED figure once one exists, and says that instead", () => {
    setGlobalRisk({ riskPctPpm: 7_500, stopAtrLen: 14, stopAtrMultPermille: 3_000 });
    const data = page.loadSizingLab("2025-06-02");
    expect(data.risk.riskPctPpm).toBe(7_500);
    expect(data.risk.riskSource).toBe("stored");
    expect(data.risk.stopAtrLen).toBe(14);
    expect(data.risk.stopAtrMultPermille).toBe(3_000);
    setGlobalRisk({ riskPctPpm: null, stopAtrLen: null, stopAtrMultPermille: null });
  });
});

describe("charge rates are resolved by the engine, and their source is named", () => {
  it("hands the client at least one priced schedule, each tagged with where it came from", () => {
    const data = page.loadSizingLab("2025-06-02");
    expect(data.schedules.length).toBeGreaterThan(0);
    for (const s of data.schedules) {
      expect(["charge_config", "default-schedule"]).toContain(s.source);
      // A schedule with no broker or no segment could not price anything.
      expect(s.rates.broker).toBe(s.broker);
      expect(s.rates.segment).toBe(s.segment);
    }
    expect(data.brokers.length).toBeGreaterThan(0);
    expect(data.ratesAsOf).toBe("2025-06-02");
  });

  it("resolves rates against the as-of date it is given, not against 'now'", () => {
    // Every epoch handed back has to CONTAIN the requested date. A loader that
    // silently used `new Date()` would still return rows, so the assertion is
    // on the epoch window rather than on the row count.
    const onDate = "2023-04-10";
    const data = page.loadSizingLab(onDate);
    expect(data.ratesAsOf).toBe(onDate);
    for (const s of data.schedules) {
      const from = s.rates.effectiveFrom ?? "";
      const to = s.rates.effectiveTo ?? null;
      expect(from <= onDate, `${s.broker}/${s.segment}`).toBe(true);
      expect(to == null || onDate < to, `${s.broker}/${s.segment}`).toBe(true);
    }
    // Called with no argument it resolves against today in ASIA/KOLKATA
    // (`todayIstIso()`), not against the runner's local calendar and not
    // against a UTC instant. The old assertion built the date from a local
    // `Date`, which is the same string only while the runner happens to sit in
    // IST: CI on a UTC runner after 18:30Z read one day behind and failed with
    // "expected '2026-09-06' to be '2026-09-05'".
    expect(page.loadSizingLab().ratesAsOf).toBe(todayIstIso());
  });

  it("carries the account the figures were read for (invariant 8)", () => {
    const data = page.loadSizingLab("2025-06-02");
    expect(Number.isInteger(data.accountId)).toBe(true);
    expect(data.capitalRupees).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The Live Desk hand-off (U1). `components/live/tracker-client.tsx` pushes
 * `/sizing-lab?from=live&symbol=<sym>&side=<long|short>&entry=<paise>&stop=<paise>`.
 * Its levels are integer PAISE and the Lab's fields are RUPEES, so one thing that can
 * go silently wrong here is a factor of a hundred. Everything else is refusal:
 * a query the Lab cannot fully trust opens the sample setup instead of mixing
 * one real level with one invented one.
 */
describe("seedFromParams — the Live Desk hand-off", () => {
  const SAMPLE = sampleInputs();

  it("converts the tracker's paise into the Lab's rupees and names the position", () => {
    const seed = seedFromParams({ from: "live", symbol: "RELIANCE", side: "long", entry: "285000", stop: "260000" });
    expect(seed.symbol).toBe("RELIANCE");
    expect(seed.inputs.entryRupees).toBe(2850);
    expect(seed.inputs.stopRupees).toBe(2600);
    expect(seed.inputs.direction).toBe("long");
  });

  it("keeps the paise exactly — a level with paise on it survives the round trip", () => {
    const seed = seedFromParams({ from: "live", symbol: "TCS", side: "long", entry: "123456", stop: "120000" });
    expect(seed.inputs.entryRupees).toBe(1234.56);
    expect(seed.symbol).toBe("TCS");
  });

  it("takes the side the desk STATED, and never infers it from the levels (M-1)", () => {
    // The bug this replaces: `direction: stopP > entryP ? "short" : "long"`.
    // The desk sends the EFFECTIVE stop, so a long whose stop has been trailed
    // above entry arrived with the stop above entry — and opened the Lab as a
    // SHORT, after which `chargesAdjustedRisk` priced the sell leg on the way
    // in. The row knows its own side; the query now carries it.
    const trailedLong = seedFromParams({ from: "live", symbol: "INFY", side: "long", entry: "285000", stop: "290000" });
    expect(trailedLong.inputs.direction, "the levels were allowed to overrule the stated side").toBe("long");
    expect(trailedLong.inputs.entryRupees).toBe(2850);
    expect(trailedLong.inputs.stopRupees).toBe(2900);
    // …and NOT flipped to make it consistent. A stop on the wrong side of
    // entry for the stated side is a fact about the position, and
    // `stopIsOriented` is what reports it on screen (owner ruling M-1).
    expect(stopIsOriented(trailedLong.inputs)).toBe(false);

    const realShort = seedFromParams({ from: "live", symbol: "INFY", side: "short", entry: "285000", stop: "290000" });
    expect(realShort.inputs.direction).toBe("short");
    expect(stopIsOriented(realShort.inputs)).toBe(true);

    // The mirror image: a short whose stop has been trailed BELOW entry.
    const trailedShort = seedFromParams({ from: "live", symbol: "INFY", side: "short", entry: "285000", stop: "260000" });
    expect(trailedShort.inputs.direction).toBe("short");
  });

  it("carries the caller's own defaults through — capital and stored risk are the server's", () => {
    const seed = seedFromParams(
      { from: "live", symbol: "SBIN", side: "long", entry: "80000", stop: "76000" },
      { capitalRupees: 25_00_000, riskPctPpm: 7_500 },
    );
    expect(seed.inputs.capitalRupees).toBe(25_00_000);
    expect(seed.inputs.riskPctPpm).toBe(7_500);
  });

  it("leaves ATR unset on a prefill rather than pricing a real symbol off the sample's volatility", () => {
    // The desk sends no ATR. Keeping the sample's Rs 85 would compute an N-unit
    // size for a real position from a number belonging to a different stock —
    // the methods report a typed reason for a missing input instead.
    expect(SAMPLE.atrRupees).toBe(85);
    expect(
      seedFromParams({ from: "live", symbol: "SBIN", side: "long", entry: "80000", stop: "76000" }).inputs.atrRupees,
    ).toBe(0);
  });

  it.each([
    ["no query at all", {}],
    ["a query from somewhere else", { from: "menu", symbol: "SBIN", side: "long", entry: "80000", stop: "76000" }],
    ["a rupee figure where paise were promised", { from: "live", symbol: "SBIN", side: "long", entry: "800.00", stop: "760.00" }],
    ["a negative level", { from: "live", symbol: "SBIN", side: "long", entry: "-80000", stop: "76000" }],
    ["a zero level", { from: "live", symbol: "SBIN", side: "long", entry: "0", stop: "76000" }],
    ["a word", { from: "live", symbol: "SBIN", side: "long", entry: "NaN", stop: "76000" }],
    ["an unsafe integer", { from: "live", symbol: "SBIN", side: "long", entry: "99999999999999999999", stop: "76000" }],
    ["no stop — the desk omits it when the row has none", { from: "live", symbol: "SBIN", side: "long", entry: "80000" }],
    ["a stop equal to entry, which is no risk per share", { from: "live", symbol: "SBIN", side: "long", entry: "80000", stop: "80000" }],
    ["a symbol that is not a symbol", { from: "live", symbol: "<script>", side: "long", entry: "80000", stop: "76000" }],
    ["no symbol", { from: "live", side: "long", entry: "80000", stop: "76000" }],
    // M-1: `side` joins the all-or-nothing rule. Inferring it from the levels
    // is what priced the wrong leg; defaulting it to "long" would price the
    // wrong leg for every short instead.
    ["no side at all", { from: "live", symbol: "SBIN", entry: "80000", stop: "76000" }],
    ["a side that is not a side", { from: "live", symbol: "SBIN", side: "buy", entry: "80000", stop: "76000" }],
    ["an empty side", { from: "live", symbol: "SBIN", side: "", entry: "80000", stop: "76000" }],
  ])("opens the sample setup on %s", (_why, q) => {
    const seed = seedFromParams(q);
    expect(seed.symbol).toBeNull();
    expect(seed.inputs).toEqual(SAMPLE);
  });

  it("takes the first value when a param is repeated, and never an array", () => {
    const seed = seedFromParams({ from: ["live"], symbol: ["ITC"], side: ["long"], entry: ["30000"], stop: ["28000"] });
    expect(seed.symbol).toBe("ITC");
    expect(seed.inputs.entryRupees).toBe(300);
  });
});

/**
 * The helper existing is not the same as the page using it. These pin the two
 * wires the prefill runs through: the page has to READ searchParams (Next 16
 * hands them over as a promise) and the client has to seed its one piece of
 * state from them.
 */
describe("the prefill is actually wired up", () => {
  const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  /** `side: r.side` in the tracker's URLSearchParams — stated, never derived. */
  const SIDE_PARAM = /side:\s*r\.side/;
  const FROM_LIVE = /from:\s*"live"/;

  it("the page awaits searchParams and passes them to the client", () => {
    const s = src("app/sizing-lab/page.tsx");
    expect(s).toMatch(/await\s+searchParams/);
    expect(s).toMatch(/query=\{/);
  });

  it("the Live Desk SENDS the side the Lab now requires (M-1)", () => {
    const s = src("components/live/tracker-client.tsx");
    expect(s, "the tracker omits `side`, so every hand-off opens the sample").toMatch(SIDE_PARAM);
    expect(s).toMatch(FROM_LIVE);
  });

  it("the client seeds its setup through seedFromParams, with no effect syncing state", () => {
    const s = src("components/sizing/lab-client.tsx");
    expect(s).toContain("seedFromParams(");
    expect(s).not.toMatch(/useEffect\([^)]*setInputs/);
  });
});
