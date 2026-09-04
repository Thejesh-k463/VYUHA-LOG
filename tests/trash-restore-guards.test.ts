import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.8 fix wave — the two ways `restoreTrashSnapshot` used to corrupt a book.
 *
 * 1. BROKER-REMOVE AFTER THE RE-IMPORT. `removeBrokerRows` exists for exactly
 *    one workflow: a parser fix changed what a file MEANS, so the broker's rows
 *    come out and the file goes back in clean. The re-imported rows carry
 *    different hashes and different positions — that is the point of the fix —
 *    so the dedup index that saves an ordinary restore collides with nothing
 *    here, and the restore quietly doubled the book while reporting
 *    "Restored 2 trades." (the same class of double-book as the v3.7 wizard).
 *
 * 2. RESTORE INTO A DELETED ACCOUNT. `trades.account_id` has no foreign key,
 *    so the rows landed in a book that no longer exists — invisible in every
 *    view, and `countTradesByBroker` answers ACCOUNT_NOT_FOUND for the dead id,
 *    so the user cannot even take them out again.
 *
 * ONE temp database per FILE; the `it`s inside each describe are ordered and
 * share state deliberately.
 */

let t: TempDb;
let trash: typeof import("@/lib/trash");
let sources: typeof import("@/lib/queries/import-sources");

const A1 = 1;
const A2 = 2;

/** A trade that is complete enough for the DB, keyed by its dedup hash. */
function seedTrade(accountId: number, broker: string, symbol: string, hash: string): number {
  return t.db
    .insert(t.schema.trades)
    .values({
      accountId, broker, bucket: "equity", segment: "eq_delivery", instrumentType: "equity",
      exchange: "NSE", symbol, tradingsymbol: symbol,
      buyQty: 10, avgBuyPrice: 100, buyValue: 1000, sellQty: 10, avgSellPrice: 110, sellValue: 1100,
      buyDate: "2026-06-01", sellDate: "2026-06-02", grossPnl: 100, netPnl: 90,
      dedupHash: hash,
    })
    .returning({ id: t.schema.trades.id })
    .get().id;
}

const tradesOf = (accountId: number, broker: string) =>
  t.db.select().from(t.schema.trades).where(and(eq(t.schema.trades.accountId, accountId), eq(t.schema.trades.broker, broker))).all();

beforeAll(async () => {
  t = await openTempDb("trash-restore-guards", { seed: true });
  trash = await import("@/lib/trash");
  sources = await import("@/lib/queries/import-sources");
  t.db.insert(t.schema.accounts).values({ id: A2, name: "Doomed", isDefault: false }).run();
});

afterAll(() => t?.cleanup());

describe("restore of a broker-remove after the clean re-import", () => {
  let snapshotId = "";

  it("removes the phantom rows and lets the fixed file back in", () => {
    // The Paytm shape: the old parser split one security into two phantom
    // positions.
    seedTrade(A1, "paytm", "PHANTOM-A", "old-hash-a");
    seedTrade(A1, "paytm", "PHANTOM-A", "old-hash-b");
    expect(tradesOf(A1, "paytm")).toHaveLength(2);

    snapshotId = trash.removeBrokerRows({ accountId: A1, broker: "paytm", actor: "test" }).snapshotId;
    expect(tradesOf(A1, "paytm")).toHaveLength(0);

    // The fixed parser pairs them on ISIN: ONE merged row, a hash that collides
    // with nothing in the snapshot.
    seedTrade(A1, "paytm", "PHANTOM-A", "new-merged-hash");
    expect(tradesOf(A1, "paytm")).toHaveLength(1);
  });

  it("REFUSES the restore, names the newer rows, and changes nothing", () => {
    const before = JSON.stringify(t.db.select().from(t.schema.trades).all());
    const res = trash.restoreTrashSnapshot(snapshotId, "test");

    expect(res.ok).toBe(false);
    expect(res.code).toBe("NEWER_ROWS");
    expect(res.restored).toBe(0);
    expect(res.message).toMatch(/1 paytm trade was imported after this removal/);
    expect(res.message).toMatch(/Nothing was changed\./);

    // The book is untouched: one merged row, not three.
    expect(tradesOf(A1, "paytm")).toHaveLength(1);
    expect(JSON.stringify(t.db.select().from(t.schema.trades).all())).toBe(before);
  });

  it("restores once the broker is empty again", () => {
    t.db.delete(t.schema.trades).where(and(eq(t.schema.trades.accountId, A1), eq(t.schema.trades.broker, "paytm"))).run();
    const res = trash.restoreTrashSnapshot(snapshotId, "test");
    expect(res.ok).toBe(true);
    expect(res.code).toBeUndefined();
    expect(res.restored).toBe(2);
    expect(tradesOf(A1, "paytm")).toHaveLength(2);
  });
});

describe("restore into an account deleted since the snapshot", () => {
  let snapshotId = "";

  it("refuses, plants no orphan row, and says which account is gone", () => {
    const id = seedTrade(A2, "dhan", "ORPHAN", "doomed-hash");
    const row = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;

    // An ORDINARY trade-delete envelope (no `env.account`): the v2 account
    // guard below it never runs for these, which is how the hole survived.
    snapshotId = trash.writeTrashSnapshot({
      trades: [row as unknown as Record<string, unknown>],
      legs: [], attachments: [],
      reason: "deleted for the guard test",
      accountId: A2,
    });
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, id)).run();
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, A2)).run();

    const res = trash.restoreTrashSnapshot(snapshotId, "test");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("ACCOUNT_GONE");
    expect(res.restored).toBe(0);
    expect(res.message).toMatch(/account 2 has been deleted since/);

    // No orphan: nothing at all landed in the dead account.
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, A2)).all()).toHaveLength(0);
    // ...which is what made the old behaviour unrecoverable — the only route
    // that could take such rows out refuses the dead id outright.
    expect(() => sources.countTradesByBroker(A2)).toThrow(expect.objectContaining({ code: "ACCOUNT_NOT_FOUND" }));
  });

  it("restores once the account is back", () => {
    t.db.insert(t.schema.accounts).values({ id: A2, name: "Doomed", isDefault: false }).run();
    const res = trash.restoreTrashSnapshot(snapshotId, "test");
    expect(res.ok).toBe(true);
    expect(res.restored).toBe(1);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, A2)).all()).toHaveLength(1);
  });
});

describe("the remove-broker audit row tells the whole truth", () => {
  it("names the broker in the summary and counts the ledger/IPO unlinks on both sides", () => {
    const id = seedTrade(A1, "groww", "AUDITME", "audit-hash");
    t.db.insert(t.schema.ledgerEntries).values({ accountId: A1, date: "2026-06-03", type: "charge", amountPaise: -100, refTradeId: id }).run();
    t.db.insert(t.schema.ipos).values({ accountId: A1, name: "IPO audit", tradeId: id }).run();

    trash.removeBrokerRows({ accountId: A1, broker: "groww", actor: "test" });

    const row = t.db.select().from(t.schema.auditLog).where(eq(t.schema.auditLog.action, "import.remove-broker")).all().at(-1)!;
    // The audit view renders CHANGED keys only, so "trades 122 → 0" alone read
    // as "the account was emptied". The broker is in the prose...
    expect(row.summary).toMatch(/^groww:/);
    expect(row.summary).toMatch(/other brokers are untouched/);
    // ...and the unlinks are keys that MOVE, so the diff shows them.
    expect(row.beforeJson).toMatchObject({ broker: "groww", trades: 1, unlinkedLedger: 0, unlinkedIpos: 0 });
    expect(row.afterJson).toMatchObject({ broker: "groww", trades: 0, unlinkedLedger: 1, unlinkedIpos: 1 });
    // Symmetric keys — lib/audit.ts throws in test on any asymmetry.
    expect(Object.keys(row.beforeJson!).sort()).toEqual(Object.keys(row.afterJson!).sort());
  });
});
