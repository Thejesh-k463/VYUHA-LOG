import { describe, it, expect } from "vitest";
import { computeExpiryStats, type ExpiryTradeInput } from "@/lib/analytics/expiry-stats";

const t = (
  segment: string,
  expiry: string | null,
  sellDate: string | null,
  netPnl: number,
  isOpen = false,
): ExpiryTradeInput => ({ segment, expiry, sellDate, netPnl, isOpen });

describe("computeExpiryStats", () => {
  // Expiry calendar derived from these expiries: 2026-06-25 and 2026-07-30.
  const trades: ExpiryTradeInput[] = [
    t("index_option", "2026-06-25", "2026-06-25", 4000), // exited on an expiry day
    t("index_option", "2026-07-30", "2026-06-25", -1500), // different contract, exit also an expiry day
    t("stock_option", "2026-07-30", "2026-07-10", 2000), // non-expiry exit
    t("future", "2026-07-30", "2026-07-12", -800), // non-expiry exit
    t("eq_delivery", null, "2026-06-25", 9000), // not F&O — ignored
    t("index_option", "2026-08-27", null, 0, true), // open → upcoming, not counted
  ];
  const s = computeExpiryStats(trades, "2026-06-20");

  it("derives the expiry calendar from F&O expiries", () => {
    expect(s.expiryDates).toEqual(["2026-06-25", "2026-07-30", "2026-08-27"]);
  });

  it("splits closed F&O P&L into expiry-day vs other days", () => {
    expect(s.expiryDay.trades).toBe(2); // both exited on 2026-06-25
    expect(s.expiryDay.net).toBe(2500); // 4000 − 1500
    expect(s.nonExpiry.trades).toBe(2);
    expect(s.nonExpiry.net).toBe(1200); // 2000 − 800
  });

  it("computes win rate, concentration and expiry edge", () => {
    expect(s.expiryDay.winRatePct).toBe(50); // 1 of 2
    expect(s.concentrationPct).toBe(50); // 2 of 4 closed F&O on expiry
    // edge = expiry avg (1250) − non-expiry avg (600) = 650
    expect(s.netEdgeExpiry).toBe(650);
  });

  it("lists upcoming expiries from open positions only", () => {
    expect(s.upcoming).toEqual([{ date: "2026-08-27", dte: 68, positions: 1 }]);
  });

  it("ignores equity trades in the split", () => {
    const total = s.expiryDay.trades + s.nonExpiry.trades;
    expect(total).toBe(4); // the eq_delivery row excluded
  });

  it("empty / no-F&O input → zeroed buckets", () => {
    const e = computeExpiryStats([t("eq_delivery", null, "2026-06-25", 100)], "2026-06-20");
    expect(e.expiryDates).toEqual([]);
    expect(e.expiryDay.trades).toBe(0);
    expect(e.concentrationPct).toBe(0);
    expect(e.upcoming).toEqual([]);
  });
});
