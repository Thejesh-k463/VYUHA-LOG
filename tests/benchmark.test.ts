import { describe, it, expect } from "vitest";
import {
  parseBenchmarkCsv,
  toIsoDate,
  closesToReturns,
  computeBenchmark,
  type BenchClose,
  type ReturnByDate,
} from "@/lib/analytics/benchmark";

// Benchmark closes whose successive ratios are rb = [+1%, −2%, +3%, +0.5%].
const closes: BenchClose[] = [
  { date: "2026-01-01", close: 100 },
  { date: "2026-01-02", close: 101 }, // +1%
  { date: "2026-01-03", close: 98.98 }, // −2%
  { date: "2026-01-04", close: 101.9494 }, // +3%
  { date: "2026-01-05", close: 102.459143 }, // +0.5%
];
const rb = [0.01, -0.02, 0.03, 0.005];
const dates = ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"];

describe("toIsoDate", () => {
  it("passes through ISO", () => expect(toIsoDate("2026-06-30")).toBe("2026-06-30"));
  it("parses DD-Mon-YYYY", () => expect(toIsoDate("30-Jun-2026")).toBe("2026-06-30"));
  it("parses DD-MM-YYYY as day-month", () => expect(toIsoDate("30-06-2026")).toBe("2026-06-30"));
  it("rejects junk / headers", () => expect(toIsoDate("Date")).toBeNull());
});

describe("parseBenchmarkCsv", () => {
  it("parses two-column rows, keeps thousands-separated closes, skips headers", () => {
    const rows = parseBenchmarkCsv(
      ["Date,Close", "30-Jun-2026, 24,000.50", "01-Jul-2026, 24,120.75", "garbage line"].join("\n"),
    );
    expect(rows).toEqual([
      { date: "2026-06-30", close: 24000.5 },
      { date: "2026-07-01", close: 24120.75 },
    ]);
  });
});

describe("closesToReturns", () => {
  it("derives daily returns from closes", () => {
    const rets = closesToReturns(closes);
    expect(rets.map((r) => r.date)).toEqual(dates);
    expect(rets[0].ret).toBeCloseTo(0.01, 8);
    expect(rets[1].ret).toBeCloseTo(-0.02, 8);
  });
});

describe("computeBenchmark", () => {
  it("recovers β and zero α for a perfectly leveraged portfolio (rp = 1.5·rb)", () => {
    const portfolio: ReturnByDate[] = dates.map((date, i) => ({ date, ret: 1.5 * rb[i] }));
    const s = computeBenchmark(portfolio, closes, 0)!;
    expect(s.beta).toBeCloseTo(1.5, 3);
    expect(s.alphaAnnualPct).toBeCloseTo(0, 2);
    expect(s.correlation).toBeCloseTo(1, 4);
    expect(s.rSquared).toBeCloseTo(1, 4);
    expect(s.overlapDays).toBe(4);
  });

  it("recovers α when the portfolio adds a constant daily edge (rp = 0.1%/day + rb)", () => {
    const portfolio: ReturnByDate[] = dates.map((date, i) => ({ date, ret: 0.001 + rb[i] }));
    const s = computeBenchmark(portfolio, closes, 0)!;
    expect(s.beta).toBeCloseTo(1, 3);
    expect(s.alphaAnnualPct).toBeCloseTo(25.2, 1); // 0.001 × 252 × 100
  });

  it("returns null when fewer than 2 dates overlap", () => {
    const portfolio: ReturnByDate[] = [{ date: "2026-01-02", ret: 0.01 }];
    expect(computeBenchmark(portfolio, closes, 0)).toBeNull();
  });

  it("returns null when dates do not overlap at all", () => {
    const portfolio: ReturnByDate[] = [
      { date: "2030-01-01", ret: 0.01 },
      { date: "2030-01-02", ret: 0.02 },
    ];
    expect(computeBenchmark(portfolio, closes, 0)).toBeNull();
  });
});
