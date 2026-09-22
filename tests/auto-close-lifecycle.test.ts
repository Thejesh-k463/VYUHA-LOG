import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";
import {
  CLOSED_BY_PREFIX,
  DEDUP_ALIAS_PREFIX,
  EXEC_BILL_PREFIX,
  executionHashOfPiece,
  isAutoClosePiece,
} from "@/lib/import/close-open-lots";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";

/**
 * v4.5.0 W3 — THE LIFECYCLE of an import auto-close: un-close, the delete and
 * merge refusals that point at it, and the summary each half reports.
 *
 * W2a built the applier (tests/auto-close-applier.test.ts). It can turn one
 * execution and the lots it consumed into a new set of rows; until W3 nothing
 * could turn them back, and every other door in the journal — a row delete, an
 * import-batch delete, an account merge — would happily remove ONE piece of
 * that set and leave the rest describing a close that no longer exists. This
 * file pins the door that undoes a close exactly, and the three refusals that
 * send the user through it.
 *
 * WHAT IS PINNED, AND WHERE EACH RULE COMES FROM
 *   · rev 10      — un-close is the EXACT inverse, per shape: a partial (a
 *                   reduced lot + a slice), a whole consumption (the lot row
 *                   itself converted) and a remainder (what the execution had
 *                   left over). The lot comes back byte-identical and the
 *                   execution comes back as ONE row, the way the file stated it.
 *   · rev 10      — the execution's own half of a merged bill is recorded on the
 *                   piece (`exec-bill:`) because the merge of two bills is not
 *                   invertible from the ten columns: two unknowns, one equation.
 *                   A piece that does not state it is REFUSED, never guessed at.
 *   · rev 9 / A3  — a row delete of ONE piece is refused by name and offers
 *                   "Un-close"; the COMPLETE family may go, and comes back whole.
 *   · R75 / A3    — an import-batch delete whose cascade would leave a piece
 *                   behind is refused in the same sentence, and the batch stays.
 *   · rev 11      — a merge that would move one piece of a close is refused.
 *   · W2a-F1      — the preview summary and the commit's `netPnl` report what the
 *                   BOOK moved: a same-file B+S charged the buy's bill twice.
 *   · inv 1/5/8/9 — money in rupees at runtime, the parent holds the aggregate,
 *                   every write inside its own book, and never account 0.
 *
 * ONE temp database per FILE (AGENTS.md Testing): `lib/db` caches its connection
 * on globalThis, so every case below owns its own account id and they run one
 * after another on the one database. Measured locally 2026-09-22: the hook
 * ~1.2 s, every `it` well under 300 ms; the raised timeouts are for the Windows
 * runner, > 15x slower on SQLite-file work.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

let t: TempDb;
let commit: typeof import("@/lib/import/commit");
let del: typeof import("@/lib/queries/delete");
let trash: typeof import("@/lib/trash");
let acct: typeof import("@/lib/queries/account-delete");
let unCloseRoute: typeof import("@/app/api/trades/un-close/route");
let oracle: typeof import("./helpers/oracle-book");

const r2 = (n: number) => Math.round(n * 100) / 100;
const AC = { autoClose: true } as const;

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

const buyRow = (symbol: string, qty: number, price: number, date: string | null, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, buyQty: qty, avgBuyPrice: price, buyValue: r2(qty * price), buyDate: date, ...over });

const sellRow = (symbol: string, qty: number, price: number, date: string | null, over: Partial<NormalizedTrade> = {}) =>
  trade({ tradingsymbol: symbol, sellQty: qty, avgSellPrice: price, sellValue: r2(qty * price), sellDate: date, ...over });

const parsed = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-gtr",
  broker: "dhan",
  format: "tradebook",
  trades,
  warnings: [],
});

const newAccount = (id: number, name: string) => t.db.insert(t.schema.accounts).values({ id, name }).run();
const select = (id: number) => t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();

const rowsOf = (accountId: number) =>
  t.db
    .select()
    .from(t.schema.trades)
    .where(eq(t.schema.trades.accountId, accountId))
    .all()
    .sort((a, b) => a.id - b.id);

type Row = ReturnType<typeof rowsOf>[number];

/**
 * The columns of two snapshots of one row that differ.
 *
 * `updatedAt` is excluded and asserted separately: an un-close IS a write, and
 * the row must say when it was written. Everything else must come back.
 */
function diffCols(a: Row, b: Row, skip: readonly string[] = ["updatedAt"]): string[] {
  return Object.keys(a).filter(
    (k) => !skip.includes(k) && JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]),
  );
}

/** Every numeric column of every row is a real number (never NaN). */
function expectNoNaN(rows: Row[]) {
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === "number") expect(Number.isFinite(v), `${k} on row ${row.id}`).toBe(true);
    }
  }
}

/**
 * The execution hash a piece answers for — the product's own rule, so a test
 * never reads a row the way no door does.
 */
const execHashOf = (row: Row) => executionHashOfPiece(row);

/** Un-close through the query, from the book the rows are in (invariant 8). */
function unClose(accountId: number, hash: string) {
  select(accountId);
  return commit.unCloseExecution(accountId, "dhan", hash);
}

/**
 * Close the same execution AGAIN through the import door.
 *
 * A straight re-import cannot do it: the reinstated row carries the execution's
 * own identity, so the file is a duplicate — which is the point of reinstating
 * it under that hash. The user's path back is to remove that ordinary sale and
 * re-import, which is what this does.
 */
function reClose(accountId: number, hash: string, file: ParsedFile, name: string) {
  select(accountId);
  const sale = rowsOf(accountId).find((r) => r.dedupHash === hash)!;
  const gone = del.deleteTradesByIds([sale.id], "W3 test re-close");
  expect(gone.ok, gone.message).toBe(true);
  return commit.commitParsedFile(file, name, null, accountId, AC);
}

const auditsSince = (marker: number) =>
  t.db
    .select()
    .from(t.schema.auditLog)
    .all()
    .filter((a) => a.id > marker && a.entity === "trade")
    .sort((a, b) => a.id - b.id);

const lastAuditId = () => t.db.select().from(t.schema.auditLog).all().reduce((m, a) => Math.max(m, a.id), 0);

beforeAll(async () => {
  t = await openTempDb("auto-close-lifecycle", { seed: true });
  commit = await import("@/lib/import/commit");
  del = await import("@/lib/queries/delete");
  trash = await import("@/lib/trash");
  acct = await import("@/lib/queries/account-delete");
  unCloseRoute = await import("@/app/api/trades/un-close/route");
  oracle = await import("./helpers/oracle-book");
  await oracle.loadOracleConsumers();
}, 120_000);
afterAll(() => t?.cleanup());

// ═══ 1 · un-close a PARTIAL close: the lot returns byte-identical ════════════

describe("1 · un-close · PARTIAL — a reduced lot and the slice beside it", () => {
  const ACC = 9001;
  const REF = 9021; // the same two files with nothing to close
  let lotBefore: Row;
  let sliceId: number;
  let hash: string;

  it("the close reduces the lot to 60 and writes the slice", () => {
    newAccount(ACC, "uc-partial");
    newAccount(REF, "uc-partial-ref");
    commit.commitParsedFile(parsed([buyRow("SBIN", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    lotBefore = { ...rowsOf(ACC)[0] };

    const res = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect(res.autoClose).toMatchObject({ reduced: 1, closedWhole: 0 });
    const [lot, slice] = rowsOf(ACC);
    sliceId = slice.id;
    hash = execHashOf(lot);
    expect(hash, "the reduced lot names the execution that took part of it").toBe(slice.dedupHash);
    expect(slice.importNotes, "the slice records the execution's OWN half of the merged bill").toContain(EXEC_BILL_PREFIX);
  });

  it("the lot comes back byte-identical on EVERY column, and the slice is gone", () => {
    const res = unClose(ACC, hash);
    expect(res.ok, res.message).toBe(true);
    const lot = rowsOf(ACC).find((r) => r.id === lotBefore.id)!;
    expect(
      diffCols(lot, lotBefore),
      "the inverse of a close is the state before it — a re-derived bill would be a rounded guess about money that really moved",
    ).toEqual([]);
    expect(lot.updatedAt, "an un-close is a write and the row says so").toBeTruthy();
    expect(rowsOf(ACC).some((r) => r.id === sliceId), "the closed slice is removed, not re-opened").toBe(false);
  });

  it("the sale is reinstated as ONE ordinary row carrying the execution's own hash", () => {
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    const sale = rows.find((r) => r.id !== lotBefore.id)!;
    expect(sale).toMatchObject({
      dedupHash: hash,
      sellQty: 40,
      buyQty: 0,
      avgSellPrice: 120,
      sellValue: 4800,
      sellDate: "2026-05-01",
      buyDate: null,
      isOpen: true,
      grossPnl: 0,
      staged: false,
      importNotes: null,
    });
    expect(sale.netPnl, "an open sale's net is what it was charged").toBe(r2(0 - sale.chargesTotal));

    // The bill it comes back with is the bill the FILE stated for it — proved
    // against the same file imported into a book with nothing to close.
    commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sell.csv", null, REF);
    const ref = rowsOf(REF)[0];
    expect(sale.chargesTotal, "the execution's own half, to the paisa").toBe(ref.chargesTotal);
    expect(r2(sale.chargesTotal + rowsOf(ACC).find((r) => r.id === lotBefore.id)!.chargesTotal), "and the two halves add back up")
      .toBe(r2(ref.chargesTotal + lotBefore.chargesTotal));
    expectNoNaN(rows);
  });

  it("re-importing the sale file is a duplicate — the reinstated row answers for it", () => {
    const again = commit.commitParsedFile(parsed([sellRow("SBIN", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped], "the execution came back under its OWN identity, not a re-derived one").toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });
});

// ═══ 2 · un-close a WHOLE consumption: the converted lot reads open again ════

describe("2 · un-close · WHOLE — the lot row itself was the closed row", () => {
  const ACC = 9002;
  let lotBefore: Row;
  let hash: string;

  it("the close converts the lot in place and the un-close gives it back", () => {
    newAccount(ACC, "uc-whole");
    commit.commitParsedFile(parsed([buyRow("ITC", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    lotBefore = { ...rowsOf(ACC)[0] };
    const res = commit.commitParsedFile(parsed([sellRow("ITC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([res.added, res.autoClose?.closedWhole]).toEqual([0, 1]);
    const converted = rowsOf(ACC)[0];
    expect(rowsOf(ACC), "no slice was invented").toHaveLength(1);
    hash = converted.importNotes!.split("|").map((s) => s.trim()).find((s) => s.startsWith(DEDUP_ALIAS_PREFIX))!.slice(DEDUP_ALIAS_PREFIX.length);

    const out = unClose(ACC, hash);
    expect(out.ok, out.message).toBe(true);
  });

  it("the lot is open again with its OWN bill, its alias and every W3 note stripped", () => {
    const lot = rowsOf(ACC).find((r) => r.id === lotBefore.id)!;
    expect(lot).toMatchObject({
      isOpen: true,
      buyQty: 100,
      buyValue: 10000,
      avgBuyPrice: 100,
      buyDate: "2026-04-01",
      sellQty: 0,
      sellValue: 0,
      avgSellPrice: 0,
      sellDate: null,
      grossPnl: 0,
      chargesTotal: lotBefore.chargesTotal,
      netPnl: lotBefore.netPnl,
      importNotes: null,
    });
    expect(lot.importNotes ?? "", "no alias, no closed-by, no exec-bill").not.toContain(DEDUP_ALIAS_PREFIX);
    expect(isAutoClosePiece(lot), "it is no longer a piece of anything").toBe(false);
    expect(diffCols(lot, lotBefore)).toEqual([]);
  });

  it("the sale is reinstated as one row, and no slice was invented", () => {
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    const sale = rows.find((r) => r.dedupHash === hash)!;
    expect(sale).toMatchObject({ sellQty: 100, buyQty: 0, sellValue: 12000, sellDate: "2026-05-01", isOpen: true });
    expectNoNaN(rows);
    const again = commit.commitParsedFile(parsed([sellRow("ITC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
  });
});

// ═══ 3 · un-close a REMAINDER shape: the execution returns as ONE row ════════

describe("3 · un-close · REMAINDER — a sale bigger than the lot it closed", () => {
  const ACC = 9003;
  const REF = 9023;
  let lotBefore: Row;
  let hash: string;

  it("the file states one sale of 100; 60 closed the lot and 40 was left over", () => {
    newAccount(ACC, "uc-remainder");
    newAccount(REF, "uc-remainder-ref");
    commit.commitParsedFile(parsed([buyRow("LT", 60, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    lotBefore = { ...rowsOf(ACC)[0] };
    const res = commit.commitParsedFile(parsed([sellRow("LT", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect(res.autoClose).toMatchObject({ closedWhole: 1, openedNew: 1 });
    const rows = rowsOf(ACC);
    expect(rows).toHaveLength(2);
    const leftover = rows.find((r) => r.isOpen)!;
    expect(leftover.importNotes, "the leftover carries the thread back to the execution").toContain(CLOSED_BY_PREFIX);
    hash = execHashOf(leftover);

    const out = unClose(ACC, hash);
    expect(out.ok, out.message).toBe(true);
  });

  it("the execution comes back as ONE row of 100 — the way the file stated it", () => {
    const rows = rowsOf(ACC);
    expect(rows, "the lot, and the sale — not the lot, the sale and its leftover").toHaveLength(2);
    const sale = rows.find((r) => r.id !== lotBefore.id)!;
    expect(sale).toMatchObject({
      dedupHash: hash,
      sellQty: 100,
      sellValue: 12000,
      avgSellPrice: 120,
      sellDate: "2026-05-01",
      buyQty: 0,
      isOpen: true,
    });
    expect(diffCols(rows.find((r) => r.id === lotBefore.id)!, lotBefore)).toEqual([]);

    // The whole bill the file stated for that sale, in one place.
    commit.commitParsedFile(parsed([sellRow("LT", 100, 120, "2026-05-01")]), "sell.csv", null, REF);
    expect(sale.chargesTotal, "both halves of a split bill, added back up").toBe(rowsOf(REF)[0].chargesTotal);
    expectNoNaN(rows);
  });

  it("re-importing that sale is a duplicate", () => {
    const again = commit.commitParsedFile(parsed([sellRow("LT", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped]).toEqual([0, 1]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });
});

// ═══ 4 · the audit trail, and ONE transaction ════════════════════════════════

describe("4 · one audit row per row touched, and nothing half-undone", () => {
  const ACC = 9004;
  let hash: string;
  let lotId: number;
  let sliceId: number;

  it("update + delete + create, each with the snapshots its action states", () => {
    newAccount(ACC, "uc-audit");
    commit.commitParsedFile(parsed([buyRow("INFY", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("INFY", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const [lot, slice] = rowsOf(ACC);
    lotId = lot.id;
    sliceId = slice.id;
    hash = execHashOf(lot);

    const marker = lastAuditId();
    expect(unClose(ACC, hash).ok).toBe(true);
    const audits = auditsSince(marker);

    // One row per row touched: the lot updated, the slice deleted, the
    // execution created. `recordAudit` itself throws on an asymmetric pair
    // (AuditShapeError), so the shape of each is asserted by the call landing.
    expect(audits.map((a) => [a.entityId, a.action])).toEqual([
      [lotId, "update"],
      [sliceId, "delete"],
      [rowsOf(ACC).find((r) => r.dedupHash === hash)!.id, "create"],
    ]);
    const [upd, gone, made] = audits;
    expect(Object.keys(upd.beforeJson ?? {}).sort(), "an update states the same columns both sides")
      .toEqual(Object.keys(upd.afterJson ?? {}).sort());
    expect(upd.beforeJson).toMatchObject({ buyQty: 60 });
    expect(upd.afterJson).toMatchObject({ buyQty: 100 });
    expect([gone.beforeJson != null, gone.afterJson], "a delete states what went and claims no after").toEqual([true, null]);
    expect([made.beforeJson, made.afterJson != null], "a create states what arrived and claims no before").toEqual([null, true]);
    expect(made.summary).toContain("reinstated as its own row");
  });

  it("a failure part-way leaves the book exactly as it was — one transaction", () => {
    // A whole consumption in a book of its own, then a row planted on the
    // execution's hash so the reinstating INSERT fails on the (account, broker,
    // dedup_hash) unique index. The lot patch runs FIRST, so a per-statement
    // un-close would leave the position open with its sale nowhere in the book:
    // 100 shares of realised P&L gone, silently.
    const ACC2 = 9044;
    newAccount(ACC2, "uc-atomic");
    commit.commitParsedFile(parsed([buyRow("VEDL", 100, 100, "2026-04-01")]), "buy.csv", null, ACC2, AC);
    commit.commitParsedFile(parsed([sellRow("VEDL", 100, 120, "2026-05-01")]), "sell.csv", null, ACC2, AC);
    const converted = rowsOf(ACC2)[0];
    const h2 = execHashOf(converted);
    expect([rowsOf(ACC2).length, converted.isOpen, h2 === converted.dedupHash]).toEqual([1, false, false]);

    t.db.insert(t.schema.trades).values(tradeRow({ accountId: ACC2, broker: "dhan", dedupHash: h2, tradingsymbol: "DECOY" }) as never).run();
    const before = rowsOf(ACC2);
    const marker = lastAuditId();
    select(ACC2);
    expect(() => commit.unCloseExecution(ACC2, "dhan", h2)).toThrow(/UNIQUE/);
    expect(rowsOf(ACC2), "not one column moved — the lot is still closed").toEqual(before);
    expect(auditsSince(marker), "and the audit rows rolled back with it").toEqual([]);
  });
});

// ═══ 5 · the refusals: SHAPE, NOT_FOUND, and idempotence ════════════════════

describe("5 · un-close refuses by code, and never twice", () => {
  const ACC = 9005;

  it("a piece that does not record the execution's own bill is refused SHAPE", () => {
    newAccount(ACC, "uc-refuse");
    commit.commitParsedFile(parsed([buyRow("WIPRO", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("WIPRO", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const [lot, slice] = rowsOf(ACC);
    const hash = execHashOf(lot);

    // A row stored by a version that did not record it (or a hand edit): the
    // two halves of its bill cannot be told apart, so the close is not undone.
    const stripped = slice.importNotes!.split("|").map((s) => s.trim()).filter((s) => !s.startsWith(EXEC_BILL_PREFIX)).join(" | ");
    t.db.update(t.schema.trades).set({ importNotes: stripped }).where(eq(t.schema.trades.id, slice.id)).run();

    const before = rowsOf(ACC);
    const res = unClose(ACC, hash);
    expect([res.ok, res.code]).toEqual([false, "SHAPE"]);
    expect(res.message).toContain("does not record what the closing execution itself was charged");
    expect(rowsOf(ACC), "a refusal writes nothing").toEqual(before);

    t.db.update(t.schema.trades).set({ importNotes: slice.importNotes }).where(eq(t.schema.trades.id, slice.id)).run();
  });

  it("a hash nothing in the book was closed by is NOT_FOUND", () => {
    const res = unClose(ACC, "f".repeat(40));
    expect([res.ok, res.code]).toEqual([false, "NOT_FOUND"]);
    expect(rowsOf(ACC)).toHaveLength(2);
  });

  it("a second un-close of the same execution is NOT_FOUND — it is not repeatable", () => {
    const hash = execHashOf(rowsOf(ACC)[0]);
    expect(unClose(ACC, hash).ok).toBe(true);
    const after = rowsOf(ACC);
    const again = unClose(ACC, hash);
    expect([again.ok, again.code]).toEqual([false, "NOT_FOUND"]);
    expect(rowsOf(ACC), "the second call changed nothing").toEqual(after);
  });
});

// ═══ 6 · the delete refusals (rev 9 / R75 / A3) ═════════════════════════════

describe("6 · a piece is never deleted alone; the family may go, and comes back", () => {
  const ACC = 9006;
  let lot: Row;
  let slice: Row;

  it("deleting ONE piece is refused, naming the execution and offering Un-close", () => {
    newAccount(ACC, "uc-delete");
    commit.commitParsedFile(parsed([buyRow("TCS", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("TCS", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    [lot, slice] = rowsOf(ACC);
    select(ACC);

    for (const [row, other] of [[slice, lot], [lot, slice]] as const) {
      const before = rowsOf(ACC);
      const res = del.deleteTradesByIds([row.id], "W3 test");
      expect([res.ok, res.deleted, res.snapshotId], res.message).toEqual([false, 0, null]);
      expect(res.message).toContain(`trade #${other.id}`);
      expect(res.message).toContain("closed automatically");
      expect(res.message, "the refusal offers the door that CAN undo it (A3)").toContain("Un-close");
      expect(res.message).toContain(execHashOf(lot).slice(0, 12));
      expect(rowsOf(ACC), "nothing was written, not even a snapshot").toEqual(before);
    }
  });

  it("the COMPLETE family goes together, and the Trash restore brings back every piece", () => {
    const before = rowsOf(ACC);
    const res = del.deleteTradesByIds([lot.id, slice.id], "W3 test family");
    expect([res.ok, res.deleted], res.message).toEqual([true, 2]);
    expect(rowsOf(ACC)).toEqual([]);

    const back = trash.restoreTrashSnapshot(res.snapshotId!, "test");
    expect([back.ok, back.restored], back.message).toEqual([true, 2]);
    expect(
      back.skipped,
      "neither piece may be swallowed by the restore's 'recorded in the position it closed' skip",
    ).toEqual([]);
    expect(rowsOf(ACC), "the set comes back whole, byte for byte").toEqual(before);
  });
});

// ═══ 7 · an import-batch delete whose cascade would leave a piece (R75) ══════

describe("7 · deleting the SELL import would strip the close off the BUY import", () => {
  const ACC = 9007;
  let sellBatch: number;

  it("the batch delete is refused in the same sentence, and the batch stays", () => {
    newAccount(ACC, "uc-batch");
    const batch = (fileName: string) =>
      t.db.insert(t.schema.importBatches).values({ accountId: ACC, broker: "dhan", fileName }).returning({ id: t.schema.importBatches.id }).get()!.id;
    const buyBatch = batch("buy.csv");
    sellBatch = batch("sell.csv");
    commit.commitParsedFile(parsed([buyRow("HDFCBANK", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    expect(rowsOf(ACC)).toHaveLength(1);
    commit.commitParsedFile(parsed([sellRow("HDFCBANK", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const [lot, slice] = rowsOf(ACC);
    t.db.update(t.schema.trades).set({ importBatchId: buyBatch }).where(eq(t.schema.trades.id, lot.id)).run();
    t.db.update(t.schema.trades).set({ importBatchId: sellBatch }).where(eq(t.schema.trades.id, slice.id)).run();

    select(ACC);
    const before = rowsOf(ACC);
    const res = del.deleteImportBatch(sellBatch, true, "test");
    expect([res.ok, res.batchRemoved, res.deleted], res.message).toEqual([false, false, 0]);
    expect(res.message).toContain("Un-close");
    expect(res.message).toContain(`trade #${lot.id}`);
    expect(rowsOf(ACC), "R75 — the SELL import's slice carries money the BUY import opened").toEqual(before);
    expect(t.db.select().from(t.schema.importBatches).where(eq(t.schema.importBatches.id, sellBatch)).all(), "the import record stays with its trades")
      .toHaveLength(1);
  });

  it("after an un-close the same batch delete goes through", () => {
    const hash = execHashOf(rowsOf(ACC).find((r) => isAutoClosePiece(r))!);
    expect(unClose(ACC, hash).ok).toBe(true);
    // The reinstated sale carries the remainder's provenance or none at all, so
    // re-file it under the batch the user is deleting, as the import did.
    const sale = rowsOf(ACC).find((r) => r.dedupHash === hash)!;
    t.db.update(t.schema.trades).set({ importBatchId: sellBatch }).where(eq(t.schema.trades.id, sale.id)).run();
    const res = del.deleteImportBatch(sellBatch, true, "test");
    expect([res.ok, res.batchRemoved, res.deleted], res.message).toEqual([true, true, 1]);
    expect(rowsOf(ACC).map((r) => [r.buyQty, r.isOpen]), "the position is whole and open again").toEqual([[100, true]]);
  });
});

// ═══ 8 · the merge refusal (revision 11) ════════════════════════════════════

describe("8 · a merge never moves one piece of a close", () => {
  const A = 9008; // target: holds the same buy, still open
  const B = 9009; // source: holds the reduced lot and the slice

  it("refused before any write, naming the execution and offering Un-close", () => {
    newAccount(A, "merge-target-w3");
    newAccount(B, "merge-source-w3");
    const buyFile = () => parsed([buyRow("BEL", 100, 100, "2026-04-01")]);
    expect(commit.commitParsedFile(buyFile(), "b.csv", null, A, AC).added).toBe(1);
    expect(commit.commitParsedFile(buyFile(), "b.csv", null, B, AC).added).toBe(1);
    expect(rowsOf(A)[0].dedupHash, "the same fill in both books carries one identity").toBe(rowsOf(B)[0].dedupHash);
    commit.commitParsedFile(parsed([sellRow("BEL", 40, 120, "2026-05-01")]), "s.csv", null, B, AC);
    expect(rowsOf(B).map((r) => [r.buyQty, r.isOpen])).toEqual([[60, true], [40, false]]);

    const beforeA = rowsOf(A);
    const beforeB = rowsOf(B);
    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect([res.ok, res.snapshotId, res.skippedTrades], res.message).toEqual([false, null, 0]);
    expect(res.message).toContain("is part of a position an import closed automatically");
    expect(res.message, "the merged book would show 100 open PLUS a closed 40").toContain("overstating the position");
    expect(res.message).toContain("Un-close");
    expect(rowsOf(A), "nothing moved").toEqual(beforeA);
    expect(rowsOf(B)).toEqual(beforeB);
    expect(t.db.select().from(t.schema.accounts).where(eq(t.schema.accounts.id, B)).all(), "the source account is still there").toHaveLength(1);

    const preview = acct.previewAccountDelete({ accountId: B, mode: "merge", targetId: A });
    expect(preview.warnings?.some((w) => w.includes("closed automatically")), "the preview says it before the user presses anything").toBe(true);
  });

  it("after the un-close the same merge runs — the pieces were the only reason", () => {
    const hash = execHashOf(rowsOf(B).find((r) => isAutoClosePiece(r))!);
    expect(unClose(B, hash).ok).toBe(true);
    select(0);
    const res = acct.deleteAccount({ accountId: B, mode: "merge", targetId: A, connections: "delete" });
    expect(res.ok, res.message).toBe(true);
    expect(rowsOf(B)).toEqual([]);
    // The buy is a plain duplicate the target already holds; the sale moves.
    expect(rowsOf(A).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[100, 0, true], [0, 40, true]]);
  });
});

// ═══ 9 · Trash restore, per shape ═══════════════════════════════════════════

describe("9 · every shape survives delete → restore whole", () => {
  it("WHOLE-converted: the one row brings the close back with it", () => {
    const ACC = 9010;
    newAccount(ACC, "trash-whole");
    commit.commitParsedFile(parsed([buyRow("ONGC", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("ONGC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const before = rowsOf(ACC);
    expect(before).toHaveLength(1);

    select(ACC);
    const res = del.deleteTradesByIds([before[0].id], "W3 trash whole");
    expect([res.ok, res.deleted], res.message).toEqual([true, 1]);
    const back = trash.restoreTrashSnapshot(res.snapshotId!, "test");
    expect([back.ok, back.restored, back.skipped.length], back.message).toEqual([true, 1, 0]);
    expect(rowsOf(ACC)).toEqual(before);

    const again = commit.commitParsedFile(parsed([sellRow("ONGC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    expect([again.added, again.skipped], "a re-pull of the sale is a duplicate, as it was before the delete").toEqual([0, 1]);
  });

  it("REMAINDER: the converted lot and what was left over come back together", () => {
    const ACC = 9011;
    newAccount(ACC, "trash-remainder");
    commit.commitParsedFile(parsed([buyRow("NTPC", 60, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("NTPC", 100, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const before = rowsOf(ACC);
    expect(before).toHaveLength(2);

    select(ACC);
    const res = del.deleteTradesByIds(before.map((r) => r.id), "W3 trash remainder");
    expect([res.ok, res.deleted], res.message).toEqual([true, 2]);
    const back = trash.restoreTrashSnapshot(res.snapshotId!, "test");
    expect([back.ok, back.restored], back.message).toEqual([true, 2]);
    expect(back.skipped, "no piece is swallowed by the 'recorded in the position it closed' skip").toEqual([]);
    expect(rowsOf(ACC)).toEqual(before);
  });
});

// ═══ 10 · W2a-F1 — the summary reports what the BOOK moved ══════════════════

describe("10 · W2a-F1 — a same-file B+S charges each leg exactly once", () => {
  const ACC = 9013;
  const REF = 9033;

  it("the preview's charges and the commit's net are Σ over the rows that were stored", () => {
    newAccount(ACC, "f1");
    newAccount(REF, "f1-ref");
    const file = () => parsed([buyRow("GAIL", 100, 100, "2026-04-01"), sellRow("GAIL", 100, 120, "2026-04-05")]);

    const p = commit.previewParsedFile(file(), null, ACC, "both.csv", AC);
    const res = commit.commitParsedFile(file(), "both.csv", null, ACC, AC);
    const rows = rowsOf(ACC);
    expect(rows, "one closed row, both legs' bills merged into it").toHaveLength(1);

    const storedCharges = r2(rows.reduce((s, r) => s + r.chargesTotal, 0));
    const storedNet = r2(rows.reduce((s, r) => s + r.netPnl, 0));
    expect(p.summary.chargesTotal, "the buy's own bill was counted once as an open row and again inside the close").toBe(storedCharges);
    expect(res.netPnl, "and the commit said the same figure back").toBe(storedNet);
    expect(p.summary.netPnl, "R2 — the two halves word one book one way").toBe(res.netPnl);

    // The same two rows with the applier off: every paisa the file charged.
    commit.commitParsedFile(file(), "both.csv", null, REF);
    expect(storedCharges, "a close merges bills, it never mints one").toBe(r2(rowsOf(REF).reduce((s, r) => s + r.chargesTotal, 0)));
  });
});

// ═══ 11 · counted-once across close → un-close → close again ════════════════

describe("11 · the realised sale is counted ONCE after a close, an un-close and a close again", () => {
  const ACC = 9014;

  it("capital, the tax base, the ITR export, both AIS sides and the /trades KPI all state it once", async () => {
    newAccount(ACC, "counted-once-w3");
    commit.commitParsedFile(parsed([buyRow("AXISBANK", 100, 100, "2025-06-10")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("AXISBANK", 100, 120, "2025-09-20")]), "sell.csv", null, ACC, AC);
    const closed = rowsOf(ACC)[0];
    const first = await oracle.readOracleView(t, ACC);

    const hash = execHashOf(closed);
    expect(unClose(ACC, hash).ok).toBe(true);
    const open = await oracle.readOracleView(t, ACC);
    expect([open.capital.totalRealised, open.taxNets, open.itrCount], "an un-closed position realises nothing").toEqual([0, [], 0]);
    expect(open.ais["2025-26 sale"] ?? 0, "and neither AIS side counts an open row").toBe(0);

    // Close it again, through the same door the import used.
    const res = reClose(ACC, hash, parsed([sellRow("AXISBANK", 100, 120, "2025-09-20")]), "sell.csv");
    expect(res.autoClose?.closedWhole, "the lot was whole again, so it closed whole again").toBe(1);

    const again = await oracle.readOracleView(t, ACC);
    expect(rowsOf(ACC), "one closed row, exactly as the first close left it").toHaveLength(1);
    expect(again, "every consumer, in this book's view, back to one sale counted once").toEqual(first);
    expect(again.capital.totalRealised).toBe(rowsOf(ACC)[0].netPnl);
    expect(again.itrCount).toBe(1);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, 0)).all(), "invariant 9").toEqual([]);
  });
});

// ═══ 12 · the Account-#3 class — a manual book is never touched ═════════════

describe("12 · a manual, batchless Dhan closed OPTION book survives a close AND an un-close elsewhere", () => {
  const ACC = 9015; // the manual book
  const OTHER = 9016; // the close and the un-close happen here
  let before: Row[];

  const manual = (over: Record<string, unknown>) =>
    tradeRow({
      accountId: ACC,
      broker: "dhan",
      bucket: "fno",
      segment: "option",
      instrumentType: "option",
      exchange: "NSE",
      symbol: "NIFTY",
      tradingsymbol: "NIFTY26MAY25000CE",
      optionType: "CE",
      strike: 25000,
      expiry: "2026-05-28",
      buyQty: 75,
      avgBuyPrice: 100,
      buyValue: 7500,
      sellQty: 75,
      avgSellPrice: 120,
      sellValue: 9000,
      buyDate: "2026-04-10",
      sellDate: "2026-04-20",
      grossPnl: 1500,
      chargesTotal: 42.17,
      netPnl: 1457.83,
      isOpen: false,
      importBatchId: null,
      sourceFile: null,
      ...over,
    });

  it("every column of every row is identical after a close and an un-close in ANOTHER account", () => {
    newAccount(ACC, "manual-book-w3");
    newAccount(OTHER, "importer-w3");
    t.db.insert(t.schema.trades).values([
      manual({ dedupHash: "w3-manual-opt-1" }),
      manual({ dedupHash: "w3-manual-opt-2", tradingsymbol: "NIFTY26MAY25200PE", optionType: "PE", strike: 25200, grossPnl: -258, netPnl: -300, chargesTotal: 42 }),
    ] as never).run();
    before = rowsOf(ACC);
    expect(before).toHaveLength(2);

    commit.commitParsedFile(
      parsed([buyRow("NIFTY26MAY25000CE", 75, 100, "2026-04-10", { productHint: null } as Partial<NormalizedTrade>)]),
      "other-b.csv", null, OTHER, AC,
    );
    const res = commit.commitParsedFile(
      parsed([sellRow("NIFTY26MAY25000CE", 75, 130, "2026-04-21", { productHint: null } as Partial<NormalizedTrade>)]),
      "other-s.csv", null, OTHER, AC,
    );
    expect(res.autoClose?.closedWhole).toBe(1);
    expect(rowsOf(ACC), "invariant 8 — an account-scoped write never crosses the book").toEqual(before);

    const hash = execHashOf(rowsOf(OTHER).find((r) => isAutoClosePiece(r))!);
    expect(unClose(OTHER, hash).ok).toBe(true);
    expect(rowsOf(ACC), "and neither does the write that undoes it").toEqual(before);
    expectNoNaN(rowsOf(ACC));
  });
});

// ═══ 13 · POST /api/trades/un-close ═════════════════════════════════════════

describe("13 · the route maps the query's answer to HTTP, and never writes to account 0", () => {
  const ACC = 9017;

  const post = (body: unknown) =>
    unCloseRoute.POST(
      new Request("http://local/api/trades/un-close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  it("{ tradeId } un-closes the execution the row belongs to", async () => {
    newAccount(ACC, "uc-route");
    commit.commitParsedFile(parsed([buyRow("CIPLA", 100, 100, "2026-04-01")]), "buy.csv", null, ACC, AC);
    commit.commitParsedFile(parsed([sellRow("CIPLA", 40, 120, "2026-05-01")]), "sell.csv", null, ACC, AC);
    const [lot, slice] = rowsOf(ACC);
    select(ACC);

    const res = await post({ tradeId: slice.id });
    const json = (await res.json()) as { ok: boolean; message: string };
    expect([res.status, json.ok], json.message).toEqual([200, true]);
    expect(rowsOf(ACC).map((r) => [r.buyQty, r.sellQty, r.isOpen])).toEqual([[100, 0, true], [0, 40, true]]);
    expect(rowsOf(ACC)[0].id, "the lot is the same row it always was").toBe(lot.id);
  });

  it("{ accountId, broker, execHash } is the other door, and a refusal answers ok:false with its code", async () => {
    // Close it again so the second door has something to open.
    const reclosed = rowsOf(ACC).find((r) => r.sellQty === 40 && r.isOpen)!;
    reClose(ACC, reclosed.dedupHash, parsed([sellRow("CIPLA", 40, 120, "2026-05-01")]), "s2.csv");
    const lot = rowsOf(ACC).find((r) => isAutoClosePiece(r))!;
    const hash = execHashOf(lot);

    const ok = await post({ accountId: ACC, broker: "dhan", execHash: hash });
    expect([ok.status, ((await ok.json()) as { ok: boolean }).ok]).toEqual([200, true]);

    const gone = await post({ accountId: ACC, broker: "dhan", execHash: hash });
    const body = (await gone.json()) as { ok: boolean; code: string; message: string };
    expect([gone.status, body.ok, body.code]).toEqual([404, false, "NOT_FOUND"]);
    expect(body.message).toContain("Nothing was changed.");
  });

  it("account 0 is a view and can never be the subject of the write (invariant 9)", async () => {
    const before = rowsOf(ACC);
    const res = await post({ accountId: 0, broker: "dhan", execHash: "a".repeat(40) });
    const body = (await res.json()) as { ok: boolean; code: string };
    expect([res.status, body.ok]).toEqual([400, false]);
    expect(rowsOf(ACC)).toEqual(before);
    expect(t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, 0)).all()).toEqual([]);
  });

  it("a request naming no row at all is refused, and an unknown row is 404", async () => {
    const empty = await post({});
    expect([empty.status, ((await empty.json()) as { ok: boolean }).ok]).toEqual([400, false]);
    const missing = await post({ tradeId: 999_999 });
    const body = (await missing.json()) as { ok: boolean; code: string };
    expect([missing.status, body.ok, body.code]).toEqual([404, false, "NOT_FOUND"]);
  });
});
