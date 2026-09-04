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
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ ok: false, message: "q is required." }, { status: 400 });

  const categories = parseCategories(url.searchParams.get("cat"));
  if (categories && categories.length === 0) {
    return NextResponse.json({ ok: false, message: `cat names no known source. Known: ${SOURCE_KEYS.join(", ")}.` }, { status: 400 });
  }

  const accountId = getSelectedAccountId();
  // A search box is a place users PASTE into, so the fan-out is treated as
  // fallible input handling, not as trusted code: any throw (a malformed FTS5
  // expression, a locked DB, a reader that meets a row it cannot shape) is
  // the QUERY's failure, and the palette renders "Search failed — try again."
  // off a 400. It used to be an unhandled 500 — a NUL in the query reached
  // FTS5 as `unterminated string` and the whole route crashed.
  let results, tookMs;
  try {
    ({ results, tookMs } = searchAll(q, { accountId, categories: categories ?? undefined }));
  } catch {
    return NextResponse.json({ ok: false, message: "That query could not be searched." }, { status: 400 });
  }
  return NextResponse.json(
    { ok: true, q, categories: categories ?? SOURCE_KEYS, cap: RESULT_CAP, results, tookMs },
    { headers: { "Cache-Control": "no-store" } },
  );
}
