import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * v3.8 W2a — broker-scoped remove + re-import, against a real database seeded
 * through the real import path.
 *
 * The owner's case: a parser fix merges 35 Paytm securities that were split
 * into phantom positions. No hash migration can absorb that, so the file is
 * re-imported clean — which needs a remove that takes ONE broker's rows out of
 * ONE account, leaves everything else exactly as it was, and can be put back.
 * Every assertion here is one of those three promises, read out of SQLite.
 *
 * ONE temp database per FILE (tests/helpers/temp-db.ts); the `it`s below are
 * ordered and share state deliberately — the book must be fingerprinted
 * before the remove and compared after the restore.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let trash: typeof import("@/lib/trash");
let sources: typeof import("@/lib/queries/import-sources");
let route: typeof import("@/app/api/import/remove-broker/route");
let commit: typeof import("@/lib/import/commit");
let detect: typeof import("@/lib/import/detect");
let trashDir: string;

const A1 = 1;
const A2 = 2;

async function importFixture(file: string, accountId: number): Promise<number> {
  const bytes = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", file));
  const ctx = detect.buildContext(file, bytes);
  const parsed = await detect.detectParser(ctx)!.parse(ctx);
  return commit.commitParsedFile(parsed, file, null, accountId).added;
}

const tradesOf = (accountId: number, broker: string) =>
  t.db.select().from(t.schema.trades).where(and(eq(t.schema.trades.accountId, accountId), eq(t.schema.trades.broker, broker))).all();

const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

/** The whole book — every table the remove touches — as one comparable string. */
function fingerprint(): string {
  return JSON.stringify({
    trades: byId(t.db.select().from(t.schema.trades).all()),
    legs: byId(t.db.select().from(t.schema.tradeLegs).all()),
    attachments: byId(t.db.select().from(t.schema.tradeAttachments).all()),
    ledger: byId(t.db.select().from(t.schema.ledgerEntries).all()),
    ipos: byId(t.db.select().from(t.schema.ipos).all()),
  });
}

/** The ids the FTS index answers for one symbol (migration 0060, trigram tokenizer). */
function ftsIds(symbol: string): number[] {
  return (t.sqlite.prepare("SELECT rowid FROM trades_fts WHERE trades_fts MATCH ?").all(`"${symbol.replace(/"/g, '""')}"`) as { rowid: number }[]).map((r) => r.rowid);
}

/** Hang one of everything a trade can own off it. */
function decorate(tradeId: number, accountId: number, tag: string) {
  fs.mkdirSync(t.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(t.attachmentsDir, `${tag}.png`), `PNG-${tag}`);
  t.db.insert(t.schema.tradeAttachments).values({ tradeId, fileName: `${tag}.png`, storedName: `${tag}.png`, mime: "image/png", sizeBytes: 9 }).run();
  t.db.insert(t.schema.tradeLegs).values({ tradeId, kind: "entry", seq: 1, tradeDate: "2026-06-02", qty: 10, price: 100 }).run();
  const ledger = t.db.insert(t.schema.ledgerEntries).values({ accountId, date: "2026-06-03", type: "charge", amountPaise: -1234, refTradeId: tradeId, note: tag }).returning({ id: t.schema.ledgerEntries.id }).get();
  const ipo = t.db.insert(t.schema.ipos).values({ accountId, name: `IPO ${tag}`, tradeId }).returning({ id: t.schema.ipos.id }).get();
  return { ledgerId: ledger.id, ipoId: ipo.id };
}

function post(body: unknown): Promise<Response> {
  return route.POST(new Request("http://local/api/import/remove-broker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}
const get = (qs: string) => route.GET(new Request(`http://local/api/import/remove-broker${qs}`));

let removedIds: number[] = [];
let removedSymbol = "";
let doomed: { tradeId: number; ledgerId: number; ipoId: number };
let survivorA1: { tradeId: number; ledgerId: number; ipoId: number };
let survivorA2: { tradeId: number; ledgerId: number; ipoId: number };
let before = "";
let snapshotId = "";

beforeAll(async () => {
  t = await openTempDb("remove-broker", { seed: true });
  trash = await import("@/lib/trash");
  sources = await import("@/lib/queries/import-sources");
  route = await import("@/app/api/import/remove-broker/route");
  commit = await import("@/lib/import/commit");
  detect = await import("@/lib/import/detect");
  trashDir = (await import("@/lib/db")).trashDir;

  t.db.insert(t.schema.accounts).values({ id: A2, name: "Swing", isDefault: false }).run();

  // Two accounts × two brokers, through the real importer.
  expect(await importFixture("dhan-pnl.csv", A1)).toBe(122);
  expect(await importFixture("groww-pnl.xlsx", A1)).toBe(130);
  expect(await importFixture("dhan-pnl.csv", A2)).toBe(122);
  expect(await importFixture("groww-pnl.xlsx", A2)).toBe(130);

  const d1 = tradesOf(A1, "dhan").find((r) => !r.isOpen)!;
  const g1 = tradesOf(A1, "groww").find((r) => !r.isOpen)!;
  const d2 = tradesOf(A2, "dhan").find((r) => !r.isOpen)!;
  doomed = { tradeId: d1.id, ...decorate(d1.id, A1, "doomed") };
  survivorA1 = { tradeId: g1.id, ...decorate(g1.id, A1, "survivor-groww") };
  survivorA2 = { tradeId: d2.id, ...decorate(d2.id, A2, "survivor-a2") };
  removedSymbol = d1.symbol;
});

afterAll(() => t?.cleanup());

describe("countTradesByBroker — what the import page shows before the user confirms", () => {
  it("counts one account's rows per broker, split open/closed, with the date span", () => {
    const c = sources.countTradesByBroker(A1);
    expect(c.map((x) => x.broker)).toEqual(["dhan", "groww"]);
    const dhan = c.find((x) => x.broker === "dhan")!;
    // A Dhan P&L export states its window in the header, not per row, so the
    // rows carry no dates and the span is honestly null (invariant 6: never
    // fabricate). Groww rows are dated.
    expect(dhan).toEqual({ broker: "dhan", trades: 122, open: 6, closed: 116, earliest: null, latest: null });
    const groww = c.find((x) => x.broker === "groww")!;
    expect(groww).toMatchObject({ trades: 130, open: 3, closed: 127 });
    expect(groww.earliest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(groww.latest! >= groww.earliest!).toBe(true);
  });

  it("refuses the aggregate view and a missing id with a stable code", () => {
    for (const bad of [0, undefined, null, "", "0", -1, 1.5]) {
      expect(() => sources.countTradesByBroker(bad)).toThrow(expect.objectContaining({ code: "ACCOUNT_REQUIRED", status: 400 }));
    }
    expect(() => sources.countTradesByBroker(99)).toThrow(expect.objectContaining({ code: "ACCOUNT_NOT_FOUND", status: 404 }));
  });
});

describe("removeBrokerRows — dhan out of account 1", () => {
  it("refuses account 0 before touching anything", () => {
    const snapshots = trash.listTrashSnapshots().length;
    const fp = fingerprint();
    expect(() => trash.removeBrokerRows({ accountId: 0, broker: "dhan" })).toThrow(expect.objectContaining({ code: "ACCOUNT_REQUIRED" }));
    expect(() => trash.removeBrokerRows({ accountId: undefined, broker: "dhan" })).toThrow(expect.objectContaining({ code: "ACCOUNT_REQUIRED" }));
    expect(() => trash.removeBrokerRows({ accountId: A1, broker: "nope" })).toThrow(expect.objectContaining({ code: "BROKER_REQUIRED" }));
    expect(fingerprint()).toBe(fp);
    expect(trash.listTrashSnapshots().length).toBe(snapshots);
  });

  it("removes exactly that broker's rows and their children, and nothing else", () => {
    before = fingerprint();
    removedIds = tradesOf(A1, "dhan").map((r) => r.id);
    // The FTS index knows these rows before the remove — otherwise the
    // "no longer returns" assertion below would pass vacuously.
    expect(ftsIds(removedSymbol).some((id) => removedIds.includes(id))).toBe(true);

    const res = trash.removeBrokerRows({ accountId: A1, broker: "dhan", actor: "test" });
    snapshotId = res.snapshotId;
    expect(res.removed).toEqual({ trades: 122, closed: 116, open: 6, legs: 1, attachments: 1 });
    expect(res.unlinked).toEqual({ ledgerEntries: 1, ipos: 1 });
    expect(res.orphanedFiles).toEqual([]);
    expect(res.message).toMatch(/Deleted items/);

    // Gone: the broker's rows in THIS account, and their children.
    expect(tradesOf(A1, "dhan")).toHaveLength(0);
    expect(t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, doomed.tradeId)).all()).toHaveLength(0);
    expect(t.db.select().from(t.schema.tradeAttachments).where(eq(t.schema.tradeAttachments.tradeId, doomed.tradeId)).all()).toHaveLength(0);
    // Moved, not destroyed: the attachment bytes sit in the snapshot.
    expect(fs.existsSync(path.join(t.attachmentsDir, "doomed.png"))).toBe(false);
    expect(fs.readFileSync(path.join(trashDir, snapshotId, "files", "doomed.png"), "utf8")).toBe("PNG-doomed");

    // Untouched: the other broker in the same account, and both brokers in the other account.
    expect(tradesOf(A1, "groww")).toHaveLength(130);
    expect(tradesOf(A2, "dhan")).toHaveLength(122);
    expect(tradesOf(A2, "groww")).toHaveLength(130);
    for (const s of [survivorA1, survivorA2]) {
      expect(t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, s.tradeId)).all()).toHaveLength(1);
      expect(t.db.select().from(t.schema.tradeAttachments).where(eq(t.schema.tradeAttachments.tradeId, s.tradeId)).all()).toHaveLength(1);
      expect(t.db.select().from(t.schema.ledgerEntries).where(eq(t.schema.ledgerEntries.id, s.ledgerId)).get()!.refTradeId).toBe(s.tradeId);
      expect(t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, s.ipoId)).get()!.tradeId).toBe(s.tradeId);
    }
    expect(fs.existsSync(path.join(t.attachmentsDir, "survivor-groww.png"))).toBe(true);
  });

  it("unlinks (never deletes) the ledger entry and the IPO that pointed at a removed trade", () => {
    const ledger = t.db.select().from(t.schema.ledgerEntries).where(eq(t.schema.ledgerEntries.id, doomed.ledgerId)).get();
    expect(ledger).toBeDefined();
    expect(ledger!.amountPaise).toBe(-1234);
    expect(ledger!.refTradeId).toBeNull();
    const ipo = t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, doomed.ipoId)).get();
    expect(ipo).toBeDefined();
    expect(ipo!.tradeId).toBeNull();
  });

  it("writes ONE audit row, action import.remove-broker, with symmetric before/after keys", () => {
    const rows = t.db.select().from(t.schema.auditLog).where(eq(t.schema.auditLog.action, "import.remove-broker")).all();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.entity).toBe("account");
    expect(row.entityId).toBe(A1);
    expect(row.source).toBe("test");
    // v3.8: the unlink counts are keys that MOVE, so the audit view (which
    // renders changed keys only) stops omitting the ledger entries and IPOs
    // this remove detached, and the summary names the broker so "trades 122 → 0"
    // can no longer read as "the whole account was emptied".
    expect(row.summary).toMatch(/^dhan:/);
    expect(row.summary).toMatch(/other brokers are untouched/);
    expect(row.beforeJson).toEqual({ accountId: A1, broker: "dhan", trades: 122, closed: 116, open: 6, unlinkedLedger: 0, unlinkedIpos: 0 });
    expect(row.afterJson).toEqual({ accountId: A1, broker: "dhan", trades: 0, closed: 0, open: 0, unlinkedLedger: 1, unlinkedIpos: 1 });
    expect(Object.keys(row.beforeJson!).sort()).toEqual(Object.keys(row.afterJson!).sort());
  });

  it("drops the removed ids from the trades_fts index", () => {
    const hits = ftsIds(removedSymbol);
    expect(hits.filter((id) => removedIds.includes(id))).toEqual([]);
    // The same symbol in account 2 is still findable — the index lost only the removed rows.
    expect(hits.length).toBeGreaterThan(0);
  });

  it("lists the snapshot as a broker-remove of that broker", () => {
    const found = trash.listTrashSnapshots().find((s) => s.id === snapshotId);
    expect(found).toMatchObject({ kind: "broker-remove", broker: "dhan", accountId: A1, trades: 122, legs: 1, attachments: 1 });
  });

  it("refuses a second remove of the same broker with NO_ROWS (404)", () => {
    expect(() => trash.removeBrokerRows({ accountId: A1, broker: "dhan" })).toThrow(expect.objectContaining({ code: "NO_ROWS", status: 404 }));
  });

  it("restores the snapshot to a byte-equal book: same ids, links re-pointed, bytes back", () => {
    const back = trash.restoreTrashSnapshot(snapshotId, "test");
    expect(back.ok).toBe(true);
    expect(back).toMatchObject({ restored: 122, legs: 1, attachments: 1, skipped: [] });
    expect(fingerprint()).toBe(before);
    expect(fs.readFileSync(path.join(t.attachmentsDir, "doomed.png"), "utf8")).toBe("PNG-doomed");
    // Counts and net, spelled out — the fingerprint covers them, but these are
    // the two figures a user checks first.
    const rows = tradesOf(A1, "dhan");
    expect(rows).toHaveLength(122);
    const net = (xs: { netPnl: number }[]) => Math.round(xs.reduce((s, r) => s + r.netPnl, 0) * 100) / 100;
    expect(net(rows)).toBe(net(tradesOf(A2, "dhan")));
    // And the FTS index knows them again.
    expect(ftsIds(removedSymbol).some((id) => removedIds.includes(id))).toBe(true);
  });
});

describe("POST/GET /api/import/remove-broker", () => {
  it("400 CONFIRM_REQUIRED without confirm: true, and nothing is removed", async () => {
    const fp = fingerprint();
    for (const confirm of [undefined, false, "true", 1]) {
      const res = await post({ accountId: A2, broker: "groww", confirm });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("CONFIRM_REQUIRED");
    }
    expect(fingerprint()).toBe(fp);
  });

  it("400 ACCOUNT_REQUIRED for account 0 or a missing account", async () => {
    for (const accountId of [0, undefined, "0", null]) {
      const res = await post({ accountId, broker: "groww", confirm: true });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("ACCOUNT_REQUIRED");
    }
    expect(tradesOf(A1, "groww")).toHaveLength(130);
    expect(tradesOf(A2, "groww")).toHaveLength(130);
  });

  it("GET ?accountId= returns the per-broker counts; refuses 0", async () => {
    const ok = await get(`?accountId=${A2}`);
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.accountId).toBe(A2);
    expect(json.sources.map((s: { broker: string; trades: number }) => [s.broker, s.trades])).toEqual([["dhan", 122], ["groww", 130]]);

    const bad = await get("?accountId=0");
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("ACCOUNT_REQUIRED");
    expect((await get("")).status).toBe(400);
  });

  it("removes, answers {removed, snapshotId}, then 404s a second time, and the file re-imports clean", async () => {
    const res = await post({ accountId: A2, broker: "groww", confirm: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.removed).toMatchObject({ trades: 130, closed: 127, open: 3 });
    expect(typeof json.snapshotId).toBe("string");
    expect(fs.existsSync(path.join(trashDir, json.snapshotId, "snapshot.json"))).toBe(true);
    expect(tradesOf(A2, "groww")).toHaveLength(0);
    expect(tradesOf(A1, "groww")).toHaveLength(130);

    const again = await post({ accountId: A2, broker: "groww", confirm: true });
    expect(again.status).toBe(404);
    expect((await again.json()).code).toBe("NO_ROWS");

    // The owner's actual workflow: the same file goes back in as new rows.
    expect(await importFixture("groww-pnl.xlsx", A2)).toBe(130);
    // ...and the restore now REFUSES outright rather than leaning on the dedup
    // index to skip row by row (v3.8). Dedup only saves this case because the
    // SAME file went back in; the workflow the remove exists for is a parser
    // FIX, whose rows carry new hashes and collide with nothing — there the
    // per-row skip did not fire and the book doubled with a success toast.
    const back = trash.restoreTrashSnapshot(json.snapshotId, "test");
    expect(back.ok).toBe(false);
    expect(back.code).toBe("NEWER_ROWS");
    expect(back.restored).toBe(0);
    expect(back.skipped).toEqual([]);
    expect(back.message).toMatch(/130 groww trades were imported after this removal/);
    expect(tradesOf(A2, "groww")).toHaveLength(130);
  });
});
