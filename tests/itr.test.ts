import { describe, expect, it } from "vitest";
import { itrPackByFy, auditVerdict, AUDIT_LIMIT_DIGITAL, type ItrTrade } from "../lib/analytics/itr";

const t = (over: Partial<ItrTrade>): ItrTrade => ({
  segment: "eq_intraday",
  buyDate: "2026-05-01",
  sellDate: "2026-05-01",
  grossPnl: 0,
  netPnl: 0,
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
    // F&O: turnover = 10000 + 7000 = 17000 (Guidance Note absolute-sum; NO premium add-on)
    expect(p.nonSpeculative.trades).toBe(2);
    expect(p.nonSpeculative.net).toBe(2200);
    expect(p.nonSpeculative.turnover).toBe(17000);
    // Capital gains: delivery held 1 month = STCG; MTF held 2 years = LTCG
    expect(p.capitalGains.stcg).toBe(2000);
    expect(p.capitalGains.ltcg).toBe(15000);
    expect(p.capitalGains.trades).toBe(2);
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
    expect(v.notes.some((n) => n.includes("44AD"))).toBe(true);
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
