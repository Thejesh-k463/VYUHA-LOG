import { describe, it, expect } from "vitest";
import { extractTime, extractDate } from "@/lib/import/time-parse";

describe("extractTime", () => {
  it("reads a bare HH:MM", () => {
    expect(extractTime("09:15")).toBe("09:15");
  });

  it("reads a time out of a full timestamp, whatever the separator", () => {
    expect(extractTime("2026-06-01T09:15:32")).toBe("09:15");
    expect(extractTime("2026-06-01 09:15:32")).toBe("09:15");
    expect(extractTime("01-06-2026 15:29")).toBe("15:29");
  });

  it("zero-pads a single-digit hour so times sort correctly as strings", () => {
    // "9:15" would sort AFTER "15:29" lexically, scrambling every hourly bucket.
    expect(extractTime("9:15")).toBe("09:15");
  });

  it("converts 12-hour clock with am/pm", () => {
    expect(extractTime("3:29 pm")).toBe("15:29");
    expect(extractTime("3:29 PM")).toBe("15:29");
    expect(extractTime("9:15 a.m.")).toBe("09:15");
  });

  it("handles the midnight/noon boundaries", () => {
    expect(extractTime("12:30 am")).toBe("00:30");
    expect(extractTime("12:30 pm")).toBe("12:30");
  });

  it("returns null rather than guessing when there is no time", () => {
    // A wrong time is worse than none — it would attribute trades to the
    // wrong session and quietly corrupt the whole time-of-day analysis.
    expect(extractTime("2026-06-01")).toBeNull();
    expect(extractTime("01-06-2026")).toBeNull();
    expect(extractTime("")).toBeNull();
    expect(extractTime(null)).toBeNull();
    expect(extractTime(undefined)).toBeNull();
  });

  it("rejects impossible clock values", () => {
    expect(extractTime("25:00")).toBeNull();
    expect(extractTime("10:75")).toBeNull();
  });

  it("does not mistake a date's digits for a time", () => {
    expect(extractTime("2026-06-01")).toBeNull();
    expect(extractTime("01/06/2026")).toBeNull();
  });
});

describe("extractDate", () => {
  it("reads ISO directly", () => {
    expect(extractDate("2026-06-01")).toBe("2026-06-01");
    expect(extractDate("2026-06-01T09:15:32")).toBe("2026-06-01");
  });

  it("reads Indian day-first dates — NOT month-first", () => {
    // The single most damaging mis-parse available here: reading 06-01-2026
    // as June 1st instead of 6th January shifts trades by months and silently
    // rewrites the whole P&L calendar.
    expect(extractDate("06-01-2026")).toBe("2026-01-06");
    expect(extractDate("06/01/2026")).toBe("2026-01-06");
    expect(extractDate("1-6-2026")).toBe("2026-06-01");
  });

  it("rejects a date whose month cannot be a month", () => {
    // 13 can only be a day, so a day-first read is unambiguous; anything that
    // would need month 13 is malformed.
    expect(extractDate("06-13-2026")).toBeNull();
  });

  it("returns null on junk", () => {
    expect(extractDate("not a date")).toBeNull();
    expect(extractDate("")).toBeNull();
    expect(extractDate(null)).toBeNull();
  });
});
