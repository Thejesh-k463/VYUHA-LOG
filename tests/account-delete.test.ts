import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * Account deletion with scoped options (v3.1) — purge and merge, against a
 * real migrated database.
 *
 * ONE temp database per FILE (see tests/helpers/temp-db.ts), so the tests run
 * in file order and each block uses its own account ids: the seed's account 1
 * ("Primary", default) stays alive throughout as the last-live anchor.
 */

let t: TempDb;
let mod: typeof import("@/lib/queries/account-delete");
let trash: typeof import("@/lib/trash");
let trashDir: string;

beforeAll(async () => {
  t = await openTempDb("accdel", { seed: true });
  mod = await import("@/lib/queries/account-delete");
  trash = await import("@/lib/trash");
  trashDir = (await import("@/lib/db")).trashDir;
});

afterAll(() => t?.cleanup());

function addAccount(id: number, name: string, over: Record<string, unknown> = {}) {
  t.db.insert(t.schema.accounts).values({ id, name, ...over }).run();
}
function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}
const selected = () => t.db.select().from(t.schema.settings).all()[0].selectedAccountId;

function addTrade(over: Record<string, unknown>): number {
  return t.db.insert(t.schema.trades).values(tradeRow(over)).returning({ id: t.schema.trades.id }).get().id;
}
function attach(tradeId: number, name: string) {
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, name), "PNG-BYTES");
  t.db.insert(t.schema.tradeAttachments).values({ tradeId, fileName: name, storedName: name, mime: "image/png", sizeBytes: 9 }).run();
}
function readEnvelope(snapshotId: string): Record<string, unknown> & {
  account?: { id: number; name: string };
  accountRows?: Record<string, Record<string, unknown>[]>;
  merge?: { targetId: number; targetName: string; carried: number };
  trades: unknown[];
} {
  return JSON.parse(fs.readFileSync(path.join(trashDir, snapshotId, "snapshot.json"), "utf8"));
}

/** Rows an account still holds, per scoped table. */
function scopedRows(accountId: number) {
  const inAcc = <T extends { accountId: number }>(rows: T[]) => rows.filter((r) => r.accountId === accountId);
  return {
    trades: inAcc(t.db.select().from(t.schema.trades).all()),
    importBatches: inAcc(t.db.select().from(t.schema.importBatches).all()),
    ipos: inAcc(t.db.select().from(t.schema.ipos).all()),
    ledgerEntries: inAcc(t.db.select().from(t.schema.ledgerEntries).all()),
    tradingSessions: inAcc(t.db.select().from(t.schema.tradingSessions).all()),
    capitalSnapshots: inAcc(t.db.select().from(t.schema.capitalSnapshots).all()),
    brokerConnections: inAcc(t.db.select().from(t.schema.brokerConnections).all()),
    panelDismissals: inAcc(t.db.select().from(t.schema.panelDismissals).all()),
  };
}

describe("refusals", () => {
  it("refuses to delete the last live account", () => {
    // Only the seeded "Primary" exists at this point in the file.
    const res = mod.deleteAccount({ accountId: 1, mode: "purge", connections: "delete" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/last live account/i);
    expect(mod.previewAccountDelete({ accountId: 1, mode: "purge" }).ok).toBe(false);
    expect(t.db.select().from(t.schema.accounts).all()).toHaveLength(1);
  });

  it("refuses an account that does not exist", () => {
    addAccount(2, "Second"); // from here on, deletes are structurally possible
    const res = mod.deleteAccount({ accountId: 999, mode: "purge", connections: "delete" });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/no longer exists/i);
  });

  it("refuses a merge without a valid target: missing, 0, self, nonexistent", () => {
    for (const targetId of [undefined, null, 0, -3] as const) {
      const res = mod.deleteAccount({ accountId: 2, mode: "merge", targetId, connections: "delete" });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/destination/i);
    }
    expect(mod.deleteAccount({ accountId: 2, mode: "merge", targetId: 2, connections: "delete" }).message).toMatch(/itself/i);
    expect(mod.deleteAccount({ accountId: 2, mode: "merge", targetId: 999, connections: "delete" }).message).toMatch(/destination account no longer exists/i);
    // Nothing above deleted anything.
    expect(t.db.select().from(t.schema.accounts).all().map((a) => a.id).sort()).toEqual([1, 2]);
  });
});

describe("purge", () => {
  let snapshotId: string;
  let tr1: number, tr2: number;

  it("removes every scoped row, the children, the account — and moves the selection", () => {
    addAccount(10, "Doomed-Purge");
    tr1 = addTrade({ accountId: 10, symbol: "PRG1", tradingsymbol: "PRG1", netPnl: 100 });
    tr2 = addTrade({ accountId: 10, symbol: "PRG2", tradingsymbol: "PRG2", netPnl: -50 });
    t.db.insert(t.schema.tradeLegs).values({ tradeId: tr1, kind: "entry", seq: 1, tradeDate: "2026-08-01", qty: 10, price: 100 }).run();
    attach(tr1, "purge-shot.png");
    t.db.insert(t.schema.importBatches).values({ accountId: 10, broker: "dhan", fileName: "purge.csv", rowCount: 2 }).run();
    t.db.insert(t.schema.ipos).values({ accountId: 10, name: "PURGE IPO", tradeId: tr1 }).run();
    t.db.insert(t.schema.ledgerEntries).values([
      { accountId: 10, date: "2026-08-01", type: "deposit", amountPaise: 1_000_00, bucket: "equity" },
      { accountId: 10, date: "2026-08-02", type: "charge", amountPaise: -500, refTradeId: tr2 },
    ]).run();
    t.db.insert(t.schema.tradingSessions).values({ accountId: 10, sessionDate: "2026-08-01" }).run();
    t.db.insert(t.schema.capitalSnapshots).values({ accountId: 10, bucket: "equity", asOfDate: "2026-08-01", openingCapital: 1000 }).run();
    t.db.insert(t.schema.brokerConnections).values({ accountId: 10, broker: "dhan", apiKey: "k", accessToken: "t" }).run();
    t.db.insert(t.schema.panelDismissals).values({ accountId: 10, panel: "risk", fingerprint: "fp-1" }).run();
    selectAccount(10);

    const res = mod.deleteAccount({ accountId: 10, mode: "purge", connections: "delete" });
    expect(res.ok).toBe(true);
    expect(res.snapshotId).toBeTruthy();
    snapshotId = res.snapshotId!;

    // Zero rows across all 8 scoped tables.
    const left = scopedRows(10);
    for (const [tbl, rows] of Object.entries(left)) {
      expect(rows, `${tbl} still holds rows for the purged account`).toHaveLength(0);
    }
    // Children went with the trades.
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === tr1)).toHaveLength(0);
    expect(t.db.select().from(t.schema.tradeAttachments).all().filter((a) => a.tradeId === tr1)).toHaveLength(0);
    // The account row itself is gone; selection moved to the default account.
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 10)).toBeUndefined();
    expect(selected()).toBe(1);
    // The preview-shaped counts report what was removed.
    expect(res.counts).toMatchObject({ trades: 2, legs: 1, attachments: 1, importBatches: 1, ipos: 1, ledgerEntries: 2, tradingSessions: 1, capitalSnapshots: 1, brokerConnections: 1, panelDismissals: 1 });
    // Attachment BYTES moved into the snapshot, not destroyed.
    expect(fs.existsSync(path.join(t.attachmentsDir, "purge-shot.png"))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, snapshotId, "files", "purge-shot.png"))).toBe(true);
  });

  it("the trash envelope carries the account row and every destroyed scoped row — but never credentials", () => {
    const env = readEnvelope(snapshotId);
    expect(env.account).toMatchObject({ id: 10, name: "Doomed-Purge" });
    expect(env.trades).toHaveLength(2);
    expect(env.accountRows!.ipos).toHaveLength(1);
    expect(env.accountRows!.ledgerEntries).toHaveLength(2);
    expect(env.accountRows!.importBatches).toHaveLength(1);
    expect(env.accountRows!.tradingSessions).toHaveLength(1);
    expect(env.accountRows!.capitalSnapshots).toHaveLength(1);
    // Credentials must never enter a trash file.
    expect(JSON.stringify(env)).not.toContain("brokerConnections");
    expect(JSON.stringify(env)).not.toContain('"apiKey"');
  });

  it("restore recreates the account and puts its trades AND scoped rows back", () => {
    const back = trash.restoreTrashSnapshot(snapshotId);
    expect(back.ok).toBe(true);
    expect(back.restored).toBe(2);
    expect(back.message).toMatch(/recreated/i);
    const acc = t.db.select().from(t.schema.accounts).all().find((a) => a.id === 10);
    expect(acc?.name).toBe("Doomed-Purge");
    expect(t.db.select().from(t.schema.trades).all().filter((r) => r.accountId === 10).map((r) => r.id).sort()).toEqual([tr1, tr2].sort());
    // The account-scoped tables round-trip too (the blocker fix): ipos,
    // ledger, imports, sessions and capital history are back in the book.
    const back10 = scopedRows(10);
    expect(back10.ipos).toHaveLength(1);
    expect(back10.ipos[0]).toMatchObject({ name: "PURGE IPO", tradeId: tr1 });
    expect(back10.ledgerEntries).toHaveLength(2);
    expect(back10.ledgerEntries.find((l) => l.amountPaise === -500)!.refTradeId).toBe(tr2);
    expect(back10.importBatches).toHaveLength(1);
    expect(back10.tradingSessions).toHaveLength(1);
    expect(back10.tradingSessions[0].sessionDate).toBe("2026-08-01");
    expect(back10.capitalSnapshots).toHaveLength(1);
    expect(back10.capitalSnapshots[0].openingCapital).toBe(1000);
    // Connections were never snapshotted, so none can come back.
    expect(back10.brokerConnections).toHaveLength(0);
    expect(back.message).toMatch(/came back with it/i);
  });
});

describe("merge", () => {
  let keepA: number, keepB: number, dup: number;
  let res: ReturnType<typeof mod.deleteAccount>;

  it("moves the journal under unchanged trade ids and skips exactly the collisions", () => {
    addAccount(20, "Merge-Source", { pnlRolledIn: 100 });
    addAccount(21, "Merge-Target", { pnlRolledIn: 50 });

    // Target already holds one identical trade, one session on 2026-08-01 and
    // a dhan connection — the three collision surfaces.
    addTrade({ accountId: 21, broker: "dhan", dedupHash: "dup-1", symbol: "DUPT", tradingsymbol: "DUPT" });
    t.db.insert(t.schema.tradingSessions).values({ accountId: 21, sessionDate: "2026-08-01", maxTrades: 9 }).run();
    t.db.insert(t.schema.brokerConnections).values({ accountId: 21, broker: "dhan", apiKey: "target-key", accessToken: "tt" }).run();

    keepA = addTrade({ accountId: 20, broker: "dhan", dedupHash: "keep-a", symbol: "KEEPA", tradingsymbol: "KEEPA" });
    keepB = addTrade({ accountId: 20, broker: "dhan", dedupHash: "keep-b", symbol: "KEEPB", tradingsymbol: "KEEPB" });
    dup = addTrade({ accountId: 20, broker: "dhan", dedupHash: "dup-1", symbol: "DUPS", tradingsymbol: "DUPS" });
    t.db.insert(t.schema.tradeLegs).values({ tradeId: keepA, kind: "entry", seq: 1, tradeDate: "2026-08-01", qty: 5, price: 50 }).run();
    attach(keepA, "merge-keep.png");
    attach(dup, "merge-dup.png");
    t.db.insert(t.schema.importBatches).values({ accountId: 20, broker: "dhan", fileName: "merge.csv", rowCount: 3 }).run();
    t.db.insert(t.schema.ipos).values({ accountId: 20, name: "MERGE IPO", tradeId: keepA }).run();
    t.db.insert(t.schema.ledgerEntries).values([
      { accountId: 20, date: "2026-08-01", type: "charge", amountPaise: -100, refTradeId: keepA },
      { accountId: 20, date: "2026-08-02", type: "charge", amountPaise: -200, refTradeId: dup },
    ]).run();
    t.db.insert(t.schema.tradingSessions).values([
      { accountId: 20, sessionDate: "2026-08-01", maxTrades: 2 }, // collides — discarded
      { accountId: 20, sessionDate: "2026-08-02", maxTrades: 3 }, // moves
    ]).run();
    t.db.insert(t.schema.capitalSnapshots).values({ accountId: 20, bucket: "equity", asOfDate: "2026-08-01", openingCapital: 500 }).run();
    t.db.insert(t.schema.panelDismissals).values({ accountId: 20, panel: "risk", fingerprint: "fp-2" }).run();
    t.db.insert(t.schema.brokerConnections).values([
      { accountId: 20, broker: "dhan", apiKey: "source-key", accessToken: "st" }, // collides — removed
      { accountId: 20, broker: "zerodha", apiKey: "zk", accessToken: "zt" }, // moves
    ]).run();
    selectAccount(20);

    const preview = mod.previewAccountDelete({ accountId: 20, mode: "merge", targetId: 21 });
    expect(preview.ok).toBe(true);
    expect(preview.dedupCollisions).toBe(1);
    expect(preview.sessionCollisions).toBe(1);
    expect(preview.warnings!.join(" ")).toMatch(/already connected to dhan/i);
    expect(preview.counts).toMatchObject({ trades: 3, brokerConnections: 2, tradingSessions: 2 });

    res = mod.deleteAccount({ accountId: 20, mode: "merge", targetId: 21, connections: "move" });
    expect(res.ok).toBe(true);
    expect(res.skippedTrades).toBe(1);
    expect(res.discardedSessions).toBe(1);
    expect(res.movedConnections).toBe(1);
    expect(res.skippedConnections).toEqual(["dhan"]);

    // Trade ids unchanged; children still point at the same ids.
    const all = t.db.select().from(t.schema.trades).all();
    const a = all.find((r) => r.id === keepA)!;
    const b = all.find((r) => r.id === keepB)!;
    expect(a.accountId).toBe(21);
    expect(b.accountId).toBe(21);
    expect(all.find((r) => r.id === dup)).toBeUndefined();
    expect(t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === keepA)).toHaveLength(1);
    expect(t.db.select().from(t.schema.tradeAttachments).all().filter((x) => x.tradeId === keepA)).toHaveLength(1);
    // The ipo link and the ledger ref survive; the ref at the skipped dup is unlinked.
    const ipo = t.db.select().from(t.schema.ipos).all().find((i) => i.name === "MERGE IPO")!;
    expect(ipo.accountId).toBe(21);
    expect(ipo.tradeId).toBe(keepA);
    const moved = t.db.select().from(t.schema.ledgerEntries).all().filter((l) => l.accountId === 21);
    expect(moved).toHaveLength(2);
    expect(moved.find((l) => l.amountPaise === -100)!.refTradeId).toBe(keepA);
    expect(moved.find((l) => l.amountPaise === -200)!.refTradeId).toBeNull();
    // Sessions: the colliding date kept the TARGET's plan; the other moved.
    const sessions21 = t.db.select().from(t.schema.tradingSessions).all().filter((s) => s.accountId === 21);
    expect(sessions21.find((s) => s.sessionDate === "2026-08-01")!.maxTrades).toBe(9);
    expect(sessions21.find((s) => s.sessionDate === "2026-08-02")!.maxTrades).toBe(3);
    // Capital snapshots and dismissals discard; nothing left keyed to 20.
    const left = scopedRows(20);
    for (const [tbl, rows] of Object.entries(left)) {
      expect(rows, `${tbl} still holds rows for the merged-away account`).toHaveLength(0);
    }
    expect(t.db.select().from(t.schema.capitalSnapshots).all().filter((c) => c.accountId === 21)).toHaveLength(0);
    // Connections: zerodha moved; dhan kept the TARGET's credentials only.
    const conns21 = t.db.select().from(t.schema.brokerConnections).all().filter((c) => c.accountId === 21);
    expect(conns21.map((c) => c.broker).sort()).toEqual(["dhan", "zerodha"]);
    expect(conns21.find((c) => c.broker === "dhan")!.apiKey).toBe("target-key");
    // Account row gone. The rolled-in marker carries only min(marker, moved
    // realised P&L): every moved trade here has netPnl 0, so carried = 0 and
    // the target keeps its own 50 — NOT 150, which would have pushed the
    // target's marker past its realised total (negative "available").
    expect(t.db.select().from(t.schema.accounts).all().find((x) => x.id === 20)).toBeUndefined();
    expect(t.db.select().from(t.schema.accounts).all().find((x) => x.id === 21)!.pnlRolledIn).toBe(50);
    // Selection followed the journal to the target.
    expect(selected()).toBe(21);
  });

  it("the merge snapshot carries the account row, the skipped trades and what merge discarded", () => {
    const env = readEnvelope(res.snapshotId!);
    expect(env.account).toMatchObject({ id: 20, name: "Merge-Source" });
    expect(env.trades).toHaveLength(1);
    expect((env.trades as { symbol: string }[])[0].symbol).toBe("DUPS");
    // What merge destroys travels too: the colliding session and the source's
    // capital checkpoint. Moved tables (imports/IPOs/ledger) need no snapshot.
    expect(env.accountRows!.tradingSessions).toHaveLength(1);
    expect(env.accountRows!.tradingSessions[0].sessionDate).toBe("2026-08-01");
    expect(env.accountRows!.capitalSnapshots).toHaveLength(1);
    expect(env.accountRows!.ipos).toHaveLength(0);
    expect(env.accountRows!.importBatches).toHaveLength(0);
    // The marker carry is recorded: nothing moved carried realised P&L here.
    expect(env.merge).toMatchObject({ targetId: 21, targetName: "Merge-Target", carried: 0 });
    // The skipped duplicate's screenshot moved into the snapshot; the moved
    // trade's file stayed in the live attachments directory.
    expect(fs.existsSync(path.join(trashDir, res.snapshotId!, "files", "merge-dup.png"))).toBe(true);
    expect(fs.existsSync(path.join(t.attachmentsDir, "merge-keep.png"))).toBe(true);
  });

  it("connections:'delete' removes the source connections instead of moving them", () => {
    addAccount(30, "Conn-Del", {});
    addAccount(31, "Conn-Del-Target", {});
    t.db.insert(t.schema.brokerConnections).values({ accountId: 30, broker: "groww", apiKey: "gk", accessToken: "gt" }).run();
    const r = mod.deleteAccount({ accountId: 30, mode: "merge", targetId: 31, connections: "delete" });
    expect(r.ok).toBe(true);
    expect(r.movedConnections).toBe(0);
    expect(r.skippedConnections).toEqual([]);
    const conns = t.db.select().from(t.schema.brokerConnections).all();
    expect(conns.filter((c) => c.accountId === 30)).toHaveLength(0);
    expect(conns.filter((c) => c.accountId === 31)).toHaveLength(0);
  });
});

describe("pnlRolledIn carry (merge) and its restore", () => {
  let rollRes: ReturnType<typeof mod.deleteAccount>;

  it("carries min(marker, moved realised P&L) — never the full marker", () => {
    addAccount(60, "Roll-Src", { pnlRolledIn: 300 });
    addAccount(61, "Roll-Tgt", { pnlRolledIn: 100 });
    // Target already holds the identical trade — its ₹50 stays out of the move.
    addTrade({ accountId: 61, broker: "dhan", dedupHash: "roll-dup", symbol: "RDUP", tradingsymbol: "RDUP", netPnl: 50, isOpen: false });
    addTrade({ accountId: 60, broker: "dhan", dedupHash: "roll-dup", symbol: "RDUP", tradingsymbol: "RDUP", netPnl: 50, isOpen: false }); // collides — deleted
    addTrade({ accountId: 60, broker: "dhan", dedupHash: "roll-move", symbol: "RMOV", tradingsymbol: "RMOV", netPnl: 200, isOpen: false }); // moves
    addTrade({ accountId: 60, broker: "dhan", dedupHash: "roll-open", symbol: "ROPN", tradingsymbol: "ROPN", netPnl: 999, isOpen: true }); // open — no realised P&L

    rollRes = mod.deleteAccount({ accountId: 60, mode: "merge", targetId: 61, connections: "delete" });
    expect(rollRes.ok).toBe(true);
    // carried = min(300, max(0, 200)) = 200 → target 100 + 200 = 300, not 400.
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 61)!.pnlRolledIn).toBe(300);
    expect(readEnvelope(rollRes.snapshotId!).merge).toMatchObject({ targetId: 61, targetName: "Roll-Tgt", carried: 200 });
  });

  it("restore recreates the source with the residue and subtracts carried from the target", () => {
    const back = trash.restoreTrashSnapshot(rollRes.snapshotId!);
    expect(back.ok).toBe(true);
    expect(back.message).toMatch(/recreated/i);
    // Source: original 300 − carried 200 = 100. Target: 300 − 200 = 100.
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 60)!.pnlRolledIn).toBe(100);
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 61)!.pnlRolledIn).toBe(100);
  });
});

describe("dup twins: merging two identical fully-compounded books", () => {
  let capital: typeof import("@/lib/queries/capital");

  beforeAll(async () => {
    capital = await import("@/lib/queries/capital");
  });

  it("keeps the target's available at ≥ 0 (the old full-marker carry pushed it negative)", () => {
    addAccount(40, "Twin-A", { pnlRolledIn: 1000 });
    addAccount(41, "Twin-B", { pnlRolledIn: 1000, equityCapital: 10000, activeCapital: 0 });
    addTrade({ accountId: 40, broker: "dhan", dedupHash: "twin-1", symbol: "TWIN", tradingsymbol: "TWIN", bucket: "equity", netPnl: 1000, isOpen: false });
    addTrade({ accountId: 41, broker: "dhan", dedupHash: "twin-1", symbol: "TWIN", tradingsymbol: "TWIN", bucket: "equity", netPnl: 1000, isOpen: false });

    const r = mod.deleteAccount({ accountId: 40, mode: "merge", targetId: 41, connections: "delete" });
    expect(r.ok).toBe(true);
    expect(r.skippedTrades).toBe(1); // the whole book collided — nothing moved
    // carried = min(1000, max(0, 0)) = 0 → the target keeps its own marker.
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 41)!.pnlRolledIn).toBe(1000);

    selectAccount(41);
    const sum = capital.getCapitalSummary();
    expect(sum.available).toBeGreaterThanOrEqual(0);
    expect(sum.available).toBe(0);
  });

  it("compoundRealised refuses a negative available instead of withdrawing capital", () => {
    // Force the pathological state an old-style merge could create.
    t.db.update(t.schema.accounts).set({ pnlRolledIn: 1500 }).where(eq(t.schema.accounts.id, 41)).run();
    const res = capital.compoundRealised("equity");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/withdraw/i);
    // Nothing moved: capital and marker untouched, no checkpoint written.
    const acc = t.db.select().from(t.schema.accounts).all().find((a) => a.id === 41)!;
    expect(acc.equityCapital).toBe(10000);
    expect(acc.pnlRolledIn).toBe(1500);
    expect(t.db.select().from(t.schema.capitalSnapshots).all().filter((c) => c.accountId === 41)).toHaveLength(0);
  });
});

describe("restore refuses a conflicted account outright", () => {
  let snapId: string;
  let oldTrade: number;

  it("refuses when the id now belongs to a DIFFERENT account — and restores nothing", () => {
    addAccount(80, "Old-Book");
    oldTrade = addTrade({ accountId: 80, symbol: "OLDB", tradingsymbol: "OLDB" });
    const r = mod.deleteAccount({ accountId: 80, mode: "purge", connections: "delete" });
    expect(r.ok).toBe(true);
    snapId = r.snapshotId!;
    // The id gets reused by a new, unrelated account before the restore runs.
    addAccount(80, "New-Book");

    const back = trash.restoreTrashSnapshot(snapId);
    expect(back.ok).toBe(false);
    expect(back.restored).toBe(0);
    expect(back.message).toMatch(/now belongs to “New-Book”/);
    expect(back.message).toMatch(/restore skipped/i);
    // Nothing was merged into the stranger's book.
    expect(t.db.select().from(t.schema.trades).all().filter((x) => x.accountId === 80)).toHaveLength(0);
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 80)!.name).toBe("New-Book");
  });

  it("refuses when the NAME is taken even though the id is free", () => {
    // Free the id but keep the name claimed by a different account.
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, 80)).run();
    addAccount(81, "Old-Book");
    const back = trash.restoreTrashSnapshot(snapId);
    expect(back.ok).toBe(false);
    expect(back.restored).toBe(0);
    expect(back.message).toMatch(/name “Old-Book” now belongs to account id 81/);
    expect(t.db.select().from(t.schema.accounts).all().find((a) => a.id === 80)).toBeUndefined();
  });

  it("treats a matching id+name+broker as already restored and says so", () => {
    // The user recreated the very same account by hand; the snapshot's rows
    // belong in it, and the message must not imply a conflict (nit fix).
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, 81)).run();
    addAccount(80, "Old-Book");
    const back = trash.restoreTrashSnapshot(snapId);
    expect(back.ok).toBe(true);
    expect(back.restored).toBe(1);
    expect(back.message).toMatch(/already present/i);
    expect(back.message).not.toMatch(/skipped to avoid/i);
    expect(t.db.select().from(t.schema.trades).all().find((x) => x.id === oldTrade)!.accountId).toBe(80);
  });
});

describe("archived merge target", () => {
  it("moves the selection to a live account, not the archived target", () => {
    addAccount(70, "Arch-Src");
    addAccount(71, "Arch-Tgt", { archived: true });
    selectAccount(70);
    const r = mod.deleteAccount({ accountId: 70, mode: "merge", targetId: 71, connections: "delete" });
    expect(r.ok).toBe(true);
    // The preferred target is archived — D8's rule applies: default first.
    expect(selected()).toBe(1);
  });
});

describe("import commit racing an account delete", () => {
  it("refuses to write into an account id that no longer exists", async () => {
    addAccount(95, "Ghost-Target");
    selectAccount(95);
    // Simulate the race: the account vanishes while the selection (and any
    // in-flight pull) still points at it.
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, 95)).run();
    const commit = await import("@/lib/import/commit");
    const parsed = { sourceId: "x", broker: "dhan", format: "csv", warnings: [], trades: [] } as unknown as import("@/lib/import/types").ParsedFile;
    expect(() => commit.commitParsedFile(parsed, "ghost.csv")).toThrow(/no longer exists/i);
    // No ghost batch either — the transaction rolled back before any write.
    expect(t.db.select().from(t.schema.importBatches).all().filter((b) => b.accountId === 95)).toHaveLength(0);
    selectAccount(1);
  });
});

describe("account name trimming", () => {
  it("the upsert schema stores a trimmed name", async () => {
    const route = await import("@/app/api/accounts/route");
    const req = new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upsert", name: "  Padded Name  " }),
    });
    // revalidatePath may throw outside a request scope — the insert has
    // already happened by then, which is all this test needs.
    await route.POST(req).catch(() => null);
    const all = t.db.select().from(t.schema.accounts).all();
    expect(all.find((a) => a.name === "Padded Name")).toBeDefined();
    expect(all.find((a) => a.name === "  Padded Name  ")).toBeUndefined();
  });
});
