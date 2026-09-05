import { describe, expect, it } from "vitest";
import { anchorSession, isMarketOpenIst, istParts, sessionBucketIst } from "@/lib/live/market-hours";

/**
 * Market hours and the daily anchor — spec §4.3, 04 §1 A10.
 *
 * Every instant is written as a UTC literal with its IST equivalent in the
 * comment, so the test says what it means on a machine in any timezone. That is
 * the whole reason `now` is an argument rather than a `Date.now()` call.
 *
 * 2026-09-04 is a Friday; 2026-09-05 a Saturday; 2026-09-07 a Monday.
 */

const at = (utc: string) => new Date(utc);

describe("istParts", () => {
  it("converts to IST wall-clock regardless of the host timezone", () => {
    // 03:45Z = 09:15 IST on the same day.
    expect(istParts(at("2026-09-04T03:45:00Z")).hhmm).toBe("09:15");
    // 19:00Z = 00:30 IST the NEXT day — the case a naive UTC read gets wrong.
    const late = istParts(at("2026-09-04T19:00:00Z"));
    expect(late.hhmm).toBe("00:30");
    expect(late.weekday).toBe(6); // Saturday in India, still Friday in UTC
  });
});

describe("isMarketOpenIst", () => {
  it("is closed one minute before the open and open at 09:15 exactly", () => {
    expect(isMarketOpenIst(at("2026-09-04T03:44:00Z"))).toBe(false); // 09:14 IST
    expect(isMarketOpenIst(at("2026-09-04T03:45:00Z"))).toBe(true); // 09:15 IST
  });

  it("is open at 15:30 exactly and closed at 15:31", () => {
    expect(isMarketOpenIst(at("2026-09-04T10:00:00Z"))).toBe(true); // 15:30 IST
    expect(isMarketOpenIst(at("2026-09-04T10:01:00Z"))).toBe(false); // 15:31 IST
  });

  it("is closed at the weekend, even inside the session window", () => {
    expect(isMarketOpenIst(at("2026-09-05T06:00:00Z"))).toBe(false); // Sat 11:30 IST
    expect(isMarketOpenIst(at("2026-09-06T06:00:00Z"))).toBe(false); // Sun 11:30 IST
    expect(isMarketOpenIst(at("2026-09-07T06:00:00Z"))).toBe(true); // Mon 11:30 IST
  });

  it("pre-open is NOT 'open' — a call-auction fill is not a session fill", () => {
    expect(isMarketOpenIst(at("2026-09-04T03:35:00Z"))).toBe(false); // 09:05 IST
  });
});

describe("sessionBucketIst", () => {
  it("names the session the cockpit already names, not a second set of bands", () => {
    expect(sessionBucketIst(at("2026-09-04T03:35:00Z"))).toBe("preopen"); // 09:05
    expect(sessionBucketIst(at("2026-09-04T03:50:00Z"))).toBe("open"); // 09:20
    expect(sessionBucketIst(at("2026-09-04T05:00:00Z"))).toBe("morning"); // 10:30
    expect(sessionBucketIst(at("2026-09-04T06:30:00Z"))).toBe("midday"); // 12:00
    expect(sessionBucketIst(at("2026-09-04T09:00:00Z"))).toBe("afternoon"); // 14:30
    expect(sessionBucketIst(at("2026-09-04T10:00:00Z"))).toBe("close"); // 15:30
  });

  it("is null outside the window and at the weekend", () => {
    expect(sessionBucketIst(at("2026-09-04T11:00:00Z"))).toBeNull(); // 16:30 IST
    expect(sessionBucketIst(at("2026-09-05T06:00:00Z"))).toBeNull(); // Saturday
  });
});

describe("anchorSession", () => {
  it("is the MODAL session, not max(date) — a partial import cannot move it", () => {
    // Five symbols refreshed to the 4th; two thousand still on the 3rd.
    const dates = [...Array(2_000).fill("2026-09-03"), ...Array(5).fill("2026-09-04")];
    const a = anchorSession(dates);
    expect(a.anchor).toBe("2026-09-03");
    expect(a.anchor).not.toBe("2026-09-04");
    expect(a.ahead).toBe(5);
    expect(a.onAnchor).toBe(2_000);
  });

  it("hands over to the new session as soon as it is the mode", () => {
    const dates = [...Array(900).fill("2026-09-03"), ...Array(1_100).fill("2026-09-04")];
    expect(anchorSession(dates).anchor).toBe("2026-09-04");
  });

  it("breaks a tie to the LATER date", () => {
    const dates = [...Array(50).fill("2026-09-03"), ...Array(50).fill("2026-09-04")];
    expect(anchorSession(dates).anchor).toBe("2026-09-04");
    // …and the same holds whichever order the dates arrive in.
    expect(anchorSession([...dates].reverse()).anchor).toBe("2026-09-04");
  });

  it("publishes BOTH counts: ahead is truncated, behind is excluded", () => {
    const a = anchorSession(["2026-09-03", "2026-09-03", "2026-09-04", "2026-09-01"]);
    expect(a.anchor).toBe("2026-09-03");
    expect(a.onAnchor).toBe(2);
    expect(a.ahead).toBe(1);
    expect(a.behind).toBe(1);
    expect(a.total).toBe(4);
    expect(a.coveragePpm).toBe(500_000); // 2 of 4
  });

  it("an empty universe has NO anchor and NULL coverage — never a fabricated 100%", () => {
    const a = anchorSession([]);
    expect(a.anchor).toBeNull();
    expect(a.coveragePpm).toBeNull();
    expect(a.coveragePpm).not.toBe(0);
    expect(a.total).toBe(0);
  });
});
