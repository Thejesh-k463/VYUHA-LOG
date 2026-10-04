// v4.7.0 C3 — the seam between the journal half (GET /api/sizing/journal-kelly →
// lib/analytics/journal-kelly.ts → kellyCeiling) and the Lab half (applyJournalKelly →
// buildSetup → compareAll / sizeKelly, and the panel's ceiling flag). Both REAL halves
// run together over a REAL migrated database (ONE temp DB for this file).
//
// value crossing the seam     | writer                                   | reader                               | unit
// result.p / result.b         | journalKelly (route JSON)                | applyJournalKelly → winPpm/payoffPpm | fraction / R → ppm
// kellyFractionPpm            | the user (quarter by default)            | sizeKelly                            | ppm — MUST NOT MOVE
// kellyFUsedPpm vs ceiling    | sizeKelly row / result.halfKellyLowerBound | kellyExceedsCeiling (panel flag)   | both: fraction of capital at risk
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { JournalKellyResponse, JournalKellyOk } from "@/lib/analytics/journal-kelly";
import { applyJournalKelly, buildSetup, kellyExceedsCeiling, sampleInputs } from "@/components/sizing/lab-config";
import { compareAll, sizeKelly } from "@/lib/risk/sizing";

let t: TempDb;
let route: typeof import("@/app/api/sizing/journal-kelly/route");

const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);

async function journal(): Promise<JournalKellyResponse> {
  const res = await route.GET(new Request("http://x/api/sizing/journal-kelly"));
  expect(res.status).toBe(200);
  return (await res.json()) as JournalKellyResponse;
}

beforeAll(async () => {
  t = await openTempDb("seams-v47-c3", { seed: true });
  route = await import("@/app/api/sizing/journal-kelly/route");
  // 60 closed trades in the seeded Primary account: 30 winners of +2.2..+3.0 R, 30 losers of −1 R.
  t.db.insert(t.schema.trades).values(
    Array.from({ length: 60 }, (_, i) => {
      const r = i % 12 < 6 ? 2.2 + (i % 5) * 0.2 : -1;
      return tradeRow({
        accountId: 1, bucket: "active", segment: "eq_intraday", symbol: "SEAM", tradingsymbol: "SEAM",
        buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 100 + r * 10, side: "long",
        buyDate: dayPlus(i), sellDate: dayPlus(i), isOpen: false,
        grossPnl: r * 100 + 20, chargesTotal: 20, netPnl: r * 100, riskAmount: 100, rMultiple: r, riskSource: "set", setupTag: "S",
      });
    }),
  ).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: 1, licenseKey: null, trialStartedAt: new Date().toISOString() }).run();
  await journal(); // warm the first-call path outside the per-test budget
}, 30_000);

afterAll(() => t?.cleanup());

async function okResult(): Promise<JournalKellyOk> {
  const { result } = await journal();
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("route → applyJournalKelly → buildSetup → sizeKelly", () => {
  it("winPpm / payoffPpm land in the Lab's units; the Kelly fraction and every other input are untouched", async () => {
    const r = await okResult();
    const before = sampleInputs({ kellyFractionPpm: 250_000 });
    const after = applyJournalKelly(before, r);
    expect(after.winPpm).toBe(r.winPpm);
    expect(after.payoffPpm).toBe(r.payoffPpm);
    expect(after.winPpm).toBe(Math.round(r.p * 1_000_000));
    expect(after.payoffPpm).toBe(Math.round(r.b * 1_000_000));
    expect(after.kellyFractionPpm).toBe(250_000);
    expect({ ...after, winPpm: before.winPpm, payoffPpm: before.payoffPpm }).toEqual(before);
    const setup = buildSetup(after);
    expect([setup.winPpm, setup.payoffPpm, setup.kellyFractionPpm]).toEqual([r.winPpm, r.payoffPpm, 250_000]);
  });

  it("the Lab's raw Kelly f equals the journal's point Kelly to within ppm rounding", async () => {
    const r = await okResult();
    const setup = buildSetup(applyJournalKelly(sampleInputs(), r));
    const row = compareAll(setup).find((x) => x.method === "kelly")!;
    expect(row.ok).toBe(true);
    expect(r.kellyPoint).not.toBeNull();
    expect(Math.abs(row.kellyFPpm! - r.kellyPoint! * 1_000_000)).toBeLessThanOrEqual(3);
    // fUsed = f × the user's fraction (quarter): the fraction crossed unchanged.
    expect(row.kellyFUsedPpm).toBe(Math.floor((row.kellyFPpm! * 250_000) / 1_000_000));
  });

  it("the panel's flag compares like with like: kellyFUsedPpm / 1e6 against ½ Kelly at the lower bounds", async () => {
    const r = await okResult();
    expect(r.halfKellyLowerBound).not.toBeNull();
    const at = (fractionPpm: number) => {
      const s = buildSetup(applyJournalKelly(sampleInputs({ kellyFractionPpm: fractionPpm }), r));
      return sizeKelly({ capitalP: s.capitalP, winPpm: s.winPpm!, payoffPpm: s.payoffPpm!, kellyFractionPpm: s.kellyFractionPpm, entryP: s.entryP, stopP: s.stopP });
    };
    for (const fraction of [100_000, 250_000, 500_000, 1_000_000]) {
      const row = at(fraction);
      expect(kellyExceedsCeiling(row.kellyFUsedPpm, r.halfKellyLowerBound), `fraction ${fraction}`).toBe(
        row.kellyFUsedPpm! / 1_000_000 > r.halfKellyLowerBound!,
      );
    }
    // Full Kelly at the POINT estimate exceeds half Kelly at the LOWER bounds; a tenth of it does not.
    expect(kellyExceedsCeiling(at(1_000_000).kellyFUsedPpm, r.halfKellyLowerBound)).toBe(true);
    expect(kellyExceedsCeiling(at(100_000).kellyFUsedPpm, r.halfKellyLowerBound)).toBe(false);
  });

  it("a refusal applies nothing — the same inputs object comes back", async () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Second", isDefault: false }).run();
    try {
      const { result } = await journal();
      expect(result).toMatchObject({ ok: false, reason: "all-view" });
      const inputs = sampleInputs();
      expect(applyJournalKelly(inputs, result)).toBe(inputs);
    } finally {
      t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
    }
  });
});
