/**
 * PURE mapping from what Vyuha already stores to a `Quote`, plus the IST
 * window that decides whether a provider may be started at all.
 *
 * This file is the pure half of the two server-only providers (`manual.ts`,
 * `eod-bhavcopy.ts`) — the same split as `lib/engine/rates.ts` vs
 * `rates-db.ts` (invariant 2). No DB, no React, no `Date.now()`; the clock is
 * always an argument.
 */
import { istWallClockIso } from "@/lib/domain/trading-day";
import { classOf, closeInstantIso, istClock, liveWindowOn, marketOf } from "@/lib/domain/market-calendar";
import { toPaise, type Exchange, type Quote, type QuoteKey } from "./types";

/** The two CASH segments. Everything else on `Exchange` is a derivative. */
export const CASH_EXCHANGES: readonly Exchange[] = ["NSE", "BSE"];

/**
 * Is this key a cash-market scrip — the only thing a bhavcopy prices?
 *
 * TWO tests, because either alone is porous: the exchange must be a cash
 * segment (NFO/BFO/MCX/CDS never are), AND the traded contract must be the
 * bare symbol. An option carries `symbol: "RELIANCE"` with
 * `tradingsymbol: "RELIANCE26SEP3000CE"`, so a lookup by `symbol` alone marks
 * the contract at the UNDERLYING's cash close — ₹2,850 for a contract worth a
 * fraction of it, and silently wrong everywhere the position is read.
 * `lib/import/mtm-bhavcopy.ts` has skipped derivatives for the same reason
 * since it was written; this is that rule, shared.
 *
 * The error direction is deliberate: a key we cannot classify with certainty
 * gets NO quote and the desk shows its no-mark state (invariant 6). A cash row
 * whose broker writes a decorated tradingsymbol ("RELIANCE-EQ") therefore
 * loses its EOD mark rather than risking a contract priced as a share — the
 * tracker only sets `tradingsymbol` when it differs from `symbol`, so this
 * costs nothing on any book Vyuha writes itself.
 */
export function isCashKey(key: QuoteKey): boolean {
  if (!CASH_EXCHANGES.includes(key.exchange)) return false;
  const contract = (key.tradingsymbol ?? "").trim().toUpperCase();
  return contract === "" || contract === key.symbol.trim().toUpperCase();
}

/** A stored EOD bar, in the shape `lib/queries/price-history.ts` returns it. */
export interface StoredBar {
  date: string;
  open?: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume?: number | null;
}

/** A mark the user typed, as stored in `mtm_prices`. */
export interface StoredMark {
  price: number;
  asOfDate: string;
}

/**
 * The instant an Indian cash session's close price was true — `asOf` is source
 * time, not receipt time (03D §1.2), so the desk can age it honestly at 09:20
 * the next morning.
 *
 * FROM THE MARKET CALENDAR (v4.6.0 W1): a 2026-09-04 bar of an F&O stock is a
 * 15:35 price (its close is struck in the closing auction), of any other stock
 * a 15:30 one, and a 2026-07-31 bar of either a 15:30 one. Without a key the
 * later (CAS) instant is used — the conservative side for "how old is this".
 * A day with no known session hours (a special session not yet bundled) ages
 * from the END of the IST day: the latest the price can have been true.
 */
export function sessionCloseIso(isoDate: string, key?: QuoteKey): string {
  const market = (key && marketOf(key.exchange)) || "NSE_CM";
  const cls = classOf(market, key?.symbol ?? null, isoDate);
  return closeInstantIso(isoDate, market, cls) ?? istWallClockIso(isoDate, "23:59");
}

/**
 * Latest stored bar → an EOD quote. `bars` must be ASCENDING by date, which is
 * what `getBarsMap()` guarantees (SQLite returns rowid order otherwise, and a
 * "latest" taken off rowid order is silently the wrong day).
 *
 * `prevClose` is `null` under two stored sessions: the day-change column must
 * render "—", never a 0 % that looks like a flat day.
 *
 * A DERIVATIVE KEY GETS NOTHING (`isCashKey`), whatever bars it is handed: a
 * bhavcopy row is a cash close, and the caller's bars were fetched by the
 * underlying's symbol.
 */
export function eodQuoteFromBars(key: QuoteKey, bars: readonly StoredBar[]): Quote | null {
  if (!isCashKey(key)) return null;
  if (bars.length === 0) return null;
  const last = bars[bars.length - 1];
  const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
  return {
    key,
    ltp: toPaise(last.close),
    prevClose: prev ? toPaise(prev.close) : null,
    dayOpen: last.open == null ? null : toPaise(last.open),
    dayHigh: last.high == null ? null : toPaise(last.high),
    dayLow: last.low == null ? null : toPaise(last.low),
    volume: last.volume ?? null,
    asOf: sessionCloseIso(last.date, key),
    staleness: "eod",
    source: "eod",
  };
}

/**
 * A typed mark → a manual quote. Nothing about a typed number is a day bar, so
 * open/high/low/volume/prevClose are `null` rather than fabricated from it
 * (invariant 6).
 */
export function manualQuoteFromMark(key: QuoteKey, mark: StoredMark): Quote {
  return {
    key,
    ltp: toPaise(mark.price),
    prevClose: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    volume: null,
    asOf: sessionCloseIso(mark.asOfDate, key),
    staleness: "manual",
    source: "manual",
  };
}

/**
 * May a streaming provider be started right now? A TRADING DAY, inside the
 * window the MARKET CALENDAR derives for it (v4.6.0 W1, R4 rule 3): from the
 * pre-open (09:00) to the day's LAST mark-availability instant — the F&O close
 * plus its margin, 15:45 since 2026-08-03. It used to be a typed 09:00–15:40,
 * and since CAS 15:40 is the derivatives CLOSE itself, which left no margin
 * for its last print (R4 #6).
 *
 * EXCHANGE HOLIDAYS CLOSE THIS WINDOW (v4.2 seam fix): `app/api/live/stream/route.ts`
 * gates the PROVIDER SUBSCRIPTION on this value, so on Republic Day it once
 * polled a shut exchange for six and a half hours while the strip printed
 * "Live". A special Sunday session (Budget day) OPENS it; a special session
 * whose hours are not bundled (Muhurat) has no window — no guessed hours.
 * Past the bundled year a weekday is an UNVERIFIED session, so the desk keeps
 * working in January rather than going silent (`tradingDayStatus`).
 *
 * The other doors a holiday changes stay where they were: `shouldPersistMark()`
 * (lib/quotes/persist-mark.ts) refuses with code `"holiday"`.
 */
export function isWithinLiveWindow(now: Date): boolean {
  const { date, minutes } = istClock(now);
  const w = liveWindowOn(date);
  return w != null && minutes >= w.startMin && minutes <= w.endMin;
}
