import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { restrictedSecurities } from "@/lib/db/schema";
import { parseRestrictedList } from "@/lib/analytics/restrictions";

export const runtime = "nodejs";

/**
 * Restriction-list mutations use a route handler + client fetch (not a server
 * action), per the project convention, so the page is refreshed explicitly.
 *   { action: "load", text, asOfDate, source }  → replace the whole list
 *   { action: "clear" }                          → empty the list
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "clear") {
    db.delete(restrictedSecurities).run();
    for (const p of ["/surveillance", "/risk", "/"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: "Restriction list cleared." });
  }

  if (body.action === "load") {
    const text = typeof body.text === "string" ? body.text : "";
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(body.asOfDate)
      ? body.asOfDate
      : new Date().toISOString().slice(0, 10);
    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "manual";
    const rows = parseRestrictedList(text, asOfDate, source);
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, message: "No valid rows found. Use: SYMBOL, category, [note]" }, { status: 400 });
    }
    db.transaction((tx) => {
      tx.delete(restrictedSecurities).run();
      for (const r of rows) {
        tx.insert(restrictedSecurities)
          .values({ symbol: r.symbol, category: r.category, stage: r.stage ?? null, note: r.note ?? null, asOfDate: r.asOfDate, source: r.source ?? null })
          .run();
      }
    });
    for (const p of ["/surveillance", "/risk", "/"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} restricted securities.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
