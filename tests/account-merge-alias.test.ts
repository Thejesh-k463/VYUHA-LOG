import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * Y2 (v4.3.0 wave 2I) — an account MERGE reads the ONE identity predicate.
 *
 * `dedupCollisionIds` compared `dedup_hash` only, so a source row whose hash
 * lives on as a TARGET lot's `dedup-alias:` (a Data Quality join records the
 * sale it consumed on the lot — `withStaleCloseNote`) was not seen as a
 * duplicate and was MOVED. The merged book then held the same sale twice: once
 * realised inside the closed round trip, once back as an open sell-only row —
 * a phantom short, with the position count wrong and the book no longer equal
 * to the broker's statement.
 *
 * The identity set is now read both ways (`heldIdentityHashes`,
 * lib/import/close-open-lots.ts — an alias counts only while its holder's
 * closing leg holds quantity):
 *
 *   source hash HELD by a target row  → a collision exactly like a same-hash
 *     row: not moved, snapshotted to Deleted items, counted and reported.
 *   source lot whose HELD alias names a row the target STORES → moving it
 *     would count that sale twice and dropping it would lose its buy leg, so
 *     the merge REFUSES before any write and names the pair.
 *
 * ONE temp database per FILE (AGENTS.md): each scenario gets its own pair of
 * accounts and its own symbol, and they run one after another on it.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let route: typeof import("@/app/api/data-quality/close-stale/route");
let acct: typeof import("@/lib/queries/account-delete");

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

const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const realisedOf = (accountId: number) =>
  rowsOf(accountId).filter((r) => !r.isOpen).reduce((s, r) => s + r.netPnl, 0);
const account = (id: number, name: string) => t.db.insert(t.schema.accounts).values({ id, name }).run();
const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const join = (lotId: number, saleId: number) =>
  route.POST(
    new Request("http://local/api/data-quality/close-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lotId, saleId, exitDate: "2026-08-25" }),
    }),
  );

// Measured locally (2026-09-15): migrate + seed only; vitest reports "tests 1.32s" for the hook plus
// all three `it`s (88 / 47 / 30 ms), so the hook is inside the 3 s local budget and every `it` inside 300 ms.
// The raised timeout is for the Windows runner, >15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("account-merge-alias", { seed: true });
  commit = await import("@/lib/import/commit");
  route = await import("@/app/api/data-quality/close-stale/route");
  acct = await import("@/lib/queries/account-delete");
}, 120_000);
afterAll(() => t?.cleanup());

describe("Y2 — a merge never moves a trade the target's joined lot already records", () => {
  const A = 8201;
  const B = 8202;
  const SYM = "MRGX";

  it("target holds the joined lot (alias = the sale's hash), source holds that sale: the sale is skipped like a hash duplicate, not moved", async () => {
    account(A, "merge-target");
    account(B, "merge-source");
    for (const acc of [A, B]) {
      expect(commit.commitParsedFile(buy(SYM, 100, 200, "2026-08-20"), `mx-b-${acc}`, null, acc).added).toBe(1);
      expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), `mx-s-${acc}`, null, acc).added).toBe(1);
    }
    const [lotA, saleA] = rowsOf(A);
    select(A);
    expect((await join(lotA.id, saleA.id)).status).toBe(200);
    expect(rowsOf(A).map((r) => [r.id, r.isOpen])).toEqual([[lotA.id, false]]);
    expect(rowsOf(A)[0].importNotes ?? "").toContain(`dedup-alias:${saleA.dedupHash}`);
    const [buyB, saleB] = rowsOf(B);
    expect(saleB.dedupHash, "the same fill from the same file kind carries the same identity in both books").toBe(saleA.dedupHash);
    const realisedBefore = realisedOf(A);

    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 2]);
    expect(res.message).toContain("0 trades moved, 2 duplicates skipped (saved to Deleted items)");
    expect(rowsOf(A).map((r) => [r.id, r.isOpen, r.buyQty, r.sellQty]), "no phantom short beside the lot that realised that sale").toEqual([
      [lotA.id, false, 100, 100],
    ]);
    expect(realisedOf(A), "the target's realised figure is untouched").toBe(realisedBefore);
    expect(rowsOf(B)).toEqual([]);
    // Reported and recoverable exactly as a hash collision is: both source rows
    // are in the snapshot the merge wrote.
    const snap = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, saleB.id)).get();
    expect([snap, res.snapshotId != null]).toEqual([undefined, true]);
    expect(buyB.dedupHash).toBe(rowsOf(A)[0].dedupHash);
  });
});

describe("Y2 — the reverse direction is refused before any write", () => {
  const A = 8203;
  const B = 8204;
  const SYM = "MRGY";

  it("source holds a joined lot whose held alias names a sale the TARGET stores: nothing moves, both accounts intact", async () => {
    account(A, "reverse-target");
    account(B, "reverse-source");
    expect(commit.commitParsedFile(buy(SYM, 100, 200, "2026-08-20"), "my-b", null, B).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), "my-s", null, B).added).toBe(1);
    const [lotB, saleB] = rowsOf(B);
    select(B);
    expect((await join(lotB.id, saleB.id)).status).toBe(200);
    expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), "my-s-a", null, A).added).toBe(1);
    const [saleA] = rowsOf(A);
    expect(saleA.dedupHash).toBe(saleB.dedupHash);

    const beforeA = rowsOf(A);
    const beforeB = rowsOf(B);
    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.snapshotId, res.skippedTrades]).toEqual([false, null, 0]);
    expect(res.message).toBe(
      `Trade #${lotB.id} (${SYM}) was closed with a sale that “reverse-target” already holds ` +
        `(trade #${saleA.id}, ${SYM}) — moving it would count that sale twice. Nothing was merged; both accounts are unchanged.`,
    );
    expect(rowsOf(A)).toEqual(beforeA);
    expect(rowsOf(B)).toEqual(beforeB);
    expect(t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, B)).get()?.name).toBe("reverse-source");

    // The preview says the same thing before the user presses anything.
    const preview = acct.previewAccountDelete({ accountId: B, mode: "merge", targetId: A });
    expect(preview.warnings?.some((w) => w.includes(`Trade #${lotB.id} (${SYM}) was closed with a sale`))).toBe(true);
  });
});

describe("U1-MERGE (wave 2L) — a dropped duplicate may not carry a leg of its own", () => {
  const A = 8207;
  const B = 8208;
  const SYM = "MRGW";

  /**
   * The forward branch's blind spot. Y2 taught it to SEE a source row whose own
   * hash a target lot holds as an alias, and to drop it exactly like a same-hash
   * duplicate — right for a plain sell-only row, whose whole content is the sale
   * the lot already records. It tested only the hash, so it dropped a CLOSED
   * ROUND TRIP on the same hash too: its purchase leg exists on no other row, and
   * it left the merged journal with its realised P&L, reported as "1 duplicate
   * skipped". That is U1's rule on the restore side ("no refusal advises deleting
   * a row that carries a leg of its own"), and the reverse branch's own reason to
   * refuse rather than drop — applied to the forward branch.
   */
  it("a source CLOSED round trip on a hash the target holds as an alias refuses the merge, in the preview and in the execution, in the same words", async () => {
    account(A, "carry-target");
    account(B, "carry-source");
    expect(commit.commitParsedFile(buy(SYM, 100, 200, "2026-08-20"), "mw-b", null, A).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), "mw-s", null, A).added).toBe(1);
    const [lotA, saleA] = rowsOf(A);
    select(A);
    expect((await join(lotA.id, saleA.id)).status).toBe(200);
    expect(rowsOf(A)[0].importNotes ?? "").toContain(`dedup-alias:${saleA.dedupHash}`);

    // The same sale record in the source book — then given its own buy leg in
    // the trade editor, so the row now records a purchase held on no other row.
    expect(commit.commitParsedFile(sell(SYM, 100, 250, "2026-08-25"), "mw-s-b", null, B).added).toBe(1);
    const [saleB] = rowsOf(B);
    expect(saleB.dedupHash).toBe(saleA.dedupHash);
    t.db
      .update(t.schema.trades)
      .set({ buyQty: 100, avgBuyPrice: 190, buyValue: 19000, buyDate: "2026-08-19", isOpen: false, grossPnl: 6000, netPnl: 5750.5 })
      .where(eq(t.schema.trades.id, saleB.id))
      .run();

    const beforeA = rowsOf(A);
    const beforeB = rowsOf(B);
    const fact =
      `Trade #${saleB.id} (${SYM}) records a sale that “carry-target” already holds ` +
      `(trade #${lotA.id}, ${SYM}, which was closed with it) — moving it would count that sale twice`;

    // THE assertion: the merge refuses before any write, rather than dropping
    // 19,000 of cost basis and 5,750.50 of realised P&L as "1 duplicate skipped".
    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.snapshotId, res.skippedTrades], res.message).toEqual([false, null, 0]);
    expect(res.message).toBe(`${fact}. Nothing was merged; both accounts are unchanged.`);
    expect(rowsOf(A)).toEqual(beforeA);
    expect(rowsOf(B)).toEqual(beforeB);

    // The preview warns EXACTLY when the execution refuses, off the same fact —
    // no dedup count, no "will be skipped" promise the merge will not keep.
    const preview = acct.previewAccountDelete({ accountId: B, mode: "merge", targetId: A });
    expect(preview.dedupCollisions).toBe(0);
    expect(preview.warnings).toContain(
      `${fact}, and skipping it would drop the other leg it records. The merge will not run until those two rows are resolved.`,
    );
  });
});

describe("Y2 — a plain same-hash collision is unchanged", () => {
  const A = 8205;
  const B = 8206;
  const SYM = "MRGZ";

  it("one identical buy in both books, one trade only the source holds: 1 moved, 1 duplicate skipped", () => {
    account(A, "plain-target");
    account(B, "plain-source");
    for (const acc of [A, B]) expect(commit.commitParsedFile(buy(SYM, 50, 100, "2026-08-20"), `mz-b-${acc}`, null, acc).added).toBe(1);
    expect(commit.commitParsedFile(buy("MRGZ2", 10, 30, "2026-08-21"), "mz-o", null, B).added).toBe(1);
    const [buyA] = rowsOf(A);
    const [, otherB] = rowsOf(B);

    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 1]);
    expect(res.message).toContain("1 trade moved, 1 duplicate skipped (saved to Deleted items)");
    expect(rowsOf(A).map((r) => r.id)).toEqual([buyA.id, otherB.id].sort((a, b) => a - b));
  });
});

/**
 * D6 (v4.3.0 fix wave 2N, re-check finding "identity#1", data loss) — the
 * SAME-HASH half of the U1-MERGE class.
 *
 * The module comment justified dropping a same-hash source row as "the WHOLE
 * row twice over". That is false for the reachable shape: the TARGET's row can
 * be a naked sell-only row while the SOURCE's row is that same sale given its
 * own buy leg in the trade editor — which does not re-hash, the very reason the
 * alias variant wave 2L fixed exists at all. The merge then deleted the round
 * trip and kept the naked sale: 1,000 of cost basis and 490.25 of realised P&L
 * out of the merged journal, reported as "1 duplicate skipped".
 *
 * The refusal now covers the same-hash half: a two-legged source row is refused
 * when its partner — same hash OR alias — carries fewer legs than it does.
 */
describe("U1-MERGE (wave 2N) — a same-hash partner that records only ONE leg", () => {
  const A = 8209;
  const B = 8210;
  const SYM = "MRGV";

  it("a two-legged source row against a sell-only same-hash target refuses the merge, in the preview and in the execution", () => {
    account(A, "leg-target");
    account(B, "leg-source");
    // The same sale in both books, from the same file kind: one dedup identity.
    expect(commit.commitParsedFile(sell(SYM, 10, 150, "2026-08-25"), "mv-s-a", null, A).added).toBe(1);
    expect(commit.commitParsedFile(sell(SYM, 10, 150, "2026-08-25"), "mv-s-b", null, B).added).toBe(1);
    const [saleA] = rowsOf(A);
    const [saleB] = rowsOf(B);
    expect(saleB.dedupHash).toBe(saleA.dedupHash);
    // The source's copy is given its own buy leg in the trade editor.
    t.db
      .update(t.schema.trades)
      .set({ buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-08-20", isOpen: false, grossPnl: 500, netPnl: 490.25 })
      .where(eq(t.schema.trades.id, saleB.id))
      .run();

    const beforeA = rowsOf(A);
    const beforeB = rowsOf(B);
    const fact =
      `Trade #${saleB.id} (${SYM}) records a sale that “leg-target” already holds ` +
      `(trade #${saleA.id}, ${SYM}, the same broker and dedup identity), and the target records only one leg of ` +
      `this trade — moving it would count that sale twice`;

    // THE assertion: on HEAD this merged, left `[[id, A, 0, 10, 0]]` and
    // reported "1 duplicate skipped (saved to Deleted items)".
    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.snapshotId, res.skippedTrades], res.message).toEqual([false, null, 0]);
    expect(res.message).toBe(`${fact}. Nothing was merged; both accounts are unchanged.`);
    expect(rowsOf(A)).toEqual(beforeA);
    expect(rowsOf(B)).toEqual(beforeB);

    const preview = acct.previewAccountDelete({ accountId: B, mode: "merge", targetId: A });
    expect(preview.dedupCollisions, "no 'will be skipped' promise the merge will not keep").toBe(0);
    expect(preview.warnings).toContain(
      `${fact}, and skipping it would drop the other leg it records. The merge will not run until those two rows are resolved.`,
    );
  });

  it("a two-legged source against a two-legged same-hash partner still drops — the whole row twice over", () => {
    const A2 = 8211;
    const B2 = 8212;
    const SYM2 = "MRGU";
    account(A2, "both-legs-target");
    account(B2, "both-legs-source");
    for (const acc of [A2, B2]) {
      expect(commit.commitParsedFile(buy(SYM2, 10, 100, "2026-08-20"), `mu-b-${acc}`, null, acc).added).toBe(1);
      expect(commit.commitParsedFile(sell(SYM2, 10, 150, "2026-08-25"), `mu-s-${acc}`, null, acc).added).toBe(1);
    }
    const res = acct.deleteAccount({ accountId: B2, mode: "merge", targetId: A2, connections: "delete" });
    expect([res.ok, res.skippedTrades], res.message).toEqual([true, 2]);
  });
});
