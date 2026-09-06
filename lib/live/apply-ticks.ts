import { ppmTrunc } from "./tracker-row";
import { ATR_SCALE, type AtrP3, type Paise, type Ppm, type Side, type Staleness } from "./types";
import { quoteKeyId, type Exchange } from "@/lib/quotes/types";

/**
 * Fold an SSE frame's quotes into the desk's rows — PURE, in memory, never a write.
 *
 * WHY IT IS A MODULE AND NOT A HANDLER. `app/api/live/stream/route.ts` has
 * shipped since v4.0 and NOTHING consumed it: `tracker-client.tsx` held no
 * `EventSource`, so with a streaming provider selected the desk's prices moved
 * only on a server render, while the OpenAlgo disclosure (items 2 and 5),
 * PRIVACY item 3, the help page and the Settings slider all describe a 1–5 s
 * refresh "while the Live Desk is open". The consumer is the fix; this file is
 * the arithmetic half of it, kept pure so the numbers can be asserted from a
 * fixture instead of from a browser.
 *
 * THE ONE RULE THAT MATTERS HERE (owner ruling Q25, invariant 7): a tick may
 * only RE-COMPUTE a figure the wire already carries. Never invent one.
 *   • A free wire ships `riskAtStopP`, `riskAmountP`, `openRPpm` and
 *     `pctOfCapital` as null — nulled at the paywall boundary in
 *     `load-desk.ts` — but it still ships `effectiveStopP`, because the stop is
 *     the user's own record. Re-deriving `riskAtStopP = investedP − qty × stop`
 *     from those free fields would hand a free reader the exact Pro figure the
 *     server had just stripped. So a null stays null: `riskAtStopP` and
 *     `pctOfCapital` are CARRIED THROUGH untouched, and `openRPpm` is computed
 *     only when `riskAmountP` is non-null.
 *   • That carry-through is also correct on its own terms: risk at stop is a
 *     property of the LEVEL, not of the mark (`tracker-row.ts`), so a tick
 *     cannot move it. Portfolio heat is a function of `riskAtStopP` and
 *     `investedP` alone (`heat.ts`), so heat and concentration are invariant
 *     under ticks too and are deliberately NOT recomputed by the client.
 *
 * MONEY (invariant 1): every field in and out is integer paise; percentages are
 * ppm integers through the same `ppmTrunc` the server row used. Nothing here
 * sees a rupee.
 *
 * NULL IS A VALUE (invariant 6): a quote with `ltp <= 0` is DROPPED rather than
 * applied — a mark of zero prints a −100 % position — and a tick for a symbol
 * the desk does not hold is ignored rather than appended as a phantom row.
 */

/** The quote fields a frame must carry for a tick to be applied. */
export interface TickQuote {
  key: { symbol: string; exchange: Exchange; tradingsymbol?: string };
  ltp: Paise;
  /** The session's previous close, when the provider sends one. */
  prevClose: Paise | null;
  /** When the price was TRUE AT THE SOURCE — not when the browser received it. */
  asOf: string;
  staleness: Staleness;
}

/** Keyed by `quoteKeyId()` — the SAME key the route and the provider use. */
export type TickMap = ReadonlyMap<string, TickQuote>;

/**
 * The slice of a desk row this module reads and rewrites.
 *
 * Structural, and generic at the call site, so `DeskRow[]` goes in and
 * `DeskRow[]` comes out with `accountName`, `spark`, `stop` and the rest
 * untouched — and so this pure module never has to import a component's types
 * (which would invert the `components/live → lib/live` direction).
 */
export interface TickableRow {
  symbol: string;
  tradingsymbol: string;
  exchange: Exchange;
  side: Side;
  qty: number;
  avgEntryP: Paise;
  investedP: Paise;
  markP: Paise | null;
  staleness: Staleness | null;
  markAsOf: string | null;
  dayChangePpm: Ppm | null;
  unrealisedP: Paise | null;
  unrealisedPctPpm: Ppm | null;
  effectiveStopP: Paise | null;
  targetP: Paise | null;
  distanceToStopP: Paise | null;
  distanceToStopPpm: Ppm | null;
  distanceToTargetP: Paise | null;
  distanceToTargetPpm: Ppm | null;
  distanceToStopAtrX100: number | null;
  atrP3: AtrP3 | null;
  /** Null on a free wire AND on a trade with no recorded R — both mean "no open R". */
  riskAmountP: Paise | null;
  openRPpm: Ppm | null;
}

/** The row's own quote key. One format, from `lib/quotes/types.ts`, never a second copy. */
export function rowQuoteKey(row: Pick<TickableRow, "symbol" | "tradingsymbol" | "exchange">): string {
  return quoteKeyId({ symbol: row.symbol, exchange: row.exchange, tradingsymbol: row.tradingsymbol });
}

const EXCHANGES: readonly string[] = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"];
const STALENESS: readonly string[] = ["tick", "delayed", "eod", "manual"];

/**
 * Parse one `snapshot`/`tick` frame's JSON into quotes, dropping anything
 * malformed.
 *
 * The frame crosses a network boundary, so it is untrusted input even though
 * this app is both ends of it: a field of the wrong type must make the desk
 * ignore ONE quote, never throw inside an `EventSource` handler where the
 * rejection is invisible and the stream is left half-applied.
 */
export function parseTickFrame(raw: unknown): TickQuote[] {
  const quotes = (raw as { quotes?: unknown } | null)?.quotes;
  if (!Array.isArray(quotes)) return [];
  const out: TickQuote[] = [];
  for (const q of quotes) {
    const v = q as Partial<TickQuote> & { key?: Partial<TickQuote["key"]> };
    const key = v?.key;
    const symbol = typeof key?.symbol === "string" ? key.symbol : null;
    const exchange = typeof key?.exchange === "string" && EXCHANGES.includes(key.exchange) ? key.exchange : null;
    if (key === undefined || symbol === null || exchange === null) continue;
    if (typeof v.ltp !== "number" || !Number.isFinite(v.ltp)) continue;
    if (typeof v.asOf !== "string") continue;
    if (typeof v.staleness !== "string" || !STALENESS.includes(v.staleness)) continue;
    out.push({
      key: {
        symbol,
        exchange: exchange as Exchange,
        ...(typeof key.tradingsymbol === "string" ? { tradingsymbol: key.tradingsymbol } : {}),
      },
      ltp: v.ltp,
      prevClose: typeof v.prevClose === "number" && Number.isFinite(v.prevClose) ? v.prevClose : null,
      asOf: v.asOf,
      staleness: v.staleness as Staleness,
    });
  }
  return out;
}

/**
 * The newest quote per key. A later frame supersedes an earlier one; a key that
 * did not tick keeps the price it had, so a partial frame never blanks a row.
 */
export function mergeTicks(prev: TickMap, incoming: readonly TickQuote[]): TickMap {
  if (incoming.length === 0) return prev;
  const next = new Map(prev);
  for (const q of incoming) next.set(quoteKeyId(q.key), q);
  return next;
}

/** Signed P&L in paise, mirrored for shorts — the same shape `tracker-row.ts` uses. */
function unrealised(side: Side, qty: number, investedP: Paise, markP: Paise): Paise {
  const valueP = qty * markP;
  return side === "short" ? investedP - valueP : valueP - investedP;
}

/** Distance in the direction that helps the position. Shorts mirror. */
function distance(side: Side, markP: Paise, levelP: Paise): Paise {
  return side === "short" ? levelP - markP : markP - levelP;
}

/**
 * Apply the ticks held in memory to the rows the server rendered.
 *
 * A row with no tick is returned BY IDENTITY, so `React.useMemo` consumers and
 * the virtualiser see the same object and nothing re-measures for a symbol that
 * did not move.
 */
export function applyTicks<R extends TickableRow>(rows: readonly R[], ticks: TickMap): R[] {
  if (ticks.size === 0) return rows as R[];
  return rows.map((row) => {
    const q = ticks.get(rowQuoteKey(row));
    // A price of zero or less is not a mark (invariant 6) — it would print the
    // position at −100 %. Keep what the server sent.
    if (!q || q.ltp <= 0) return row;

    const markP = q.ltp;
    const unrealisedP = unrealised(row.side, row.qty, row.investedP, markP);
    const distanceToStopP = row.effectiveStopP === null ? null : distance(row.side, markP, row.effectiveStopP);
    const distanceToTargetP = row.targetP === null ? null : -distance(row.side, markP, row.targetP);

    return {
      ...row,
      markP,
      staleness: q.staleness,
      markAsOf: q.asOf,
      // The provider's own previous close is the honest live day change. Without
      // one the wire's figure stands — it came from two stored sessions, which
      // is a different measurement, not a worse one, and blanking it would lose
      // a real number every time a provider omits `prevClose`.
      dayChangePpm: q.prevClose !== null && q.prevClose > 0 ? ppmTrunc(markP - q.prevClose, q.prevClose) : row.dayChangePpm,
      unrealisedP,
      // Denominator is INVESTED VALUE, never capital — as on the server.
      unrealisedPctPpm: ppmTrunc(unrealisedP, row.investedP === 0 ? null : row.investedP),
      distanceToStopP,
      distanceToStopPpm: ppmTrunc(distanceToStopP, markP),
      distanceToTargetP,
      distanceToTargetPpm: ppmTrunc(distanceToTargetP, markP),
      distanceToStopAtrX100:
        distanceToStopP === null || row.atrP3 === null || row.atrP3 <= 0
          ? null
          : Math.trunc((distanceToStopP * ATR_SCALE * 100) / row.atrP3),
      // PRO, and only from a field the wire carries. `riskAmountP` is null both
      // for a free wire and for a trade with no recorded R (invariant 4) — and
      // in both cases open R stays null rather than being re-derived from
      // today's stop.
      openRPpm: row.riskAmountP === null ? null : ppmTrunc(unrealisedP, row.riskAmountP),
    };
  });
}
