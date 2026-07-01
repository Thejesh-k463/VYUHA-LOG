// Pure tax-summary scaffold. INFORMATIONAL ONLY — not filing advice.
// Figures use net (post-charge) realised P&L; charges are generally deductible.

export interface TaxTrade {
  segment: string;
  instrumentType: string;
  sellDate: string | null;
  buyDate: string | null;
  grossPnl: number;
  netPnl: number;
  buyValue: number;
  sellValue: number;
  chargesTotal: number;
  isOpen: boolean;
}

export interface FySummary {
  fy: string; // e.g. "2026-27"
  stcg: number; // equity delivery/MTF held < 12m
  ltcg: number; // equity delivery/MTF held >= 12m
  intradaySpeculative: number; // eq_intraday
  fnoBusiness: number; // options + futures
  fnoTurnover: number; // for audit applicability
  charges: number;
  totalRealised: number;
  trades: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const FNO = new Set(["index_option", "stock_option", "commodity_option", "commodity_future", "future"]);
const OPTIONS = new Set(["index_option", "stock_option", "commodity_option"]);
const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function isLongTerm(buyDate: string | null, sellDate: string | null): boolean {
  if (!buyDate || !sellDate) return false;
  const days = (new Date(sellDate).getTime() - new Date(buyDate).getTime()) / 86400000;
  return days >= 365;
}

export function taxByFy(trades: TaxTrade[], fyStartMonth = 4, goLiveFy = "2026-27"): FySummary[] {
  const map = new Map<string, FySummary>();
  for (const t of trades) {
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate, fyStartMonth, goLiveFy);
    const s = map.get(fy) ?? {
      fy, stcg: 0, ltcg: 0, intradaySpeculative: 0, fnoBusiness: 0,
      fnoTurnover: 0, charges: 0, totalRealised: 0, trades: 0,
    };
    if (DELIVERY.has(t.segment)) {
      if (isLongTerm(t.buyDate, t.sellDate)) s.ltcg += t.netPnl;
      else s.stcg += t.netPnl;
    } else if (t.segment === "eq_intraday") {
      s.intradaySpeculative += t.netPnl;
    } else if (FNO.has(t.segment)) {
      s.fnoBusiness += t.netPnl;
      s.fnoTurnover += Math.abs(t.grossPnl) + (OPTIONS.has(t.segment) ? t.sellValue : 0);
    }
    s.charges += t.chargesTotal;
    s.totalRealised += t.netPnl;
    s.trades++;
    map.set(fy, s);
  }
  return [...map.values()]
    .map((s) => ({
      ...s,
      stcg: r2(s.stcg), ltcg: r2(s.ltcg), intradaySpeculative: r2(s.intradaySpeculative),
      fnoBusiness: r2(s.fnoBusiness), fnoTurnover: r2(s.fnoTurnover), charges: r2(s.charges),
      totalRealised: r2(s.totalRealised),
    }))
    .sort((a, b) => a.fy.localeCompare(b.fy));
}
