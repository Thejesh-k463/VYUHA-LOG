import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import { UNJOIN_MENU_LABEL, autoCloseSentences, emptyAutoCloseCounters } from "@/lib/import/close-open-lots";

/**
 * v4.8.0 FIX-A — J-2 (FIX-A-REVIEW-2026-10-05.md §J-2, binding).
 *
 * `heldBy` is any stored row whose `heldIdentityHashes` contains the hash the
 * plan would store a slice or remainder under. The `held-identity` sentences
 * said "Un-close that earlier record" for EVERY holder; in the pinned shape
 * (x1-probes.test.ts D6b ii) the holder is a plain row that was never closed —
 * Trades shows no Un-close, the server answers NOT_FOUND — and the alternative
 * on screen ("join them from Data Quality") ended at 225. Three holder shapes,
 * three sentences, and the plain-row path is WALKED to the stated figure.
 *
 * ONE temp database per FILE (AGENTS.md Testing): every case owns its account.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let del: typeof import("@/lib/queries/delete");

const SYM = "NIFTY2692225000CE";
const DAY = "2026-09-15";
const QTY = 75;
const r2 = (n: number) => Math.round(n * 100) / 100;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "fyers",
    isin: null,
    buyQty: 0, avgBuyPrice: 0, buyValue: 0,
    sellQty: 0, avgSellPrice: 0, sellValue: 0,
    closingPrice: null, grossPnl: 0, unrealisedPnl: 0,
    buyDate: null, sellDate: null,
    productHint: null, exchangeHint: "NSE", sourceFile: null,
    ...over,
  } as NormalizedTrade;
}
const buy = (qty: number, price: number, date: string) => trade({ tradingsymbol: SYM, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date });
const sell = (qty: number, price: number, date: string) => trade({ tradingsymbol: SYM, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date });
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "fyers-api", broker: "fyers", format: "api", trades, warnings: [] });

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  select(id);
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const sold = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.sellQty, 0);
const importFile = (accountId: number, file: ParsedFile, fileName: string, autoClose = true) =>
  commit.commitParsedFile(file, fileName, null, accountId, { autoClose });
const pullFile = (accountId: number, file: ParsedFile, fileName: string) =>
  commit.commitParsedFile(file, fileName, null, accountId, { supersedeSnapshot: { fileName }, autoClose: true });
const preview = (accountId: number, file: ParsedFile, fileName: string) => commit.previewParsedFile(file, null, accountId, fileName, { autoClose: true });

beforeAll(async () => {
  t = await openTempDb("fix-a-held-identity", { seed: true });
  commit = await import("@/lib/import/commit");
  del = await import("@/lib/queries/delete");
}, 30_000);

afterAll(() => t?.cleanup());

// ─────────────────────────────────────────────────────────────────────────────

describe("J-2 · the three holder shapes, each with the remedy that exists for it", () => {
  const A = 311;
  it("shape 2 — a PLAIN never-closed sale row holds the remainder's hash: 'delete that row', never 'Un-close'; the path ends at the stated figure", () => {
    newAccount(A, "fix-a j2 plain");
    importFile(A, parsed([buy(QTY, 120, "2026-09-10")]), "lot.csv");
    importFile(A, parsed([sell(QTY, 140, DAY)]), "sale-75.csv", false);
    const plain = rowsOf(A).find((r) => r.sellQty === QTY)!;
    const file = parsed([sell(150, 140, DAY)]);
    const pre = preview(A, file, "sale-150.csv");
    expect(pre.autoClose).toMatchObject({ refusedHeldIdentity: 1 });
    const c = pre.crossSource!.collisions;
    expect(c.map((x) => [x.kind, x.holder, x.existing.id])).toEqual([["held-identity", "plain-row", plain.id]]);
    // THE assertions (release audit J-2): HEAD said "Un-close that record from Trades" for this row.
    expect(c[0]!.detail).toContain(`That earlier row (sale-75.csv, ${DAY}) already records this sale — it is part of this file's 150. Delete that row in Trades, then import / pull again`);
    expect(c[0]!.detail).not.toMatch(/Un-close/);
    expect(pre.crossSource!.message).toContain("already recorded as a row of its own");
    expect(pre.crossSource!.message).toContain("Delete that earlier row in Trades, then pull again");
    expect(pre.crossSource!.message).not.toMatch(/Un-close/);
    expect(pre.crossSource!.message, "the DQ 'join them' alternative is gone from this branch").not.toMatch(/join them/);
    // The remedy walked: delete the plain row, import again → the lot closes, the rest is the execution's own row; sold 150.
    expect(del.deleteTradesByIds([plain.id], "J-2 remedy", "test").ok).toBe(true);
    const res = importFile(A, file, "sale-150.csv");
    expect(res.autoClose).toMatchObject({ closedWhole: 1, refusedHeldIdentity: 0 });
    expect(rowsOf(A).map((r) => [r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[QTY, QTY, false], [0, QTY, true]].sort());
    expect(sold(A), "the file sold 150").toBe(150);
  });

  const B = 312;
  it("shape 3 — a Data Quality-JOINED lot holds the remainder's hash as an alias: 'Undo Data Quality join', never a delete (it holds the purchase)", () => {
    newAccount(B, "fix-a j2 joined");
    importFile(B, parsed([buy(QTY, 120, "2026-09-10")]), "lot-a.csv");
    importFile(B, parsed([sell(QTY, 140, DAY)]), "sale-75.csv", false);
    const [lotA, sale] = rowsOf(B);
    expect(commit.closeStaleLot(lotA!.id, sale!.id, DAY).ok).toBe(true);
    importFile(B, parsed([buy(QTY, 121, "2026-09-11")]), "lot-b.csv");
    const pre = preview(B, parsed([sell(150, 140, DAY)]), "sale-150.csv");
    expect(pre.autoClose).toMatchObject({ refusedHeldIdentity: 1 });
    const c = pre.crossSource!.collisions;
    expect(c.map((x) => [x.kind, x.holder, x.existing.id])).toEqual([["held-identity", "joined", lotA!.id]]);
    expect(c[0]!.detail).toBe(`Trade #${lotA!.id} (${SYM}) already records this sale as part of its close. Undo that join (Trades → the row's menu → ${UNJOIN_MENU_LABEL}) and import again, or commit anyway to record this row beside it.`);
    expect(pre.crossSource!.message).toContain("already recorded as part of a position's close — a Data Quality join");
    expect(pre.crossSource!.message).toContain(`Undo that join (Trades → the row's menu → ${UNJOIN_MENU_LABEL})`);
    // U1: a row holding a purchase on no other row is never advised deleted.
    expect(pre.crossSource!.message).not.toMatch(/[Dd]elete/);
    expect(pre.crossSource!.message).not.toMatch(/Un-close/);
    expect(pre.crossSource!.risky, "still a 409 needsForce").toBe(true);
  });

  const C = 313;
  it("shape 1 — an AUTO-CLOSE piece (a lot a pull folded whole) holds the hash: today's 'Un-close …' text stays", () => {
    newAccount(C, "fix-a j2 auto-close");
    importFile(C, parsed([buy(QTY, 120, "2026-09-10")]), "lot-a.csv");
    // A pull folds the 75 sale into lot A whole: lot A holds the sale's hash as an alias and SAYS an import closed it.
    expect(pullFile(C, parsed([sell(QTY, 140, DAY)]), `fyers-api-${DAY}`).autoClose?.closedWhole).toBe(1);
    const lotA = rowsOf(C)[0]!;
    importFile(C, parsed([buy(QTY, 121, "2026-09-11")]), "lot-b.csv");
    // A FILE sells 150: lot B closes whole, the 75 left over hashes to the pull's sale — held by lot A.
    const pre = preview(C, parsed([sell(150, 140, DAY)]), "sale-150.csv");
    expect(pre.autoClose).toMatchObject({ refusedHeldIdentity: 1 });
    const c = pre.crossSource!.collisions;
    expect(c.map((x) => [x.kind, x.holder, x.existing.id])).toEqual([["held-identity", "auto-close", lotA.id]]);
    expect(c[0]!.detail).toContain("Un-close that record from Trades and pull again");
    expect(pre.crossSource!.message).toContain(`Un-close that earlier record (Trades → the row's menu → "Un-close")`);
  });

  it("the counter sentence knows no row, so it names no remedy and points at the per-row detail", () => {
    const [s] = autoCloseSentences({ ...emptyAutoCloseCounters(), refusedHeldIdentity: 1 });
    expect(s).toContain("already recorded as a row of its own");
    expect(s).toContain("names the earlier record and the way to resolve it");
    expect(s).not.toMatch(/Un-close|join them from Data Quality/);
  });
});
