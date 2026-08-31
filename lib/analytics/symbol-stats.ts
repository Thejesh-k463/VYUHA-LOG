/**
 * Per-symbol enrichment for the session planner (PURE, no DB/React).
 *
 * Everything here is computed from the account's OWN trades at render time and
 * never persisted — the numbers are the trader's history with a symbol, not a
 * market claim. Honesty rules:
 *
 *   - Win rate and average R state their n; a figure over zero closed trades
 *     is null, never 0 (invariant 6 — no fabricated denominator).
 *   - Average R is taken ONLY over trades that carry a non-null rMultiple,
 *     and the count says how many that was.
 *   - Expiry proximity comes from the book's own open F&O positions ("your
 *     book has an expiry within N days"), never a live market calendar.
 */

export interface SymbolTradeInput {
  symbol: string;
  netPnl: number;
  rMultiple: number | null;
  isOpen: boolean;
  buyDate: string | null;
  sellDate: string | null;
  segment: string;
  expiry: string | null;
}

export interface SymbolStats {
  symbol: string;
  /** Every trade on the symbol, open or closed. */
  tradeCount: number;
  closedCount: number;
  /** Net P&L over CLOSED trades (open rows have no settled figure). */
  netPnl: number;
  /** Percent of closed trades with positive net, with the n it was taken over. */
  winRate: { pct: number; n: number } | null;
  /** Mean rMultiple over closed trades that carry one, with that count. */
  avgR: { value: number; n: number } | null;
  /** Most recent buy or sell date on the symbol. */
  lastTraded: string | null;
  /** Days to the NEAREST expiry among the book's own open F&O positions. */
  expiryWithinDays: number | null;
}

const FNO_SEGMENTS = new Set([
  "stock_option",
  "index_option",
  "future",
  "commodity_future",
  "commodity_option",
]);

const r2 = (n: number) => Math.round(n * 100) / 100;

function daysBetween(a: string, b: string): number | null {
  const x = new Date(a + "T00:00:00").getTime();
  const y = new Date(b + "T00:00:00").getTime();
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return Math.round((y - x) / 86400000);
}

/**
 * Group the book by symbol (upper-cased) and derive each symbol's history.
 * The caller resolves aliases BEFORE passing trades in, so a position stored
 * under a broker's full name lands on the same key as its canonical ticker.
 */
export function computeSymbolStats(trades: SymbolTradeInput[], today: string): Map<string, SymbolStats> {
  const bySymbol = new Map<string, SymbolTradeInput[]>();
  for (const t of trades) {
    const key = t.symbol.trim().toUpperCase();
    if (!key) continue;
    const cur = bySymbol.get(key);
    if (cur) cur.push(t);
    else bySymbol.set(key, [t]);
  }

  const out = new Map<string, SymbolStats>();
  for (const [symbol, rows] of bySymbol) {
    const closed = rows.filter((t) => !t.isOpen);
    const wins = closed.filter((t) => t.netPnl > 0).length;
    const withR = closed.filter((t) => t.rMultiple != null);

    let lastTraded: string | null = null;
    for (const t of rows) {
      for (const d of [t.buyDate, t.sellDate]) {
        if (d && (!lastTraded || d > lastTraded)) lastTraded = d;
      }
    }

    let expiryWithinDays: number | null = null;
    for (const t of rows) {
      if (!t.isOpen || !t.expiry || !FNO_SEGMENTS.has(t.segment) || t.expiry < today) continue;
      const dte = daysBetween(today, t.expiry);
      if (dte != null && (expiryWithinDays == null || dte < expiryWithinDays)) expiryWithinDays = dte;
    }

    out.set(symbol, {
      symbol,
      tradeCount: rows.length,
      closedCount: closed.length,
      netPnl: r2(closed.reduce((s, t) => s + t.netPnl, 0)),
      winRate: closed.length ? { pct: r2((wins / closed.length) * 100), n: closed.length } : null,
      avgR: withR.length ? { value: r2(withR.reduce((s, t) => s + (t.rMultiple as number), 0) / withR.length), n: withR.length } : null,
      lastTraded,
      expiryWithinDays,
    });
  }
  return out;
}
