import "server-only";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, eq, sql, desc, type SQL } from "drizzle-orm";
import { SLIM_TRADE_FIELDS, type SlimTrade } from "@/lib/domain/slim-trade";
import type { Trade } from "@/lib/db/schema";
import type { TradeView, ViewCounts } from "@/lib/analytics/trade-status";
import { TRADES_PAGE_SIZE, type TradeFilters as TradesPageFilters } from "@/lib/domain/trades-filter";
import { getSelectedAccountId } from "./accounts";

/**
 * /trades, ONE PAGE AT A TIME (v3.9).
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * `/trades` was the only route over the 1,500 ms median budget (1,968 ms on
 * the 25k perf book, DECISIONS 2026-09-04). The cost is not the SQL: it is
 * every row of the book crossing the RSC flight stream in the wire shape and
 * then being filtered in the browser. This module answers the question the
 * screen actually asks — "the next 500 rows that match these filters" — in
 * SQL, and returns the whole-set counts alongside so nothing on screen is
 * ever a page-local number.
 *
 * ── The order is TOTAL, and that is load-bearing ─────────────────────────
 * Keyset pagination is only correct on a total order: with ties, a page
 * boundary can drop rows or repeat them. `(sell_date, created_at)` is NOT a
 * total order — `created_at` is `datetime('now')` at second resolution and
 * `lib/import/commit.ts` never sets it, so a whole import batch shares one
 * value (842 of the owner's 905 rows sit in 174 such blocks, the largest 36
 * rows wide). v3.9 ends every projection in `lib/queries/trades.ts` and every
 * page here on `id DESC` — AUTOINCREMENT, therefore unique — and migration
 * 0063 extends `trades_account_sell_created_idx` to match, so the seek stays
 * an index scan.
 *
 * ── The filters are the SAME filters ─────────────────────────────────────
 * Every predicate below is a faithful SQL transcription of the JS filter in
 * `components/trades/trades-client.tsx`, including `matchesView`
 * (lib/analytics/trade-status.ts). `tests/trades-page-parity.test.ts` proves
 * the two agree ID-FOR-ID on every view and every filter over a seeded book —
 * that test is the licence to filter in SQL at all. The client still runs its
 * own filter over the page it receives; on a faithful transcription that is a
 * no-op, and if it ever stops being one the table narrows rather than showing
 * a row the filter excludes.
 *
 * NO COUNT IS EVER PAGE-LOCAL. `total` and `viewCounts` are aggregates over
 * the whole filtered set (invariant 6 in list form: a count that silently
 * means "…of the rows we happened to fetch" is a fabricated denominator).
 */

/**
 * The filter shape and the page size are the PURE module's
 * (lib/domain/trades-filter.ts) — one definition, imported by the client too,
 * which cannot import this `server-only` file at all.
 */
export { TRADES_PAGE_SIZE, EMPTY_TRADE_FILTERS as EMPTY_TRADES_PAGE_FILTERS } from "@/lib/domain/trades-filter";
export type { TradeFilters as TradesPageFilters } from "@/lib/domain/trades-filter";

/** `(sell_date, created_at, id)` of the last row of a page, as one token. */
export interface TradesCursor {
  sellDate: string | null;
  createdAt: string;
  id: number;
}

export function encodeCursor(c: TradesCursor): string {
  return `${c.sellDate ?? ""}|${c.createdAt}|${c.id}`;
}

/** `sell_date` is a plain ISO day; the empty field is the null-sell-date token. */
const CURSOR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** `created_at` is `datetime('now')` — `YYYY-MM-DD HH:MM:SS`. An ISO `T` and a
 *  fractional/Z tail are accepted too, so a hand-written row cannot be locked
 *  out of paging by its own timestamp shape. */
const CURSOR_STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z?$/;

/**
 * Never throws: a malformed cursor is NO cursor.
 *
 * Strict, not lenient. `""` used to decode to a null `sellDate`, so any
 * three-field string with a plausible id — `garbage||7`, a truncated token, a
 * cursor from another sort — silently became "the null-sell-date tail of the
 * book" and returned a page from the WRONG place with no error anywhere. Both
 * date fields are now shape-checked, and the route turns a `null` here into a
 * 400 rather than quietly serving page one (app/api/trades/page/route.ts).
 */
export function decodeCursor(raw: string | null | undefined): TradesCursor | null {
  if (!raw) return null;
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const id = Number(parts[2]);
  if (!Number.isInteger(id) || id <= 0) return null;
  // Shape AND calendar: `2026-13-45` matches the shape and is not a day.
  // ISO parsing is strict about ranges, so this rejects 31 February too.
  const isDay = (d: string) => CURSOR_DATE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (parts[0] !== "" && !isDay(parts[0])) return null;
  if (!CURSOR_STAMP.test(parts[1]) || !isDay(parts[1].slice(0, 10))) return null;
  return { sellDate: parts[0] === "" ? null : parts[0], createdAt: parts[1], id };
}

/** The effective date the window filters on — exit if closed, entry if open. */
const EFFECTIVE_DATE = sql`case when ${trades.isOpen} then ${trades.buyDate} else ${trades.sellDate} end`;

/** `isMarked` (lib/analytics/trade-status.ts) in SQL. */
const MARKED = sql`(${trades.closingPrice} is not null and ${trades.closingPrice} > 0)`;

/** `matchesView` in SQL — one arm per case of the switch, same verdicts. */
function viewPredicate(view: TradeView): SQL | undefined {
  switch (view) {
    case "open": return sql`${trades.isOpen} = 1`;
    case "closed": return sql`${trades.isOpen} = 0`;
    case "staged": return sql`${trades.staged} = 1`;
    // An UNMARKED open position has no unrealised result, so it belongs to
    // neither outcome view — `MARKED` is what keeps it out of both.
    case "open-gain": return sql`${trades.isOpen} = 1 and ${MARKED} and ${trades.unrealisedPnl} > 0`;
    case "open-loss": return sql`${trades.isOpen} = 1 and ${MARKED} and ${trades.unrealisedPnl} < 0`;
    case "closed-profit": return sql`${trades.isOpen} = 0 and ${trades.netPnl} > 0`;
    case "closed-loss": return sql`${trades.isOpen} = 0 and ${trades.netPnl} < 0`;
    case "all":
    default: return undefined;
  }
}

/** LIKE metacharacters are literal text in a search box. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Everything EXCEPT the view — the base `viewCounts` is computed over, so each
 * option in the select shows how many rows choosing it would give (which is
 * what the client's `viewCounts` memo has always done).
 */
function baseConditions(f: TradesPageFilters): SQL[] {
  const accountId = getSelectedAccountId();
  const cond: SQL[] = [];
  // Invariant 8: `accountId > 0 ? filter : all`.
  if (accountId > 0) cond.push(eq(trades.accountId, accountId));
  if (f.broker) cond.push(eq(trades.broker, f.broker));
  if (f.segment) cond.push(eq(trades.segment, f.segment));
  if (f.bucket) cond.push(eq(trades.bucket, f.bucket));
  if (f.realised) cond.push(sql`${trades.isOpen} = 0`);
  if (f.basisUnknown) {
    // !hasKnownBasis(t) — lib/analytics/acquisition.ts:66. `!t.acquisition` is
    // true for null AND for "", so both count as "known basis" here.
    cond.push(sql`${trades.acquisition} is not null and ${trades.acquisition} != '' and ${trades.buyValue} <= 0 and ${trades.acquisitionPrice} is null`);
  }
  if (f.from || f.to) {
    // A row with no effective date is excluded once a window is set — the
    // client's `if (!d) return false`.
    cond.push(sql`${EFFECTIVE_DATE} is not null`);
    if (f.from) cond.push(sql`${EFFECTIVE_DATE} >= ${f.from}`);
    if (f.to) cond.push(sql`${EFFECTIVE_DATE} <= ${f.to}`);
  }
  const q = f.q.trim().toLowerCase();
  if (q) {
    // The client matches `${symbol} ${tradingsymbol} ${setupTag ?? ""}`
    // lower-cased. Same haystack, same needle. (ASCII: SQLite's lower() does
    // not fold non-ASCII, and neither does any ticker.)
    const needle = `%${likeEscape(q)}%`;
    cond.push(sql`lower(${trades.symbol} || ' ' || ${trades.tradingsymbol} || ' ' || coalesce(${trades.setupTag}, '')) like ${needle} escape '\\'`);
  }
  return cond;
}

function allConditions(f: TradesPageFilters): SQL | undefined {
  const cond = baseConditions(f);
  const v = viewPredicate(f.view);
  if (v) cond.push(v);
  return cond.length ? and(...cond) : undefined;
}

function pickSlim() {
  const out = {} as Pick<typeof trades, (typeof SLIM_TRADE_FIELDS)[number]>;
  for (const k of SLIM_TRADE_FIELDS) out[k] = trades[k] as never;
  return out;
}

/**
 * "Strictly after this row" in `(sell_date DESC, created_at DESC, id DESC)`.
 *
 * SQLite sorts NULLs LAST under DESC, so a null `sell_date` behaves as the
 * SMALLEST key — which is why the null arm is spelled out rather than left to
 * `sell_date < ?` (that comparison is NULL, i.e. false, for exactly the rows
 * the page still has to reach).
 */
function afterCursor(c: TradesCursor): SQL {
  const tail = sql`(${trades.createdAt} < ${c.createdAt} or (${trades.createdAt} = ${c.createdAt} and ${trades.id} < ${c.id}))`;
  if (c.sellDate == null) {
    return sql`(${trades.sellDate} is null and ${tail})`;
  }
  return sql`(${trades.sellDate} is null or ${trades.sellDate} < ${c.sellDate} or (${trades.sellDate} = ${c.sellDate} and ${tail}))`;
}

export interface TradesPage {
  rows: SlimTrade[];
  /** Null when this page is the last one. */
  nextCursor: string | null;
  /** Rows matching the WHOLE filter, not this page. */
  total: number;
  /** Counts for every view option, over the filters EXCEPT the view. */
  viewCounts: ViewCounts;
}

/** One page of the /trades table, plus the whole-set counts around it. */
export function getTradesPage(
  f: TradesPageFilters,
  cursor: string | null = null,
  limit: number = TRADES_PAGE_SIZE,
): TradesPage {
  const where = allConditions(f);
  const c = decodeCursor(cursor);
  const seek = c ? afterCursor(c) : undefined;
  const rowWhere = where && seek ? and(where, seek) : (seek ?? where);

  const rows = db
    .select(pickSlim())
    .from(trades)
    .where(rowWhere)
    // The total order. Same three keys as every projection in
    // lib/queries/trades.ts, and as migration 0063's index.
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id))
    .limit(limit + 1)
    .all() as SlimTrade[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page,
    nextCursor:
      hasMore && last
        ? encodeCursor({ sellDate: last.sellDate, createdAt: last.createdAt, id: last.id })
        : null,
    total: countTrades(f),
    viewCounts: getViewCounts(f),
  };
}

/** Rows matching the whole filter — the "of N" the client shows. */
export function countTrades(f: TradesPageFilters): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(trades)
    .where(allConditions(f))
    .get();
  return Number(row?.n ?? 0);
}

/**
 * `countViews` (lib/analytics/trade-status.ts) as one aggregate query, over
 * the filters EXCLUDING the view — so each option in the select shows how many
 * rows choosing it would return.
 */
export function getViewCounts(f: TradesPageFilters): ViewCounts {
  const cond = baseConditions(f);
  const n = (e: SQL) => sql<number>`sum(case when ${e} then 1 else 0 end)`;
  const row = db
    .select({
      all: sql<number>`count(*)`,
      open: n(sql`${trades.isOpen} = 1`),
      closed: n(sql`${trades.isOpen} = 0`),
      staged: n(sql`${trades.staged} = 1`),
      openGain: n(sql`${trades.isOpen} = 1 and ${MARKED} and ${trades.unrealisedPnl} > 0`),
      openLoss: n(sql`${trades.isOpen} = 1 and ${MARKED} and ${trades.unrealisedPnl} < 0`),
      openUnmarked: n(sql`${trades.isOpen} = 1 and not ${MARKED}`),
      closedProfit: n(sql`${trades.isOpen} = 0 and ${trades.netPnl} > 0`),
      closedLoss: n(sql`${trades.isOpen} = 0 and ${trades.netPnl} < 0`),
    })
    .from(trades)
    .where(cond.length ? and(...cond) : undefined)
    .get();
  return {
    all: Number(row?.all ?? 0),
    open: Number(row?.open ?? 0),
    closed: Number(row?.closed ?? 0),
    staged: Number(row?.staged ?? 0),
    openGain: Number(row?.openGain ?? 0),
    openLoss: Number(row?.openLoss ?? 0),
    openUnmarked: Number(row?.openUnmarked ?? 0),
    closedProfit: Number(row?.closedProfit ?? 0),
    closedLoss: Number(row?.closedLoss ?? 0),
  };
}

/** Every id matching the whole filter — the "delete this view" scope, which
 *  must name rows the current PAGE has not fetched or its count is a lie. */
export function getFilteredTradeIds(f: TradesPageFilters): number[] {
  return db
    .select({ id: trades.id })
    .from(trades)
    .where(allConditions(f))
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id))
    .all()
    .map((r) => r.id);
}

const DELETABLE_FIELDS = [
  "id", "accountId", "broker", "segment", "symbol", "tradingsymbol",
  "buyDate", "sellDate", "isOpen", "netPnl", "importBatchId", "createdAt", "staged",
] as const satisfies readonly (keyof Trade)[];

export type DeletableRow = Pick<Trade, (typeof DELETABLE_FIELDS)[number]>;

/**
 * The WHOLE account-scoped book in the 13-column delete-scope shape.
 *
 * "Delete by date range / broker / trade type" must be able to name a trade
 * the current filter is hiding, or the count it shows is not the truth about
 * that range — so this one read is deliberately unpaginated. It is fetched
 * ON DEMAND, when the "Delete by…" dialog opens, and never on page load.
 */
export function getDeletableTrades(): DeletableRow[] {
  const accountId = getSelectedAccountId();
  const cols = {} as Pick<typeof trades, (typeof DELETABLE_FIELDS)[number]>;
  for (const k of DELETABLE_FIELDS) cols[k] = trades[k] as never;
  return db
    .select(cols)
    .from(trades)
    .where(accountId > 0 ? eq(trades.accountId, accountId) : undefined)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id))
    .all() as DeletableRow[];
}
