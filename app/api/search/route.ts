import { NextResponse } from "next/server";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { searchAll } from "@/lib/queries/search";
import { parseCategories, RESULT_CAP, SOURCE_KEYS } from "@/lib/domain/search-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=…&cat=a,b — Search v1 (v3.8).
 *
 * Answers `{ ok, q, categories, cap, results, tookMs }`, at most RESULT_CAP
 * results per source, ranked within each source. The account is the SELECTED
 * one (invariant 8), resolved server-side — never taken from the client — and
 * the response is `no-store`: a cached answer would outlive an account switch
 * and show one book's trades under another's name.
 *
 * 400 when `q` is blank, or when `cat` names no known source (a typo in a
 * chip must not silently widen the search to everything).
 */
/**
 * The throws that are the QUERY's fault (SQLite's own wording for a MATCH
 * expression it cannot parse). Anything else is the INSTALL's fault and must
 * not be reported to the user as a bad search.
 *
 * ANCHORED, because these words appear inside install failures too: unanchored,
 * `no such module: fts5` (FTS5 not compiled in) and `near "selec": syntax
 * error` (a broken query in our OWN SQL) both answered 400 "could not be
 * searched" — the very blame-the-user bug this constant exists to prevent.
 * better-sqlite3 surfaces sqlite3_errmsg verbatim, and the query-fault texts
 * START with the wording: `unterminated string`, `fts5: syntax error near
 * "…"`, `malformed MATCH expression for table …`.
 */
const QUERY_FAULT = /^(fts5: syntax error|unterminated string|malformed MATCH)/i;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ ok: false, message: "q is required." }, { status: 400 });

  const categories = parseCategories(url.searchParams.get("cat"));
  if (categories && categories.length === 0) {
    return NextResponse.json({ ok: false, message: `cat names no known source. Known: ${SOURCE_KEYS.join(", ")}.` }, { status: 400 });
  }

  const accountId = getSelectedAccountId();
  let results, tookMs;
  try {
    ({ results, tookMs } = searchAll(q, { accountId, categories: categories ?? undefined }));
  } catch (e) {
    // A search box is a place users PASTE into, so a throw that the QUERY
    // caused is fallible input handling: 400, and the palette renders
    // "Search failed — try again." It used to be an unhandled 500 — a NUL in
    // the query reached FTS5 as `unterminated string` and the route crashed.
    //
    // But ONLY a throw the query caused. Blanket-catching turned a locked
    // database, a missing `trades_fts` table and an entitlement failure into
    // the same "that query could not be searched" — blaming the user for a
    // broken install, and hiding the breakage from the perf sweep's
    // console-error gate, which only watches 5xx. So the query-shaped errors
    // are named, and everything else is logged and rethrown as a 500.
    if (QUERY_FAULT.test((e as Error)?.message ?? "")) {
      return NextResponse.json({ ok: false, message: "That query could not be searched." }, { status: 400 });
    }
    console.error("[api/search] search failed:", e);
    throw e;
  }
  return NextResponse.json(
    { ok: true, q, categories: categories ?? SOURCE_KEYS, cap: RESULT_CAP, results, tookMs },
    { headers: { "Cache-Control": "no-store" } },
  );
}
