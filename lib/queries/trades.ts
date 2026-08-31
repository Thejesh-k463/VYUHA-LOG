import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { trades, importBatches, tradeAttachments } from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Trade } from "@/lib/db/schema";
import { SLIM_TRADE_FIELDS, type SlimTrade } from "@/lib/domain/slim-trade";
import { getSelectedAccountId } from "./accounts";

export const getTrades = cache((): Trade[] => {
  const accountId = getSelectedAccountId();
  const q = db.select().from(trades);
  return (accountId > 0 ? q.where(eq(trades.accountId, accountId)) : q)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all();
});

/**
 * COLUMN-TRIMMED PROJECTIONS OF THE WHOLE BOOK (2026-08-29 perf sweep).
 *
 * `getTrades()` maps all 74 columns for every row (~300 ms at 25k rows against
 * data/perf.sqlite) when each read surface renders a fraction of them. Each
 * projection below is the exact field set one surface consumes — measured
 * 78–200 ms for the same 25k rows — and the same drizzle column decoders
 * (moneyPaise, booleans, json) run on the selected columns, so every value is
 * identical to the full-row read.
 *
 * These deliberately add NO new WHERE clause: they keep `getTrades()`'s exact
 * account scope and ORDER BY, and the pages keep their JS filters. Measured
 * against perf.sqlite, a pure projection returns rows in exactly the full
 * scan's order, while an added WHERE clause (different plan) reorders rows
 * that tie on (sell_date, created_at) — and tie order feeds visible row order
 * and float-summation order on these surfaces.
 */
function pickCols<K extends keyof Trade & keyof typeof trades>(
  keys: readonly K[],
): Pick<typeof trades, K> {
  const out = {} as Pick<typeof trades, K>;
  for (const k of keys) out[k] = trades[k];
  return out;
}

function scopedBookRows<K extends keyof Trade & keyof typeof trades>(
  keys: readonly K[],
): Pick<Trade, K>[] {
  const accountId = getSelectedAccountId();
  const q = db.select(pickCols(keys)).from(trades);
  return (accountId > 0 ? q.where(eq(trades.accountId, accountId)) : q)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt))
    .all() as Pick<Trade, K>[];
}

/** The trades-table wire shape (`SlimTrade`), selected in SQL instead of projected in JS. */
export const getSlimTrades = cache((): SlimTrade[] => scopedBookRows(SLIM_TRADE_FIELDS));

const LENS_FIELDS = [
  // DeletableTrade (lib/domain/delete-scope.ts) …
  "id", "accountId", "broker", "segment", "symbol", "tradingsymbol",
  "buyDate", "sellDate", "isOpen", "netPnl", "importBatchId", "createdAt", "staged",
  // … plus what LensTrade adds, and what computeKpis reads.
  "setupTag", "playbookId", "bucket", "grossPnl", "chargesTotal", "rMultiple",
] as const satisfies readonly (keyof Trade)[];

export type LensRowTrade = Pick<Trade, (typeof LENS_FIELDS)[number]>;

/**
 * /lenses: 19 columns, not the 43 of `SlimTrade`.
 *
 * The Lenses tree only ever reads the delete-scope identity fields plus six
 * grouping/KPI fields — the other 23 (`strike`, `optionType`, `slPlanned`,
 * `notes`, `mistakeTags`, every per-leg price and quantity …) crossed the RSC
 * flight stream for 25,001 rows and were never touched.
 *
 * This route shares `SLIM_TRADE_FIELDS` with /trades, which genuinely needs the
 * wider shape, so it gets its OWN projection rather than narrowing that one —
 * the single-route-projection rule at the head of this file.
 */
export const getLensTrades = cache((): LensRowTrade[] => scopedBookRows(LENS_FIELDS));

const JOURNAL_EXTRA_FIELDS = [
  "acquisition", "acquisitionPrice", "acquisitionDate", "suggestedBasisPrice",
] as const satisfies readonly (keyof Trade)[];

export type JournalTrade = SlimTrade & Pick<Trade, (typeof JOURNAL_EXTRA_FIELDS)[number]>;

/** /trades: the wire shape plus the acquisition/basis fields its server panels read. */
export const getJournalTrades = cache((): JournalTrade[] =>
  scopedBookRows([...SLIM_TRADE_FIELDS, ...JOURNAL_EXTRA_FIELDS]));

const DASH_FIELDS = [
  "broker", "bucket", "segment", "symbol", "exchange",
  "netPnl", "grossPnl", "chargesTotal", "rMultiple",
  "isOpen", "sellDate", "buyDate", "setupTag",
] as const satisfies readonly (keyof Trade)[];

export type DashboardTrade = Pick<Trade, (typeof DASH_FIELDS)[number]>;

/** The dashboard's 13-field per-trade wire shape (the page always shipped exactly this). */
export const getDashboardTrades = cache((): DashboardTrade[] => scopedBookRows(DASH_FIELDS));

const TRACKER_FIELDS = [
  "id", "broker", "bucket", "segment", "instrumentType", "exchange",
  "symbol", "tradingsymbol", "optionType", "strike", "expiry",
  "buyQty", "sellQty", "avgBuyPrice", "avgSellPrice", "closingPrice",
  "buyDate", "sellDate", "netPnl", "grossPnl", "rMultiple", "isOpen", "staged",
  "slPlanned", "trailingSl", "targetPlanned", "riskAmount",
  "mtfInterest", "mtfFundedAmount", "impliedVol", "buyValue",
] as const satisfies readonly (keyof Trade)[];

export type TrackerTrade = Pick<Trade, (typeof TRACKER_FIELDS)[number]>;

/** /active, /equity, /risk: open-position derivation plus the closed-trade strips. */
export const getTrackerTrades = cache((): TrackerTrade[] => scopedBookRows(TRACKER_FIELDS));

const PERFORMANCE_FIELDS = [
  "broker", "bucket", "segment", "symbol",
  "netPnl", "grossPnl", "chargesTotal", "rMultiple",
  "isOpen", "sellDate", "buyDate", "setupTag",
  "acquisition", "acquisitionPrice", "buyValue",
  "buyQty", "sellQty", "closingPrice", "avgBuyPrice",
] as const satisfies readonly (keyof Trade)[];

export type PerformanceTrade = Pick<Trade, (typeof PERFORMANCE_FIELDS)[number]>;

/** /reports/performance: the KPI-engine fields plus the open-MTM and basis fields it reads. */
export const getPerformanceTrades = cache((): PerformanceTrade[] => scopedBookRows(PERFORMANCE_FIELDS));

/**
 * Option trades only, filtered in SQL. `/options-journal` used to pull the
 * whole book through `getTrades()` and keep a third of it in JS — on a
 * 25k-trade book that is 25,000 rows through Drizzle's row mapping (~300 ms)
 * to keep 8,058 (~130 ms). Same ORDER BY as `getTrades` so the rows come back
 * in exactly the order the page always showed them.
 */
const OPTION_JOURNAL_FIELDS = [
  // read by SellerTrade (lib/analytics/options-seller.ts) …
  "id", "symbol", "tradingsymbol", "segment", "isOpen",
  "buyQty", "sellQty", "avgBuyPrice", "avgSellPrice", "netPnl", "riskAmount",
  "entryIv", "exitIv", "entryDte", "hedgeStatus", "expiryOutcome", "adjustmentGroup",
  // … plus the two dates SellerTradeWithDates adds (options-seller-depth.ts).
  "buyDate", "sellDate",
] as const satisfies readonly (keyof Trade)[];

export type OptionJournalRow = Pick<Trade, (typeof OPTION_JOURNAL_FIELDS)[number]>;

/**
 * Option trades only, filtered in SQL AND projected to the 19 columns the page
 * reads. It was `select *` — all 75 columns of 8,058 rows, ~12.3 MB of row
 * objects materialised to feed nineteen fields.
 *
 * Projection, not filtering: no WHERE is added beyond the one already here, so
 * the plan and therefore the tie order are unchanged — the property that makes
 * this provably output-identical (see the header of this file).
 */
export const getOptionTrades = cache((): OptionJournalRow[] => {
  const accountId = getSelectedAccountId();
  const isOption = eq(trades.instrumentType, "option");
  return db.select(pickCols(OPTION_JOURNAL_FIELDS)).from(trades)
    .where(accountId > 0 ? and(isOption, eq(trades.accountId, accountId)) : isOption)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all() as OptionJournalRow[];
});

/**
 * Open option positions that can be drawn as strategy legs — the exact
 * predicate `/strategies` used to apply in JS after materialising the whole
 * book (25,000 rows mapped to keep 673 on the 25k perf tier: ~300 ms → ~9 ms).
 * Same ORDER BY as `getTrades` so leg order inside each strategy group is
 * byte-identical to what the page rendered before.
 */
const STRATEGY_LEG_FIELDS = [
  "symbol", "expiry", "optionType", "strike",
  "buyQty", "sellQty", "avgBuyPrice", "avgSellPrice",
] as const satisfies readonly (keyof Trade)[];

export type StrategyLegRow = Pick<Trade, (typeof STRATEGY_LEG_FIELDS)[number]>;

export const getOpenOptionPositions = cache((): StrategyLegRow[] => {
  const accountId = getSelectedAccountId();
  const isLeg = and(
    eq(trades.isOpen, true),
    eq(trades.instrumentType, "option"),
    isNotNull(trades.strike),
    inArray(trades.optionType, ["CE", "PE"]),
  );
  // Projected to the 8 columns /strategies reads, of 75. Same WHERE, same
  // ORDER BY — leg order inside each group is unchanged, which matters because
  // `classifyStrategy` reads legs[0] and legs[1] POSITIONALLY and a reorder can
  // rename a strategy on screen.
  return db.select(pickCols(STRATEGY_LEG_FIELDS)).from(trades)
    .where(accountId > 0 ? and(isLeg, eq(trades.accountId, accountId)) : isLeg)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all() as StrategyLegRow[];
});

const TAX_FIELDS = [
  "id", "symbol", "segment", "instrumentType",
  "buyQty", "avgBuyPrice", "buyValue", "sellValue",
  "buyDate", "sellDate", "grossPnl", "chargesTotal", "netPnl",
  "fmv31Jan2018", "isOpen",
] as const satisfies readonly (keyof Trade)[];

export type TaxPageTrade = Pick<Trade, (typeof TAX_FIELDS)[number]>;

/**
 * /reports/tax: the whole book projected to the 15 columns the Tax Summary
 * and the ITR export actually read (of 74). A pure projection — NO new WHERE
 * clause, per the header note above: filtering `is_open` in SQL was measured
 * (scratch equivalence run against data/perf.sqlite, 2026-08-29) to reorder
 * rows tying on (sell_date, created_at), which changes the ITR export's row
 * order and taxByFy's float-summation order. The page keeps its `!t.isOpen`
 * JS filters, so rows, order and every accumulated rupee are identical by
 * construction.
 */
export const getTaxTrades = cache((): TaxPageTrade[] => scopedBookRows(TAX_FIELDS));

const HARVEST_FIELDS = [
  "id", "symbol", "segment", "isOpen",
  "buyQty", "sellQty", "avgBuyPrice", "closingPrice",
  "buyDate", "sellDate",
  // Added for the tax levers (v3.3.0): the STT split by head, and the
  // set-off position. Columns only — no new WHERE — so row order and both
  // float sums are unchanged by construction.
  // No `grossPnl`: the realised STCG/LTCG sums moved to `netPnl` so both tax
  // surfaces report one figure per FY, and nothing else on the page read it.
  "netPnl", "chargesTotal", "sttCtt",
] as const satisfies readonly (keyof Trade)[];

export type HarvestTrade = Pick<Trade, (typeof HARVEST_FIELDS)[number]>;

/**
 * /reports/harvest: the whole book projected to the 13 columns the harvest
 * report reads — the open-lot mapping, the realised STCG/LTCG window, and the
 * tax levers (STT split by head, set-off position, holding clock). Same
 * pure-projection contract as `getTaxTrades` (no new WHERE; the page keeps
 * its JS filters), so lot order — which feeds `allocate()`'s stable sort and
 * therefore the rendered candidate order — and both float sums are identical
 * by construction.
 */
export const getHarvestTrades = cache((): HarvestTrade[] => scopedBookRows(HARVEST_FIELDS));

/**
 * tradeId → number of chart screenshots attached.
 *
 * One grouped query for the whole table rather than a count per row: the
 * trades table renders hundreds of rows, and the point of this map is a small
 * paperclip badge — it must never cost a query per trade. Attachments are not
 * account-scoped themselves (they hang off a trade that already is), so the
 * map is safe to build unfiltered and read by id.
 */
export function getAttachmentCounts(): Map<number, number> {
  const rows = db
    .select({ tradeId: tradeAttachments.tradeId, n: sql<number>`count(*)` })
    .from(tradeAttachments)
    .groupBy(tradeAttachments.tradeId)
    .all();
  return new Map(rows.map((r) => [r.tradeId, Number(r.n)]));
}

export function getSetupTags(): string[] {
  const accountId = getSelectedAccountId();
  const rows = db
    .selectDistinct({ tag: trades.setupTag })
    .from(trades)
    .where(accountId > 0 ? sql`${trades.setupTag} is not null and ${trades.setupTag} != '' and ${trades.accountId} = ${accountId}` : sql`${trades.setupTag} is not null and ${trades.setupTag} != ''`)
    .all();
  return rows.map((r) => r.tag!).filter(Boolean);
}

export function getImportBatches() {
  const accountId = getSelectedAccountId();
  const q = db.select().from(importBatches);
  return (accountId > 0 ? q.where(eq(importBatches.accountId, accountId)) : q).orderBy(desc(importBatches.importedAt)).all();
}

/**
 * Per-batch open and opening-sell counts, for the Recent-imports row's
 * "N executions → M positions (K open, J opening sells…)" sentence.
 *
 * Derived rather than stored: `is_open` and `acquisition` are already on every
 * trade, so a column on `import_batches` would be a second copy of the same
 * fact that a later edit could drift away from. One grouped query for the whole
 * table, not one per row.
 *
 * Account-scoped like every other read (invariant 8) — an unscoped version
 * would count another book's trades into this account's import summary.
 */
export function getImportBatchShapes(): Map<number, { open: number; openingSells: number }> {
  const accountId = getSelectedAccountId();
  const rows = db
    .select({
      batchId: trades.importBatchId,
      open: sql<number>`sum(case when ${trades.isOpen} = 1 and coalesce(${trades.acquisition}, '') != 'unknown' then 1 else 0 end)`,
      openingSells: sql<number>`sum(case when ${trades.acquisition} = 'unknown' then 1 else 0 end)`,
    })
    .from(trades)
    .where(
      accountId > 0
        ? sql`${trades.importBatchId} is not null and ${trades.accountId} = ${accountId}`
        : sql`${trades.importBatchId} is not null`,
    )
    .groupBy(trades.importBatchId)
    .all();
  return new Map(rows.filter((r) => r.batchId != null).map((r) => [r.batchId!, { open: Number(r.open ?? 0), openingSells: Number(r.openingSells ?? 0) }]));
}

/**
 * The /trades KPI strip, computed from rows the page already fetched — same
 * reduce, same row order, same floats as `getTradeStats()`, without a second
 * full-book query.
 */
export function tradeStatsOf(all: Array<Pick<Trade, "netPnl" | "grossPnl" | "chargesTotal" | "isOpen">>) {
  const net = all.reduce((s, t) => s + t.netPnl, 0);
  const gross = all.reduce((s, t) => s + t.grossPnl, 0);
  const charges = all.reduce((s, t) => s + t.chargesTotal, 0);
  return {
    count: all.length,
    open: all.filter((t) => t.isOpen).length,
    net: Math.round(net * 100) / 100,
    gross: Math.round(gross * 100) / 100,
    charges: Math.round(charges * 100) / 100,
  };
}

export function getTradeStats() {
  return tradeStatsOf(getTrades());
}
