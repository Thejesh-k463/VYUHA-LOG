import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades, tradingSessions } from "@/lib/db/schema";
import { reviewSession } from "@/lib/analytics/session-review";
import { computeSymbolStats, type SymbolStats } from "@/lib/analytics/symbol-stats";
import { getSelectedAccountId } from "./accounts";
import { getAliasMap } from "./aliases";
import { getInstruments } from "./instruments";

/**
 * Everything the /sessions page renders, resolved through the alias map so a
 * position stored under a broker's full name matches its planned ticker
 * instead of scoring as "traded off-watchlist" (the latent bug this file
 * exists to close — the older getSessionsWithReview compared raw strings).
 *
 * Enrichment is computed at render and NEVER persisted: the per-symbol block
 * is the account's own history (n stated, null over an empty denominator),
 * sector/lot-size come from the user's instruments where present, and expiry
 * proximity is the book's own open F&O expiries — no live market claims.
 */

export interface PlannedSymbolInfo {
  symbol: string;
  /** null = no history in this account's book. */
  stats: SymbolStats | null;
  sector: string | null;
  lotSize: number | null;
}

// Column-trimmed projection (2026-08-29 perf-sweep rule): only the 13 fields
// the review + symbol stats read, not all 74. Same account scope as getTrades.
const SESSION_TRADE_COLS = {
  id: trades.id,
  symbol: trades.symbol,
  playbookId: trades.playbookId,
  buyDate: trades.buyDate,
  sellDate: trades.sellDate,
  buyQty: trades.buyQty,
  sellQty: trades.sellQty,
  entryTime: trades.entryTime,
  netPnl: trades.netPnl,
  rMultiple: trades.rMultiple,
  isOpen: trades.isOpen,
  segment: trades.segment,
  expiry: trades.expiry,
};

export function getSessionPlanPage() {
  const accountId = getSelectedAccountId();
  const aliasMap = getAliasMap();
  const canon = (s: string) => aliasMap.get(s.trim().toUpperCase()) ?? s.trim().toUpperCase();

  const tq = db.select(SESSION_TRADE_COLS).from(trades);
  const book = (accountId > 0 ? tq.where(eq(trades.accountId, accountId)) : tq).all();

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // Stats are keyed on the CANONICAL ticker so a planned symbol finds history
  // recorded under any of its broker names.
  const stats = computeSymbolStats(
    book.map((t) => ({ ...t, symbol: canon(t.symbol) })),
    today,
  );

  const instrumentBySymbol = new Map(getInstruments().map((i) => [i.symbol.trim().toUpperCase(), i]));

  const reviewTrades = book.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    playbookId: t.playbookId,
    entryDate: t.sellQty > t.buyQty ? t.sellDate : t.buyDate,
    entryTime: t.entryTime,
    netPnl: t.netPnl,
  }));

  const sq = db.select().from(tradingSessions);
  const sessions = (accountId > 0 ? sq.where(eq(tradingSessions.accountId, accountId)) : sq)
    .orderBy(desc(tradingSessions.sessionDate))
    .all();

  return sessions.map((s) => ({
    ...s,
    review: reviewSession(s, reviewTrades, aliasMap),
    plannedSymbolInfo: s.plannedSymbols.map((raw): PlannedSymbolInfo => {
      const symbol = canon(raw);
      const inst = instrumentBySymbol.get(symbol) ?? null;
      return {
        symbol: raw.trim().toUpperCase(),
        stats: stats.get(symbol) ?? null,
        sector: inst?.sector ?? null,
        lotSize: inst?.lotSize ?? null,
      };
    }),
  }));
}
