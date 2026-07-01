import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { symbolAliases } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseAliasList } from "@/lib/analytics/aliases";

export const runtime = "nodejs";

function revalidate() {
  for (const p of ["/aliases", "/surveillance", "/risk"]) revalidatePath(p);
}

/** Upsert one alias by its unique `alias` key. */
function upsert(alias: string, ticker: string, note: string | null) {
  db.insert(symbolAliases)
    .values({ alias, ticker, note })
    .onConflictDoUpdate({ target: symbolAliases.alias, set: { ticker, note } })
    .run();
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "clear") {
    db.delete(symbolAliases).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "All aliases cleared." });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    db.delete(symbolAliases).where(eq(symbolAliases.id, id)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "Alias deleted." });
  }

  if (body.action === "add") {
    const alias = String(body.alias ?? "").trim().toUpperCase();
    const ticker = String(body.ticker ?? "").trim().toUpperCase();
    if (!alias || !ticker) return NextResponse.json({ ok: false, message: "Both name and ticker are required." }, { status: 400 });
    upsert(alias, ticker, typeof body.note === "string" ? body.note : null);
    revalidate();
    return NextResponse.json({ ok: true, message: `Mapped ${alias} → ${ticker}.` });
  }

  if (body.action === "load") {
    const rows = parseAliasList(typeof body.text === "string" ? body.text : "");
    if (rows.length === 0) return NextResponse.json({ ok: false, message: "No valid rows. Use: NAME, TICKER" }, { status: 400 });
    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(symbolAliases)
          .values({ alias: r.alias, ticker: r.ticker, note: r.note ?? null })
          .onConflictDoUpdate({ target: symbolAliases.alias, set: { ticker: r.ticker, note: r.note ?? null } })
          .run();
      }
    });
    revalidate();
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} alias${rows.length === 1 ? "" : "es"}.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
