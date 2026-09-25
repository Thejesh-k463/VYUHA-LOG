import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { latestBhavcopyDate, previousTradingDay } from "../lib/domain/market-calendar";
import {
  toDdmmyyyy,
  isRealDay,
  normalizeDate,
  unreadableDateMessage,
  dayOf,
  sameDay,
  calendarDaysHeld,
  unreadableStoredDate,
  storedDateProblem,
  unreadableStoredDateMessage,
} from "../lib/domain/trading-day";

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

/**
 * G-G3-1 (v4.3.0 fix wave 2M) — ONE calendar implementation.
 *
 * `isRealDay` / `normalizeDate` were private to `lib/import/commit.ts`, which is
 * server-only: the close dialog restated the rule as its own `realDay`, and the
 * staged ladder — which cannot import commit.ts either — went without it and priced
 * MTF interest off `new Date(leg.tradeDate)`. They live here now, unchanged, because
 * this module is pure (invariant 2) and both graphs already import it.
 *
 * The behaviour pinned below is the behaviour they had in commit.ts;
 * `tests/normalize-date.test.ts` pins the same function through commit.ts's own
 * re-export, and both files must stay green for the move to be a move.
 */
describe("G-G3-1 · the one calendar: normalizeDate reads a day or answers none", () => {
  it.each([
    ["2026-02-31", null, "February has no 31st — the shape matched, the calendar does not"],
    ["31-08-2026", "2026-08-31", "day-first, as every Indian broker export writes it"],
    ["2026-08-31T10:00", "2026-08-31", "an ISO day with a time on it"],
    ["not-a-date", null, "text that is no date at all"],
    ["", null, "a blank field states no day"],
    ["29-02-2027", null, "2027 is not a leap year"],
    ["29-02-2028", "2028-02-29", "2028 is"],
  ])("%j → %j (%s)", (input, expected, _why) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it("isRealDay composes the day only when it exists", () => {
    expect(isRealDay("2028", "02", "29")).toBe("2028-02-29");
    expect(isRealDay("2026", "02", "31")).toBeNull();
    expect(isRealDay("2026", "13", "01")).toBeNull();
    expect(isRealDay("2026", "09", "00")).toBeNull();
  });
});

/**
 * D4 / D7 / D9 (v4.3.0 fix wave 2P) — the three folds every date READER shares.
 *
 * `dayOf` is the ONE fold for "which day does this stored or typed value state":
 * three private copies of it (`lib/analytics/ipo-link.ts`, two in
 * `app/api/ipos/route.ts`) and two raw byte compares (`lib/domain/trade-edit.ts`)
 * each answered a different question for a blank, so a notes-only save of a
 * day-first ladder was refused as a moved fill (D4) and a blank stored IPO exit
 * date was a 409 "sale recorded in Trades" (D8). `calendarDaysHeld` is the ONE day
 * count: five copies of `/ 86400000` existed and one of them (`updateManualTrade`)
 * read a whitespace date as PRESENT, took NaN into the engine and died on the NOT
 * NULL write (D7). `unreadableStoredDate` is the part `storedDateProblem` already
 * computed, exposed so the trade editor can state the STORED problem (D9).
 */
describe("D4 · dayOf — the ISO day a value states; raw when unreadable; null when blank", () => {
  it.each([
    ["2026-01-05", "2026-01-05"],
    ["05-01-2026", "2026-01-05"],
    ["2026-01-05 10:30:00", "2026-01-05"],
    ["", null],
    [" ", null],
    ["\t", null],
    [null, null],
    [undefined, null],
    ["9999-99-99", "9999-99-99"],
  ] as const)("%j → %j", (input, expected) => {
    expect(dayOf(input)).toBe(expected);
  });

  it("sameDay compares the days two values state, whatever their spelling", () => {
    expect(sameDay("2026-01-20", "20-01-2026")).toBe(true);
    expect(sameDay("2026-01-21", "20-01-2026")).toBe(false);
    expect(sameDay("9999-99-99", "9999-99-99"), "an unreadable value compares only to itself").toBe(true);
    expect(sameDay(null, "20-01-2026")).toBe(false);
    expect(sameDay(" ", null), "a blank states no day, like a null").toBe(true);
    expect(sameDay("", "")).toBe(true);
  });
});

describe("D7 · calendarDaysHeld — one day count; a date that states no day counts zero", () => {
  it.each([
    ["2026-08-01", "2026-08-20", 19, "an ISO pair"],
    ["01-08-2026", "20-08-2026", 19, "a day-first pair"],
    ["01-08-2026", "2026-08-20", 19, "a mixed pair"],
    [" ", "2026-08-20", 0, "whitespace"],
    ["2026-08-01", "\t", 0, "a tab"],
    ["", "2026-08-20", 0, "blank"],
    [null, "2026-08-20", 0, "null"],
    ["2026-02-31", "2026-08-20", 0, "an impossible day"],
    ["2026-08-20", "2026-08-01", 0, "reversed"],
    [undefined, undefined, 0, "both absent"],
  ] as const)("%j → %j = %i (%s)", (from, to, expected, _why) => {
    expect(calendarDaysHeld(from, to)).toBe(expected);
  });

  it("is arithmetic-preserving for a readable pair: the same integer the five copies computed", () => {
    const legacy = (a: string, b: string) => Math.max(0, Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000));
    for (const [a, b] of [["2026-01-01", "2026-12-31"], ["2024-02-28", "2024-03-01"], ["2026-08-01", "2026-08-01"]]) {
      expect(calendarDaysHeld(a, b)).toBe(legacy(a, b));
    }
  });
});

describe("D9 · unreadableStoredDate — the parts, and storedDateProblem is their sentence", () => {
  it("names the column and the raw value, trimmed; null when both dates are readable or absent", () => {
    expect(unreadableStoredDate({ buyDate: "9999-99-99", sellDate: "2026-09-01" })).toEqual({ label: "buy date", raw: "9999-99-99" });
    expect(unreadableStoredDate({ buyDate: "2026-08-01", sellDate: " 2026-02-31 " })).toEqual({ label: "sell date", raw: "2026-02-31" });
    expect(unreadableStoredDate({ buyDate: "2026-08-01", sellDate: null })).toBeNull();
    expect(unreadableStoredDate({ buyDate: " ", sellDate: "" }), "whitespace is an unanswered field, not an unreadable one").toBeNull();
    expect(unreadableStoredDate({})).toBeNull();
  });

  it("storedDateProblem ≡ its sentence over those parts", () => {
    for (const t of [
      { buyDate: "9999-99-99", sellDate: "2026-09-01" },
      { buyDate: "05-01-2026", sellDate: "2026-02-31" },
      { buyDate: "2026-08-01", sellDate: null },
    ]) {
      const parts = unreadableStoredDate(t);
      expect(storedDateProblem(t)).toBe(parts ? unreadableStoredDateMessage(parts.label, parts.raw) : null);
    }
  });
});

describe("G-G3-1 · every writer and both dialogs read THIS calendar, not a copy of it", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  // The files that date a trade or a fill. A private re-implementation in any of
  // them is how the ladder came to bill seven months of interest for one.
  // D4 / D7 (wave 2P): the two /ipos files that folded a day privately, and the
  // broker-compare page that counted days privately, join the scan; a private
  // `dayOf` / `day` / `storedDay` fold or a `/ 86400000` day count reddens it.
  it.each([
    "lib/import/commit.ts",
    "lib/queries/staged.ts",
    "lib/domain/staged.ts",
    "lib/domain/trade-edit.ts",
    "components/trades/close-trade-dialog.tsx",
    "components/trades/edit-trade-dialog.tsx",
    "lib/analytics/ipo-link.ts",
    "app/api/ipos/route.ts",
    "app/reports/costs/_tabs/broker-compare.tsx", // v4.6.0 W3: the old /reports/broker-compare body
  ])("%s imports the shared calendar and defines none of its own", (rel) => {
    const src = read(rel);
    expect(/from "@\/lib\/domain\/trading-day"/.test(src), "imports lib/domain/trading-day").toBe(true);
    expect(/function\s+(isRealDay|realDay|normalizeDate|dayOf|storedDay|calendarDaysHeld|daysBetween|heldDays)\s*\(/.test(src), "a private copy of the calendar").toBe(false);
    expect(/const\s+(dayOf|day|storedDay)\s*=\s*\(/.test(src), "a private day fold").toBe(false);
    expect(/\/\s*86400000/.test(src), "a private day count").toBe(false);
  });

  it("the refusal sentence is the one commit.ts's writers answer, word for word", () => {
    // commit.ts keeps its own `unreadableDate` (its file set, not this wave's); this
    // asserts the two sentences are the same sentence, so a later edit to either is
    // caught here rather than by a user reading two different refusals.
    const m = read("lib/import/commit.ts").match(/return `The \$\{label\} “\$\{raw\}”([^`]*)`/);
    expect(m, "commit.ts#unreadableDate's sentence").not.toBeNull();
    expect(unreadableDateMessage("sell date", "2026-02-31")).toBe(`The sell date “2026-02-31”${m![1]}`);
    expect(unreadableDateMessage("entry date", "31-02-2026")).toContain("31-02-2026");
  });
});
