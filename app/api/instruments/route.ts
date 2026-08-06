import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { parseInstrumentList } from "@/lib/analytics/instruments";
import { parseInstrumentsFile } from "@/lib/import/instruments-file";

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

  if (body.action === "file") {
    // NSE file upload (bhavcopy / EQUITY_L / fo_mktlots). MERGE semantics: only
    // the columns the file actually supplies are written — a bhavcopy carries
    // no sector, and overwriting would wipe every sector the user has tagged.
    const parsed = parseInstrumentsFile(typeof body.text === "string" ? body.text : "");
    if (parsed.format === "unknown" || parsed.count === 0) {
      return NextResponse.json(
        { ok: false, message: parsed.warnings[0] ?? "Could not read the file." },
        { status: 400 },
      );
    }
    // Existing-only mode (default for bhavcopy/securities list): enrich the
    // instruments the user already tracks rather than dumping all ~2000 NSE
    // listings into their master. `addAll` opts into inserting everything —
    // the sane default for the lots file, which is only ~200 F&O names.
    const addAll = body.addAll === true || parsed.format === "fo-lots";
    const existing = new Set(
      db.select({ symbol: instruments.symbol }).from(instruments).all().map((r) => r.symbol),
    );
    let updated = 0;
    let added = 0;
    for (const r of parsed.rows) {
      const known = existing.has(r.symbol);
      if (!known && !addAll) continue;
      const set: Record<string, unknown> = { updatedAt: sql`(datetime('now'))` };
      if (parsed.fields.includes("name") && r.name) set.name = r.name;
      if (parsed.fields.includes("isin") && r.isin) set.isin = r.isin;
      if (parsed.fields.includes("lotSize") && r.lotSize) set.lotSize = r.lotSize;
      if (Object.keys(set).length === 1) continue; // nothing but the timestamp
      db.insert(instruments)
        .values({
          symbol: r.symbol,
          name: r.name,
          isin: r.isin,
          lotSize: r.lotSize,
          sector: null,
        })
        .onConflictDoUpdate({ target: instruments.symbol, set })
        .run();
      if (known) updated += 1;
      else added += 1;
    }
    revalidate();
    const what =
      parsed.format === "fo-lots" ? "lot sizes" : parsed.format === "securities-list" ? "names + ISINs" : "ISINs/names";
    return NextResponse.json({
      ok: true,
      message: `Read ${parsed.count} rows (${parsed.format}) — ${what}: ${updated} updated, ${added} added.${
        parsed.format !== "fo-lots" && !body.addAll ? " Only symbols already in your master were touched." : ""
      }`,
    });
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
