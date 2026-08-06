import { NextResponse } from "next/server";
import { getTrades } from "@/lib/queries/trades";
import { getIposComputed } from "@/lib/queries/ipos";
import { getLedgerEntries } from "@/lib/queries/ledger";
import { getSettings } from "@/lib/queries/settings";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import {
  parseAisText,
  reconcileAis,
  fyOfDate,
  type JournalDividend,
  type JournalFyTotal,
} from "@/lib/analytics/ais";
import { extractAisJson } from "@/lib/import/ais-json";

export const runtime = "nodejs";

const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

/** IND-5 — reconcile AIS rows (pasted text OR the portal's JSON download)
 *  against the journal. Stateless either way. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text : "";
  const jsonText = typeof body?.jsonText === "string" ? body.jsonText : "";
  if (!text.trim() && !jsonText.trim()) {
    return NextResponse.json({ ok: false, message: "Paste AIS rows or upload the AIS JSON." }, { status: 400 });
  }

  const fyStartMonth = getSettings()?.fyStartMonth ?? 4;
  const aliasMap = getAliasMap();
  const resolve = (name: string) => resolveTicker(name.toUpperCase(), aliasMap);
  const fyOf = (d: string | null) => (d ? fyOfDate(d, fyStartMonth) : null);

  // Journal dividends: the ledger rows written by Corporate Actions (gross +, TDS −).
  const divMap = new Map<string, JournalDividend>();
  for (const e of getLedgerEntries()) {
    if (e.type !== "dividend" && e.type !== "dividend_tds") continue;
    const fy = fyOf(e.date);
    const symbol = (e.symbol ?? "").toUpperCase();
    if (!fy || !symbol) continue;
    const key = `${resolve(symbol)} ${fy}`;
    const cur = divMap.get(key) ?? { symbol, fy, gross: 0, tds: 0 };
    if (e.type === "dividend") cur.gross += e.amountPaise / 100;
    else cur.tds += Math.abs(e.amountPaise) / 100;
    divMap.set(key, cur);
  }

  // Per-FY equity sale consideration / purchase value (AIS SFT-17/18 shape):
  // delivery+MTF trades by leg date, plus IPO allotments (purchase) and exits (sale).
  const totals = new Map<string, JournalFyTotal>();
  const bump = (fy: string | null, kind: "sale" | "purchase", amount: number) => {
    if (!fy || amount <= 0) return;
    const t = totals.get(fy) ?? { fy, saleConsideration: 0, purchaseValue: 0 };
    if (kind === "sale") t.saleConsideration += amount;
    else t.purchaseValue += amount;
    totals.set(fy, t);
  };
  for (const t of getTrades()) {
    if (!DELIVERY.has(t.segment)) continue;
    bump(fyOf(t.buyDate), "purchase", t.buyValue);
    if (!t.isOpen) bump(fyOf(t.sellDate), "sale", t.sellValue);
  }
  for (const ipo of getIposComputed().rows) {
    if (ipo.allotted && ipo.allottedQty > 0) {
      bump(fyOf(ipo.allotmentDate ?? ipo.listingDate ?? ipo.appliedDate ?? null), "purchase", ipo.investedAllotted);
      if (ipo.exitPrice != null && ipo.exitDate) bump(fyOf(ipo.exitDate), "sale", ipo.exitPrice * ipo.allottedQty);
    }
  }

  // JSON upload takes priority when both are present; the extractor emits the
  // exact row shape parseAisText produces, so everything downstream is shared.
  const parsed = jsonText.trim()
    ? (() => {
        const x = extractAisJson(jsonText);
        return { rows: x.rows, unparsed: x.unparsed };
      })()
    : parseAisText(text, fyStartMonth);

  const recon = reconcileAis(
    parsed,
    [...divMap.values()],
    [...totals.values()].sort((a, b) => a.fy.localeCompare(b.fy)),
    resolve,
  );
  return NextResponse.json({ ok: true, recon });
}
