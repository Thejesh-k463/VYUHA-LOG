import { NextResponse } from "next/server";
import { getTrades } from "@/lib/queries/trades";
// The counted-once rule has ONE home, beside the IPO reads it is about (wave 2L).
import { getIposComputed, ipoIdsCountedThroughTrades } from "@/lib/queries/ipos";
import { isPriceableExitDate } from "@/lib/analytics/ipo";
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
import { resolveTaxScope, taxScopeHeader } from "@/lib/queries/tax-scope";

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

  // v4.5.0 wave TP — AIS is issued PER PAN, so the journal side of this
  // reconciliation is the TAX PERSON's book: every account of the person the
  // selector names, archived included, and never two persons at once (owner
  // ruling T1). `?person=` carries the picker's choice from the tax pages. An
  // All-accounts selection spanning more than one person yields an EMPTY scope
  // — no rows, no totals — rather than a merged statement nobody can file
  // (invariant 6). Read-only: nothing here writes.
  const scope = resolveTaxScope(new URL(req.url).searchParams.get("person"));
  const fyStartMonth = getSettings()?.fyStartMonth ?? 4;
  const aliasMap = getAliasMap();
  const resolve = (name: string) => resolveTicker(name.toUpperCase(), aliasMap);
  const fyOf = (d: string | null) => (d ? fyOfDate(d, fyStartMonth) : null);

  // Journal dividends: the ledger rows written by Corporate Actions (gross +, TDS −).
  const divMap = new Map<string, JournalDividend>();
  for (const e of getLedgerEntries(scope.accountIds)) {
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
  /** True when the amount was counted into a year. */
  const bump = (fy: string | null, kind: "sale" | "purchase", amount: number): boolean => {
    if (!fy || amount <= 0) return false;
    const t = totals.get(fy) ?? { fy, saleConsideration: 0, purchaseValue: 0 };
    if (kind === "sale") t.saleConsideration += amount;
    else t.purchaseValue += amount;
    totals.set(fy, t);
    return true;
  };
  // TAX-IPO-LINK (v4.3.0 wave 2H): an IPO pushed to holdings links a trade, and the
  // /ipos sync writes the allotment and the exit onto it — so the linked holding's
  // purchase and sale ARE the IPO's. Bumping both read the journal's FY totals
  // double. CAP-IPO-LINK's rule, per side: the IPO's allotment is skipped when its
  // holding's purchase was counted above, its exit when the holding's sale was.
  const purchaseCounted = new Set<number>();
  const saleCounted = new Set<number>();
  for (const t of getTrades(scope.accountIds)) {
    if (!DELIVERY.has(t.segment)) continue;
    if (bump(fyOf(t.buyDate), "purchase", t.buyValue)) purchaseCounted.add(t.id);
    if (!t.isOpen && bump(fyOf(t.sellDate), "sale", t.sellValue)) saleCounted.add(t.id);
  }
  const allotmentThroughTrade = ipoIdsCountedThroughTrades(purchaseCounted, scope.accountIds);
  const exitThroughTrade = ipoIdsCountedThroughTrades(saleCounted, scope.accountIds);
  for (const ipo of getIposComputed(scope.accountIds).rows) {
    if (ipo.allotted && ipo.allottedQty > 0) {
      if (!allotmentThroughTrade.has(ipo.id)) {
        bump(fyOf(ipo.allotmentDate ?? ipo.listingDate ?? ipo.appliedDate ?? null), "purchase", ipo.investedAllotted);
      }
      // IPO-EXITDATE (v4.3.0): fyOfDate never throws on a string but invents a
      // year for an unreadable one ('0202-06-15' → "202-03", '2026-02-30' →
      // "2025-26"). A sale is counted only on a date computeIpo can read (N13);
      // otherwise it is skipped rather than filed under a year nobody stated.
      if (!exitThroughTrade.has(ipo.id) && ipo.exitPrice != null && ipo.exitDate && isPriceableExitDate(ipo.exitDate)) {
        bump(fyOf(ipo.exitDate), "sale", ipo.exitPrice * ipo.allottedQty);
      }
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
  return NextResponse.json({ ok: true, recon, scope: taxScopeHeader(scope) });
}
