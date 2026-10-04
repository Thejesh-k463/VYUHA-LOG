// v4.7.0 C3 — GET /api/sizing/journal-kelly against a REAL migrated database
// (tests/helpers/temp-db.ts; ONE temp DB for this whole file). What it pins is the
// research pack's risk 1 and 2 and the design's "What WRONG looks like":
//   - the selected account is the scope (invariant 8): two accounts, two answers;
//   - the All-accounts view reads nothing and refuses (K6, invariant 9's "0 is a view");
//   - a cap-only account never fills a payoff (K1);
//   - a free copy gets 403 (the Lab is Pro, R9); malformed params get 400;
//   - neither the route nor the Lab runs the Clinic report (D3, D4).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { JournalKellyResponse } from "@/lib/analytics/journal-kelly";

let t: TempDb;
let route: typeof import("@/app/api/sizing/journal-kelly/route");

const A = 1; // the seeded Primary account
const B = 2;
const C = 3; // every closed row is risk_source 'cap'

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}
function setFree(free: boolean) {
  t.db.update(t.schema.settings).set({ licenseKey: null, trialStartedAt: free ? "2020-01-01T00:00:00.000Z" : new Date().toISOString() }).run();
}
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);

/** One closed eq_intraday round trip with the given R. */
function closed(accountId: number, i: number, r: number, over: Record<string, unknown> = {}) {
  return tradeRow({
    accountId, bucket: "active", segment: "eq_intraday", symbol: `SYM${i % 5}`, tradingsymbol: `SYM${i % 5}`,
    buyQty: 10, sellQty: 10, avgBuyPrice: 100, avgSellPrice: 100 + r * 10, side: "long",
    buyDate: dayPlus(i), sellDate: dayPlus(i), isOpen: false,
    grossPnl: r * 100 + 20, chargesTotal: 20, netPnl: r * 100, riskAmount: 100, rMultiple: r, riskSource: "set",
    setupTag: "S", ...over,
  });
}

async function get(qs = ""): Promise<{ status: number; text: string; body: JournalKellyResponse & { message?: string } }> {
  const res = await route.GET(new Request(`http://x/api/sizing/journal-kelly${qs}`));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

beforeAll(async () => {
  t = await openTempDb("journal-kelly-route", { seed: true });
  route = await import("@/app/api/sizing/journal-kelly/route");
  t.db.insert(t.schema.accounts).values([
    { id: B, name: "Book B", isDefault: false },
    { id: C, name: "Book C", isDefault: false },
  ]).run();
  // A: 40 trades, ~45 % winners. B: 35 trades, a different mix. C: 40 cap-unit rows.
  t.db.insert(t.schema.trades).values(Array.from({ length: 40 }, (_, i) => closed(A, i, i % 9 < 4 ? 1.8 : -1))).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 35 }, (_, i) => closed(B, i + 100, i % 5 < 3 ? 0.9 : -1.2))).run();
  t.db.insert(t.schema.trades).values(Array.from({ length: 40 }, (_, i) => closed(C, i + 200, i % 2 ? 2 : -1, { riskSource: "cap" }))).run();
  // An open row and a 10-trade second setup in A: never in the sample / its own slice.
  t.db.insert(t.schema.trades).values(closed(A, 300, 5, { isOpen: true, sellQty: 0, sellDate: null })).run();
  // Setup T closes within the last 12 months of the REAL clock (the route reads todayIstIso()).
  const today = (await import("@/lib/domain/trading-day")).todayIstIso();
  const daysAgo = (k: number) => new Date(Date.parse(`${today}T00:00:00Z`) - k * 86_400_000).toISOString().slice(0, 10);
  t.db.insert(t.schema.trades).values(
    Array.from({ length: 10 }, (_, i) => closed(A, 400 + i, i % 2 ? 1 : -1, { setupTag: "T", buyDate: daysAgo(30 + i), sellDate: daysAgo(30 + i) })),
  ).run();
  setFree(false);
  selectAccount(A);
  await get(); // warm the route's first-call path (entitlement sweep, module init) outside the per-test budget
}, 30_000);

afterAll(() => t?.cleanup());

describe("the selected account is the scope (invariant 8)", () => {
  it("two accounts give two answers: different n and win rate", async () => {
    selectAccount(A);
    const a = await get();
    selectAccount(B);
    const b = await get();
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.result.ok && b.body.result.ok).toBe(true);
    if (!a.body.result.ok || !b.body.result.ok) return;
    expect(a.body.result.n).toBe(50);
    expect(b.body.result.n).toBe(35);
    expect(a.body.result.winPpm).not.toBe(b.body.result.winPpm);
    expect(a.body.slices[0]).toMatchObject({ key: "all|all", n: 50, of: 50 });
  });

  it("a narrowed slice re-applies the floor: A's 10-trade setup T refuses while the account fills", async () => {
    selectAccount(A);
    const s = await get("?segment=eq_intraday&setup=T");
    expect(s.body.result).toEqual({ ok: false, reason: "below-floor", n: 10, of: 10, need: 30 });
    expect(s.body.slices.map((x) => x.key)).toEqual(["all|all", "eq_intraday|all", "eq_intraday|setup:S", "eq_intraday|setup:T"]);
  });
});

describe("refusals", () => {
  it("the All-accounts view reads nothing and refuses (K6): 200, no slices, no figure", async () => {
    selectAccount(0);
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ slices: [], result: { ok: false, reason: "all-view", n: 0, of: 0, need: 30 } });
    expect(r.text).not.toMatch(/winPpm|payoffPpm/);
    selectAccount(A);
  });

  it("a cap-only account refuses: 0 of 40 carry a real risk, and no payoff key exists", async () => {
    selectAccount(C);
    const r = await get();
    expect(r.body.result).toEqual({ ok: false, reason: "below-floor", n: 0, of: 40, need: 30 });
    expect(r.text).not.toMatch(/winPpm|payoffPpm/);
    selectAccount(A);
  });

  it("a free copy is refused with 403 (the Lab is Pro)", async () => {
    setFree(true);
    try {
      const r = await get();
      expect(r.status).toBe(403);
      expect(r.text).not.toMatch(/winPpm|payoffPpm|slices/);
    } finally {
      setFree(false);
    }
  });

  it.each([
    ["?segment=bogus", "unknown segment"],
    ["?window=5y", "unknown window"],
    ["?setup=S", "a setup without a segment"],
    [`?segment=eq_intraday&setup=${"x".repeat(201)}`, "an over-long setup"],
  ])("400 for %s (%s)", async (qs) => {
    const r = await get(qs);
    expect(r.status).toBe(400);
    expect(r.body.result).toBeUndefined();
  });

  it("window=12m answers over the last 365 days only (A's 40 early-2025 trades are older; setup T's 10 closed a month ago)", async () => {
    selectAccount(A);
    const r = await get("?window=12m");
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ ok: false, reason: "below-floor", n: 10, of: 10, need: 30 });
    expect(r.body.slices[0]).toMatchObject({ key: "all|all", n: 10, of: 10 });
  });
});

describe("source scans (D3, D4)", () => {
  const ROOT = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("neither the route, the Lab page nor the Lab's components run the Clinic report", () => {
    const files = [
      "app/api/sizing/journal-kelly/route.ts",
      "app/sizing-lab/page.tsx",
      "lib/analytics/journal-kelly.ts",
      ...fs.readdirSync(path.join(ROOT, "components/sizing")).map((f) => `components/sizing/${f}`),
    ];
    for (const f of files) expect(read(f), f).not.toMatch(/\b(?:edgeClinic|computeClinic|getClinicState|clinicInputs)\s*\(/);
  });

  it("the route reads the selected account and the Clinic's own projection, and is dynamic + nodejs", () => {
    const src = read("app/api/sizing/journal-kelly/route.ts");
    expect(src).toContain("getSelectedAccountId()");
    expect(src).toContain("getClinicTrades([accountId])");
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).toContain('export const runtime = "nodejs"');
  });

  it("journal-kelly.ts stays pure: no DB, no queries, no React, no server-only", () => {
    const src = read("lib/analytics/journal-kelly.ts");
    expect(src).not.toMatch(/from "@\/lib\/(db|queries)|from "react"|import "server-only"/);
  });
});
