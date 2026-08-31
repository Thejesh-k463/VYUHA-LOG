import { describe, expect, it } from "vitest";
import { itrPackByFy, auditVerdict, AUDIT_LIMIT_DIGITAL, type ItrTrade } from "../lib/analytics/itr";

const t = (over: Partial<ItrTrade>): ItrTrade => ({
  segment: "eq_intraday",
  buyDate: "2026-05-01",
  sellDate: "2026-05-01",
  grossPnl: 0,
  netPnl: 0,
  sellValue: 0,
  chargesTotal: 0,
  isOpen: false,
  ...over,
});

describe("itrPackByFy — head segregation", () => {
  it("splits speculative / non-speculative / capital gains correctly", () => {
    const pack = itrPackByFy([
      t({ segment: "eq_intraday", grossPnl: 5000, netPnl: 4800, chargesTotal: 200 }),
      t({ segment: "eq_intraday", grossPnl: -3000, netPnl: -3150, chargesTotal: 150 }),
      t({ segment: "index_option", grossPnl: 10000, netPnl: 9500, chargesTotal: 500 }),
      t({ segment: "future", grossPnl: -7000, netPnl: -7300, chargesTotal: 300 }),
      t({ segment: "eq_delivery", buyDate: "2026-04-01", sellDate: "2026-05-01", netPnl: 2000, chargesTotal: 100 }),
      t({ segment: "eq_mtf", buyDate: "2024-04-01", sellDate: "2026-05-01", netPnl: 15000, chargesTotal: 400 }),
    ]);
    expect(pack).toHaveLength(1);
    const p = pack[0];
    expect(p.fy).toBe("2026-27");
    // Speculative: net 1650, turnover = |5000| + |−3000| = 8000
    expect(p.speculative.trades).toBe(2);
    expect(p.speculative.net).toBe(1650);
    expect(p.speculative.turnover).toBe(8000);
    expect(p.speculative.charges).toBe(350);
    // F&O: differences 10000 + 7000, plus option sell premium (0 in this fixture).
    expect(p.nonSpeculative.trades).toBe(2);
    expect(p.nonSpeculative.net).toBe(2200);
    expect(p.nonSpeculative.turnover).toBe(17000);
    // Capital gains: delivery held 1 month = STCG; MTF held 2 years = LTCG
    expect(p.capitalGains.stcg).toBe(2000);
    expect(p.capitalGains.ltcg).toBe(15000);
    expect(p.capitalGains.trades).toBe(2);
  });

  it("carries BOTH turnover bases and an audit read on each (owner decision 2026-09-01)", () => {
    // An options seller: tiny differences, huge premium — the shape where the
    // two bases land on OPPOSITE sides of the ₹10 Cr line (a real Zerodha
    // book measured 6.5–8.7× apart; here exaggerated to cross the limit).
    const pack = itrPackByFy([
      t({ segment: "index_option", grossPnl: -50_00_000, netPnl: -50_10_000, sellValue: 10_10_00_000, chargesTotal: 10_000 }),
    ]);
    const p = pack[0];
    // ICAI 11th ed.: |−50L| + 10.1Cr premium = 10.6Cr → over the limit.
    expect(p.nonSpeculative.turnover).toBe(10_60_00_000);
    expect(p.audit.level).toBe("audit-required");
    // Broker basis: differences only = 50L → well inside it.
    expect(p.nonSpeculative.turnoverBroker).toBe(50_00_000);
    expect(p.auditBroker.level).toBe("audit-unlikely");
  });

  it("the broker basis on a futures-only book equals the ICAI basis (no premium term)", () => {
    const pack = itrPackByFy([t({ segment: "future", grossPnl: 40_000, sellValue: 9_00_000 })]);
    expect(pack[0].nonSpeculative.turnover).toBe(40_000);
    expect(pack[0].nonSpeculative.turnoverBroker).toBe(40_000);
  });

  it("open trades are excluded; FY assignment follows sell date and fyStartMonth", () => {
    const pack = itrPackByFy([
      t({ isOpen: true, grossPnl: 99999 }),
      t({ sellDate: "2026-03-31", grossPnl: 1000, netPnl: 900 }), // before April → FY 2025-26
      t({ sellDate: "2026-04-01", grossPnl: 1000, netPnl: 900 }), // April → FY 2026-27
    ]);
    expect(pack.map((p) => p.fy)).toEqual(["2025-26", "2026-27"]);
    expect(pack[0].speculative.trades).toBe(1);
  });
});

describe("auditVerdict", () => {
  it("no business turnover → 44AB does not arise", () => {
    expect(auditVerdict(0, false).level).toBe("no-business-income");
  });

  it("over ₹10 Cr digital limit → audit required", () => {
    const v = auditVerdict(AUDIT_LIMIT_DIGITAL + 1, false);
    expect(v.level).toBe("audit-required");
  });

  it("within limit → audit unlikely, presumptive note under ₹3 Cr", () => {
    const v = auditVerdict(50_00_000, false);
    expect(v.level).toBe("audit-unlikely");
    // Cited under the Act in force for the year the verdict is about.
    expect(v.notes.some((n) => n.includes("s.58"))).toBe(true);
    expect(auditVerdict(1_00_00_000, false, "2024-25").notes.some((n) => n.includes("S.44AD"))).toBe(true);
  });

  it("business loss adds the carry-forward / 44AD-opt-out caution", () => {
    const v = auditVerdict(50_00_000, true);
    expect(v.notes.some((n) => n.toLowerCase().includes("loss"))).toBe(true);
  });

  it("every verdict carries the consult-your-CA caution", () => {
    for (const v of [auditVerdict(0, false), auditVerdict(1e9, false), auditVerdict(1, true)]) {
      expect(v.notes.some((n) => n.includes("CA"))).toBe(true);
    }
  });
});
