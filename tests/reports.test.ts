import { describe, it, expect } from "vitest";
import { chargesBySegment, chargesTotals, type ChargeReportTrade } from "@/lib/analytics/charges-report";
import { disciplineByWeek, type DisciplineTrade } from "@/lib/analytics/discipline";
import { taxByFy, type TaxTrade } from "@/lib/analytics/tax";

describe("charges-report", () => {
  const trades: ChargeReportTrade[] = [
    {
      segment: "index_option", sellDate: "2026-06-01", buyValue: 10000, sellValue: 12000,
      grossPnl: 2000, netPnl: 1925.68, brokerage: 40, sttCtt: 18, exchangeTxn: 7.71,
      sebi: 0.02, stampDuty: 0, ipft: 0, gst: 8.59, dpCharges: 0, mtfInterest: 0,
      pledgeCharges: 0, chargesTotal: 74.32,
    },
  ];
  it("aggregates per segment with break-even %", () => {
    const seg = chargesBySegment(trades);
    expect(seg[0].key).toBe("index_option");
    expect(seg[0].turnover).toBe(22000);
    expect(seg[0].total).toBe(74.32);
    expect(seg[0].breakevenPct).toBeCloseTo(0.34, 2); // 74.32 / 22000
  });
  it("totals row", () => {
    expect(chargesTotals(trades).total).toBe(74.32);
  });
});

describe("discipline scorecard", () => {
  const trades: DisciplineTrade[] = [
    { sellDate: "2026-06-01", netPnl: -5000, riskAmount: 9500, slPlanned: 95, targetPlanned: null, isOpen: false },
    { sellDate: "2026-06-01", netPnl: -12000, riskAmount: 9500, slPlanned: null, targetPlanned: null, isOpen: false },
    { sellDate: "2026-06-02", netPnl: 3000, riskAmount: 9500, slPlanned: 100, targetPlanned: null, isOpen: false },
  ];
  it("scores risk-cap, daily-stop and planning per week", () => {
    const w = disciplineByWeek(trades, 9500, 25000);
    expect(w.length).toBe(1);
    expect(w[0].riskCapRespectedPct).toBe(50); // 1 of 2 losers within cap
    expect(w[0].dailyStopRespectedPct).toBe(100); // both days within ₹25k
    expect(w[0].planningPct).toBeCloseTo(66.67, 1); // 2 of 3 have SL
    expect(w[0].score).toBeCloseTo(72.22, 1);
  });
});

describe("tax summary scaffold", () => {
  const trades: TaxTrade[] = [
    { segment: "eq_delivery", instrumentType: "equity", sellDate: "2026-06-01", buyDate: "2026-05-30", grossPnl: 1100, netPnl: 1000, buyValue: 49000, sellValue: 50000, chargesTotal: 100, isOpen: false },
    { segment: "eq_intraday", instrumentType: "equity", sellDate: "2026-06-02", buyDate: "2026-06-02", grossPnl: -400, netPnl: -500, buyValue: 20000, sellValue: 19600, chargesTotal: 100, isOpen: false },
    { segment: "index_option", instrumentType: "option", sellDate: "2026-06-03", buyDate: "2026-06-03", grossPnl: 2100, netPnl: 2000, buyValue: 10000, sellValue: 12000, chargesTotal: 100, isOpen: false },
    { segment: "eq_delivery", instrumentType: "equity", sellDate: "2026-06-01", buyDate: "2025-01-01", grossPnl: 5200, netPnl: 5000, buyValue: 40000, sellValue: 45000, chargesTotal: 200, isOpen: false },
  ];
  it("classifies STCG/LTCG/intraday/F&O per FY with turnover", () => {
    const fy = taxByFy(trades, 4, "2026-27");
    expect(fy.length).toBe(1);
    const s = fy[0];
    expect(s.fy).toBe("2026-27");
    expect(s.stcg).toBe(1000);
    expect(s.ltcg).toBe(5000);
    expect(s.intradaySpeculative).toBe(-500);
    expect(s.fnoBusiness).toBe(2000);
    expect(s.fnoTurnover).toBe(14100); // |2100| + 12000 premium
  });
});
