import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * WS2 — capital_goals queries against a real migrated temp DB (which also
 * proves migration 0052 applies cleanly: openTempDb runs the whole folder).
 *
 * Covers the account boundary (invariant 8), the aggregate-view write refusal
 * (invariant 9, mirroring compoundRealised), the refuse-don't-default write
 * rules (invariant 6), the frozen baseline, and the paise-at-rest /
 * rupees-at-runtime round trip (invariant 1).
 */

let t: TempDb;
let goals: typeof import("@/lib/queries/goals");
let route: typeof import("@/app/api/goals/route");

const PRIMARY = 1;
const SWING = 2;
const ALL = 0;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

function req(body: unknown): Request {
  return new Request("http://local/api/goals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  t = await openTempDb("goals", { seed: true });
  goals = await import("@/lib/queries/goals");
  route = await import("@/app/api/goals/route");
  t.db.insert(t.schema.accounts).values({ id: SWING, name: "Swing", equityCapital: 400000, activeCapital: 100000 }).run();
  // Primary carries no capital of its own; the settings row does.
  t.db.update(t.schema.settings).set({ equityCapital: 1500000, activeCapital: 200000 }).run();
});

afterAll(() => t?.cleanup());

describe("writes", () => {
  it("creates a goal for the selected account, freezing the baseline from resolved capital", () => {
    selectAccount(PRIMARY);
    const res = goals.upsertGoal({ bucket: "equity", kind: "absolute", targetAmount: 2000000 });
    expect(res.ok).toBe(true);
    const row = t.db.select().from(t.schema.capitalGoals).all()[0];
    expect(row.accountId).toBe(PRIMARY);
    expect(row.baselineCapital).toBe(1500000); // settings fallback, frozen
    expect(row.baselineDate).toBe(new Date().toISOString().slice(0, 10));
  });

  it("round-trips rupees through the paise columns (invariant 1)", () => {
    selectAccount(PRIMARY);
    expect(goals.upsertGoal({ bucket: "active", kind: "absolute", targetAmount: 123456.78 }).ok).toBe(true);
    const row = t.db.select().from(t.schema.capitalGoals).all().find((r) => r.bucket === "active")!;
    expect(row.targetAmount).toBe(123456.78); // rupees at runtime …
    const raw = t.sqlite.prepare("select target_paise as p from capital_goals where bucket = 'active'").get() as { p: number };
    expect(raw.p).toBe(12345678); // … integer paise at rest
    goals.deleteGoal("active");
  });

  it("REFUSES the aggregate view — 0 is a view, not a place (invariant 9)", () => {
    selectAccount(ALL);
    const res = goals.upsertGoal({ bucket: "equity", kind: "absolute", targetAmount: 1 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/single account/i);
    expect(goals.deleteGoal("equity").ok).toBe(false);
  });

  it("refuses a missing/zero target instead of defaulting it (invariant 6)", () => {
    selectAccount(PRIMARY);
    expect(goals.upsertGoal({ bucket: "total", kind: "absolute" }).ok).toBe(false);
    expect(goals.upsertGoal({ bucket: "total", kind: "absolute", targetAmount: 0 }).ok).toBe(false);
    expect(goals.upsertGoal({ bucket: "total", kind: "pct_profit" }).ok).toBe(false);
    expect(t.db.select().from(t.schema.capitalGoals).all().filter((r) => r.bucket === "total")).toHaveLength(0);
  });

  it("refuses a %-goal when the bucket's capital is unknown — never freezes a 0 baseline", () => {
    selectAccount(PRIMARY);
    t.db.update(t.schema.settings).set({ activeCapital: 0 }).run();
    const res = goals.upsertGoal({ bucket: "active", kind: "pct_profit", pctTarget: 20 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Settings/);
    t.db.update(t.schema.settings).set({ activeCapital: 200000 }).run();
  });

  it("an EDIT keeps the frozen baseline; one goal per bucket (unique index honoured)", () => {
    selectAccount(PRIMARY);
    t.db.update(t.schema.settings).set({ equityCapital: 9999999 }).run(); // capital edited later
    const res = goals.upsertGoal({ bucket: "equity", kind: "absolute", targetAmount: 2500000, targetDate: "2027-03-31" });
    expect(res.ok).toBe(true);
    const rows = t.db.select().from(t.schema.capitalGoals).all().filter((r) => r.bucket === "equity");
    expect(rows).toHaveLength(1); // updated, not duplicated
    expect(rows[0].targetAmount).toBe(2500000);
    expect(rows[0].targetDate).toBe("2027-03-31");
    expect(rows[0].baselineCapital).toBe(1500000); // still the creation-time figure
    t.db.update(t.schema.settings).set({ equityCapital: 1500000 }).run();
  });
});

describe("reads (invariant 8)", () => {
  it("getGoalRows returns only the selected account's goals", () => {
    selectAccount(SWING);
    expect(goals.upsertGoal({ bucket: "equity", kind: "absolute", targetAmount: 800000 }).ok).toBe(true);
    expect(goals.getGoalRows().map((r) => r.targetAmount)).toEqual([800000]);

    selectAccount(PRIMARY);
    expect(goals.getGoalRows().map((r) => r.targetAmount)).toEqual([2500000]);
  });

  it("the aggregate view SUMS per-account absolute goals per bucket", () => {
    selectAccount(ALL);
    const view = goals.getGoalView();
    expect(view.aggregate).toBe(true);
    const eq = view.goals.find((g) => g.bucket === "equity")!;
    expect(eq.targetAmount).toBe(3300000); // 25L + 8L
    expect(eq.baselineCapital).toBe(1900000); // 15L + 4L, both frozen
  });

  it("the aggregate EXCLUDES a bucket holding any %-goal, with the reason stated", () => {
    selectAccount(SWING);
    expect(goals.upsertGoal({ bucket: "total", kind: "pct_profit", pctTarget: 10 }).ok).toBe(true);
    selectAccount(ALL);
    const view = goals.getGoalView();
    expect(view.goals.some((g) => g.bucket === "total")).toBe(false);
    expect(view.excluded).toEqual([{ bucket: "total", reason: expect.stringMatching(/cannot be summed/i) }]);
  });
});

describe("account delete/merge", () => {
  it("purge removes the account's goals; merge drops them (never sums)", async () => {
    const del = await import("@/lib/queries/account-delete");
    selectAccount(PRIMARY);

    const preview = del.previewAccountDelete({ accountId: SWING, mode: "merge", targetId: PRIMARY });
    expect(preview.counts?.capitalGoals).toBe(2); // equity + total on Swing
    expect(preview.warnings?.some((w) => /goal/.test(w))).toBe(true);

    const res = del.deleteAccount({ accountId: SWING, mode: "merge", targetId: PRIMARY, connections: "delete" });
    expect(res.ok).toBe(true);
    const rows = t.db.select().from(t.schema.capitalGoals).all();
    // Swing's goals are gone; Primary's single equity goal is untouched.
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(PRIMARY);
    expect(rows[0].targetAmount).toBe(2500000);
  });
});

describe("refusal honesty + the aggregate walk (fix wave, 2026-09-02)", () => {
  const SECOND = 3;
  const NOGOAL = 4;

  it("aggregate-view writes carry the forbidden marker (route → 403, aligned with bf-losses)", () => {
    t.db.insert(t.schema.accounts).values({ id: SECOND, name: "Second" }).run();
    selectAccount(ALL);
    const res = goals.upsertGoal({ bucket: "equity", kind: "absolute", targetAmount: 1000 });
    expect(res.ok).toBe(false);
    expect(res.forbidden).toBe(true);
    expect(goals.deleteGoal("equity").forbidden).toBe(true);
  });

  it("editing a baseline-less goal to %-profit states the REAL remedy — delete + recreate, not a Settings nudge", () => {
    selectAccount(SECOND);
    // Freeze a NULL baseline: capital genuinely unknown at creation.
    t.db.update(t.schema.settings).set({ activeCapital: 0 }).run();
    expect(goals.upsertGoal({ bucket: "active", kind: "absolute", targetAmount: 100000 }).ok).toBe(true);
    // Capital IS configured now — but the edit keeps the frozen null baseline
    // by design, so "set capital in Settings" would be a lie.
    t.db.update(t.schema.settings).set({ activeCapital: 500000 }).run();
    const res = goals.upsertGoal({ bucket: "active", kind: "pct_profit", pctTarget: 20 });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/delete and recreate/i);
    expect(res.message).not.toMatch(/set this bucket's capital in Settings/i);
    goals.deleteGoal("active");
  });

  it("getAggregateGoalProgress sums per-account walks from each account's OWN baseline (probe scenarios)", () => {
    t.db.delete(t.schema.capitalGoals).run();
    t.db.delete(t.schema.trades).run();
    t.db.insert(t.schema.accounts).values({ id: NOGOAL, name: "NoGoal" }).run();
    const stamp = { createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
    t.db.insert(t.schema.capitalGoals).values([
      { accountId: PRIMARY, bucket: "total", kind: "absolute", targetAmount: 1200000, baselineCapital: 1000000, baselineDate: "2026-01-01", ...stamp },
      { accountId: SECOND, bucket: "total", kind: "absolute", targetAmount: 600000, baselineCapital: 500000, baselineDate: "2026-06-01", ...stamp },
    ]).run();
    t.db.insert(t.schema.trades).values([
      // PRIMARY: 50k AFTER its baseline — the only honest progress.
      tradeRow({ accountId: PRIMARY, isOpen: false, sellDate: "2026-02-01", netPnl: 50000 }),
      // SECOND: 100k BEFORE its June baseline — already inside the 5L base.
      tradeRow({ accountId: SECOND, isOpen: false, sellDate: "2026-03-01", netPnl: 100000 }),
      // NOGOAL holds no goal — its 120k must not leak into the numerator.
      tradeRow({ accountId: NOGOAL, isOpen: false, sellDate: "2026-03-15", netPnl: 120000 }),
    ]).run();

    selectAccount(ALL);
    const p = goals.getAggregateGoalProgress("2026-08-31").get("total")!;
    expect(p.measurable).toBe(true);
    expect(p.progressAmount).toBe(50000); // blended walk said 270k
    expect(p.progressPct).toBe(16.67); // 50k of the 3L summed gap
    expect(p.achieved).toBe(1550000); // (10L + 50k) + (5L + 0)
    expect(p.gapAmount).toBe(250000);
  });
});

describe("route: zod bounds + status mapping", () => {
  it("a negative and an absurd ₹ target both 400, the absurd one with the bound stated", async () => {
    selectAccount(PRIMARY);
    expect((await route.POST(req({ action: "upsert", bucket: "equity", kind: "absolute", targetAmount: -5 }))).status).toBe(400);
    const absurd = await route.POST(req({ action: "upsert", bucket: "equity", kind: "absolute", targetAmount: 2e11 }));
    expect(absurd.status).toBe(400);
    expect(((await absurd.json()) as { message?: string }).message).toMatch(/10,000 Cr/);
  });

  it("boolean coercion is refused — true is not a ₹ amount", async () => {
    selectAccount(PRIMARY);
    const res = await route.POST(req({ action: "upsert", bucket: "equity", kind: "absolute", targetAmount: true }));
    expect(res.status).toBe(400);
    expect(t.db.select().from(t.schema.capitalGoals).all().some((r) => r.accountId === PRIMARY && r.bucket === "equity")).toBe(false);
  });

  it("the aggregate view 403s — pinned to match /api/bf-losses", async () => {
    selectAccount(ALL);
    const res = await route.POST(req({ action: "upsert", bucket: "equity", kind: "absolute", targetAmount: 1000 }));
    expect(res.status).toBe(403);
  });

  it("a valid upsert lands (200) and can be deleted (200)", async () => {
    selectAccount(PRIMARY);
    expect((await route.POST(req({ action: "upsert", bucket: "equity", kind: "absolute", targetAmount: 750000 }))).status).toBe(200);
    expect((await route.POST(req({ action: "delete", bucket: "equity" }))).status).toBe(200);
  });
});
