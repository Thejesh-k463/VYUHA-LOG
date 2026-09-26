import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { parseSignal } from "@/lib/domain/signal";
import type { SignalTradeRow } from "@/lib/analytics/signal-book";
import { getSelectedAccountId } from "./accounts";

/**
 * THE SIGNAL BOOK's single database reader (v4.3.0).
 *
 * Scoped like every other account-scoped read (invariant 8): the selected
 * account when one is chosen, every account in the aggregate view where 0 is a
 * view and not a place (invariant 9). Nothing here writes, so invariant 9 has
 * only the read half to honour.
 *
 * A COLUMN-TRIMMED PROJECTION, not `getTrades()`: this page renders fifteen
 * cells per row and the analytics read nine fields, while the full row is 75
 * columns — the same reasoning as `getSlimTrades` in lib/queries/trades.ts, and
 * the same ORDER BY so the Signal book lists trades in the journal's own order.
 *
 * `signal_json IS NOT NULL` is a WHERE clause this projection adds on purpose
 * (unlike the perf projections next door, which deliberately add none): the
 * signal book is BY DEFINITION the subset of the book that carries one, and on
 * a 25k-row journal with 42 signals the alternative is mapping every row to
 * throw all but 42 away.
 *
 * Rows the envelope cannot be read from are DROPPED, never half-rendered: the
 * tombstone `{"v":1}` an explicit clear stores, an all-null envelope, and an
 * envelope written by a NEWER release. `parseSignal` is the only thing in the
 * tree that reads the column's content, and `tests/signal-book-page.test.ts`
 * scans lib/, app/ and components/ for a second reader.
 */
export const getSignalTrades = cache((): SignalTradeRow[] => {
  const accountId = getSelectedAccountId();
  const where = accountId > 0 ? and(eq(trades.accountId, accountId), isNotNull(trades.signalJson)) : isNotNull(trades.signalJson);
  const rows = db
    .select({
      id: trades.id,
      symbol: trades.symbol,
      tradingsymbol: trades.tradingsymbol,
      strike: trades.strike,
      optionType: trades.optionType,
      lotSize: trades.lotSize,
      buyQty: trades.buyQty,
      sellQty: trades.sellQty,
      avgBuyPrice: trades.avgBuyPrice,
      avgSellPrice: trades.avgSellPrice,
      buyDate: trades.buyDate,
      sellDate: trades.sellDate,
      isOpen: trades.isOpen,
      netPnl: trades.netPnl,
      // v4.6.0 fix wave (SEAM-V46-1) — the side of a FLAT row, read by sideOf.
      side: trades.side,
      importNotes: trades.importNotes,
      signalJson: trades.signalJson,
    })
    .from(trades)
    .where(where)
    .orderBy(desc(trades.sellDate), desc(trades.createdAt), desc(trades.id))
    .all();

  const out: SignalTradeRow[] = [];
  for (const r of rows) {
    const signal = parseSignal(r.signalJson);
    if (!signal) continue;
    const { signalJson: _drop, ...rest } = r;
    out.push({ ...rest, signal });
  }
  return out;
});
