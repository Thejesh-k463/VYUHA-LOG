import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import {
  DEDUP_ALIAS_PREFIX,
  EXEC_BILL_PREFIX,
  STALE_CLOSE_NOTE,
  UNJOIN_MENU_LABEL,
  execBillFromNotes,
  executionHashOfPiece,
  lotIdentityHashes,
} from "@/lib/import/close-open-lots";
import { closedByStaleJoin } from "@/lib/analytics/data-quality";

/**
 * v4.8.0 FIX-A — J-3, the Un-join door (owner ruling 2026-10-05; review §J-3 binding).
 *
 * `closeStaleLot` now records the SALE's half of the bill as `exec-bill:` and the
 * lot's FULL pre-join row in the audit `before`; `unJoinStaleClose(lotId)`
 * restores the lot from that `before` and puts the sale back from its Trash
 * envelope inside ONE transaction, then consumes the envelope. The sequences
 * the review walked are each a case below; a refusal always leaves the book as
 * it was. On HEAD 60c809b there was no door at all: no Un-close (closedBy null),
 * `unCloseExecution` → SHAPE, the Trash restore skipped, a re-pull a duplicate.
 *
 * ONE temp database per FILE (AGENTS.md Testing): every case owns its account.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let dq: typeof import("@/lib/queries/data-quality");
let trash: typeof import("@/lib/trash");
let tradesPage: typeof import("@/lib/queries/trades-page");
let route: typeof import("@/app/api/data-quality/unjoin-stale/route");

const SYM = "NIFTY2692225000CE";
const OA_M = "OPT NIFTY 29 Sep 2026 25000 CE";
const NAT_M = "NIFTY26SEP25000CE";
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
const buy = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });
const sell = (sym: string, qty: number, price: number, date: string, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });
const parsed = (trades: NormalizedTrade[], sourceId = "fyers-api"): ParsedFile => ({ sourceId, broker: "fyers", format: "api", trades, warnings: [] });

const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
const newAccount = (id: number, name: string) => {
  t.db.insert(t.schema.accounts).values({ id, name }).run();
  select(id);
};
const rowsOf = (accountId: number) =>
  t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all().sort((a, b) => a.id - b.id);
const rowById = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get() ?? null;
const sold = (accountId: number) => rowsOf(accountId).reduce((s, r) => s + r.sellQty, 0);
const importFile = (accountId: number, file: ParsedFile, fileName: string, autoClose = true) =>
  commit.commitParsedFile(file, fileName, null, accountId, { autoClose });
const pull = (accountId: number, file: ParsedFile, fileName: string) => {
  const opts = { supersedeSnapshot: { fileName }, autoClose: true };
  const preview = commit.previewParsedFile(file, null, accountId, fileName, opts);
  if (preview.summary.total > 0 && preview.summary.newCount === 0 && preview.summary.supersededCount === 0) return "nothingNew" as const;
  if (preview.crossSource?.risky) return "needsForce" as const;
  commit.commitParsedFile(file, fileName, null, accountId, opts);
  return "committed" as const;
};
/** Every column but the write stamp — what "byte-identical, ids aside" compares. */
const shapeOf = (r: NonNullable<ReturnType<typeof rowById>>) => {
  const { updatedAt: _u, ...rest } = r;
  return rest;
};
/** The lot + its stored sale, joined by the one-click; returns the pre-join lot row and both ids. */
function joinedPair(accountId: number, name: string, sym = SYM) {
  newAccount(accountId, name);
  importFile(accountId, parsed([buy(sym, QTY, 120, "2026-09-10")]), "lot.csv");
  importFile(accountId, parsed([sell(sym, QTY, 140, DAY)]), "sale-75.csv", false);
  const [lot, sale] = rowsOf(accountId);
  const before = rowById(lot!.id)!;
  const joined = commit.closeStaleLot(lot!.id, sale!.id, DAY);
  expect(joined.ok, joined.message).toBe(true);
  return { lotId: lot!.id, saleId: sale!.id, before, sale: sale! };
}
const envelopeIds = () => trash.listTrashSnapshots().map((s) => s.id);
const jsonReq = (body: unknown) => new Request("http://localhost/api/data-quality/unjoin-stale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  t = await openTempDb("fix-a-unjoin", { seed: true });
  commit = await import("@/lib/import/commit");
  dq = await import("@/lib/queries/data-quality");
  trash = await import("@/lib/trash");
  tradesPage = await import("@/lib/queries/trades-page");
  route = await import("@/app/api/data-quality/unjoin-stale/route");
}, 30_000);

afterAll(() => t?.cleanup());

// ─────────────────────────────────────────────────────────────────────────────

describe("what the join now records", () => {
  const A = 321;
  it("the joined lot carries the SALE's half as exec-bill: and the audit `before` is the full pre-join row; no Un-close appears, and unCloseExecution refuses it by name", () => {
    const { lotId, before, sale } = joinedPair(A, "fix-a j3 records");
    const lot = rowById(lotId)!;
    expect(lot.importNotes).toContain(STALE_CLOSE_NOTE);
    expect(lot.importNotes).toContain(`${DEDUP_ALIAS_PREFIX}${sale.dedupHash}`);
    const bill = execBillFromNotes(lot.importNotes);
    expect(bill, "the second writer of exec-bill: (review §J-3.1)").not.toBeNull();
    // The sale stated no charges of its own (an API row), so its half was PRICED
    // — and the lot's total is the lot's own bill plus exactly that half.
    expect(r2(before.chargesTotal + bill!.total)).toBe(lot.chargesTotal);
    const audit = t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "trade" && a.entityId === lotId && a.action === "close").at(-1)!;
    expect(audit.source).toBe("data-quality");
    expect((audit.beforeJson as Record<string, unknown>).dedupHash, "the FULL row, as delete.ts records a deleted row").toBe(before.dedupHash);
    expect(Object.keys(audit.beforeJson as object).sort()).toEqual(Object.keys(audit.afterJson as object).sort());
    // The menu: a joined lot has `staleJoined`, never `closedBy` (there is no Un-close).
    select(A);
    const wire = tradesPage.getTradesPage({ q: "", broker: "", segment: "", bucket: "", view: "all", realised: false, basisUnknown: false, from: "", to: "" }).rows.find((r) => r.id === lotId)!;
    expect([wire.staleJoined, wire.closedBy]).toEqual([true, null]);
    // The import's un-close is not this join's door (review §Cross-design seams).
    const un = commit.unCloseExecution(A, "fyers", sale.dedupHash);
    expect([un.ok, un.code]).toEqual([false, "SHAPE"]);
    expect(un.message).toContain(UNJOIN_MENU_LABEL);
  });
});

describe("join → un-join: the book is byte-identical to before the join (ids aside); the pair is listed again", () => {
  const B = 322;
  it("the lot reads exactly as before, the sale is back under its own id, hash, charges and notes; the envelope is consumed; a second press is NOT_FOUND", () => {
    const { lotId, saleId, before, sale } = joinedPair(B, "fix-a j3 round trip");
    const envBefore = envelopeIds();
    expect(envBefore.length).toBeGreaterThan(0);
    const res = commit.unJoinStaleClose(lotId);
    expect(res.ok, res.message).toBe(true);
    expect([res.lotId, res.saleId]).toEqual([lotId, saleId]);
    expect(res.message).toContain("Data Quality lists the pair again");
    // THE assertion: every column of the lot as it was before the join.
    expect(shapeOf(rowById(lotId)!)).toEqual(shapeOf(before));
    const back = rowById(saleId)!;
    expect(shapeOf(back)).toEqual(shapeOf(sale));
    expect(sold(B)).toBe(QTY);
    expect(closedByStaleJoin(rowById(lotId)!)).toBe(false);
    // The envelope the join wrote is gone: Deleted items offers no second restore.
    expect(envelopeIds().length).toBe(envBefore.length - 1);
    // (keyed on THIS join's reason: the hash carries no account, so another
    // account's identical fixture sale legitimately sits in its own envelope)
    expect(envelopeIds().some((id) => trash.readTrashEnvelope(id)!.reason.startsWith(`joined to trade #${lotId} `))).toBe(false);
    // Listed again, one-click.
    select(B);
    expect(dq.getStaleOpenSection().pairs.map((p) => [p.lotId, p.saleId, p.oneClick, p.monthOnly])).toEqual([[lotId, saleId, true, false]]);
    // Un-joining twice: nothing left to undo.
    const twice = commit.unJoinStaleClose(lotId);
    expect([twice.ok, twice.code]).toEqual([false, "NOT_FOUND"]);
    // Join again: a NEW envelope, the same figures.
    const again = commit.closeStaleLot(lotId, saleId, DAY);
    expect(again.ok, again.message).toBe(true);
    expect(envelopeIds().length).toBe(envBefore.length);
    expect([rowById(lotId)!.isOpen, rowById(saleId)]).toEqual([false, null]);
  });

  const C = 323;
  it("the re-pull of the sale is a duplicate while joined (the alias) AND after the un-join (the row's own hash) — never a second row", () => {
    const { lotId } = joinedPair(C, "fix-a j3 repull");
    expect(pull(C, parsed([sell(SYM, QTY, 140, DAY)]), `fyers-api-${DAY}`)).toBe("nothingNew");
    expect(commit.unJoinStaleClose(lotId).ok).toBe(true);
    expect(pull(C, parsed([sell(SYM, QTY, 140, DAY)]), `fyers-api-${DAY}`)).toBe("nothingNew");
    expect(rowsOf(C)).toHaveLength(2);
  });

  const D = 324;
  it("a PARTLY sold lot (P-G: bought 100, sold 40 on 09-12) joined with a stored sale of 60 comes back with its 09-12 exit and 130 average", () => {
    newAccount(D, "fix-a j3 partly sold");
    const lotId = t.db
      .insert(t.schema.trades)
      .values(tradeRow({ accountId: D, broker: "fyers", symbol: "PARTLY", tradingsymbol: "PARTLY", buyQty: 100, avgBuyPrice: 100, buyValue: 10000, buyDate: "2026-09-10", buyOrderCount: 1, sellQty: 40, avgSellPrice: 130, sellValue: 5200, sellDate: "2026-09-12", sellOrderCount: 1, grossPnl: 1200, chargesTotal: 10, netPnl: 1190, isOpen: true, side: "long" }))
      .returning({ id: t.schema.trades.id })
      .get()!.id;
    importFile(D, parsed([sell("PARTLY", 60, 140, DAY)]), "sale-60.csv", false);
    const saleId = rowsOf(D).find((r) => r.id !== lotId)!.id;
    const before = rowById(lotId)!;
    select(D);
    const pair = dq.getStaleOpenSection().pairs.find((p) => p.lotId === lotId)!;
    expect(pair.oneClick).toBe(true);
    expect(commit.closeStaleLot(lotId, saleId, DAY).ok).toBe(true);
    const joined = rowById(lotId)!;
    expect([joined.sellQty, joined.sellDate, joined.sellOrderCount]).toEqual([100, DAY, 2]);
    expect(r2(joined.avgSellPrice)).toBe(136);
    const res = commit.unJoinStaleClose(lotId);
    expect(res.ok, res.message).toBe(true);
    // THE assertion (P-G): only the audit `before` held 09-12 and 130 — and they are back.
    expect(shapeOf(rowById(lotId)!)).toEqual(shapeOf(before));
    expect([rowById(lotId)!.sellDate, rowById(lotId)!.avgSellPrice, rowById(lotId)!.sellOrderCount]).toEqual(["2026-09-12", 130, 1]);
  });

  const E = 325;
  it("a MONTH-level pair (ticked) → un-join → listed again as month-only, one-click, both names", () => {
    newAccount(E, "fix-a j3 month-only");
    importFile(E, parsed([buy(OA_M, QTY, 120, "2026-09-14")], "openalgo-api"), "openalgo-fyers-2026-09-14");
    importFile(E, parsed([sell(NAT_M, QTY, 140, DAY)]), "sale.csv", false);
    select(E);
    const p = dq.getStaleOpenSection().pairs[0]!;
    expect([p.monthOnly, p.oneClick]).toEqual([true, true]);
    expect(commit.closeStaleLot(p.lotId, p.saleId, DAY, { monthOnlyAcknowledged: true }).ok).toBe(true);
    expect(rowsOf(E)).toHaveLength(1);
    expect(commit.unJoinStaleClose(p.lotId).ok).toBe(true);
    expect(rowsOf(E).map((r) => [r.tradingsymbol, r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[OA_M, QTY, 0, true], [NAT_M, 0, QTY, true]].sort());
    expect(dq.getStaleOpenSection().pairs.map((q) => [q.tradingsymbol, q.saleTradingsymbol, q.monthOnly, q.oneClick])).toEqual([[OA_M, NAT_M, true, true]]);
  });
});

describe("the refusals — each with its reason, each writing nothing", () => {
  const F = 326;
  it("the envelope purged from Deleted items → ENVELOPE_GONE, the stated sentence, the book unchanged", () => {
    const { lotId, sale } = joinedPair(F, "fix-a j3 purged");
    const id = envelopeIds().find((e) => trash.readTrashEnvelope(e)!.trades.some((r) => r.dedupHash === sale.dedupHash))!;
    expect(trash.purgeTrashSnapshot(id).ok).toBe(true);
    const before = JSON.stringify(rowsOf(F));
    const res = commit.unJoinStaleClose(lotId);
    expect([res.ok, res.code]).toEqual([false, "ENVELOPE_GONE"]);
    expect(res.message).toBe("The sale this join removed is no longer in Deleted items, so the join cannot be undone here. Nothing was changed.");
    expect(JSON.stringify(rowsOf(F))).toBe(before);
  });

  const G = 327;
  it("scope: another account's view → OTHER_ACCOUNT; the All-accounts view (0) acts on the lot's own account (invariants 8, 9)", () => {
    const { lotId, saleId } = joinedPair(G, "fix-a j3 scope");
    newAccount(G + 50, "fix-a j3 other view");
    const other = commit.unJoinStaleClose(lotId);
    expect([other.ok, other.code]).toEqual([false, "OTHER_ACCOUNT"]);
    expect(rowById(lotId)!.isOpen).toBe(false);
    select(0);
    const res = commit.unJoinStaleClose(lotId);
    expect(res.ok, res.message).toBe(true);
    expect(rowById(saleId)!.accountId).toBe(G);
  });

  const H = 328;
  it("after a merge moved the lot to another account, the sale lands in the LOT's current account — not the envelope's (P-F's ACCOUNT_GONE)", () => {
    const { lotId, saleId } = joinedPair(H, "fix-a j3 merged source");
    const target = H + 50;
    t.db.insert(t.schema.accounts).values({ id: target, name: "fix-a j3 merge target" }).run();
    // What a merge does to the row (lib/queries/account-delete.ts): it is re-homed and the source book goes.
    t.db.update(t.schema.trades).set({ accountId: target }).where(eq(t.schema.trades.id, lotId)).run();
    t.db.delete(t.schema.accounts).where(eq(t.schema.accounts.id, H)).run();
    select(target);
    const res = commit.unJoinStaleClose(lotId);
    expect(res.ok, res.message).toBe(true);
    expect(rowById(saleId)!.accountId, "the anchor is the lot's account").toBe(target);
    expect(rowsOf(target).map((r) => [r.buyQty, r.sellQty, r.isOpen]).sort()).toEqual([[QTY, 0, true], [0, QTY, true]].sort());
  });

  const I = 329;
  it("the lot deleted, or a plain row → NOT_FOUND; the editor's re-made close (sentence dropped) → NOT_FOUND", () => {
    const { lotId, saleId: _s } = joinedPair(I, "fix-a j3 not found");
    expect(commit.unJoinStaleClose(999999).code).toBe("NOT_FOUND");
    expect(commit.unJoinStaleClose(0).code).toBe("NOT_FOUND");
    // The editor re-makes the close: H1 drops the sentence (and the bill), keeps the alias — no longer the join's.
    const lot = rowById(lotId)!;
    const edited = commit.updateManualTrade(lotId, { avgSellPrice: 141, sellQty: lot.sellQty, sellDate: DAY });
    expect(edited.ok, edited.message).toBe(true);
    expect(rowById(lotId)!.importNotes).not.toContain(STALE_CLOSE_NOTE);
    expect(rowById(lotId)!.importNotes, "the join's bill goes with its sentence").not.toContain(EXEC_BILL_PREFIX);
    expect(closedByStaleJoin(rowById(lotId)!)).toBe(false);
    const res = commit.unJoinStaleClose(lotId);
    expect([res.ok, res.code]).toEqual([false, "NOT_FOUND"]);
  });
});

describe("joins made BEFORE this fix (no exec-bill:, a seven-field audit `before`)", () => {
  /** Re-shape a fresh join to what ≤ 60c809b wrote: strip the bill, shrink the audit `before`. */
  function legacify(lotId: number, before: NonNullable<ReturnType<typeof rowById>>) {
    const lot = rowById(lotId)!;
    const notes = lot.importNotes!.split("|").map((s) => s.trim()).filter((s) => !s.startsWith(EXEC_BILL_PREFIX)).join(" | ");
    t.db.update(t.schema.trades).set({ importNotes: notes }).where(eq(t.schema.trades.id, lotId)).run();
    const seven = { isOpen: true, buyQty: before.buyQty, sellQty: before.sellQty, sellDate: before.sellDate, chargesTotal: before.chargesTotal, netPnl: before.netPnl, importNotes: before.importNotes };
    const audit = t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "trade" && a.entityId === lotId && a.action === "close").at(-1)!;
    t.db.update(t.schema.auditLog).set({ beforeJson: seven, afterJson: null }).where(eq(t.schema.auditLog.id, audit.id)).run();
  }

  const J = 331;
  it("a sale that STATED its charges: the closing leg, counts, total and net are derived exactly; no re-pricing is said", () => {
    newAccount(J, "fix-a j3 legacy stated");
    importFile(J, parsed([buy(SYM, QTY, 120, "2026-09-10")]), "lot.csv");
    importFile(J, parsed([sell(SYM, QTY, 140, DAY, { reportedCharges: { total: 44.01, brokerage: 20, sttCtt: 11, exchangeTxn: 5.5, sebi: 0.01, stampDuty: 0, ipft: 0, gst: 4.59, dpCharges: 2.91 } as never })]), "sale-75.csv", false);
    const [lot, sale] = rowsOf(J);
    expect(sale!.chargesTotal, "the fixture's sale states a bill").toBe(44.01);
    const before = rowById(lot!.id)!;
    expect(commit.closeStaleLot(lot!.id, sale!.id, DAY).ok).toBe(true);
    legacify(lot!.id, before);
    expect(execBillFromNotes(rowById(lot!.id)!.importNotes)).toBeNull();
    const res = commit.unJoinStaleClose(lot!.id);
    expect(res.ok, res.message).toBe(true);
    expect(res.message).not.toContain("re-priced");
    const back = rowById(lot!.id)!;
    expect([back.isOpen, back.sellQty, back.sellValue, back.avgSellPrice, back.sellDate, back.sellOrderCount]).toEqual([true, 0, 0, 0, null, 0]);
    expect([back.chargesTotal, back.netPnl, back.grossPnl, back.realisedPct]).toEqual([before.chargesTotal, before.netPnl, before.grossPnl, null]);
    expect(back.importNotes).toBe(before.importNotes);
    expect(lotIdentityHashes(back)).toEqual([back.dedupHash]);
    expect(shapeOf(rowById(sale!.id)!)).toEqual(shapeOf(sale!));
  });

  const K = 332;
  it("a sale whose half was PRICED at join time is re-priced from today's card and the message SAYS so; an eq_mtf lot and a partly covered short REFUSE with the reason", () => {
    newAccount(K, "fix-a j3 legacy priced");
    importFile(K, parsed([buy(SYM, QTY, 120, "2026-09-10")]), "lot.csv");
    importFile(K, parsed([sell(SYM, QTY, 140, DAY)]), "sale-75.csv", false);
    const [lot, sale] = rowsOf(K);
    // A sale row storing NO bill (a hand-entered row, a file that stated none):
    // `statedOrPricedCharges` then prices its half from the card at join time.
    t.db.update(t.schema.trades).set({ chargesTotal: 0, netPnl: 0, brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, dpCharges: 0 }).where(eq(t.schema.trades.id, sale!.id)).run();
    const lotId = lot!.id;
    const before = rowById(lotId)!;
    expect(commit.closeStaleLot(lotId, sale!.id, DAY).ok).toBe(true);
    expect(execBillFromNotes(rowById(lotId)!.importNotes)!.total, "the priced half travels on the lot").toBeGreaterThan(0);
    legacify(lotId, before);
    const res = commit.unJoinStaleClose(lotId);
    expect(res.ok, res.message).toBe(true);
    expect(res.message).toContain("re-priced from today's rate card");
    const back = rowById(lotId)!;
    expect([back.isOpen, back.sellQty, back.chargesTotal, back.netPnl]).toEqual([true, 0, before.chargesTotal, before.netPnl]);

    // eq_mtf: interest, pledge and GST were REPLACED by the join — not derivable.
    const M = K + 50;
    const mtf = joinedPair(M, "fix-a j3 legacy mtf");
    legacify(mtf.lotId, mtf.before);
    t.db.update(t.schema.trades).set({ segment: "eq_mtf" }).where(eq(t.schema.trades.id, mtf.lotId)).run();
    const snapshot = JSON.stringify(rowsOf(M));
    const refused = commit.unJoinStaleClose(mtf.lotId);
    expect([refused.ok, refused.code]).toEqual([false, "SHAPE"]);
    expect(refused.message).toContain("MTF position joined before this update");
    expect(JSON.stringify(rowsOf(M))).toBe(snapshot);
  });

  const L = 333;
  it("the audit row gone → refused (the earlier state cannot be restored); nothing is invented", () => {
    const { lotId, before } = joinedPair(L, "fix-a j3 no audit");
    legacify(lotId, before);
    const audits = t.db.select().from(t.schema.auditLog).all().filter((a) => a.entity === "trade" && a.entityId === lotId);
    for (const a of audits) t.db.delete(t.schema.auditLog).where(eq(t.schema.auditLog.id, a.id)).run();
    const res = commit.unJoinStaleClose(lotId);
    expect([res.ok, res.code]).toEqual([false, "SHAPE"]);
    expect(res.message).toContain("not in the audit trail");
    expect(rowById(lotId)!.isOpen).toBe(false);
  });
});

describe("the route — POST /api/data-quality/unjoin-stale", () => {
  const N = 341;
  it("maps the answer to HTTP: 400 for no lot, 404 NOT_FOUND, 200 on success with the server's own sentence", async () => {
    const { lotId, saleId } = joinedPair(N, "fix-a j3 route");
    const bad = await route.POST(jsonReq({}));
    expect(bad.status).toBe(400);
    const missing = await route.POST(jsonReq({ lotId: 987654 }));
    expect([missing.status, ((await missing.json()) as { code: string }).code]).toEqual([404, "NOT_FOUND"]);
    const ok = await route.POST(jsonReq({ lotId }));
    const body = (await ok.json()) as { ok: boolean; message: string; saleId: number };
    expect([ok.status, body.ok, body.saleId]).toEqual([200, true, saleId]);
    expect(body.message).toContain("Undone.");
    const gone = await route.POST(jsonReq({ lotId }));
    expect(gone.status).toBe(404);
  });

  it("the executionHashOfPiece of a joined lot is its OWN hash (no Un-close family), and the un-join label is one constant", () => {
    const row = rowById(rowsOf(N)[0]!.id)!;
    expect(executionHashOfPiece(row)).toBe(row.dedupHash);
    expect(UNJOIN_MENU_LABEL).toBe("Undo Data Quality join");
  });
});
