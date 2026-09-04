import { NextResponse } from "next/server";
import {
  getTradesPage, getDeletableTrades, getFilteredTradeIds, decodeCursor,
  TRADES_PAGE_SIZE, type TradesPageFilters,
} from "@/lib/queries/trades-page";
import { SEGMENTS, BROKERS, BUCKETS } from "@/lib/domain/constants";
import { TRADES_QUERY_VIEWS } from "@/lib/domain/trades-query";
import type { TradeView } from "@/lib/analytics/trade-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ONE PAGE of the /trades table, or the whole-book scope the delete dialog
 * needs — v3.9 server pagination.
 *
 * A route handler rather than a server action, per the repo convention: a
 * server action auto-refreshes the current route, which remounts the sibling
 * client components on this page and would silently reset the column order,
 * the selection and the filters the user just set.
 *
 * `mode=page` (default) returns `{rows, nextCursor, total, viewCounts}` —
 * `total` and `viewCounts` are over the WHOLE filtered set, never the page.
 * `mode=scope` returns the two whole-book lists the "Delete by…" dialog needs
 * and nothing else, so they are fetched when that dialog opens rather than on
 * every page load.
 *
 * Every value is validated against the same vocabularies the deep-link
 * contract uses (lib/domain/trades-query.ts): an unknown broker/segment/
 * bucket/view is DROPPED, not passed to SQL, so a hand-typed URL can only ever
 * widen to "no filter".
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readFilters(url: URL): TradesPageFilters {
  const get = (k: string) => (url.searchParams.get(k) ?? "").trim();
  const oneOf = (v: string, allowed: readonly string[]) => (allowed.includes(v) ? v : "");
  const view = get("view");
  const date = (k: string) => (ISO_DATE.test(get(k)) ? get(k) : "");
  return {
    q: get("q"),
    broker: oneOf(get("broker"), BROKERS as readonly string[]),
    segment: oneOf(get("segment"), SEGMENTS as readonly string[]),
    bucket: oneOf(get("bucket"), BUCKETS as readonly string[]),
    view: ((TRADES_QUERY_VIEWS as readonly string[]).includes(view) ? view : "all") as TradeView,
    realised: get("realised") === "1",
    basisUnknown: get("basis") === "unknown",
    from: date("from"),
    to: date("to"),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filters = readFilters(url);

  if (url.searchParams.get("mode") === "scope") {
    return NextResponse.json({
      ok: true,
      candidates: getDeletableTrades(),
      viewIds: getFilteredTradeIds(filters),
    });
  }

  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= TRADES_PAGE_SIZE
    ? rawLimit
    : TRADES_PAGE_SIZE;

  // A cursor that does not decode is an ERROR, not page one: serving the first
  // page for a malformed token silently restarts the user's scroll.
  const cursor = url.searchParams.get("cursor");
  if (cursor && !decodeCursor(cursor)) {
    return NextResponse.json({ ok: false, error: "Malformed cursor." }, { status: 400 });
  }

  const page = getTradesPage(filters, cursor, limit);
  return NextResponse.json({ ok: true, ...page });
}
