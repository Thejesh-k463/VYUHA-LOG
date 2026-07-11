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

export const runtime = "nodejs";

const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

/** IND-5 — reconcile pasted AIS/26AS rows against the journal (stateless). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text.trim()) return NextResponse.json({ ok: false, message: "Paste at least one AIS row." }, { status: 400 });

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

  const recon = reconcileAis(
    parseAisText(text, fyStartMonth),
    [...divMap.values()],
    [...totals.values()].sort((a, b) => a.fy.localeCompare(b.fy)),
    resolve,
  );
  return NextResponse.json({ ok: true, recon });
}
