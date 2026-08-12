import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Per-account capital compounding, against a real migrated database.
 *
 * The defect this pins (D1, 2026-08-12): compounding WROTE the global
 * settings row while the summary READ the account row first — so with an
 * account-level capital set, the user saw "Compounded +₹X", the number never
 * changed, and the global rolled-in marker burned every other account's
 * un-compounded P&L. Migration 0044 moved `pnl_rolled_in` onto accounts;
 * these tests prove the money lands where the screen reads and that account
 * B's book is untouched by account A's compounding.
 *
 * ONE temp database per FILE (see tests/helpers/temp-db.ts).
 */

let t: TempDb;
let capital: typeof import("@/lib/queries/capital");
let accounts2: number;

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("capital", { seed: true });
  capital = await import("@/lib/queries/capital");

  // A second account with its OWN capital — the configuration the bug hid in.
  accounts2 = t.db
    .insert(t.schema.accounts)
    .values({ name: "Second", equityCapital: 50_000, activeCapital: 10_000 })
    .returning({ id: t.schema.accounts.id })
    .get().id;
});

afterAll(() => t?.cleanup());

describe("compounding lands where the summary reads", () => {
  it("adds the account's realised P&L to the ACCOUNT capital and the summary sees it", () => {
    selectAccount(accounts2);
    t.db.insert(t.schema.trades).values(
      tradeRow({ accountId: accounts2, netPnl: 1_000, isOpen: false, symbol: "CAP1", tradingsymbol: "CAP1" }),
    ).run();

    const before = capital.getCapitalSummary();
    expect(before.equityCapital).toBe(50_000);
    expect(before.available).toBe(1_000);

    const res = capital.compoundRealised("equity");
    expect(res.ok).toBe(true);
    expect(res.added).toBe(1_000);

    // The read path and the write path now agree: the number on screen moves.
    const after = capital.getCapitalSummary();
    expect(after.equityCapital).toBe(51_000);
    expect(after.available).toBe(0);
    expect(after.rolledIn).toBe(1_000);

    // And the account row itself carries it — not the global settings row.
    const acc = t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, accounts2)).get()!;
    expect(acc.equityCapital).toBe(51_000);
    expect(acc.pnlRolledIn).toBe(1_000);
  });

  it("never burns another account's un-compounded P&L", () => {
    // Account 1 (the seeded default) has its own realised P&L, never compounded.
    t.db.insert(t.schema.trades).values(
      tradeRow({ accountId: 1, netPnl: 700, isOpen: false, symbol: "OTHER", tradingsymbol: "OTHER" }),
    ).run();

    // Compounding in account 2 (again — nothing new there) must not touch it.
    selectAccount(accounts2);
    const again = capital.compoundRealised("equity");
    expect(again.ok).toBe(false); // nothing new to compound in account 2

    selectAccount(1);
    const one = capital.getCapitalSummary();
    // The old global marker would have swallowed this 700. It is still available.
    expect(one.available).toBe(700);
    expect(one.rolledIn).toBe(0);
  });

  it("records the capital snapshot against the account that compounded", () => {
    const snaps = t.db.select().from(t.schema.capitalSnapshots).all().filter((s) => s.realisedPnlToDate === 1_000);
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    for (const s of snaps) expect(s.accountId).toBe(accounts2);
  });

  it("refuses the aggregate view instead of moving money between books", () => {
    // Two accounts exist, so a stored 0 is a genuine aggregate (invariant 9).
    selectAccount(0);
    const res = capital.compoundRealised("equity");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/single account/i);
  });

  it("materialises capital onto an account that had none of its own", () => {
    // Account 1 has NULL capital → reads fall back to settings. Compounding
    // must write the account row, where the read will look next.
    selectAccount(1);
    const before = capital.getCapitalSummary();
    const res = capital.compoundRealised("equity");
    expect(res.ok).toBe(true);
    expect(res.added).toBe(700);

    const acc = t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, 1)).get()!;
    expect(acc.equityCapital).toBe(Math.round((before.equityCapital + 700) * 100) / 100);
    expect(acc.pnlRolledIn).toBe(700);
  });
});
