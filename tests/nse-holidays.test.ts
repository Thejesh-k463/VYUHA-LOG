import { describe, expect, it } from "vitest";
import holidays from "@/lib/data/nse-holidays.json";
import {
  NSE_HOLIDAY_YEAR,
  isExchangeHoliday,
  isTradingDayIst,
  todayIstIso,
} from "@/lib/domain/trading-day";

/**
 * F1 (v4.2) — the BUNDLED NSE trading-holiday list, and the year guard that
 * stops a release shipping a stale one.
 *
 * WHY A BUNDLED LIST AT ALL. Vyuha is offline-first, so until v4.2 the app
 * modelled the CLOCK and not the exchange calendar: `isMarketOpenIst` said
 * "open" on Republic Day, and — the actual defect — a weekday holiday after
 * 15:30 wrote the previous close into `mtm_prices` UNDER THE HOLIDAY'S DATE,
 * inventing a session the market never had. `tests/live-mark-persist.test.ts`
 * drives that door; this file is about the calendar itself.
 *
 * THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC, which is why the semantics are
 * what they are:
 *
 *   - A DATE WRONGLY LISTED here suppresses a real session's automatic mark and
 *     tells the user the market is closed on a day it traded. Unrecoverable
 *     without the user noticing. So rows come only from a recorded diff against
 *     NSE's own holiday-master, and CLEARING holidays — a different list, on
 *     which the market is OPEN — may never be copied in.
 *   - AN UNKNOWN YEAR is merely unknown. `isExchangeHoliday` answers FALSE for
 *     it, so v4.1's weekday behaviour survives unchanged rather than the whole
 *     desk falling silent every January. The YEAR GUARD below is what stops
 *     that being a quiet, permanent state.
 */

const rows = holidays.trading_holidays;
const dates = rows.map((r) => r.date);

describe("the bundled file's shape is the contract the code reads", () => {
  it("carries the year, the recorded diff behind it, and its own warning", () => {
    expect(holidays.year).toBe(2026);
    expect(holidays.verified_at).toBe("2026-08-27");
    expect(holidays.verified_against).toBe(
      "nseindia.com/api/holiday-master (CM segment), fetched live 2026-08-27",
    );
    // The header warning travels WITH the data, so a session editing the rows
    // cannot avoid reading why a wrong one is expensive.
    expect(holidays._note).toContain("SILENTLY SUPPRESSES A REAL SESSION");
    expect(holidays._note).toContain("CLEARING HOLIDAYS ARE NOT TRADING HOLIDAYS");
    expect(NSE_HOLIDAY_YEAR).toBe(holidays.year);
  });

  it("holds NSE's 19 CM trading holidays for 2026 — every row an ISO date in that year, with a name", () => {
    // 19, not 20: NSE's CM trading list carries "Diwali Laxmi Pujan*" on
    // 08-Nov, where the asterisk IS the Muhurat evening session. A day with a
    // session is not a holiday, so it is not here.
    expect(rows).toHaveLength(19);
    for (const r of rows) {
      expect(r.date, `${r.date} is not an ISO date`).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(r.name.length, `${r.date} has no name`).toBeGreaterThan(0);
    }
    expect(new Set(dates).size, "a duplicated date").toBe(rows.length);
    expect([...dates].sort()).toEqual(dates); // ascending, so a human can diff it
  });

  it("carries NO clearing holiday — the market is OPEN on those days", () => {
    // NSE's 2026 CM clearing list holds 20 rows; sixteen coincide with a
    // trading holiday and these FOUR do not. Each is an ordinary trading day on
    // which only settlement is shut. One of them (26-Aug, Id-E-Milad) was
    // copied into a trading list in another product and cancelled a real
    // session that printed Nifty 24,207.75.
    for (const clearingOnly of ["2026-02-19", "2026-03-19", "2026-04-01", "2026-08-26"]) {
      expect(dates, `${clearingOnly} is a CLEARING holiday and must not be here`).not.toContain(clearingOnly);
      expect(isExchangeHoliday(clearingOnly)).toBe(false);
    }
  });

  it("THE YEAR GUARD: this build's own IST year is covered by the bundled list", () => {
    // Goes RED on 1 January of the year after `year`, in IST — before a release
    // can ship a calendar that has run out. Fixing it means adding the next
    // year's rows FROM NSE's holiday-master and bumping `year`; it must never
    // be fixed by relaxing this assertion.
    const istYear = Number(todayIstIso().slice(0, 4));
    expect(istYear, `the bundled NSE holiday list stops at ${NSE_HOLIDAY_YEAR} and it is now ${istYear}`).toBeLessThanOrEqual(
      NSE_HOLIDAY_YEAR,
    );
  });
});

describe("isExchangeHoliday — listed AND covered, or it is not a holiday", () => {
  it("is true for a listed date", () => {
    expect(isExchangeHoliday("2026-01-26")).toBe(true); // Republic Day, a Monday
    expect(isExchangeHoliday("2026-10-02")).toBe(true); // Gandhi Jayanti, a Friday
    expect(isExchangeHoliday("2026-12-25")).toBe(true);
  });

  it("is false for an ordinary weekday in a covered year", () => {
    expect(isExchangeHoliday("2026-01-27")).toBe(false);
    expect(isExchangeHoliday("2026-09-04")).toBe(false);
  });

  it("is false — UNKNOWN, not a holiday — for a year the file does not cover", () => {
    // The same calendar dates one year on. Guessing them is how a lunar-calendar
    // holiday ends up asserted against a day NSE traded.
    expect(isExchangeHoliday("2027-01-26")).toBe(false);
    expect(isExchangeHoliday("2027-12-25")).toBe(false);
    expect(isExchangeHoliday("2025-01-26")).toBe(false);
  });

  it("is false for a malformed or empty date rather than throwing", () => {
    for (const bad of ["", "26-01-2026", "not-a-date"]) expect(isExchangeHoliday(bad)).toBe(false);
  });
});

describe("isTradingDayIst — a weekday that is not a listed holiday", () => {
  it("takes an ISO date or an instant, and answers on INDIA's day either way", () => {
    expect(isTradingDayIst("2026-09-04")).toBe(true); // Friday
    // 2026-09-04T19:00Z is 00:30 IST on Saturday the 5th — the case a naive UTC
    // read gets wrong, and the reason there is exactly one IST clock.
    expect(isTradingDayIst(new Date("2026-09-04T19:00:00Z"))).toBe(false);
    expect(isTradingDayIst(new Date("2026-09-04T05:00:00Z"))).toBe(true); // Fri 10:30 IST
  });

  it("is false at the weekend and on a listed holiday", () => {
    expect(isTradingDayIst("2026-09-05")).toBe(false); // Saturday
    expect(isTradingDayIst("2026-09-06")).toBe(false); // Sunday
    expect(isTradingDayIst("2026-10-02")).toBe(false); // Gandhi Jayanti, a Friday
    expect(isTradingDayIst(new Date("2026-10-02T11:00:00Z"))).toBe(false); // 16:30 IST
  });

  it("stays TRUE on an uncovered year's weekday — unknown is not a holiday", () => {
    expect(isTradingDayIst("2027-01-26")).toBe(true); // a Tuesday
    expect(isTradingDayIst("2027-01-30")).toBe(false); // a Saturday, still known
  });
});
