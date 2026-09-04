import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Delete → restore, against a real database and real files.
 *
 * This is the test that decides whether the confirmation dialog is telling the
 * truth. It says "a snapshot is saved first: these trades can be put back", and
 * the only way to know that sentence is honest is to delete something and put
 * it back.
 *
 * ONE temp database per FILE — Vitest gives one module registry per file and
 * lib/db caches its connection on globalThis, so a second openTempDb() here
 * would silently reuse the first (see tests/helpers/temp-db.ts).
 */

let t: TempDb;
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let trashDir: string;

beforeAll(async () => {
  t = await openTempDb("trash", { seed: true });
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  trashDir = (await import("@/lib/db")).trashDir;
});

afterAll(() => t?.cleanup());

function seedTrade(over: Record<string, unknown> = {}): number {
  const row = t.db.insert(t.schema.trades).values(tradeRow({ netPnl: 500, isOpen: false, ...over })).returning({ id: t.schema.trades.id }).get();
  return row.id;
}

function attach(tradeId: number, name: string) {
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, name), "PNG-BYTES");
  t.db.insert(t.schema.tradeAttachments).values({ tradeId, fileName: name, storedName: name, mime: "image/png", sizeBytes: 9 }).run();
}

const tradeCount = () => t.db.select().from(t.schema.trades).all().length;

describe("a delete leaves a snapshot behind", () => {
  it("writes one snapshot per delete and reports its id", () => {
    const id = seedTrade({ symbol: "SNAP", tradingsymbol: "SNAP" });
    const res = del.deleteTradesByIds([id], "test snapshot");

    expect(res.ok).toBe(true);
    expect(res.snapshotId).toBeTruthy();
    expect(fs.existsSync(path.join(trashDir, res.snapshotId!, "snapshot.json"))).toBe(true);
  });

  it("says in the result message where the trades can be found", () => {
    const id = seedTrade({ symbol: "MSG", tradingsymbol: "MSG" });
    const res = del.deleteTradesByIds([id], "test message");
    expect(res.message).toMatch(/Deleted items/i);
  });

  it("v4 format: an ordinary delete carries no broker-remove labels, and older envelopes still validate", async () => {
    const fmt = await import("@/lib/trash-format");
    expect(fmt.TRASH_VERSION).toBe(4);
    const id = seedTrade({ symbol: "PLAIN", tradingsymbol: "PLAIN" });
    const res = del.deleteTradesByIds([id], "plain delete");
    const env = JSON.parse(fs.readFileSync(path.join(trashDir, res.snapshotId!, "snapshot.json"), "utf8"));
    expect(env.v).toBe(4);
    expect("kind" in env).toBe(false);
    expect("broker" in env).toBe(false);
    // An ordinary trade delete carries no reference rows, so the field is
    // absent exactly as it was before the bump — the v4 field is additive.
    expect("referenceRows" in env).toBe(false);
    const summary = trash.listTrashSnapshots().find((s) => s.id === res.snapshotId)!;
    expect("kind" in summary).toBe(false);
    // Additive bump: a v3 (and v2, v1) envelope is still readable.
    for (const v of [1, 2, 3]) {
      expect(fmt.validateTrashEnvelope({ ...env, v }).ok).toBe(true);
    }
    expect(fmt.validateTrashEnvelope({ ...env, v: 5 }).ok).toBe(false);
  });

  it("lists the snapshot with an honest summary", () => {
    const id = seedTrade({ symbol: "LISTED", tradingsymbol: "LISTED", netPnl: -1234 });
    const res = del.deleteTradesByIds([id], "test listing");

    const found = trash.listTrashSnapshots().find((s) => s.id === res.snapshotId);
    expect(found).toBeDefined();
    expect(found!.trades).toBe(1);
    expect(found!.symbols).toContain("LISTED");
    expect(found!.netPnl).toBe(-1234);
    expect(found!.reason).toBe("test listing");
    expect(found!.sizeBytes).toBeGreaterThan(0);
  });
});

describe("restore puts the trades back", () => {
  it("returns the row under its ORIGINAL id, so nothing that pointed at it is orphaned", () => {
    const id = seedTrade({ symbol: "BACK", tradingsymbol: "BACK", netPnl: 777 });
    const before = tradeCount();

    const res = del.deleteTradesByIds([id], "restore me");
    expect(tradeCount()).toBe(before - 1);

    const back = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(back.ok).toBe(true);
    expect(back.restored).toBe(1);
    expect(tradeCount()).toBe(before);

    const row = t.db.select().from(t.schema.trades).all().find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.symbol).toBe("BACK");
    // Money survives the JSON round trip: paise in the column, rupees here.
    expect(row!.netPnl).toBe(777);
  });

  it("brings the staged legs back with the trade", () => {
    const id = seedTrade({ symbol: "LEGS", tradingsymbol: "LEGS", staged: true });
    t.db.insert(t.schema.tradeLegs).values({ tradeId: id, kind: "entry", seq: 1, tradeDate: "2026-07-01", qty: 10, price: 100 }).run();

    const res = del.deleteTradesByIds([id], "legs");
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === id)).toHaveLength(0);

    const back = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(back.legs).toBe(1);
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === id)).toHaveLength(1);
  });

  it("moves attachment BYTES into the snapshot rather than deleting them, and copies them back", () => {
    const id = seedTrade({ symbol: "PIC", tradingsymbol: "PIC" });
    attach(id, "chart-restore.png");

    const res = del.deleteTradesByIds([id], "attachment");
    // Gone from the live directory...
    expect(fs.existsSync(path.join(t.attachmentsDir, "chart-restore.png"))).toBe(false);
    // ...but held in the snapshot, not destroyed.
    expect(fs.existsSync(path.join(trashDir, res.snapshotId!, "files", "chart-restore.png"))).toBe(true);

    const back = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(back.attachments).toBe(1);
    expect(fs.readFileSync(path.join(t.attachmentsDir, "chart-restore.png"), "utf8")).toBe("PNG-BYTES");
  });

  it("unlinks ledger entries on delete (keeping the cashflow) and re-links them on restore", () => {
    const id = seedTrade({ symbol: "LEDG", tradingsymbol: "LEDG" });
    const ledger = t.db
      .insert(t.schema.ledgerEntries)
      .values({ date: "2026-07-10", type: "charge", amountPaise: -12345, refTradeId: id, note: "brokerage" })
      .returning({ id: t.schema.ledgerEntries.id })
      .get();

    const res = del.deleteTradesByIds([id], "ledger link");

    // The cashflow survives the trade — money that moved stays recorded — but
    // its ref no longer points at a row that does not exist.
    const afterDelete = t.db.select().from(t.schema.ledgerEntries).all().find((l) => l.id === ledger.id);
    expect(afterDelete).toBeDefined();
    expect(afterDelete!.refTradeId).toBeNull();

    const back = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(back.restored).toBe(1);
    const afterRestore = t.db.select().from(t.schema.ledgerEntries).all().find((l) => l.id === ledger.id);
    expect(afterRestore!.refTradeId).toBe(id);
  });

  it("never overwrites a ledger ref the user re-linked after the delete", () => {
    const id = seedTrade({ symbol: "RELINK", tradingsymbol: "RELINK" });
    const other = seedTrade({ symbol: "OTHER", tradingsymbol: "OTHER" });
    const ledger = t.db
      .insert(t.schema.ledgerEntries)
      .values({ date: "2026-07-11", type: "charge", amountPaise: -500, refTradeId: id })
      .returning({ id: t.schema.ledgerEntries.id })
      .get();

    const res = del.deleteTradesByIds([id], "relink race");
    // The user points the entry at another trade before restoring.
    t.db.update(t.schema.ledgerEntries).set({ refTradeId: other }).where(eq(t.schema.ledgerEntries.id, ledger.id)).run();
    trash.restoreTrashSnapshot(res.snapshotId!);
    const after = t.db.select().from(t.schema.ledgerEntries).all().find((l) => l.id === ledger.id);
    expect(after!.refTradeId).toBe(other);
  });

  it("keeps the snapshot after a successful restore", () => {
    const id = seedTrade({ symbol: "KEEP", tradingsymbol: "KEEP" });
    const res = del.deleteTradesByIds([id], "keep the snapshot");
    trash.restoreTrashSnapshot(res.snapshotId!);
    // Deleting the recovery at the moment the user is checking it worked is
    // not a tidy-up.
    expect(fs.existsSync(path.join(trashDir, res.snapshotId!, "snapshot.json"))).toBe(true);
  });
});

describe("restore refuses rather than duplicating", () => {
  it("skips a trade whose id is already taken and names it", () => {
    const id = seedTrade({ symbol: "TAKEN", tradingsymbol: "TAKEN" });
    const res = del.deleteTradesByIds([id], "conflict");

    // Restore once — it comes back.
    expect(trash.restoreTrashSnapshot(res.snapshotId!).restored).toBe(1);
    const after = tradeCount();

    // Restore the same snapshot again — the id is now occupied by the row we
    // just put back. A second copy would silently double every figure derived
    // from this trade.
    const second = trash.restoreTrashSnapshot(res.snapshotId!);
    expect(second.restored).toBe(0);
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0].symbol).toBe("TAKEN");
    expect(second.message).toMatch(/could not be restored/i);
    expect(tradeCount()).toBe(after);
  });

  it("refuses an id that could escape the trash directory", () => {
    for (const bad of ["../../etc", "..", "a/b", ""]) {
      expect(trash.restoreTrashSnapshot(bad).ok).toBe(false);
      expect(trash.purgeTrashSnapshot(bad).ok).toBe(false);
    }
  });

  it("reports a missing snapshot instead of throwing", () => {
    const r = trash.restoreTrashSnapshot("2026-01-01T00-00-00-000Z-deadbeef");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/missing or unreadable/i);
  });
});

describe("purge", () => {
  it("removes the snapshot and its stashed bytes for good", () => {
    const id = seedTrade({ symbol: "PURGE", tradingsymbol: "PURGE" });
    attach(id, "chart-purge.png");
    const res = del.deleteTradesByIds([id], "purge");

    const gone = trash.purgeTrashSnapshot(res.snapshotId!);
    expect(gone.ok).toBe(true);
    expect(gone.message).toMatch(/no longer be recovered/i);
    expect(fs.existsSync(path.join(trashDir, res.snapshotId!))).toBe(false);
    expect(trash.listTrashSnapshots().find((s) => s.id === res.snapshotId)).toBeUndefined();
  });

  it("says so when there is nothing to purge", () => {
    expect(trash.purgeTrashSnapshot("2026-01-01T00-00-00-000Z-cafe").ok).toBe(false);
  });
});

describe("broker-remove takes the broker's stated figures with it (v4)", () => {
  it("snapshots them, deletes them, and brings them back on restore", () => {
    // The v3.8 remove took every Dhan trade and left Dhan's stated totals
    // behind, so `reconcile()` (lib/queries/reference.ts) went on comparing
    // the broker's own figures against a book with none of those rows in it.
    t.db.delete(t.schema.brokerReference).run();
    const id = seedTrade({ broker: "dhan", symbol: "REFB", tradingsymbol: "REFB" });
    const batch = t.db.insert(t.schema.importBatches)
      .values({ accountId: 1, broker: "dhan", fileName: "dhan-realised.csv", rowCount: 1, status: "completed" })
      .returning({ id: t.schema.importBatches.id }).get()!.id;
    const mine = t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "dhan", sourceId: "dhan-realised-pnl", scope: "fy", key: "2026-27",
      figuresJson: JSON.stringify({ netPnl: 99 }), importBatchId: batch,
    }).returning({ id: t.schema.brokerReference.id }).get()!.id;
    // Another broker's figure in the same account must survive untouched.
    t.db.insert(t.schema.brokerReference).values({
      accountId: 1, broker: "groww", sourceId: "groww-realised-pnl", scope: "fy", key: "2026-27", figuresJson: "{}",
    }).run();

    const res = trash.removeBrokerRows({ accountId: 1, broker: "dhan", actor: "test" });
    expect(res.removed.referenceRows).toBe(1);
    expect(res.message).toMatch(/broker-stated figure/);
    expect(t.db.select().from(t.schema.brokerReference).all().map((r) => r.broker)).toEqual(["groww"]);

    const env = JSON.parse(fs.readFileSync(path.join(trashDir, res.snapshotId, "snapshot.json"), "utf8"));
    expect(env.referenceRows).toHaveLength(1);
    expect(env.referenceRows[0]).toMatchObject({ id: mine, broker: "dhan", importBatchId: batch });

    const back = trash.restoreTrashSnapshot(res.snapshotId, "test");
    expect(back.ok).toBe(true);
    const rows = t.db.select().from(t.schema.brokerReference).all();
    expect(rows.map((r) => r.broker).sort()).toEqual(["dhan", "groww"]);
    // ORIGINAL id and batch link — `holdsBookTrades` reads `import_batch_id`.
    expect(rows.find((r) => r.broker === "dhan")).toMatchObject({ id: mine, importBatchId: batch });
    expect(t.db.select().from(t.schema.trades).all().filter((r) => r.id === id)).toHaveLength(1);
  });
});
