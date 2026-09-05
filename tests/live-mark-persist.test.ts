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

  it("holds ONE row per (symbol, day) even with the stamp lost — delete, then insert", async () => {
    // The second guard on its own: a restored or blanked stamp must not be
    // able to leave two marks for one position on one day.
    t.db.update(t.schema.settings).set({ lastLiveMarkDate: null }).run();
    const r = await persist.persistDailyMarks([quote("TCS", 3040.5)], { now: AFTER_CLOSE });
    expect(r.written).toBe(true);
    const rows = marks().filter((m) => m.symbol === "TCS" && m.asOfDate === "2026-09-04");
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(3040.5);
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
