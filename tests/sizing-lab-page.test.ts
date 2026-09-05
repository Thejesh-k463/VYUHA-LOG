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
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { eq } from "drizzle-orm";
import {
  DEFAULT_DEPLOY_CAP_PPM,
  DEFAULT_RISK_PCT_PPM,
  LAB_METHODS,
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
    // Called with no argument it resolves against TODAY's local calendar date,
    // not a UTC instant — a book in IST must not price yesterday's schedule
    // for the first five and a half hours of every day.
    const now = new Date();
    const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    expect(page.loadSizingLab().ratesAsOf).toBe(todayLocal);
  });

  it("carries the account the figures were read for (invariant 8)", () => {
    const data = page.loadSizingLab("2025-06-02");
    expect(Number.isInteger(data.accountId)).toBe(true);
    expect(data.capitalRupees).toBeGreaterThanOrEqual(0);
  });
});
