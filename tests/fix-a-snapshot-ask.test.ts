import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
// Pure (no DB): the note readers and the label.
import {
  AUTO_CLOSE_NOTE,
  DEDUP_ALIAS_PREFIX,
  EXEC_BILL_PREFIX,
  EXEC_ORIGIN_PREFIX,
  STALE_CLOSE_NOTE,
  UNJOIN_MENU_LABEL,
  closeOriginOf,
  closedOnDayWithoutPull,
  executionHashOfPiece,
} from "@/lib/import/close-open-lots";

/**
 * v4.8.0 FIX-A — S-1 and J-1 (FIX-A-REVIEW-2026-10-05.md, binding).
 *
 * S-1  The snapshot set admitted a stored row only when it sat in the pull's
 *      file or carried the pull's `exec-origin:`. A frozen row closed TODAY that
 *      records no closing pull — a ≤ v4.7.0 whole-fold (P-B: `AUTO_CLOSE_NOTE |
 *      dedup-alias | exec-bill`, filed under the LOT's file), or a Data Quality
 *      join of this pull's own kept-separate sale (P-A) — was invisible, so a
 *      same-day restating pull was a plain new position: 225 sold where the
 *      broker stated 150, auto-pull committing too. Both fixtures below were
 *      `[200, "committed"]` on HEAD 60c809b.
 * J-1  The 409's detail named the LOT's file and its sentence a remedy that
 *      ends at 225. Now it names what closed the row (today's earlier pull /
 *      an earlier pull today / a Data Quality join you made today) and the one
 *      remedy that ends at the broker's figure — pinned here by WALKING it
 *      (P-C, P-D and the dq-join branch): un-close or un-join, delete the sale
 *      that brings back, pull again → sold 150, the lot closed.
 *
 * ONE temp database per FILE (AGENTS.md Testing): every case owns its account.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let del: typeof import("@/lib/queries/delete");
let autoPull: typeof import("@/lib/jobs/auto-pull");

const SYM = "NIFTY2692225000CE";
const DAY = "2026-09-15";
const NEXT = "2026-09-16";
const LOT_FILE = "angelone-tradebook-prev.csv";
const PULL = `angelone-api-${DAY}`;
const PULL_NEXT = `angelone-api-${NEXT}`;
const QTY = 75;
const r2 = (n: number) => Math.round(n * 100) / 100;

function trade(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
  return {
    broker: "angelone",
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
const parsed = (trades: NormalizedTrade[]): ParsedFile => ({ sourceId: "angelone-api", broker: "angelone", format: "api", trades, warnings: [] });

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  select(id);
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const sold = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.sellQty, 0);

/** The broker route's pull decision (app/api/import/broker/route.ts), against the REAL preview and commit. */
function pull(accountId: number, file: ParsedFile, fileName: string, autoClose = true) {
  const opts = { supersedeSnapshot: { fileName }, autoClose };
  const preview = commit.previewParsedFile(file, null, accountId, fileName, opts);
  if (preview.summary.total > 0 && preview.summary.newCount === 0 && preview.summary.supersededCount === 0) {
    return { status: 409 as const, reason: "nothingNew" as const, preview, result: null };
  }
  if (preview.crossSource?.risky) return { status: 409 as const, reason: "needsForce" as const, preview, result: null };
  const result = commit.commitParsedFile(file, fileName, null, accountId, opts);
  return { status: 200 as const, reason: "committed" as const, preview, result };
}
const importFile = (accountId: number, file: ParsedFile, fileName: string, autoClose = true) =>
  commit.commitParsedFile(file, fileName, null, accountId, { autoClose });

/** The lot the 11:00 pull folded whole, re-shaped to what v4.7.0 WROTE (P-B): no `exec-origin:`. */
function stripOrigin(id: number) {
  const row = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
  const notes = row.importNotes!.split("|").map((s) => s.trim()).filter((s) => !s.startsWith(EXEC_ORIGIN_PREFIX)).join(" | ");
  t.db.update(t.schema.trades).set({ importNotes: notes }).where(eq(t.schema.trades.id, id)).run();
  return t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get()!;
}

beforeAll(async () => {
  t = await openTempDb("fix-a-snapshot-ask", { seed: true });
  commit = await import("@/lib/import/commit");
  del = await import("@/lib/queries/delete");
  autoPull = await import("@/lib/jobs/auto-pull");
}, 30_000);

afterAll(() => t?.cleanup());

// ─────────────────────────────────────────────────────────────────────────────

describe("the predicate — closeOriginOf / closedOnDayWithoutPull (pure)", () => {
  const alias = `${DEDUP_ALIAS_PREFIX}${"a".repeat(40)}`;
  const origin = `${EXEC_ORIGIN_PREFIX}SYM;;pull-file;1`;
  it("names the three shapes and nothing else", () => {
    expect(closeOriginOf(`${AUTO_CLOSE_NOTE} | ${alias} | ${EXEC_BILL_PREFIX}[0,0,0,0,0,0,0,0,0,0,0] | ${origin}`)).toBe("pull");
    expect(closeOriginOf(`${AUTO_CLOSE_NOTE} | ${alias} | ${EXEC_BILL_PREFIX}[0,0,0,0,0,0,0,0,0,0,0]`)).toBe("auto-close");
    expect(closeOriginOf(`${STALE_CLOSE_NOTE} | ${alias}`)).toBe("dq-join");
    expect(closeOriginOf(alias)).toBeNull();
    expect(closeOriginOf(null)).toBeNull();
  });
  it("admits a frozen row closed on the day with no pull recorded, by its CLOSING side; never a pull's row, never another day", () => {
    const long = { dedupHash: "x", buyQty: 75, sellQty: 75, buyDate: "2026-09-10", sellDate: DAY, side: "long" };
    expect(closedOnDayWithoutPull({ ...long, importNotes: `${STALE_CLOSE_NOTE} | ${alias}` }, DAY)).toBe(true);
    expect(closedOnDayWithoutPull({ ...long, importNotes: `${AUTO_CLOSE_NOTE} | ${alias}` }, DAY)).toBe(true);
    expect(closedOnDayWithoutPull({ ...long, importNotes: `${AUTO_CLOSE_NOTE} | ${alias} | ${origin}` }, DAY), "an X1 close is admitted by its origin file, not here").toBe(false);
    expect(closedOnDayWithoutPull({ ...long, importNotes: `${STALE_CLOSE_NOTE} | ${alias}` }, NEXT), "closed on another day").toBe(false);
    expect(closedOnDayWithoutPull({ ...long, importNotes: null }, DAY), "not frozen").toBe(false);
    // A short closes on its BUY date (sideOf), so the sell date being today says nothing.
    const short = { dedupHash: "x", buyQty: 75, sellQty: 75, buyDate: "2026-09-10", sellDate: DAY, side: "short", importNotes: `${STALE_CLOSE_NOTE} | ${alias}` };
    expect(closedOnDayWithoutPull(short, DAY)).toBe(false);
    expect(closedOnDayWithoutPull(short, "2026-09-10")).toBe(true);
  });
});

describe("S-1 (P-B) — the v4.7.0 whole-fold shape on the upgrade day", () => {
  const A = 301;
  it("a same-day restating pull is ASKED (409 needsForce), its detail names an earlier pull today — never a file; auto-pull records a collision; the book sells 75", () => {
    newAccount(A, "fix-a s1 v470");
    expect(importFile(A, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE).added).toBe(1);
    const eleven = pull(A, parsed([sell(QTY, 140, DAY)]), PULL);
    expect([eleven.status, eleven.result!.autoClose?.closedWhole]).toEqual([200, 1]);
    const lot = stripOrigin(rowsOf(A)[0]!.id);
    // The v4.7.0 shape exactly: the sentence, the alias, the bill, the LOT's file.
    expect(lot.importNotes).toContain(AUTO_CLOSE_NOTE);
    expect(lot.importNotes).toContain(DEDUP_ALIAS_PREFIX);
    expect(lot.importNotes).toContain(EXEC_BILL_PREFIX);
    expect(lot.importNotes).not.toContain(EXEC_ORIGIN_PREFIX);
    expect([lot.sourceFile, lot.sellDate, lot.isOpen]).toEqual([LOT_FILE, DAY, false]);

    const fifteen = pull(A, parsed([sell(150, 140, DAY)]), PULL);
    // THE assertion: on HEAD 60c809b this was [200, "committed"] and the book sold 225.
    expect([fifteen.status, fifteen.reason]).toEqual([409, "needsForce"]);
    const c = fifteen.preview.crossSource!.collisions;
    expect(c.map((x) => [x.kind, x.sameSnapshot, x.origin, x.existing.id])).toEqual([["partial-quantity", true, "auto-close", lot.id]]);
    // J-1: the pull's file was never stored on a v4.7.0 close, so none is named (invariant 6).
    expect(c[0]!.detail).toContain("already recorded from an earlier pull today");
    expect(c[0]!.detail).not.toContain(LOT_FILE);
    const msg = fifteen.preview.crossSource!.message!;
    expect(msg).toContain(`An earlier pull today already closed ${QTY} of ${SYM} against an older position; this pull states the day's total as 150.`);
    expect(msg).toContain("Un-close that position (the row's menu → Un-close), delete the sale row that brings back, then pull again");
    expect(msg).toContain("so the day is counted twice");
    expect(msg).not.toContain("committing anyway adds this pull's row beside the earlier one");
    expect(sold(A), "nothing was committed").toBe(QTY);
    // lib/jobs/auto-pull.ts: the same preview is a collision skip, never a commit.
    expect(autoPull.classifyPreview(fifteen.preview)).toBe("collision");
  });

  const B = 302;
  it("a pull on ANOTHER day is unchanged: no ask, the sale lands as the new position it is", () => {
    newAccount(B, "fix-a s1 other day");
    importFile(B, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE);
    pull(B, parsed([sell(QTY, 140, DAY)]), PULL);
    stripOrigin(rowsOf(B)[0]!.id);
    const next = pull(B, parsed([sell(150, 140, NEXT)]), PULL_NEXT);
    // Not an ask: nothing risky, no snapshot candidate (the pre-existing soft
    // cross-file "partial overlap" note about the closed lot is informational).
    const cs = next.preview.crossSource;
    expect([next.status, next.reason, cs?.risky ?? false, cs?.collisions.some((c) => c.sameSnapshot || c.origin) ?? false]).toEqual([200, "committed", false, false]);
    expect(rowsOf(B)).toHaveLength(2);
  });
});

describe("S-1 (P-A) — a Data Quality join of this pull's own kept-separate sale, LIVE post-X1", () => {
  const C = 303;
  it("lot 75; 11:00 pull sells 75 with sells kept separate; the one-click joins them; 15:00 states 150 → ASKED, naming the join and its undo; the book sells 75", () => {
    newAccount(C, "fix-a s1 p-a");
    importFile(C, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE);
    const eleven = pull(C, parsed([sell(QTY, 140, DAY)]), PULL, false);
    expect([eleven.status, eleven.result!.added]).toEqual([200, 1]);
    const [lot, sale] = rowsOf(C);
    const joined = commit.closeStaleLot(lot!.id, sale!.id, DAY);
    expect(joined.ok, joined.message).toBe(true);
    const lotNow = rowsOf(C)[0]!;
    expect([lotNow.isOpen, lotNow.sellQty, closeOriginOf(lotNow.importNotes)]).toEqual([false, QTY, "dq-join"]);

    const fifteen = pull(C, parsed([sell(150, 140, DAY)]), PULL);
    // THE assertion: on HEAD 60c809b this was [200, "committed"], added 1, SOLD 225 (review P-A).
    expect([fifteen.status, fifteen.reason]).toEqual([409, "needsForce"]);
    const c = fifteen.preview.crossSource!.collisions;
    expect(c.map((x) => [x.kind, x.sameSnapshot, x.origin])).toEqual([["partial-quantity", true, "dq-join"]]);
    expect(c[0]!.detail).toContain("already recorded from a Data Quality join you made today");
    const msg = fifteen.preview.crossSource!.message!;
    expect(msg).toContain(`A Data Quality join you made today already closed ${QTY} of ${SYM}`);
    expect(msg).toContain(`undo that join (the row's menu → ${UNJOIN_MENU_LABEL}), delete the sale row that brings back, then pull again`);
    expect(msg, "there is NO Un-close for a joined lot (trades-page.ts closedBy is null)").not.toMatch(/Un-close/);
    expect(sold(C)).toBe(QTY);
    expect(autoPull.classifyPreview(fifteen.preview)).toBe("collision");
  });
});

describe("J-1 — the remedy each branch names really ends at the broker's figure", () => {
  const D = 304;
  it("P-C (≤ v4.7.0 shape): un-close → delete the reinstated sale → pull 150 → the lot is closed and the book sells 150", () => {
    newAccount(D, "fix-a j1 p-c");
    importFile(D, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE);
    pull(D, parsed([sell(QTY, 140, DAY)]), PULL);
    const lot = stripOrigin(rowsOf(D)[0]!.id);
    expect(pull(D, parsed([sell(150, 140, DAY)]), PULL).reason).toBe("needsForce");

    const un = commit.unCloseExecution(D, "angelone", executionHashOfPiece(lot));
    expect(un.ok, un.message).toBe(true);
    const reinstated = rowsOf(D).find((r) => r.sellQty === QTY && r.buyQty === 0)!;
    expect(reinstated.sourceFile, "a ≤ v4.7.0 close stored no origin, so the sale lands under the LOT's file").toBe(LOT_FILE);
    expect(del.deleteTradesByIds([reinstated.id], "J-1 remedy: the reinstated sale", "test").ok).toBe(true);
    const again = pull(D, parsed([sell(150, 140, DAY)]), PULL);
    expect([again.status, again.result!.autoClose?.closedWhole]).toEqual([200, 1]);
    expect(rowsOf(D).map((r) => [r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[QTY, QTY, false], [0, QTY, true]].sort());
    expect(sold(D), "the broker sold 150").toBe(150);
  });

  const E = 305;
  it("P-D (post-X1 shape): the detail names TODAY's earlier pull by its file, not the lot's; the same remedy → 150; a later restore of the deleted sale is skipped", async () => {
    newAccount(E, "fix-a j1 p-d");
    importFile(E, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE);
    pull(E, parsed([sell(QTY, 140, DAY)]), PULL);
    const lot = rowsOf(E)[0]!;
    const fifteen = pull(E, parsed([sell(150, 140, DAY)]), PULL);
    expect([fifteen.status, fifteen.reason]).toEqual([409, "needsForce"]);
    const c = fifteen.preview.crossSource!.collisions[0]!;
    // Release audit J-1 (P-D): HEAD read `… already recorded from angelone-tradebook-prev.csv`.
    expect([c.kind, c.origin]).toEqual(["partial-quantity", "pull"]);
    expect(c.detail).toContain(`already recorded from today's earlier pull (${PULL})`);
    expect(c.detail).not.toContain(LOT_FILE);
    expect(fifteen.preview.crossSource!.message).toContain(`Today's earlier pull from this broker already closed ${QTY} of ${SYM}`);

    expect(commit.unCloseExecution(E, "angelone", executionHashOfPiece(lot)).ok).toBe(true);
    const reinstated = rowsOf(E).find((r) => r.sellQty === QTY && r.buyQty === 0)!;
    expect(reinstated.sourceFile, "X1 D4(b): under its own pull").toBe(PULL);
    const deleted = del.deleteTradesByIds([reinstated.id], "J-1 remedy", "test");
    expect(deleted.ok).toBe(true);
    const again = pull(E, parsed([sell(150, 140, DAY)]), PULL);
    expect([again.status, again.result!.autoClose?.closedWhole]).toEqual([200, 1]);
    expect(sold(E)).toBe(150);
    // The informational line the sentence adds: the delete stays in Deleted items; restoring it is skipped.
    const trash = await import("@/lib/trash");
    const res = trash.restoreTrashSnapshot(deleted.snapshotId!, "test");
    expect([res.restored, res.skipped.length]).toEqual([0, 1]);
    expect(res.skipped[0]!.reason).toMatch(/re-imported since the delete|recorded in the position it closed/);
    expect(sold(E), "still 150").toBe(150);
  });

  const F = 306;
  it("dq-join branch: Undo Data Quality join → delete the sale it brings back → pull 150 → 150, the lot closed", () => {
    newAccount(F, "fix-a j1 dq-join");
    importFile(F, parsed([buy(QTY, 120, "2026-09-10")]), LOT_FILE);
    pull(F, parsed([sell(QTY, 140, DAY)]), PULL, false);
    const [lot, sale] = rowsOf(F);
    expect(commit.closeStaleLot(lot!.id, sale!.id, DAY).ok).toBe(true);
    expect(pull(F, parsed([sell(150, 140, DAY)]), PULL).reason).toBe("needsForce");

    const un = commit.unJoinStaleClose(lot!.id);
    expect(un.ok, un.message).toBe(true);
    expect(rowsOf(F).map((r) => [r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[QTY, 0, true], [0, QTY, true]].sort());
    expect(del.deleteTradesByIds([un.saleId!], "J-1 remedy: the restored sale", "test").ok).toBe(true);
    const again = pull(F, parsed([sell(150, 140, DAY)]), PULL);
    expect([again.status, again.result!.autoClose?.closedWhole]).toEqual([200, 1]);
    expect(rowsOf(F).map((r) => [r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[QTY, QTY, false], [0, QTY, true]].sort());
    expect(sold(F), "the broker sold 150").toBe(150);
  });
});
