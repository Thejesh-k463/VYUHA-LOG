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
  // v4.6.0 W6 (migration 0077): which side OPENED the row. A flat (fully
  // closed) row cannot state it through its quantities, and every client-side
  // direction read (`tradeDirection`, the dialogs, the table's Entry/Exit
  // columns) goes through `sideOf`, which reads this on a flat row.
  "side",
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
  // v4.4.0 D2: WHERE that riskAmount came from ('cap' | 'set' | 'frozen' | null,
  // migration 0073). One nullable short string per row, and it travels with the
  // risk plan it describes — every Avg R surface labels cap-unit R from it, and
  // /lenses reads it through LENS_FIELDS, which must stay a subset of this list.
  "riskSource",
  "mtfFundedAmount",
  "setupTag",
  "playbookId",
  "emotionTag",
  "mistakeTags",
  "notes",
  // v4.3.0: the Signal book's envelope. Same reasoning as `notes` above — the
  // edit dialog is typed on SlimTrade and its Signal section seeds from this
  // value, it is user-authored, and it is null on every imported book. Fetching
  // it when the dialog opens is the round trip slim-trade.ts:22-24 rejects.
  "signalJson",
  "ruleViolations",
  "exitTrigger",
  // v3.7: the /trades table shows a reviewed marker and the queue's "Mark
  // reviewed" acts on the same row — one nullable string, so the marker costs
  // no fetch-on-render. Deliberately NOT added to LENS_FIELDS
  // (lib/queries/trades.ts): /lenses groups and aggregates, it never renders a
  // per-trade review state, and that projection is being REDUCED in v3.7.
  "reviewedAt",
  // v4.3.0 T2: brokerage is per executed order, so the close dialog's live
  // preview bills the stored counts exactly as closePosition does — without them
  // it billed an option closed from 2 + 3 orders as 1 + 2. Two user-journal
  // integers (never gated analytics).
  "buyOrderCount",
  "sellOrderCount",
] as const satisfies readonly (keyof Trade)[];

export type SlimTrade = Pick<Trade, (typeof SLIM_TRADE_FIELDS)[number]> & {
  /**
   * W2b — the EXECUTION this row is a piece of, when an import's automatic
   * close made it one; null otherwise. DERIVED, never a column: it is
   * `executionHashOfPiece` read off `dedup_hash` + `import_notes`, both of
   * which stay off the wire (this is one short string instead of the whole
   * notes column). It is the only thing that may show the "Un-close" row
   * action — a row with no `closedBy` was never closed by an import.
   *
   * Optional because only the /trades page derives it (`lib/queries/trades-page.ts`);
   * every other projection through `toSlimTrade` leaves it null.
   */
  closedBy?: string | null;
};

/** Project a row carrying at least the slim fields down to the wire shape
 *  (never mutates its input). Accepts any superset of `SlimTrade` — the full
 *  `Trade` row, or a column-trimmed query row like `JournalTrade`. */
export function toSlimTrade(t: SlimTrade): SlimTrade {
  const out = {} as Record<string, unknown>;
  for (const k of SLIM_TRADE_FIELDS) out[k] = t[k];
  // Derived, so it is not in the field list; carried through when the caller
  // has already derived it, and stated as null rather than absent when not.
  out.closedBy = t.closedBy ?? null;
  return out as SlimTrade;
}
