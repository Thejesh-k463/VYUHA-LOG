import "server-only";
import { todayIstIso, toIst } from "@/lib/domain/trading-day";
import { isCashKey } from "./mapping";
import { fromPaise, quoteKeyId, type Exchange, type ProviderId, type Quote, type QuoteKey } from "./types";

/**
 * The ONE number the live feed is allowed to write (owner answer Q25:
 * "ticks in memory only, exactly one persisted mark per position per day").
 *
 * A live feed that wrote every tick would turn a journal into a tick database:
 * the file would grow without bound, a backup would carry a day of noise, and
 * every derived figure would silently depend on which second the app happened
 * to be open. So the desk keeps ticks in memory, and at the end of the session
 * the LAST snapshot is persisted once, into the mark path the app already has.
 *
 * WHERE IT WRITES, and why not a new table: `mtm_prices` is Vyuha's existing
 * mark store — written by the risk dialog
 * (`app/api/positions/risk/route.ts:60-65`) and by the bhavcopy apply
 * (`lib/import/mtm-bhavcopy.ts`), read back through `getMtmMap()` with the
 * precedence `mtm[symbol] → mtm[tradingsymbol] → trades.closingPrice`. Writing
 * there means the live mark reaches every position figure in the app without
 * one query changing. (The prompt's `trades.closingPrice` is the LAST rung of
 * that same precedence — an import-time column, not a per-day mark store — so
 * writing it would be both narrower and destructive of import data.)
 *
 * IDEMPOTENCE IS THE ROW, NOT A STAMP (N1). The "already marked" question is
 * asked per (symbol, IST date) row of `mtm_prices` — the exact key the write is
 * made on — and the write itself is a DELETE of (symbol, as_of_date) then one
 * INSERT. `settings.last_live_mark_date` (migration 0067) is kept as the
 * BANNER value (the newest day this machine wrote) and is never a gate:
 * both doors mark only the SELECTED account's open positions
 * (`openPositionKeys()`, invariant 8), so one global stamp meant the first door
 * after 15:30 stamped the day for the whole file and every OTHER account's open
 * positions were told "already saved" and got no mark at all that day.
 *
 * MONEY: `mtm_prices.price` is REAL RUPEES — a per-unit price, the documented
 * exception in invariant 1. Quotes carry paise, so `fromPaise()` converts
 * exactly once, here, at the write edge.
 */

const EXCHANGES: readonly Exchange[] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];

/** Ceiling on one subscription set — the same 500 the SSE route applies. */
export const MAX_POSITION_KEYS = 500;

/**
 * The open positions of the SELECTED account, as provider keys.
 *
 * The SAME rule `app/api/live/stream/route.ts` applies, in a place a second
 * caller can reach: `is_open` is the open predicate (never `sell_date IS
 * NULL`, which is a sort key on this table), the account scope comes from
 * `getTrackerTrades()` (invariant 8), and duplicates collapse on
 * `quoteKeyId()`. The stream route keeps its own copy because it is outside
 * this wave's file set — fold the two together when one wave owns both.
 */
export async function openPositionKeys(): Promise<QuoteKey[]> {
  const { getTrackerTrades } = await import("@/lib/queries/trades");
  const out: QuoteKey[] = [];
  const seen = new Set<string>();
  for (const t of getTrackerTrades()) {
    if (!t.isOpen) continue;
    const raw = (t.exchange ?? "").trim().toUpperCase();
    const key: QuoteKey = {
      symbol: t.symbol.trim().toUpperCase(),
      exchange: (EXCHANGES as readonly string[]).includes(raw) ? (raw as Exchange) : "NSE",
      ...(t.tradingsymbol && t.tradingsymbol !== t.symbol
        ? { tradingsymbol: t.tradingsymbol.trim().toUpperCase() }
        : {}),
    };
    const id = quoteKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
    if (out.length >= MAX_POSITION_KEYS) break;
  }
  return out;
}

/** 15:30 IST. Before the close there is no "day's last price" to persist. */
export const MARK_AFTER_IST_MIN = 15 * 60 + 30;

/**
 * The once-a-day refusal, written ONCE because it is said in two places: here,
 * and again on the waived-clock path in `persistDailyMarks()`.
 */
export const alreadyMarkedReason = (date: string) => `Today's mark is already saved (${date}).`;

/**
 * WHICH rule refused, as a stable value rather than as a sentence.
 *
 * `persistDailyMarks()` has to waive exactly one of these for the "Save today's
 * mark" button, and matching on `reason` would tie that waiver to copy. The
 * code is what a caller branches on; the sentence stays the user's.
 */
export type PersistMarkRefusal = "weekend" | "before-close" | "already-marked";

export interface PersistMarkDecision {
  ok: boolean;
  /** Why it will not run, in the user's words. Empty when it will. */
  reason: string;
  /** The IST day the mark belongs to. */
  date: string;
  /** The rule that refused. null when `ok`. */
  code: PersistMarkRefusal | null;
}

/**
 * PURE. May the day's mark be written right now?
 *
 * Refuses three cases, each for its own reason: a weekend (no session to
 * close), before 15:30 IST (a mid-session price is not the day's close — and
 * persisting one would make "yesterday's close" mean 11:04), and a day that
 * already has its mark. Exchange holidays are not modelled anywhere in this
 * app; on a holiday the feed has nothing to persist, so nothing is written.
 *
 * `lastMarkDate` IS THE CALLER'S OWN FACT, and the signature keeps it because
 * it is still worth asking (the Settings card holds the banner date, and a
 * caller that already knows a set is marked can refuse without touching the
 * database). `persistDailyMarks()` no longer passes the global stamp here: it
 * asks the same question per (symbol, IST date) ROW, because the stamp is one
 * value for a file that holds many accounts (N1).
 */
export function shouldPersistMark(now: Date, lastMarkDate: string | null | undefined): PersistMarkDecision {
  const date = todayIstIso(now);
  const ist = toIst(now); // IST wall-clock lands in the UTC fields
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) {
    return { ok: false, reason: "It is the weekend — there is no session to close.", date, code: "weekend" };
  }
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes < MARK_AFTER_IST_MIN) {
    return {
      ok: false,
      reason: "The session has not closed yet. The live mark is written once, from the last price of the day.",
      date,
      code: "before-close",
    };
  }
  if (lastMarkDate === date) {
    return { ok: false, reason: alreadyMarkedReason(date), date, code: "already-marked" };
  }
  return { ok: true, reason: "", date, code: null };
}

export interface PersistMarkResult {
  written: boolean;
  /** Positions marked. 0 with `written: false` when nothing was persisted. */
  marked: number;
  reason: string;
  date: string;
  /** The rule that refused, when one did — the same names `shouldPersistMark()` uses. */
  code?: PersistMarkRefusal | null;
}

export interface PersistMarkOptions {
  now?: Date;
  /**
   * Skip the clock half of the guard (never the once-a-day half). For the
   * "mark now" button: the user asking is a better reason than 15:30, and the
   * one-mark-per-day rule still holds.
   */
  ignoreClock?: boolean;
}

/**
 * Persist the day's last snapshot as ONE mark per position.
 *
 * `quotes` is the snapshot the caller already has in memory — this function
 * never fetches, so it cannot be the thing that makes a network call at 15:30
 * on a machine whose feed is off.
 */
export async function persistDailyMarks(
  quotes: Iterable<Quote>,
  opts: PersistMarkOptions = {},
): Promise<PersistMarkResult> {
  const now = opts.now ?? new Date();
  const { db } = await import("@/lib/db");
  const { settings, mtmPrices } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");

  const row = db
    .select({ id: settings.id, lastLiveMarkDate: settings.lastLiveMarkDate })
    .from(settings)
    .limit(1)
    .all()[0];
  if (!row) return { written: false, marked: 0, reason: "No settings row.", date: todayIstIso(now) };

  // `null`, not the stamp: the day guard is the ROW, decided per symbol below
  // (N1). What is asked here is the pure half — the weekend and the clock.
  const decision = shouldPersistMark(now, null);
  const date = decision.date;
  if (!decision.ok) {
    // The once-a-day rule is never waived; the CLOCK is, on request, and
    // nothing else (M1).
    //
    // `ignoreClock` used to be a blanket fall-through, which waived the WEEKEND
    // refusal too — `shouldPersistMark()` reports it through the same
    // `ok: false`. A Saturday press then wrote a mark dated Saturday, and every
    // "yesterday's close" read through `getMtmMap()` resolved to a day the
    // market never traded. The waiver is now named: only `before-close`.
    const waived = opts.ignoreClock === true && decision.code === "before-close";
    if (!waived) return { written: false, marked: 0, reason: decision.reason, date, code: decision.code };
  }

  // One row per POSITION per day: keyed on (symbol, as_of_date), delete then
  // insert. A price of zero or less is refused rather than stored — a mark of
  // zero would print a -100 % position (invariant 6).
  //
  // DERIVATIVES ARE SKIPPED, not written under the underlying (`isCashKey()`,
  // the same rule the EOD provider applies): the write below is keyed on
  // `q.key.symbol` and `getMtmMap()` reads `mtm[symbol]` FIRST, so a contract
  // mark would price the cash position at the option's price — and its
  // delete-then-insert would take the cash mark of the day with it. A feed
  // that can quote NFO (v4.1) therefore leaves the journal alone until a mark
  // store keyed on the traded contract exists.
  const usable = [...quotes].filter((q) => q.ltp > 0 && isCashKey(q.key));
  if (usable.length === 0) {
    return { written: false, marked: 0, reason: "The feed had no usable price to save.", date };
  }

  // THE ONCE-A-DAY RULE, ASKED PER ROW (N1). A symbol that already holds
  // today's mark is skipped — a second connect, a second window and a second
  // press all change nothing — and the symbols that do NOT are written, which
  // is what makes the second account of the day get its mark at all. It is
  // also what stops a live print from overwriting a mark the user typed into
  // the risk dialog today: whoever wrote the row first, keeps it.
  //
  // THE ASYMMETRY IS DELIBERATE (owner ruling, v4.1 fix wave 3). This door
  // skips a held row; the TYPED doors (`writeTypedMark()` in
  // `lib/queries/mtm.ts`, used by the risk dialog and the bulk MTM paste)
  // delete-then-insert and replace one. So a mark typed BEFORE the close
  // survives the automatic write, and a mark typed AFTER it wins — which is
  // what "a typed mark is always the day's mark" means. Neither door needs a
  // reader-side tiebreak, and none was added: `getMtmMap()` and every other
  // readers still take the first row of the newest `as_of_date`, which is now
  // the only row for it.
  let marked = 0;
  db.transaction((tx) => {
    for (const q of usable) {
      const symbol = q.key.symbol.trim().toUpperCase();
      const held = tx
        .select({ id: mtmPrices.id })
        .from(mtmPrices)
        .where(and(eq(mtmPrices.symbol, symbol), eq(mtmPrices.asOfDate, date)))
        .limit(1)
        .all()[0];
      if (held) continue;
      // Delete-then-insert stays even though the SELECT above says there is
      // nothing to delete: it costs nothing, and it is what keeps "one row per
      // symbol per day" true if a duplicate pair ever reached this table by
      // another road (the SELECT would only ever see one of them).
      tx.delete(mtmPrices).where(and(eq(mtmPrices.symbol, symbol), eq(mtmPrices.asOfDate, date))).run();
      tx.insert(mtmPrices)
        .values({
          symbol,
          tradingsymbol: (q.key.tradingsymbol ?? q.key.symbol).trim().toUpperCase(),
          price: fromPaise(q.ltp),
          asOfDate: date,
        })
        .run();
      marked++;
    }
    // The BANNER value, and only that: the newest day this file has written.
    // Never moved backwards, and never written on a day that wrote no row.
    if (marked > 0 && (!row.lastLiveMarkDate || row.lastLiveMarkDate < date)) {
      tx.update(settings).set({ lastLiveMarkDate: date }).where(eq(settings.id, row.id)).run();
    }
  });

  if (marked === 0) {
    return { written: false, marked: 0, reason: alreadyMarkedReason(date), date, code: "already-marked" };
  }

  const { recordAudit } = await import("@/lib/audit");
  recordAudit({
    entity: "settings",
    action: "update",
    summary: `live feed mark — ${marked} position${marked === 1 ? "" : "s"} marked to the day's last price @ ${date}`,
    source: "openalgo",
  });

  return { written: true, marked, reason: `Saved ${marked} mark${marked === 1 ? "" : "s"} for ${date}.`, date };
}

/* ─────────────────────── the AUTOMATIC half of the mark ─────────────────── */

/**
 * PURE. May this provider's prints become the day's persisted mark?
 *
 * TWO CONDITIONS, and the second is not obvious:
 *
 *   1. THE PROVIDER STREAMS. The end-of-day and typed-marks providers have no
 *      "last price of the session" to catch: the bhavcopy IS yesterday's close
 *      and a typed mark is already in `mtm_prices`. Marking from either would
 *      copy a row onto itself under today's date.
 *   2. IT IS NOT THE MOCK. `mock` is a deterministic seeded walk — the provider
 *      vitest and e2e pin through `VYUHA_QUOTE_PROVIDER` and
 *      `settings.live_feed_provider`. Its capability block says `streaming:
 *      true` because `subscribe()` really emits, so condition 1 alone would let
 *      a fixture price be written into the user's journal by any run that
 *      happened to fall after 15:30 IST on a weekday. A generated number is not
 *      a mark (invariant 6), and a test run must not move the book it asserts
 *      against.
 */
export function providerMayAutoMark(capabilities: { id: ProviderId; streaming: boolean }): boolean {
  return capabilities.streaming && capabilities.id !== "mock";
}

/**
 * Persist the day's mark from a snapshot the caller ALREADY has — the automatic
 * half of owner answer Q25, which had no caller at all before this wave.
 *
 * `persistDailyMarks()` shipped in v4.1 with exactly one caller: the "Save
 * today's mark" button. So the promised "one mark per position per day, from
 * the last price of the session" only ever happened when a user pressed a
 * button on the Settings card — the Settings copy, the disclosure and PRIVACY
 * all describe it as automatic.
 *
 * TWO CALL SITES, ONE OUTCOME. The SSE route calls this on connect and
 * `components/live/load-desk.ts` calls it on the desk's server render;
 * whichever runs first writes each open symbol's row for the IST day, and that
 * per-(symbol, day) row makes the other a no-op the same day (the stamp is
 * display-only, never the gate). Neither passes `ignoreClock`: the automatic path
 * IS the 15:30 rule.
 *
 * NEVER THROWS. It is called on the path that renders the desk and on the path
 * that opens the stream; a failed write must cost the mark, never the screen.
 * `null` means "not attempted".
 */
export async function catchUpDailyMark(
  capabilities: { id: ProviderId; streaming: boolean },
  quotes: Iterable<Quote>,
  opts: { now?: Date } = {},
): Promise<PersistMarkResult | null> {
  if (!providerMayAutoMark(capabilities)) return null;
  try {
    return await persistDailyMarks(quotes, opts.now ? { now: opts.now } : {});
  } catch {
    return null;
  }
}
