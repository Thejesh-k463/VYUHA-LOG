import { todayIstIso } from "@/lib/domain/trading-day";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { restrictedSecurities } from "@/lib/db/schema";
import { CATEGORY_META, parseRestrictedList } from "@/lib/analytics/restrictions";
import { parseNseSurveillance } from "@/lib/import/nse-surveillance";
import { replaceRestrictionCategories } from "@/lib/queries/restrictions";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Restriction-list mutations use a route handler + client fetch (not a server
 * action), per the project convention, so the page is refreshed explicitly.
 *   { action: "file", text, fileName?, asOfDate? } → parse an official NSE
 *       file (fo_secban.csv / REG_IND) and replace ONLY the categories that
 *       file speaks for
 *   { action: "load", text, asOfDate, source }  → replace the whole list (paste)
 *   { action: "clear" }                          → empty the list
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "clear") {
    const gone = db.delete(restrictedSecurities).run().changes;
    recordAudit({ entity: "restriction", action: "delete", summary: `Cleared the restriction list (${gone} rows)` });
    for (const p of ["/surveillance", "/risk", "/"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: "Restriction list cleared." });
  }

  if (body.action === "file") {
    const text = typeof body.text === "string" ? body.text : "";
    const fileName = typeof body.fileName === "string" ? body.fileName : undefined;
    const parsed = parseNseSurveillance(text, fileName);
    if ("refused" in parsed) {
      return NextResponse.json({ ok: false, message: parsed.refused }, { status: 400 });
    }
    // The file's own date wins; the fallback is NAMED in the recap rather than
    // silently substituted.
    const fallbackDate = /^\d{4}-\d{2}-\d{2}$/.test(body.asOfDate)
      ? (body.asOfDate as string)
      : todayIstIso();
    const asOf = parsed.asOf ?? fallbackDate;
    const rows = parsed.rows.map((r) => ({ ...r, asOfDate: asOf, source: "NSE" }));
    const { deleted } = replaceRestrictionCategories(parsed.categories, rows);
    const catLabels = parsed.categories.map((c) => CATEGORY_META[c].label).join("/");
    const skippedNote = Object.keys(parsed.skipped).length
      ? ` Skipped: ${Object.entries(parsed.skipped).map(([k, v]) => `${k} ×${v}`).join(", ")}.`
      : "";
    const message =
      `Imported ${rows.length} ${catLabels} row${rows.length === 1 ? "" : "s"} from the ${parsed.kindLabel}` +
      ` (as of ${asOf}${parsed.asOf ? "" : " — date not in the file, using the form date"})` +
      `, replacing ${deleted}.${skippedNote}` +
      (rows.length === 0 ? " An empty ban day clears that category — nothing is currently banned." : "");
    recordAudit({
      entity: "restriction",
      action: "create",
      summary: `Imported ${rows.length} ${catLabels} rows from ${parsed.kindLabel} (as of ${asOf}), replacing ${deleted}`,
    });
    for (const p of ["/surveillance", "/risk", "/"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message });
  }

  if (body.action === "load") {
    const text = typeof body.text === "string" ? body.text : "";
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(body.asOfDate)
      ? body.asOfDate
      : todayIstIso();
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
    recordAudit({ entity: "restriction", action: "create", summary: `Pasted ${rows.length} restricted securities (as of ${asOfDate}), replacing the whole list` });
    for (const p of ["/surveillance", "/risk", "/"]) revalidatePath(p);
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} restricted securities.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
