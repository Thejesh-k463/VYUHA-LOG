import { describe, it, expect } from "vitest";
import {
  computeEventTds,
  annotateDividendTds,
  summariseByCompanyFy,
  TDS_THRESHOLD,
  TDS_RATE,
  type DividendEvent,
} from "@/lib/analytics/dividend-tds";

describe("computeEventTds", () => {
  it("no TDS when cumulative stays at or under the threshold", () => {
    expect(computeEventTds(0, 3000)).toEqual({ tds: 0, net: 3000 });
    expect(computeEventTds(2000, 3000)).toEqual({ tds: 0, net: 3000 }); // exactly 5000, not exceeding
  });

  it("taxes the whole payment that pushes the aggregate over the threshold", () => {
    const { tds, net } = computeEventTds(4000, 2000); // cumulative after = 6000 > 5000
    expect(tds).toBeCloseTo(2000 * TDS_RATE, 6);
    expect(net).toBeCloseTo(2000 - tds, 6);
  });

  it("taxes the whole payment when already past the threshold", () => {
    const { tds, net } = computeEventTds(6000, 1000);
    expect(tds).toBeCloseTo(100, 6);
    expect(net).toBeCloseTo(900, 6);
  });

  it("a single payment exceeding the threshold outright is fully taxed", () => {
    const { tds } = computeEventTds(0, 10000);
    expect(tds).toBeCloseTo(1000, 6);
  });
});

describe("annotateDividendTds — running threshold per company+FY", () => {
  it("keeps separate running totals per symbol", () => {
    const events: DividendEvent[] = [
      { symbol: "TCS", fy: "2026-27", date: "2026-04-01", grossAmount: 4000 },
      { symbol: "INFY", fy: "2026-27", date: "2026-04-01", grossAmount: 4000 },
      { symbol: "TCS", fy: "2026-27", date: "2026-07-01", grossAmount: 2000 }, // crosses TCS's threshold
    ];
    const out = annotateDividendTds(events);
    const tcs2 = out.find((e) => e.symbol === "TCS" && e.date === "2026-07-01")!;
    const infy = out.find((e) => e.symbol === "INFY")!;
    expect(tcs2.tds).toBeGreaterThan(0);
    expect(infy.tds).toBe(0); // INFY alone never crosses 5000
  });

  it("keeps separate running totals per FY for the same company", () => {
    const events: DividendEvent[] = [
      { symbol: "TCS", fy: "2025-26", date: "2025-06-01", grossAmount: 4000 },
      { symbol: "TCS", fy: "2026-27", date: "2026-06-01", grossAmount: 4000 }, // new FY — fresh threshold
    ];
    const out = annotateDividendTds(events);
    expect(out.every((e) => e.tds === 0)).toBe(true);
  });

  it("orders events by date within a group regardless of input order", () => {
    const events: DividendEvent[] = [
      { symbol: "TCS", fy: "2026-27", date: "2026-09-01", grossAmount: 2000 },
      { symbol: "TCS", fy: "2026-27", date: "2026-04-01", grossAmount: 4000 },
    ];
    const out = annotateDividendTds(events);
    const first = out.find((e) => e.date === "2026-04-01")!;
    const second = out.find((e) => e.date === "2026-09-01")!;
    expect(first.tds).toBe(0);
    expect(second.tds).toBeGreaterThan(0);
  });
});

describe("summariseByCompanyFy", () => {
  it("aggregates gross/tds/net per company+FY and flags threshold crossing", () => {
    const events: DividendEvent[] = [
      { symbol: "TCS", fy: "2026-27", date: "2026-04-01", grossAmount: 4000 },
      { symbol: "TCS", fy: "2026-27", date: "2026-07-01", grossAmount: 2000 },
    ];
    const rows = summariseByCompanyFy(events);
    expect(rows).toHaveLength(1);
    expect(rows[0].grossTotal).toBe(6000);
    expect(rows[0].thresholdCrossed).toBe(true);
    expect(rows[0].tdsTotal).toBeCloseTo(200, 6); // 10% of the 2000 crossing payment
    expect(rows[0].netTotal).toBeCloseTo(5800, 6);
  });

  it("does not flag threshold when aggregate stays at or under 5000", () => {
    const events: DividendEvent[] = [{ symbol: "ITC", fy: "2026-27", date: "2026-04-01", grossAmount: TDS_THRESHOLD }];
    const rows = summariseByCompanyFy(events);
    expect(rows[0].thresholdCrossed).toBe(false);
    expect(rows[0].tdsTotal).toBe(0);
  });

  it("sorts rows by FY then symbol", () => {
    const events: DividendEvent[] = [
      { symbol: "TCS", fy: "2026-27", date: "2026-04-01", grossAmount: 100 },
      { symbol: "INFY", fy: "2025-26", date: "2025-04-01", grossAmount: 100 },
    ];
    const rows = summariseByCompanyFy(events);
    expect(rows.map((r) => `${r.fy}:${r.symbol}`)).toEqual(["2025-26:INFY", "2026-27:TCS"]);
  });
});
