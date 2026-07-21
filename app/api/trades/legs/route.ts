import { NextResponse } from "next/server";
import { getStagedView } from "@/lib/queries/staged";

export const runtime = "nodejs";

/**
 * The entry ladder behind a staged position, priced and marked.
 *
 * Returns `{ ok: true, view: null }` — not a 404 — for a trade that has no
 * legs yet, so the client can render the "turn on staged mode" empty state
 * without treating a normal trade as an error.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tradeId = Number(url.searchParams.get("tradeId"));
  if (!Number.isFinite(tradeId)) {
    return NextResponse.json({ ok: false, message: "Bad tradeId" }, { status: 400 });
  }
  const view = getStagedView(tradeId);
  return NextResponse.json({ ok: true, view });
}
