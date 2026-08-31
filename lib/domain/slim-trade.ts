// THE TRADES SCREEN'S WIRE FORMAT (PURE, no DB/React).
//
// `app/trades/page.tsx` used to hand the client component the complete
// 74-column `Trade` row for every trade in the book. All of it crossed the
// RSC flight payload on every navigation and every `router.refresh()`:
// measured 1,626 bytes/row on real data — ~16 MB at a 10,000-trade book —
// for a table that renders 15 columns. The columns dropped here are the ones
// NOTHING in the client tree reads: the 64-char dedup hash, source-file
// paths, import notes, the per-component charge breakdown (the edit dialog's
// breakdown comes from the charge-preview API, not the row), the options
// Greeks and the tax-acquisition block (server-rendered panels own those).
//
// ── How the field list stays honest ─────────────────────────────────────────
//
// `TradesClient` and its dialogs are typed against `SlimTrade`, and TanStack
// types `accessorKey` against the row type — so a column, filter or dialog
// that starts reading a dropped field is a COMPILE error, not a silently
// undefined cell. Add the field here, and `toSlimTrade` picks it up from the
// same list. Never widen back to `Trade` "to be safe": the payload is the
// cost, and tsc is the safety.
//
// `notes` and `ruleViolations` are dialog-only but stay in the projection
// deliberately — they are user-authored, overwhelmingly null on an imported
// book, and keeping them means the dialogs need no fetch-on-open round trip.

import type { Trade } from "@/lib/db/schema";

export const SLIM_TRADE_FIELDS = [
  // identity + delete-scope (resolveDeleteScope / DeletableTrade)
  "id",
  "accountId",
  "broker",
  "bucket",
  "segment",
  "instrumentType",
  "exchange",
  "importBatchId",
  "createdAt",
  // instrument cell + option detail
  "symbol",
  "tradingsymbol",
  "expiry",
  "strike",
  "optionType",
  "lotSize",
  // quantities / prices / dates (columns, holding period, dialogs)
  "buyQty",
  "avgBuyPrice",
  "sellQty",
  "avgSellPrice",
  "buyDate",
  "sellDate",
  // P&L columns + view filters (matchesView/countViews read unrealised/closing)
  "buyValue",
  "sellValue",
  "grossPnl",
  "chargesTotal",
  "netPnl",
  "rMultiple",
  "mtfInterest",
  "unrealisedPnl",
  "closingPrice",
  "isOpen",
  "staged",
  // risk plan + journal (edit / journal / close dialogs)
  "slPlanned",
  "trailingSl",
  "targetPlanned",
  "riskAmount",
  "mtfFundedAmount",
  "setupTag",
  "playbookId",
  "emotionTag",
  "mistakeTags",
  "notes",
  "ruleViolations",
  "exitTrigger",
] as const satisfies readonly (keyof Trade)[];

export type SlimTrade = Pick<Trade, (typeof SLIM_TRADE_FIELDS)[number]>;

/** Project a row carrying at least the slim fields down to the wire shape
 *  (never mutates its input). Accepts any superset of `SlimTrade` — the full
 *  `Trade` row, or a column-trimmed query row like `JournalTrade`. */
export function toSlimTrade(t: SlimTrade): SlimTrade {
  const out = {} as Record<string, unknown>;
  for (const k of SLIM_TRADE_FIELDS) out[k] = t[k];
  return out as SlimTrade;
}
