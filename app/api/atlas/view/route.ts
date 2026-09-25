import { NextResponse } from "next/server";
import { getAtlasIndexView, listIndexFilters, NO_CHARTINK_LINE } from "@/lib/queries/atlas";
import { getEntitlement } from "@/lib/queries/license";
import { CROSS_ORIGIN_MESSAGE, isSameOrigin } from "../origin";

/**
 * `GET /api/atlas/view?index=<name>` — the index-membership FILTER (v4.6.0 W5,
 * owner ruling AQ23, design review A8).
 *
 * A non-"All" filter is computed IN MEMORY over the aligned series and
 * returned; it NEVER writes the cache. `atlas_metric` is unique on
 * `(as_of, metric, group_kind, group_name)` and `atlas_daily`'s checksum covers
 * ALL bars, so a filtered persist would be served as the market on the next
 * open. Stored rows stay unfiltered; this is a view over them.
 *
 * Without `index` it lists the filters the bundled index map exposes (the
 * eight size indices and the sectoral/thematic ones), so the client never
 * hard-codes a name.
 *
 * NO EGRESS: reads `price_history` the user already has. PRO (Q55): the same
 * verbatim refusal as app/api/atlas/route.ts — this endpoint must not be the
 * side door around <ProGate>. Same-origin, like every /api/atlas route.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** <ProGate>'s only blocking branch, verbatim — see app/api/tax-itr/route.ts. */
function proRefusal(): NextResponse | null {
  const ent = getEntitlement();
  if (!(ent.state === "licensed" || ent.pro || ent.enforcement === "banner")) {
    return NextResponse.json({ ok: false, message: "Vyuha Pro required." }, { status: 403 });
  }
  return null;
}

export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
  const refused = proRefusal();
  if (refused) return refused;
  const index = new URL(req.url).searchParams.get("index")?.trim() ?? "";
  if (!index || index.toLowerCase() === "all") {
    return NextResponse.json({ ok: true, filters: listIndexFilters(), provenance: NO_CHARTINK_LINE });
  }
  const view = getAtlasIndexView(index);
  if (!view.ok) return NextResponse.json({ ok: false, message: view.message, provenance: NO_CHARTINK_LINE }, { status: 404 });
  return NextResponse.json({ provenance: NO_CHARTINK_LINE, ...view });
}
