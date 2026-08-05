import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * A6 / migration 0035 — a single-account install must never sit in the
 * synthetic "All accounts" view.
 *
 * Migration 0034 shipped `selected_account_id` defaulting to 0 while trades
 * defaulted to account 1, so every install landed in an aggregate view of
 * exactly one account. That is what made writes ambiguous, and the app used to
 * resolve the ambiguity silently.
 *
 * This lives in its own file because lib/db binds its connection once per
 * module registry, and Vitest gives one registry per FILE — a second
 * openTempDb() in the same file would silently reuse the first database.
 */

let t: TempDb;
let accounts: typeof import("@/lib/queries/accounts");

beforeAll(async () => {
  t = await openTempDb("account-default", { seed: true });
  accounts = await import("@/lib/queries/accounts");
});

afterAll(() => t?.cleanup());

describe("default account selection", () => {
  it("starts with exactly one account", () => {
    expect(t.db.select().from(t.schema.accounts).all()).toHaveLength(1);
  });

  it("resolves a stored 0 to the only account that exists", () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    expect(accounts.getSelectedAccountId()).toBe(1);
    expect(accounts.isAggregateView()).toBe(false);
    expect(accounts.getWriteAccountId()).toBe(1);
  });

  it("stops resolving once a second account exists — the aggregate becomes real", () => {
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", isDefault: false }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: 0 }).run();
    expect(accounts.getSelectedAccountId()).toBe(0);
    expect(accounts.isAggregateView()).toBe(true);
    // Writes still need somewhere to go until the user picks.
    expect(accounts.getWriteAccountId()).toBe(1);
    expect(accounts.getWriteAccountId(2)).toBe(2);
  });

  it("resolves again if the second account goes away", () => {
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, 2)).run();
    expect(accounts.getSelectedAccountId()).toBe(1);
    expect(accounts.isAggregateView()).toBe(false);
  });
});
