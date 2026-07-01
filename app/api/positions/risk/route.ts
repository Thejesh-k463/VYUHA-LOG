import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades, mtmPrices } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

const numOrNull = (v: unknown): number | null => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Set per-position risk inputs (original SL, trailing SL, target) and the current
 * MTM price for an open position. Recomputes riskAmount (= |entry − SL| × open qty)
 * and R-multiple so the rest of the app uses the real stop, not the flat default.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const id = Number(body.tradeId);
  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return NextResponse.json({ ok: false, message: "Trade not found" }, { status: 404 });

  const originalSl = numOrNull(body.originalSl);
  const trailingSl = numOrNull(body.trailingSl);
  const target = numOrNull(body.target);
  const mtmPrice = numOrNull(body.mtmPrice);
  const impliedVol = numOrNull(body.impliedVol);

  // Short (sell-to-open) has its entry on the sell leg — avgBuyPrice is unset until covered.
  const isShort = t.sellQty > t.buyQty;
  const openQty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
  const entryPrice = isShort ? t.avgSellPrice : t.avgBuyPrice;
  const riskAmount =
    originalSl != null && openQty > 0
      ? Math.round(Math.abs(entryPrice - originalSl) * openQty * 100) / 100
      : t.riskAmount;
  const rMultiple =
    riskAmount && riskAmount > 0 ? Math.round((t.netPnl / riskAmount) * 100) / 100 : t.rMultiple;

  db.update(trades)
    .set({
      slPlanned: originalSl,
      trailingSl,
      targetPlanned: target,
      riskAmount,
      rMultiple,
      impliedVol,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(trades.id, id))
    .run();

  if (mtmPrice != null) {
    const asOf = new Date().toISOString().slice(0, 10);
    db.insert(mtmPrices)
      .values({ symbol: t.symbol.toUpperCase(), tradingsymbol: t.tradingsymbol, price: mtmPrice, asOfDate: asOf })
      .run();
  }

  for (const p of ["/risk", "/equity", "/active", "/", "/trades"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: "Saved." });
}
