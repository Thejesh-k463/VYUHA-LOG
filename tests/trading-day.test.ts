import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  latestBhavcopyDate,
  previousTradingDay,
  toDdmmyyyy,
  isRealDay,
  normalizeDate,
  unreadableDateMessage,
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

describe("G-G3-1 · every writer and both dialogs read THIS calendar, not a copy of it", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  // The five files that date a trade or a fill. A private re-implementation in any
  // of them is how the ladder came to bill seven months of interest for one.
  it.each([
    "lib/import/commit.ts",
    "lib/queries/staged.ts",
    "lib/domain/staged.ts",
    "components/trades/close-trade-dialog.tsx",
    "components/trades/edit-trade-dialog.tsx",
  ])("%s imports the shared calendar and defines none of its own", (rel) => {
    const src = read(rel);
    expect(/from "@\/lib\/domain\/trading-day"/.test(src), "imports lib/domain/trading-day").toBe(true);
    expect(/function\s+(isRealDay|realDay|normalizeDate)\s*\(/.test(src), "a private copy of the calendar").toBe(false);
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
