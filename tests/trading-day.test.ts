import { describe, expect, it } from "vitest";
import { latestBhavcopyDate, previousTradingDay, toDdmmyyyy } from "../lib/domain/trading-day";

// Instants below are UTC; IST = UTC+5:30.

describe("latestBhavcopyDate", () => {
  it("weekday after 7pm IST → today", () => {
    // Tue 2026-07-14 19:30 IST == 14:00 UTC
    expect(latestBhavcopyDate(new Date("2026-07-14T14:00:00Z"))).toBe("2026-07-14");
  });

  it("weekday before publish hour → previous weekday", () => {
    // Tue 10:00 IST == 04:30 UTC
    expect(latestBhavcopyDate(new Date("2026-07-14T04:30:00Z"))).toBe("2026-07-13");
  });

  it("Monday morning → previous Friday", () => {
    // Mon 2026-07-13 09:00 IST == 03:30 UTC
    expect(latestBhavcopyDate(new Date("2026-07-13T03:30:00Z"))).toBe("2026-07-10");
  });

  it("Saturday and Sunday → Friday, regardless of hour", () => {
    expect(latestBhavcopyDate(new Date("2026-07-11T15:00:00Z"))).toBe("2026-07-10"); // Sat evening IST
    expect(latestBhavcopyDate(new Date("2026-07-12T05:00:00Z"))).toBe("2026-07-10"); // Sun morning IST
  });
});

describe("previousTradingDay", () => {
  it("walks back over weekends", () => {
    expect(previousTradingDay("2026-07-13")).toBe("2026-07-10"); // Mon → Fri
    expect(previousTradingDay("2026-07-14")).toBe("2026-07-13"); // Tue → Mon
  });
});

describe("toDdmmyyyy", () => {
  it("matches NSE archive naming", () => {
    expect(toDdmmyyyy("2026-07-14")).toBe("14072026");
  });
});
