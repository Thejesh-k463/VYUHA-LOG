import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { closePosition } from "@/lib/import/commit";

export const runtime = "nodejs";

/** Close an open position at an exit price → realised P&L (feeds dashboards & capital). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const id = Number(body?.tradeId);
  const exitPrice = Number(body?.exitPrice);
  if (!Number.isFinite(id) || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return NextResponse.json({ ok: false, message: "Valid exit price required." }, { status: 400 });
  }
  const res = closePosition(id, exitPrice, body?.exitDate ?? null);
  if (res.ok) {
    for (const p of ["/risk", "/equity", "/active", "/", "/trades"]) revalidatePath(p);
  }
  return NextResponse.json(res);
}
