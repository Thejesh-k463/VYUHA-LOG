/**
 * THE BOOK-SEQUENCE HARNESS — the operation table and the invariant checks.
 * (v4.3.0, builder G2; the harness itself is `tests/harness-book-sequences.test.ts`.)
 *
 * WHY THIS EXISTS. Every finding in this release's re-checks was one of two
 * shapes (wave2h-recheck.json / wave2i-recheck.json):
 *
 *   (a) a value WRITTEN in one file and READ differently in another — the
 *       counted-once split (`getIpoRealisedNet`'s scoped join beside
 *       `ipoIdsCountedThroughTrades`'s unscoped link read), the stated MTF
 *       `funded 0` that three readers took for "unstated";
 *   (b) a STATEFUL SEQUENCE nobody enumerated — delete → restore → merge →
 *       un-merge, sync → rate edit → exit edit, a Trash envelope written by one
 *       version and restored by the next.
 *
 * A seam test pins (a). Nothing pinned (b): each wave tested its own operation
 * from a clean book, and the combinations were left to the audit's imagination.
 * This file is the bounded model of (b): a table of the REAL operations the
 * identity subsystem exposes, and six invariants that must hold after EVERY one
 * of them, in EVERY order.
 *
 * NOTHING HERE RE-IMPLEMENTS PRODUCT LOGIC. Every operation is the shipped code
 * path — `deleteTradesByIds`, `restoreTrashSnapshot`, `closeStaleLot` through
 * its own route, `updateManualTrade`, `closePosition` through `/api/positions/
 * close`, `deleteAccount` (merge and purge), `commitParsedFile`, `/api/ipos`
 * POST, `runDataFixes` — and every invariant reads the product's own answers
 * (`getCapitalSummary`, `getTaxBase`, `/api/ais`, `heldIdentityHashes`,
 * `parentAggregate`) rather than a second opinion written here.
 *
 * ── THE OPERATION TABLE ──────────────────────────────────────────────────────
 * Each op is TOTAL: when its precondition is absent it records `skipped` and
 * writes nothing, so any ordering of any two ops is runnable. Each op declares
 * the quantity delta it INTENDS, measured from the rows it names BEFORE the
 * call (a delete: the legs those rows state; a restore: the legs its own
 * envelope states, less the rows the restore reported as skipped). I3 then
 * asserts the journal moved by exactly that and by nothing else — a cascade, a
 * phantom short, a row silently left behind or moved to another book all break
 * it.
 *
 * ── ONE TEMPLATE, MANY SCENARIOS ─────────────────────────────────────────────
 * AGENTS.md asks a scenario sweep to build its book ONCE and give each scenario
 * its own copy. The usual form of that (`tpl.serialize()` → `new Database(buf)`)
 * cannot be used here: every op runs through PRODUCT code, which reads the one
 * connection `lib/db` caches on `globalThis`, so a second connection would be a
 * database nothing under test can see. The same economy is reached the other way
 * the note allows — a template FILE, ATTACHed to the live connection, its tables
 * copied back over `main` between scenarios (`resetToTemplate`, measured at
 * ~4 ms) together with the Trash directory the fixture wrote. One migrate, one
 * seed, one fixture build for the whole file.
 */

import fs from "node:fs";
import path from "node:path";
import { tradeRow, type TempDb } from "./temp-db";
import type { NormalizedTrade } from "@/lib/engine/types";
import type { ParsedFile } from "@/lib/import/types";

// ─────────────────────────────────────────────────────────────────────────────
// Modules — ALL loaded dynamically. A static import of anything that reaches
// `@/lib/db` binds the connection before `openTempDb` sets VYUHA_DB_PATH, and
// the helper throws rather than assert against the wrong database (AGENTS.md).
// ─────────────────────────────────────────────────────────────────────────────

export interface BookMods {
  commit: typeof import("@/lib/import/commit");
  del: typeof import("@/lib/queries/delete");
  trash: typeof import("@/lib/trash");
  accountDelete: typeof import("@/lib/queries/account-delete");
  capital: typeof import("@/lib/queries/capital");
  taxItr: typeof import("@/lib/queries/tax-itr");
  ipoQ: typeof import("@/lib/queries/ipos");
  dq: typeof import("@/lib/queries/data-quality");
  dataFixes: typeof import("@/lib/db/data-fixes");
  backup: typeof import("@/lib/backup");
  lots: typeof import("@/lib/import/close-open-lots");
  staged: typeof import("@/lib/domain/staged");
  ipoRoute: typeof import("@/app/api/ipos/route");
  aisRoute: typeof import("@/app/api/ais/route");
  closeRoute: typeof import("@/app/api/positions/close/route");
  staleRoute: typeof import("@/app/api/data-quality/close-stale/route");
  settingsRoute: typeof import("@/app/api/settings/route");
  riskRoute: typeof import("@/app/api/positions/risk/route");
  riskCap: typeof import("@/lib/queries/risk-cap");
  limits: typeof import("@/lib/risk/limits");
  trashDir: string;
}

export async function loadBookMods(): Promise<BookMods> {
  return {
    commit: await import("@/lib/import/commit"),
    del: await import("@/lib/queries/delete"),
    trash: await import("@/lib/trash"),
    accountDelete: await import("@/lib/queries/account-delete"),
    capital: await import("@/lib/queries/capital"),
    taxItr: await import("@/lib/queries/tax-itr"),
    ipoQ: await import("@/lib/queries/ipos"),
    dq: await import("@/lib/queries/data-quality"),
    dataFixes: await import("@/lib/db/data-fixes"),
    backup: await import("@/lib/backup"),
    lots: await import("@/lib/import/close-open-lots"),
    staged: await import("@/lib/domain/staged"),
    ipoRoute: await import("@/app/api/ipos/route"),
    aisRoute: await import("@/app/api/ais/route"),
    closeRoute: await import("@/app/api/positions/close/route"),
    staleRoute: await import("@/app/api/data-quality/close-stale/route"),
    settingsRoute: await import("@/app/api/settings/route"),
    riskRoute: await import("@/app/api/positions/risk/route"),
    riskCap: await import("@/lib/queries/risk-cap"),
    limits: await import("@/lib/risk/limits"),
    trashDir: (await import("@/lib/db")).trashDir,
  };
}

export type BookDb = TempDb["db"];

// ─────────────────────────────────────────────────────────────────────────────
// The fixture
// ─────────────────────────────────────────────────────────────────────────────

/** A1's and A2's symbols, and the quantities the broker statement states. */
export const SYM = {
  dup: "GDUP", //  the genuine cross-account duplicate (same dedup hash, both books)
  dq: "GDQ", //    the Data Quality close shape: a lot + the sale its alias names
  ipo: "GIPO", //  the IPO-linked closed holding
  mtf: "GMTF", //  a partly sold open MTF row
  fresh: "GNEW", // whatever `reimportOtherHash` brings in
} as const;

/** Every quantity the fixture states, in one place — no op derives one. */
export const QTY = {
  dup: 10, //  bought and sold, so the position is flat in BOTH books
  dq: 100, //  bought, sold in a separate row, joined by the Data Quality one-click
  ipo: 10, //  the allotment, and the holding it became
  mtfBuy: 100,
  mtfSold: 40, // partly sold: 60 still open (the H1 shape)
  fresh: 50,
} as const;

export const IPO_NAME = "G2-SEQ-IPO";
/** The net the fixture's closed round trip states, in rupees. */
const DUP_NET = 490.25;

export interface SeedIds {
  acctA: number; //  the seeded default book (the merge target)
  acctB: number; //  the second book (the merge source / purge victim)
  dupA: number; //   A1's copy of the duplicate round trip
  dupB: number; //   A2's copy — the SAME dedup hash
  dupHash: string;
  dqLot: number; //  the lot, closed by the Data Quality one-click
  dqSaleHash: string; // the sale now in Trash, named by the lot's `dedup-alias:`
  dqBuyHash: string;
  ipoTrade: number; // the IPO-linked closed holding, in A2
  ipoId: number; //   the `ipos` row that names it
  ipoHash: string;
  mtfTrade: number; // the partly sold open MTF row, in A1
  mtfHash: string;
}

/**
 * `skipped` has ONE meaning in this table and the harness relies on it: the op
 * found its precondition absent and made NO product call at all, so it wrote
 * nothing — not to the database, not to the Trash directory. `refused` means
 * the product WAS called and answered no (a 409, an `ok:false`), which is a
 * state worth re-checking: a refusal that half-wrote is exactly the defect
 * class these refusals exist to prevent.
 */
export type OpStatus = "applied" | "skipped" | "refused";
export interface OpRecord {
  op: string;
  status: OpStatus;
  note: string;
}

export interface BookCtx {
  t: TempDb;
  m: BookMods;
  ids: SeedIds;
  /**
   * The broker statement, as the ops have legitimately moved it: net quantity
   * per symbol ACROSS every book. Seeded by `seedSequenceBook`, adjusted only
   * by an op that declares a delta.
   */
  expectedQty: Record<string, number>;
  /** Every op of the scenario so far, with what it actually did. */
  log: OpRecord[];
  /**
   * Symbols an op has declared the book may legitimately read SHORT in. The
   * only such op is `reimportSameHash`: re-pulling the broker file that carries
   * the Data Quality SALE, after the lot that recorded it has been deleted,
   * genuinely leaves a sale with no purchase beside it — the state the app
   * itself surfaces as the `stale_sale` warning (W2-DQ P2), not a defect. Every
   * other op must leave every book flat or long.
   */
  mayReadShort: Set<string>;
  /** Bumped by ops that must not collide with their own earlier call. */
  seq: number;
  /**
   * I7 (v4.4.0 D1) — the risk signature of every row that must NEVER move: a
   * staged position (R frozen at the first entry, invariant 4) or a row whose
   * source is `'frozen'`. Filled LAZILY, the first time a check sees the row,
   * and compared on every later check, so a row a test plants before its first
   * op is pinned at the value it was planted with.
   */
  frozenRisk: Map<number, string>;
}

// ── small helpers over the live connection ──────────────────────────────────

const selectAccount = (ctx: BookCtx, id: number) =>
  ctx.t.db.update(ctx.t.schema.settings).set({ selectedAccountId: id }).run();

/** Every trades row, in every book — the harness reads the whole database. */
const allTrades = (ctx: BookCtx) => ctx.t.db.select().from(ctx.t.schema.trades).all();
const tradeById = (ctx: BookCtx, id: number) => allTrades(ctx).find((r) => r.id === id) ?? null;
const accountExists = (ctx: BookCtx, id: number) =>
  ctx.t.db.select().from(ctx.t.schema.accounts).all().some((a) => a.id === id);

/** The signed quantity a row states: long adds, short subtracts. */
const netOf = (r: { buyQty: number; sellQty: number }) => r.buyQty - r.sellQty;

const r2 = (n: number) => Math.round(n * 100) / 100;

function bump(ctx: BookCtx, symbol: string, delta: number) {
  ctx.expectedQty[symbol] = r2((ctx.expectedQty[symbol] ?? 0) + delta);
}
const record = (ctx: BookCtx, op: string, status: OpStatus, note: string) => {
  ctx.log.push({ op, status, note });
};

const jsonReq = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** A Trash envelope, read off disk exactly as `restoreTrashSnapshot` reads it. */
export function readEnvelope(ctx: BookCtx, id: string): {
  account?: { id: number; name: string };
  trades: { id: number; accountId: number; tradingsymbol: string; buyQty: number; sellQty: number; dedupHash: string }[];
  ipoRefs?: { ipoId: number; tradeId: number }[];
} {
  const p = path.join(ctx.m.trashDir, id, "snapshot.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** The newest snapshot that is (or is not) an ACCOUNT envelope. */
function newestSnapshot(ctx: BookCtx, wantAccount: boolean): string | null {
  for (const s of ctx.m.trash.listTrashSnapshots()) {
    const env = readEnvelope(ctx, s.id);
    if (!!env.account === wantAccount) return s.id;
  }
  return null;
}

// ── the importer, driven the way the app drives it ──────────────────────────

function normalized(over: Partial<NormalizedTrade> & { tradingsymbol: string }): NormalizedTrade {
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
const parsedFile = (trades: NormalizedTrade[]): ParsedFile => ({
  sourceId: "dhan-api",
  broker: "dhan",
  format: "api",
  trades,
  warnings: [],
});

/** One Dhan delivery fill aggregate, committed through the real importer. */
function commitFill(
  ctx: BookCtx,
  accountId: number,
  sym: string,
  side: "BUY" | "SELL",
  qty: number,
  price: number,
  day: string,
  fileName: string,
): { added: number; skipped: number } {
  const tr =
    side === "BUY"
      ? normalized({ tradingsymbol: sym, buyQty: qty, avgBuyPrice: price, buyValue: qty * price, buyDate: day })
      : normalized({ tradingsymbol: sym, sellQty: qty, avgSellPrice: price, sellValue: qty * price, sellDate: day });
  const res = ctx.m.commit.commitParsedFile(parsedFile([tr]), fileName, null, accountId);
  return { added: res.added, skipped: res.skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) seedSequenceBook — the SMALL two-account book every scenario starts from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four shapes, chosen because each one is the subject of a v4.3.0 finding:
 *
 *   1. ONE closed round trip in EACH account on the SAME dedup hash — the
 *      genuine cross-account duplicate a merge must drop exactly once (F4/F13).
 *   2. An open lot in A1 and its sale, JOINED by the Data Quality one-click, so
 *      the lot carries `dedup-alias:<sale hash>` and the sale sits in Trash
 *      (F3: the shape whose restore was refused whole).
 *   3. An IPO-linked closed holding in A2, with its `ipos` record filed in A2 —
 *      the counted-once subject (wave 2H/2I/2L).
 *   4. A PARTLY sold open MTF row in A1 (100 bought, 40 sold, funded 8,000) —
 *      the H1 remaining-quantity close and the F16 own-capital reader.
 *
 * Everything is built through product code where product code exists (the
 * importer and the Data Quality one-click); the rest is the plain row the
 * broker files would have produced.
 */
export async function seedSequenceBook(db: BookDb, ctx: { t: TempDb; m: BookMods }): Promise<SeedIds> {
  const { t, m } = ctx;
  const acctA = db.select().from(t.schema.accounts).all()[0]!.id;
  const acctB = acctA + 1;
  db.insert(t.schema.accounts).values({ id: acctB, name: "G2 sequence B", isDefault: false }).run();

  const dupHash = "g2-seq-duplicate-hash";
  const closed = (accountId: number, symbol: string, over: Record<string, unknown> = {}) =>
    db
      .insert(t.schema.trades)
      .values(
        tradeRow({
          accountId,
          broker: "zerodha",
          bucket: "equity",
          segment: "eq_delivery",
          symbol,
          tradingsymbol: symbol,
          buyQty: QTY.dup,
          avgBuyPrice: 100,
          buyValue: QTY.dup * 100,
          buyDate: "2026-02-20",
          sellQty: QTY.dup,
          avgSellPrice: 150,
          sellValue: QTY.dup * 150,
          sellDate: "2026-03-02",
          grossPnl: QTY.dup * 50,
          chargesTotal: QTY.dup * 50 - DUP_NET,
          netPnl: DUP_NET,
          isOpen: false,
          ...over,
        }),
      )
      .returning({ id: t.schema.trades.id })
      .get()!.id;

  // 1 — the same fill, in two books.
  const dupA = closed(acctA, SYM.dup, { dedupHash: dupHash });
  const dupB = closed(acctB, SYM.dup, { dedupHash: dupHash });

  // 3 — the IPO-linked holding, in A2, and its record beside it.
  const ipoTrade = closed(acctB, SYM.ipo, {
    acquisition: "ipo",
    acquisitionPrice: 100,
    acquisitionDate: "2026-02-20",
  });
  const ipoId = db
    .insert(t.schema.ipos)
    .values({
      accountId: acctB,
      name: IPO_NAME,
      broker: "zerodha",
      exchange: "NSE",
      appliedPrice: 100,
      lotSize: QTY.ipo,
      lotsApplied: 1,
      allotted: true,
      allottedQty: QTY.ipo,
      listingPrice: 130,
      exitPrice: 150,
      appliedDate: "2026-02-10",
      allotmentDate: "2026-02-20",
      listingDate: "2026-02-24",
      exitDate: "2026-03-02",
      tradeId: ipoTrade,
    })
    .returning({ id: t.schema.ipos.id })
    .get()!.id;

  // 4 — the partly sold MTF row. It carries what an IMPORT of it would have
  // written (v4.4.0 D1): the cap its bucket/segment resolves to, stamped
  // `'cap'`, and R off its own net through the writers' one formula — so the
  // S1 mark-only save has a cap row to be tested on.
  const mtfCap = m.limits.resolvePerTradeCap(m.riskCap.readCapRows(t.sqlite), "equity", "eq_mtf");
  const mtfTrade = db
    .insert(t.schema.trades)
    .values(
      tradeRow({
        accountId: acctA,
        broker: "zerodha",
        bucket: "equity",
        segment: "eq_mtf",
        symbol: SYM.mtf,
        tradingsymbol: SYM.mtf,
        buyQty: QTY.mtfBuy,
        avgBuyPrice: 100,
        buyValue: QTY.mtfBuy * 100,
        buyDate: "2026-08-01",
        buyOrderCount: 1,
        sellQty: QTY.mtfSold,
        avgSellPrice: 108,
        sellValue: QTY.mtfSold * 108,
        sellDate: "2026-08-20",
        mtfFundedAmount: 8000,
        isOpen: true,
        riskAmount: mtfCap,
        riskSource: mtfCap == null ? null : "cap",
        rMultiple: m.riskCap.capR(0, mtfCap),
      }),
    )
    .returning({ id: t.schema.trades.id })
    .get()!.id;

  // 2 — the Data Quality close shape, built by the Data Quality one-click.
  selectAccount({ t, m } as BookCtx, acctA);
  const c = { t, m } as BookCtx;
  commitFill(c, acctA, SYM.dq, "BUY", QTY.dq, 200, "2026-08-20", `g2-seq-${SYM.dq}-BUY`);
  commitFill(c, acctA, SYM.dq, "SELL", QTY.dq, 250, "2026-08-25", `g2-seq-${SYM.dq}-SELL`);
  const dqRows = db.select().from(t.schema.trades).all().filter((r) => r.tradingsymbol === SYM.dq);
  const dqLotRow = dqRows.find((r) => r.buyQty > 0)!;
  const dqSaleRow = dqRows.find((r) => r.sellQty > 0 && r.buyQty === 0)!;
  const joined = m.commit.closeStaleLot(dqLotRow.id, dqSaleRow.id, "2026-08-25");
  if (!joined.ok) throw new Error(`seedSequenceBook: the Data Quality join failed — ${joined.message}`);

  return {
    acctA,
    acctB,
    dupA,
    dupB,
    dupHash,
    dqLot: dqLotRow.id,
    dqBuyHash: dqLotRow.dedupHash,
    dqSaleHash: dqSaleRow.dedupHash,
    ipoTrade,
    ipoId,
    ipoHash: tradeById({ t, m } as BookCtx, ipoTrade)!.dedupHash,
    mtfTrade,
    mtfHash: tradeById({ t, m } as BookCtx, mtfTrade)!.dedupHash,
  };
}

/** The statement the seeded book states, before any op runs. */
export const statementOf = (): Record<string, number> => ({
  [SYM.dup]: 0, //  flat in both books
  [SYM.dq]: 0, //   the lot is closed by the sale the alias names
  [SYM.ipo]: 0, //  the allotment was exited
  [SYM.mtf]: QTY.mtfBuy - QTY.mtfSold, // 60 still open
  [SYM.fresh]: 0, // nothing imported yet
});

// ─────────────────────────────────────────────────────────────────────────────
// The template — one build, one copy per scenario
// ─────────────────────────────────────────────────────────────────────────────

export interface Template {
  tables: string[];
  trashTemplateDir: string;
  reset: () => void;
}

/**
 * Freeze the CURRENT database + Trash directory as the template every scenario
 * starts from, and return the reset. `VACUUM INTO` + `ATTACH` rather than a
 * second `Database` handle, because every op runs through the one connection
 * `lib/db` caches (see this file's header).
 */
export function snapshotTemplate(ctx: BookCtx): Template {
  const { sqlite } = ctx.t;
  // A throwaway database in the OS temp directory has nothing to be durable
  // about, and the reset below is ~54 DELETE+INSERT pairs run once per
  // scenario. Turning fsync off is the single biggest lever on the Windows CI
  // runner, measured > 15x slower than a dev machine on SQLite-FILE work
  // (AGENTS.md Testing). It changes no result — only what survives a crash.
  sqlite.pragma("synchronous = OFF");
  const tplPath = path.join(ctx.t.dir, "sequence-template.sqlite").replace(/\\/g, "/");
  fs.rmSync(tplPath, { force: true });
  sqlite.prepare(`VACUUM INTO '${tplPath}'`).run();

  // FTS shadow tables are maintained by the triggers on `trades`/`ledger_entries`
  // /`audit_log`; copying them by hand is refused by SQLite ("may not be
  // modified") and would be wrong anyway.
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((x) => x.name)
    .filter((n) => !/_fts($|_)/.test(n));
  sqlite.prepare(`ATTACH '${tplPath}' AS g2tpl`).run();

  const trashTemplateDir = path.join(ctx.t.dir, "trash-template");
  fs.rmSync(trashTemplateDir, { recursive: true, force: true });
  if (fs.existsSync(ctx.m.trashDir)) fs.cpSync(ctx.m.trashDir, trashTemplateDir, { recursive: true });
  else fs.mkdirSync(trashTemplateDir, { recursive: true });

  const copy = sqlite.transaction(() => {
    for (const name of tables) {
      sqlite.prepare(`DELETE FROM main."${name}"`).run();
      sqlite.prepare(`INSERT INTO main."${name}" SELECT * FROM g2tpl."${name}"`).run();
    }
  });

  return {
    tables,
    trashTemplateDir,
    reset() {
      copy();
      fs.rmSync(ctx.m.trashDir, { recursive: true, force: true });
      fs.cpSync(trashTemplateDir, ctx.m.trashDir, { recursive: true });
    },
  };
}

/** A scenario's own context over the reset database. */
export function freshCtx(t: TempDb, m: BookMods, ids: SeedIds): BookCtx {
  return { t, m, ids, expectedQty: statementOf(), log: [], mayReadShort: new Set(), seq: 0, frozenRisk: new Map() };
}

// ─────────────────────────────────────────────────────────────────────────────
// (b) OPS — the operation table
// ─────────────────────────────────────────────────────────────────────────────

export interface BookOp {
  name: string;
  /** What it needs to do anything — stated so a `skipped` is never a surprise. */
  needs: string;
  /** The real code path it drives. */
  drives: string;
  run: (db: BookDb, ctx: BookCtx) => Promise<void>;
}

/** Delete named rows through `/trades`' own path, scoped to their own book. */
async function deleteRow(ctx: BookCtx, opName: string, tradeId: number, why: string): Promise<void> {
  const row = tradeById(ctx, tradeId);
  if (!row) return record(ctx, opName, "skipped", "that row is not in the journal");
  selectAccount(ctx, row.accountId);
  const res = ctx.m.del.deleteTradesByIds([row.id], `G2 harness: ${why}`, "harness");
  if (!res.ok) return record(ctx, opName, "refused", res.message);
  // The journal must lose exactly the legs that row stated — no cascade, no
  // survivor.
  bump(ctx, row.tradingsymbol, -netOf(row));
  record(ctx, opName, "applied", `deleted #${row.id} from account ${row.accountId}`);
}

export const OPS: BookOp[] = [
  {
    name: "deleteDupInA1",
    needs: "A1's copy of the duplicate round trip is in the journal",
    drives: "lib/queries/delete.ts deleteTradesByIds (the /trades delete)",
    run: async (_db, ctx) => deleteRow(ctx, "deleteDupInA1", ctx.ids.dupA, "the A1 duplicate"),
  },
  {
    name: "deleteIpoHolding",
    needs: "the IPO-linked holding is in the journal",
    drives: "lib/queries/delete.ts deleteTradesByIds — the branch that writes `ipoRefs`",
    run: async (_db, ctx) => deleteRow(ctx, "deleteIpoHolding", ctx.ids.ipoTrade, "the IPO-linked holding"),
  },
  {
    name: "deleteJoinedLot",
    needs: "the Data Quality-joined lot is in the journal",
    drives: "lib/queries/delete.ts deleteTradesByIds on a row holding a `dedup-alias:`",
    run: async (_db, ctx) => deleteRow(ctx, "deleteJoinedLot", ctx.ids.dqLot, "the joined lot"),
  },
  {
    name: "restoreLatestSnapshot",
    needs: "a Trash snapshot that is not an account envelope",
    drives: "lib/trash.ts restoreTrashSnapshot (POST /api/trash {action:'restore'})",
    run: async (_db, ctx) => {
      const id = newestSnapshot(ctx, false);
      if (!id) return record(ctx, "restoreLatestSnapshot", "skipped", "no trade snapshot exists");
      const env = readEnvelope(ctx, id);
      const res = ctx.m.trash.restoreTrashSnapshot(id, "harness");
      const skipped = new Set(res.skipped.map((s) => s.id));
      const landed = env.trades.filter((r) => !skipped.has(r.id));
      if (!res.ok && landed.length === 0) return record(ctx, "restoreLatestSnapshot", "refused", res.message);
      // The journal must gain exactly the rows this envelope said came back.
      for (const r of landed) bump(ctx, r.tradingsymbol, netOf(r));
      record(ctx, "restoreLatestSnapshot", "applied", `restored ${res.restored}, skipped ${res.skipped.length} (${id})`);
    },
  },
  {
    name: "closeStaleLot",
    needs: "an unambiguous stale pair the one-click offers",
    drives: "POST /api/data-quality/close-stale → lib/import/commit.ts closeStaleLot",
    run: async (_db, ctx) => {
      selectAccount(ctx, 0); // every book's pairs, each inside its own book
      const pair = ctx.m.dq.getStaleOpenPairs().find((p) => p.oneClick && !p.ambiguous && !p.blocked);
      if (!pair) return record(ctx, "closeStaleLot", "skipped", "no one-click pair is offered");
      selectAccount(ctx, pair.accountId);
      const res = await ctx.m.staleRoute.POST(
        jsonReq("/api/data-quality/close-stale", { lotId: pair.lotId, saleId: pair.saleId, exitDate: pair.saleDate }),
      );
      const body = (await res.json()) as { ok: boolean; message: string };
      if (res.status !== 200) return record(ctx, "closeStaleLot", "refused", `${res.status} ${body.message}`);
      // Net-neutral by construction: the lot takes the sale's quantity onto its
      // closing leg and the sale ROW leaves the journal for Trash.
      record(ctx, "closeStaleLot", "applied", `joined #${pair.saleId} into #${pair.lotId}`);
    },
  },
  {
    name: "reopenInEditor",
    needs: "the Data Quality-joined lot is in the journal and closed",
    drives: "lib/import/commit.ts updateManualTrade — the editor clearing the sell leg",
    run: async (_db, ctx) => {
      const lot = tradeById(ctx, ctx.ids.dqLot);
      if (!lot) return record(ctx, "reopenInEditor", "skipped", "the lot is not in the journal");
      if (lot.sellQty === 0) return record(ctx, "reopenInEditor", "skipped", "the lot has no sell leg to clear");
      selectAccount(ctx, lot.accountId);
      const res = ctx.m.commit.updateManualTrade(lot.id, { sellQty: 0, avgSellPrice: 0, sellDate: null });
      if (!res.ok) return record(ctx, "reopenInEditor", "refused", res.message);
      bump(ctx, lot.tradingsymbol, lot.sellQty);
      record(ctx, "reopenInEditor", "applied", `cleared the sell leg of #${lot.id} (${lot.sellQty})`);
    },
  },
  {
    name: "closePositionPartial",
    needs: "the partly sold MTF row is in the journal and still open",
    drives: "POST /api/positions/close → lib/import/commit.ts closePosition (the H1 remainder)",
    run: async (_db, ctx) => {
      const row = tradeById(ctx, ctx.ids.mtfTrade);
      if (!row) return record(ctx, "closePositionPartial", "skipped", "the MTF row is not in the journal");
      if (!row.isOpen) return record(ctx, "closePositionPartial", "skipped", "the MTF row is already closed");
      const remaining = netOf(row);
      selectAccount(ctx, row.accountId);
      const res = await ctx.m.closeRoute.POST(
        jsonReq("/api/positions/close", { tradeId: row.id, exitPrice: 110, exitDate: "2026-09-05" }),
      );
      const body = (await res.json()) as { ok: boolean; message: string };
      if (!body.ok) return record(ctx, "closePositionPartial", "refused", `${res.status} ${body.message}`);
      bump(ctx, row.tradingsymbol, -remaining);
      record(ctx, "closePositionPartial", "applied", `closed the remaining ${remaining} of #${row.id}`);
    },
  },
  {
    name: "mergeAccountBIntoA",
    needs: "account B still exists",
    drives: "lib/queries/account-delete.ts deleteAccount({mode:'merge'})",
    run: async (_db, ctx) => {
      if (!accountExists(ctx, ctx.ids.acctB)) return record(ctx, "mergeAccountBIntoA", "skipped", "account B is gone");
      selectAccount(ctx, ctx.ids.acctA);
      const res = ctx.m.accountDelete.deleteAccount({
        accountId: ctx.ids.acctB,
        mode: "merge",
        targetId: ctx.ids.acctA,
        connections: "delete",
        source: "harness",
      });
      if (!res.ok) return record(ctx, "mergeAccountBIntoA", "refused", res.message);
      // Moving a row between books changes no symbol total; the DROPPED
      // duplicates do, and the envelope is where the merge states them.
      if (res.snapshotId) for (const r of readEnvelope(ctx, res.snapshotId).trades) bump(ctx, r.tradingsymbol, -netOf(r));
      record(ctx, "mergeAccountBIntoA", "applied", res.message);
    },
  },
  {
    name: "purgeAccountB",
    needs: "account B still exists",
    drives: "lib/queries/account-delete.ts deleteAccount({mode:'purge'})",
    run: async (_db, ctx) => {
      if (!accountExists(ctx, ctx.ids.acctB)) return record(ctx, "purgeAccountB", "skipped", "account B is gone");
      selectAccount(ctx, ctx.ids.acctA);
      const res = ctx.m.accountDelete.deleteAccount({
        accountId: ctx.ids.acctB,
        mode: "purge",
        connections: "delete",
        source: "harness",
      });
      if (!res.ok) return record(ctx, "purgeAccountB", "refused", res.message);
      if (res.snapshotId) for (const r of readEnvelope(ctx, res.snapshotId).trades) bump(ctx, r.tradingsymbol, -netOf(r));
      record(ctx, "purgeAccountB", "applied", res.message);
    },
  },
  {
    name: "restoreSourceAccount",
    needs: "a merge or a purge has written an account envelope",
    drives: "lib/trash.ts restoreTrashSnapshot on an `account` envelope (the un-merge)",
    run: async (_db, ctx) => {
      const id = newestSnapshot(ctx, true);
      if (!id) return record(ctx, "restoreSourceAccount", "skipped", "no account envelope exists");
      const env = readEnvelope(ctx, id);
      const res = ctx.m.trash.restoreTrashSnapshot(id, "harness");
      const skipped = new Set(res.skipped.map((s) => s.id));
      const landed = env.trades.filter((r) => !skipped.has(r.id));
      if (!res.ok && landed.length === 0) return record(ctx, "restoreSourceAccount", "refused", res.message);
      for (const r of landed) bump(ctx, r.tradingsymbol, netOf(r));
      record(ctx, "restoreSourceAccount", "applied", `restored ${res.restored}, skipped ${res.skipped.length} (${id})`);
    },
  },
  {
    name: "reimportSameHash",
    needs: "nothing — the same broker fill is always re-pullable",
    drives: "lib/import/commit.ts commitParsedFile (the dedup / alias read)",
    run: async (_db, ctx) => {
      const before = allTrades(ctx).length;
      const res = commitFill(ctx, ctx.ids.acctA, SYM.dq, "SELL", QTY.dq, 250, "2026-08-25", `g2-seq-${SYM.dq}-SELL-again-${ctx.seq++}`);
      // The importer's OWN report is the declaration; I1 answers separately for
      // whether that sale now exists twice.
      bump(ctx, SYM.dq, -QTY.dq * res.added);
      // A re-pulled SALE is the one op that can leave a book short of a
      // purchase (see `mayReadShort`) — declared, never inferred.
      if (res.added > 0) ctx.mayReadShort.add(SYM.dq);
      // "applied" either way: the importer RAN. `skipped` in this table means a
      // product call was never made at all (see `OpStatus`).
      record(ctx, "reimportSameHash", "applied", `added ${res.added}, deduped ${res.skipped} (rows ${before} → ${allTrades(ctx).length})`);
    },
  },
  {
    name: "reimportOtherHash",
    needs: "nothing — a fill the book has never seen",
    drives: "lib/import/commit.ts commitParsedFile (a genuinely new identity)",
    run: async (_db, ctx) => {
      const price = 300 + ctx.seq;
      const res = commitFill(ctx, ctx.ids.acctA, SYM.fresh, "BUY", QTY.fresh, price, "2026-09-01", `g2-seq-${SYM.fresh}-BUY-${ctx.seq++}`);
      bump(ctx, SYM.fresh, QTY.fresh * res.added);
      record(ctx, "reimportOtherHash", "applied", `added ${res.added} at ${price}`);
    },
  },
  {
    name: "ipoExitEdit",
    needs: "the `ipos` record is still stored",
    drives: "POST /api/ipos — an edit that CHANGES the exit (the sync writes the holding)",
    run: async (_db, ctx) => {
      await postIpo(ctx, "ipoExitEdit", { exitPrice: 155, exitDate: "2026-03-05" });
    },
  },
  {
    name: "ipoNotesOnlySave",
    needs: "the `ipos` record is still stored",
    drives: "POST /api/ipos — a save that writes NOTHING to the holding (L3)",
    run: async (_db, ctx) => {
      await postIpo(ctx, "ipoNotesOnlySave", { notes: `G2 harness note ${ctx.seq++}` });
    },
  },
  {
    name: "runDataFixes",
    needs: "nothing — this runs on every startup and after every restore",
    drives: "lib/db/data-fixes.ts runDataFixes (the IPO account re-home ledger)",
    run: async (_db, ctx) => {
      const ran = ctx.m.dataFixes.runDataFixes(ctx.t.sqlite);
      record(
        ctx,
        "runDataFixes",
        "applied",
        ran.map((f) => `${f.name}: applied ${f.applied}, rekeyed ${f.rekeyed}, collisions ${f.skippedCollisions}`).join("; ") || "no fix ran",
      );
    },
  },
  {
    name: "editChargeRate",
    needs: "a zerodha eq_delivery NSE rate row",
    drives: "POST /api/settings {type:'charge'} — the charge editor's own save",
    run: async (_db, ctx) => {
      const rate = ctx.t.db
        .select()
        .from(ctx.t.schema.chargeConfig)
        .all()
        .find((r) => r.broker === "zerodha" && r.segment === "eq_delivery" && r.exchange === "NSE" && r.plan === "default");
      if (!rate) return record(ctx, "editChargeRate", "skipped", "no zerodha eq_delivery NSE rate row");
      const res = await ctx.m.settingsRoute.POST(
        jsonReq("/api/settings", {
          type: "charge",
          id: rate.id,
          brokerageFlat: (rate.brokerageFlat ?? 0) + 7,
          brokeragePct: rate.brokeragePct,
          brokerageCap: rate.brokerageCap,
          brokerageFloor: rate.brokerageFloor,
          sttPct: rate.sttPct,
          exchangeTxnPct: rate.exchangeTxnPct,
          sebiPct: rate.sebiPct,
          stampPct: rate.stampPct,
          ipftPct: rate.ipftPct,
          gstPct: rate.gstPct,
          dpCharge: rate.dpCharge,
          mtfInterestAnnual: rate.mtfInterestAnnual,
        }),
      );
      const out = (await res.json()) as { ok?: boolean; message?: string };
      if (!out.ok) return record(ctx, "editChargeRate", "refused", `${res.status} ${out.message ?? ""}`);
      // A rate correction re-prices what is COMPUTED (the IPO book's exit
      // charges) and nothing that is STORED; no quantity moves.
      record(ctx, "editChargeRate", "applied", `zerodha eq_delivery NSE brokerage flat → ${(rate.brokerageFlat ?? 0) + 7}`);
    },
  },
  {
    // D1 (v4.4.0) — THE CAP IS A UNIT, so every R measured in it follows it
    // (owner ruling OQ1). The risk editor posts every `risk_config` row on each
    // save, so this op does the same and changes only the per-trade cap of the
    // SEGMENT rows; the route stamps `capScheme` and re-prices every `'cap'`
    // trade inside ONE transaction. Alternating between two figures so a second
    // call in one sequence is a real second edit, not a no-op.
    name: "editPerTradeCap",
    needs: "nothing — the risk editor always has its rows",
    drives: "POST /api/settings {type:'risk'} → repriceCapTrades (lib/queries/risk-cap.ts)",
    run: async (_db, ctx) => {
      const rows = ctx.t.db.select().from(ctx.t.schema.riskConfig).all();
      if (rows.length === 0) return record(ctx, "editPerTradeCap", "skipped", "no risk_config rows");
      const next = EDITED_PER_TRADE_CAPS[ctx.seq++ % EDITED_PER_TRADE_CAPS.length]!;
      selectAccount(ctx, ctx.ids.acctA); // the audit line is filed in a real book (invariant 9)
      const res = await ctx.m.settingsRoute.POST(
        jsonReq("/api/settings", {
          type: "risk",
          // Every stored value posted back, the way the editor posts them: a
          // field this body omits would be written NULL by the route.
          rows: rows.map((r) => ({
            id: r.id,
            perTradeMaxLoss: r.scope === "segment" ? next : r.perTradeMaxLoss,
            maxOpen: r.maxOpen,
            maxTradesDay: r.maxTradesDay,
            dailyLossStop: r.dailyLossStop,
            concentrationPct: r.concentrationPct,
            monthlyTargetBase: r.monthlyTargetBase,
            monthlyTargetStretch: r.monthlyTargetStretch,
          })),
        }),
      );
      const out = (await res.json()) as { ok?: boolean; message?: string };
      if (!out.ok) return record(ctx, "editPerTradeCap", "refused", `${res.status} ${out.message ?? ""}`);
      // A cap edit moves a UNIT, never a quantity and never money.
      record(ctx, "editPerTradeCap", "applied", `every segment cap → ${next}`);
    },
  },
  {
    name: "legacifyLatestEnvelope",
    needs: "a Trash envelope that carries `ipoRefs`",
    drives: "the 4.2.x Trash writer — the field did not exist, so it is DELETED, not emptied",
    run: async (_db, ctx) => {
      for (const s of ctx.m.trash.listTrashSnapshots()) {
        const p = path.join(ctx.m.trashDir, s.id, "snapshot.json");
        const env = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
        if (!Array.isArray(env.ipoRefs)) continue;
        delete env.ipoRefs;
        fs.writeFileSync(p, JSON.stringify(env));
        return record(ctx, "legacifyLatestEnvelope", "applied", `stripped ipoRefs from ${s.id}`);
      }
      record(ctx, "legacifyLatestEnvelope", "skipped", "no envelope carries ipoRefs");
    },
  },
  {
    name: "autoCloseImport",
    needs: "nothing — it imports its own lot first, then the sale that closes it",
    drives:
      "lib/import/commit.ts commitParsedFile with `{ autoClose: true }` (v4.5.0 W2a, dormant) — the FIFO applier: the lot row becomes the closed row and holds the sale's hash as an alias",
    run: async (_db, ctx) => {
      // Two separate files, which is the class the applier exists for: a sale
      // that closes a lot ALREADY in the book. The pair is flat, so the op
      // declares no quantity delta; on a re-run both files dedup and it writes
      // nothing, which keeps the op total in every ordering.
      const acc = ctx.ids.acctA;
      if (!accountExists(ctx, acc)) return record(ctx, "autoCloseImport", "skipped", "account A is gone");
      const sym = `ACSYM${ctx.seq}`;
      const file = (t: NormalizedTrade, name: string) =>
        ctx.m.commit.commitParsedFile(parsedFile([t]), name, null, acc, { autoClose: true });
      const buy = file(
        normalized({ tradingsymbol: sym, buyQty: 10, avgBuyPrice: 100, buyValue: 1000, buyDate: "2026-04-01" }),
        `autoclose-buy-${ctx.seq}`,
      );
      if (buy.added !== 1) return record(ctx, "autoCloseImport", "skipped", `the lot was already imported (${sym})`);
      const sale = file(
        normalized({ tradingsymbol: sym, sellQty: 10, avgSellPrice: 120, sellValue: 1200, sellDate: "2026-05-01" }),
        `autoclose-sell-${ctx.seq}`,
      );
      record(
        ctx,
        "autoCloseImport",
        "applied",
        `${sym}: ${sale.autoClose?.closedWhole ?? 0} closed whole, ${sale.added} rows added beside it`,
      );
    },
  },
  {
    name: "unCloseImport",
    needs: "an import auto-close in account A — i.e. `autoCloseImport` ran before this op",
    drives: "lib/import/commit.ts unCloseExecution (POST /api/trades/un-close) — v4.5.0 W3",
    run: async (_db, ctx) => {
      // The inverse of `autoCloseImport`, and the pair the harness exists to
      // sweep: the close merged one purchase and one sale into ONE row, and the
      // un-close states those same two legs as two rows. Flat either way, so the
      // op declares no quantity delta — and if it ever stopped being flat (a
      // slice deleted without its lot, a sale reinstated twice) I3 says so.
      // The execution is read through the product's own rule, never off
      // `dedup_hash`: a lot consumed WHOLE keeps its own identity and holds the
      // execution's as an alias.
      const acc = ctx.ids.acctA;
      if (!accountExists(ctx, acc)) return record(ctx, "unCloseImport", "skipped", "account A is gone");
      const piece = allTrades(ctx).find((r) => r.accountId === acc && ctx.m.lots.isAutoClosePiece(r));
      if (!piece) return record(ctx, "unCloseImport", "skipped", "nothing in account A was closed by an import");
      selectAccount(ctx, acc);
      const res = ctx.m.commit.unCloseExecution(acc, piece.broker, ctx.m.lots.executionHashOfPiece(piece));
      if (!res.ok) return record(ctx, "unCloseImport", "refused", res.message);
      record(ctx, "unCloseImport", "applied", `${piece.tradingsymbol}: ${res.message}`);
    },
  },
];

/**
 * The per-trade caps `editPerTradeCap` types into the risk editor, in turn.
 * Neither is the legacy seed literal (₹9,500) and neither divides any fixture
 * net evenly, so a stale denominator cannot coincide with the new one.
 */
export const EDITED_PER_TRADE_CAPS = [4000, 3000] as const;

/** The look-alike's name — an ISSUE's name, as /ipos' own field is labelled. */
export const LOOKALIKE_IPO_NAME = "Second G2 Sequence Issue Limited";
/** The stray record's name — ANOTHER issue entirely (re-check counted-once#0). */
export const STRAY_IPO_NAME = "Bee Industries Limited";
/** D4 (wave 2O): a record in B naming a holding in A — the CROSS-BOOK link. */
export const CROSS_BOOK_IPO_NAME = "G2 Cross Book Issue Limited";
/** D4: the record the SURVIVING copy of the duplicate carries. */
export const SURVIVOR_IPO_NAME = "G2 Survivor Issue Limited";
/** D4: the record naming the copy a merge DROPS, filed in the target's book. */
export const FOREIGN_IPO_NAME = "G2 Foreign Issue Limited";
/** D4: the symbol of the trade that takes the dropped duplicate's freed id. */
export const TAKEN_ID_SYMBOL = "GTAKEN";

/**
 * FIXTURE VARIANTS (G-G2-1, wave 2M) — a shape a named scenario needs, which is
 * NOT an operation on the book.
 *
 * `runSequence` finds these by name exactly like an op, but the pair sweep
 * composes `OPS` only: a variation of the FIXTURE crossed with all seventeen
 * operations is thirty-four more scenarios asking nothing the single case does
 * not already ask, on a runner measured >15x slower than this machine. A
 * variant that turned out to compose interestingly belongs in `OPS` instead.
 */
export const VARIANTS: BookOp[] = [
  {
    // D1 / review S1 — THE MARK-ONLY SAVE. On /active the user pastes a price
    // with no stop: `app/api/positions/risk/route.ts` writes `riskAmount` back
    // on every save, and the version that stamped `'set'` unconditionally froze
    // THAT row in the old cap while every other cap row moved — two units
    // averaged into one Avg R. The row must still be `'cap'` afterwards, which
    // the pair with `editPerTradeCap` is what proves.
    //
    // A VARIANT and not an OP: its whole subject is what the NEXT cap edit does
    // to it, the pair the harness names explicitly, and seventeen more scenarios
    // asking nothing that pair does not ask cost the Windows runner (> 15x
    // slower on SQLite-file work) more than they are worth.
    name: "markPriceNoStop",
    needs: "the partly sold MTF row is in the journal",
    drives: "POST /api/positions/risk with ONLY a price — no stop in the request",
    run: async (_db, ctx) => {
      const row = tradeById(ctx, ctx.ids.mtfTrade);
      if (!row) return record(ctx, "markPriceNoStop", "skipped", "the MTF row is not in the journal");
      selectAccount(ctx, row.accountId);
      const res = await ctx.m.riskRoute.POST(jsonReq("/api/positions/risk", { tradeId: row.id, mtmPrice: 112 }));
      const out = (await res.json()) as { ok?: boolean; message?: string };
      if (!out.ok) return record(ctx, "markPriceNoStop", "refused", `${res.status} ${out.message ?? ""}`);
      record(ctx, "markPriceNoStop", "applied", `marked #${row.id} at 112 with no stop`);
    },
  },
  {
    // D1 / review S2 — THE EDIT DIALOG RE-POSTING THE CAP. The dialog prefills
    // the risk from the row and posts it on EVERY save, so a notes-only save
    // posts the cap figure back. A writer that reads any posted risk as the
    // user's choice turns that row into `'set'` at today's cap, and the next cap
    // edit leaves it behind (the stale denominator S2 names). Re-posting what
    // the row holds must leave a cap row following the cap.
    //
    // NOT asserted here: a dialog opened BEFORE a cap edit and saved after it
    // posts a figure that differs from both the stored value and today's cap —
    // by the D1 rule that IS a typed risk, and it is kept as `'set'`.
    name: "saveEditDialogRepostingTheCap",
    needs: "the Data Quality-joined lot is in the journal and follows the cap",
    drives: "lib/import/commit.ts updateManualTrade with the risk the dialog prefilled",
    run: async (_db, ctx) => {
      const lot = tradeById(ctx, ctx.ids.dqLot);
      if (!lot) return record(ctx, "saveEditDialogRepostingTheCap", "skipped", "the lot is not in the journal");
      if (lot.riskSource !== "cap") return record(ctx, "saveEditDialogRepostingTheCap", "skipped", `the lot is ${String(lot.riskSource)}, not a cap row`);
      selectAccount(ctx, lot.accountId);
      const res = ctx.m.commit.updateManualTrade(lot.id, { riskAmount: lot.riskAmount });
      if (!res.ok) return record(ctx, "saveEditDialogRepostingTheCap", "refused", res.message);
      record(ctx, "saveEditDialogRepostingTheCap", "applied", `re-posted ${String(lot.riskAmount)} on #${lot.id}`);
    },
  },
  {
    name: "addLookalikeIpoRecord",
    needs: "the fixture's own IPO record is still stored",
    drives: "a SECOND /ipos application in the same book, stating the same allotment — the raw row the fixture itself writes",
    run: async (_db, ctx) => {
      const stored = ctx.t.db.select().from(ctx.t.schema.ipos).all().find((r) => r.id === ctx.ids.ipoId);
      if (!stored) return record(ctx, "addLookalikeIpoRecord", "skipped", "the fixture's IPO record is gone");
      // Every fact the pairing reads is the fixture record's own, and the name
      // is a different ISSUE name: nothing in either row can tell the two
      // apart, which is precisely when a link must not be invented.
      const id = ctx.t.db
        .insert(ctx.t.schema.ipos)
        .values({
          accountId: stored.accountId,
          name: LOOKALIKE_IPO_NAME,
          broker: stored.broker,
          exchange: stored.exchange,
          appliedPrice: stored.appliedPrice,
          lotSize: stored.lotSize,
          lotsApplied: stored.lotsApplied,
          allotted: true,
          allottedQty: stored.allottedQty,
          listingPrice: stored.listingPrice,
          exitPrice: stored.exitPrice,
          appliedDate: stored.appliedDate,
          allotmentDate: stored.allotmentDate,
          listingDate: stored.listingDate,
          exitDate: stored.exitDate,
          tradeId: null,
        })
        .returning({ id: ctx.t.schema.ipos.id })
        .get()!.id;
      record(ctx, "addLookalikeIpoRecord", "applied", `a second unlinked exited record #${id} stating the same allotment`);
    },
  },
  {
    // D1 (fix wave 2N, re-check finding counted-once#0) — THE BEE SHAPE.
    //
    // A record of ANOTHER issue the user keeps in the same book, whose four
    // allotment facts happen to be the fixture holding's own: allotted with an
    // exit price, the same quantity, the same allotment day, the same exit day.
    // Two IPOs allotted on one day in the same lot size and both sold on listing
    // day is an ordinary retail pattern — and `ipos` carries no symbol or ISIN,
    // so nothing on this row can tell tier B it is a different scrip. Its own
    // sale must go on being counted once, before and after any restore.
    name: "addStrayExitedRecordOfAnotherScrip",
    needs: "the fixture's own IPO record is still stored",
    drives: "a second /ipos application in the same book, for a DIFFERENT issue",
    run: async (_db, ctx) => {
      const stored = ctx.t.db.select().from(ctx.t.schema.ipos).all().find((r) => r.id === ctx.ids.ipoId);
      if (!stored) return record(ctx, "addStrayExitedRecordOfAnotherScrip", "skipped", "the fixture's IPO record is gone");
      const id = ctx.t.db
        .insert(ctx.t.schema.ipos)
        .values({
          accountId: stored.accountId,
          name: STRAY_IPO_NAME,
          broker: stored.broker,
          exchange: stored.exchange,
          appliedPrice: stored.appliedPrice,
          lotSize: stored.lotSize,
          lotsApplied: stored.lotsApplied,
          allotted: true,
          allottedQty: stored.allottedQty,
          listingPrice: stored.listingPrice,
          // A different issue, a different exit price — the same allotment FACTS.
          exitPrice: (stored.exitPrice ?? 150) + 10,
          appliedDate: stored.appliedDate,
          allotmentDate: stored.allotmentDate,
          listingDate: stored.listingDate,
          exitDate: stored.exitDate,
          tradeId: null,
        })
        .returning({ id: ctx.t.schema.ipos.id })
        .get()!.id;
      record(ctx, "addStrayExitedRecordOfAnotherScrip", "applied", `a stray exited record #${id} of another issue, same allotment facts`);
    },
  },
  {
    // D4 (fix wave 2O, re-check finding identity#0) — THE CROSS-BOOK LINK.
    //
    // An `ipos` row in B naming a holding in A: the shape lib/queries/ipos.ts
    // :163-177 describes, which a Trash restore or an earlier merge leaves
    // behind. A PURGE of B snapshots this row into `accountRows.ipos` with its
    // `trade_id` intact, and A's holding is not in that envelope — so the replay
    // must keep the reference VERBATIM. Gating it on `landed` alone would cut a
    // live link, and an unlinked exited record beside the holding it names is
    // that sale counted twice.
    name: "addCrossBookIpoRecordInB",
    needs: "A1's copy of the duplicate round trip is in the journal",
    drives: "an /ipos record in B whose holding is in A — the raw row the fixture writes",
    run: async (_db, ctx) => {
      const holding = tradeById(ctx, ctx.ids.dupA);
      if (!holding) return record(ctx, "addCrossBookIpoRecordInB", "skipped", "A1's duplicate is not in the journal");
      const id = ctx.t.db
        .insert(ctx.t.schema.ipos)
        .values({
          accountId: ctx.ids.acctB,
          name: CROSS_BOOK_IPO_NAME,
          broker: "zerodha",
          exchange: "NSE",
          appliedPrice: 100,
          lotSize: QTY.dup,
          lotsApplied: 1,
          allotted: true,
          allottedQty: QTY.dup,
          listingPrice: 130,
          exitPrice: 150,
          appliedDate: "2026-02-10",
          allotmentDate: "2026-02-20",
          listingDate: "2026-02-24",
          exitDate: "2026-03-02",
          tradeId: holding.id,
        })
        .returning({ id: ctx.t.schema.ipos.id })
        .get()!.id;
      record(ctx, "addCrossBookIpoRecordInB", "applied", `record #${id} in account ${ctx.ids.acctB} names holding #${holding.id} in account ${ctx.ids.acctA}`);
    },
  },
  {
    // D4 — the pair that makes a merge SKIP a record rather than re-point it
    // (L7: one trade takes one IPO record). Both are filed in the TARGET's book:
    // the survivor's own record, and the record naming the copy the merge drops.
    // The second is the one D5 deletes into `accountRows.ipos`.
    name: "addDuplicateIpoRecordsInA",
    needs: "both copies of the duplicate round trip are in the journal",
    drives: "two /ipos records in A, one per copy of the duplicate — the raw rows the fixture writes",
    run: async (_db, ctx) => {
      const survivor = tradeById(ctx, ctx.ids.dupA);
      const dropped = tradeById(ctx, ctx.ids.dupB);
      if (!survivor || !dropped) return record(ctx, "addDuplicateIpoRecordsInA", "skipped", "one copy of the duplicate is gone");
      const insert = (name: string, tradeId: number) =>
        ctx.t.db
          .insert(ctx.t.schema.ipos)
          .values({
            accountId: ctx.ids.acctA,
            name,
            broker: "zerodha",
            exchange: "NSE",
            appliedPrice: 100,
            lotSize: QTY.dup,
            lotsApplied: 1,
            allotted: true,
            allottedQty: QTY.dup,
            listingPrice: 130,
            exitPrice: 150,
            appliedDate: "2026-02-10",
            allotmentDate: "2026-02-20",
            listingDate: "2026-02-24",
            exitDate: "2026-03-02",
            tradeId,
          })
          .returning({ id: ctx.t.schema.ipos.id })
          .get()!.id;
      const own = insert(SURVIVOR_IPO_NAME, survivor.id);
      const foreign = insert(FOREIGN_IPO_NAME, dropped.id);
      record(ctx, "addDuplicateIpoRecordsInA", "applied", `#${own} names the survivor #${survivor.id}, #${foreign} names the dropped copy #${dropped.id}`);
    },
  },
  {
    // D4 — the id the dropped duplicate held, taken by another closed trade.
    //
    // `trades.id` is AUTOINCREMENT, so an ordinary re-import never hands a freed
    // rowid back: the field shape is a snapshot restored against a database whose
    // rowids came from elsewhere (a backup from another machine, the desktop
    // template swap). Written explicitly, and FLAT (bought and sold), so it moves
    // no symbol's net quantity.
    name: "takeTheDroppedDuplicatesId",
    needs: "B's copy of the duplicate has left the journal",
    drives: "a raw INSERT with an explicit id — the state a restore then meets",
    run: async (_db, ctx) => {
      if (tradeById(ctx, ctx.ids.dupB)) return record(ctx, "takeTheDroppedDuplicatesId", "skipped", "that id is still B's duplicate");
      ctx.t.db
        .insert(ctx.t.schema.trades)
        .values(
          tradeRow({
            id: ctx.ids.dupB,
            accountId: ctx.ids.acctA,
            broker: "zerodha",
            bucket: "equity",
            segment: "eq_delivery",
            symbol: TAKEN_ID_SYMBOL,
            tradingsymbol: TAKEN_ID_SYMBOL,
            buyQty: QTY.dup,
            avgBuyPrice: 100,
            buyValue: QTY.dup * 100,
            buyDate: "2026-02-20",
            sellQty: QTY.dup,
            avgSellPrice: 150,
            sellValue: QTY.dup * 150,
            sellDate: "2026-03-02",
            grossPnl: QTY.dup * 50,
            chargesTotal: QTY.dup * 50 - DUP_NET,
            netPnl: DUP_NET,
            isOpen: false,
          }),
        )
        .run();
      record(ctx, "takeTheDroppedDuplicatesId", "applied", `#${ctx.ids.dupB} is now ${TAKEN_ID_SYMBOL} in account ${ctx.ids.acctA}`);
    },
  },
  {
    // D1 (fix wave 2N) — the user's own answer to the `ipo_record_link`
    // question. A restore no longer writes a tier-B pairing (the record carries
    // the ISSUE's name and `ipos` has no scrip fact, so it cannot prove it is
    // this holding's — counted-once#0), so what settles the book is the link the
    // user makes on /ipos. The moment they do, the allotment is counted once.
    name: "linkIpoRecordOnIpos",
    needs: "the fixture's IPO record is stored and its holding is in the journal",
    drives: "POST /api/ipos with a tradeId — the form's own link write",
    run: async (_db, ctx) => {
      const holding = tradeById(ctx, ctx.ids.ipoTrade);
      if (!holding) return record(ctx, "linkIpoRecordOnIpos", "skipped", "the IPO holding is gone");
      await postIpo(ctx, "linkIpoRecordOnIpos", { tradeId: ctx.ids.ipoTrade });
    },
  },
  /* ── v4.3.0 Signal book: the tombstone, across a backup restore ──────────── */
  {
    // The Signal book's ONE stateful sequence: a signal the user DELETED must
    // not come back. `rerunDataFixesAfterRestore` forgets every marker inside
    // the restore transaction and replays `signal-notes-backfill-v1`, and the
    // seeded notes this row carries are exactly what that fix reads — so with
    // SQL NULL as the cleared state the restore would hand the deletion back.
    // The tombstone `{"v":1}` is what the fix's IS NULL guard skips.
    name: "recordSignalTrade",
    needs: "nothing — it adds the option round trip the next two steps act on",
    drives: "lib/import/commit.ts commitManualTrade with `signalJson` (the Add form's Signal section)",
    run: async (_db, ctx) => {
      selectAccount(ctx, ctx.ids.acctA);
      const res = ctx.m.commit.commitManualTrade(
        {
          broker: "zerodha",
          tradingsymbol: SIGNAL_SYMBOL,
          isin: null,
          buyQty: 50,
          avgBuyPrice: 10,
          buyValue: 500,
          sellQty: 50,
          avgSellPrice: 16,
          sellValue: 800,
          closingPrice: null,
          grossPnl: 300,
          unrealisedPnl: 0,
          buyDate: "2026-09-02",
          sellDate: "2026-09-02",
          productHint: null,
          exchangeHint: null,
          sourceFile: "manual",
        } as never,
        { notes: SEEDED_SIGNAL_NOTES, setupTag: "CE BREAKOUT (RES)", signalJson: '{"v":1,"model":"S1","t1":13,"t2":16,"sl":7.5}' },
        ctx.ids.acctA,
      );
      if (!res.id) return record(ctx, "recordSignalTrade", "skipped", "the signal round trip is already in the journal");
      bump(ctx, SIGNAL_SYMBOL, 0); // bought and sold the same day: flat
      record(ctx, "recordSignalTrade", "applied", `#${res.id} carries a signal and the seeded notes`);
    },
  },
  {
    name: "clearRecordedSignal",
    needs: "the signal round trip is in the journal and carries a signal",
    drives: "lib/import/commit.ts updateManualTrade with `signalJson: null` — the Edit form's explicit clear",
    run: async (_db, ctx) => {
      const row = allTrades(ctx).find((r) => r.tradingsymbol === SIGNAL_SYMBOL);
      if (!row) return record(ctx, "clearRecordedSignal", "skipped", "no signal round trip is in the journal");
      selectAccount(ctx, row.accountId);
      const res = ctx.m.commit.updateManualTrade(row.id, { signalJson: null });
      if (!res.ok) return record(ctx, "clearRecordedSignal", "refused", res.message);
      record(ctx, "clearRecordedSignal", "applied", `#${row.id} now stores ${row.signalJson === null ? "nothing" : "a tombstone"}`);
    },
  },
  {
    name: "backupDumpAndRestore",
    needs: "nothing — it dumps the whole database and restores that dump over itself",
    drives: "lib/backup.ts dumpDatabase + restoreDatabase (which reruns every data fix, invariant 10)",
    run: async (_db, ctx) => {
      const dump = ctx.m.backup.dumpDatabase(false);
      const res = ctx.m.backup.restoreDatabase(dump);
      record(ctx, "backupDumpAndRestore", res.ok ? "applied" : "refused", res.message);
    },
  },
];

/** The Signal book variants' own contract — flat, so it states no quantity. */
export const SIGNAL_SYMBOL = "OPT GSIG 25 Sep 2026 100 CE";
/** The four lines `scripts/seed-options-account.ts` writes, which the fix reads. */
export const SEEDED_SIGNAL_NOTES = [
  "Options strategy log #7 · TIER 1",
  "Spot 100.5 · S/R zone 98 - 102 · Day H/L 16.5/8.25",
  "T1 13 · T2 16 · SL 7.5 · Exit: TARGET 2 HIT (60.00%)",
  "ΔOI -2.10% (unwind) · Volume 1200",
].join("\n");

/** The stored IPO, edited through its own route with one field changed. */
async function postIpo(ctx: BookCtx, opName: string, change: Record<string, unknown>): Promise<void> {
  const stored = ctx.t.db.select().from(ctx.t.schema.ipos).all().find((r) => r.id === ctx.ids.ipoId);
  if (!stored) return record(ctx, opName, "skipped", "the IPO record is gone");
  selectAccount(ctx, stored.accountId);
  const body = {
    id: stored.id,
    name: stored.name,
    broker: stored.broker,
    exchange: stored.exchange,
    board: stored.board,
    category: stored.category,
    discountPerShare: stored.discountPerShare,
    appliedPrice: stored.appliedPrice,
    lotSize: stored.lotSize,
    lotsApplied: stored.lotsApplied,
    allotted: stored.allotted,
    allottedQty: stored.allottedQty,
    listingPrice: stored.listingPrice,
    exitPrice: stored.exitPrice,
    appliedDate: stored.appliedDate,
    allotmentDate: stored.allotmentDate,
    listingDate: stored.listingDate,
    exitDate: stored.exitDate,
    notes: stored.notes,
    ...change,
  };
  const res = await ctx.m.ipoRoute.POST(jsonReq("/api/ipos", body));
  const out = (await res.json()) as { ok?: boolean; message?: string };
  if (res.status !== 200) return record(ctx, opName, "refused", `${res.status} ${out.message ?? ""}`);
  record(ctx, opName, "applied", JSON.stringify(change));
}

/**
 * Pairs the table refuses to run, with the reason. The bar is high on purpose:
 * every op is total, so almost every ordering IS runnable and a `skipped`
 * second op is itself worth asserting (it must refuse cleanly, not throw and
 * not half-write). Only an ordering that can never reach its own precondition
 * — and therefore tests nothing that its mirror does not already test — is
 * listed here.
 */
export const INCOMPATIBLE: { first: string; second: string; why: string }[] = OPS.filter(
  (o) => o.name !== "mergeAccountBIntoA" && o.name !== "purgeAccountB" && o.name !== "restoreSourceAccount",
).map((o) => ({
  first: "restoreSourceAccount",
  second: o.name,
  why: "no account envelope can exist before a merge or a purge has run, so `restoreSourceAccount` first is a guaranteed skip and the pair is the second op alone",
}));

export const isIncompatible = (first: string, second: string) =>
  INCOMPATIBLE.some((x) => x.first === first && x.second === second);

// ─────────────────────────────────────────────────────────────────────────────
// (c) checkInvariants
// ─────────────────────────────────────────────────────────────────────────────

export interface Violation {
  code: "I1" | "I2" | "I3" | "I4" | "I5" | "I6" | "I7";
  detail: string;
}

/**
 * The `account_id = 0` count, one PREPARED statement per table, resolved once
 * per file. Re-preparing thirteen statements inside a check that runs twice per
 * scenario and 500 times per file was measurable; the statements outlive the
 * template copies because `DELETE`/`INSERT` do not change the schema.
 */
let zeroAccountStatements: { table: string; stmt: { get: () => unknown } }[] | null = null;
function zeroAccountCounters(ctx: BookCtx) {
  if (zeroAccountStatements) return zeroAccountStatements;
  const names = (ctx.t.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((x) => x.name)
    .filter((n) => !/_fts($|_)/.test(n));
  zeroAccountStatements = names
    .filter((n) => (ctx.t.sqlite.pragma(`table_info("${n}")`) as { name: string }[]).some((c) => c.name === "account_id"))
    .map((table) => ({ table, stmt: ctx.t.sqlite.prepare(`SELECT count(*) AS n FROM "${table}" WHERE account_id = 0`) }));
  return zeroAccountStatements;
}

let moneyStatement: { all: () => Record<string, unknown>[] } | null = null;
const MONEY_COLUMNS = ["buy_value_paise", "sell_value_paise", "gross_pnl_paise", "charges_total_paise", "net_pnl_paise"];
const LEVEL_COLUMNS = ["buy_qty", "sell_qty", "avg_buy_price", "avg_sell_price"];
function moneyReader(ctx: BookCtx) {
  moneyStatement ??= ctx.t.sqlite.prepare(`SELECT id, ${[...MONEY_COLUMNS, ...LEVEL_COLUMNS].join(", ")} FROM trades`) as unknown as {
    all: () => Record<string, unknown>[];
  };
  return moneyStatement;
}

/** The AIS FY totals as `/api/ais` states them for the view now selected. */
async function aisTotals(ctx: BookCtx): Promise<{ sale: number; purchase: number }> {
  const res = await ctx.m.aisRoute.POST(jsonReq("/api/ais", { text: "nothing to parse" }));
  const { recon } = (await res.json()) as {
    recon: { fyTotals: { fy: string; kind: string; journal: number | null }[] };
  };
  let sale = 0;
  let purchase = 0;
  for (const f of recon.fyTotals) {
    if (f.kind === "sale") sale += f.journal ?? 0;
    else if (f.kind === "purchase") purchase += f.journal ?? 0;
  }
  return { sale: r2(sale), purchase: r2(purchase) };
}

/**
 * Every invariant, over the whole database, after ONE op.
 *
 * Returns the violations rather than asserting, so the harness can name the
 * sequence that produced them and so a case that is RED ON HEAD can be pinned
 * with `it.fails` and its code rather than silently weakened.
 */
export async function checkInvariants(db: BookDb, ctx: BookCtx): Promise<Violation[]> {
  const out: Violation[] = [];
  const add = (code: Violation["code"], detail: string) => out.push({ code, detail });
  const rows = allTrades(ctx);
  const selectedBefore =
    ctx.t.db.select().from(ctx.t.schema.settings).all()[0]?.selectedAccountId ?? ctx.ids.acctA;

  // ── I1 RECOVERABLE ────────────────────────────────────────────────────────
  // Every identity the fixture created is still SOMEWHERE — the journal or a
  // Trash envelope — and is never stated twice in the journal. "Stated" is the
  // product's own `heldIdentityHashes`: a row's own hash, plus the
  // `dedup-alias:` hashes it HOLDS (V1 — an alias whose closing leg no longer
  // holds quantity says nothing), so a joined lot and the sale it consumed are
  // ONE statement of one sale, not two.
  const held = new Map<string, number[]>();
  for (const r of rows) {
    for (const h of ctx.m.lots.heldIdentityHashes(r)) held.set(h, [...(held.get(h) ?? []), r.id]);
  }
  const inTrash = new Set<string>();
  for (const s of ctx.m.trash.listTrashSnapshots()) {
    for (const r of readEnvelope(ctx, s.id).trades) if (r.dedupHash) inTrash.add(r.dedupHash);
  }
  const fixtureIdentities: [string, string][] = [
    [ctx.ids.dqSaleHash, "the Data Quality sale"],
    [ctx.ids.dqBuyHash, "the Data Quality lot"],
    [ctx.ids.ipoHash, "the IPO-linked holding"],
    [ctx.ids.mtfHash, "the partly sold MTF row"],
  ];
  for (const [hash, label] of fixtureIdentities) {
    const ids = held.get(hash) ?? [];
    if (ids.length > 1) add("I1", `${label} (${hash}) is stated ${ids.length} times in the journal: #${ids.join(", #")}`);
    if (ids.length === 0 && !inTrash.has(hash)) add("I1", `${label} (${hash}) is in neither the journal nor any Trash envelope`);
  }
  // The duplicate is ONE hash carried by TWO books on purpose: it may be held
  // once per account, never twice inside one.
  const dupPerAccount = new Map<number, number>();
  for (const r of rows) {
    if (!ctx.m.lots.heldIdentityHashes(r).includes(ctx.ids.dupHash)) continue;
    dupPerAccount.set(r.accountId, (dupPerAccount.get(r.accountId) ?? 0) + 1);
  }
  for (const [acc, n] of dupPerAccount) {
    if (n > 1) add("I1", `the duplicate round trip is stated ${n} times inside account ${acc}`);
  }
  if (dupPerAccount.size === 0 && !inTrash.has(ctx.ids.dupHash)) {
    add("I1", `the duplicate round trip (${ctx.ids.dupHash}) is in neither book nor any Trash envelope`);
  }

  // ── I3 BOOK-EQUALS-STATEMENT ──────────────────────────────────────────────
  // Per symbol across every book, the net quantity equals what the statement
  // said adjusted by the deltas the ops declared; and inside a book no symbol
  // may read SHORT when the fixture never sold one short (the phantom the merge
  // used to leave behind).
  const bySymbol = new Map<string, number>();
  const byAccountSymbol = new Map<string, number>();
  for (const r of rows) {
    bySymbol.set(r.tradingsymbol, r2((bySymbol.get(r.tradingsymbol) ?? 0) + netOf(r)));
    const k = `${r.accountId}:${r.tradingsymbol}`;
    byAccountSymbol.set(k, r2((byAccountSymbol.get(k) ?? 0) + netOf(r)));
  }
  for (const [symbol, expected] of Object.entries(ctx.expectedQty)) {
    const actual = bySymbol.get(symbol) ?? 0;
    if (r2(actual) !== r2(expected)) add("I3", `${symbol}: the journal holds ${actual}, the statement says ${expected}`);
  }
  for (const [k, qty] of byAccountSymbol) {
    if (qty >= 0) continue;
    if (ctx.mayReadShort.has(k.split(":")[1]!)) continue;
    add("I3", `${k} reads SHORT ${qty} — a phantom leg with no purchase beside it`);
  }

  // ── I4 NO-ACCOUNT-0 ───────────────────────────────────────────────────────
  // 0 is a view, not a place (invariant 9).
  for (const { table, stmt } of zeroAccountCounters(ctx)) {
    const n = (stmt.get() as { n: number }).n;
    if (n > 0) add("I4", `${table} holds ${n} row(s) in account 0`);
  }

  // ── I5 PARENT-EQUALS-LEGS ─────────────────────────────────────────────────
  // Invariant 5, read through the product's own collapse.
  const legs = ctx.t.db.select().from(ctx.t.schema.tradeLegs).all();
  if (legs.length > 0) {
    const byTrade = new Map<number, typeof legs>();
    for (const l of legs) byTrade.set(l.tradeId, [...(byTrade.get(l.tradeId) ?? []), l]);
    for (const [tradeId, ls] of byTrade) {
      const parent = rows.find((r) => r.id === tradeId);
      if (!parent) {
        add("I5", `trade_legs hold ${ls.length} leg(s) for trade #${tradeId}, which is not in the journal`);
        continue;
      }
      const direction = ctx.m.lots.readsLong(parent) ? "long" : "short";
      const agg = ctx.m.staged.parentAggregate(
        ls.map((l) => ({ id: l.id, kind: l.kind as "entry" | "exit", seq: l.seq, tradeDate: l.tradeDate, qty: l.qty, price: l.price })),
        direction,
      );
      if (r2(agg.buyQty) !== r2(parent.buyQty) || r2(agg.sellQty) !== r2(parent.sellQty)) {
        add(
          "I5",
          `#${tradeId} (${direction}) states ${parent.buyQty}/${parent.sellQty} but its ${ls.length} legs collapse to ${agg.buyQty}/${agg.sellQty}`,
        );
      }
    }
  }

  // ── I6 NO-NAN ─────────────────────────────────────────────────────────────
  // Read RAW (integer paise), so a NULL written into a money column that must
  // be stated is seen before `moneyPaise` turns it into a 0 at the boundary.
  for (const r of moneyReader(ctx).all()) {
    for (const col of [...MONEY_COLUMNS, ...LEVEL_COLUMNS]) {
      const v = r[col];
      if (typeof v !== "number" || !Number.isFinite(v)) add("I6", `trades #${r.id}.${col} is ${JSON.stringify(v)}`);
    }
  }

  // ── I7 CAP ROWS FOLLOW THE CAP ────────────────────────────────────────────
  // v4.4.0 D1, owner ruling OQ1: a per-trade cap is a UNIT, so after EVERY
  // operation each row that states it follows the cap holds the cap its OWN
  // bucket/segment resolves to now, and an R computed from it by the writers'
  // one formula (`capR`). Charges stay frozen on a rate edit because they are
  // money; a cap-R is not money. A staged position's R is frozen at its first
  // entry (invariant 4) and a `'frozen'` row is never re-priced at all, so
  // those rows must come back byte-identical.
  {
    const caps = ctx.m.riskCap.readCapRows(ctx.t.sqlite);
    for (const r of rows) {
      if (r.staged || r.riskSource === "frozen") {
        const sig = JSON.stringify([r.riskAmount, r.rMultiple, r.riskSource]);
        const first = ctx.frozenRisk.get(r.id);
        if (first === undefined) ctx.frozenRisk.set(r.id, sig);
        else if (first !== sig) add("I7", `#${r.id} is ${r.staged ? "staged" : "'frozen'"} and its risk moved: ${first} → ${sig}`);
        continue;
      }
      if (r.riskSource !== "cap") continue;
      const cap = ctx.m.limits.resolvePerTradeCap(caps, r.bucket, r.segment);
      if ((r.riskAmount ?? null) !== (cap ?? null)) {
        add("I7", `#${r.id} (${r.bucket}/${r.segment}) follows the cap but holds ${String(r.riskAmount)}, the resolver says ${String(cap)}`);
        continue;
      }
      const expected = ctx.m.riskCap.capR(r.netPnl, cap);
      if ((r.rMultiple ?? null) !== (expected ?? null)) {
        add("I7", `#${r.id} states R ${String(r.rMultiple)}, but ${r.netPnl} ÷ ${String(cap)} is ${String(expected)}`);
      }
    }
  }

  // ── I2 COUNTED-ONCE ───────────────────────────────────────────────────────
  // Capital, the tax base and the AIS sale side must agree with each other, in
  // EVERY view, about the one economic sale each row states.
  const views = [ctx.ids.acctA, ctx.ids.acctB, 0].filter((id, i, a) => a.indexOf(id) === i);
  const per: Record<number, { capital: number; tax: number; sale: number; purchase: number }> = {};
  for (const view of views) {
    if (view > 0 && !accountExists(ctx, view)) continue;
    selectAccount(ctx, view);
    const cap = ctx.m.capital.getCapitalSummary();
    const base = ctx.m.taxItr.getTaxBase();
    const taxTotal = r2(base.cgTrades.reduce((s, t) => s + t.netPnl, 0));
    const ais = await aisTotals(ctx);
    per[view] = { capital: r2(cap.totalRealised), tax: taxTotal, sale: ais.sale, purchase: ais.purchase };
    // (a) two modules, one realised total.
    if (per[view].capital !== taxTotal) {
      add("I2", `account ${view}: the capital summary realises ${per[view].capital}, the tax base ${taxTotal}`);
    }
    // (b) the ONE economic sale rule, stated where everything is visible. The
    //     link is read off the `ipos` row itself: `IpoComputed` deliberately
    //     carries only the link FACTS the form needs, never the trade id.
    if (view === 0) {
      const linkOf = new Map(ctx.t.db.select().from(ctx.t.schema.ipos).all().map((r) => [r.id, r.tradeId ?? null]));
      const closedIds = new Set(base.closedTrades.map((x) => x.id));
      for (const ipo of ctx.m.ipoQ.getIposComputed().rows.filter((r) => r.realised)) {
        const link = linkOf.get(ipo.id) ?? null;
        const own = base.exitedIpos.some((r) => r.id === ipo.id);
        const throughTrade = link != null && closedIds.has(link);
        if (own && throughTrade) {
          add("I2", `IPO #${ipo.id} (${ipo.name}) is realised BOTH on its own row and through holding #${link}`);
        }
        if (!own && !throughTrade) {
          add("I2", `IPO #${ipo.id} (${ipo.name}) is realised nowhere: its own row is excluded and holding #${String(link)} is not counted`);
        }
      }
      // The fixture's own allotment, read the other way round: while its holding
      // is CLOSED in the book and the record also realises its own exit, one
      // sale is stated twice whatever the link column says.
      const holding = rows.find((r) => r.id === ctx.ids.ipoTrade && !r.isOpen);
      const stored = ctx.t.db.select().from(ctx.t.schema.ipos).all().find((r) => r.id === ctx.ids.ipoId);
      if (holding && stored && base.exitedIpos.some((r) => r.id === stored.id)) {
        add("I2", `the allotment is stated twice: holding #${holding.id} is closed in the book and IPO #${stored.id} realises its own exit`);
      }
    }
  }
  // (c) the aggregate view is the sum of the books — a double count shows up
  //     HERE and nowhere on screen (the wave-2L counted-once finding).
  if (per[0] && per[ctx.ids.acctA] && per[ctx.ids.acctB]) {
    for (const key of ["capital", "tax", "sale", "purchase"] as const) {
      const sum = r2(per[ctx.ids.acctA][key] + per[ctx.ids.acctB][key]);
      if (r2(per[0][key]) !== sum) {
        add("I2", `All accounts states ${key} ${per[0][key]}, its two books state ${per[ctx.ids.acctA][key]} + ${per[ctx.ids.acctB][key]} = ${sum}`);
      }
    }
  }

  selectAccount(ctx, selectedBefore);
  return out;
}

/** A violation list, as a failure message names it. */
export const describeViolations = (v: Violation[]) => v.map((x) => `${x.code} ${x.detail}`);
