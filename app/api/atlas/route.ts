import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getVerifiedSnapshot, refreshAtlasSnapshot, NO_CHARTINK_LINE } from "@/lib/queries/atlas";
import { getEntitlement } from "@/lib/queries/license";
import { CROSS_ORIGIN_MESSAGE, isSameOrigin } from "./origin";

/**
 * `GET /api/atlas`  — the latest stored snapshot, computed or not.
 * `POST /api/atlas` — recompute it now (`{force:true}` re-runs even when the
 *                     input checksum is unchanged, e.g. after a spec bump).
 *
 * The GET never computes: a read must not be able to start a 2,000-symbol
 * recompute by accident. `/atlas` itself calls `getAtlasView()`, which
 * recomputes only when the checksum moved, so the ordinary path is still one
 * click and the button here is the explicit override.
 *
 * NO EGRESS. Both verbs read `price_history` rows the user already has. The
 * only thing on this feature that touches the network is the backfill, and it
 * has its own route, its own consent and its own rate limit.
 *
 * PRO (Q55). `/atlas` sits behind the gate, so this endpoint must not be the
 * side door around it — the predicate is the one `app/api/tax-itr/route.ts`
 * uses, mirroring <ProGate>'s ONE blocking branch so every state that renders
 * the screen also answers here.
 *
 * THE GET SERVES A CHECKED SNAPSHOT, NOT THE RAW ROW. `atlas_daily` is keyed on
 * the anchor session and read by max(as_of); after a restore replaced the bars,
 * a surviving later row is a true statement about inputs this database no
 * longer holds. Migration 0065 calls that stale EVIDENCE and forbids serving it
 * as data, so the read goes through `getVerifiedSnapshot()` and reports
 * `stale: true` with a null snapshot instead of publishing it.
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
  const { snapshot, stale } = getVerifiedSnapshot();
  return NextResponse.json({
    ok: true,
    computed: snapshot !== null,
    stale,
    provenance: NO_CHARTINK_LINE,
    snapshot,
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
  const refused = proRefusal();
  if (refused) return refused;
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  const result = refreshAtlasSnapshot({ force: body.force === true });
  if (result.recomputed) revalidatePath("/atlas");
  return NextResponse.json({
    ok: true,
    recomputed: result.recomputed,
    reason: result.reason,
    provenance: NO_CHARTINK_LINE,
    snapshot: result.snapshot,
  });
}
