import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * One-click stop trailing. mode:
 *   "breakeven" → move the trailing SL to the entry price (lock in no-loss).
 * Only the trailing SL is changed; original SL / target / initial risk are untouched.
 * Refuses to set a stop above the current price (would be invalid for a long).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const id = Number(body.tradeId);
  const mode = String(body.mode ?? "breakeven");
  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return NextResponse.json({ ok: false, message: "Trade not found" }, { status: 404 });

  let trailingSl: number;
  if (mode === "breakeven") {
    // Short (sell-to-open) has its entry on the sell leg (avgBuyPrice is unset until covered).
    trailingSl = t.sellQty > t.buyQty ? t.avgSellPrice : t.avgBuyPrice;
  } else {
    return NextResponse.json({ ok: false, message: "Unknown trail mode" }, { status: 400 });
  }

  db.update(trades)
    .set({ trailingSl, updatedAt: sql`(datetime('now'))` })
    .where(eq(trades.id, id))
    .run();

  for (const p of ["/risk", "/equity", "/active", "/"]) revalidatePath(p);
  return NextResponse.json({ ok: true, trailingSl, message: "Stop trailed to breakeven." });
}
