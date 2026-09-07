import { describe, expect, it } from "vitest";
import {
  eodQuoteFromBars,
  isCashKey,
  isWithinLiveWindow,
  manualQuoteFromMark,
  sessionCloseIso,
  type StoredBar,
} from "@/lib/quotes/mapping";
import { NSE_HOLIDAY_YEAR } from "@/lib/domain/trading-day";
import { isMarketOpenIst } from "@/lib/live/market-hours";
import { quoteKeyId, toPaise, type QuoteKey } from "@/lib/quotes/types";

/**
 * The PURE half of the two DB-backed providers (invariant 2): stored rupees →
 * quoted paise, and the IST window that decides whether a feed may run at all.
 * Everything here is a value in / value out, so it is the layer that can be
 * exhaustively asserted.
 */

const TCS: QuoteKey = { symbol: "TCS", exchange: "NSE" };

const bar = (over: Partial<StoredBar> & { date: string; close: number }): StoredBar => ({
  high: null,
  low: null,
  ...over,
});

describe("rupees at rest, paise on the wire (invariant 1)", () => {
  it("converts a per-unit price without the float error", () => {
    // 1234.56 * 100 === 123455.99999999999 in IEEE 754. A truncation here is a
    // one-paise-per-share error on every mark.
    expect(toPaise(1234.56)).toBe(123456);
    expect(toPaise(2478.65)).toBe(247865);
    expect(Number.isInteger(toPaise(99.995))).toBe(true);
  });

  it("keys a quote by the traded contract when there is one", () => {
    expect(quoteKeyId(TCS)).toBe("NSE:TCS");
    expect(quoteKeyId({ symbol: "NIFTY", exchange: "NFO", tradingsymbol: "NIFTY26SEP24000CE" })).toBe(
      "NFO:NIFTY26SEP24000CE",
    );
  });
});

describe("eodQuoteFromBars", () => {
  const bars: StoredBar[] = [
    bar({ date: "2026-09-02", close: 3000.5 }),
    bar({ date: "2026-09-03", close: 3010.25 }),
    bar({ date: "2026-09-04", close: 3025.75, open: 3012.1, high: 3030, low: 3005.5, volume: 812345 }),
  ];

  it("quotes the LAST bar and takes prevClose from the one before it", () => {
    const q = eodQuoteFromBars(TCS, bars)!;
    expect(q.ltp).toBe(302575);
    expect(q.prevClose).toBe(301025);
    expect(q.dayOpen).toBe(301210);
    expect(q.dayHigh).toBe(303000);
    expect(q.dayLow).toBe(300550);
    expect(q.volume).toBe(812345);
  });

  it("stamps asOf with the session the price was true in, not 'now'", () => {
    expect(eodQuoteFromBars(TCS, bars)!.asOf).toBe("2026-09-04T15:30:00+05:30");
    expect(sessionCloseIso("2026-01-01")).toBe("2026-01-01T15:30:00+05:30");
  });

  it("declares its own staleness and source", () => {
    const q = eodQuoteFromBars(TCS, bars)!;
    expect(q.staleness).toBe("eod");
    expect(q.source).toBe("eod");
  });

  it("returns prevClose null under two sessions — never a 0 that reads as flat", () => {
    const one = eodQuoteFromBars(TCS, [bar({ date: "2026-09-04", close: 3025.75 })])!;
    expect(one.prevClose).toBeNull();
    expect(one.ltp).toBe(302575);
  });

  it("returns null (not a zero quote) when nothing is stored", () => {
    expect(eodQuoteFromBars(TCS, [])).toBeNull();
  });

  it("keeps open/high/low/volume null when the projection does not carry them", () => {
    const q = eodQuoteFromBars(TCS, [bar({ date: "2026-09-03", close: 10 }), bar({ date: "2026-09-04", close: 11 })])!;
    expect([q.dayOpen, q.dayHigh, q.dayLow, q.volume]).toEqual([null, null, null, null]);
  });
});

describe("isCashKey — the bhavcopy is the CASH market, and only the cash market", () => {
  it("accepts a bare NSE or BSE key", () => {
    expect(isCashKey({ symbol: "TCS", exchange: "NSE" })).toBe(true);
    expect(isCashKey({ symbol: "TCS", exchange: "BSE" })).toBe(true);
    // The tradingsymbol equal to the symbol is how the tracker writes a cash
    // row; case and padding are noise, not a difference.
    expect(isCashKey({ symbol: "TCS", exchange: "NSE", tradingsymbol: " tcs " })).toBe(true);
  });

  it("refuses every derivative exchange", () => {
    for (const exchange of ["NFO", "BFO", "MCX", "CDS"] as const) {
      expect(isCashKey({ symbol: "RELIANCE", exchange }), exchange).toBe(false);
    }
  });

  it("refuses a contract tradingsymbol even when the exchange field says NSE", () => {
    // A mis-tagged exchange is common in imported books; the traded contract
    // is the fact that decides, not the column.
    expect(isCashKey({ symbol: "RELIANCE", exchange: "NSE", tradingsymbol: "RELIANCE26SEP3000CE" })).toBe(false);
  });
});

describe("eodQuoteFromBars refuses a derivative key (M1)", () => {
  it("never prices an option at the underlying's cash close", () => {
    // The bug this pins: the EOD provider looked bars up by key.symbol, so
    // RELIANCE26SEP3000CE was marked at RELIANCE's ₹2,850 close — a ₹285,000
    // paise LTP on a contract worth a fraction of it.
    const key: QuoteKey = { symbol: "RELIANCE", exchange: "NFO", tradingsymbol: "RELIANCE26SEP3000CE" };
    expect(eodQuoteFromBars(key, [bar({ date: "2026-09-04", close: 2850 })])).toBeNull();
  });

  it("still quotes the cash key of the same underlying", () => {
    const key: QuoteKey = { symbol: "RELIANCE", exchange: "NSE" };
    expect(eodQuoteFromBars(key, [bar({ date: "2026-09-04", close: 2850 })])!.ltp).toBe(285000);
  });
});

describe("manualQuoteFromMark", () => {
  it("is a level and nothing else — no fabricated day bar (invariant 6)", () => {
    const q = manualQuoteFromMark(TCS, { price: 3120.4, asOfDate: "2026-09-04" });
    expect(q.ltp).toBe(312040);
    expect(q.staleness).toBe("manual");
    expect(q.source).toBe("manual");
    expect([q.prevClose, q.dayOpen, q.dayHigh, q.dayLow, q.volume]).toEqual([null, null, null, null, null]);
    expect(q.asOf).toBe("2026-09-04T15:30:00+05:30");
  });
});

describe("isWithinLiveWindow — 09:00–15:40 IST, Mon–Fri", () => {
  // 2026-09-04 is a Friday; 03:30Z = 09:00 IST.
  const ist = (utc: string) => new Date(utc);

  it("opens at 09:00 IST and not a minute earlier", () => {
    expect(isWithinLiveWindow(ist("2026-09-04T03:29:00Z"))).toBe(false); // 08:59 IST
    expect(isWithinLiveWindow(ist("2026-09-04T03:30:00Z"))).toBe(true); // 09:00 IST
  });

  it("closes at 15:40 IST and not a minute later", () => {
    expect(isWithinLiveWindow(ist("2026-09-04T10:10:00Z"))).toBe(true); // 15:40 IST
    expect(isWithinLiveWindow(ist("2026-09-04T10:11:00Z"))).toBe(false); // 15:41 IST
  });

  it("is closed at night — including after IST midnight, where a UTC date is a day behind", () => {
    expect(isWithinLiveWindow(ist("2026-09-03T18:30:00Z"))).toBe(false); // 2026-09-04 00:00 IST
    expect(isWithinLiveWindow(ist("2026-09-04T17:00:00Z"))).toBe(false); // 22:30 IST
  });

  it("is closed at the weekend, IST weekend not UTC weekend", () => {
    expect(isWithinLiveWindow(ist("2026-09-05T06:00:00Z"))).toBe(false); // Saturday 11:30 IST
    expect(isWithinLiveWindow(ist("2026-09-06T06:00:00Z"))).toBe(false); // Sunday 11:30 IST
    // Friday 23:00 UTC is Saturday 04:30 IST — the IST day is what counts.
    expect(isWithinLiveWindow(ist("2026-09-04T23:00:00Z"))).toBe(false);
  });

  /**
   * A LISTED EXCHANGE HOLIDAY IS NOT A LIVE WINDOW (v4.2, seam finding).
   *
   * `app/api/live/stream/route.ts` gates BOTH the broker subscription and the
   * frame's `marketOpen` on this one answer. While it was weekday-and-clock
   * only, Republic Day at 10:00 IST answered true: Upstox or Angel One would be
   * polled every few seconds for six and a half hours on a shut exchange, and
   * the desk strip printed "Live" over yesterday's close. `isMarketOpenIst()`
   * (lib/live/market-hours.ts) already said false on the same instant — two
   * doors, two answers, and the polling one was the wrong one.
   *
   * The calendar is asked through `isTradingDayIst()`, the single IST source
   * (`tests/today-clock.test.ts` forbids a second +5:30 derivation).
   */
  it("is closed on a LISTED exchange holiday, at an hour that is otherwise inside the window", () => {
    // 2026-01-26 is a Monday AND Republic Day in lib/data/nse-holidays.json.
    expect(isWithinLiveWindow(ist("2026-01-26T04:30:00Z"))).toBe(false); // 10:00 IST
    // …and the calendar door agrees, so the route can no longer poll a feed
    // that the mark door and the desk clock both call shut.
    expect(isMarketOpenIst(ist("2026-01-26T04:30:00Z"))).toBe(false);
  });

  it("is OPEN on the very next weekday, which is not on the list", () => {
    // 2026-01-27, Tuesday, no holiday: the fix must not close ordinary days.
    expect(isWithinLiveWindow(ist("2026-01-27T04:30:00Z"))).toBe(true); // 10:00 IST
  });

  it("treats an UNCOVERED year as unknown, never as a holiday", () => {
    // The bundled list stops at 2026, so 2027-01-26 (a Tuesday) is unknown —
    // and unknown answers "trading", which is what keeps a stale calendar from
    // silently cancelling every session in January.
    expect(NSE_HOLIDAY_YEAR).toBe(2026);
    expect(isWithinLiveWindow(ist("2027-01-26T04:30:00Z"))).toBe(true); // 10:00 IST
  });
});
