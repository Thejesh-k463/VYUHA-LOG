import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, tradeRow, type TempDb } from "./helpers/temp-db";
import { MARK_AFTER_IST_MIN, shouldPersistMark } from "@/lib/quotes/persist-mark";
import { toPaise, type Quote, type QuoteKey } from "@/lib/quotes/types";

/**
 * The ONE number a live feed may write (owner answer Q25: "ticks in memory
 * only, exactly one persisted mark per position per day").
 *
 * Three properties are under test, and each one is a way the journal could be
 * corrupted by a feed that ran all day:
 *
 *   1. RUPEES AT THE WRITE EDGE. Quotes carry paise; `mtm_prices.price` is a
 *      REAL per-unit price in rupees (invariant 1's documented exception). A
 *      missing conversion here would store 302575 as the price of a ₹3,025.75
 *      share and print a 10,000 % gain everywhere the mark is read.
 *   2. ONCE A DAY, TWICE OVER. The `settings.last_live_mark_date` stamp AND
 *      the delete-then-insert on (symbol, as_of_date). Either alone would let
 *      a second click, a second window or a restored stamp produce two marks
 *      for one position on one day.
 *   3. NO MID-SESSION MARK. 11:04's price is not "the close", and persisting
 *      one silently redefines every "yesterday's close" the app prints. The
 *      "Save today's mark" button may waive the CLOCK (the user asking is a
 *      better reason than 15:30) but never the once-a-day rule.
 *
 * ONE temp database for the whole file: `lib/db` caches its connection on
 * globalThis, so a second `openTempDb()` here would silently reuse the first.
 * `@/lib/quotes/persist-mark`'s db access is lazy, so the static import above
 * (pure functions only) cannot bind the connection before the helper runs.
 */

let t: TempDb;
let persist: typeof import("@/lib/quotes/persist-mark");

const SWING = 2;
const LONG_TERM = 3;

/** Friday 2026-09-04, 16:00 IST — after the 15:30 close. */
const AFTER_CLOSE = new Date("2026-09-04T10:30:00Z");
/** Friday 2026-09-04, 11:04 IST — mid-session. */
const MID_SESSION = new Date("2026-09-04T05:34:00Z");
/** Saturday 2026-09-05, 16:00 IST. */
const WEEKEND = new Date("2026-09-05T10:30:00Z");
/**
 * FRIDAY 2026-10-02, 16:30 IST — Mahatma Gandhi Jayanti, on NSE's own CM
 * trading list and now on the bundled one (`lib/data/nse-holidays.json`).
 *
 * A WEEKDAY, which is the whole of the F1 defect: both automatic doors fired
 * here before v4.2 and wrote the bridge's last print — the PREVIOUS session's
 * close — into `mtm_prices` dated to a day the exchange never opened.
 */
const HOLIDAY = new Date("2026-10-02T11:00:00Z");

function quote(symbol: string, rupees: number, over: Partial<Quote> = {}): Quote {
  const key: QuoteKey = { symbol, exchange: "NSE" };
  return {
    key,
    ltp: toPaise(rupees),
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf: AFTER_CLOSE.toISOString(),
    staleness: "delayed",
    source: "openalgo",
    ...over,
  };
}

function marks() {
  return t.db.select().from(t.schema.mtmPrices).all();
}

function stamp(): string | null {
  return t.db.select().from(t.schema.settings).limit(1).all()[0]?.lastLiveMarkDate ?? null;
}

function clearStamp() {
  t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
  t.sqlite.prepare("DELETE FROM mtm_prices").run();
}

beforeAll(async () => {
  t = await openTempDb("live-mark", { seed: true });
  persist = await import("@/lib/quotes/persist-mark");
  await import("@/lib/queries/trades");

  t.db.insert(t.schema.accounts).values([{ id: SWING, name: "Swing" }, { id: LONG_TERM, name: "Long term" }]).run();
  t.db
    .insert(t.schema.trades)
    .values([
      tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 10, avgBuyPrice: 3000 }),
      // Same scrip a second time: two lots are one position to a feed.
      tradeRow({ accountId: SWING, symbol: "TCS", tradingsymbol: "TCS", isOpen: true, buyQty: 5, avgBuyPrice: 3100 }),
      tradeRow({ accountId: SWING, symbol: "WIPRO", tradingsymbol: "WIPRO", isOpen: false, buyQty: 5, sellQty: 5 }),
      tradeRow({ accountId: LONG_TERM, symbol: "INFY", tradingsymbol: "INFY", isOpen: true, buyQty: 8, avgBuyPrice: 1400 }),
    ])
    .run();
});

afterAll(() => t?.cleanup());

describe("shouldPersistMark — PURE, and refuses three cases for three reasons", () => {
  it("refuses the weekend: there is no session to close", () => {
    const d = shouldPersistMark(WEEKEND, null);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/weekend/i);
    expect(d.date).toBe("2026-09-05");
  });

  it("refuses mid-session: a price at 11:04 is not the day's close", () => {
    const d = shouldPersistMark(MID_SESSION, null);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/has not closed yet/i);
  });

  it("refuses a day that already has its mark, and says which day", () => {
    const d = shouldPersistMark(AFTER_CLOSE, "2026-09-04");
    expect(d.ok).toBe(false);
    expect(d.reason).toContain("2026-09-04");
  });

  it("allows it after 15:30 IST on a weekday that has no mark yet", () => {
    expect(MARK_AFTER_IST_MIN).toBe(15 * 60 + 30);
    const d = shouldPersistMark(AFTER_CLOSE, "2026-09-03");
    expect(d.ok).toBe(true);
    expect(d.reason).toBe("");
    expect(d.date).toBe("2026-09-04");
  });

  /**
   * The refusals are NAMED, not only worded (FW-1).
   *
   * `persistDailyMarks()` has to waive exactly one of them for the button and
   * no other, and matching on the sentence would make the waiver depend on
   * copy. The code is what the caller branches on; the sentence stays the
   * user's.
   */
  it("refuses a LISTED EXCHANGE HOLIDAY, and says which day it was (F1)", () => {
    const d = shouldPersistMark(HOLIDAY, null);
    expect(d.ok, "a weekday holiday must not be markable").toBe(false);
    expect(d.code).toBe("holiday");
    expect(d.date).toBe("2026-10-02");
    expect(d.reason).toBe("The exchange was closed for Mahatma Gandhi Jayanti — there is no session to close.");
  });

  it("still allows the weekday BEFORE and AFTER that holiday — the calendar refuses one day, not a week", () => {
    // Thu 2026-10-01, 16:30 IST, and Mon 2026-10-05, 16:30 IST.
    expect(shouldPersistMark(new Date("2026-10-01T11:00:00Z"), null).ok).toBe(true);
    expect(shouldPersistMark(new Date("2026-10-05T11:00:00Z"), null).ok).toBe(true);
  });

  it("names which rule refused, so a caller can waive one and only one", () => {
    expect(shouldPersistMark(WEEKEND, null).code).toBe("weekend");
    expect(shouldPersistMark(HOLIDAY, null).code).toBe("holiday");
    expect(shouldPersistMark(MID_SESSION, null).code).toBe("before-close");
    expect(shouldPersistMark(AFTER_CLOSE, "2026-09-04").code).toBe("already-marked");
    expect(shouldPersistMark(AFTER_CLOSE, null).code).toBeNull();
  });
});

describe("openPositionKeys — the SELECTED account's open positions, once each", () => {
  it("takes only open rows of the selected account, and collapses two lots into one key", async () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
    const keys = await persist.openPositionKeys();
    expect(keys.map((k) => k.symbol)).toEqual(["TCS"]);
    expect(keys[0].exchange).toBe("NSE");
  });

  it("follows the account switch (invariant 8) rather than caching the first book", async () => {
    t.db.update(t.schema.settings).set({ selectedAccountId: LONG_TERM }).run();
    expect((await persist.openPositionKeys()).map((k) => k.symbol)).toEqual(["INFY"]);
    t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
  });
});

describe("persistDailyMarks — rupees, once a day, never mid-session", () => {
  it("writes the price in RUPEES, converting from paise exactly once", async () => {
    clearStamp();
    const r = await persist.persistDailyMarks([quote("TCS", 3025.75)], { now: AFTER_CLOSE });
    expect(r.written).toBe(true);
    expect(r.marked).toBe(1);
    const rows = marks();
    expect(rows).toHaveLength(1);
    // 3025.75, NOT 302575 — the paise the quote carries would print a
    // 10,000 % position if it reached mtm_prices unconverted.
    expect(rows[0].price).toBe(3025.75);
    expect(rows[0].symbol).toBe("TCS");
    expect(rows[0].asOfDate).toBe("2026-09-04");
    expect(stamp()).toBe("2026-09-04");
  });

  it("does nothing at all the second time on the same IST day", async () => {
    const r = await persist.persistDailyMarks([quote("TCS", 9999)], { now: AFTER_CLOSE });
    expect(r.written).toBe(false);
    expect(r.marked).toBe(0);
    expect(r.reason).toContain("already saved");
    // The stale price never reached the journal.
    expect(marks().map((m) => m.price)).toEqual([3025.75]);
  });

  it("holds ONE row per (symbol, day) even with the stamp lost — the ROW is the guard (N1)", async () => {
    // The stamp is a BANNER value, not the rule: a blanked or restored stamp
    // (another machine's backup, a fresh install reading the same journal)
    // must not be able to leave two marks for one position on one day, nor
    // overwrite the price already written for it.
    //
    // Until N1 this same call answered `written: true` and rewrote the row,
    // because the stamp was the gate and the stamp was gone.
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
    const r = await persist.persistDailyMarks([quote("TCS", 3040.5)], { now: AFTER_CLOSE });
    expect(r.written).toBe(false);
    expect(r.code).toBe("already-marked");
    const rows = marks().filter((m) => m.symbol === "TCS" && m.asOfDate === "2026-09-04");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3025.75);
  });

  it("refuses mid-session unless the user asked — and then still only once a day", async () => {
    clearStamp();
    const refused = await persist.persistDailyMarks([quote("TCS", 3000)], { now: MID_SESSION });
    expect(refused.written).toBe(false);
    expect(refused.reason).toMatch(/has not closed yet/i);
    expect(marks()).toHaveLength(0);

    // The button waives the CLOCK…
    const asked = await persist.persistDailyMarks([quote("TCS", 3000)], { now: MID_SESSION, ignoreClock: true });
    expect(asked.written).toBe(true);
    // …and never the once-a-day rule.
    const again = await persist.persistDailyMarks([quote("TCS", 3111)], { now: MID_SESSION, ignoreClock: true });
    expect(again.written).toBe(false);
    expect(again.reason).toContain("already saved");
    expect(marks().map((m) => m.price)).toEqual([3000]);
  });

  /**
   * M1 — `ignoreClock` waived MORE than the clock.
   *
   * Its own contract (`PersistMarkOptions.ignoreClock`) says "skip the clock
   * half of the guard (never the once-a-day half)", and the code checked the
   * day rule by hand and then fell through on `!opts.ignoreClock` — which
   * waived the WEEKEND refusal as well, because `shouldPersistMark()` reports
   * it through the same `ok:false`. A Saturday press of "Save today's mark"
   * therefore wrote a mark dated Saturday into `mtm_prices`, and every
   * "yesterday's close" read through `getMtmMap()` then resolved to a day the
   * market never traded.
   */
  it("refuses the WEEKEND even when the user asks — ignoreClock waives the clock, nothing else", async () => {
    clearStamp();
    const asked = await persist.persistDailyMarks([quote("TCS", 3025.75)], { now: WEEKEND, ignoreClock: true });
    expect(asked.written, "a Saturday press must refuse").toBe(false);
    expect(asked.reason).toMatch(/weekend/i);
    expect(marks(), "no mark may be dated to a day with no session").toHaveLength(0);
    // And the refusal must not stamp the day either, or Monday is blocked too.
    expect(stamp()).toBe(null);
  });

  /**
   * F1 — THE BUG THIS WAVE FIXES, driven through the real write.
   *
   * A holiday is a weekday, so `shouldPersistMark()` said yes, the catch-up
   * door and the 15:31 close door both fired, and the price they had was the
   * PREVIOUS session's close (the bridge quotes nothing on a shut exchange).
   * That row then WAS "the close of 2026-10-02" to `getMtmMap()` and to every
   * unrealised-P&L figure downstream, for a session that never happened.
   */
  it("writes NOTHING on a listed exchange holiday, and the button cannot waive it either (F1)", async () => {
    clearStamp();
    const auto = await persist.persistDailyMarks([quote("TCS", 3025.75)], { now: HOLIDAY });
    expect(auto.written, "a mark dated to a day the exchange was shut").toBe(false);
    expect(auto.code).toBe("holiday");
    expect(auto.date).toBe("2026-10-02");
    expect(marks(), "no row may be dated to a non-session day").toHaveLength(0);

    // `ignoreClock` waives the CLOCK and nothing else — the same rule that
    // already protects the weekend.
    const asked = await persist.persistDailyMarks([quote("TCS", 3025.75)], { now: HOLIDAY, ignoreClock: true });
    expect(asked.written).toBe(false);
    expect(asked.code).toBe("holiday");
    expect(marks()).toHaveLength(0);
    // …and a refusal must not stamp the day, or the next session is blocked.
    expect(stamp()).toBe(null);
  });

  it("the AUTOMATIC door (catchUpDailyMark) is refused on that holiday too, and writes on the next session", async () => {
    clearStamp();
    const caps = { id: "openalgo" as const, streaming: true };
    const onHoliday = await persist.catchUpDailyMark(caps, [quote("TCS", 3025.75)], { now: HOLIDAY });
    expect(onHoliday?.written).toBe(false);
    expect(onHoliday?.code).toBe("holiday");
    expect(marks()).toHaveLength(0);

    // Monday 2026-10-05, 16:30 IST — an ordinary session, and the same door
    // writes. The calendar closes one day; it does not switch the feature off.
    const next = await persist.catchUpDailyMark(caps, [quote("TCS", 3025.75)], {
      now: new Date("2026-10-05T11:00:00Z"),
    });
    expect(next?.written).toBe(true);
    expect(marks().map((m) => [m.symbol, m.asOfDate])).toEqual([["TCS", "2026-10-05"]]);
    clearStamp();
  });

  it("never persists a zero or negative price — a mark of zero prints -100 %", async () => {
    clearStamp();
    const r = await persist.persistDailyMarks([quote("TCS", 0), quote("INFY", -5)], { now: AFTER_CLOSE });
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/no usable price/i);
    expect(marks()).toHaveLength(0);
    // Refusing is not the same as stamping the day: tomorrow's mark must not
    // be blocked by a day that wrote nothing.
    expect(stamp()).toBe(null);
  });

  it("never writes a derivative's price under the underlying's symbol (M1)", async () => {
    clearStamp();
    // `mtm_prices` is keyed on the SYMBOL, and `getMtmMap()` reads
    // mtm[symbol] first — so a contract mark written here would price the
    // cash position at the option's ₹285. The cash quote in the same batch is
    // written; the contract is skipped, and the row it would have clobbered
    // still holds the cash close.
    const option = quote("RELIANCE", 285, {
      key: { symbol: "RELIANCE", exchange: "NFO", tradingsymbol: "RELIANCE26SEP3000CE" },
    });
    const r = await persist.persistDailyMarks([quote("RELIANCE", 2850), option], { now: AFTER_CLOSE });
    expect(r.marked).toBe(1);
    const rows = marks();
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("RELIANCE");
    expect(rows[0].price).toBe(2850);
  });

  it("writes nothing at all when every quote is a derivative", async () => {
    clearStamp();
    const option = quote("RELIANCE", 285, {
      key: { symbol: "RELIANCE", exchange: "NFO", tradingsymbol: "RELIANCE26SEP3000CE" },
    });
    const r = await persist.persistDailyMarks([option], { now: AFTER_CLOSE });
    expect(r.written).toBe(false);
    expect(marks()).toHaveLength(0);
    // A day that wrote nothing must not be stamped, or tomorrow is blocked too.
    expect(stamp()).toBe(null);
  });

  it("marks every usable position in one transaction and leaves an audit line", async () => {
    clearStamp();
    const r = await persist.persistDailyMarks([quote("TCS", 3025.75), quote("INFY", 1499.9)], { now: AFTER_CLOSE });
    expect(r.marked).toBe(2);
    expect(marks().map((m) => m.symbol).sort()).toEqual(["INFY", "TCS"]);
    const audit = t.sqlite
      .prepare("SELECT summary, source FROM audit_log WHERE summary LIKE '%live feed mark%' ORDER BY id DESC LIMIT 1")
      .get() as { summary: string; source: string } | undefined;
    expect(audit?.summary).toContain("2 positions marked");
    expect(audit?.source).toBe("openalgo");
  });
});

/**
 * N1 — TWO ACCOUNTS, ONE DAY.
 *
 * `settings.last_live_mark_date` is ONE global stamp, while both doors mark
 * only the SELECTED account's open positions (`openPositionKeys()` is scoped by
 * `getSelectedAccountId()`, invariant 8). So the first door to run after 15:30
 * stamped the day for the whole file, and every OTHER account's open positions
 * were then told "already saved" and got no automatic mark at all that day —
 * silently, and for as long as the two books were used on the same machine.
 *
 * The rule is per (symbol, IST date) ROW in `mtm_prices`, which is the thing
 * the write is actually keyed on. The stamp survives as the banner's "last
 * saved mark" value (the newest day written), never as a gate.
 */
describe("two accounts on one day — the ROW is the once-a-day rule, not one global stamp (N1)", () => {
  const doorFor = async (accountId: number, price: number) => {
    t.db.update(t.schema.settings).set({ selectedAccountId: accountId }).run();
    const keys = await persist.openPositionKeys();
    return { keys, result: await persist.persistDailyMarks(keys.map((k) => quote(k.symbol, price)), { now: AFTER_CLOSE }) };
  };

  it("marks the second account too, after the first account has been marked the same day", async () => {
    clearStamp();

    const a = await doorFor(SWING, 3025.75);
    expect(a.keys.map((k) => k.symbol)).toEqual(["TCS"]);
    expect(a.result.written).toBe(true);
    expect(stamp()).toBe("2026-09-04");

    // The account switch, and the door runs again. Under the global stamp this
    // came back `written: false` — "Today's mark is already saved" — and the
    // Long term book carried no mark for the day at all.
    const b = await doorFor(LONG_TERM, 1499.9);
    expect(b.keys.map((k) => k.symbol)).toEqual(["INFY"]);
    expect(b.result.written, "the other account's open positions got no mark for the day").toBe(true);
    expect(b.result.marked).toBe(1);

    expect(marks().map((m) => [m.symbol, m.price]).sort()).toEqual([
      ["INFY", 1499.9],
      ["TCS", 3025.75],
    ]);
  });

  it("and running BOTH doors a second time writes nothing more — one row per symbol per day", async () => {
    const a = await doorFor(SWING, 9999);
    expect(a.result.written).toBe(false);
    expect(a.result.reason).toContain("already saved");
    const b = await doorFor(LONG_TERM, 8888);
    expect(b.result.written).toBe(false);
    expect(b.result.reason).toContain("already saved");

    // The stale prices never reached the journal, and there is still exactly
    // one row per symbol for the day.
    expect(marks().map((m) => [m.symbol, m.price]).sort()).toEqual([
      ["INFY", 1499.9],
      ["TCS", 3025.75],
    ]);
    expect(stamp()).toBe("2026-09-04");
    t.db.update(t.schema.settings).set({ selectedAccountId: SWING }).run();
  });
});
