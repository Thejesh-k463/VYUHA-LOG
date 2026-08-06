import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { instruments, instrumentIndices } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { parseInstrumentList } from "@/lib/analytics/instruments";
import { parseInstrumentsFile, indexLabelFromFilename } from "@/lib/import/instruments-file";
import nseIndexMap from "@/lib/data/nse-index-map.json";

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
      // Sector fills only EMPTY cells: identity facts (name/ISIN/lot) come from
      // the exchange, but a sector the user typed is their classification — an
      // upload must never silently overwrite it.
      if (parsed.fields.includes("sector") && r.sector) {
        set.sector = sql`COALESCE(${instruments.sector}, ${r.sector})`;
      }
      if (Object.keys(set).length === 1) continue; // nothing but the timestamp
      db.insert(instruments)
        .values({
          symbol: r.symbol,
          name: r.name,
          isin: r.isin,
          lotSize: r.lotSize,
          sector: r.sector ?? null,
        })
        .onConflictDoUpdate({ target: instruments.symbol, set })
        .run();
      if (known) updated += 1;
      else added += 1;
    }
    // A constituent list is also a membership fact: the file IS "these symbols
    // are in index X", X read from the standard ind_*_list.csv filename.
    let memberships = 0;
    if (parsed.format === "index-constituents" && typeof body.fileName === "string") {
      const label = indexLabelFromFilename(body.fileName);
      if (label) {
        for (const r of parsed.rows) {
          if (!existing.has(r.symbol) && !addAll) continue;
          db.insert(instrumentIndices)
            .values({ symbol: r.symbol, indexName: label })
            .onConflictDoNothing()
            .run();
          memberships += 1;
        }
      }
    }
    revalidate();
    const what =
      parsed.format === "fo-lots" ? "lot sizes"
      : parsed.format === "index-constituents" ? "sectors + names + ISINs"
      : parsed.format === "securities-list" ? "names + ISINs" : "ISINs/names";
    return NextResponse.json({
      ok: true,
      message: `Read ${parsed.count} rows (${parsed.format}) — ${what}: ${updated} updated, ${added} added.${
        memberships ? ` Index membership recorded for ${memberships} symbols.` : ""
      }${
        parsed.format !== "fo-lots" && !body.addAll ? " Only symbols already in your master were touched." : ""
      }`,
    });
  }

  if (body.action === "load-nse-map") {
    // One-click sector/theme fill from the BUNDLED snapshot of NSE's index
    // constituent lists — lib/data/nse-index-map.json, regenerated by
    // scripts/build-nse-index-map.mjs. Same merge rules as a file upload:
    // names/ISINs are written, sectors fill only empty cells, and by default
    // only symbols already in the master are touched.
    const addAll = body.addAll === true;
    const map = nseIndexMap as {
      asOf: string;
      symbols: Record<string, { industry: string | null; isin: string | null; name: string | null; indices: string[] }>;
    };
    const existing = new Set(
      db.select({ symbol: instruments.symbol }).from(instruments).all().map((r) => r.symbol),
    );
    let touched = 0;
    let memberships = 0;
    db.transaction(() => {
      for (const [symbol, v] of Object.entries(map.symbols)) {
        const known = existing.has(symbol);
        if (!known && !addAll) continue;
        const set: Record<string, unknown> = { updatedAt: sql`(datetime('now'))` };
        if (v.name) set.name = v.name;
        if (v.isin) set.isin = v.isin;
        if (v.industry) set.sector = sql`COALESCE(${instruments.sector}, ${v.industry})`;
        db.insert(instruments)
          .values({ symbol, name: v.name, isin: v.isin, sector: v.industry, lotSize: null })
          .onConflictDoUpdate({ target: instruments.symbol, set })
          .run();
        touched += 1;
        for (const idx of v.indices) {
          db.insert(instrumentIndices).values({ symbol, indexName: idx }).onConflictDoNothing().run();
          memberships += 1;
        }
      }
    });
    revalidate();
    return NextResponse.json({
      ok: true,
      message: touched === 0
        ? "No matching symbols yet — add or import trades first, or tick “add every symbol”."
        : `NSE map (as of ${map.asOf}) applied to ${touched} symbols — sectors filled where empty, ${memberships} index memberships recorded.`,
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
