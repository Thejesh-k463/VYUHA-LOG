import { quoteKeyId, type Exchange, type QuoteKey } from "@/lib/quotes/types";

/**
 * THE OPEN-POSITION → PROVIDER-KEY RULE (PURE — no DB, no React).
 *
 * Extracted in v4.7.0 C5 (design D3) from `app/api/live/stream/route.ts`, where
 * it lived as `openPositionKeys()`, so the Live Desk's stream and the Telegram
 * alert job (`lib/jobs/telegram-alerts.ts`) build their `QuoteKey`s by ONE rule:
 * a copy is a second rule the day one of them changes. The stream's behaviour is
 * unchanged — it hands this the SELECTED account's tracker rows (invariant 8);
 * the alert job hands it every account's alertable rows (ruling TG3, design D7).
 *
 * The rule: `is_open` is the open predicate (never `sell_date IS NULL`, which is
 * a sort key on this table — lib/analytics/positions.ts); the symbol is trimmed
 * and upper-cased; an unknown exchange reads as NSE; a derivative carries its
 * own contract as `tradingsymbol` (so `quoteKeyId()` prices it off its own
 * contract, owner ruling A-1); duplicates collapse on `quoteKeyId()`; at most
 * `MAX_POSITION_KEYS` keys, before the provider's own cap applies.
 */

/** Ceiling on one subscription / snapshot set. */
export const MAX_POSITION_KEYS = 500;

const EXCHANGES: readonly Exchange[] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];

/** The columns the rule reads — what `getTrackerTrades()` and a raw select both carry. */
export interface PositionKeyRow {
  symbol: string;
  exchange: string | null | undefined;
  tradingsymbol: string | null | undefined;
  isOpen: boolean;
}

export function toExchange(raw: string | null | undefined): Exchange {
  const v = (raw ?? "").trim().toUpperCase();
  return (EXCHANGES as readonly string[]).includes(v) ? (v as Exchange) : "NSE";
}

/** One row's key — the same key `positionKeys()` would emit for it. */
export function positionKeyFor(t: Omit<PositionKeyRow, "isOpen">): QuoteKey {
  return {
    symbol: t.symbol.trim().toUpperCase(),
    exchange: toExchange(t.exchange),
    ...(t.tradingsymbol && t.tradingsymbol !== t.symbol ? { tradingsymbol: t.tradingsymbol.trim().toUpperCase() } : {}),
  };
}

/** The open rows as provider keys, deduped, capped. */
export function positionKeys(rows: Iterable<PositionKeyRow>, max: number = MAX_POSITION_KEYS): QuoteKey[] {
  const out: QuoteKey[] = [];
  const seen = new Set<string>();
  for (const t of rows) {
    if (!t.isOpen) continue;
    const key = positionKeyFor(t);
    const id = quoteKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}
