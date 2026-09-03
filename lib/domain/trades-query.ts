/**
 * The `/trades?…` deep-link contract — ONE parser and ONE serializer, so every
 * surface that emits a trades link (dashboard KPI drill-downs, the calendar
 * heatmap, the options-seller popups, the Data Quality Center, the command
 * palette, the Search server, the import summary) and the one that reads it
 * (components/trades/trades-client.tsx) agree on keys, encoding and defaults.
 *
 * Why this exists: the client used to read the query by hand, honoured five of
 * the seven keys the app emitted (`basis=unknown` and `view=open` were dead
 * links), decoded nothing (a symbol with `&` or `%` round-tripped wrong), and
 * then WIPED the query on mount — so a filtered view could never be reloaded
 * or re-entered, and Back from `/trades` skipped the page the user came from.
 *
 * Rules:
 * - `parseTradesQuery` never throws. Unknown keys are ignored; a value that is
 *   not in the contract (a segment that is not a segment, a date that is not
 *   YYYY-MM-DD, a view the select does not offer) is DROPPED, not passed on.
 * - `serializeTradesQuery` is canonical: stable key order, defaults omitted,
 *   every value `encodeURIComponent`-ed. `parse(serialize(q))` is identity for
 *   any valid `q`, and `serialize(parse(href))` reproduces a canonical href —
 *   the "no dead link" test in tests/trades-query.test.ts leans on both.
 * - Pure (invariant 2): no React, no DB, no `window`. The caller passes
 *   `window.location.search` in and writes the result out.
 */

import { SEGMENTS } from "./constants";
import type { TradeView } from "@/lib/analytics/trade-status";

export type TradesAdd = "manual" | "open";
export type TradesBasis = "unknown";

export interface TradesQuery {
  /** One-shot: opens the Add-trade / Open-trade dialog, then leaves the URL. */
  add: TradesAdd | null;
  /** Decoded — the client puts it straight into the search box. */
  symbol: string;
  /** YYYY-MM-DD inclusive window on the trade's EFFECTIVE date. */
  from: string;
  to: string;
  /** Closed trades only — so a realised-P&L drill-down reconciles exactly. */
  realised: boolean;
  /** One of `SEGMENTS`, or "" for all. */
  segment: string;
  /** `unknown` — sales whose cost basis is not on record (Data Quality). */
  basis: TradesBasis | null;
  /** The status/outcome select on /trades. `null` means "all" (the default). */
  view: TradeView | null;
}

export const EMPTY_TRADES_QUERY: Readonly<TradesQuery> = Object.freeze({
  add: null, symbol: "", from: "", to: "", realised: false, segment: "", basis: null, view: null,
});

/**
 * Every value the /trades view select offers. Kept as a local list (rather
 * than importing TRADE_VIEWS at runtime) so this module's only runtime
 * dependency stays lib/domain; tests/trades-query.test.ts pins it equal to
 * `TRADE_VIEWS.map((v) => v.value)` so the two cannot drift.
 */
export const TRADES_QUERY_VIEWS: readonly TradeView[] = [
  "all", "open", "closed", "staged", "open-gain", "open-loss", "closed-profit", "closed-loss",
];

/** Stable emission order. `add` first so a one-shot reads as the intent. */
const KEY_ORDER = ["add", "symbol", "from", "to", "realised", "segment", "basis", "view"] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isView(v: string): v is TradeView {
  return (TRADES_QUERY_VIEWS as readonly string[]).includes(v);
}

/**
 * Parse a search string (`"?symbol=X&view=open"`, with or without the leading
 * `?`) into a `TradesQuery`. Never throws; invalid values are dropped.
 */
export function parseTradesQuery(search: string): TradesQuery {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search ?? "");
  } catch {
    return { ...EMPTY_TRADES_QUERY };
  }
  const get = (k: string): string => (q.get(k) ?? "").trim();

  const add = get("add");
  const from = get("from");
  const to = get("to");
  const segment = get("segment");
  const basis = get("basis");
  const view = get("view");
  const realised = get("realised");

  return {
    add: add === "manual" || add === "open" ? add : null,
    symbol: get("symbol"),
    from: ISO_DATE.test(from) ? from : "",
    to: ISO_DATE.test(to) ? to : "",
    realised: realised === "1" || realised === "true",
    segment: (SEGMENTS as readonly string[]).includes(segment) ? segment : "",
    basis: basis === "unknown" ? "unknown" : null,
    // "all" is the select's default; as a query value it means nothing, so it
    // is normalised to null rather than kept as a no-op key.
    view: view && view !== "all" && isView(view) ? view : null,
  };
}

/**
 * Serialize to a canonical `?k=v&…` string, or `""` when nothing is set — so
 * `pathname + serializeTradesQuery(q)` is always a valid href. Accepts a
 * partial so link builders can write `serializeTradesQuery({ add: "open" })`.
 */
export function serializeTradesQuery(q: Partial<TradesQuery>): string {
  const full: TradesQuery = { ...EMPTY_TRADES_QUERY, ...q };
  const parts: string[] = [];
  for (const k of KEY_ORDER) {
    const v = full[k];
    if (v == null || v === "" || v === false) continue;
    if (k === "view" && v === "all") continue;
    parts.push(`${k}=${encodeURIComponent(v === true ? "1" : String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** True when the query carries nothing — a `/trades?…` link that parses to
 *  this is a dead link: it would show the unfiltered table. */
export function isEmptyTradesQuery(q: TradesQuery): boolean {
  return serializeTradesQuery(q) === "";
}
