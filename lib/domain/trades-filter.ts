/**
 * THE /trades FILTER, AS ONE PURE PREDICATE.
 *
 * Until v3.9 this lived inline in `components/trades/trades-client.tsx`, where
 * it ran over the whole book in the browser. v3.9 pages the table from the
 * server (`lib/queries/trades-page.ts`), which means the same question is now
 * asked TWICE — once in SQL, once in JS over the page that comes back — and a
 * predicate that exists in two places drifts.
 *
 * So it exists once, here, pure (invariant 2: no React, no DB, no `window`):
 *
 *   - the client calls it over the rows the server sent (a no-op when the SQL
 *     is faithful, and a NARROWING — never a widening — if it ever is not);
 *   - `tests/trades-page-parity.test.ts` calls it over the whole book and
 *     demands the SQL page return the identical id set, for every view and
 *     every filter combination.
 *
 * `basisUnknown` takes a callback rather than reading the row: the wire shape
 * the table renders (`SlimTrade`) deliberately does not carry `acquisition` /
 * `acquisitionPrice` — the server decides that verdict with `hasKnownBasis`
 * and sends ids. The parity test builds the same callback from
 * `hasKnownBasis`, which is what proves the two definitions agree.
 */

import { matchesView, type StatusTrade, type TradeView } from "@/lib/analytics/trade-status";

export interface FilterableTrade extends StatusTrade {
  id: number;
  broker: string;
  segment: string;
  bucket: string;
  symbol: string;
  tradingsymbol: string;
  setupTag?: string | null;
  buyDate: string | null;
  sellDate: string | null;
}

export interface TradeFilters {
  /** Free text over `symbol tradingsymbol setupTag`. Trimmed and lower-cased here. */
  q: string;
  broker: string;
  segment: string;
  bucket: string;
  view: TradeView;
  realised: boolean;
  basisUnknown: boolean;
  from: string;
  to: string;
}

/**
 * Rows per server page.
 *
 * It lives in this PURE module, not in `lib/queries/trades-page.ts`, because
 * both ends need it and that one is `server-only`: the client renders
 * "Load N more" from it, and a client that imported the query module would
 * fail at `next build`, not at typecheck (AGENTS.md).
 */
export const TRADES_PAGE_SIZE = 500;

export const EMPTY_TRADE_FILTERS: Readonly<TradeFilters> = Object.freeze({
  q: "", broker: "", segment: "", bucket: "", view: "all" as TradeView,
  realised: false, basisUnknown: false, from: "", to: "",
});

/**
 * The trade's EFFECTIVE date: the exit for a closed trade, the ENTRY for one
 * still open.
 *
 * `sellDate ?? buyDate` looks equivalent and is not — it hands an open
 * position its exit date whenever one exists (a partial exit, or a holding
 * sold with no recorded purchase). This mirrors `dailyPnl`
 * (lib/analytics/metrics.ts), which buckets realised P&L on `sellDate`, so a
 * drill-down shows exactly the population the clicked figure summed.
 */
export function effectiveDate(t: Pick<FilterableTrade, "isOpen" | "buyDate" | "sellDate">): string | null {
  return t.isOpen ? t.buyDate : t.sellDate;
}

/** Does this row belong in the current /trades view? */
export function matchesTradeFilters(
  t: FilterableTrade,
  f: TradeFilters,
  isUnknownBasis: (id: number) => boolean = () => false,
): boolean {
  if (f.broker && t.broker !== f.broker) return false;
  if (f.segment && t.segment !== f.segment) return false;
  if (f.bucket && t.bucket !== f.bucket) return false;
  if (!matchesView(t, f.view)) return false;
  if (f.basisUnknown && !isUnknownBasis(t.id)) return false;
  // A REALISED drill-down must show exactly the population dailyPnl summed —
  // closed trades only. An open position can carry a sell date, and including
  // it here put rupees on screen that were never in the clicked figure.
  if (f.realised && t.isOpen) return false;
  if (f.from || f.to) {
    const d = effectiveDate(t);
    if (!d) return false;
    if (f.from && d < f.from) return false;
    if (f.to && d > f.to) return false;
  }
  const q = f.q.trim().toLowerCase();
  if (q && !`${t.symbol} ${t.tradingsymbol} ${t.setupTag ?? ""}`.toLowerCase().includes(q)) return false;
  return true;
}

/** The same predicate minus the view — the base the view counts are taken over,
 *  so each option shows how many rows CHOOSING it would give. */
export function matchesTradeFiltersExceptView(
  t: FilterableTrade,
  f: TradeFilters,
  isUnknownBasis: (id: number) => boolean = () => false,
): boolean {
  return matchesTradeFilters(t, { ...f, view: "all" }, isUnknownBasis);
}
