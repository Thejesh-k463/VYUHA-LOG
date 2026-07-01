import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { parseInstrumentList } from "@/lib/analytics/instruments";

export const runtime = "nodejs";

function revalidate() {
  for (const p of ["/instruments", "/risk"]) revalidatePath(p);
}

type Fields = { name: string | null; sector: string | null; lotSize: number | null; isin: string | null };

/** Upsert one instrument by its unique `symbol` key. */
function upsert(symbol: string, f: Fields) {
  db.insert(instruments)
    .values({ symbol, ...f })
    .onConflictDoUpdate({ target: instruments.symbol, set: { ...f, updatedAt: sql`(datetime('now'))` } })
    .run();
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "clear") {
    db.delete(instruments).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "All instruments cleared." });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    db.delete(instruments).where(eq(instruments.id, id)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "Instrument deleted." });
  }

  if (body.action === "add") {
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    if (!symbol) return NextResponse.json({ ok: false, message: "Symbol is required." }, { status: 400 });
    const lot = Number(body.lotSize);
    upsert(symbol, {
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : null,
      sector: typeof body.sector === "string" && body.sector.trim() ? body.sector.trim() : null,
      lotSize: Number.isFinite(lot) && lot > 0 ? lot : null,
      isin: typeof body.isin === "string" && body.isin.trim() ? body.isin.trim().toUpperCase() : null,
    });
    revalidate();
    return NextResponse.json({ ok: true, message: `Saved ${symbol}.` });
  }

  if (body.action === "load") {
    const rows = parseInstrumentList(typeof body.text === "string" ? body.text : "");
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, message: "No valid rows. Use: SYMBOL, SECTOR, [NAME], [LOT], [ISIN]" }, { status: 400 });
    }
    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(instruments)
          .values({ symbol: r.symbol, name: r.name, sector: r.sector, lotSize: r.lotSize, isin: r.isin })
          .onConflictDoUpdate({
            target: instruments.symbol,
            set: { name: r.name, sector: r.sector, lotSize: r.lotSize, isin: r.isin, updatedAt: sql`(datetime('now'))` },
          })
          .run();
      }
    });
    revalidate();
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} instrument${rows.length === 1 ? "" : "s"}.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
