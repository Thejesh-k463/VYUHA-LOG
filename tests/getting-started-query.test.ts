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

  it("the plan is the SELECTED account's; the All-accounts view counts any account's", () => {
    const { accounts } = t.schema;
    t.db.update(accounts).set({ brokerPlan: "plus" }).where(eq(accounts.id, B)).run();
    select(A);
    expect(q.getGettingStartedFacts().planSet).toBe(false);
    select(B);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(true);
    t.db.update(accounts).set({ brokerPlan: null }).where(eq(accounts.id, B)).run();
    select(0);
    expect(q.getGettingStartedFacts().planSet).toBe(false);
  });
});
