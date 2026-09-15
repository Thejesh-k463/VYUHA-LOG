import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * H3 (v4.3.0 wave 2H) — restoring a sale that Data Quality joined.
 *
 * The join (POST /api/data-quality/close-stale) closes the lot with its stored
 * sale, removes the sale row into Deleted items, and records the sale's dedup
 * hash as a `dedup-alias:` in the lot's `import_notes`. The unique index
 * `trades_account_broker_dedup_uq` cannot see an alias, so a restore used to put
 * the sale back as an open sell-only row beside the lot whose close already IS
 * that sale — one sale counted twice, and (before H3's M2 narrowing) a held
 * sibling lot offered a one-click join onto it.
 *
 * `restoreTrashSnapshot` now skips a row whose hash is an alias of a stored row
 * in the same account and broker, exactly as it skips a row the index rejects.
 *
 * ONE temp database per FILE (AGENTS.md); the `it`s run in order on it.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let route: typeof import("@/app/api/data-quality/close-stale/route");
let dq: typeof import("@/lib/queries/data-quality");
let trash: typeof import("@/lib/trash");

const ACC = 951;
const SYM = "TRASHX";

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "dhan",
    isin: null,
    buyQty: 0,
    avgBuyPrice: 0,
    buyValue: 0,
    sellQty: 0,
    avgSellPrice: 0,
    sellValue: 0,
    closingPrice: null,
    grossPnl: 0,
    unrealisedPnl: 0,
    buyDate: null,
    sellDate: null,
    productHint: "delivery",
    exchangeHint: "NSE",
    sourceFile: null,
    ...over,
  } as NormalizedTrade;
}

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings: [] });
const buy = (sym: string, qty: number, price: number, day: string) =>
  parsed([trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })]);
const sell = (sym: string, qty: number, price: number, day: string) =>
  parsed([trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day })]);

const row = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);

// Measured locally (2026-09-15): the hook takes ~1.1 s (migrate + seed; vitest "tests 1.23s" for hook + 4 its), inside the 3 s local budget.
// The raised timeout is for the Windows runner, >15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("trash-restore-alias", { seed: true });
  commit = await import("@/lib/import/commit");
  route = await import("@/app/api/data-quality/close-stale/route");
  dq = await import("@/lib/queries/data-quality");
  trash = await import("@/lib/trash");
  t.db.insert(t.schema.accounts).values({ id: ACC, name: "trash-alias" }).run();
  t.db.update(t.schema.settings).set({ selectedAccountId: ACC }).run();
}, 120_000);
afterAll(() => t?.cleanup());

describe("H3 — a Trash restore never re-inserts a sale a Data Quality join recorded as a lot's alias", () => {
  let L1: NonNullable<ReturnType<typeof row>>;
  let L2: NonNullable<ReturnType<typeof row>>;
  let S1: NonNullable<ReturnType<typeof row>>;
  let joinSnapshot = "";

  it("the re-check's book: lot BUY 100 @200 (08-20), a held lot BUY 100 @210 (08-21), sale SELL 100 @250 (08-25); the join returns 200", async () => {
    expect(commit.commitParsedFile(buy(SYM, 100, 200, "2026-08-20"), "ta-l1", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(buy(SYM, 100, 210, "2026-08-21"), "ta-l2", null, ACC).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), "ta-s1", null, ACC).added).toBe(1);
    [L1, L2, S1] = rowsOf(ACC);
    const res = await route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId: L1.id, saleId: S1.id, exitDate: "2026-08-25" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(row(S1.id)).toBeUndefined();
    expect(row(L1.id)!.importNotes ?? "").toContain(`dedup-alias:${S1.dedupHash}`);
    joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.includes(`#${L1.id}`))!.id;
    expect(joinSnapshot).toBeTruthy();
  });

  it("restoring the join's snapshot skips the sale as already in the journal: the book keeps one closed lot and the held lot, nothing pairs", () => {
    const before = rowsOf(ACC);
    const res = trash.restoreTrashSnapshot(joinSnapshot);
    expect([res.restored, res.skipped.map((s) => s.id)]).toEqual([0, [S1.id]]);
    expect(res.skipped[0].reason).toMatch(/identical trade is already in the journal/);
    expect(res.message).toMatch(/could not be restored/);
    expect(row(S1.id), "the sale is not back as an open sell-only row beside the lot that closed with it").toBeUndefined();
    expect(rowsOf(ACC)).toEqual(before);
    expect(dq.getStaleOpenPairs(), "the held lot is offered no join onto a sale already counted").toEqual([]);
  });

  it("a genuinely different trade in the same snapshot still restores; the aliased sale in it is still skipped", () => {
    expect(commit.commitParsedFile(sell("OTHERX", 10, 99, "2026-08-26"), "ta-other", null, ACC).added).toBe(1);
    const X = rowsOf(ACC).find((r) => r.tradingsymbol === "OTHERX")!;
    t.db.delete(t.schema.trades).where(eq(t.schema.trades.id, X.id)).run();
    const id = trash.writeTrashSnapshot({
      trades: [S1 as unknown as Record<string, unknown> & { id: number }, X as unknown as Record<string, unknown> & { id: number }],
      legs: [],
      attachments: [],
      reason: "H3 mixed snapshot",
      accountId: ACC,
    });
    const res = trash.restoreTrashSnapshot(id);
    expect([res.restored, res.skipped.map((s) => [s.id, s.symbol])]).toEqual([1, [[S1.id, S1.symbol]]]);
    expect(res.skipped[0].reason, "skipped for its identity, not for a taken id").toMatch(/identical trade is already in the journal/);
    expect(row(X.id)).toMatchObject({ tradingsymbol: "OTHERX", sellQty: 10, isOpen: X.isOpen });
    expect(row(S1.id)).toBeUndefined();
    expect(rowsOf(ACC).map((r) => r.id)).toEqual([L1.id, L2.id, X.id]);
  });

  // Y1 (wave 2I) re-pin. Wave 2H asserted [1, [90_002]] here — the lot landed and
  // the sale behind it was skipped "recorded in the position it closed". Both rows
  // come out of the SAME book in the SAME delete, so the journal they were captured
  // from held them side by side: the snapshot is restored to the state it was taken
  // from, and only a row ALREADY STORED refuses or skips (the S2/T1 describes below).
  it("one snapshot carrying BOTH the joined lot and its sale (a book deleted whole): both land, the book is the one that was captured", () => {
    const ACC2 = 952;
    t.db.insert(t.schema.accounts).values({ id: ACC2, name: "trash-alias-both" }).run();
    const lot = { ...row(L1.id)!, id: 90_001, accountId: ACC2 } as unknown as Record<string, unknown> & { id: number };
    const sale = { ...S1, id: 90_002, accountId: ACC2 } as unknown as Record<string, unknown> & { id: number };
    const id = trash.writeTrashSnapshot({ trades: [lot, sale], legs: [], attachments: [], reason: "H3 lot and sale", accountId: ACC2 });
    const res = trash.restoreTrashSnapshot(id);
    expect([res.ok, res.restored, res.skipped.map((s) => s.id)], res.message).toEqual([true, 2, []]);
    expect(rowsOf(ACC2).map((r) => [r.id, r.isOpen, r.sellQty])).toEqual([
      [90_001, false, 100],
      [90_002, true, 100],
    ]);
  });
});

/**
 * S2 (v4.3.0 wave 2H seam pass) — the symmetric case. The sale came back first
 * (its join snapshot restored after the lot itself was deleted), so the lot's
 * own snapshot would land a closed lot whose alias IS that stored sale: one
 * sale on two rows. Skipping the lot would lose its buy leg, so the WHOLE
 * restore refuses before any write, naming the stored row.
 */
describe("S2 — a Trash restore never brings a joined lot back beside the sale it already counts", () => {
  const ACC3 = 953;
  const SYM3 = "TRASHY";
  let lot: NonNullable<ReturnType<typeof row>>;
  let sale: NonNullable<ReturnType<typeof row>>;
  let other: NonNullable<ReturnType<typeof row>>;
  let lotSnapshot = "";

  it("join, delete the lot, restore the join's snapshot (the sale returns): the lot's snapshot is then refused whole — journal and snapshot unchanged", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC3, name: "trash-alias-s2" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC3 }).run();
    expect(commit.commitParsedFile(buy(SYM3, 100, 200, "2026-08-20"), "ts2-l", null, ACC3).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM3, 100, 250, "2026-08-25"), "ts2-s", null, ACC3).added).toBe(1);
    expect(commit.commitParsedFile(buy("OTHERY", 5, 40, "2026-08-22"), "ts2-o", null, ACC3).added).toBe(1);
    [lot, sale, other] = rowsOf(ACC3);
    const res = await route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId: lot.id, saleId: sale.id, exitDate: "2026-08-25" }),
      }),
    );
    expect(res.status).toBe(200);
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${lot.id} (`))!.id;

    const del = (await import("@/lib/queries/delete")).deleteTradesByIds([lot.id], "S2: the joined lot removed", "test");
    expect(del.ok).toBe(true);
    lotSnapshot = del.snapshotId!;
    const back = trash.restoreTrashSnapshot(joinSnapshot);
    expect(back.restored, "the sale returns — nothing stored names it any more").toBe(1);
    expect(row(sale.id)).toMatchObject({ isOpen: true, sellQty: 100 });

    const before = rowsOf(ACC3);
    const listedBefore = trash.listTrashSnapshots().find((s) => s.id === lotSnapshot);
    const refused = trash.restoreTrashSnapshot(lotSnapshot);
    expect([refused.ok, refused.restored, refused.skipped]).toEqual([false, 0, []]);
    expect(refused.message).toBe(
      `Trade #${lot.id} (${SYM3}) was closed with a sale that is back in the journal (trade #${sale.id}, ${SYM3}) — ` +
        `restoring it would count that sale twice. Delete that row, then restore. Nothing was changed.`,
    );
    expect(row(lot.id), "the lot is not back beside the sale it already counts").toBeUndefined();
    expect(rowsOf(ACC3)).toEqual(before);
    expect(trash.listTrashSnapshots().find((s) => s.id === lotSnapshot), "the snapshot is kept, unchanged").toEqual(listedBefore);
  });

  it("the refusal is that lot's alone: an unrelated trade deleted from the same book still restores while the sale is back", async () => {
    const del = (await import("@/lib/queries/delete")).deleteTradesByIds([other.id], "S2: an unrelated trade removed", "test");
    const res = trash.restoreTrashSnapshot(del.snapshotId!);
    expect([res.ok, res.restored, res.skipped]).toEqual([true, 1, []]);
    expect(row(other.id)).toMatchObject({ tradingsymbol: "OTHERY", buyQty: 5 });
  });

  it("once the returned sale is deleted, the lot's snapshot restores: one closed lot, no open sale beside it", async () => {
    expect((await import("@/lib/queries/delete")).deleteTradesByIds([sale.id], "S2: the returned sale removed", "test").ok).toBe(true);
    const res = trash.restoreTrashSnapshot(lotSnapshot);
    expect([res.ok, res.restored, res.skipped]).toEqual([true, 1, []]);
    expect(row(lot.id)!.importNotes ?? "").toContain(`dedup-alias:${sale.dedupHash}`);
    expect(rowsOf(ACC3).map((r) => [r.id, r.isOpen, r.sellQty])).toEqual([
      [lot.id, false, 100],
      [other.id, true, 0],
    ]);
  });
});

/**
 * T1 (v4.3.0 wave 2H second seam fix) — S2's refusal compared identity sets one
 * way: the incoming lot's aliases against the stored rows' OWN hashes. Once the
 * returned sale was joined onto the held lot (the one click the card offers),
 * the sale was no row, only that lot's alias, and the first lot's restore landed:
 * one ₹25,000 sale realised on two closed rows. Identity sets are now compared
 * both ways — own and alias hashes of every stored row, and of every row landed
 * earlier in the same restore.
 */
describe("T1 — a Trash restore refuses a lot whose sale is recorded only as ANOTHER lot's alias", () => {
  const ACC4 = 954;
  const SYM4 = "TRASHZ";
  const join = (lotId: number, saleId: number) =>
    route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId, saleId, exitDate: "2026-08-25" }),
      }),
    );

  it("L1 100 @200, L2 100 @210, S1 100 @250; join L1+S1; delete L1; restore the join (S1 back); join L2+S1; L1's snapshot is refused naming L2 — book and snapshot unchanged", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC4, name: "trash-alias-t1" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC4 }).run();
    expect(commit.commitParsedFile(buy(SYM4, 100, 200, "2026-08-20"), "tt1-l1", null, ACC4).added).toBe(1);
    expect(commit.commitParsedFile(buy(SYM4, 100, 210, "2026-08-21"), "tt1-l2", null, ACC4).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM4, 100, 250, "2026-08-25"), "tt1-s1", null, ACC4).added).toBe(1);
    const [L1, L2, S1] = rowsOf(ACC4);
    expect((await join(L1.id, S1.id)).status).toBe(200);
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${L1.id} (`))!.id;
    const del = (await import("@/lib/queries/delete")).deleteTradesByIds([L1.id], "T1: the joined lot removed", "test");
    expect(del.ok).toBe(true);
    const lotSnapshot = del.snapshotId!;
    expect(trash.restoreTrashSnapshot(joinSnapshot).restored, "the sale returns — nothing stored names it").toBe(1);
    expect((await join(L2.id, S1.id)).status, "the held lot takes the returned sale in one click").toBe(200);
    expect(row(S1.id)).toBeUndefined();
    expect(row(L2.id)).toMatchObject({ isOpen: false, sellQty: 100 });
    expect(row(L2.id)!.importNotes ?? "").toContain(`dedup-alias:${S1.dedupHash}`);

    const before = rowsOf(ACC4);
    const listedBefore = trash.listTrashSnapshots().find((s) => s.id === lotSnapshot);
    const refused = trash.restoreTrashSnapshot(lotSnapshot);
    expect([refused.ok, refused.restored, refused.skipped]).toEqual([false, 0, []]);
    // U1 (a) re-pin. Before: "… was closed with a trade that is already recorded in
    // trade #L2 (SYM) — restoring it would count that trade twice. Delete that row,
    // then restore. Nothing was changed." L2 is a LOT with its own purchase, so the
    // advice lost that purchase for good (each lot's restore then refuses against
    // the other). After: the fact, both trades named, and no instruction to delete.
    expect(refused.message).toBe(
      `Trade #${L1.id} (${SYM4}) was closed with a sale that trade #${L2.id} (${SYM4}) already records, ` +
        `so restoring it would count that sale twice. Nothing was changed; this entry stays in Deleted items.`,
    );
    expect(refused.message, "no refusal advises deleting a row that carries a leg of its own").not.toMatch(/\bdelete\b/i);
    expect(row(L1.id), "L1 is not back beside L2, which already realised that sale").toBeUndefined();
    expect(rowsOf(ACC4)).toEqual(before);
    expect(trash.listTrashSnapshots().find((s) => s.id === lotSnapshot), "the snapshot is kept, unchanged").toEqual(listedBefore);
  });

  // Y1 (wave 2I) re-pin. Wave 2H refused this whole restore (ok false, message
  // "…was closed with a sale this snapshot also holds…"). A row landing earlier in
  // the SAME restore is not a stored row: the pair was consistent in the book the
  // snapshot was taken from, so it is restored as it was — in either order (the H3
  // describe above pins the lot-first ordering).
  it("one snapshot holding the sale BEFORE the lot that closed with it: both land, whichever order the snapshot holds them in", () => {
    const ACC5 = 955;
    t.db.insert(t.schema.accounts).values({ id: ACC5, name: "trash-alias-t1-order" }).run();
    const lotRow = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, ACC4)).all().find((r) => !r.isOpen)!;
    const saleHash = /dedup-alias:([0-9a-f]{40})/.exec(lotRow.importNotes ?? "")![1];
    const sale = { ...lotRow, id: 91_001, accountId: ACC5, dedupHash: saleHash, importNotes: null, buyQty: 0, buyValue: 0, avgBuyPrice: 0, isOpen: true };
    const lot = { ...lotRow, id: 91_002, accountId: ACC5 };
    const id = trash.writeTrashSnapshot({
      trades: [sale, lot] as unknown as (Record<string, unknown> & { id: number })[],
      legs: [],
      attachments: [],
      reason: "T1 sale before lot",
      accountId: ACC5,
    });
    const res = trash.restoreTrashSnapshot(id);
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 2, []]);
    expect(rowsOf(ACC5).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty])).toEqual([
      [91_001, true, 0, 100],
      [91_002, false, 100, 100],
    ]);
  });
});

/**
 * U1 (v4.3.0 wave 2H third seam fix) (b) — H1 keeps a joined lot's
 * `dedup-alias:` when the trade editor re-opens it (the alias is identity for
 * re-import dedup). Such a lot no longer records the sale, so an alias counts as
 * HELD only while its holder's closing leg holds quantity (a long's sell leg, a
 * short's buy leg — H1's long/short reading). An open holder with an empty
 * closing leg does not refuse.
 */
describe("U1 — a lot re-opened in the trade editor no longer holds the sale its kept alias names", () => {
  const ACC6 = 956;
  const SYM6 = "TRASHU";
  const join = (lotId: number, saleId: number) =>
    route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId, saleId, exitDate: "2026-08-25" }),
      }),
    );

  it("T1's book, then #L2 edited to sell 0 (open, alias kept): L1's snapshot restores and the book realises the ₹25,000 sale exactly once", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC6, name: "trash-alias-u1" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC6 }).run();
    expect(commit.commitParsedFile(buy(SYM6, 100, 200, "2026-08-20"), "tu1-l1", null, ACC6).added).toBe(1);
    expect(commit.commitParsedFile(buy(SYM6, 100, 210, "2026-08-21"), "tu1-l2", null, ACC6).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM6, 100, 250, "2026-08-25"), "tu1-s1", null, ACC6).added).toBe(1);
    const [L1, L2, S1] = rowsOf(ACC6);
    expect((await join(L1.id, S1.id)).status).toBe(200);
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${L1.id} (`))!.id;
    const del = (await import("@/lib/queries/delete")).deleteTradesByIds([L1.id], "U1: the joined lot removed", "test");
    expect(del.ok).toBe(true);
    expect(trash.restoreTrashSnapshot(joinSnapshot).restored).toBe(1);
    expect((await join(L2.id, S1.id)).status).toBe(200);

    // The editor re-opens L2: sell qty 0, price 0, date blank. H1 keeps the alias.
    expect(commit.updateManualTrade(L2.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect(row(L2.id)).toMatchObject({ isOpen: true, buyQty: 100, sellQty: 0 });
    expect(row(L2.id)!.importNotes ?? "", "the alias survives the re-open (H1)").toContain(`dedup-alias:${S1.dedupHash}`);

    const res = trash.restoreTrashSnapshot(del.snapshotId!);
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 1, []]);
    expect(rowsOf(ACC6).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue])).toEqual([
      [L1.id, false, 100, 100, 25000],
      [L2.id, true, 100, 0, 0],
    ]);
    expect(
      rowsOf(ACC6).filter((r) => !r.isOpen && r.sellQty === 100 && r.sellValue === 25000).length,
      "the sale is realised on exactly one row",
    ).toBe(1);
  });
});

/**
 * V1 (v4.3.0 wave 2H fourth seam fix) — U1 stopped the restore REFUSAL counting
 * a re-opened lot's kept alias, but the sale's own recovery paths still did:
 * restoring the join snapshot skipped the sale as "recorded in the position it
 * closed" (H3) and re-importing it was deduped (R26). The ₹25,000 sale and its
 * +₹5,000 gross were on no row and unrecoverable. Every alias reader now goes
 * through ONE predicate (`heldIdentityHashes`, lib/import/close-open-lots.ts):
 * an alias is identity only while its holder's closing leg holds quantity.
 */
describe("V1 — an alias records the sale only while its lot still closes on it", () => {
  const ACC7 = 957;
  const SYM7 = "TRASHV";
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;
  let joinSnapshot = "";
  const join = (lotId: number, saleId: number) =>
    route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId, saleId, exitDate: "2026-08-25" }),
      }),
    );
  const saleFile = (sym: string) => sell(sym, 100, 250, "2026-08-25");

  it("a lot still closed on the sale — whole, then partly re-made (sell 60 of 100) — keeps it recorded: the join's restore skips it, preview and re-import dedupe it", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC7, name: "trash-alias-v1" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC7 }).run();
    expect(commit.commitParsedFile(buy(SYM7, 100, 200, "2026-08-20"), "tv1-l", null, ACC7).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM7), "tv1-s", null, ACC7).added).toBe(1);
    [L, S] = rowsOf(ACC7);
    expect((await join(L.id, S.id)).status).toBe(200);
    joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${L.id} (`))!.id;

    const held = (label: string) => {
      const res = trash.restoreTrashSnapshot(joinSnapshot);
      expect([res.restored, res.skipped.map((s) => s.id)], label).toEqual([0, [S.id]]);
      expect(res.skipped[0].reason, label).toMatch(/recorded in the position it closed/);
      expect(commit.previewParsedFile(saleFile(SYM7), null, ACC7).summary.dupCount, label).toBe(1);
      expect(commit.commitParsedFile(saleFile(SYM7), "tv1-s-again", null, ACC7).added, label).toBe(0);
      expect(row(S.id), label).toBeUndefined();
    };
    held("closed on the sale");

    expect(commit.updateManualTrade(L.id, { sellQty: 60, avgSellPrice: 250, sellDate: "2026-08-25" }).ok).toBe(true);
    expect(row(L.id)).toMatchObject({ isOpen: true, buyQty: 100, sellQty: 60 });
    expect(row(L.id)!.importNotes ?? "").toContain(`dedup-alias:${S.dedupHash}`);
    held("partly re-made by the user (sell 60 of 100)");
    expect(rowsOf(ACC7).map((r) => r.id)).toEqual([L.id]);
  });

  it("the probe: the lot re-opened in the editor (sell 0, alias kept) — the preview no longer calls the sale a duplicate, the join's restore brings it back, and the book realises it once", async () => {
    expect(commit.updateManualTrade(L.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect(row(L.id)).toMatchObject({ isOpen: true, buyQty: 100, sellQty: 0 });
    expect(row(L.id)!.importNotes ?? "", "the alias survives the re-open (H1)").toContain(`dedup-alias:${S.dedupHash}`);
    expect(commit.previewParsedFile(saleFile(SYM7), null, ACC7).summary.dupCount, "the preview does not dedupe the sale").toBe(0);

    const res = trash.restoreTrashSnapshot(joinSnapshot);
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 1, []]);
    expect(row(S.id)).toMatchObject({ isOpen: true, sellQty: 100, sellValue: 25000 });

    expect(dq.getStaleOpenPairs().map((p) => [p.lotId, p.saleId]), "the card offers the join again").toEqual([[L.id, S.id]]);
    expect((await join(L.id, S.id)).status).toBe(200);
    expect(rowsOf(ACC7).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty, r.sellValue, r.grossPnl])).toEqual([
      [L.id, false, 100, 100, 25000, 5000],
    ]);
    expect(commit.commitParsedFile(saleFile(SYM7), "tv1-s-third", null, ACC7).added, "closed again, the lot records the sale again").toBe(0);
  });

  it("the other recovery path: a re-opened lot does not dedupe its sale — re-importing the fill adds it", async () => {
    const ACC8 = 958;
    const SYM8 = "TRASHW";
    t.db.insert(t.schema.accounts).values({ id: ACC8, name: "trash-alias-v1-reimport" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC8 }).run();
    expect(commit.commitParsedFile(buy(SYM8, 100, 200, "2026-08-20"), "tv1r-l", null, ACC8).added).toBe(1);
    expect(commit.commitParsedFile(saleFile(SYM8), "tv1r-s", null, ACC8).added).toBe(1);
    const [lot, sale] = rowsOf(ACC8);
    expect((await join(lot.id, sale.id)).status).toBe(200);
    expect(commit.updateManualTrade(lot.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect(row(lot.id)!.importNotes ?? "").toContain(`dedup-alias:${sale.dedupHash}`);

    const res = commit.commitParsedFile(saleFile(SYM8), "tv1r-s-again", null, ACC8);
    expect([res.added, res.skipped]).toEqual([1, 0]);
    expect(rowsOf(ACC8).map((r) => [r.isOpen, r.buyQty, r.sellQty, r.sellValue])).toEqual([
      [true, 100, 0, 0],
      [true, 0, 100, 25000],
    ]);
  });
});

/**
 * Y1 (v4.3.0 wave 2I) — a snapshot is restored to the state it was CAPTURED
 * from.
 *
 * T1's `planned` branch refused the whole restore when a row landing earlier in
 * the same restore held the incoming row's identity. But both rows came out of
 * the same book in the same delete: the journal held the joined lot and the sale
 * side by side, so restoring both restores exactly that book. Refusing it lost
 * the snapshot's OTHER rows too (an account-deletion snapshot: every trade, plus
 * the imports, sessions, capital history, IPOs, ledger and reviews that come back
 * with it), permanently and with no remedy — nothing was stored to delete.
 *
 * The refusal (S2/T1) and the skip (H3) apply ONLY against a row ALREADY STORED
 * in the journal, which is pinned again at the end of this describe.
 */
describe("Y1 — a self-consistent snapshot restores whole", () => {
  const ACC9 = 959;
  const SYM9 = "TRASHJ";
  let L: NonNullable<ReturnType<typeof row>>;
  let S: NonNullable<ReturnType<typeof row>>;
  let O: NonNullable<ReturnType<typeof row>>;
  const join = (lotId: number, saleId: number) =>
    route.POST(
      new Request("http://local/api/data-quality/close-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lotId, saleId, exitDate: "2026-08-25" }),
      }),
    );

  it("(a) the joined lot and the sale its alias names, deleted together: both come back, the alias intact, Data Quality reading exactly what it read before", async () => {
    t.db.insert(t.schema.accounts).values({ id: ACC9, name: "trash-alias-y1" }).run();
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC9 }).run();
    expect(commit.commitParsedFile(buy(SYM9, 100, 200, "2026-08-20"), "ty1-l", null, ACC9).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM9, 100, 250, "2026-08-25"), "ty1-s", null, ACC9).added).toBe(1);
    [L, S] = rowsOf(ACC9);
    // How the book gets there with no user mistake: join, re-open the lot in the
    // editor (the alias is kept but no longer held — V1), restore the join's
    // snapshot so the sale comes back, then re-close the lot in the editor.
    expect((await join(L.id, S.id)).status).toBe(200);
    const joinSnapshot = trash.listTrashSnapshots().find((s) => s.reason.startsWith(`joined to trade #${L.id} (`))!.id;
    expect(commit.updateManualTrade(L.id, { sellQty: 0, avgSellPrice: 0, sellDate: null }).ok).toBe(true);
    expect(trash.restoreTrashSnapshot(joinSnapshot).restored, "the sale returns (V1)").toBe(1);
    expect(commit.updateManualTrade(L.id, { sellQty: 100, avgSellPrice: 250, sellDate: "2026-08-25" }).ok).toBe(true);
    expect(row(L.id)!.importNotes ?? "", "the lot records the sale again").toContain(`dedup-alias:${S.dedupHash}`);

    const before = rowsOf(ACC9);
    const listingBefore = dq.getStaleOpenSection();
    const del = (await import("@/lib/queries/delete")).deleteTradesByIds([L.id, S.id], "Y1: the pair removed together", "test");
    expect(del.ok).toBe(true);
    expect(rowsOf(ACC9)).toEqual([]);

    const res = trash.restoreTrashSnapshot(del.snapshotId!);
    // On revert: {ok:false, restored:0} and "Trade #<L> (TRASHJ) was closed with a
    // sale this snapshot also holds (trade #<S>, TRASHJ) — restoring both would
    // count that sale twice. Nothing was changed."
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 2, []]);
    expect(rowsOf(ACC9), "the book is the one the snapshot was taken from").toEqual(before);
    expect(row(L.id)!.importNotes ?? "").toContain(`dedup-alias:${S.dedupHash}`);
    expect(dq.getStaleOpenSection(), "and Data Quality says what it said before the delete").toEqual(listingBefore);
  });

  it("(b) the same pair inside an ACCOUNT-deletion snapshot: every row comes back, the unrelated ones included", async () => {
    expect(commit.commitParsedFile(buy("OTHERJ", 5, 40, "2026-08-22"), "ty1-o", null, ACC9).added).toBe(1);
    O = rowsOf(ACC9).find((r) => r.tradingsymbol === "OTHERJ")!;
    const before = rowsOf(ACC9);
    const del = (await import("@/lib/queries/account-delete")).deleteAccount({ accountId: ACC9, mode: "purge", connections: "delete" });
    expect([del.ok, del.snapshotId != null], del.message).toEqual([true, true]);
    expect(rowsOf(ACC9)).toEqual([]);

    const res = trash.restoreTrashSnapshot(del.snapshotId!);
    // On revert: {ok:false, restored:0} — the whole account lost, the unrelated
    // OTHERJ trade with it, and the refusal names nothing to delete.
    expect([res.ok, res.restored, res.skipped], res.message).toEqual([true, 3, []]);
    expect(rowsOf(ACC9)).toEqual(before);
    expect(t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, ACC9)).get()?.name).toBe("trash-alias-y1");
    expect(rowsOf(ACC9).map((r) => r.id)).toContain(O.id);
    t.db.update(t.schema.settings).set({ selectedAccountId: ACC9 }).run();
  });

  it("(c) unchanged against a STORED row: the lot beside the stored sale is still refused, the sale beside the lot that records it still skipped", async () => {
    const del = await import("@/lib/queries/delete");
    const lotSnapshot = del.deleteTradesByIds([L.id], "Y1: the lot alone", "test").snapshotId!;
    const before = rowsOf(ACC9);
    const refused = trash.restoreTrashSnapshot(lotSnapshot);
    expect([refused.ok, refused.restored, refused.skipped]).toEqual([false, 0, []]);
    expect(refused.message).toBe(
      `Trade #${L.id} (${SYM9}) was closed with a sale that is back in the journal (trade #${S.id}, ${SYM9}) — ` +
        `restoring it would count that sale twice. Delete that row, then restore. Nothing was changed.`,
    );
    expect(rowsOf(ACC9)).toEqual(before);

    const saleSnapshot = del.deleteTradesByIds([S.id], "Y1: the sale alone", "test").snapshotId!;
    expect(trash.restoreTrashSnapshot(lotSnapshot).restored, "with the sale gone, the lot restores").toBe(1);
    const skipped = trash.restoreTrashSnapshot(saleSnapshot);
    expect([skipped.restored, skipped.skipped.map((s) => s.id)]).toEqual([0, [S.id]]);
    expect(skipped.skipped[0].reason).toMatch(/recorded in the position it closed/);
    expect(rowsOf(ACC9).map((r) => [r.id, r.isOpen])).toEqual([
      [L.id, false],
      [O.id, true],
    ]);
  });
});
