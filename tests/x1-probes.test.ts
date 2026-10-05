import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
// Pure (no DB): the note readers and the key.
import { AUTO_CLOSE_NOTE, DEDUP_ALIAS_PREFIX, EXEC_ORIGIN_PREFIX, execOriginFromNotes, executionHashOfPiece } from "@/lib/import/close-open-lots";
import { pairKeyOf } from "@/lib/import/contract-key";

/**
 * v4.8.0 wave X1 — THE PROBES, as named tests (X1-REVIEW-2026-10-05.md).
 *
 * Every case below was RED on HEAD 3502995 (the published v4.7.0) and is green
 * after X1; the red-on-revert evidence per fix is in the wave report. Each runs
 * the REAL preview and commit with the options the broker route passes
 * (`supersedeSnapshot` for a snapshot pull, `autoClose: true`), and reads the
 * book back through the product's own doors.
 *
 *   PROBE-1   same name, lot 75; 11:00 sells 75 (folded whole), 15:00 states 150
 *             → was 225 sold against the broker's 150; now a 409 ask (D6b).
 *   PROBE-4   lot 75, 11:00 sells 75, un-close, 15:00 states 150
 *             → was `UNIQUE constraint failed` out of a commit the preview had
 *             called safe; now the reinstated sale is superseded in place (D4 b).
 *   PROBE-5a  OpenAlgo alone, two pulls one day → was bought 150 against 75;
 *             now the day aggregate supersedes the morning row (S7).
 *   PROBE-5b  OpenAlgo opens the lot today, the native sale closes it, OpenAlgo
 *             pulls again → was a silent second row; now a 409 (D6b iii + S7).
 *   D2/D4     the cross-name exact pair closes, stored under the LOT's name,
 *             and un-close reinstates the execution as ITS file stated it.
 *   D3/D5     a month-level pair is said, listed with both names, joined only
 *             with the tick (owner ruling S6).
 *   D6b (ii)  a close whose remainder the journal already holds is refused in
 *             preview AND commit — never an insert that throws.
 *
 * ONE temp database per FILE (AGENTS.md Testing): every case owns its account.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dq: typeof import("@/lib/queries/data-quality");
let dedup: typeof import("@/lib/import/dedup");
let trash: typeof import("@/lib/trash");

const OA_W = "OPT NIFTY 22 Sep 2026 25000 CE";
const NAT_W = "NIFTY2692225000CE";
const NAT_M = "NIFTY26SEP25000CE";
const OA_M = "OPT NIFTY 29 Sep 2026 25000 CE";
const DAY = "2026-09-15";
const PREV = "2026-09-14";
const FILES = {
  oaPrev: `openalgo-fyers-${PREV}`,
  oa: `openalgo-fyers-${DAY}`,
  fyers: `fyers-api-${DAY}`,
  angel: `angelone-api-${DAY}`,
  angelFile: "angelone-tradebook-prev.csv",
} as const;
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
const buy = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });
const sell = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });
/** The OpenAlgo DAY AGGREGATE of a position opened and closed today. */
const roundTrip = (sym: string, qty: number, buyP: number, sellP: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: buyP, buyValue: r2(qty * buyP), buyDate: date, sellQty: qty, avgSellPrice: sellP, sellValue: r2(qty * sellP), sellDate: date, grossPnl: r2(qty * (sellP - buyP)), ...over });

const parsed = (trades: NormalizedTrade[], broker: ParsedFile["broker"] = "fyers", sourceId = "fyers-api"): ParsedFile => ({ sourceId, broker, format: "api", trades, warnings: [] });

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  select(id);
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const sold = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.sellQty, 0);
const bought = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.buyQty, 0);

/**
 * The broker route's pull decision (`app/api/import/broker/route.ts`, the commit
 * branch), against the REAL preview and commit with the route's own options.
 */
function pull(accountId: number, file: ParsedFile, fileName: string, snapshot = true) {
  const opts = { ...(snapshot ? { supersedeSnapshot: { fileName } } : {}), autoClose: true };
  const preview = commit.previewParsedFile(file, null, accountId, fileName, opts);
  if (preview.summary.total > 0 && preview.summary.newCount === 0 && preview.summary.supersededCount === 0) {
    return { status: 409 as const, reason: "nothingNew" as const, preview, result: null };
  }
  if (preview.crossSource?.risky) return { status: 409 as const, reason: "needsForce" as const, preview, result: null };
  const result = commit.commitParsedFile(file, fileName, null, accountId, opts);
  return { status: 200 as const, reason: "committed" as const, preview, result };
}
/** A FILE import (no snapshot identity), auto-close on. */
const importFile = (accountId: number, file: ParsedFile, fileName: string, autoClose = true) =>
  commit.commitParsedFile(file, fileName, null, accountId, { autoClose });

beforeAll(async () => {
  t = await openTempDb("x1-probes", { seed: true });
  commit = await import("@/lib/import/commit");
  dq = await import("@/lib/queries/data-quality");
  dedup = await import("@/lib/import/dedup");
  trash = await import("@/lib/trash");
}, 30_000);

afterAll(() => t?.cleanup());

// ─────────────────────────────────────────────────────────────────────────────

describe("D2 + D4 — the cross-name EXACT pair: an OpenAlgo weekly lot sold through the native pull", () => {
  const A = 91;
  it("closes the lot whole, stored under the LOT's name, with the execution's origin on it; the book sells 75 once", () => {
    newAccount(A, "x1 exact");
    expect(pull(A, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev).result!.added).toBe(1);
    const out = pull(A, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers);
    expect([out.status, out.reason]).toEqual([200, "committed"]);
    // Preview = commit: the plan's counters and net.
    expect(out.preview.autoClose).toMatchObject({ closedWhole: 1, closedAgainstStoredLot: 1, refusedMonthOnly: 0 });
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 1, closedAgainstStoredLot: 1 });
    expect(out.result!.added).toBe(0);
    expect(r2(out.preview.summary.netPnl)).toBe(r2(out.result!.netPnl));

    const rows = rowsOf(A);
    expect(rows.map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen, r.sourceFile])).toEqual([[OA_W, QTY, QTY, false, FILES.oaPrev]]);
    expect(sold(A), "the broker sold 75").toBe(QTY);
    const origin = execOriginFromNotes(rows[0]!.importNotes);
    expect(origin).toEqual({ tradingsymbol: NAT_W, isin: null, sourceFile: FILES.fyers, importBatchId: expect.any(Number) });
    expect(rows[0]!.importNotes).toContain(AUTO_CLOSE_NOTE);
    expect(rows[0]!.importNotes).toContain(DEDUP_ALIAS_PREFIX);
    // A re-pull of the sale is a duplicate (the alias), not a second row.
    const again = pull(A, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers);
    expect([again.status, again.reason]).toEqual([409, "nothingNew"]);
  });

  const B = 92;
  it("a PARTIAL sale (40 of 75): the slice copies the lot's name; un-close reinstates the sale as ITS file stated it, hash derivable", () => {
    newAccount(B, "x1 partial");
    pull(B, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    const out = pull(B, parsed([sell(NAT_W, 40, 140, DAY)]), FILES.fyers);
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 0, reduced: 1 });
    const after = rowsOf(B);
    expect(after.map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_W, 35, 0, true], [OA_W, 40, 40, false]].sort());
    const slice = after.find((r) => !r.isOpen)!;
    expect(slice.symbol, "D4(a): the lot's own symbol, not a re-classification").toBe(after.find((r) => r.isOpen)!.symbol);
    expect(slice.sourceFile).toBe(FILES.fyers);
    expect(execOriginFromNotes(slice.importNotes)?.tradingsymbol).toBe(NAT_W);

    const hash = executionHashOfPiece(slice);
    const un = commit.unCloseExecution(B, "fyers", hash);
    expect(un.ok, un.message).toBe(true);
    const back = rowsOf(B);
    const lot = back.find((r) => r.tradingsymbol === OA_W)!;
    const sale = back.find((r) => r.tradingsymbol === NAT_W)!;
    expect([lot.buyQty, lot.sellQty, lot.isOpen]).toEqual([QTY, 0, true]);
    expect([sale.buyQty, sale.sellQty, sale.isOpen, sale.sourceFile, sale.dedupHash]).toEqual([0, 40, true, FILES.fyers, hash]);
    expect(sale.importBatchId, "filed under the SALE's batch, not the lot's").toBe(slice.importBatchId);
    // The hash is derivable from the row's OWN columns again — what the Paytm
    // re-key would recompute, and what a re-import of the file hashes to.
    expect(dedup.dedupHash({ ...sale, buyValue: sale.buyValue, sellValue: sale.sellValue })).toBe(sale.dedupHash);
    expect(sale.importNotes ?? "", "no machine segment survives on the reinstated row").not.toContain(EXEC_ORIGIN_PREFIX);
  });

  const C = 93;
  it("a sale LARGER than the lot (100 of 75): the remainder is the execution's own row; un-close folds it back to ONE row of 100", () => {
    newAccount(C, "x1 remainder");
    pull(C, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    const out = pull(C, parsed([sell(NAT_W, 100, 140, DAY)]), FILES.fyers);
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 1, openedNew: 1 });
    const after = rowsOf(C);
    expect(after.map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_W, QTY, QTY, false], [NAT_W, 0, 25, true]].sort());
    expect(sold(C)).toBe(100);
    const remainder = after.find((r) => r.isOpen)!;
    expect(execOriginFromNotes(remainder.importNotes)?.sourceFile).toBe(FILES.fyers);

    const hash = executionHashOfPiece(after.find((r) => !r.isOpen)!);
    expect(commit.unCloseExecution(C, "fyers", hash).ok).toBe(true);
    const back = rowsOf(C);
    expect(back.map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_W, QTY, 0, true], [NAT_W, 0, 100, true]].sort());
    expect(sold(C)).toBe(100);
  });
});

describe("PROBE-1 — a snapshot pull whose sale an auto-close folded WHOLE into an older lot, then the same pull states more", () => {
  const D = 94;
  it("same name, one lot: the 15:00 pull is ASKED (409 needsForce), nothing added — the book sells 75, not 225", () => {
    newAccount(D, "x1 probe-1");
    const angel = (rows: NormalizedTrade[]) => parsed(rows.map((r) => ({ ...r, broker: "angelone" }) as NormalizedTrade), "angelone", "angelone-api");
    expect(importFile(D, angel([buy("NIFTY2692225000CE", QTY, 120, "2026-09-10")]), FILES.angelFile).added).toBe(1);
    const eleven = pull(D, angel([sell("NIFTY2692225000CE", QTY, 140, DAY)]), FILES.angel);
    expect([eleven.status, eleven.result!.added, eleven.result!.autoClose?.closedWhole]).toEqual([200, 0, 1]);
    expect(sold(D)).toBe(QTY);

    const fifteen = pull(D, angel([sell("NIFTY2692225000CE", 150, 140, DAY)]), FILES.angel);
    // THE assertion: on HEAD 3502995 this was `[200, "committed"]` and the book sold 225.
    expect([fifteen.status, fifteen.reason]).toEqual([409, "needsForce"]);
    expect(fifteen.preview.crossSource?.collisions.map((c) => [c.kind, c.sameSnapshot, c.existing.sourceFile])).toEqual([["partial-quantity", true, FILES.angelFile]]);
    expect(sold(D), "nothing was committed").toBe(QTY);
    expect(rowsOf(D)).toHaveLength(1);
  });

  const D2 = 95;
  it("two lots (75 + 75): the 11:00 sale closes the first; the 15:00 restatement is asked the same way", () => {
    newAccount(D2, "x1 probe-1 two lots");
    const angel = (rows: NormalizedTrade[]) => parsed(rows.map((r) => ({ ...r, broker: "angelone" }) as NormalizedTrade), "angelone", "angelone-api");
    importFile(D2, angel([buy("NIFTY2692225000CE", QTY, 120, "2026-09-10"), buy("NIFTY2692225000CE", QTY, 121, "2026-09-11")]), FILES.angelFile);
    pull(D2, angel([sell("NIFTY2692225000CE", QTY, 140, DAY)]), FILES.angel);
    const fifteen = pull(D2, angel([sell("NIFTY2692225000CE", 150, 140, DAY)]), FILES.angel);
    expect([fifteen.status, fifteen.reason]).toEqual([409, "needsForce"]);
    expect(sold(D2)).toBe(QTY);
  });

  const D3 = 96;
  it("cross-name: an OpenAlgo lot sold through the native pull, then the native pull restates 150 — asked, not added", () => {
    newAccount(D3, "x1 probe-1 cross-name");
    pull(D3, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    expect(pull(D3, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers).result!.autoClose?.closedWhole).toBe(1);
    const grown = pull(D3, parsed([sell(NAT_W, 150, 140, DAY)]), FILES.fyers);
    expect([grown.status, grown.reason]).toEqual([409, "needsForce"]);
    expect(sold(D3)).toBe(QTY);
  });
});

describe("PROBE-4 — lot 75, 11:00 sells 75, UN-CLOSE, 15:00 states 150", () => {
  const E = 97;
  it("the reinstated sale is filed under its own pull, so the 15:00 pull supersedes it IN PLACE — no insert, no throw; preview = commit", () => {
    newAccount(E, "x1 probe-4");
    pull(E, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    pull(E, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers);
    const lot = rowsOf(E)[0]!;
    expect(commit.unCloseExecution(E, "fyers", executionHashOfPiece(lot)).ok).toBe(true);
    const reinstated = rowsOf(E).find((r) => r.tradingsymbol === NAT_W)!;
    expect([reinstated.sellQty, reinstated.sourceFile], "D4(b): under the SALE's file").toEqual([QTY, FILES.fyers]);

    const fifteen = pull(E, parsed([sell(NAT_W, 150, 140, DAY)]), FILES.fyers);
    // THE assertion: on HEAD 3502995 the commit THREW `UNIQUE constraint failed:
    // trades.account_id, trades.broker, trades.dedup_hash` after a preview that
    // had said new=1, risky=false.
    expect([fifteen.status, fifteen.reason]).toEqual([200, "committed"]);
    expect(fifteen.preview.summary.supersededCount).toBe(1);
    expect(fifteen.result!.warnings).toContain("1 position updated from today's earlier pull.");
    expect(fifteen.result!.added).toBe(0);
    expect(fifteen.preview.autoClose?.closedWhole, "the preview skips the applier on a superseding row").toBe(0);
    expect(fifteen.result!.autoClose?.closedWhole, "and so does the commit (D10)").toBe(0);
    const after = rowsOf(E);
    expect(after.map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_W, QTY, 0, true], [NAT_W, 0, 150, true]].sort());
    expect(after.find((r) => r.tradingsymbol === NAT_W)!.id, "the SAME row, restated").toBe(reinstated.id);
    expect(sold(E), "the broker sold 150").toBe(150);
    // End state: listed in Data Quality (the lot open beside its restated sale).
    select(E);
    const pairs = dq.getStaleOpenSection().pairs;
    expect(pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly, p.oneClick])).toEqual([[OA_W, NAT_W, false, false]]);
  });
});

describe("D6b (ii) — a close whose remainder the journal ALREADY holds is refused, in preview and commit alike", () => {
  const F = 98;
  it("lot 75 + a stored sale row of 75; a file sells 150: refused with a counter and a risky ask, and the commit never throws", () => {
    newAccount(F, "x1 held identity");
    importFile(F, parsed([buy(NAT_W, QTY, 120, "2026-09-10")]), "lot.csv");
    // The sale stored as its own row (the user kept sells separate that day).
    importFile(F, parsed([sell(NAT_W, QTY, 140, DAY)]), "sale-75.csv", false);
    expect(rowsOf(F).map((r) => [r.buyQty, r.sellQty])).toEqual([[QTY, 0], [0, QTY]]);

    const file = parsed([sell(NAT_W, 150, 140, DAY)]);
    const pre = commit.previewParsedFile(file, null, F, "sale-150.csv", { autoClose: true });
    expect(pre.autoClose).toMatchObject({ closedWhole: 0, refusedHeldIdentity: 1 });
    expect(pre.crossSource?.risky, "a risky ask: the route answers 409 needsForce").toBe(true);
    expect(pre.crossSource?.collisions.map((c) => c.kind)).toEqual(["held-identity"]);
    expect(pre.crossSource?.message).toMatch(/already recorded as a row of its own/);
    expect(pre.warnings.join(" ")).toMatch(/already recorded as a row of its own/);

    // A FORCED commit: the row lands as stated, the counter agrees, nothing throws.
    // On HEAD 3502995: `SqliteError: UNIQUE constraint failed`.
    const res = importFile(F, file, "sale-150.csv");
    expect(res.autoClose).toMatchObject({ closedWhole: 0, refusedHeldIdentity: 1 });
    expect(res.added).toBe(1);
    expect(rowsOf(F).map((r) => [r.buyQty, r.sellQty]).sort()).toEqual([[QTY, 0], [0, QTY], [0, 150]].sort());
  });
});

describe("PROBE-5 — OpenAlgo's DAY-AGGREGATE pull (owner ruling S7: it joins the snapshot set)", () => {
  const G = 99;
  it("5a: OpenAlgo alone, two pulls one day — the second RESTATES the first in place: bought 75, sold 75", () => {
    newAccount(G, "x1 probe-5a");
    const first = pull(G, parsed([buy(OA_W, QTY, 120, DAY)], "fyers", "openalgo-api"), FILES.oa);
    expect(first.result!.added).toBe(1);
    const second = pull(G, parsed([roundTrip(OA_W, QTY, 120, 140, DAY)], "fyers", "openalgo-api"), FILES.oa);
    // THE assertion: on HEAD 3502995 OpenAlgo was outside the snapshot set, so
    // this added a second row — bought 150, sold 75 against the broker's 75 / 75.
    expect([second.status, second.preview.summary.supersededCount, second.result!.added]).toEqual([200, 1, 0]);
    expect(rowsOf(G).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[QTY, QTY, false]]);
    expect([bought(G), sold(G)]).toEqual([QTY, QTY]);
  });

  const H = 100;
  it("5b: OpenAlgo opens the lot today, the native sale closes it, OpenAlgo pulls again — 409, through the snapshot ask AND the same-file exclusion", () => {
    newAccount(H, "x1 probe-5b");
    pull(H, parsed([buy(OA_W, QTY, 120, DAY)], "fyers", "openalgo-api"), FILES.oa);
    expect(pull(H, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers).result!.autoClose?.closedWhole).toBe(1);
    const again = parsed([roundTrip(OA_W, QTY, 120, 140, DAY)], "fyers", "openalgo-api");
    // With the snapshot identity (the route, S7): the frozen lot is asked about.
    const snap = pull(H, again, FILES.oa, true);
    expect([snap.status, snap.reason]).toEqual([409, "needsForce"]);
    // WITHOUT it (D6b iii): the lot sits in this very file, but another file's
    // execution closed it, so the same-file exclusion no longer hides it.
    const plain = pull(H, again, FILES.oa, false);
    expect([plain.status, plain.reason]).toEqual([409, "needsForce"]);
    expect(plain.preview.crossSource?.collisions[0]).toMatchObject({ kind: "same-quantity", existing: { sourceFile: FILES.oa } });
    expect([bought(H), sold(H)], "the broker bought 75 and sold 75").toEqual([QTY, QTY]);
    expect(rowsOf(H)).toHaveLength(1);
  });

  it("the broker route puts every OpenAlgo connection in its snapshot set (the one place the set is chosen)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("app/api/import/broker/route.ts", "utf8");
    const m = /const snapshotPull =([\s\S]*?);/.exec(src);
    expect(m, "the set is still chosen in one expression").not.toBeNull();
    expect(m?.[1] ?? "").toContain("isOpenAlgoConnectionId(broker)");
  });
});

describe("D3 + D5 — a MONTH-level pair is said, listed with both names and joined only with the tick (owner ruling S6)", () => {
  const I = 101;
  it("OpenAlgo monthly lot + native compact monthly sale: two rows, `refusedMonthOnly` 1 in preview and commit, a `monthOnly` pair, MONTH_ONLY without the tick, joined with it", () => {
    newAccount(I, "x1 month-only");
    pull(I, parsed([buy(OA_M, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    const out = pull(I, parsed([sell(NAT_M, QTY, 140, DAY)]), FILES.fyers);
    expect([out.status, out.result!.added]).toEqual([200, 1]);
    expect(out.preview.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 1 });
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 1 });
    expect((out.result!.warnings ?? []).join(" ")).toMatch(/states no expiry day/);
    expect(out.preview.warnings.join(" ")).toMatch(/states no expiry day/);
    expect(rowsOf(I).map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_M, QTY, 0, true], [NAT_M, 0, QTY, true]].sort());

    select(I);
    const pairs = dq.getStaleOpenSection().pairs;
    expect(pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly, p.ambiguous, p.oneClick])).toEqual([[OA_M, NAT_M, true, false, true]]);
    const [p] = pairs;
    const refused = commit.closeStaleLot(p!.lotId, p!.saleId, DAY);
    expect([refused.ok, refused.code]).toEqual([false, "MONTH_ONLY"]);
    expect(rowsOf(I)).toHaveLength(2);
    const joined = commit.closeStaleLot(p!.lotId, p!.saleId, DAY, { monthOnlyAcknowledged: true });
    expect(joined.ok, joined.message).toBe(true);
    expect(rowsOf(I).map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen])).toEqual([[OA_M, QTY, QTY, false]]);
    expect(sold(I)).toBe(QTY);
    // The sale row is in Deleted items, and its re-pull is a duplicate (the alias).
    expect(trash.listTrashSnapshots().length).toBeGreaterThan(0);
    expect(pull(I, parsed([sell(NAT_M, QTY, 140, DAY)]), FILES.fyers).reason).toBe("nothingNew");
  });

  const J = 102;
  it("a compact WEEKLY sale against a compact MONTHLY lot: one grammar, two contracts — never listed, never said", () => {
    newAccount(J, "x1 weekly vs monthly");
    pull(J, parsed([buy(NAT_M, QTY, 120, PREV)]), `fyers-api-${PREV}`);
    const out = pull(J, parsed([sell(NAT_W, QTY, 140, DAY)]), FILES.fyers);
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 0 });
    select(J);
    expect(dq.getStaleOpenSection().pairs).toEqual([]);
    expect(rowsOf(J)).toHaveLength(2);
  });

  const K = 103;
  it("the calendar spread (a dated weekly lot, a compact monthly sale): said and listed month-only, never closed; a sale dated AFTER the weekly's expiry is not listed at all", () => {
    newAccount(K, "x1 calendar spread");
    pull(K, parsed([buy(OA_W, QTY, 120, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    const out = pull(K, parsed([sell(NAT_M, QTY, 140, DAY)]), FILES.fyers);
    expect(out.result!.autoClose).toMatchObject({ closedWhole: 0, refusedMonthOnly: 1 });
    select(K);
    expect(dq.getStaleOpenSection().pairs.map((p) => [p.tradingsymbol, p.saleTradingsymbol, p.monthOnly])).toEqual([[OA_W, NAT_M, true]]);
    // The weekly expired on the 22nd: a monthly sale on the 25th cannot be its
    // exit (50 @ 160 — unrelated to the first sale by quantity and value, so the
    // C6 cross-source check has nothing to say and the pull commits).
    const late = pull(K, parsed([sell(NAT_M, 50, 160, "2026-09-25")]), `fyers-api-2026-09-25`);
    expect([late.status, late.reason]).toEqual([200, "committed"]);
    expect(late.result!.autoClose).toMatchObject({ refusedMonthOnly: 0 });
    select(K);
    expect(dq.getStaleOpenSection().pairs.map((p) => p.saleDate)).toEqual([DAY]);
  });

  const L = 104;
  it("a month-level pair is AMBIGUOUS when the month's book states two expiry days (a weekly lot beside the monthly's)", () => {
    newAccount(L, "x1 month ambiguous");
    pull(L, parsed([buy(OA_W, QTY, 120, PREV), buy(OA_M, QTY, 110, PREV)], "fyers", "openalgo-api"), FILES.oaPrev);
    pull(L, parsed([sell(NAT_M, QTY, 140, DAY)]), FILES.fyers);
    select(L);
    const pairs = dq.getStaleOpenSection().pairs;
    expect(pairs.map((p) => [p.monthOnly, p.ambiguous, p.oneClick])).toEqual([[true, true, false]]);
    const res = commit.closeStaleLot(pairs[0]!.lotId, pairs[0]!.saleId, DAY, { monthOnlyAcknowledged: true });
    expect([res.ok, res.code]).toEqual([false, "AMBIGUOUS"]);
  });
});

describe("D6a — the supersede key carries the pairing key, and a whole-row restatement is unchanged", () => {
  const M = 105;
  it("a same-day re-pull of one position under one name still replaces it in place (R43, byte-green)", () => {
    newAccount(M, "x1 supersede neutral");
    pull(M, parsed([buy(NAT_W, 10, 120, DAY)]), FILES.fyers);
    const again = pull(M, parsed([buy(NAT_W, 20, 121, DAY)]), FILES.fyers);
    expect([again.preview.summary.supersededCount, again.result!.added]).toEqual([1, 0]);
    expect(rowsOf(M).map((r) => [r.buyQty, pairKeyOf(r.tradingsymbol)])).toEqual([[20, pairKeyOf(NAT_W)]]);
  });
});
