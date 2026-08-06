import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { corporateActions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseCorporateActionList, type CorporateActionType } from "@/lib/analytics/corporate-actions";
import { parseNseCorporateActions } from "@/lib/import/nse-corporate-actions";
import { applyCorporateAction } from "@/lib/corporate-actions-apply";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

function revalidate() {
  for (const p of ["/corporate-actions", "/risk", "/cash", "/equity", "/active", "/"]) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  if (body.action === "clear") {
    db.delete(corporateActions).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "All corporate action events cleared." });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    db.delete(corporateActions).where(eq(corporateActions.id, id)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: "Event deleted." });
  }

  if (body.action === "apply") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    const res = applyCorporateAction(id);
    if (res.ok) revalidate();
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  }

  if (body.action === "add") {
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    const type = String(body.type ?? "") as CorporateActionType;
    const exDate = String(body.exDate ?? "").trim();
    if (!symbol || !["split", "bonus", "dividend"].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(exDate)) {
      return NextResponse.json({ ok: false, message: "Symbol, type and a valid ex-date are required." }, { status: 400 });
    }
    const fromUnits = type !== "dividend" ? Number(body.fromUnits) : null;
    const toUnits = type !== "dividend" ? Number(body.toUnits) : null;
    const dividendPerShare = type === "dividend" ? Number(body.dividendPerShare) : null;
    if (type !== "dividend" && (!(fromUnits! > 0) || !(toUnits! > 0))) {
      return NextResponse.json({ ok: false, message: "Enter a valid ratio (e.g. 1:5)." }, { status: 400 });
    }
    if (type === "dividend" && !(dividendPerShare! > 0)) {
      return NextResponse.json({ ok: false, message: "Enter a valid ₹-per-share dividend amount." }, { status: 400 });
    }
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    const ins = db
      .insert(corporateActions)
      .values({ symbol, type, exDate, fromUnits, toUnits, dividendPerShare, note })
      .returning({ id: corporateActions.id })
      .get();
    recordAudit({ entity: "corporate_action", entityId: ins?.id ?? null, action: "create", summary: `${symbol} ${type} recorded (ex ${exDate})` });
    revalidate();
    return NextResponse.json({ ok: true, message: `${symbol} ${type} recorded.` });
  }

  if (body.action === "file") {
    // NSE CF-CA CSV upload. Unlike bulk paste, a downloaded file WILL be
    // uploaded twice (next month's download overlaps this month's), so events
    // already recorded — same symbol + type + ex-date — are skipped, never
    // duplicated. Application stays a separate, per-event decision.
    const parsed = parseNseCorporateActions(typeof body.text === "string" ? body.text : "");
    if (parsed.count === 0) {
      return NextResponse.json(
        { ok: false, message: parsed.warnings[0] ?? "No splits, bonuses or dividends found in the file." },
        { status: 400 },
      );
    }
    const existing = new Set(
      db.select({ s: corporateActions.symbol, t: corporateActions.type, d: corporateActions.exDate })
        .from(corporateActions).all()
        .map((r) => `${r.s}|${r.t}|${r.d}`),
    );
    let added = 0;
    db.transaction((tx) => {
      for (const r of parsed.rows) {
        if (existing.has(`${r.symbol}|${r.type}|${r.exDate}`)) continue;
        tx.insert(corporateActions)
          .values({
            symbol: r.symbol,
            type: r.type,
            exDate: r.exDate,
            fromUnits: r.fromUnits,
            toUnits: r.toUnits,
            dividendPerShare: r.dividendPerShare,
            note: r.note,
          })
          .run();
        added += 1;
      }
    });
    revalidate();
    const skippedKinds = Object.entries(parsed.skipped)
      .map(([k, n]) => `${k.toLowerCase()} ×${n}`)
      .join(", ");
    return NextResponse.json({
      ok: true,
      message: `${added} new event${added === 1 ? "" : "s"} added, ${parsed.count - added} already recorded.${
        skippedKinds ? ` Not translated (by design): ${skippedKinds}.` : ""
      } Review each row's note before applying.`,
    });
  }

  if (body.action === "load") {
    const rows = parseCorporateActionList(typeof body.text === "string" ? body.text : "");
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, message: "No valid rows. Use: SYMBOL, TYPE, EX-DATE, RATIO_OR_AMOUNT" }, { status: 400 });
    }
    db.transaction((tx) => {
      for (const r of rows) {
        tx.insert(corporateActions)
          .values({
            symbol: r.symbol,
            type: r.type,
            exDate: r.exDate,
            fromUnits: r.fromUnits,
            toUnits: r.toUnits,
            dividendPerShare: r.dividendPerShare,
            note: r.note,
          })
          .run();
      }
    });
    revalidate();
    return NextResponse.json({ ok: true, message: `Loaded ${rows.length} event${rows.length === 1 ? "" : "s"}.` });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
