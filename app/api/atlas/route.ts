import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getStoredSnapshot, refreshAtlasSnapshot, NO_CHARTINK_LINE } from "@/lib/queries/atlas";
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
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
  const snapshot = getStoredSnapshot();
  return NextResponse.json({
    ok: true,
    computed: snapshot !== null,
    provenance: NO_CHARTINK_LINE,
    snapshot,
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
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
