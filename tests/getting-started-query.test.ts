import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v4.6.0 W4, row 9.5 — lib/queries/getting-started.ts against a real migrated
 * database. Its own file: one temp database per FILE (lib/db caches its
 * connection on globalThis).
 *
 * SCOPE (invariant 8): trades and "a stop recorded" follow the selected
 * account (`accountId > 0 ? filter : all`); the account count is global; the
 * plan is the selected account's own (any account's in the All-accounts view).
 */

let t: TempDb;
let q: typeof import("@/lib/queries/getting-started");
let A = 0;
let B = 0;

/** getSelectedAccountId is React-cached per request; outside a request it re-reads, but select through settings each time. */
function select(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("getting-started", { seed: true });
  const { accounts } = t.schema;
  A = t.db.select({ id: accounts.id }).from(accounts).limit(1).get()!.id;
  B = t.db.insert(accounts).values({ name: "Second book" }).returning({ id: accounts.id }).get().id;
  // Account A: one trade, no stop. Account B: two trades, one with a planned stop.
  t.db.insert(t.schema.trades).values(tradeRow({ accountId: A })).run();
  t.db.insert(t.schema.trades).values(tradeRow({ accountId: B })).run();
  t.db.insert(t.schema.trades).values(tradeRow({ accountId: B, slPlanned: 95.5 })).run();
  q = await import("@/lib/queries/getting-started");
});

afterAll(() => t?.cleanup());

describe("getGettingStartedFacts — scoped by the selected account", () => {
  it("account A sees only its own trade, and no stop", () => {
    select(A);
    expect(q.getGettingStartedFacts()).toMatchObject({ accounts: 2, trades: 1, stopRecorded: false });
  });

  it("account B sees its two trades and the stop on one of them", () => {
    select(B);
    expect(q.getGettingStartedFacts()).toMatchObject({ accounts: 2, trades: 2, stopRecorded: true });
  });

  it("the All-accounts view (0) reads every account", () => {
    select(0);
    expect(q.getGettingStartedFacts()).toMatchObject({ accounts: 2, trades: 3, stopRecorded: true });
  });

  it("a stop is sl_planned NOT NULL — a trailing stop alone does not count", () => {
    const { trades } = t.schema;
    const id = t.db.insert(trades).values(tradeRow({ accountId: A, trailingSl: 90 })).returning({ id: trades.id }).get().id;
    select(A);
    expect(q.getGettingStartedFacts().stopRecorded).toBe(false);
    t.db.update(trades).set({ slPlanned: 88 }).where(eq(trades.id, id)).run();
    expect(q.getGettingStartedFacts().stopRecorded).toBe(true);
    t.db.delete(trades).where(eq(trades.id, id)).run();
  });

  // v4.6.0 audit DA-1: "Charges plan set" is done when no account in scope is
  // flagged by getAccountsWithoutPlan() (Data Quality's list). The default plan
  // is stored as NULL and a one-plan broker has no editor, so `broker_plan IS
  // NOT NULL` could never tick on the common path.
  it("a one-plan broker on the default plan (NULL) counts as set", () => {
    const { accounts } = t.schema;
    t.db.update(accounts).set({ broker: "zerodha", brokerPlan: null }).where(eq(accounts.id, A)).run();
    t.db.update(accounts).set({ broker: "zerodha", brokerPlan: null }).where(eq(accounts.id, B)).run();
    select(A);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
  });

  it("a multi-plan broker with no plan stated is NOT set — in its own view and in All accounts, not in another account's", () => {
    const { accounts } = t.schema;
    t.db.update(accounts).set({ broker: "zerodha", brokerPlan: null }).where(eq(accounts.id, A)).run();
    t.db.update(accounts).set({ broker: "upstox", brokerPlan: null }).where(eq(accounts.id, B)).run();
    select(B);
    expect(q.getGettingStartedFacts().planSet).toBe(false);
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(false);
    select(A);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    // Stating the plan clears it everywhere.
    t.db.update(accounts).set({ brokerPlan: "plus" }).where(eq(accounts.id, B)).run();
    select(B);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    t.db.update(accounts).set({ broker: null, brokerPlan: null }).where(eq(accounts.id, B)).run();
  });

  // DA-1 skeptic follow-up: a multi-plan user who EXPLICITLY picks the default
  // plan used to be saved as NULL (`plan === "default" ? null : plan`), so Data
  // Quality kept flagging them and this step could never tick. The editor's own
  // writer (`planFields`) now stores the default's id; pricing reads both alike.
  it("an EXPLICIT default plan on a multi-plan broker counts as set, and prices exactly like null", async () => {
    const { planFields, planChanged } = await import("@/components/settings/account-plan-editor");
    const { resolvePlan } = await import("@/lib/engine/rates");
    const { getAccountsWithoutPlan } = await import("@/lib/queries/data-quality");
    const { accounts } = t.schema;
    // A never-chosen plan is savable as the default — that click IS the choice.
    expect(planChanged({ brokerPlan: null, brokerPlanFrom: null }, "default", "")).toBe(true);
    expect(planChanged({ brokerPlan: "default", brokerPlanFrom: null }, "default", "")).toBe(false);
    t.db.update(accounts).set({ broker: "zerodha", brokerPlan: null }).where(eq(accounts.id, A)).run();
    t.db.update(accounts).set({ broker: "upstox", ...planFields("default", "") }).where(eq(accounts.id, B)).run();
    expect(getAccountsWithoutPlan().map((a) => a.id)).not.toContain(B);
    select(B);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    const map = new Map() as Parameters<typeof resolvePlan>[3];
    for (const d of ["2025-01-01", "2026-09-26"]) {
      expect(resolvePlan({ broker: "upstox", brokerPlan: "default", brokerPlanFrom: null }, "upstox", d, map)).toBe(
        resolvePlan({ broker: "upstox", brokerPlan: null, brokerPlanFrom: null }, "upstox", d, map),
      );
    }
    t.db.update(accounts).set({ broker: null, brokerPlan: null }).where(eq(accounts.id, B)).run();
  });
});
