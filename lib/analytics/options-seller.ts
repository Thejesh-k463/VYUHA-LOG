import { inr } from "@/lib/format";

/** `segment` and `tradingsymbol` are optional so the existing fixtures keep
 *  compiling; when present they make the drill-down rows deep-link precisely
 *  (`/trades?symbol=&segment=`), when absent the row still links by symbol. */
export interface SellerTrade { id: number; symbol: string; tradingsymbol?: string; segment?: string; sellQty: number; buyQty: number; avgSellPrice: number; avgBuyPrice: number; netPnl: number; riskAmount: number | null; entryIv: number | null; exitIv: number | null; entryDte: number | null; hedgeStatus: string | null; expiryOutcome: string | null; adjustmentGroup: string | null; isOpen: boolean; }
export interface SellerRow { id: number; symbol: string; premiumSold: number; premiumCaptured: number; capturePct: number | null; ivChange: number | null; returnOnRiskPct: number | null; }
/** The seller filter, shared by the report and the drill-downs so both count
 *  exactly the same set of contracts. */
function sellerTrades(trades: SellerTrade[]): SellerTrade[] {
  return trades.filter((t) => t.sellQty > 0 && (t.sellQty >= t.buyQty || t.avgSellPrice > 0));
}

export function optionsSellerReport(trades: SellerTrade[]) {
  const sellers = sellerTrades(trades);
  const rows: SellerRow[] = sellers.map((t) => { const qty = t.sellQty; const sold = t.avgSellPrice * qty; const bought = t.avgBuyPrice * Math.min(t.buyQty, qty); const captured = sold - bought; return { id: t.id, symbol: t.symbol, premiumSold: Math.round(sold*100)/100, premiumCaptured: Math.round(captured*100)/100, capturePct: sold > 0 ? Math.round(captured/sold*10000)/100 : null, ivChange: t.entryIv != null && t.exitIv != null ? Math.round((t.exitIv-t.entryIv)*100)/100 : null, returnOnRiskPct: t.riskAmount && t.riskAmount > 0 ? Math.round(t.netPnl/t.riskAmount*10000)/100 : null }; });
  const closed = sellers.filter((t) => !t.isOpen); const premiumSold = rows.reduce((s,r) => s+r.premiumSold,0); const captured = rows.reduce((s,r) => s+r.premiumCaptured,0);
  const outcomes = Object.fromEntries([...new Set(sellers.map((t) => t.expiryOutcome ?? "unclassified"))].map((k) => [k, sellers.filter((t) => (t.expiryOutcome ?? "unclassified") === k).length]));
  return { rows, count: sellers.length, closed: closed.length, netPnl: sellers.reduce((s,t)=>s+t.netPnl,0), capturePct: premiumSold > 0 ? Math.round(captured/premiumSold*10000)/100 : null, hedgedPct: sellers.length ? Math.round(sellers.filter((t)=>t.hedgeStatus === "hedged").length/sellers.length*10000)/100 : null, completeIv: sellers.filter((t)=>t.entryIv != null && t.exitIv != null).length, outcomes };
}
export type OptionsSellerReport = ReturnType<typeof optionsSellerReport>;

// ---------------------------------------------------------------------------
// KPI drill-downs. These mirror `KpiDetail` in components/kpi-card.tsx as a
// LOCAL type so this module stays React-free (invariant 2). Every field is a
// plain string, which is what lets a server component build the object and
// hand it to the client card unchanged. Rows never invent a number: anything
// the report could not derive is shown as "—" with the reason in the hint.
// ---------------------------------------------------------------------------

export interface SellerDetailRow { label: string; value: string; tone?: "profit" | "loss" | "neutral"; hint?: string; href?: string; }
export interface SellerDetail { title: string; summary?: string; rows: SellerDetailRow[]; note?: string; footerHref?: string; footerLabel?: string; }
export interface SellerKpiDetails { trades: SellerDetail; netPnl: SellerDetail; capture: SellerDetail; hedged: SellerDetail; outcomes: SellerDetail; }

/** Fixed display order + literal colours for the outcome mix. Literal hex on
 *  purpose: the bar is recharts SVG so it prints, and chart tokens must never
 *  be `var()`/`color-mix()` (tests/skin.test.ts). */
export const OUTCOME_ORDER = ["expired_worthless", "squared_off", "assigned", "rolled", "unclassified"] as const;
export const OUTCOME_COLORS: Record<string, string> = {
  expired_worthless: "#2dd4bf",
  squared_off: "#a78bfa",
  assigned: "#f0b429",
  rolled: "#7196ff",
  unclassified: "#64748b",
};
export function outcomeLabel(k: string): string { return k.replaceAll("_", " "); }
export interface OutcomeSlice { key: string; label: string; count: number; color: string; }
/** Outcomes in a stable order — known keys first, then anything unexpected alphabetically. */
export function orderedOutcomes(outcomes: Record<string, number>): OutcomeSlice[] {
  const keys = Object.keys(outcomes);
  const known = OUTCOME_ORDER.filter((k) => keys.includes(k));
  const rest = keys.filter((k) => !(OUTCOME_ORDER as readonly string[]).includes(k)).sort();
  return [...known, ...rest].map((key) => ({ key, label: outcomeLabel(key), count: outcomes[key] ?? 0, color: OUTCOME_COLORS[key] ?? OUTCOME_COLORS.unclassified }));
}

const money = (n: number) => inr(n, { decimals: 0 });
const tone = (n: number): "profit" | "loss" | "neutral" => (n > 0 ? "profit" : n < 0 ? "loss" : "neutral");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const contractName = (t: SellerTrade) => t.tradingsymbol ?? t.symbol;
const tradesHref = (symbol: string, segment?: string) => `/trades?symbol=${encodeURIComponent(symbol)}${segment ? `&segment=${encodeURIComponent(segment)}` : ""}`;
const contractHref = (t: SellerTrade) => tradesHref(contractName(t), t.segment);

export function sellerKpiDetails(trades: SellerTrade[], report: OptionsSellerReport): SellerKpiDetails {
  const sellers = sellerTrades(trades);
  const noneNote = "No seller trades yet — sell-side option contracts appear here once imported or entered.";

  // --- Seller trades: per underlying, top 8 by count -----------------------
  // push, not re-spread: `[...(get ?? []), t]` recopied the bucket per trade —
  // O(n²) per symbol, and index-heavy books concentrate in 1-2 underlyings.
  const byUnderlying = new Map<string, SellerTrade[]>();
  for (const t of sellers) {
    const bucket = byUnderlying.get(t.symbol);
    if (bucket) bucket.push(t);
    else byUnderlying.set(t.symbol, [t]);
  }
  const underlyings = [...byUnderlying.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const modeSegment = (ts: SellerTrade[]): string | undefined => {
    const c = new Map<string, number>();
    for (const t of ts) if (t.segment) c.set(t.segment, (c.get(t.segment) ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const tradesDetail: SellerDetail = {
    title: "Seller trades",
    summary: sellers.length
      ? `${plural(sellers.length, "sell-side contract")} across ${plural(underlyings.length, "underlying")} · ${report.closed} closed, ${sellers.length - report.closed} open.`
      : noneNote,
    rows: underlyings.slice(0, 8).map(([sym, ts]) => {
      const open = ts.filter((t) => t.isOpen).length;
      return { label: sym, value: `${ts.length}`, hint: open ? `${open} still open` : undefined, href: tradesHref(sym, modeSegment(ts)) };
    }),
    note: underlyings.length > 8
      ? `Top 8 of ${underlyings.length} underlyings by contract count.`
      : "A trade counts as a seller trade when it has a sell leg and either sold at least as much as it bought or carries a sell price.",
    footerHref: "/trades",
    footerLabel: "Show me the trades",
  };

  // --- Net P&L: realised vs open, best and worst contract -----------------
  const closed = sellers.filter((t) => !t.isOpen);
  const open = sellers.filter((t) => t.isOpen);
  const realised = closed.reduce((s, t) => s + t.netPnl, 0);
  const unrealised = open.reduce((s, t) => s + t.netPnl, 0);
  const byPnl = [...sellers].sort((a, b) => b.netPnl - a.netPnl);
  const best = byPnl[0];
  const worst = byPnl.length > 1 ? byPnl[byPnl.length - 1] : undefined;
  const netRows: SellerDetailRow[] = [
    { label: "Realised", value: closed.length ? money(realised) : "—", tone: closed.length ? tone(realised) : undefined, hint: plural(closed.length, "closed contract") },
    { label: "Open (marked)", value: open.length ? money(unrealised) : "—", tone: open.length ? tone(unrealised) : undefined, hint: open.length ? `${open.length} still open — moves until closed` : "nothing open" },
  ];
  if (best) netRows.push({ label: `Best: ${contractName(best)}`, value: money(best.netPnl), tone: tone(best.netPnl), hint: best.isOpen ? "open — marked, not booked" : undefined, href: contractHref(best) });
  if (worst) netRows.push({ label: `Worst: ${contractName(worst)}`, value: money(worst.netPnl), tone: tone(worst.netPnl), hint: worst.isOpen ? "open — marked, not booked" : undefined, href: contractHref(worst) });
  const netDetail: SellerDetail = {
    title: "Net P&L",
    summary: sellers.length ? `${money(report.netPnl)} across ${plural(sellers.length, "seller contract")}, after charges.` : noneNote,
    rows: netRows,
    note: "Realised is what closed contracts booked; open contracts contribute their current mark and will move.",
    footerHref: "/trades?realised=1",
    footerLabel: "Show realised trades",
  };

  // --- Premium captured ---------------------------------------------------
  const premiumSold = report.rows.reduce((s, r) => s + r.premiumSold, 0);
  const captured = report.rows.reduce((s, r) => s + r.premiumCaptured, 0);
  const capBest = report.rows.filter((r) => r.capturePct != null).sort((a, b) => (b.capturePct ?? 0) - (a.capturePct ?? 0))[0];
  const capRows: SellerDetailRow[] = [
    { label: "Premium collected", value: premiumSold > 0 ? money(premiumSold) : "—", hint: premiumSold > 0 ? "sell price × quantity sold" : "no premium sold yet" },
    { label: "Premium kept", value: premiumSold > 0 ? money(captured) : "—", tone: premiumSold > 0 ? tone(captured) : undefined, hint: premiumSold > 0 ? "collected minus what it cost to buy back" : undefined },
    { label: "Capture rate", value: report.capturePct == null ? "—" : `${report.capturePct}%`, hint: report.capturePct == null ? "needs premium sold to divide by" : undefined },
  ];
  if (capBest && capBest.capturePct != null) {
    const t = sellers.find((s) => s.id === capBest.id);
    capRows.push({ label: `Best capture: ${t ? contractName(t) : capBest.symbol}`, value: `${capBest.capturePct}%`, tone: "profit", href: t ? contractHref(t) : undefined });
  }
  const captureDetail: SellerDetail = {
    title: "Premium captured",
    summary: report.capturePct == null ? "Nothing to divide by yet — capture needs at least one contract with premium sold." : `${report.capturePct}% of the premium you sold stayed with you.`,
    rows: capRows,
    note: "Capture % = (premium collected − premium paid to close) ÷ premium collected, before charges; a contract that expired worthless captures 100%.",
    footerHref: "/trades",
    footerLabel: "Show me the trades",
  };

  // --- Fully hedged -------------------------------------------------------
  const hedgedN = sellers.filter((t) => t.hedgeStatus === "hedged").length;
  const unhedgedN = sellers.filter((t) => t.hedgeStatus === "unhedged").length;
  const partialN = sellers.filter((t) => t.hedgeStatus != null && t.hedgeStatus !== "hedged" && t.hedgeStatus !== "unhedged").length;
  const unknownN = sellers.filter((t) => t.hedgeStatus == null).length;
  const hedgedRows: SellerDetailRow[] = [
    { label: "Fully hedged", value: `${hedgedN}`, tone: hedgedN ? "profit" : undefined },
    { label: "Unhedged", value: `${unhedgedN}`, tone: unhedgedN ? "loss" : undefined },
  ];
  if (partialN) hedgedRows.push({ label: "Partially hedged", value: `${partialN}` });
  hedgedRows.push({ label: "Not recorded", value: `${unknownN}`, hint: unknownN ? "counted as not fully hedged — record the hedge state in the contract journal below" : undefined });
  const hedgedDetail: SellerDetail = {
    title: "Fully hedged",
    summary: report.hedgedPct == null ? noneNote : `${report.hedgedPct}% of seller contracts were marked fully hedged.`,
    rows: hedgedRows,
    note: "Hedge state is what you recorded, never inferred from the legs. The share is out of ALL seller contracts, so unrecorded ones pull it down rather than being dropped.",
  };

  // --- Outcome mix --------------------------------------------------------
  const ordered = orderedOutcomes(report.outcomes);
  const total = ordered.reduce((s, o) => s + o.count, 0);
  const dominant = ordered.slice().sort((a, b) => b.count - a.count)[0];
  const outcomesDetail: SellerDetail = {
    title: "Outcome mix",
    summary: total ? `${plural(total, "seller contract")}${dominant ? ` · most often ${dominant.label} (${dominant.count})` : ""}.` : noneNote,
    rows: ordered.map((o) => ({ label: o.label, value: `${o.count} · ${total ? Math.round((o.count / total) * 1000) / 10 : 0}%`, hint: o.key === "unclassified" && o.count ? "no expiry outcome recorded yet" : undefined })),
    note: "Outcomes are what you recorded per contract in the journal below; a contract with no outcome yet sits in unclassified rather than being guessed.",
    footerHref: "/trades",
    footerLabel: "Show me the trades",
  };

  return { trades: tradesDetail, netPnl: netDetail, capture: captureDetail, hedged: hedgedDetail, outcomes: outcomesDetail };
}
