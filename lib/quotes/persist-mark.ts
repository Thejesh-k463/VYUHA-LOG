import "server-only";
import { todayIstIso, toIst } from "@/lib/domain/trading-day";
import { fromPaise, quoteKeyId, type Exchange, type Quote, type QuoteKey } from "./types";

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
 * IDEMPOTENCE, TWICE OVER:
 *   1. `settings.last_live_mark_date` (migration 0067) — a second call on the
 *      same IST day does nothing at all;
 *   2. the write itself is a DELETE of (symbol, as_of_date) then one INSERT,
 *      so even with the stamp lost or restored from another machine, one
 *      position can hold at most one live mark per day.
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

export interface PersistMarkDecision {
  ok: boolean;
  /** Why it will not run, in the user's words. Empty when it will. */
  reason: string;
  /** The IST day the mark belongs to. */
  date: string;
}

/**
 * PURE. May the day's mark be written right now?
 *
 * Refuses three cases, each for its own reason: a weekend (no session to
 * close), before 15:30 IST (a mid-session price is not the day's close — and
 * persisting one would make "yesterday's close" mean 11:04), and a day that
 * already has its mark. Exchange holidays are not modelled anywhere in this
 * app; on a holiday the feed has nothing to persist, so nothing is written.
 */
export function shouldPersistMark(now: Date, lastMarkDate: string | null | undefined): PersistMarkDecision {
  const date = todayIstIso(now);
  const ist = toIst(now); // IST wall-clock lands in the UTC fields
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) {
    return { ok: false, reason: "It is the weekend — there is no session to close.", date };
  }
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (minutes < MARK_AFTER_IST_MIN) {
    return {
      ok: false,
      reason: "The session has not closed yet. The live mark is written once, from the last price of the day.",
      date,
    };
  }
  if (lastMarkDate === date) {
    return { ok: false, reason: alreadyMarkedReason(date), date };
  }
  return { ok: true, reason: "", date };
}

export interface PersistMarkResult {
  written: boolean;
  /** Positions marked. 0 with `written: false` when nothing was persisted. */
  marked: number;
  reason: string;
  date: string;
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

  const decision = shouldPersistMark(now, row.lastLiveMarkDate);
  const date = decision.date;
  if (!decision.ok) {
    // The once-a-day rule is never waived; the clock is, on request.
    //
    // ORDER MATTERS IN THE ANSWER, not just in the outcome: shouldPersistMark()
    // reports the clock first, so a second press of "Save today's mark" at
    // 11:04 would be told "the session has not closed yet" — true, and not the
    // reason it was refused. The day guard is therefore checked here on its
    // own, so the message the user reads is the rule that actually stopped it.
    if (row.lastLiveMarkDate === date) {
      return { written: false, marked: 0, reason: alreadyMarkedReason(date), date };
    }
    if (!opts.ignoreClock) return { written: false, marked: 0, reason: decision.reason, date };
  }

  // One row per POSITION per day: keyed on (symbol, as_of_date), delete then
  // insert. A price of zero or less is refused rather than stored — a mark of
  // zero would print a -100 % position (invariant 6).
  const usable = [...quotes].filter((q) => q.ltp > 0);
  if (usable.length === 0) {
    return { written: false, marked: 0, reason: "The feed had no usable price to save.", date };
  }

  let marked = 0;
  db.transaction((tx) => {
    for (const q of usable) {
      const symbol = q.key.symbol.trim().toUpperCase();
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
    tx.update(settings).set({ lastLiveMarkDate: date }).where(eq(settings.id, row.id)).run();
  });

  const { recordAudit } = await import("@/lib/audit");
  recordAudit({
    entity: "settings",
    action: "update",
    summary: `live feed mark — ${marked} position${marked === 1 ? "" : "s"} marked to the day's last price @ ${date}`,
    source: "openalgo",
  });

  return { written: true, marked, reason: `Saved ${marked} mark${marked === 1 ? "" : "s"} for ${date}.`, date };
}
