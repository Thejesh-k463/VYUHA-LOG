import { afterAll, describe, expect, it } from "vitest";
import { trailingRunRate, type RealisedDay } from "@/lib/analytics/goal";

/**
 * Timezone-stability of the trailing windows (adversarial probe, 2026-09-01).
 *
 * shiftDays used to parse LOCAL midnight and slice toISOString() (UTC): on any
 * timezone ahead of UTC — IST, where this app lives — the window start slid one
 * calendar day back, so the "30-day" run-rate quietly averaged 31 days of P&L
 * and a trade exactly 30 days old leaked into the window.
 *
 * Node re-reads process.env.TZ on date use, so each case pins the zone
 * explicitly and the suite proves the SAME boundary in UTC and IST. Under the
 * reverted (local-midnight) implementation the IST case fails: the day-31
 * boundary trade comes back inside the window.
 */

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const TODAY = "2026-08-31";
// windowDays = 30 → window is 2026-08-02 .. 2026-08-31 inclusive (30 days).
const lastDayIn: RealisedDay[] = [{ date: "2026-08-02", net: 3000 }];
const firstDayOut: RealisedDay[] = [{ date: "2026-08-01", net: 3000 }];

describe.each(["UTC", "Asia/Kolkata"])("trailing window boundaries under TZ=%s", (tz) => {
  it("the 30-day window holds exactly 30 days", () => {
    process.env.TZ = tz;
    // day 30 (today − 29) is IN: ₹3,000 over 30 days = ₹700/week.
    expect(trailingRunRate(lastDayIn, TODAY, 30)).toBe(700);
    // day 31 (today − 30) is OUT: a real history, a quiet window → true ₹0.
    expect(trailingRunRate(firstDayOut, TODAY, 30)).toBe(0);
  });

  it("the 90-day window boundary holds too", () => {
    process.env.TZ = tz;
    // 90-day window from 2026-08-31 starts 2026-06-03.
    expect(trailingRunRate([{ date: "2026-06-03", net: 9000 }], TODAY, 90)).toBe(700);
    expect(trailingRunRate([{ date: "2026-06-02", net: 9000 }], TODAY, 90)).toBe(0);
  });
});
