// ITR-3 preparation pack (PURE, no DB/React). INFORMATIONAL ONLY — every number
// here is a preparation aid for you and your CA, not filing advice. Thresholds
// change with Finance Acts; the caution notes are part of the output on purpose.
//
// Head-wise segregation follows how Indian ITRs treat a retail trader's book:
//   - eq_intraday        → SPECULATIVE business income   (S.43(5) → s.66(31))
//   - options/futures    → NON-SPECULATIVE business income (S.43(5) proviso (d)/(e) → s.66(33))
//   - eq_delivery/eq_mtf → CAPITAL GAINS (STCG < 12m, LTCG ≥ 12m)
//
// Section numbers shown to the user are resolved by tax year in
// lib/analytics/statute.ts — the 1961 Act was repealed with effect from
// 1 April 2026, but a report for an earlier year must keep its own citations.
//
// Turnover comes from lib/analytics/turnover.ts, which implements the CURRENT
// ICAI Guidance Note (11th edition, 2026) para 5.11(b): differences PLUS premium
// received on the sale of options.
//
// This file previously used the 8th-edition (2022) method — absolute P&L only,
// no premium — and described the premium method as "the older 2012 method". That
// was wrong: premium was removed in the 8th edition and REINSTATED in the 9th
// (2023), and has been in every edition since. Because this figure feeds
// `auditVerdict`, an options seller could be told an audit was not required on a
// book far above the threshold. Corrected 2026-08-31 against the PDFs.

import {
  BROKER_TURNOVER_BASIS,
  DELIVERY_SEGMENTS,
  FNO_SEGMENTS,
  TURNOVER_BASIS,
  brokerTurnoverContribution,
  turnoverContribution,
} from "./turnover";
import { section, STATUTE_CUTOVER_FY } from "./statute";
import { currentFy } from "./tax";

export { TURNOVER_BASIS, BROKER_TURNOVER_BASIS };

export interface ItrTrade {
  segment: string;
  buyDate: string | null;
  sellDate: string | null;
  grossPnl: number;
  netPnl: number;
  /** Sell-side consideration — the option premium half of turnover. Required. */
  sellValue: number;
  chargesTotal: number;
  isOpen: boolean;
}

export interface HeadSummary {
  trades: number;
  net: number; // post-charge realised P&L for the head
  gross: number;
  turnover: number; // ICAI GN 11th ed. 5.11(b): differences + option premium (business heads only)
  /** Differences only — the figure most broker tax reports print (owner
   *  decision 2026-09-01: BOTH bases are shown, labelled, never one). */
  turnoverBroker: number;
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
  /** The primary read — ICAI 11th-ed. turnover. */
  audit: AuditVerdict;
  /** The same threshold tested on the broker (differences-only) figure. At
   *  ₹1.2 Cr ICAI vs ₹14 L broker on one real book, the two can land on
   *  OPPOSITE sides of a limit — the user sees both reads, labelled. */
  auditBroker: AuditVerdict;
}

// S.44AB: 1 Cr base; 10 Cr when cash receipts AND payments ≤ 5% (retail broker
// trading is fully digital, so 10 Cr is the operative line). S.44AD presumptive:
// 2 Cr base / 3 Cr when ≥95% receipts are digital.
export const AUDIT_LIMIT_DIGITAL = 10_00_00_000;
export const PRESUMPTIVE_44AD_LIMIT_DIGITAL = 3_00_00_000;

const r2 = (n: number) => Math.round(n * 100) / 100;
const FNO = FNO_SEGMENTS;
const DELIVERY = DELIVERY_SEGMENTS;

function fyOf(dateStr: string | null, fyStartMonth: number, fallback: string): string {
  if (!dateStr) return fallback;
  const d = new Date(dateStr + "T00:00:00");
  const start = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const isLongTerm = (buy: string | null, sell: string | null) =>
  !!buy && !!sell && (new Date(sell).getTime() - new Date(buy).getTime()) / 86400000 >= 365;

function emptyHead(): HeadSummary {
  return { trades: 0, net: 0, gross: 0, turnover: 0, turnoverBroker: 0, charges: 0 };
}

/**
 * `fy` decides which Act the verdict CITES. The thresholds themselves are
 * unchanged across the 1961→2025 transition (₹10 Cr audit, ₹3 Cr presumptive),
 * so only the section numbers move. It defaults to the current Act rather than
 * the repealed one: a citation that is current-but-unqualified misleads far less
 * than one that confidently names repealed law.
 */
export function auditVerdict(
  combinedBusinessTurnover: number,
  hasBusinessLoss: boolean,
  fy: string = STATUTE_CUTOVER_FY,
): AuditVerdict {
  const auditS = section(fy, "audit");
  const presumptiveS = section(fy, "presumptive");
  const t = r2(combinedBusinessTurnover);
  const notes: string[] = [];
  let level: AuditLevel;
  let headline: string;

  if (t === 0) {
    level = "no-business-income";
    headline = `No business-head turnover this year — ${auditS} does not arise from trading alone.`;
  } else if (t > AUDIT_LIMIT_DIGITAL) {
    level = "audit-required";
    headline = `Business turnover ₹${t.toLocaleString("en-IN")} exceeds the ₹10 Cr digital-transactions limit — a tax audit under ${auditS} is required.`;
  } else {
    level = "audit-unlikely";
    headline = `Business turnover ₹${t.toLocaleString("en-IN")} is within the ₹10 Cr digital limit — an audit is generally NOT required on turnover alone.`;
    if (t <= PRESUMPTIVE_44AD_LIMIT_DIGITAL) {
      notes.push(
        `Turnover is within the ₹3 Cr (digital) presumptive limit of ${presumptiveS} — declaring ≥6% deemed profit is an option, but it binds you for 5 years and rarely suits loss years. Discuss with your CA.`,
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

/** Head-wise ITR-3 preparation pack per financial year, oldest FY first.
 *  The undated-sell fallback FY derives from TODAY (the A5 fix) — a frozen
 *  literal here filed undated trades under a stale year forever. */
export function itrPackByFy(
  trades: ItrTrade[],
  fyStartMonth = 4,
  fallbackFy: string = currentFy(fyStartMonth),
): ItrFyPack[] {
  const map = new Map<string, { spec: HeadSummary; fno: HeadSummary; cg: CapitalGainsSummary }>();
  for (const t of trades) {
    if (t.isOpen) continue;
    const fy = fyOf(t.sellDate ?? t.buyDate, fyStartMonth, fallbackFy);
    const b = map.get(fy) ?? { spec: emptyHead(), fno: emptyHead(), cg: { trades: 0, stcg: 0, ltcg: 0, charges: 0 } };
    if (t.segment === "eq_intraday") {
      b.spec.trades++;
      b.spec.net = r2(b.spec.net + t.netPnl);
      b.spec.gross = r2(b.spec.gross + t.grossPnl);
      b.spec.turnover = r2(b.spec.turnover + turnoverContribution(t));
      b.spec.turnoverBroker = r2(b.spec.turnoverBroker + brokerTurnoverContribution(t));
      b.spec.charges = r2(b.spec.charges + t.chargesTotal);
    } else if (FNO.has(t.segment)) {
      b.fno.trades++;
      b.fno.net = r2(b.fno.net + t.netPnl);
      b.fno.gross = r2(b.fno.gross + t.grossPnl);
      b.fno.turnover = r2(b.fno.turnover + turnoverContribution(t));
      b.fno.turnoverBroker = r2(b.fno.turnoverBroker + brokerTurnoverContribution(t));
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
    .map(([fy, b]) => {
      const hasLoss = b.spec.net < 0 || b.fno.net < 0;
      return {
        fy,
        speculative: b.spec,
        nonSpeculative: b.fno,
        capitalGains: b.cg,
        audit: auditVerdict(b.spec.turnover + b.fno.turnover, hasLoss, fy),
        auditBroker: auditVerdict(b.spec.turnoverBroker + b.fno.turnoverBroker, hasLoss, fy),
      };
    })
    .sort((a, b) => a.fy.localeCompare(b.fy));
}
