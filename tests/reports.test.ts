import { describe, it, expect } from "vitest";
import { chargesBySegment, chargesTotals, type ChargeReportTrade } from "@/lib/analytics/charges-report";
import { disciplineByWeek, type DisciplineTrade } from "@/lib/analytics/discipline";
import { processScore } from "@/lib/analytics/process-score";
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

// v3.7 (WS2): the weekly score is the PROCESS SCORE — five components, a
// sample floor, and a refusal instead of a number when the week is too thin.
// The three legacy percentage fields still populate (the discipline table and
// the monthly report read them) but they now come off the Process Score's own
// components, so there is one weekly number in the product, not two.
describe("discipline scorecard", () => {
  const trades: DisciplineTrade[] = [
    { sellDate: "2026-06-01", netPnl: -5000, riskAmount: 9500, slPlanned: 95, targetPlanned: null, isOpen: false },
    { sellDate: "2026-06-01", netPnl: -12000, riskAmount: 9500, slPlanned: null, targetPlanned: null, isOpen: false },
    { sellDate: "2026-06-02", netPnl: 3000, riskAmount: 9500, slPlanned: 100, targetPlanned: null, isOpen: false },
  ];

  it("scores risk-cap, daily-stop and planning per week", () => {
    const w = disciplineByWeek(trades, 9500, 25000, 3);
    expect(w.length).toBe(1);
    expect(w[0].riskCapRespectedPct).toBe(50); // 1 of 2 losers within its own risk
    expect(w[0].dailyStopRespectedPct).toBe(100); // both days within ₹25k
    expect(w[0].planningPct).toBeCloseTo(66.67, 1); // 2 of 3 have SL
    // Five components now, not three: nothing is reviewed and nothing carries a
    // playbook, so `reviewed` is 0 and `rules-followed` refuses.
    expect(w[0].score).toBe(54); // (66.67 + 50 + 100 + 0) / 4
    expect(w[0].components.map((c) => c.id)).toEqual([
      "planned", "risk-cap", "daily-stop", "rules-followed", "reviewed",
    ]);
    expect(w[0].components.find((c) => c.id === "rules-followed")!.pct).toBeNull();
  });

  it("the weekly score IS processScore for the same week — one number, not two", () => {
    const cfg = { perTradeCap: 9500, dailyStop: 25000, floor: 3 };
    const direct = processScore(
      trades.map((t) => ({ ...t, playbookId: null, ruleViolations: null, reviewedAt: null })),
      cfg,
    );
    const w = disciplineByWeek(trades, cfg.perTradeCap, cfg.dailyStop, cfg.floor)[0];
    expect(w.processScore).toBe(direct.score);
    expect(w.score).toBe(direct.score);
    expect(w.components).toEqual(direct.components);
  });

  it("a week under the sample floor refuses to score and says why", () => {
    const w = disciplineByWeek(trades, 9500, 25000)[0]; // default floor of 10
    expect(w.processScore).toBeNull();
    expect(w.refusal).toEqual({ reason: "3 closed trades this week; the score needs 10" });
    // The components are still there: the arithmetic is visible even when the
    // summary figure is withheld.
    expect(w.components).toHaveLength(5);
    expect(w.planningPct).toBeCloseTo(66.67, 1);
  });

  // v3.6 read `cap = perTradeCap || 9500` — measuring a user's losses against a
  // limit they never set (invariant 6: never fabricate a denominator).
  it("refuses the risk-cap percentage rather than inventing a ₹9,500 cap", () => {
    const noRisk: DisciplineTrade[] = trades.map((t) => ({ ...t, riskAmount: null }));
    const w = disciplineByWeek(noRisk, null, 25000, 3)[0];
    expect(w.riskCapRespectedPct).toBeNull(); // the invented cap would have said 50
    expect(w.dailyStopRespectedPct).toBe(100); // the other components still score
    expect(w.score).toBe(56); // (66.67 + 100 + 0) / 3
  });

  it("a daily stop that was never configured refuses too", () => {
    const w = disciplineByWeek(trades, 9500, null, 3)[0];
    expect(w.dailyStopRespectedPct).toBeNull();
    expect(w.riskCapRespectedPct).toBe(50);
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
