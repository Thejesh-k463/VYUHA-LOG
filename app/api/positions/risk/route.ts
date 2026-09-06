import { todayIstIso } from "@/lib/domain/trading-day";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { writeTypedMark } from "@/lib/queries/mtm";
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

  // Only the fields PRESENT in the body are written. The risk dialog always
  // sends all five, so its saves behave as before ("" still clears a field);
  // a partial caller (the unmarked-holdings panel sends only mtmPrice) must
  // not silently wipe an existing stop or target.
  const has = (k: string) => k in (body as Record<string, unknown>);
  const originalSl = has("originalSl") ? numOrNull(body.originalSl) : t.slPlanned;
  const mtmPrice = numOrNull(body.mtmPrice);

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
      riskAmount,
      rMultiple,
      updatedAt: sql`(datetime('now'))`,
      ...(has("originalSl") ? { slPlanned: originalSl } : {}),
      ...(has("trailingSl") ? { trailingSl: numOrNull(body.trailingSl) } : {}),
      ...(has("target") ? { targetPlanned: numOrNull(body.target) } : {}),
      ...(has("impliedVol") ? { impliedVol: numOrNull(body.impliedVol) } : {}),
    })
    .where(eq(trades.id, id))
    .run();

  if (mtmPrice != null && !(mtmPrice > 0)) {
    // Refused: a typed 0 used to sit unread in a second row; now that a typed
    // mark replaces the day's row it would erase the real one.
    return NextResponse.json({ ok: false, message: "A mark is a price above zero." }, { status: 400 });
  }
  if (mtmPrice != null) {
    // DELETE-THEN-INSERT for (symbol, IST day), not a bare insert: the number
    // the user just typed is the day's mark, and a plain insert made it the
    // row nobody reads. Every reader takes the FIRST row of the newest
    // `as_of_date` with no tiebreak — rowid order — so a mark typed after the
    // automatic 15:31 write (`lib/quotes/persist-mark.ts`) sat behind it and
    // changed nothing on screen. `writeTypedMark()` is the same one
    // transaction the feed and the bhavcopy apply already use.
    writeTypedMark({
      symbol: t.symbol,
      tradingsymbol: t.tradingsymbol,
      price: mtmPrice,
      asOfDate: todayIstIso(),
    });
  }

  for (const p of ["/risk", "/equity", "/active", "/", "/trades"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: "Saved." });
}
