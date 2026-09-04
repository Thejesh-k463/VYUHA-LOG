import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Delete execution, against a real migrated database.
 *
 * The pure resolver decides WHAT gets deleted; this covers what actually
 * happens on disk — which is where the old implementation was wrong. It removed
 * the `trades` row and nothing else, leaving orphaned legs, orphaned attachment
 * rows and the attachment BYTES on disk forever, with no audit entry to say the
 * trade had ever existed.
 */

let t: TempDb;
let del: typeof import("@/lib/queries/delete");
let trashDir: string;

beforeAll(async () => {
  t = await openTempDb("delete", { seed: true });
  del = await import("@/lib/queries/delete");
  trashDir = (await import("@/lib/db")).trashDir;
});

afterAll(() => t?.cleanup());

function reset() {
  t.db.delete(t.schema.tradeAttachments).run();
  t.db.delete(t.schema.tradeLegs).run();
  t.db.delete(t.schema.trades).run();
  t.db.delete(t.schema.importBatches).run();
  t.db.delete(t.schema.auditLog).run();
  t.db.delete(t.schema.ipos).run();
  if (fs.existsSync(t.attachmentsDir)) fs.rmSync(t.attachmentsDir, { recursive: true, force: true });
  t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
}

function makeTrade(over: Record<string, unknown> = {}): number {
  return t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get()!.id;
}

function attach(tradeId: number, name: string) {
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, name), "PNG");
  t.db.insert(t.schema.tradeAttachments).values({ tradeId, fileName: name, storedName: name, mime: "image/png", sizeBytes: 3 }).run();
}

describe("a trade takes its belongings with it", () => {
  it("removes legs, attachment rows AND the files on disk", () => {
    reset();
    const id = makeTrade({ staged: true });
    t.db.insert(t.schema.tradeLegs).values([
      { tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-07-01", qty: 10, price: 100 },
      { tradeId: id, kind: "exit", seq: 2, tradeDate: "2026-07-02", qty: 10, price: 110 },
    ]).run();
    attach(id, "chart-del.png");

    const res = del.deleteTradesByIds([id], "test");
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(1);
    expect(res.legs).toBe(2);
    expect(res.attachments).toBe(1);

    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(0);
    expect(t.db.select().from(t.schema.tradeLegs).all()).toHaveLength(0);
    expect(t.db.select().from(t.schema.tradeAttachments).all()).toHaveLength(0);
    expect(fs.existsSync(path.join(t.attachmentsDir, "chart-del.png"))).toBe(false);
  });

  it("leaves OTHER trades' legs and attachments completely alone", () => {
    reset();
    const doomed = makeTrade();
    const keeper = makeTrade();
    t.db.insert(t.schema.tradeLegs).values({ tradeId: keeper, kind: "entry", seq: 1, tradeDate: "2026-07-01", qty: 5, price: 50 }).run();
    attach(keeper, "keep.png");
    attach(doomed, "go.png");

    del.deleteTradesByIds([doomed], "test");

    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toEqual([keeper]);
    expect(t.db.select().from(t.schema.tradeLegs).all()).toHaveLength(1);
    expect(fs.existsSync(path.join(t.attachmentsDir, "keep.png"))).toBe(true);
    expect(fs.existsSync(path.join(t.attachmentsDir, "go.png"))).toBe(false);
  });

  it("writes an audit entry carrying the deleted row, before it is gone", () => {
    reset();
    const id = makeTrade({ symbol: "AUDITME", netPnl: -1234.5 });
    del.deleteTradesByIds([id], "batch cleanup");

    const entries = t.db.select().from(t.schema.auditLog).all().filter((a) => a.action === "delete" && a.entity === "trade");
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toMatch(/batch cleanup/);
    // The before-snapshot is the only surviving record of what was removed.
    const before = entries[0].beforeJson as Record<string, unknown> | null;
    expect(before?.symbol).toBe("AUDITME");
    expect(before?.netPnl).toBe(-1234.5);
  });

  it("unlinks an IPO but never deletes the IPO record itself", () => {
    reset();
    const id = makeTrade();
    t.db.insert(t.schema.ipos).values({ name: "Test IPO", tradeId: id }).run();

    del.deleteTradesByIds([id], "test");

    const rows = t.db.select().from(t.schema.ipos).all();
    expect(rows).toHaveLength(1);           // the user's own IPO record survives
    expect(rows[0].tradeId).toBeNull();     // but no longer points at a dead id
  });
});

describe("account scoping is enforced at execution, not trusted", () => {
  it("refuses ids belonging to another account", () => {
    reset();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Other", isDefault: false }).onConflictDoNothing().run();
    const mine = makeTrade({ accountId: 1 });
    const theirs = makeTrade({ accountId: 2 });

    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
    const res = del.deleteTradesByIds([mine, theirs], "test");

    expect(res.deleted).toBe(1);
    const left = t.db.select().from(t.schema.trades).all().map((r) => r.id);
    expect(left).toEqual([theirs]); // the other account's trade is untouched
  });

  it("refuses everything when nothing in the list belongs to this account", () => {
    reset();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Other", isDefault: false }).onConflictDoNothing().run();
    const theirs = makeTrade({ accountId: 2 });
    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();

    const res = del.deleteTradesByIds([theirs], "test");
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(1);
  });
});

describe("refusals", () => {
  it("does nothing for an empty list", () => {
    reset();
    makeTrade();
    const res = del.deleteTradesByIds([], "test");
    expect(res.ok).toBe(false);
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(1);
  });

  it("ignores non-integer and negative ids rather than throwing", () => {
    reset();
    const res = del.deleteTradesByIds([-1, 0, 1.5, NaN], "test");
    expect(res.ok).toBe(false);
    expect(res.deleted).toBe(0);
  });

  it("de-duplicates a repeated id so the count is honest", () => {
    reset();
    const id = makeTrade();
    const res = del.deleteTradesByIds([id, id, id], "test");
    expect(res.deleted).toBe(1);
  });
});

describe("import batches", () => {
  function makeBatch(fileName = "dhan.csv"): number {
    return t.db.insert(t.schema.importBatches)
      .values({ accountId: 1, broker: "dhan", fileName, rowCount: 2, status: "completed" })
      .returning({ id: t.schema.importBatches.id }).get()!.id;
  }

  it("cascade removes the batch AND its trades", () => {
    reset();
    const b = makeBatch();
    makeTrade({ importBatchId: b });
    makeTrade({ importBatchId: b });
    const other = makeTrade();

    const res = del.deleteImportBatch(b, true);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(2);
    expect(res.batchRemoved).toBe(true);
    expect(t.db.select().from(t.schema.trades).all().map((r) => r.id)).toEqual([other]);
    expect(t.db.select().from(t.schema.importBatches).all()).toHaveLength(0);
  });

  it("without cascade the trades stay and only the record goes", () => {
    reset();
    const b = makeBatch();
    makeTrade({ importBatchId: b });

    const res = del.deleteImportBatch(b, false);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(0);
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(1);
    expect(t.db.select().from(t.schema.importBatches).all()).toHaveLength(0);
  });

  it("counts what a cascade would take, for the confirmation prompt", () => {
    reset();
    const b = makeBatch();
    makeTrade({ importBatchId: b });
    makeTrade({ importBatchId: b });
    makeTrade();
    expect(del.tradesInBatch(b)).toBe(2);
  });

  it("refuses a batch from another account", () => {
    reset();
    t.db.insert(t.schema.accounts).values({ id: 2, name: "Other", isDefault: false }).onConflictDoNothing().run();
    const b = t.db.insert(t.schema.importBatches)
      .values({ accountId: 2, broker: "dhan", fileName: "theirs.csv", rowCount: 1, status: "completed" })
      .returning({ id: t.schema.importBatches.id }).get()!.id;

    t.db.update(t.schema.settings).set({ selectedAccountId: 1 }).run();
    const res = del.deleteImportBatch(b, true);
    expect(res.ok).toBe(false);
    expect(t.db.select().from(t.schema.importBatches).all()).toHaveLength(1);
  });

  it("takes the batch's BROKER-STATED figures with a cascade, into the same snapshot", async () => {
    reset();
    t.db.delete(t.schema.brokerReference).run();
    const b = makeBatch("dhan-realised.csv");
    const kept = makeBatch("other.csv");
    makeTrade({ importBatchId: b });
    const ref = t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "dhan", sourceId: "dhan-realised-pnl", scope: "fy", key: "2026-27",
      figuresJson: JSON.stringify({ netPnl: 1234.5 }), importBatchId: b,
    }).returning({ id: t.schema.brokerReference.id }).get()!.id;
    // A figure belonging to a DIFFERENT batch must not be touched.
    t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "dhan", sourceId: "dhan-realised-pnl", scope: "fy", key: "2025-26",
      figuresJson: "{}", importBatchId: kept,
    }).run();

    const res = del.deleteImportBatch(b, true);
    expect(res.ok).toBe(true);
    // Without this, `reconcile()` kept comparing the broker's stated FY total
    // against a book that no longer holds any of the rows it describes.
    expect(t.db.select().from(t.schema.brokerReference).all().map((r) => r.key)).toEqual(["2025-26"]);

    const env = JSON.parse(fs.readFileSync(path.join(trashDir, res.snapshotId!, "snapshot.json"), "utf8"));
    expect(env.referenceRows).toHaveLength(1);
    expect(env.referenceRows[0]).toMatchObject({ id: ref, key: "2026-27", importBatchId: b });

    // …and the restore puts them back under the same id, so `import_batch_id`
    // still names the batch that stored them (`holdsBookTrades`).
    const trash = await import("@/lib/trash");
    const back = trash.restoreTrashSnapshot(res.snapshotId!, "test");
    expect(back.ok).toBe(true);
    const rows = t.db.select().from(t.schema.brokerReference).all();
    expect(rows.map((r) => r.key).sort()).toEqual(["2025-26", "2026-27"]);
    expect(rows.find((r) => r.key === "2026-27")).toMatchObject({ id: ref, importBatchId: b });
  });

  it("a reference-ONLY batch (figures, no trades) still gets a snapshot before its figures go", async () => {
    reset();
    t.db.delete(t.schema.brokerReference).run();
    const b = makeBatch("dhan-statement.csv");
    t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "dhan", sourceId: "dhan-realised-pnl", scope: "fy", key: "2024-25",
      figuresJson: JSON.stringify({ netPnl: 7 }), importBatchId: b,
    }).run();

    const res = del.deleteImportBatch(b, true);
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(0);
    expect(t.db.select().from(t.schema.brokerReference).all()).toHaveLength(0);
    // They were the only copy, so they are recoverable rather than destroyed.
    expect(res.snapshotId).toBeTruthy();
    const trash = await import("@/lib/trash");
    const back = trash.restoreTrashSnapshot(res.snapshotId!, "test");
    expect(back.ok).toBe(true);
    expect(t.db.select().from(t.schema.brokerReference).all().map((r) => r.key)).toEqual(["2024-25"]);
  });

  it("KEEPS them without a cascade — the trades stay, so the figures stated about them stay", () => {
    reset();
    t.db.delete(t.schema.brokerReference).run();
    const b = makeBatch("dhan-realised-2.csv");
    makeTrade({ importBatchId: b });
    t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "dhan", sourceId: "dhan-realised-pnl", scope: "fy", key: "2026-27",
      figuresJson: "{}", importBatchId: b,
    }).run();

    expect(del.deleteImportBatch(b, false).ok).toBe(true);
    // Deleting them here would silently reclassify the surviving trades as
    // BOOK trades in `holdsBookTrades` — the double-count guard the column
    // exists for.
    expect(t.db.select().from(t.schema.brokerReference).all()).toHaveLength(1);
    expect(t.db.select().from(t.schema.trades).all()).toHaveLength(1);
  });

  it("reports a missing batch instead of silently succeeding", () => {
    reset();
    expect(del.deleteImportBatch(9999, true).ok).toBe(false);
  });
});
