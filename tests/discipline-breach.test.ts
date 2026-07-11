import { describe, expect, it } from "vitest";
import { breachReport } from "../lib/analytics/discipline";

const t = (violations: string[] | null, netPnl: number, isOpen = false) => ({
  ruleViolations: violations,
  netPnl,
  isOpen,
});

describe("breachReport", () => {
  it("returns an empty report when no trade carries a breach", () => {
    const r = breachReport([t(null, 100), t([], -50)]);
    expect(r.breachedTrades).toBe(0);
    expect(r.totalBreaches).toBe(0);
    expect(r.closedNet).toBe(0);
    expect(r.perRule).toEqual([]);
  });

  it("counts trades and breaches per rule label", () => {
    const r = breachReport([
      t(["Per-trade risk: Risk ₹12,000 exceeds the cap.", "Daily loss stop: near stop"], -5000),
      t(["Per-trade risk: Risk ₹9,900 near the cap."], -2000),
      t(null, 1000),
    ]);
    expect(r.breachedTrades).toBe(2);
    expect(r.totalBreaches).toBe(3);
    expect(r.closedNet).toBe(-7000);
    const perTrade = r.perRule.find((p) => p.rule === "Per-trade risk")!;
    expect(perTrade.trades).toBe(2);
    expect(perTrade.closedNet).toBe(-7000);
    const daily = r.perRule.find((p) => p.rule === "Daily loss stop")!;
    expect(daily.trades).toBe(1);
    expect(daily.closedNet).toBe(-5000);
  });

  it("excludes open trades from closedNet but counts them as breached", () => {
    const r = breachReport([
      t(["Concentration: over cap"], 999, true),
      t(["Concentration: over cap"], -300, false),
    ]);
    expect(r.breachedTrades).toBe(2);
    expect(r.openBreached).toBe(1);
    expect(r.closedNet).toBe(-300);
    expect(r.perRule[0].closedNet).toBe(-300);
  });

  it("sorts perRule worst closed net first and handles label-only strings", () => {
    const r = breachReport([
      t(["Stop-loss"], -100),
      t(["Max open positions: at max"], -900),
    ]);
    expect(r.perRule[0].rule).toBe("Max open positions");
    expect(r.perRule[1].rule).toBe("Stop-loss");
  });
});
