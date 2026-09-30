import { NextResponse } from "next/server";
import { getDashboardExportRows } from "@/lib/queries/trades";
import { parseDashboardFilters, sanitizeDashboardFilters } from "@/lib/analytics/dashboard-aggregate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dashboard's CSV/XLSX rows, fetched on the click (v4.7.0 C0).
 *
 * Since C0 the dashboard page ships `DashboardAggregate` and no trade row, so
 * the export reads its rows here instead. A route handler answered by client
 * `fetch`, NOT a server action: a server-action call refreshes the route and
 * remounts the sibling client components (AGENTS.md), which would reset the
 * filter controls the user just set.
 *
 * The query string is the dashboard's own (`dashboardQuery(filters, "")`): an
 * absent `bucket` is "Both buckets" here — the client sends the filters the
 * figures were computed under, already resolved against the workspace. Every
 * value is checked against the vocabulary, so a hand-typed URL can only widen
 * to "no filter". Scope is `getDashboardTrades()`'s — the selected account, or
 * every account in the aggregate view (invariant 8).
 */
export function GET(req: Request) {
  const url = new URL(req.url);
  const filters = sanitizeDashboardFilters(parseDashboardFilters(Object.fromEntries(url.searchParams), ""));
  return NextResponse.json({ ok: true, rows: getDashboardExportRows(filters) });
}
