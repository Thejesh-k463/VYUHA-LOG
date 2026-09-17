import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { trades, importBatches, tradeAttachments } from "@/lib/db/schema";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Trade } from "@/lib/db/schema";
import { bundledIsinBySymbol } from "@/lib/import/isin-symbol";
import { canonicalIsin } from "@/lib/domain/isin";
import { SLIM_TRADE_FIELDS, type SlimTrade } from "@/lib/domain/slim-trade";
import { getSelectedAccountId } from "./accounts";

export const getTrades = cache((): Trade[] => {
  const accountId = getSelectedAccountId();
  const q = db.select().from(trades);
  return (accountId > 0 ? q.where(eq(trades.accountId, accountId)) : q)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id)).all();
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
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id))
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
  // …and the three `edgeMeasurable` reads (the wave 2O seam pass, defect 1):
  // without them `!t.acquisition` is TRUE for every row, so `unpricedCount` was
  // permanently 0 here and a basis-less IPO sale counted as a priced WIN — one
  // book read "Win rate 100.0%" on /lenses and null through `getTrades()`. The two
  // that are NOT on the /trades wire shape are named as the deliberate exception
  // in `tests/render-windowing.test.ts`'s subset pin; `buyValue` already was.
  "acquisition", "acquisitionPrice", "buyValue",
] as const satisfies readonly (keyof Trade)[];

export type LensRowTrade = Pick<Trade, (typeof LENS_FIELDS)[number]>;

/**
 * /lenses: the `LENS_FIELDS` above — `SLIM_TRADE_FIELDS` plus the two basis
 * columns the /trades wire shape does not carry (`acquisition`,
 * `acquisitionPrice`), minus everything this page never groups on.
 *
 * The Lenses tree only ever reads the delete-scope identity fields plus the
 * six grouping/KPI fields. Everything else in the wire shape (`strike`,
 * `optionType`, `slPlanned`, `notes`, `mistakeTags`, `reviewedAt`, every
 * per-leg price and quantity …) crossed the RSC flight stream for 25,001 rows
 * and was never touched.
 *
 * NO COUNTS IN THIS PROSE, deliberately: it read "19 columns, not the 43 of
 * SlimTrade" while `SLIM_TRADE_FIELDS` went 43 → 44 → 45 (v3.7.0 added
 * `reviewedAt`), so the sentence was wrong for two releases and nothing could
 * fail. The two arrays are the count; `tests/render-windowing.test.ts` pins that
 * this one stays inside the other PLUS the two named basis columns, and does not
 * creep. Those two are the ONE exception, and they buy nothing on the RSC payload:
 * since v3.7 /lenses ships GROUP rows, not per-trade rows, so they cross the wire
 * only for the one group the members route is asked for.
 *
 * This route shares `SLIM_TRADE_FIELDS` with /trades, which genuinely needs the
 * wider shape, so it gets its OWN projection rather than narrowing that one —
 * the single-route-projection rule at the head of this file.
 */
export const getLensTrades = cache((): LensRowTrade[] => scopedBookRows(LENS_FIELDS));

const LENS_CHARGE_FIELDS = [
  // id joins the row back to its lens group; isOpen lets the aggregation keep
  // to closed trades so the head split reconciles with the Charges KPI.
  "id", "isOpen", "segment", "sellDate",
  // ChargeReportTrade (lib/analytics/charges-report.ts)
  "buyValue", "sellValue", "grossPnl", "netPnl",
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft",
  "gst", "dpCharges", "mtfInterest", "pledgeCharges", "chargesTotal",
] as const satisfies readonly (keyof Trade)[];

export type LensChargeRow = Pick<Trade, (typeof LENS_CHARGE_FIELDS)[number]>;

/**
 * /lenses charge popups: the 10 charge heads plus turnover, as a SECOND narrow
 * projection rather than a widening of LENS_FIELDS — the per-trade charge
 * columns are aggregated to ~10 numbers per GROUP on the server and never
 * cross the RSC stream row-by-row.
 */
export const getLensChargeRows = cache((): LensChargeRow[] => scopedBookRows(LENS_CHARGE_FIELDS));

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
  // The three `edgeMeasurable` reads (the wave 2O seam pass, defect 1): the hero
  // KPIs, the segment bars and the setup cut all run `computeKpis`/`groupBy` on
  // THIS projection, and without these the dashboard showed a basis-less IPO sale
  // as a priced win (win rate 100.0%, expectancy ₹1,496 for a book with no
  // measurable edge) while `computeKpis(getTrades())` answered "—". Required on
  // `AnalyticsTrade` since the same pass, so a narrower projection cannot compile.
  "acquisition", "acquisitionPrice", "buyValue",
  // closedSorted's same-day tiebreaks (2026-09-17): rows arrive newest-first, and without these
  // the streak and drawdown loops ran BACKWARDS inside a day.
  "id", "exitTime",
] as const satisfies readonly (keyof Trade)[];

export type DashboardTrade = Pick<Trade, (typeof DASH_FIELDS)[number]>;

/** The dashboard's per-trade wire shape (13 render fields + the 3 basis fields). */
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
  // The two columns `storedMarkFor()` needs to price an OPEN position (owner
  // ruling A-1, v4.2 fix wave): a derivative reads a mark stored under its own
  // `tradingsymbol`, never `mtm[symbol]`, which for a derivative is the
  // underlying's cash price. Without them the page marked an open option at
  // the index spot and fed that into XIRR/TWR. Two columns, not a widening to
  // getTrackerTrades() — the 2026-08-29 sweep's narrow projection stands.
  "instrumentType", "tradingsymbol",
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
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id)).all() as OptionJournalRow[];
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
  // L5 (fix wave 2G): the page builds N17's admitting-symbol map PER ACCOUNT, so
  // in All accounts another account's ticker for one ISIN never routes a holding.
  // Read on the server only — the page never copies it onto a leg or a group.
  "accountId",
] as const satisfies readonly (keyof Trade)[];

export type StrategyLegRow = Pick<Trade, (typeof STRATEGY_LEG_FIELDS)[number]>;

/**
 * The open-option-leg predicate, account scope included (invariant 8), shared
 * by both readers below so the "symbols that already have an option leg"
 * restriction and the legs themselves can never describe different books.
 */
const openOptionLegWhere = (accountId: number) => {
  const isLeg = and(
    eq(trades.isOpen, true),
    eq(trades.instrumentType, "option"),
    isNotNull(trades.strike),
    inArray(trades.optionType, ["CE", "PE"]),
  );
  return accountId > 0 ? and(isLeg, eq(trades.accountId, accountId)) : isLeg;
};

export const getOpenOptionPositions = cache((): StrategyLegRow[] => {
  const accountId = getSelectedAccountId();
  // Projected to the 9 columns /strategies reads, of 75. Same WHERE, same
  // ORDER BY, so leg order inside each group is unchanged.
  return db.select(pickCols(STRATEGY_LEG_FIELDS)).from(trades)
    .where(openOptionLegWhere(accountId))
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id)).all() as StrategyLegRow[];
});

/**
 * Open UNDERLYING positions — equity and futures — for the symbols that already
 * carry an open option leg (research note Q4).
 *
 * WHY IT EXISTS: without the underlying there is no covered call and no
 * protective put, and a covered call is the single most-held retail option
 * position in India. `buildStrategies` takes a `kind: "UL"` leg beside the
 * option legs; the page renders them read-only.
 *
 * WHY THE RESTRICTION IS IN SQL, as a subquery on the same predicate: the whole
 * point of the 25k-row work above is that this screen never materialises the
 * book. Reading every open equity row and filtering in JS would undo it on
 * exactly the books it was measured against — an options book with one open
 * option leg also holds every equity position the user has ever left open.
 * Same account scope on BOTH halves of the statement, so an "All accounts"
 * view widens the legs and the underlyings together and a single-account view
 * narrows both.
 *
 * THE JOIN IS READ-TIME ONLY (R105): option symbols are upper-cased at import,
 * an equity row keeps the broker's spelling ("reliance"), and a Groww row is
 * stored under the COMPANY NAME with its ISIN. So a row joins when its symbol
 * matches case-folded, OR its CANONICAL ISIN is the bundled ISIN of an
 * option-side symbol — both inside the same account filter. No stored symbol
 * changes; the page resolves the leg's symbol through `isin`.
 *
 * L1 (fix wave 2L): "canonical" is ONE FUNCTION, `canonicalIsin`, and the ISIN
 * match happens in JS so there is no second spelling of it. I6 (fix wave 2I)
 * folded the column in SQL (`upper(trim(isin))`) to meet the page's
 * `isin.trim().toUpperCase()` — but SQLite's `trim()` strips U+0020 and NOTHING
 * else, so the two were still different canonicalisations and a stored ISIN
 * carrying a tab, a newline or a non-breaking space stayed invisible to its OWN
 * account's read while another account's ticker could still carry it in on 0
 * (the wave-2I re-check's "strategies" finding; the Groww and Angel One /
 * Upstox parsers store an .xlsx ISIN cell raw). SQL now selects a SUPERSET —
 * rows that carry an ISIN at all — and JS decides, with the same function the
 * page asks.
 *
 * THE SUPERSET IS NOT THE WHOLE-BOOK READ the paragraph above refuses: it is
 * bounded by OPEN equity/future rows in the same account. Measured 2026-09-15 on
 * a 5,000-row book whose OPEN holdings are 1,500 (every one carrying an ISIN)
 * under 100 option symbols — far past a real options book: 5.4 ms per call for
 * one account and 8.2 ms on "All accounts", against 2.3 ms for I6's narrow SQL
 * predicate, which returned 0 of those 1,500 (it is the defect). The SQL half
 * itself got no slower (1.9 ms for the superset, against 2.3 ms for the
 * 100-term `upper(trim(…)) IN (…)` scan); the added cost is materialising the
 * candidates and the JS pass. The 50 ms line this was measured against is the
 * point where an SQL pre-filter would have to come back.
 *
 * A basis-unknown sale (`acquisition = 'unknown'`, stored open) is RETURNED,
 * with its `acquisition`, and is never a leg of its own (P5). Read as a short
 * it netted a holding into a phantom SHORT (K3-M1); left out, a partly sold
 * holding covered naked calls — with auto-close OFF a later sale of a held lot
 * is committed as exactly such a row and the lot keeps its full size. The page
 * nets these sales against the same holding, floored at zero. Same account
 * scope as every other row here.
 *
 * D3 (v4.3.0 fix wave 2, W2-FIXB): every delivery-segment sale is returned with
 * its `segment` and `acquisitionPrice` too, so the page reads Data Quality's
 * own basis predicate (`hasRecordedBasis`): a sale with NO recorded basis
 * (acquisition NULL or 'unknown', no price) nets the holding; a sale WITH one
 * (bonus, ESOP, gift, or a price) is a complete trade of shares acquired outside
 * the book and is left out of the join. A future's sale stays a short.
 *
 * N16 (v4.3.0 fix wave 2R): every row carries its `accountId`. A sale can only
 * come out of its own account's demat, so the page nets per account, floors
 * each account at zero, and only then lets "All accounts" add the books up.
 */
const UNDERLYING_LEG_FIELDS = [
  "symbol", "instrumentType", "buyQty", "sellQty", "avgBuyPrice", "avgSellPrice", "expiry", "isin",
  // P5: the page nets a basis-unknown sale; P14: a compact future's stated month.
  "acquisition", "tradingsymbol",
  // D3: only a delivery-segment sell-only row nets or is left out; a recorded basis price.
  "segment", "acquisitionPrice",
  // N16: a sale nets only its OWN account's lots, so All accounts keys the netting by account.
  "accountId",
] as const satisfies readonly (keyof Trade)[];

export type UnderlyingLegRow = Pick<Trade, (typeof UNDERLYING_LEG_FIELDS)[number]>;

export const getOpenUnderlyingPositions = cache((): UnderlyingLegRow[] => {
  const accountId = getSelectedAccountId();
  const optionLeg = openOptionLegWhere(accountId);
  const withAnOptionLeg = db
    .select({ symbol: sql<string>`upper(${trades.symbol})` })
    .from(trades)
    .where(optionLeg);
  const byCase = inArray(sql`upper(${trades.symbol})`, withAnOptionLeg);
  // The option-side symbols are a handful of distinct tickers, so their ISINs
  // are resolved here, from the bundled snapshot, under the same scope. Both
  // sets are canonicalised by the SAME functions the page's admitting map uses
  // (L1): `canonicalIsin` for the ISIN, `toUpperCase()` for the symbol.
  const optionSymbolRows = db.selectDistinct({ symbol: trades.symbol }).from(trades).where(optionLeg).all();
  const optionSymbols = new Set(optionSymbolRows.map((r) => r.symbol.toUpperCase()));
  const optionIsins = new Set(
    optionSymbolRows.map((r) => canonicalIsin(bundledIsinBySymbol(r.symbol))).filter((isin) => isin.length > 0),
  );
  const isUnderlying = and(
    eq(trades.isOpen, true),
    inArray(trades.instrumentType, ["equity", "future"]),
    // The SUPERSET (L1): every open row that carries an ISIN at all, since no SQL
    // fold matches `canonicalIsin`. The JS pass below is what decides.
    optionIsins.size ? or(byCase, isNotNull(trades.isin)) : byCase,
  );
  const rows = db.select(pickCols(UNDERLYING_LEG_FIELDS)).from(trades)
    .where(accountId > 0 ? and(isUnderlying, eq(trades.accountId, accountId)) : isUnderlying)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id)).all() as UnderlyingLegRow[];
  // The ORDER BY is total (`id` breaks every tie), so filtering here returns the
  // rows in exactly the order the narrower WHERE returned them. The symbol half
  // repeats `byCase` in JS: SQLite's `upper()` folds ASCII only, so two strings
  // equal under it are equal under `toUpperCase()` too — this never drops a row
  // SQL admitted, and it matches the page, which folds the symbol in JS as well.
  return optionIsins.size
    ? rows.filter((r) => optionSymbols.has(r.symbol.toUpperCase()) || optionIsins.has(canonicalIsin(r.isin)))
    : rows;
});

const ARJUN_FIELDS = [
  // CockpitTrade (lib/analytics/cockpit.ts) plus the charges the scorecard maps by id …
  "id", "symbol", "segment", "netPnl", "buyValue", "sellValue",
  "buyDate", "sellDate", "entryTime", "exitTime", "isOpen", "rMultiple",
  "acquisition", "acquisitionPrice", "chargesTotal",
  // … AnalyticsTrade for winLossReport (lib/analytics/win-loss.ts) …
  "broker", "bucket", "grossPnl",
  // … SlTrade quantities/prices (lib/analytics/sl-analysis.ts) and the plan fields …
  "buyQty", "sellQty", "avgBuyPrice", "avgSellPrice",
  "slPlanned", "trailingSl", "targetPlanned", "riskAmount",
  // … and the behaviour fields the Trade Craft tabs read (exit-behaviour.ts).
  "setupTag", "playbookId", "buyOrderCount", "sellOrderCount", "exitTrigger",
] as const satisfies readonly (keyof Trade)[];

export type ArjunTrade = Pick<Trade, (typeof ARJUN_FIELDS)[number]>;

/**
 * /arjuns-eye: the whole book projected to the 31 columns the Trade Craft
 * cockpit reads (of 74) — it pulled every column through `getTrades()` until
 * v3.5.0. Same pure-projection contract as the rest of this file: columns
 * only, NO new WHERE, canonical ORDER BY, so row order and every float sum
 * are identical by construction.
 */
export const getArjunTrades = cache((): ArjunTrade[] => scopedBookRows(ARJUN_FIELDS));

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
  // Added v3.5.0 for grandfathering on the realised-LTCG sum: classifyGain
  // needs the actual cost, the consideration and the 31-Jan-2018 FMV so
  // /reports/harvest matches /reports/tax on pre-2018 lots. Columns only.
  "fmv31Jan2018", "buyValue", "sellValue",
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
