import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import {
  ORACLE_A1, ORACLE_A2, ORACLE_ALIAS, ORACLE_BUY_DATE, ORACLE_FY, ORACLE_SELL_DATE,
  assertLiveFixture, loadOracleConsumers, oracleParsedFile, oracleReimportTrade,
  oracleIpoPrice, readOracle, resetOracleBook, seedOracleBook, selectOracleAccount,
  type OracleBook, type OracleSnapshot, type OracleView,
} from "./helpers/oracle-book";
import type { NormalizedTrade } from "@/lib/engine/types";

/**
 * THE CROSS-CONSUMER COUNTED-ONCE ORACLE (v4.3.0 wave 3, guard G1).
 *
 * ONE statement that every identity / IPO / tax / capital change must pass:
 *
 *   over a seeded book, every realised SALE is counted EXACTLY ONCE in EVERY
 *   consumer and EVERY view — and it stays counted once after each of the
 *   fifteen stateful operations below, applied one at a time to a fresh copy
 *   of that book, through the REAL code paths.
 *
 * WHY THIS SHAPE. The wave-2H and wave-2I re-checks
 * (LIVE-DESK-RESEARCH/18-FIX-WORK-4.3.0/wave2h-recheck.json, wave2i-recheck.json)
 * found the same two failure modes over and over:
 *
 *   1. a value WRITTEN in one file and READ differently in another — the
 *      counted-once rule existed twice (lib/queries/capital.ts and
 *      lib/queries/tax-itr.ts) and the two copies drifted into reading the LINK
 *      differently, so one sale was stated twice in the capital summary and once
 *      in the tax pack, with nothing on screen saying so;
 *   2. stateful sequences nobody enumerated — delete -> restore -> merge ->
 *      un-merge, sync -> rate edit -> exit edit.
 *
 * A per-file unit test cannot see either. So this guard never asks one module a
 * question: it reads SIX consumers in THREE views off ONE book, and re-reads all
 * eighteen after every operation.
 *
 * ── THE SIX CONSUMERS (found, not assumed) ──────────────────────────────────
 *
 *   capital summary   lib/queries/capital.ts:34   getCapitalSummary
 *                     -> equityRealised / activeRealised / ipoRealised /
 *                        totalRealised -> `available` -> compoundRealised
 *   tax base + pack   lib/queries/tax-itr.ts:36   getTaxBase
 *                     lib/analytics/tax.ts:69     taxByFy   (app/reports/tax/page.tsx:72)
 *   ITR export        lib/queries/tax-itr.ts:96   getItrExportRows / :87 countItrRows
 *   AIS reconcile     app/api/ais/route.ts:25     POST — purchase AND sale sides
 *   /trades KPI       lib/queries/trades.ts:501   tradeStatsOf(getJournalTrades())
 *                     (app/trades/page.tsx:52 `stats`, the KPI strip)
 *   the IPO book      lib/queries/ipos.ts:206     getIpoRealisedNet (no argument —
 *                     /ipos' own total, which must NOT move when a consumer
 *                     stops counting a record)
 *
 * All six read the rule from its ONE home, `ipoIdsCountedThroughTrades`
 * (lib/queries/ipos.ts:186, wave 2L) — which is exactly why an oracle is worth
 * having: the home is shared, the CALLERS are not, and each caller chooses its
 * own `countedTradeIds` set.
 *
 * ── THE THREE VIEWS ─────────────────────────────────────────────────────────
 *
 * Account 1, account 2, and All accounts — selected the way the app selects
 * them (`settings.selected_account_id`, read by `getSelectedAccountId()`,
 * invariant 8). All accounts is NOT the sum of the two: the fixture's legacy
 * cross-account record is counted in account 1 (its holding is not in that
 * view) and excluded from All accounts (its holding is). A guard that asserted
 * additivity would be demanding the double count back.
 *
 * ── WHAT IS PINNED, AND HOW IT COULD BE WRONG ───────────────────────────────
 *
 * Two layers, both re-run after every operation:
 *
 *   - `assertAgreement` — the identities that must hold in ANY state, each
 *     between two consumers that apply the rule in DIFFERENT FILES. The
 *     strongest is `deliveryConsideration == the AIS sale total`:
 *     lib/queries/tax-itr.ts and app/api/ais/route.ts each decide which sales
 *     to count, independently; if either stops applying the rule they part
 *     company here and nowhere else.
 *   - the per-view expectation table, stated in tests/helpers/oracle-book.ts
 *     from the fixture's own arithmetic (every trade row states its money) and
 *     written out in that file's header. The one thing the fixture does NOT
 *     state is what an IPO exit is WORTH — `computeIpo` prices it through the
 *     real charges engine and `charge_config` (invariant 3), and
 *     re-implementing that here would be a test agreeing with itself. So the
 *     fixture states WHICH rows count (the rule under test) and reads WHAT each
 *     is worth once; `assertLiveFixture` pins each record's GROSS (pure
 *     arithmetic) and that all three nets differ from each other and from every
 *     trade net, so no assertion can pass by two figures colliding.
 *
 * ── ONE DATABASE, FRESH BOOK PER OPERATION ──────────────────────────────────
 *
 * ONE temp database for this FILE (AGENTS.md Testing). A second `openTempDb()`
 * would silently reuse the first, and an in-memory `new Database(buffer)` copy
 * per scenario cannot be handed to `lib/queries/*` — `lib/db` caches its
 * connection on `globalThis`, so the product would keep reading the file. Each
 * operation therefore gets a book that is fresh because `resetOracleBook`
 * EMPTIES the journal first: the All-accounts view reads every account, so a
 * leftover book from the previous scenario would be counted into it.
 *
 * RED ON DEMAND (2026-09-15), two probes, each a deleted tests/zzprobe-* copy of
 * THIS file with one `vi.mock` appended. No product file was touched.
 *
 *   1. the rule REMOVED from its one home — the pre-wave-2H behaviour, where no
 *      consumer excludes anything:
 *        vi.mock("@/lib/queries/ipos", … ipoIdsCountedThroughTrades: () => new Set(),
 *                getIpoRealisedNet: () => orig.getIpoRealisedNet({}))
 *      14 of the 16 `it`s went red, including every operation but one. Green:
 *      "is live" (it states fixture facts, not counts) and "purge account 2" —
 *      after that purge the legacy record's holding is GONE, so there is nothing
 *      left for the rule to exclude and both builds agree. That is the guard
 *      telling the truth, not a hole.
 *   2. a ONE-SIDED drift, to falsify `assertAgreement` on its own — only the AIS
 *      route buckets a sale by FY through lib/analytics/ais#fyOfDate:
 *        vi.mock("@/lib/analytics/ais", … fyOfDate: () => "2099-00")
 *      "at rest · account 1: the ITR export and the AIS sale side name the same
 *       sales: expected 29200 to be +0"
 *      — i.e. the identity fires BEFORE the expectation table, naming the two
 *      files that disagreed.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const NO_STATE = { ok: false, message: "" };

let t: TempDb;
let book: OracleBook;
let actions: typeof import("@/app/trades/actions");
let trash: typeof import("@/lib/trash");
let ipoRoute: typeof import("@/app/api/ipos/route");
let accountDelete: typeof import("@/lib/queries/account-delete");
let dataFixes: typeof import("@/lib/db/data-fixes");
let importer: typeof import("@/lib/import/commit");
let lots: typeof import("@/lib/import/close-open-lots");

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn }));

// Re-measured 2026-09-16 with wave 2O's D4 case added (18 `it`s): the slowest is
// 140 ms ("the oracle at rest"), the new one 97 ms, wall clock 4.0 s.
// Measured locally 2026-09-15 (vitest's own per-test times, 16 `it`s): the
// slowest `it` is 105 ms ("the oracle at rest"), then 97, 96, 95; the 16 sum to
// ~1.4 s and the file's wall clock is 3.3 s, the rest of it this hook (migrate +
// seed + eleven dynamic imports). Each `it`'s time INCLUDES its `beforeEach` —
// the whole book wiped and re-seeded, with the real `pushTradeToIpoAction` and a
// real /trades delete inside it. All well inside the local budget of <= 300 ms
// per `it` and <= 3 s per hook; the raised timeouts are for the Windows runner,
// measured > 15x slower on SQLite-file work (AGENTS.md Testing).
beforeAll(async () => {
  t = await openTempDb("oracle-counted-once", { seed: true });
  await loadOracleConsumers();
  actions = await import("@/app/trades/actions");
  trash = await import("@/lib/trash");
  ipoRoute = await import("@/app/api/ipos/route");
  accountDelete = await import("@/lib/queries/account-delete");
  dataFixes = await import("@/lib/db/data-fixes");
  importer = await import("@/lib/import/commit");
  lots = await import("@/lib/import/close-open-lots");
}, 120_000);

afterAll(() => t?.cleanup());

/** A fresh copy of the book for every `it` — see the header. */
beforeEach(async () => {
  resetOracleBook(t);
  book = await seedOracleBook(t);
}, 60_000);

// ── the driving helpers, all real code paths ────────────────────────────────

const rowOf = (id: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.id, id)).get();
const rowsIn = (accountId: number) => t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, accountId)).all();
const ipoRowOf = (id: number) => t.db.select().from(t.schema.ipos).where(eq(t.schema.ipos.id, id)).get();

/** The /trades bulk delete, through the real server action. */
async function deleteTrades(ids: number[]): Promise<string> {
  const fd = new FormData();
  fd.set("ids", ids.join(","));
  const res = await actions.deleteTradesAction(NO_STATE, fd);
  expect(res.ok, res.message).toBe(true);
  return trash.listTrashSnapshots()[0]!.id;
}
const restore = (id: string) => {
  const res = trash.restoreTrashSnapshot(id, "oracle");
  expect(res.ok, res.message).toBe(true);
  return res;
};
/** DELETE /api/ipos — the /ipos row delete. It writes NO Trash snapshot. */
async function deleteIpo(id: number) {
  const res = await ipoRoute.DELETE(new Request(`http://local/api/ipos?id=${id}`, { method: "DELETE" }));
  expect([res.status, ((await res.json()) as { ok: boolean }).ok]).toEqual([200, true]);
}
/** POST /api/ipos with the row's own stored values, plus the user's edit. */
async function saveIpo(id: number, over: Record<string, unknown>) {
  const r = ipoRowOf(id)!;
  const body = {
    id, name: r.name, broker: r.broker, exchange: r.exchange, board: r.board, category: r.category,
    discountPerShare: r.discountPerShare, appliedPrice: r.appliedPrice, lotSize: r.lotSize,
    lotsApplied: r.lotsApplied, allotted: r.allotted, allottedQty: r.allottedQty,
    listingPrice: r.listingPrice, exitPrice: r.exitPrice, appliedDate: r.appliedDate,
    allotmentDate: r.allotmentDate, listingDate: r.listingDate, exitDate: r.exitDate,
    notes: r.notes, ...over,
  };
  const res = await ipoRoute.POST(
    new Request("http://local/api/ipos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  const json = (await res.json()) as { ok: boolean; message: string };
  expect([res.status, json.ok], json.message).toEqual([200, true]);
  return json;
}

/** Replace whole fields of one or more views; every other field must not move. */
function patch(base: OracleSnapshot, over: Partial<Record<keyof OracleSnapshot, Partial<OracleView>>>): OracleSnapshot {
  const next = JSON.parse(JSON.stringify(base)) as OracleSnapshot;
  for (const [view, fields] of Object.entries(over) as [keyof OracleSnapshot, Partial<OracleView>][]) {
    Object.assign(next[view], fields);
  }
  return next;
}
/** The view a book with no rows at all reads as (a purged / merged-away account). */
const EMPTY_VIEW: OracleView = {
  capital: { equityRealised: 0, activeRealised: 0, ipoRealised: 0, totalRealised: 0 },
  taxNets: [], ipoNames: [], itrScrips: [], itrCount: 0,
  deliveryConsideration: 0, deliveryCost: 0,
  fyRealised: {}, ais: {}, kpi: { count: 0, open: 0, net: 0 }, ipoBookNet: 0,
};

// ── layer 1: the identities that hold in EVERY state ────────────────────────

/**
 * Each of these holds two consumers against each other, and each pair decides
 * WHICH sales to count in a DIFFERENT FILE. None of them is derivable from the
 * fixture, so they stay true after an operation nobody predicted.
 */
function assertAgreement(where: string, v: OracleView): void {
  expect(v.itrScrips.length, `${where}: the ITR export states one row per row it counted`).toBe(v.itrCount);
  expect(v.taxNets.length, `${where}: every gain the tax base holds is exported`).toBe(v.itrCount);
  expect(r2(sum(v.taxNets)), `${where}: the tax base (tax-itr.ts) and the capital summary (capital.ts) counted the same set`)
    .toBe(v.capital.totalRealised);
  expect(r2(sum(Object.values(v.fyRealised))), `${where}: taxByFy (analytics/tax.ts) counted the same set`)
    .toBe(v.capital.totalRealised);
  expect(r2(v.capital.equityRealised + v.capital.activeRealised + v.capital.ipoRealised), `${where}: the capital summary's own parts`)
    .toBe(v.capital.totalRealised);
  // THE cross-file one: lib/queries/tax-itr.ts and app/api/ais/route.ts each
  // decide which sales the view counted. They agree only while both apply the
  // counted-once rule to the same set.
  expect(v.deliveryConsideration, `${where}: the ITR export and the AIS sale side name the same sales`)
    .toBe(v.ais[`${ORACLE_FY} sale`] ?? 0);
}

async function readAndCheck(label: string): Promise<OracleSnapshot> {
  const snap = await readOracle(t);
  assertAgreement(`${label} · account 1`, snap.a1);
  assertAgreement(`${label} · account 2`, snap.a2);
  assertAgreement(`${label} · All accounts`, snap.all);
  return snap;
}

// ============================================================================
// the fixture itself
// ============================================================================

describe("the book the oracle is stated over", () => {
  it("is live: the link is the product's own write, the legacy row crosses the account boundary, and no two figures collide", () => {
    assertLiveFixture(book);
    const { ids } = book;
    // The link under test came from app/trades/actions.ts pushTradeToIpoAction,
    // not from an insert imitating it — and it landed in the HOLDING's account
    // (F8, wave 2I), never the schema default of 1.
    const linked = ipoRowOf(ids.linkedIpo)!;
    expect([linked.accountId, linked.tradeId, linked.name], "the real push").toEqual([ORACLE_A2, ids.a2IpoHolding, "A2IPOH"]);
    expect(rowOf(ids.a2IpoHolding)!.acquisition, "and it marked the holding's provenance").toBe("ipo");
    // The LEGACY shape the startup data fix exists for: the record in account 1,
    // its holding in account 2.
    const legacy = ipoRowOf(ids.legacyIpo)!;
    expect([legacy.accountId, rowOf(legacy.tradeId!)!.accountId], "the legacy cross-account link").toEqual([ORACLE_A1, ORACLE_A2]);
    // The Data Quality join's shape, and the sale its alias names, in Trash.
    expect(rowOf(ids.a1Join)!.importNotes).toContain(`dedup-alias:${ORACLE_ALIAS}`);
    expect(trash.listTrashSnapshots().map((s) => s.id)).toContain(ids.a1JoinSaleSnapshot);
    // A STATED funded 0 beside one that states nothing (F1/F16, waves 2H-2L).
    expect([rowOf(ids.a1MtfZero)!.mtfFundedAmount, rowOf(ids.a1MtfNull)!.mtfFundedAmount]).toEqual([0, null]);
    // A staged parent holding the aggregate, with one exit leg (invariant 5).
    const legs = t.db.select().from(t.schema.tradeLegs).where(eq(t.schema.tradeLegs.tradeId, ids.a1Staged)).all();
    expect([rowOf(ids.a1Staged)!.staged, legs.length, legs.filter((l) => l.kind === "exit").length]).toEqual([true, 3, 1]);
    // And a partly closed holding: 100 bought, 60 sold, still open.
    expect([rowOf(ids.a1Part)!.buyQty, rowOf(ids.a1Part)!.sellQty, rowOf(ids.a1Part)!.isOpen]).toEqual([100, 60, true]);
  });

  it("the oracle at rest: six consumers, three views, every sale counted exactly once", async () => {
    expect(await readAndCheck("at rest")).toEqual(book.expected);
  });

  it("All accounts is NOT the sum of the two books, and that IS the rule working", async () => {
    const s = await readOracle(t);
    // ORACLE-LEGACY (account 1) names a holding in account 2. Account 1 counts
    // the record (the holding is not in view), account 2 counts the holding (the
    // record is not in view) — and All accounts counts the HOLDING and leaves
    // the record out. One economic sale, stated once in all three.
    expect(s.a1.capital.ipoRealised, "account 1 counts the legacy record").toBe(book.ipoNet.legacy);
    expect(s.all.capital.ipoRealised, "All accounts does not").toBe(book.ipoNet.loose);
    expect(s.all.capital.totalRealised, "so the aggregate is NOT a1 + a2")
      .not.toBe(r2(s.a1.capital.totalRealised + s.a2.capital.totalRealised));
    // The sale itself is stated once in every one of them: 1,500 of
    // consideration for A2SOLD, never 3,000.
    expect(s.all.itrScrips.filter((x) => x === "A2SOLD" || x === "ORACLE-LEGACY (IPO)")).toEqual(["A2SOLD"]);
  });
});

// ============================================================================
// the state machine — one operation per `it`, each on a fresh book
// ============================================================================

interface Op {
  name: string;
  /** Apply the operation through the real code path and state what must follow. */
  run: (b: OracleBook, base: OracleSnapshot) => Promise<OracleSnapshot>;
}

const OPS: Op[] = [
  {
    // The holding goes; its record is unlinked and kept. The sale does not
    // vanish and it does not double: it is now stated by the RECORD instead of
    // the trade. So the counted row set is the same size, the ITR scrip changes
    // from the holding to "A2IPOH (IPO)", and BOTH AIS sides are untouched —
    // 1,000 of purchase and 1,500 of sale, once, either way.
    // The realised NET does move (490.25 -> 497.95): the two rows state their
    // charges differently — the trade's 9.75 is the broker's bill as imported,
    // the record's is the engine's on the statutory columns, since
    // pushTradeToIpoAction seeds no broker. A different bill for the same sale
    // is not a second sale.
    name: "delete the linked holding on /trades",
    run: async (b, base) => {
      await deleteTrades([b.ids.a2IpoHolding]);
      expect(ipoRowOf(b.ids.linkedIpo)!.tradeId, "the delete unlinked the record and kept it").toBeNull();
      const a2Ipo = r2(b.ipoNet.linked + b.ipoNet.loose);
      return patch(base, {
        a2: {
          capital: { equityRealised: 490.25, activeRealised: 0, ipoRealised: a2Ipo, totalRealised: r2(490.25 + a2Ipo) },
          taxNets: [490.25, b.ipoNet.linked, b.ipoNet.loose].sort((x, y) => x - y),
          ipoNames: ["A2IPOH", "ORACLE-LOOSE"],
          itrScrips: ["A2IPOH (IPO)", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          fyRealised: { [ORACLE_FY]: r2(490.25 + a2Ipo) },
          kpi: { count: 1, open: 0, net: 490.25 },
        },
        all: {
          capital: { equityRealised: 6142.5, activeRealised: 0, ipoRealised: a2Ipo, totalRealised: r2(6142.5 + a2Ipo) },
          taxNets: [192, 490.25, 490.25, 4970, b.ipoNet.linked, b.ipoNet.loose].sort((x, y) => x - y),
          ipoNames: ["A2IPOH", "ORACLE-LOOSE"],
          itrScrips: ["A1JOIN", "A1SOLD1", "A1SOLD2", "A2IPOH (IPO)", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          fyRealised: { [ORACLE_FY]: r2(6142.5 + a2Ipo) },
          kpi: { count: 9, open: 5, net: 6451.5 },
        },
      });
    },
  },
  {
    // The round trip: `ipoRefs` (wave 2J/2K) carries the broken link in the
    // envelope, so the restore re-points it and every one of the eighteen
    // readings is the one it was before.
    name: "delete the linked holding, then restore it",
    run: async (b, base) => {
      const snapshotId = await deleteTrades([b.ids.a2IpoHolding]);
      expect(restore(snapshotId).restored).toBe(1);
      expect(ipoRowOf(b.ids.linkedIpo)!.tradeId, "the restore re-linked it").toBe(b.ids.a2IpoHolding);
      return base;
    },
  },
  {
    // DELETE /api/ipos writes no Trash snapshot, so the record does not come
    // back — only the trade does. Everything except /ipos' own book total is
    // therefore the baseline: the sale was already being counted through the
    // holding, and the record it was counted INSTEAD of is simply gone.
    name: "delete the IPO record, then the holding, then restore the holding",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A2);
      await deleteIpo(b.ids.linkedIpo);
      const snapshotId = await deleteTrades([b.ids.a2IpoHolding]);
      expect(restore(snapshotId).restored).toBe(1);
      expect(ipoRowOf(b.ids.linkedIpo), "the record is gone for good").toBeUndefined();
      return patch(base, {
        a2: { ipoBookNet: b.ipoNet.loose },
        all: { ipoBookNet: r2(b.ipoNet.loose + b.ipoNet.legacy) },
      });
    },
  },
  {
    // The other order, which is the one that can go wrong: the delete unlinks
    // the record and writes an `ipoRefs` entry naming it, the record is then
    // destroyed, and the restore must re-link a record that no longer exists —
    // without throwing and without leaving the holding uncounted.
    name: "delete the holding, then the IPO record, then restore the holding",
    run: async (b, base) => {
      const snapshotId = await deleteTrades([b.ids.a2IpoHolding]);
      selectOracleAccount(t, ORACLE_A2);
      await deleteIpo(b.ids.linkedIpo);
      expect(restore(snapshotId).restored).toBe(1);
      expect(ipoRowOf(b.ids.linkedIpo), "the record is gone for good").toBeUndefined();
      return patch(base, {
        a2: { ipoBookNet: b.ipoNet.loose },
        all: { ipoBookNet: r2(b.ipoNet.loose + b.ipoNet.legacy) },
      });
    },
  },
  {
    // Nothing collides, so both holdings move. Account 1 becomes the whole book
    // — and the LEGACY record, which counted its own sale while its holding was
    // in another account, must stop counting it now that the holding is beside
    // it. That is the merge's own counted-once obligation, and it is why the
    // merged account 1 reads EXACTLY what All accounts read before it.
    name: "merge account 2 into account 1",
    run: async (_b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const res = accountDelete.deleteAccount({ accountId: ORACLE_A2, mode: "merge", targetId: ORACLE_A1, connections: "delete", source: "test" });
      expect([res.ok, res.skippedTrades], res.message).toEqual([true, 0]);
      expect(res.message).toBe("Merged “oracle 2” into “Primary” — 2 trades moved.");
      return patch(base, { a1: base.all, a2: EMPTY_VIEW });
    },
  },
  {
    // A clean merge discards no trade, so its envelope carries the ACCOUNT and
    // nothing else: the restore re-creates "oracle 2" empty and the book stays
    // merged. The property being guarded is that un-merging cannot resurrect a
    // second copy of a sale that already moved — All accounts must not move.
    name: "merge account 2 into account 1, then restore the source snapshot",
    run: async (_b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const res = accountDelete.deleteAccount({ accountId: ORACLE_A2, mode: "merge", targetId: ORACLE_A1, connections: "delete", source: "test" });
      expect(res.ok, res.message).toBe(true);
      const back = trash.restoreTrashSnapshot(res.snapshotId!, "oracle");
      expect([back.ok, back.restored], back.message).toEqual([true, 0]);
      expect(back.message, "the account comes back; its trades are already in the target").toContain("was recreated");
      return patch(base, { a1: base.all, a2: EMPTY_VIEW });
    },
  },
  {
    // Account 2 and everything it owned is destroyed. The LEGACY record in
    // account 1 now names a trade that is GONE — "the link is history, not a
    // destination" — so it counts its own sale once, in every remaining view,
    // and All accounts reads what account 1 reads.
    name: "purge account 2",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const res = accountDelete.deleteAccount({ accountId: ORACLE_A2, mode: "purge", connections: "delete", source: "test" });
      expect(res.ok, res.message).toBe(true);
      expect(rowOf(b.ids.a2Sold), "the legacy record's holding is gone").toBeUndefined();
      return patch(base, { a2: EMPTY_VIEW, all: base.a1 });
    },
  },
  {
    // …and back. The purge's own `ipos` rows ride inside the envelope with
    // `trade_id` intact, the legacy record in ANOTHER account was unlinked and
    // recorded in `ipoRefs`, and the restore re-points it — so all eighteen
    // readings are the ones the book started with.
    name: "purge account 2, then restore it",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const res = accountDelete.deleteAccount({ accountId: ORACLE_A2, mode: "purge", connections: "delete", source: "test" });
      expect(res.ok, res.message).toBe(true);
      const back = restore(res.snapshotId!);
      expect(back.restored, back.message).toBe(2);
      expect(ipoRowOf(b.ids.legacyIpo)!.tradeId, "the cross-account link is re-pointed, not left null").toBe(b.ids.a2Sold);
      return base;
    },
  },
  {
    /**
     * D4 (v4.3.0 fix wave 2O, re-check finding identity#0) — A RESTORE THAT
     * CANNOT BRING A HOLDING BACK LEAVES ITS IPO RECORD UNLINKED.
     *
     * The purge snapshots account 2's OWN `ipos` rows into `accountRows.ipos`,
     * and that replay was the one restore path with no gate on what landed (the
     * `ipoRefs` and ledger loops both skip a trade that did not come back, and
     * lib/trash.ts:792 states the rule: "a link onto a row this restore did not
     * bring back is not this restore's to make"). So when the holding cannot come
     * back — its id is taken, the shape a snapshot restored against a database
     * whose rowids came from elsewhere reaches — the record came back naming
     * WHATEVER now holds that id: /trades badged that unrelated row, and the
     * record's own sale left every consumer, because the counted-once rule read
     * it as "counted through" a trade that is not its holding.
     *
     * The record must come back UNLINKED instead (it is the user's own record —
     * invariant 10), which is the same state the /trades delete of that holding
     * leaves: the sale is stated by the RECORD instead of the trade, once.
     */
    name: "purge account 2, then restore it with the IPO holding's id taken",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const res = accountDelete.deleteAccount({ accountId: ORACLE_A2, mode: "purge", connections: "delete", source: "test" });
      expect(res.ok, res.message).toBe(true);
      // The freed id, taken in account 1 by an OPEN purchase — no realised money,
      // so what the eighteen readings gain is one open row and 1,000 of AIS
      // purchase, and everything else is about the record that lost its holding.
      t.db
        .insert(t.schema.trades)
        .values(
          tradeRow({
            id: b.ids.a2IpoHolding, accountId: ORACLE_A1, broker: "zerodha", segment: "eq_delivery",
            symbol: "A1TAKEN", tradingsymbol: "A1TAKEN",
            buyQty: 20, avgBuyPrice: 50, buyValue: 1000, buyDate: ORACLE_BUY_DATE,
            sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null,
            grossPnl: 0, chargesTotal: 0, netPnl: 0, isOpen: true,
          }),
        )
        .run();
      const back = trash.restoreTrashSnapshot(res.snapshotId!, "oracle");
      expect([back.ok, back.restored], back.message).toEqual([true, 1]);
      expect(back.skipped.map((s) => s.id), "the holding's id belongs to another trade now").toEqual([b.ids.a2IpoHolding]);
      // THE assertion. On HEAD: the id of A1TAKEN — an open purchase in the other
      // book — so `getIpoTradeLinks()` badged it and the record's own ₹497.95
      // left capital, the tax base, the ITR export and both AIS sides.
      expect(ipoRowOf(b.ids.linkedIpo)!.tradeId, "its holding is not in the journal, so it names nothing").toBeNull();
      expect(back.message, "and the restore says what it could not do").toContain("1 IPO record came back unlinked");
      const a2Ipo = r2(b.ipoNet.linked + b.ipoNet.loose);
      const openPurchase = (v: OracleView): Partial<OracleView> => ({
        ais: { ...v.ais, [`${ORACLE_FY} purchase`]: (v.ais[`${ORACLE_FY} purchase`] ?? 0) + 1000 },
        kpi: { count: v.kpi.count + 1, open: v.kpi.open + 1, net: v.kpi.net },
      });
      return patch(base, {
        a1: openPurchase(base.a1),
        // Exactly the state the /trades delete of that holding leaves (above):
        // the sale is stated by the record, once.
        a2: {
          capital: { equityRealised: 490.25, activeRealised: 0, ipoRealised: a2Ipo, totalRealised: r2(490.25 + a2Ipo) },
          taxNets: [490.25, b.ipoNet.linked, b.ipoNet.loose].sort((x, y) => x - y),
          ipoNames: ["A2IPOH", "ORACLE-LOOSE"],
          itrScrips: ["A2IPOH (IPO)", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          fyRealised: { [ORACLE_FY]: r2(490.25 + a2Ipo) },
          kpi: { count: 1, open: 0, net: 490.25 },
        },
        all: {
          ...openPurchase(base.all),
          capital: { equityRealised: 6142.5, activeRealised: 0, ipoRealised: a2Ipo, totalRealised: r2(6142.5 + a2Ipo) },
          taxNets: [192, 490.25, 490.25, 4970, b.ipoNet.linked, b.ipoNet.loose].sort((x, y) => x - y),
          ipoNames: ["A2IPOH", "ORACLE-LOOSE"],
          itrScrips: ["A1JOIN", "A1SOLD1", "A1SOLD2", "A2IPOH (IPO)", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          fyRealised: { [ORACLE_FY]: r2(6142.5 + a2Ipo) },
          kpi: { count: 10, open: 6, net: 6451.5 },
        },
      });
    },
  },
  {
    // The same file again. The holding carries exactly this row's dedup hash,
    // so the importer recognises it and stores nothing — and not one of the
    // eighteen readings moves.
    name: "re-import the linked holding's sale file, same hash",
    run: async (_b, base) => {
      const res = importer.commitParsedFile(oracleParsedFile([oracleReimportTrade()]), "oracle-reimport-same", null, ORACLE_A2);
      expect([res.added, res.skipped], "the import reads its own identity").toEqual([0, 1]);
      return base;
    },
  },
  {
    // The same sale in a file that states it differently (a day later), so the
    // identity does not match and a SECOND closed row is stored. The journal
    // cannot know these are one sale — but what it must not do is lose count of
    // the IPO: the record's holding is still counted, so the record stays
    // excluded, and the book gains exactly ONE row in every consumer.
    // The new row's charges are the engine's (invariant 3), so its net is read
    // off the stored row; its GROSS and consideration are the file's own.
    name: "re-import the linked holding's sale under ANOTHER hash",
    run: async (b, base) => {
      const res = importer.commitParsedFile(
        oracleParsedFile([oracleReimportTrade({ sellDate: "2025-09-22" })]), "oracle-reimport-other", null, ORACLE_A2,
      );
      expect([res.added, res.skipped], "a file that states the sale differently is a new row").toEqual([1, 0]);
      const dupe = t.db.select().from(t.schema.trades).where(eq(t.schema.trades.accountId, ORACLE_A2)).all().at(-1)!;
      expect([dupe.grossPnl, dupe.sellValue, dupe.buyValue], "the duplicate states the file's own money").toEqual([500, 1500, 1000]);
      const n = r2(dupe.netPnl);
      return patch(base, {
        a2: {
          capital: { equityRealised: r2(980.5 + n), activeRealised: 0, ipoRealised: b.ipoNet.loose, totalRealised: r2(980.5 + n + b.ipoNet.loose) },
          taxNets: [490.25, 490.25, n, b.ipoNet.loose].sort((x, y) => x - y),
          itrScrips: ["A2IPOH", "A2IPOH", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          itrCount: 4,
          deliveryConsideration: 5900,
          deliveryCost: 4000,
          fyRealised: { [ORACLE_FY]: r2(980.5 + n + b.ipoNet.loose) },
          ais: { [`${ORACLE_FY} purchase`]: 4000, [`${ORACLE_FY} sale`]: 5900 },
          kpi: { count: 3, open: 0, net: r2(980.5 + n) },
        },
        all: {
          capital: { equityRealised: r2(6632.75 + n), activeRealised: 0, ipoRealised: b.ipoNet.loose, totalRealised: r2(6632.75 + n + b.ipoNet.loose) },
          taxNets: [192, 490.25, 490.25, 490.25, 4970, n, b.ipoNet.loose].sort((x, y) => x - y),
          itrScrips: ["A1JOIN", "A1SOLD1", "A1SOLD2", "A2IPOH", "A2IPOH", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          itrCount: 7,
          deliveryConsideration: 33600,
          deliveryCost: 26000,
          fyRealised: { [ORACLE_FY]: r2(6632.75 + n + b.ipoNet.loose) },
          ais: { [`${ORACLE_FY} purchase`]: 52000, [`${ORACLE_FY} sale`]: 33600 },
          // The KPI strip sums EVERY row, so the five open ones (115 + 194) are
          // in this figure and the duplicate adds itself to the baseline's.
          kpi: { count: 11, open: 5, net: r2(6941.75 + n) },
        },
      });
    },
  },
  {
    // lib/db/data-fixes.ts applyIpoAccountRehome files the LEGACY record in its
    // holding's account. THE property: it moves a record between two books and
    // ALL ACCOUNTS DOES NOT MOVE — because that view already counted the sale
    // through the holding. Account 1 loses a record it was rightly counting
    // (the holding is not in that view), account 2 gains one it must NOT count
    // (the holding is), and the one sale stays stated once everywhere.
    name: "run the startup data fix (the legacy IPO is re-homed)",
    run: async (b, base) => {
      const results = dataFixes.rerunDataFixesAfterRestore(t.sqlite);
      expect(results.find((r) => r.name === "ipo-account-rehome-v1"), "the re-home ran and moved one row")
        .toMatchObject({ applied: true, rekeyed: 1 });
      expect(ipoRowOf(b.ids.legacyIpo)!.accountId, "filed where its holding is").toBe(ORACLE_A2);
      return patch(base, {
        a1: {
          capital: { equityRealised: 5652.25, activeRealised: 0, ipoRealised: 0, totalRealised: 5652.25 },
          taxNets: [192, 490.25, 4970],
          ipoNames: [],
          itrScrips: ["A1JOIN", "A1SOLD1", "A1SOLD2"],
          itrCount: 3,
          deliveryConsideration: 27700,
          deliveryCost: 22000,
          fyRealised: { [ORACLE_FY]: 5652.25 },
          ais: { [`${ORACLE_FY} purchase`]: 48000, [`${ORACLE_FY} sale`]: 27700 },
          ipoBookNet: 0,
        },
        a2: { ipoBookNet: r2(b.ipoNet.linked + b.ipoNet.loose + b.ipoNet.legacy) },
      });
    },
  },
  {
    // The user raises the linked record's exit to 160 on /ipos. The route syncs
    // the holding (J4/L3: it owns the close it wrote), so the SALE is restated
    // — once. 1,600 of consideration in the ITR export and 1,600 on the AIS
    // sale side, never 1,500 + 1,600, and `ipoRealised` still 0 for that record.
    // The stored charges stay the holding's own 9.75 (the exit charges are not
    // re-priced at today's rates — lib/analytics/ipo-link.ts IPO_SYNC_CHARGES_NOTE),
    // so the net is the fixture's arithmetic: 1600 − 1000 − 9.75 = 590.25.
    name: "an IPO exit edit through POST /api/ipos",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A2);
      const res = await saveIpo(b.ids.linkedIpo, { exitPrice: 160, exitDate: ORACLE_SELL_DATE });
      expect(res.message).toContain("the linked holding");
      const holding = rowOf(b.ids.a2IpoHolding)!;
      expect([holding.sellValue, holding.chargesTotal, holding.netPnl], "one sale, restated on the holding")
        .toEqual([1600, 9.75, 590.25]);
      // /ipos' OWN total moves with the record it re-priced. Its gross is
      // arithmetic — (160 − 100) × 10 = 600 — and its charges are the engine's.
      const priced = oracleIpoPrice(t, b.ids.linkedIpo);
      expect(priced.grossPnl, "the record's own gross on the new exit").toBe(600);
      return patch(base, {
        a2: {
          capital: { equityRealised: 1080.5, activeRealised: 0, ipoRealised: b.ipoNet.loose, totalRealised: r2(1080.5 + b.ipoNet.loose) },
          taxNets: [490.25, 590.25, b.ipoNet.loose].sort((x, y) => x - y),
          deliveryConsideration: 4500,
          fyRealised: { [ORACLE_FY]: r2(1080.5 + b.ipoNet.loose) },
          ais: { [`${ORACLE_FY} purchase`]: 3000, [`${ORACLE_FY} sale`]: 4500 },
          kpi: { count: 2, open: 0, net: 1080.5 },
          ipoBookNet: r2(priced.netPnl + b.ipoNet.loose),
        },
        all: {
          capital: { equityRealised: 6732.75, activeRealised: 0, ipoRealised: b.ipoNet.loose, totalRealised: r2(6732.75 + b.ipoNet.loose) },
          taxNets: [192, 490.25, 490.25, 590.25, 4970, b.ipoNet.loose].sort((x, y) => x - y),
          deliveryConsideration: 32200,
          fyRealised: { [ORACLE_FY]: r2(6732.75 + b.ipoNet.loose) },
          ais: { [`${ORACLE_FY} purchase`]: 51000, [`${ORACLE_FY} sale`]: 32200 },
          kpi: { count: 10, open: 5, net: 7041.75 }, // 6941.75 + the extra ₹100 on the sale
          ipoBookNet: r2(priced.netPnl + b.ipoNet.loose + b.ipoNet.legacy),
        },
      });
    },
  },
  {
    /**
     * D1 (v4.3.0 fix wave 2N, re-check finding counted-once#1) — AN EXITED
     * RECORD BESIDE AN OPEN UNLINKED IPO HOLDING.
     *
     * A 4.2.x Trash envelope carries no `ipoRefs`, so the restore falls back to
     * the book's own records. Tier A compared the record's name and quantity and
     * never asked whether the holding SOLD, so an exited record was attached to
     * a position that is still held: the double count it was meant to settle
     * survived untouched, both Data Quality warnings that had named it were
     * silenced, and the next save of that record on /ipos would have closed the
     * position with a sale it never had (`tradePatchFromIpo` writes sellQty /
     * avgSellPrice / sellValue / sellDate / isOpen:false).
     *
     * ORACLE-LOOSE states an exit of its own and is realised on its own row.
     * The open holding beside it realises nothing. The restore must write
     * nothing and the ask must not claim a second sale — and all eighteen
     * readings must be the baseline plus exactly one open purchase.
     */
    name: "restore an OPEN unlinked IPO holding from a 4.2.x envelope, beside an exited record",
    run: async (b, base) => {
      selectOracleAccount(t, ORACLE_A2);
      const held = t.db
        .insert(t.schema.trades)
        .values(
          tradeRow({
            accountId: ORACLE_A2, broker: "zerodha", segment: "eq_delivery",
            symbol: "ORACLE-LOOSE", tradingsymbol: "ORACLE-LOOSE",
            buyQty: 20, avgBuyPrice: 50, buyValue: 1000, buyDate: ORACLE_BUY_DATE,
            sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null,
            grossPnl: 0, chargesTotal: 0, netPnl: 0, isOpen: true,
            acquisition: "ipo", acquisitionPrice: 50, acquisitionDate: ORACLE_BUY_DATE,
          }),
        )
        .returning({ id: t.schema.trades.id })
        .get()!.id;
      const snapshotId = await deleteTrades([held]);
      // The 4.2.x shape: the field did not exist, so it is DELETED, not emptied.
      const p = path.join((await import("@/lib/db")).trashDir, snapshotId, "snapshot.json");
      const env = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      expect(env.ipoRefs, "a 4.3 delete that broke no link STATES the empty list (D1)").toEqual([]);
      delete env.ipoRefs;
      fs.writeFileSync(p, JSON.stringify(env));
      expect(restore(snapshotId).restored).toBe(1);

      // THE assertion. Measured on the wave-2L/2M module: the record was linked
      // to `held`, so it stopped being realised on its own row — a ₹1,381.xx
      // realised net, an ITR row and 1,400 of AIS sale consideration gone, with
      // both questions that named it silenced.
      expect(ipoRowOf(b.ids.looseIpo)!.tradeId, "an exit is no allotment's record until that allotment sold").toBeNull();
      const dq = await import("@/lib/queries/data-quality");
      const issue = dq.getDataQualityReport().issues.find((x) => x.code === `ipo_record_link:${held}`);
      expect(issue?.title, "the pair is named").toBe("IPO record not linked to its holding");
      expect(issue!.detail).toContain("this holding records no sale, so the record's exit is the only one stated");
      expect(issue!.detail, "and no second sale is claimed").not.toContain("counted once in IPOs and again");

      // The book gains one OPEN purchase of 1,000 and nothing else: no realised
      // figure moves, the KPI strip counts every row so it gains one open row
      // with a stated net of 0, and the AIS purchase side counts every purchase.
      const openPurchase = (v: OracleView): Partial<OracleView> => ({
        ais: { ...v.ais, [`${ORACLE_FY} purchase`]: (v.ais[`${ORACLE_FY} purchase`] ?? 0) + 1000 },
        kpi: { count: v.kpi.count + 1, open: v.kpi.open + 1, net: v.kpi.net },
      });
      return patch(base, { a2: openPurchase(base.a2), all: openPurchase(base.all) });
    },
  },
  {
    // The remaining 40 of the partly closed holding are sold at 15. The row was
    // OPEN, so every realised consumer was skipping its stated 115.00; it now
    // classifies for the first time and must appear ONCE in each of them — a
    // new ITR row, a new AIS sale of 1,320, and nothing at all on the IPO side.
    // Its charges are the engine's (invariant 3): the aggregate is read off the
    // stored row, its gross (100 × 13.2 − 1,000 = 320) is arithmetic.
    name: "closePosition on the partly closed holding",
    run: async (b, base) => {
      const res = importer.closePosition(b.ids.a1Part, 15, "2025-09-25");
      expect(res.ok, res.message).toBe(true);
      const closed = rowOf(b.ids.a1Part)!;
      expect([closed.isOpen, closed.sellQty, closed.sellValue, closed.grossPnl], "the whole 100 is now sold")
        .toEqual([false, 100, 1320, 320]);
      const n = r2(closed.netPnl);
      return patch(base, {
        a1: {
          capital: { equityRealised: r2(5652.25 + n), activeRealised: 0, ipoRealised: b.ipoNet.legacy, totalRealised: r2(5652.25 + n + b.ipoNet.legacy) },
          taxNets: [192, 490.25, 4970, n, b.ipoNet.legacy].sort((x, y) => x - y),
          itrScrips: ["A1JOIN", "A1PART", "A1SOLD1", "A1SOLD2", "ORACLE-LEGACY (IPO)"],
          itrCount: 5,
          deliveryConsideration: 30520,
          deliveryCost: 24000,
          fyRealised: { [ORACLE_FY]: r2(5652.25 + n + b.ipoNet.legacy) },
          ais: { [`${ORACLE_FY} purchase`]: 49000, [`${ORACLE_FY} sale`]: 30520 },
          kpi: { count: 8, open: 4, net: r2(5961.25 - 115 + n) },
        },
        all: {
          capital: { equityRealised: r2(6632.75 + n), activeRealised: 0, ipoRealised: b.ipoNet.loose, totalRealised: r2(6632.75 + n + b.ipoNet.loose) },
          taxNets: [192, 490.25, 490.25, 490.25, 4970, n, b.ipoNet.loose].sort((x, y) => x - y),
          itrScrips: ["A1JOIN", "A1PART", "A1SOLD1", "A1SOLD2", "A2IPOH", "A2SOLD", "ORACLE-LOOSE (IPO)"],
          itrCount: 7,
          deliveryConsideration: 33420,
          deliveryCost: 26000,
          fyRealised: { [ORACLE_FY]: r2(6632.75 + n + b.ipoNet.loose) },
          ais: { [`${ORACLE_FY} purchase`]: 51000, [`${ORACLE_FY} sale`]: 33420 },
          kpi: { count: 10, open: 4, net: r2(6941.75 - 115 + n) },
        },
      });
    },
  },
  {
    // v4.5.0 W3 — an import auto-close, UN-CLOSED, and closed again.
    //
    // The sequence the lifecycle work adds: three writes, and the sale must be
    // stated exactly once at the end of them, in every consumer and every view.
    // The expectation is not predicted here — it is MEASURED after the first
    // close and re-asserted after the round trip, which is the property under
    // test (the state is reachable twice and reads the same both times). The
    // `it` before the round trip proves the measurement is not the baseline, so
    // the comparison cannot pass by the import having done nothing.
    name: "an import auto-close, then un-close, then close again",
    run: async (_b, base) => {
      selectOracleAccount(t, ORACLE_A1);
      const file = (over: Partial<NormalizedTrade>, name: string) =>
        importer.commitParsedFile(
          oracleParsedFile([{ ...oracleReimportTrade(), tradingsymbol: "A1AUTOC", buyQty: 0, avgBuyPrice: 0, buyValue: 0, buyDate: null, sellQty: 0, avgSellPrice: 0, sellValue: 0, sellDate: null, grossPnl: 0, ...over } as NormalizedTrade]),
          name, null, ORACLE_A1, { autoClose: true },
        );
      expect(file({ buyQty: 20, avgBuyPrice: 100, buyValue: 2000, buyDate: ORACLE_BUY_DATE }, "w3-buy").added).toBe(1);
      const closed = file({ sellQty: 20, avgSellPrice: 150, sellValue: 3000, sellDate: ORACLE_SELL_DATE }, "w3-sell");
      expect([closed.added, closed.autoClose?.closedWhole], "the lot became the closed row").toEqual([0, 1]);

      const afterFirstClose = await readOracle(t);
      expect(afterFirstClose.a1.itrCount, "the new round trip is counted").toBe(base.a1.itrCount + 1);
      expect(afterFirstClose.all.itrCount).toBe(base.all.itrCount + 1);

      const row = rowsIn(ORACLE_A1).find((r) => r.tradingsymbol === "A1AUTOC")!;
      const hash = lots.executionHashOfPiece(row);
      const un = importer.unCloseExecution(ORACLE_A1, row.broker, hash);
      expect(un.ok, un.message).toBe(true);
      const open = await readOracle(t);
      expect([open.a1.itrCount, open.all.itrCount], "an un-closed position realises nothing")
        .toEqual([base.a1.itrCount, base.all.itrCount]);

      // Close it again through the import door: the reinstated sale carries the
      // execution's own identity, so it is removed first and the file re-read.
      const sale = rowsIn(ORACLE_A1).find((r) => r.dedupHash === hash)!;
      await deleteTrades([sale.id]);
      const again = file({ sellQty: 20, avgSellPrice: 150, sellValue: 3000, sellDate: ORACLE_SELL_DATE }, "w3-sell-again");
      expect(again.autoClose?.closedWhole, "the lot was whole again, so it closed whole again").toBe(1);
      return afterFirstClose;
    },
  },
];

describe("the state machine — the oracle still holds after", () => {
  it.each(OPS.map((op) => [op.name, op] as const))("%s", async (_name, op) => {
    const base = book.expected;
    const expected = await op.run(book, base);
    expect(await readAndCheck(op.name)).toEqual(expected);
  }, 60_000);
});
