// Pure tax-summary scaffold. INFORMATIONAL ONLY — not filing advice.
// Figures use net (post-charge) realised P&L; charges are generally deductible.
//
// Turnover comes from lib/analytics/turnover.ts — the single method shared with
// /reports/itr. Do not re-derive it here; two screens showing two turnovers for
// the same year is the defect that module was created to end.

import {
  DELIVERY_SEGMENTS,
  FNO_SEGMENTS,
  turnoverContribution,
} from "./turnover";
import { bucketFor, resolveCgHead, type CgAssetClass } from "./cg-heads";

export interface TaxTrade {
  segment: string;
  /** REQUIRED from v4.5.0 — see `CapitalGainsTrade.assetClass`. Build it with
   *  `assetClassFor()`, never a literal: a gold ETF is not an equity share. */
  assetClass: CgAssetClass;
  instrumentType: string;
  sellDate: string | null;
  buyDate: string | null;
  grossPnl: number;
  netPnl: number;
  buyValue: number;
  sellValue: number;
  chargesTotal: number;
  /** Added back in the capital-gains buckets only — proviso to S.48. */
  sttCtt?: number;
  /** Added back in the capital-gains buckets only — financing cost, not
   *  transfer expenditure (dossier §G2). */
  mtfInterest?: number;
  pledgeCharges?: number;
  isOpen: boolean;
}

export interface FySummary {
  fy: string; // e.g. "2026-27"
  // v4.5.0 — one "STCG" column merged three different heads taxed three
  // different ways. See `FyGrossGains` in lib/analytics/capital-gains.ts.
  stcg111A: number;
  stcgOther: number;
  ltcg112A: number;
  ltcg112: number;
  cgUndetermined: number;
  intradaySpeculative: number; // eq_intraday
  fnoBusiness: number; // options + futures
  fnoTurnover: number; // for audit applicability
  charges: number;
  totalRealised: number;
  trades: number;
  /** ₹ of MTF interest + pledge charges NOT deducted from the CG buckets. */
  notDeductedMtf: number;
  /** ₹ of STT added back into the CG buckets (never the business heads). */
  sttAddedBack: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
// Segment sets and the turnover method live in one place — three modules had
// their own copies and two of them disagreed. See lib/analytics/turnover.ts.
const FNO = FNO_SEGMENTS;
const DELIVERY = DELIVERY_SEGMENTS;

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// The 365-day `isLongTerm` copy that stood here is DELETED, not adjusted. The
// holding-period rule lives once, in `lib/analytics/cg-heads.ts`, and it is a
// CALENDAR-MONTH rule (General Clauses Act 1897 s.3(35)). Four copies of a
// day count meant four modules could disagree about one trade's term, and all
// four were wrong by up to two days at every boundary.

// FY containing `today`. The fallback bucket for closed trades with no sell
// date — it must be DERIVED, not a literal: a frozen "2026-27" default filed
// undated trades under a stale year forever once that FY passed.
export function currentFy(fyStartMonth: number, today: Date = new Date()): string {
  const y = today.getFullYear();
  const start = today.getMonth() + 1 >= fyStartMonth ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function taxByFy(
  trades: TaxTrade[],
  fyStartMonth = 4,
  fallbackFy: string = currentFy(fyStartMonth),
): FySummary[] {
  const map = new Map<string, FySummary>();
  for (const t of trades) {
    // A guard over ALREADY-SHAPED rows, not the definition of "realised":
    // WHICH rows reach here is decided in lib/analytics/realised-rows.ts (a
    // staged ladder arrives as one row per fill, each already `isOpen: false`).
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate, fyStartMonth, fallbackFy);
    const s = map.get(fy) ?? {
      fy, stcg111A: 0, stcgOther: 0, ltcg112A: 0, ltcg112: 0, cgUndetermined: 0,
      intradaySpeculative: 0, fnoBusiness: 0,
      fnoTurnover: 0, charges: 0, totalRealised: 0, trades: 0,
      notDeductedMtf: 0, sttAddedBack: 0,
    };
    if (DELIVERY.has(t.segment)) {
      const head = resolveCgHead({ assetClass: t.assetClass, acquiredOn: t.buyDate, transferredOn: t.sellDate });
      // STT and the financing charges are added back HERE and nowhere else in
      // this function: the two business heads below keep them as allowable
      // expenses, which is the whole asymmetry (proviso to S.48 vs S.36(1)(xv)).
      const addBackStt = Math.max(0, t.sttCtt ?? 0);
      const addBackMtf = Math.max(0, t.mtfInterest ?? 0) + Math.max(0, t.pledgeCharges ?? 0);
      s[bucketFor(head.head)] += t.netPnl + addBackStt + addBackMtf;
      s.sttAddedBack += addBackStt;
      s.notDeductedMtf += addBackMtf;
    } else if (t.segment === "eq_intraday") {
      s.intradaySpeculative += t.netPnl;
    } else if (FNO.has(t.segment)) {
      s.fnoBusiness += t.netPnl;
      s.fnoTurnover += turnoverContribution(t);
    }
    s.charges += t.chargesTotal;
    s.totalRealised += t.netPnl;
    s.trades++;
    map.set(fy, s);
  }
  return [...map.values()]
    .map((s) => ({
      ...s,
      stcg111A: r2(s.stcg111A), stcgOther: r2(s.stcgOther),
      ltcg112A: r2(s.ltcg112A), ltcg112: r2(s.ltcg112), cgUndetermined: r2(s.cgUndetermined),
      intradaySpeculative: r2(s.intradaySpeculative),
      fnoBusiness: r2(s.fnoBusiness), fnoTurnover: r2(s.fnoTurnover), charges: r2(s.charges),
      totalRealised: r2(s.totalRealised),
      notDeductedMtf: r2(s.notDeductedMtf), sttAddedBack: r2(s.sttAddedBack),
    }))
    .sort((a, b) => a.fy.localeCompare(b.fy));
}
