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
export const getOptionTrades = cache((): Trade[] => {
  const accountId = getSelectedAccountId();
  const isOption = eq(trades.instrumentType, "option");
  return db.select().from(trades)
    .where(accountId > 0 ? and(isOption, eq(trades.accountId, accountId)) : isOption)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all();
});

/**
 * Open option positions that can be drawn as strategy legs — the exact
 * predicate `/strategies` used to apply in JS after materialising the whole
 * book (25,000 rows mapped to keep 673 on the 25k perf tier: ~300 ms → ~9 ms).
 * Same ORDER BY as `getTrades` so leg order inside each strategy group is
 * byte-identical to what the page rendered before.
 */
export const getOpenOptionPositions = cache((): Trade[] => {
  const accountId = getSelectedAccountId();
  const isLeg = and(
    eq(trades.isOpen, true),
    eq(trades.instrumentType, "option"),
    isNotNull(trades.strike),
    inArray(trades.optionType, ["CE", "PE"]),
  );
  return db.select().from(trades)
    .where(accountId > 0 ? and(isLeg, eq(trades.accountId, accountId)) : isLeg)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt)).all();
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
  "buyDate", "sellDate", "grossPnl",
] as const satisfies readonly (keyof Trade)[];

export type HarvestTrade = Pick<Trade, (typeof HARVEST_FIELDS)[number]>;

/**
 * /reports/harvest: the whole book projected to the 11 columns the harvest
 * report reads — the open-lot mapping and the realised STCG/LTCG window. Same
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
