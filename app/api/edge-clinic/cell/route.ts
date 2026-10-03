import { NextResponse } from "next/server";
import { getEntitlement } from "@/lib/queries/license";
import { getTradeCellLine } from "@/lib/queries/edge-clinic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/edge-clinic/cell?tradeId=<id> — v4.7.0 C2 (design D6, review change 5).
 * The journal dialog's one line: the trade's `segment|setup:<tag>` cell from the
 * CACHED report of the selected scope. Never computes.
 *
 * 200 → `{ ok: true, line: TradeCellLine | null }` — null for a FREE copy (the
 * report never leaves the server for one), a trade outside the
 * `getSelectedAccountId()` scope, an unknown trade, or no cached report / cell.
 * 400 → `{ ok: false, message }` for a missing or malformed tradeId.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("tradeId") ?? "";
  const tradeId = /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(tradeId) || tradeId <= 0) {
    return NextResponse.json({ ok: false, message: "tradeId is required." }, { status: 400 });
  }
  if (!getEntitlement().pro) return NextResponse.json({ ok: true, line: null });
  return NextResponse.json({ ok: true, line: getTradeCellLine(tradeId) });
}
