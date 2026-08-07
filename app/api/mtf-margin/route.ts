import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { mtfMargins } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { BROKERS } from "@/lib/domain/constants";
import { resolveMtfMarginDb } from "@/lib/queries/mtf-margins";
import { mtfSourceLabel, MTF_BUNDLE_AS_OF } from "@/lib/risk/mtf-margins";

export const runtime = "nodejs";

/** GET ?broker=&symbol= — resolve one stock's MTF own-margin % with its source.
 *  The Trades form's auto-split calls this as the user types. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const broker = String(u.searchParams.get("broker") ?? "").toLowerCase();
  const symbol = String(u.searchParams.get("symbol") ?? "").toUpperCase().trim();
  if (!(BROKERS as readonly string[]).includes(broker) || !symbol) {
    return NextResponse.json({ ok: false, message: "broker and symbol required" }, { status: 400 });
  }
  const r = resolveMtfMarginDb(broker, symbol);
  return NextResponse.json({ ok: true, ...r, label: mtfSourceLabel(r), bundleAsOf: MTF_BUNDLE_AS_OF });
}

/**
 * POST — upload a broker's MTF list to refresh/extend the per-stock margins.
 * Accepts the three shapes the brokers actually publish:
 *   - Zerodha JSON:  [{tradingsymbol, margin, isin}]
 *   - Paytm JSON:    {data:[{symbol, margin_perc, isin}]}
 *   - generic CSV:   SYMBOL,MARGIN_PCT[,ISIN] (header optional)
 * Rows land in mtf_margins (unique broker+symbol, upsert) and take precedence
 * over the bundled snapshot. marginPct is the trader's OWN contribution %.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { broker?: string; text?: string; asOf?: string } | null;
  const broker = String(body?.broker ?? "").toLowerCase();
  const text = String(body?.text ?? "");
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(body?.asOf ?? "")) ? String(body?.asOf) : new Date().toISOString().slice(0, 10);
  if (!(BROKERS as readonly string[]).includes(broker) || !text.trim()) {
    return NextResponse.json({ ok: false, message: "Pick a broker and a file." }, { status: 400 });
  }

  const rows: { symbol: string; pct: number; isin: string | null }[] = [];
  const push = (symbol: unknown, pct: unknown, isin?: unknown) => {
    const s = String(symbol ?? "").toUpperCase().trim();
    const p = Number(pct);
    if (s && /^[A-Z0-9&.-]{1,20}$/.test(s) && Number.isFinite(p) && p > 0 && p <= 100) {
      rows.push({ symbol: s, pct: Math.round(p * 10) / 10, isin: typeof isin === "string" && isin ? isin.toUpperCase() : null });
    }
  };

  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return NextResponse.json({ ok: false, message: "File looks like JSON but doesn't parse." }, { status: 400 });
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { data?: unknown[] }).data;
    if (!Array.isArray(arr)) {
      return NextResponse.json({ ok: false, message: "JSON didn't contain a list of scrips." }, { status: 400 });
    }
    for (const r of arr as Record<string, unknown>[]) {
      push(r.tradingsymbol ?? r.symbol ?? r.nseScriptCode, r.margin ?? r.margin_perc ?? r.marginPct ?? r.mtfHaircut, r.isin);
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      const parts = line.split(/[,\t]/).map((x) => x.trim());
      if (parts.length < 2 || /symbol|margin/i.test(parts[0])) continue; // header
      push(parts[0], parts[1], parts[2]);
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ ok: false, message: "No usable rows — expected symbol + margin % per row." }, { status: 400 });
  }

  db.transaction((tx) => {
    for (const r of rows) {
      tx.insert(mtfMargins)
        .values({ broker, symbol: r.symbol, marginPct: r.pct, isin: r.isin, asOf, source: "upload" })
        .onConflictDoUpdate({
          target: [mtfMargins.broker, mtfMargins.symbol],
          set: { marginPct: r.pct, isin: r.isin, asOf, source: "upload", createdAt: sql`(datetime('now'))` },
        })
        .run();
    }
  });
  for (const p of ["/risk", "/trades"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: `${rows.length} per-stock margins saved for ${broker} (as of ${asOf}).` });
}
