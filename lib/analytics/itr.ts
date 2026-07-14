// ITR-3 preparation pack (PURE, no DB/React). INFORMATIONAL ONLY — every number
// here is a preparation aid for you and your CA, not filing advice. Thresholds
// change with Finance Acts; the caution notes are part of the output on purpose.
//
// Head-wise segregation follows how Indian ITRs treat a retail trader's book:
//   - eq_intraday        → SPECULATIVE business income (S.43(5))
//   - options/futures    → NON-SPECULATIVE business income (S.43(5) proviso (d)/(e))
//   - eq_delivery/eq_mtf → CAPITAL GAINS (STCG < 12m, LTCG ≥ 12m)
//
// Turnover uses the ICAI Guidance Note (8th edition, 2022): the ABSOLUTE sum of
// per-trade profits and losses. Option sale premium is NOT added separately when
// it already flows through the P&L (it does here) — note that the older 2012
// method (premium added) shows a much larger turnover; ask your CA which your
// filing history uses.

export interface ItrTrade {
  segment: string;
  buyDate: string | null;
  sellDate: string | null;
  grossPnl: number;
  netPnl: number;
  chargesTotal: number;
  isOpen: boolean;
}

export interface HeadSummary {
  trades: number;
  net: number; // post-charge realised P&L for the head
  gross: number;
  turnover: number; // Guidance-Note absolute-sum turnover (business heads only)
  charges: number; // deductible expenses for business heads; cost-adjusting for CG
}

export interface CapitalGainsSummary {
  trades: number;
  stcg: number;
  ltcg: number;
  charges: number;
}

export type AuditLevel = "audit-required" | "audit-unlikely" | "no-business-income";

export interface AuditVerdict {
  combinedBusinessTurnover: number; // speculative + non-speculative
  level: AuditLevel;
  headline: string;
  notes: string[]; // the cautions ARE the product — always read to the user
}

export interface ItrFyPack {
  fy: string; // e.g. "2026-27"
  speculative: HeadSummary; // intraday equity
  nonSpeculative: HeadSummary; // F&O
  capitalGains: CapitalGainsSummary;
  audit: AuditVerdict;
}

// S.44AB: 1 Cr base; 10 Cr when cash receipts AND payments ≤ 5% (retail broker
// trading is fully digital, so 10 Cr is the operative line). S.44AD presumptive:
// 2 Cr base / 3 Cr when ≥95% receipts are digital.
export const AUDIT_LIMIT_DIGITAL = 10_00_00_000;
export const PRESUMPTIVE_44AD_LIMIT_DIGITAL = 3_00_00_000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const FNO = new Set(["index_option", "stock_option", "commodity_option", "commodity_future", "future"]);
const DELIVERY = new Set(["eq_delivery", "eq_mtf"]);

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const start = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const isLongTerm = (buy: string | null, sell: string | null) =>
  !!buy && !!sell && (new Date(sell).getTime() - new Date(buy).getTime()) / 86400000 >= 365;

function emptyHead(): HeadSummary {
  return { trades: 0, net: 0, gross: 0, turnover: 0, charges: 0 };
}

export function auditVerdict(combinedBusinessTurnover: number, hasBusinessLoss: boolean): AuditVerdict {
  const t = r2(combinedBusinessTurnover);
  const notes: string[] = [];
  let level: AuditLevel;
  let headline: string;

  if (t === 0) {
    level = "no-business-income";
    headline = "No business-head turnover this FY — 44AB does not arise from trading alone.";
  } else if (t > AUDIT_LIMIT_DIGITAL) {
    level = "audit-required";
    headline = `Business turnover ₹${t.toLocaleString("en-IN")} exceeds the ₹10 Cr digital-transactions limit — a tax audit under S.44AB is required.`;
  } else {
    level = "audit-unlikely";
    headline = `Business turnover ₹${t.toLocaleString("en-IN")} is within the ₹10 Cr digital limit — an audit is generally NOT required on turnover alone.`;
    if (t <= PRESUMPTIVE_44AD_LIMIT_DIGITAL) {
      notes.push(
        "Turnover is within the ₹3 Cr (digital) presumptive limit of S.44AD — declaring ≥6% deemed profit is an option, but it binds you for 5 years and rarely suits loss years. Discuss with your CA.",
      );
    }
    if (hasBusinessLoss) {
      notes.push(
        "You have a business-head LOSS. Carrying it forward needs an ITR filed by the due date; and if you previously used 44AD and now declare lower-than-presumptive profit with income above the exemption limit, an audit can still apply. This can't be determined from trade data alone — check your filing history with your CA.",
      );
    }
  }
  notes.push(
    "Thresholds are per the FY's Finance Act and your OVERALL income situation (other businesses, past presumptive elections, cash components). This is a preparation aid, not filing advice — have a CA confirm before filing.",
  );
  return { combinedBusinessTurnover: t, level, headline, notes };
}

/** Head-wise ITR-3 preparation pack per financial year, oldest FY first. */
export function itrPackByFy(trades: ItrTrade[], fyStartMonth = 4, fallbackFy = "2026-27"): ItrFyPack[] {
  const map = new Map<string, { spec: HeadSummary; fno: HeadSummary; cg: CapitalGainsSummary }>();
  for (const t of trades) {
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate ?? t.buyDate, fyStartMonth, fallbackFy);
    const b = map.get(fy) ?? { spec: emptyHead(), fno: emptyHead(), cg: { trades: 0, stcg: 0, ltcg: 0, charges: 0 } };
    if (t.segment === "eq_intraday") {
      b.spec.trades++;
      b.spec.net = r2(b.spec.net + t.netPnl);
      b.spec.gross = r2(b.spec.gross + t.grossPnl);
      b.spec.turnover = r2(b.spec.turnover + Math.abs(t.grossPnl));
      b.spec.charges = r2(b.spec.charges + t.chargesTotal);
    } else if (FNO.has(t.segment)) {
      b.fno.trades++;
      b.fno.net = r2(b.fno.net + t.netPnl);
      b.fno.gross = r2(b.fno.gross + t.grossPnl);
      b.fno.turnover = r2(b.fno.turnover + Math.abs(t.grossPnl));
      b.fno.charges = r2(b.fno.charges + t.chargesTotal);
    } else if (DELIVERY.has(t.segment)) {
      b.cg.trades++;
      if (isLongTerm(t.buyDate, t.sellDate)) b.cg.ltcg = r2(b.cg.ltcg + t.netPnl);
      else b.cg.stcg = r2(b.cg.stcg + t.netPnl);
      b.cg.charges = r2(b.cg.charges + t.chargesTotal);
    }
    map.set(fy, b);
  }

  return [...map.entries()]
    .map(([fy, b]) => ({
      fy,
      speculative: b.spec,
      nonSpeculative: b.fno,
      capitalGains: b.cg,
      audit: auditVerdict(b.spec.turnover + b.fno.turnover, b.spec.net < 0 || b.fno.net < 0),
    }))
    .sort((a, b) => a.fy.localeCompare(b.fy));
}
