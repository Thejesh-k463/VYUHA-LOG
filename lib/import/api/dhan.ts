/**
 * DhanHQ v2 API — the ONLY source that states MTF outright.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * Every Dhan *file* is silent about margin funding. A P&L statement has no
 * product column at all; a Global Transaction Report has one implicitly, in the
 * charge rates — but MTF and delivery attract identical STT and stamp duty, and
 * financing interest is a LEDGER entry that never appears on a contract note.
 * So from files alone, "was this MTF?" is unanswerable and Vyuha has to ask.
 *
 * The API answers it. `GET /v2/positions` returns a `productType` enum whose
 * values are CNC, INTRADAY, MARGIN, **MTF**, CO and BO. That is a stated fact
 * from the broker's own books — no inference, no confirmation dialog.
 *
 * ── What it can and cannot cover ──────────────────────────────────────────
 *
 * `/v2/positions` is the CURRENT day's book plus carry-forward quantities, not
 * a historical tradebook. So this is the daily pull that keeps open MTF
 * positions honest; the long history still arrives by file. The same shape as
 * the Kite integration, deliberately — one seam, two brokers.
 *
 * `normalizeDhanPositions` is pure and unit-tested; the fetch wrapper is a thin
 * authenticated GET.
 */

import { todayIstIso, toIst } from "@/lib/domain/trading-day";
import type { ChargeBreakdown, Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Exchange } from "@/lib/domain/constants";
import type { ApiImportSource, ParsedFile } from "@/lib/import/types";
// The SAME FIFO the Zerodha tradebook and the Dhan GTR parser pair with — a
// catch-up window spans days, and a Monday buy closed on Wednesday is one
// position. Forking that arithmetic here is how two sources start disagreeing.
import { pairLegs, type Leg, type PairedPosition } from "@/lib/import/pair-legs";
import { totp } from "@/lib/totp";

/** One row from GET /v2/positions (the fields we consume). */
export interface DhanPositionRow {
  dhanClientId?: string;
  tradingSymbol: string;
  securityId?: string;
  positionType: string; // LONG | SHORT | CLOSED
  exchangeSegment: string; // NSE_EQ | BSE_EQ | NSE_FNO | MCX_COMM | …
  productType: string; // CNC | INTRADAY | MARGIN | MTF | CO | BO
  buyAvg: number;
  buyQty: number;
  sellAvg: number;
  sellQty: number;
  netQty: number;
  realizedProfit?: number;
  unrealizedProfit?: number;
  drvExpiryDate?: string | null;
  drvOptionType?: string | null;
  drvStrikePrice?: number | null;
}

/**
 * One row from GET /v2/trades/{from-date}/{to-date}/{page} — Dhan's own trade
 * HISTORY (dhanhq.co/docs/v2/statements/, field list verified 2026-09-09).
 *
 * `/positions` is today only, so a connection last pulled five days ago used
 * to lose four days outright: the pull fetched today, stamped `lastPullAt` and
 * the gap never came back. This endpoint is fill-level and dated, which is
 * what makes the catch-up possible.
 */
export interface DhanTradeRow {
  dhanClientId?: string;
  orderId?: string;
  exchangeOrderId?: string;
  /** The exchange's own id for the fill — the dedup key across pages. */
  exchangeTradeId?: string;
  transactionType: string; // BUY | SELL
  exchangeSegment: string; // NSE_EQ | BSE_EQ | NSE_FNO | MCX_COMM | …
  productType: string; // CNC | INTRADAY | MARGIN | MTF | CO | BO
  orderType?: string;
  tradingSymbol: string;
  customSymbol?: string;
  securityId?: string;
  tradedQuantity: number;
  tradedPrice: number;
  isin?: string | null;
  instrument?: string;
  /** Charges Dhan actually levied on this fill, stated per row. */
  sebiTax?: number;
  stt?: number;
  brokerageCharges?: number;
  serviceTax?: number; // GST
  exchangeTransactionCharges?: number;
  stampDuty?: number;
  createTime?: string;
  updateTime?: string;
  exchangeTime?: string;
  drvExpiryDate?: string | null;
  drvOptionType?: string | null;
  drvStrikePrice?: number | null;
}

/** One row from GET /v2/holdings. */
export interface DhanHoldingRow {
  exchange: string;
  tradingSymbol: string;
  securityId?: string;
  isin?: string | null;
  totalQty: number;
  availableQty?: number;
  collateralQty?: number;
  avgCostPrice: number;
}

/**
 * Map Dhan's product type onto Vyuha's hint.
 *
 * MTF is the whole point of this integration — it is the one product no Dhan
 * file can express. MARGIN (the F&O/commodity carry-forward product) returns
 * null on purpose: the classifier reads the segment off the SYMBOL, and a hint
 * would only get in the way.
 */
export function productHintOf(productType: string): ProductHint {
  switch (String(productType).toUpperCase()) {
    case "MTF":
      return "mtf";
    case "CNC":
      return "delivery";
    case "INTRADAY":
    case "CO": // cover order — always intraday
    case "BO": // bracket order — always intraday
      return "intraday";
    default:
      return null; // MARGIN and anything new: let the symbol decide
  }
}

/** `NSE_EQ` → `NSE`. Null when the segment is unrecognised, so the classifier
 *  falls back to its own default rather than trusting a bad guess. */
export function exchangeOf(segment: string): Exchange | null {
  const s = String(segment).toUpperCase();
  if (s.startsWith("NSE")) return "NSE";
  if (s.startsWith("BSE")) return "BSE";
  if (s.startsWith("MCX")) return "MCX";
  return null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-29 14:30:00" → "2026-09-29". Dhan's equity rows carry the sentinel
 *  "0001-01-01", which is a non-date and returns null. */
function drvExpiryIso(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  if (Number(m[1]) < 1980) return null; // "0001-01-01" sentinel on non-derivatives
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The fields `canonicalDerivativeName` reads — stated identically by a
 *  position row and a trade-history fill. */
export type DhanDerivativeFacts = Pick<
  DhanPositionRow,
  "tradingSymbol" | "exchangeSegment" | "drvExpiryDate" | "drvOptionType" | "drvStrikePrice"
>;

/** A derivative segment as Dhan names it. Currency segments are deliberately
 *  NOT included: Vyuha has no currency segment vocabulary, so those rows keep
 *  their raw symbol and the equity fallback until that vocabulary exists. */
function isDerivativeSegment(segment: string): boolean {
  const s = String(segment).toUpperCase();
  return s.endsWith("_FNO") || s === "MCX_COMM";
}

/**
 * Canonicalise a derivative name from Dhan's STATED drv* fields.
 *
 * The API's `tradingSymbol` is hyphenated (`SENSEX-Aug2026-78200-CE`) — a shape
 * `parseInstrumentName` does not read, so every F&O position used to fall
 * through to the equity branch and be charged at equity STT (found on the first
 * real-fills pull, 2026-08-26). Dhan states expiry, strike and option type
 * outright in `drvExpiryDate` / `drvStrikePrice` / `drvOptionType`, so the
 * canonical `OPT <SYM> <DD Mon YYYY> <STRIKE> <CE|PE>` / `FUT <SYM> <DD Mon YYYY>`
 * name is BUILT from those facts — the same convention as the Angel One tax-P&L
 * parser — never parsed out of the symbol's shape.
 *
 * Returns null when the row is not a derivative, or when the stated fields are
 * incomplete (the caller then keeps the raw symbol and says so).
 *
 * Typed on the FACTS it reads, not on one row shape: a position row and a
 * trade-history fill state the same drv* fields, and one mapping serves both.
 */
export function canonicalDerivativeName(r: DhanDerivativeFacts): string | null {
  if (!isDerivativeSegment(r.exchangeSegment)) return null;
  const underlying = String(r.tradingSymbol ?? "").split("-")[0]!.trim().toUpperCase();
  const iso = drvExpiryIso(r.drvExpiryDate);
  if (!underlying || !iso) return null;
  const [y, m, d] = iso.split("-");
  const date = `${d} ${MON[Number(m) - 1]} ${y}`;

  const ot = String(r.drvOptionType ?? "").toUpperCase();
  const strike = Number(r.drvStrikePrice) || 0;
  const optionType = ot === "CALL" || ot === "CE" ? "CE" : ot === "PUT" || ot === "PE" ? "PE" : null;
  if (optionType && strike > 0) return `OPT ${underlying} ${date} ${String(strike)} ${optionType}`;
  if (!optionType || ot === "NA") return `FUT ${underlying} ${date}`;
  return null; // an option type with no strike — incomplete, refuse to guess
}

/**
 * The current mark of an OPEN position, derived from Dhan's own numbers.
 *
 * The payload has no LTP field, but it states `unrealizedProfit`, and
 * entry ± unrealised/qty IS the broker's mark (verified against Dhan's UI on
 * the real 2026-08-26 book: 1.30 / 2.90 / 38.25 reproduced exactly). This is
 * algebra on two stated facts, not an invented price — without it every open
 * position imports unvalued and asks the user for a number Dhan already sent.
 */
export function markOf(r: DhanPositionRow): number | null {
  const netQty = Number(r.netQty) || 0;
  const u = Number(r.unrealizedProfit);
  if (netQty === 0 || !Number.isFinite(u)) return null;
  return netQty > 0
    ? r2((Number(r.buyAvg) || 0) + u / netQty)
    : r2((Number(r.sellAvg) || 0) - u / Math.abs(netQty));
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Turn today's positions into normalized trades.
 *
 * A position with `netQty === 0` was opened and closed today, so it is a
 * completed round trip; anything else is still open and is imported as such.
 * Gross P&L is taken from Dhan's own `realizedProfit` when it is present —
 * the broker's arithmetic beats ours — and derived from the legs otherwise.
 */
export function normalizeDhanPositions(rows: DhanPositionRow[], today: string): NormalizedTrade[] {
  const out: NormalizedTrade[] = [];

  for (const r of rows) {
    const buyQty = Number(r.buyQty) || 0;
    const sellQty = Number(r.sellQty) || 0;
    if (buyQty === 0 && sellQty === 0) continue; // nothing happened

    const buyValue = r2(buyQty * (Number(r.buyAvg) || 0));
    const sellValue = r2(sellQty * (Number(r.sellAvg) || 0));
    const closed = buyQty === sellQty && buyQty > 0;
    /**
     * SOLD TODAY, out of a holding this endpoint cannot see — the user held it
     * from before any import, so /positions states the sale and no purchase.
     *
     * The sale's date is not unknown: the row is in TODAY's book, so it is
     * today by definition. Leaving it null wrote a closed trade with no exit
     * date (or a phantom short), and tomorrow's catch-up window — inclusive of
     * the stamp day — restated the same sale as a dated history fill, which
     * hashed differently and landed a SECOND time (round-1 audit, 2026-09-10;
     * tests/dhan-api.test.ts pins the two hashes equal). The basis really is
     * unknown, and says so rather than being derived from a buyValue of zero
     * (invariant 6).
     */
    const sellOnly = sellQty > 0 && buyQty === 0;

    const gross =
      r.realizedProfit != null && Number.isFinite(Number(r.realizedProfit))
        ? r2(Number(r.realizedProfit))
        : closed
          ? r2(sellValue - buyValue)
          : 0;

    // Derivatives get the canonical OPT/FUT name built from Dhan's stated drv*
    // fields; a derivative row whose facts are incomplete keeps its raw symbol
    // and SAYS SO rather than silently classifying as equity.
    const canonical = canonicalDerivativeName(r);
    const unclassifiable = !canonical && isDerivativeSegment(r.exchangeSegment);
    const notes: string[] = [];
    if (productHintOf(r.productType) === "mtf") notes.push("Product stated by the Dhan API as MTF — not inferred.");
    if (unclassifiable)
      notes.push(
        `Dhan marked ${r.tradingSymbol} as F&O but stated no usable expiry/strike — imported with its raw name; check its segment.`,
      );
    if (sellOnly)
      notes.push(
        "Sold today out of a holding bought before this pull can see — Dhan's positions state no purchase, so the cost basis is unknown until you set it.",
      );

    out.push({
      broker: "dhan",
      tradingsymbol: canonical ?? r.tradingSymbol,
      isin: null,
      buyQty,
      avgBuyPrice: r2(Number(r.buyAvg) || 0),
      buyValue,
      sellQty,
      avgSellPrice: r2(Number(r.sellAvg) || 0),
      sellValue,
      // The broker's own mark for an open position (entry ± unrealised/qty);
      // null for closed rows and when Dhan states no unrealised figure.
      closingPrice: markOf(r),
      grossPnl: gross,
      unrealisedPnl: r2(Number(r.unrealizedProfit) || 0),
      // Positions are the CURRENT day's book, so today is the honest date.
      buyDate: buyQty > 0 ? today : null,
      // A sell-only row is dated today for the same reason a closed one is: it
      // is in today's book. Every other shape is untouched.
      sellDate: closed || sellOnly ? today : null,
      ...(sellOnly ? { basisUnknown: true } : {}),
      productHint: productHintOf(r.productType),
      exchangeHint: exchangeOf(r.exchangeSegment),
      sourceFile: "dhan-api",
      // The positions endpoint carries no fill times — only aggregates.
      entryTime: null,
      exitTime: null,
      importNotes: notes.length ? notes : null,
    });
  }

  return out;
}

/**
 * The widest catch-up window a pull will ever ask Dhan for, in days.
 *
 * A connection last pulled a year ago is CLAMPED to this, not refused: 90 days
 * of fills is a handful of pages, while a year would be a page loop against a
 * statement endpoint, and the long history has always been a file import
 * (AGENTS.md — the API exists for MTF and today's book, files for the rest).
 */
export const DHAN_MAX_PULL_RANGE_DAYS = 90;

/**
 * The page ceiling for one history walk. Dhan's `/v2/trades/{from}/{to}/{page}`
 * is paged from 0 and states no total, so the loop's real stop is the first
 * EMPTY page; this cap is the stop an endpoint that never empties cannot
 * outrun. 50 pages is far beyond any 90-day retail book.
 */
export const DHAN_TRADES_MAX_PAGES = 50;

/** ISO date ± n days, on the calendar — no timezone arithmetic. */
function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The window a pull should ask for, given when this connection last pulled.
 *
 * `from` is the IST DAY of the last pull, INCLUSIVE — excluding it would drop
 * every fill that happened after the pull ran. Re-reading that day is NOT made
 * safe by the commit's de-duplication: a fill the last pull already stored from
 * /v2/positions (which states no fill id) comes back from the history in
 * another shape, and normalizeDhanTrades pairs it with any later SELL into a
 * new closed row that hashes differently — a purchase counted twice (R42,
 * v4.3.0 fix wave 1). `catchUpAfter` below is the cutoff that stops it; the
 * caller hands it to fetchTrades as `after`. Null when there is nothing to
 * catch up on (never pulled, unreadable stamp, or already pulled today —
 * today's book is what `/positions` is for).
 *
 * C-6 (v4.3.0 fix wave C, owner ruling "Say it plainly"): when the gap is wider
 * than DHAN_MAX_PULL_RANGE_DAYS the window is still clamped — no extra Dhan
 * calls — but the result NAMES what the clamp left out, as `unfetched`: the
 * last pull's IST day up to the day before the floor. Absent (not undefined)
 * when nothing was left out, so an unclamped range is byte-identical to before.
 */
export type DhanCatchUpRange = { from: string; to: string; unfetched?: { from: string; to: string } };

export function catchUpRange(
  lastPullAt: string | null | undefined,
  today: string = todayIstIso(),
): DhanCatchUpRange | null {
  if (!lastPullAt) return null;
  const t = Date.parse(lastPullAt);
  if (!Number.isFinite(t)) return null;
  const day = todayIstIso(new Date(t));
  if (day >= today) return null;
  const floor = addDaysIso(today, -DHAN_MAX_PULL_RANGE_DAYS);
  if (day < floor) return { from: floor, to: today, unfetched: { from: day, to: addDaysIso(floor, -1) } };
  return { from: day, to: today };
}

/** An instant as India wall clock, `YYYY-MM-DD HH:MM:SS` — the format Dhan
 *  states a fill's `exchangeTime` in. */
function istWallClock(ms: number): string {
  return toIst(new Date(ms)).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * R42 (v4.3.0 fix wave 1): the cutoff a catch-up pull hands fetchTrades as
 * `after` — the last pull's stamp as IST wall clock. A history fill at or
 * before it was already in the book that pull read from /v2/positions, so
 * fetchTrades drops it instead of re-pairing the stored BUY with a later SELL.
 *
 * Null when there is no window, and when the window is CLAMPED: the stamp's day
 * is then not in it, so nothing that pull read can come back. A separate
 * function, not a field on `catchUpRange`'s result, so the window every caller
 * and test already reads keeps its exact shape.
 *
 * The stamp is the instant taken immediately BEFORE the /v2/positions request
 * (`onCutoff`), never a post-commit clock — a fill executed after the snapshot
 * and before a later stamp would otherwise be dropped on every pull. Residual:
 * a fill executed between that instant and Dhan's response can sit in the
 * snapshot AND in the next pull's history; a laptop clock running ahead of the
 * exchange's widens that window by the skew.
 */
export function catchUpAfter(lastPullAt: string | null | undefined, today: string = todayIstIso()): string | null {
  const range = catchUpRange(lastPullAt, today);
  if (!range || range.unfetched) return null;
  return istWallClock(Date.parse(lastPullAt!));
}

/** R42: the fill's `YYYY-MM-DD HH:MM:SS` as Dhan states it (exchangeTime, else
 *  createTime), or null when no full time is readable — such a fill is kept. */
function fillWallClock(r: DhanTradeRow): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(String(r.exchangeTime ?? r.createTime ?? "").trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

/** "2026-09-07 10:15:00" (or an ISO instant) → "2026-09-07"; null when Dhan
 *  states no readable time on the fill. */
function tradeDateOf(r: DhanTradeRow): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(r.exchangeTime ?? r.createTime ?? r.updateTime ?? "").trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "HH:MM" of the fill, for the execution ladder; null when unstated. */
function tradeTimeOf(r: DhanTradeRow): string | null {
  const m = /[T ](\d{2}):(\d{2})/.exec(String(r.exchangeTime ?? r.createTime ?? "").trim());
  return m ? `${m[1]}:${m[2]}` : null;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The charge components Dhan states on a fill, in ChargeBreakdown's names. */
function fillCharges(r: DhanTradeRow) {
  return {
    brokerage: num(r.brokerageCharges),
    gst: num(r.serviceTax),
    sttCtt: num(r.stt),
    sebi: num(r.sebiTax),
    exchangeTxn: num(r.exchangeTransactionCharges),
    stampDuty: num(r.stampDuty),
  };
}

type FillCharges = ReturnType<typeof fillCharges>;

/** One Dhan fill, with the charges Dhan stated on it. */
type DhanFill = Execution & { charges: FillCharges };

/** The six components Dhan states, in the order a remainder split walks them. */
const CHARGE_KEYS = ["brokerage", "gst", "sttCtt", "sebi", "exchangeTxn", "stampDuty"] as const;

const noCharges = (): FillCharges => ({ brokerage: 0, gst: 0, sttCtt: 0, sebi: 0, exchangeTxn: 0, stampDuty: 0 });

/**
 * How much of one fill a single position consumed, and the charges it owes —
 * allocated by REMAINDER (see `splitChargesByRemainder`), never re-derived from
 * the share at the call site.
 */
type FillTake = { fill: DhanFill; qty: number; charges: FillCharges };

/**
 * Split ONE fill's stated charges across the takes that consumed it, exactly.
 *
 * Every take but the LAST gets its quantity share rounded to paise; the last
 * take gets `total − what the earlier takes already got`, per component. A
 * per-share pro-rata rounded independently does not conserve: ₹5.00 of
 * brokerage on a 300-share fill split three ways is 1.67 × 3 = ₹5.01, which is
 * how ₹44.00 charged came to be stored as ₹44.01 (seam audit D1, 2026-09-10).
 *
 * The target is the CONSUMED quantity's share, not the whole fill's — when
 * pairLegs conserves quantity (it does) every fill is drained and the target is
 * the fill's own stated charge, so the takes sum to it to the paisa.
 */
function splitChargesByRemainder(fill: DhanFill, takes: FillTake[]): void {
  if (takes.length === 0) return;
  const consumed = takes.reduce((s, t) => s + t.qty, 0);
  for (const key of CHARGE_KEYS) {
    const stated = fill.charges[key];
    const target = fill.qty > 0 ? r2(stated * (consumed / fill.qty)) : 0;
    let given = 0;
    takes.forEach((t, i) => {
      const share = i === takes.length - 1 ? r2(target - given) : fill.qty > 0 ? r2(stated * (t.qty / fill.qty)) : 0;
      t.charges[key] = share;
      given = r2(given + share);
    });
  }
}

/**
 * Hand every fill to the position that consumed it — FIFO, and once only.
 *
 * `pairLegs` reports what each position holds but not WHICH fills it retired,
 * so the mapping is rebuilt here from the same two facts pairLegs pairs on:
 * fills go out oldest-first (file order is the within-day tiebreak, the only
 * sequence a dated fill states), and positions ask in the order they entered
 * (buy side) or exited (sell side). A fill big enough for two positions is
 * SPLIT, and each takes the quantity it needed — so the quantities in a
 * position's `executions` sum to its own buyQty/sellQty, and its charges are
 * that fill's charges split by the same shares, BY REMAINDER: every take but
 * the last gets its rounded share and the last gets what is left, per
 * component, so the takes of a fill sum to the charges Dhan stated on it to the
 * paisa (`splitChargesByRemainder`).
 *
 * The predecessor filtered fills by each position's [buyDate, sellDate] window,
 * which double-counted every fill two overlapping windows both contained
 * (round-1 audit, 2026-09-10). Quantity is conserved by pairLegs, so the queues
 * empty exactly.
 */
function allocateFills(fills: DhanFill[], positions: PairedPosition[]): FillTake[][] {
  const taken: FillTake[][] = positions.map(() => []);
  /** Every take of one fill, in the order the positions took it. */
  const perFill = new Map<DhanFill, FillTake[]>();
  const ordered = fills
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.date ?? "").localeCompare(b.f.date ?? "") || a.i - b.i);
  const rank = new Map<DhanFill, number>();
  ordered.forEach((x, k) => rank.set(x.f, k));

  const hand = (side: "buy" | "sell") => {
    const queue = ordered.filter((x) => x.f.side === side).map((x) => ({ fill: x.f, left: x.f.qty }));
    const want = (p: PairedPosition) => (side === "buy" ? p.buyQty : p.sellQty);
    const when = (p: PairedPosition) => (side === "buy" ? p.buyDate : p.sellDate) ?? "";
    const order = positions
      .map((p, i) => ({ p, i }))
      .filter((x) => want(x.p) > 0)
      .sort((a, b) => when(a.p).localeCompare(when(b.p)) || a.i - b.i);
    let q = 0;
    for (const { p, i } of order) {
      let need = want(p);
      while (need > 0 && q < queue.length) {
        if (queue[q].left <= 0) {
          q++;
          continue;
        }
        const take = Math.min(need, queue[q].left);
        queue[q].left -= take;
        need -= take;
        const t: FillTake = { fill: queue[q].fill, qty: take, charges: noCharges() };
        taken[i].push(t);
        const list = perFill.get(t.fill);
        if (list) list.push(t);
        else perFill.set(t.fill, [t]);
      }
    }
  };
  hand("buy");
  hand("sell");
  // Charges are split only once the takes of a fill are ALL known — the last
  // one carries the remainder, so a three-way split cannot round the same
  // rupee three times.
  for (const [fill, takes] of perFill) splitChargesByRemainder(fill, takes);
  // Chronological again: the buy pass ran before the sell pass, and a ladder
  // reads in the order the fills happened.
  for (const t of taken) t.sort((a, b) => (rank.get(a.fill) ?? 0) - (rank.get(b.fill) ?? 0));
  return taken;
}

/**
 * Dated fills → normalized trades, FIFO-paired per symbol + product.
 *
 * A LEG is a scrip-DAY, not a fill — the same unit the Zerodha tradebook and
 * the Dhan GTR parser use, and for the same reason: feeding `pairLegs` raw
 * fills makes a book that fills 11 + 2 + 3 shares at a time report hundreds of
 * positions nobody took. Every individual fill still survives in `executions`,
 * so a staged ladder rebuilds exactly. Pairing across days is what makes a
 * catch-up honest: a Monday buy and a Wednesday sell are ONE closed position,
 * not an open long plus a phantom short.
 *
 * A row with no readable side, quantity, price or date is REFUSED and counted,
 * never coerced (AGENTS.md — a zero-share trade is worse than no trade).
 */
export function normalizeDhanTrades(rows: DhanTradeRow[]): { trades: NormalizedTrade[]; refused: number } {
  type Group = {
    symbol: string;
    productRaw: string;
    segment: string;
    isin: string | null;
    notes: string[];
    /** Keyed `date|side` — one leg per scrip-day-side. */
    legs: Map<string, Leg>;
    fills: DhanFill[];
  };
  const groups = new Map<string, Group>();
  let refused = 0;

  for (const r of rows) {
    const rawSymbol = String(r.tradingSymbol ?? "").trim();
    const qty = num(r.tradedQuantity);
    const price = num(r.tradedPrice);
    const rawSide = String(r.transactionType ?? "").toUpperCase();
    const side: Leg["side"] | null = rawSide.startsWith("B") ? "buy" : rawSide.startsWith("S") ? "sell" : null;
    const date = tradeDateOf(r);
    if (!rawSymbol || !side || !date || qty <= 0 || price <= 0) {
      refused++;
      continue;
    }

    // The SAME derivative naming as the positions path, built from Dhan's own
    // drv* fields — never parsed out of the hyphenated symbol's shape.
    const canonical = canonicalDerivativeName(r);
    const symbol = canonical ?? rawSymbol;
    const productRaw = String(r.productType ?? "");
    const key = `${symbol}|${productRaw.toUpperCase()}`;

    let g = groups.get(key);
    if (!g) {
      const notes: string[] = [];
      if (productHintOf(productRaw) === "mtf") notes.push("Product stated by the Dhan API as MTF — not inferred.");
      if (!canonical && isDerivativeSegment(r.exchangeSegment)) {
        notes.push(
          `Dhan marked ${rawSymbol} as F&O but stated no usable expiry/strike — imported with its raw name; check its segment.`,
        );
      }
      g = {
        symbol,
        productRaw,
        segment: String(r.exchangeSegment ?? ""),
        isin: (r.isin ?? null) || null,
        notes,
        legs: new Map(),
        fills: [],
      };
      groups.set(key, g);
    }
    if (!g.isin && r.isin) g.isin = r.isin;

    // MTF has no counterpart in pairLegs' product union; the group key keeps it
    // separate and Dhan's stated productType supplies the hint further down.
    const hint = productHintOf(productRaw);
    const legProduct: Leg["product"] = hint === "intraday" ? "intraday" : hint === "delivery" ? "delivery" : "unknown";

    const legKey = `${date}|${side}`;
    const existing = g.legs.get(legKey);
    if (existing) {
      existing.qty += qty;
      existing.value = r2(existing.value + qty * price);
    } else {
      g.legs.set(legKey, {
        symbol: g.symbol,
        side,
        date,
        qty,
        value: r2(qty * price),
        // Charges ride on the FILLS (Dhan states them per fill, in components)
        // and are re-summed per position below; the leg's scalar would only
        // round the same money twice.
        charges: 0,
        exchange: exchangeOf(r.exchangeSegment),
        product: legProduct,
      });
    }
    g.fills.push({ side, qty, price, date, time: tradeTimeOf(r), charges: fillCharges(r) });
  }

  const trades: NormalizedTrade[] = [];
  for (const g of groups.values()) {
    const positions = pairLegs([...g.legs.values()]);
    const taken = allocateFills(g.fills, positions);
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i];
      // Every fill lands in exactly ONE position — handed out FIFO, the same
      // consumption order pairLegs uses for the quantity, and pro-rated by the
      // quantity each position took when one fill spans two. A DATE WINDOW was
      // the earlier rule and it was wrong: two positions that overlap in time
      // both claimed the same fill, so its charges were stored twice and each
      // row listed fills it never consumed (found by the round-1 skeptic,
      // 2026-09-10 — ₹44 stored from ₹22 charged). Approximate for a symbol
      // re-entered on one day (the Zerodha tradebook makes the same trade-off).
      // The TOTALS are exact — and exact means EXACT, not ±₹0.01: allocateFills
      // splits each fill by REMAINDER (last take gets total − earlier takes,
      // per component), so summing the takes here only adds paise-denominated
      // numbers and the file's stored charges equal what Dhan levied. Rounding
      // each take's share independently made ₹44.00 store as ₹44.01 (D1).
      const mine = taken[i];
      const executions: Execution[] = mine.map((m) => ({
        side: m.fill.side,
        qty: m.qty,
        price: m.fill.price,
        date: m.fill.date,
        time: m.fill.time,
      }));
      const sum = mine.reduce<FillCharges>((a, m) => {
        for (const key of CHARGE_KEYS) a[key] = r2(a[key] + m.charges[key]);
        return a;
      }, noCharges());
      const total = r2(sum.brokerage + sum.gst + sum.sttCtt + sum.sebi + sum.exchangeTxn + sum.stampDuty);
      // Only when Dhan actually stated charges. A zero total means the payload
      // carried none, and reporting 0 as a FACT would override the rate card
      // with a number the broker never sent.
      const reportedCharges: Partial<ChargeBreakdown> | null =
        total > 0
          ? {
              brokerage: r2(sum.brokerage),
              gst: r2(sum.gst),
              sttCtt: r2(sum.sttCtt),
              sebi: r2(sum.sebi),
              exchangeTxn: r2(sum.exchangeTxn),
              stampDuty: r2(sum.stampDuty),
              total,
            }
          : null;

      trades.push({
        broker: "dhan",
        tradingsymbol: pos.symbol,
        isin: g.isin,
        buyQty: pos.buyQty,
        avgBuyPrice: pos.buyQty > 0 ? r2(pos.buyValue / pos.buyQty) : 0,
        buyValue: pos.buyValue,
        sellQty: pos.sellQty,
        avgSellPrice: pos.sellQty > 0 ? r2(pos.sellValue / pos.sellQty) : 0,
        sellValue: pos.sellValue,
        closingPrice: null,
        // Only a CLOSED position has a knowable P&L; an opening sell has no
        // purchase anywhere in the window and `basisUnknown` says why.
        grossPnl: pos.kind === "closed" ? r2(pos.sellValue - pos.buyValue) : 0,
        unrealisedPnl: 0,
        buyDate: pos.buyDate,
        sellDate: pos.sellDate,
        entryTime: executions.find((e) => e.side === "buy")?.time ?? null,
        exitTime: [...executions].reverse().find((e) => e.side === "sell")?.time ?? null,
        // STATED by Dhan, not inferred from the calendar or the charges.
        productHint: productHintOf(g.productRaw),
        exchangeHint: exchangeOf(g.segment),
        sourceFile: "dhan-api",
        executions: executions.length > 0 ? executions : null,
        reportedCharges,
        basisUnknown: pos.basisUnknown,
        importNotes: [...g.notes, ...pos.notes].length > 0 ? [...g.notes, ...pos.notes] : null,
      });
    }
  }

  return { trades, refused };
}

export interface DhanCredentials {
  /** Dhan client ID (stored in broker_connections.api_key). */
  clientId: string;
  /** A pasted 24h JWT from the Dhan developer console — the fallback mode,
   *  and the only mode for legacy connections saved before PIN+TOTP existed. */
  accessToken?: string;
  /** Unattended-auth extras (one encrypted JSON blob in auth_json, the Angel
   *  One pattern): when BOTH are present, the day's token is MINTED at pull
   *  time from PIN + a freshly computed TOTP code. */
  pin?: string;
  totpSecret?: string;
}

/**
 * The Dhan PIN+TOTP consent version the save route stamps into auth_json as
 * `totpAckVersion`, and the version an enrolment must MEET to count as
 * enrolled. It lives here, next to `dhanTotpEnrolled`, so that bumping it
 * actually invalidates older acknowledgements: the check used to be the
 * literal `>= 1`, so raising the route's copy of the constant left every v1
 * blob "enrolled" and the re-consent never happened. MUST equal
 * DHAN_TOTP_CONSENT_VERSION exported next to the consent copy in
 * components/import/broker-connect.tsx (a "use client" module this one cannot
 * import — tests/broker-auth-gate.test.ts pins the two to the same number).
 */
export const DHAN_TOTP_ACK_VERSION = 1;

/**
 * Is this auth_json blob a COMPLETE Dhan unattended-auth enrollment?
 *
 * Complete means pin + totpSecret + a recorded consent (`totpAckVersion`,
 * stamped by the save route only when the user sent the explicit
 * `dhanTotpConsent` acknowledgement — components/import/broker-connect.tsx
 * exports the consent copy and DHAN_TOTP_CONSENT_VERSION). A legacy-shaped
 * blob with pin + totpSecret but NO ack is treated as NOT enrolled: the mint
 * path is skipped (pulls fall back to the pasted token) and auto-pull calls it
 * ineligible — a credential stored without its recorded consent must not keep
 * working as if the consent existed.
 */
export function dhanTotpEnrolled(
  auth: { pin?: string; totpSecret?: string; totpAckVersion?: number } | null | undefined,
  required: number = DHAN_TOTP_ACK_VERSION,
): boolean {
  return Boolean(auth?.pin && auth?.totpSecret && Number(auth.totpAckVersion) >= required);
}

/** The generateAccessToken URL, built pure so tests can pin its shape.
 *  The endpoint takes everything as query parameters and no auth headers. */
export function dhanAuthUrl(clientId: string, pin: string, totpCode: string): string {
  const q = new URLSearchParams({ dhanClientId: clientId, pin, totp: totpCode });
  return `https://auth.dhan.co/app/generateAccessToken?${q.toString()}`;
}

/**
 * The `exp` claim of a JWT as epoch MILLISECONDS, or null when the token is
 * not a decodable JWT or carries no finite exp (refuse to guess).
 *
 * RFC 7519 says `exp` is seconds, but a millisecond `exp` is a common issuer
 * slip and the old `exp * 1000` comparison read one as alive for ~50,000
 * years — a revoked token then looked reusable forever. Any `exp` above 1e11
 * (seconds would put that in the year 5138) is treated as milliseconds.
 */
function jwtExpMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp)) return null;
    return exp > 1e11 ? exp : exp * 1000;
  } catch {
    return null;
  }
}

/** The JWT's own expiry as an ISO timestamp, for display ("pasted token ·
 *  expires …"); null when unreadable. Never returns any other claim. */
export function jwtExpiresAt(token: string): string | null {
  const ms = jwtExpMs(token);
  return ms == null ? null : new Date(ms).toISOString();
}

/** Does this JWT's own `exp` claim say it is still alive? Used only to decide
 *  whether a stored pasted token is worth FALLING BACK on after a failed mint —
 *  an unreadable token counts as expired (refuse to guess). */
export function jwtLooksUnexpired(token: string, nowMs: number = Date.now()): boolean {
  const ms = jwtExpMs(token);
  return ms != null && ms > nowMs;
}

/**
 * Mint a fresh 24h access token from PIN + TOTP (the code is computed HERE, at
 * call time, from the enrolled secret — lib/totp.ts, no dependency).
 *
 * LIVE-VERIFIED 2026-09-02 on the owner's real account (API-key mode active
 * at web.dhan.co): mint → preview → cached-token commit all succeeded, 5
 * trades landed. Two behaviors Dhan's docs never state, found on that run:
 * auth failures arrive as HTTP 200 with {"message","status":"error"}, and
 * minting is limited to once per 2 minutes — hence the reuse-first resolver
 * below. Whether the flow also works with API-key mode OFF remains untested
 * (irrelevant in practice; the generic-400 hint stays for that case).
 */
export async function mintDhanAccessToken(creds: { clientId: string; pin: string; totpSecret: string }): Promise<string> {
  const code = totp(creds.totpSecret);
  const res = await fetch(dhanAuthUrl(creds.clientId, creds.pin, code), { method: "POST", cache: "no-store" });
  const json = (await res.json().catch(() => null)) as
    | { accessToken?: string; errorMessage?: string; message?: string }
    | null;
  if (!res.ok) {
    const msg = json?.errorMessage ?? json?.message ?? `HTTP ${res.status}`;
    const hint = /totp|otp/i.test(msg)
      ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right; a drifted clock produces valid-looking wrong codes.)"
      : /pin/i.test(msg)
        ? " (PIN rejected — the Dhan login PIN, not the account password.)"
        : res.status === 400
          ? " (Dhan refused the request — if the PIN and TOTP secret are right, check that Trading APIs are enabled for this account at web.dhan.co; whether that toggle is required for token minting is unverified.)"
          : "";
    throw new Error(`Dhan generateAccessToken: ${msg}${hint}`);
  }
  const token = json?.accessToken;
  if (!token) {
    // LIVE-VERIFIED 2026-09-02 on the owner's account: Dhan answers auth
    // failures as HTTP 200 with {"message": "...", "status": "error"} — an
    // error-in-200 envelope ("Invalid TOTP", "Token can be generated once
    // every 2 minutes."). Surface that message with the matching hint; for
    // anything shapeless, echo the body (it is Dhan's own response and cannot
    // contain the user's PIN or secret).
    const msg = json?.errorMessage ?? json?.message;
    if (msg) {
      const hint = /once every|minute/i.test(msg)
        ? " (Dhan mints at most one token per 2 minutes — Vyuha reuses the day's token once minted, so this clears on its own; retry shortly.)"
        : /totp|otp/i.test(msg)
          ? " (TOTP rejected — check the enrolled secret and that this machine's clock is right; a drifted clock produces valid-looking wrong codes.)"
          : /pin/i.test(msg)
            ? " (PIN rejected — the Dhan login PIN, not the account password.)"
            : "";
      throw new Error(`Dhan generateAccessToken: ${msg}${hint}`);
    }
    const body = json ? JSON.stringify(json).slice(0, 300) : "(not JSON)";
    throw new Error(`Dhan generateAccessToken: HTTP ${res.status} but no accessToken in the response — body: ${body}`);
  }
  return token;
}

/**
 * The access token a pull should use, in order of honesty:
 *
 *   1. PIN + TOTP secret present → MINT a fresh 24h token (stateless, per
 *      pull — at one pull a day, caching the minted JWT in the DB buys
 *      nothing; if pull frequency ever rises, cache it with its expiryTime
 *      in broker_connections.access_token instead).
 *
 *   ^ That comment aged fast. LIVE-VERIFIED 2026-09-02: Dhan rate-limits
 *   generateAccessToken to ONCE PER 2 MINUTES ("Token can be generated once
 *   every 2 minutes.", in an error-in-200 envelope) — and preview → commit is
 *   always inside that window, so mint-per-call broke commit on the first
 *   real run. The order is therefore:
 *
 *   1. A stored token whose own `exp` says it is alive → USE IT (it is either
 *      today's minted token or a user-pasted one; both die within 24h and
 *      jwtLooksUnexpired reads the JWT itself).
 *   2. PIN + TOTP secret present → mint, and return `minted: true` so the
 *      caller PERSISTS it into broker_connections.access_token (the route
 *      owns that write via the vault) — the very next call then takes path 1.
 *   3. Mint failed → throw with guidance naming both ways out.
 */
export async function resolveDhanAccessToken(creds: DhanCredentials): Promise<{ token: string; minted: boolean }> {
  const canMint = Boolean(creds.pin && creds.totpSecret);
  // Paste-only mode returns the stored token UNTOUCHED even when unreadable —
  // Dhan's own 401 (with the 24-hour hint) is the honest judge there, exactly
  // as before the caching change. Mint mode reuses only a token whose own
  // `exp` says it is alive.
  if (creds.accessToken && (jwtLooksUnexpired(creds.accessToken) || !canMint)) {
    return { token: creds.accessToken, minted: false };
  }
  if (!canMint) {
    throw new Error("Dhan: no access token saved and no PIN + TOTP secret to mint one — reconnect Dhan with either.");
  }
  try {
    const token = await mintDhanAccessToken({ clientId: creds.clientId, pin: creds.pin!, totpSecret: creds.totpSecret! });
    return { token, minted: true };
  } catch (e) {
    throw new Error(
      `${(e as Error).message} No unexpired stored token to fall back on — fix the PIN/TOTP secret, or paste a fresh 24-hour token from web.dhan.co → DhanHQ Trading APIs.`,
    );
  }
}

/**
 * Does the REFUSAL itself name an authentication failure?
 *
 * 401 always does. A 403 does NOT by itself: Dhan answers a permissions
 * problem (a segment or data API the account is not subscribed to) with 403
 * too, and treating that as "token expired" burned the one mint allowed per 2
 * minutes on a token that was never the problem — and then told the user to
 * check a token that was fine. So a 403 counts only when the body states
 * Dhan's own AUTHENTICATION error code (DH-901 Invalid_Authentication) or the
 * matching errorType.
 *
 * DH-902 IS NOT ONE OF THEM. Dhan's annexure calls it "Invalid Access": the
 * account is not subscribed to the Data APIs, or has no access to the Trading
 * APIs. That is a permissions verdict wearing an auth-shaped code, and minting
 * a fresh token cannot fix it — it just spends the one mint allowed per 2
 * minutes and then blames a token that was never the problem, which is the
 * exact bug the bare-403 rule above was written to stop.
 */
function namesAuthFailure(status: number, json: unknown): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const o = json as { errorCode?: unknown; internalErrorCode?: unknown; errorType?: unknown } | null;
  const code = String(o?.errorCode ?? o?.internalErrorCode ?? "").toUpperCase();
  const type = String(o?.errorType ?? "").toLowerCase();
  return /^DH-?901$/.test(code) || /invalid[_ -]?authentication\b/.test(type);
}

/** The auth hint, shared by the first refusal and the post-retry one. It is
 *  attached only when the refusal actually names an authentication failure —
 *  a bare permissions 403 gets Dhan's own message and no token advice. */
function dhanApiError(status: number, json: unknown): Error {
  const msg =
    (json as { errorMessage?: string; message?: string } | null)?.errorMessage ??
    (json as { message?: string } | null)?.message ??
    `HTTP ${status}`;
  return new Error(
    `Dhan API: ${msg}${
      namesAuthFailure(status, json)
        ? " (access token expired or wrong? Pasted Dhan tokens from web.dhan.co → DhanHQ Trading APIs last 24 hours; with PIN + TOTP saved, Vyuha mints a fresh one at every pull instead.)"
        : status === 403
          ? " (Dhan refused this request as forbidden without naming an authentication failure — check that this account is enabled for the data/segment being pulled; the access token is not necessarily the problem.)"
          : ""
    }`,
  );
}

async function dhanGetRaw(path: string, accessToken: string): Promise<{ res: Response; json: unknown }> {
  const res = await fetch(`https://api.dhan.co/v2${path}`, {
    headers: {
      "Content-Type": "application/json",
      "access-token": accessToken,
    },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as unknown;
  return { res, json };
}

/**
 * One authenticated GET, with the token resolved reuse-first (see
 * resolveDhanAccessToken) and ONE retry on a refusal that NAMES an
 * authentication failure (401, or a 403 carrying DH-901 — see
 * namesAuthFailure; a bare permissions 403 must not spend the mint):
 *
 * A stored token can be REVOKED while its own `exp` still says alive (the user
 * regenerated it at web.dhan.co, or Dhan invalidated the session). Reuse-first
 * then sends a dead token and, before this retry existed, the whole pull
 * failed with the 24-hour hint even though PIN + TOTP could have minted a live
 * one. So: when the request used a REUSED token and the enrolment is present,
 * drop that token, mint once, persist the mint (`onMinted`), and retry once.
 * A 401 on the freshly minted token, or on the retry, surfaces the hint as
 * before. Paste-only mode never mints — Dhan's own 401 stays the judge there.
 */
async function dhanGet<T>(path: string, creds: DhanCredentials, onMinted?: (token: string) => void): Promise<T> {
  const { token, minted } = await resolveDhanAccessToken(creds);
  if (minted) {
    creds.accessToken = token; // the in-process cache — the next call reuses instead of re-minting
    onMinted?.(token);
  }
  let r = await dhanGetRaw(path, token);
  const rejected = namesAuthFailure(r.res.status, r.json);
  const canMint = Boolean(creds.pin && creds.totpSecret);
  if (!r.res.ok && rejected && !minted && canMint) {
    let fresh: string;
    try {
      fresh = await mintDhanAccessToken({ clientId: creds.clientId, pin: creds.pin!, totpSecret: creds.totpSecret! });
    } catch (e) {
      throw new Error(`${dhanApiError(r.res.status, r.json).message} Re-minting after that rejection also failed: ${(e as Error).message}`);
    }
    creds.accessToken = fresh;
    onMinted?.(fresh);
    r = await dhanGetRaw(path, fresh);
  }
  if (!r.res.ok) throw dhanApiError(r.res.status, r.json);
  // Dhan returns a bare array on success for these endpoints.
  return r.json as T;
}

/**
 * `onMinted` fires when the call had to mint a fresh token (PIN+TOTP mode —
 * including the one-shot re-mint after a 401 on a reused token) so the caller
 * can PERSIST it — Dhan mints at most one token per 2 minutes
 * (live-verified 2026-09-02), so an unpersisted mint breaks the very next
 * call (preview → commit). The route stores it encrypted via the vault.
 */
export async function fetchDhanPositions(creds: DhanCredentials, onMinted?: (token: string) => void): Promise<DhanPositionRow[]> {
  const data = await dhanGet<DhanPositionRow[] | null>("/positions", creds, onMinted);
  return Array.isArray(data) ? data : [];
}

/**
 * Every fill Dhan states in [from, to], walking its pages from 0.
 *
 * Stops at the FIRST EMPTY page (the endpoint states no total) or at
 * DHAN_TRADES_MAX_PAGES, whichever comes first. Fills are de-duplicated by
 * `exchangeTradeId` — the exchange's own id for the fill — because a paged
 * statement re-served across a page boundary would otherwise double a
 * position's quantity, and a doubled quantity is a wrong book, not a warning.
 * A row with no id falls back to a composite of the facts that identify it.
 *
 * `onRead` (C-6) is told what the walk actually covered: a walk that ends at
 * the page cap WITHOUT reaching an empty page is `truncated`, and the pull must
 * say so rather than present a partial history as the whole one.
 */
export interface DhanHistoryRead {
  /** Pages requested from Dhan. */
  pages: number;
  /** True when the walk stopped at DHAN_TRADES_MAX_PAGES before an empty page. */
  truncated: boolean;
  /** Earliest / latest fill date actually read; null when no fill states a readable date. */
  oldest: string | null;
  newest: string | null;
}

export async function fetchDhanTrades(
  creds: DhanCredentials,
  range: { from: string; to: string },
  onMinted?: (token: string) => void,
  onRead?: (read: DhanHistoryRead) => void,
): Promise<DhanTradeRow[]> {
  const out: DhanTradeRow[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let reachedEnd = false;
  for (let page = 0; page < DHAN_TRADES_MAX_PAGES; page++) {
    const data = await dhanGet<DhanTradeRow[] | null>(`/trades/${range.from}/${range.to}/${page}`, creds, onMinted);
    pages++;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const r of rows) {
      const id = String(r.exchangeTradeId ?? "").trim();
      const key = id || [r.orderId, r.tradingSymbol, r.transactionType, r.tradedQuantity, r.tradedPrice, r.exchangeTime ?? r.createTime].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  if (onRead) {
    const dates = out.map(tradeDateOf).filter((d): d is string => d != null).sort();
    onRead({ pages, truncated: !reachedEnd, oldest: dates[0] ?? null, newest: dates[dates.length - 1] ?? null });
  }
  return out;
}

export async function fetchDhanHoldings(creds: DhanCredentials, onMinted?: (token: string) => void): Promise<DhanHoldingRow[]> {
  const data = await dhanGet<DhanHoldingRow[] | null>("/holdings", creds, onMinted);
  return Array.isArray(data) ? data : [];
}

/** `fetchTrades`' options: the window, and (C-6) a hook told what the history
 *  walk covered — how the page cap reaches the pull's warnings without a
 *  second fetch or a property hidden on the returned array. */
export interface DhanFetchOptions {
  from?: string;
  to?: string;
  /** R42: `catchUpAfter`'s cutoff — history fills at or before it are dropped. */
  after?: string | null;
  onHistory?: (read: DhanHistoryRead) => void;
  /** R42: the instant taken immediately BEFORE the /v2/positions request, as
   *  ISO — the only honest lastPullAt for this pull. */
  onCutoff?: (iso: string) => void;
}

/** The Dhan source: the shared ApiImportSource, with the widened options. */
export interface DhanImportSource extends ApiImportSource {
  fetchTrades(opts?: DhanFetchOptions): Promise<NormalizedTrade[]>;
}

export function dhanImportSource(creds: DhanCredentials, onMinted?: (token: string) => void): DhanImportSource {
  return {
    id: "dhan-api",
    label: "Dhan API (today's positions, states MTF outright)",
    broker: "dhan",
    kind: "api",
    /**
     * No range: today's `/positions`, byte-identical to every build before
     * v4.2.1 — that is the daily pull and it must not change shape.
     *
     * With a range: the trade HISTORY for [from, to] as well, so a connection
     * last pulled five days ago no longer loses four of them. Today is taken
     * from `/positions` in BOTH cases and history fills dated today are
     * dropped: the two sources state the same day in different shapes, a
     * position row carries no `exchangeTradeId` to dedupe against, and
     * `/positions` is the only source that states MTF and the broker's mark.
     *
     * v4.3.0 fix wave 1: fills at or before `after` (the last pull's stamp)
     * are dropped — that pull's snapshot already holds them (R42). A walk that
     * stopped at the page cap is dropped WHOLE (F-L1-3a): which days a
     * truncated walk covered cannot be named at day granularity, so none of it
     * is committed and toParsedFile names the whole span. `onCutoff` hands back
     * the instant taken just before /v2/positions — the caller's stamp.
     */
    async fetchTrades(opts: DhanFetchOptions = {}) {
      const today = todayIstIso();
      const history: NormalizedTrade[] = [];
      if (opts.from) {
        const walk: { read: DhanHistoryRead | null } = { read: null };
        const rows = await fetchDhanTrades(creds, { from: opts.from, to: opts.to ?? today }, onMinted, (r) => {
          walk.read = r;
          opts.onHistory?.(r);
        });
        if (!walk.read?.truncated) {
          const after = opts.after ?? null;
          const notCovered = (r: DhanTradeRow) => {
            if (!after) return true;
            const at = fillWallClock(r);
            return at == null || at > after;
          };
          history.push(...normalizeDhanTrades(rows.filter((r) => tradeDateOf(r) !== today && notCovered(r))).trades);
        }
      }
      opts.onCutoff?.(new Date().toISOString());
      const positions = normalizeDhanPositions(await fetchDhanPositions(creds, onMinted), today);
      return [...history, ...positions];
    },
  };
}

/**
 * One span of Dhan history a pull did NOT read (C-6), and the sentence that
 * says so. `range-cap`: older than DHAN_MAX_PULL_RANGE_DAYS, never asked for.
 * `page-cap`: inside the window, but the walk stopped at DHAN_TRADES_MAX_PAGES.
 * The caller that COMMITS keeps these (the audit trail), because the commit is
 * what moves lastPullAt past them.
 */
export interface DhanUnfetchedSpan {
  from: string;
  to: string;
  reason: "range-cap" | "page-cap";
  message: string;
  /** The days a Dhan tradebook can bring in WITHOUT repeating an import: the
   *  span minus the last pull's own IST day. Null when nothing is left. */
  remedy: { from: string; to: string } | null;
  /** Set when the span starts on the last pull's own IST day: its fills up to
   *  that pull are in the journal, the ones after `after` (IST "HH:MM"; null
   *  when the stamp is not known) were not fetched. */
  partial: { day: string; after: string | null } | null;
}

/** Wrap an API pull in the ParsedFile shape the preview/commit pipeline expects.
 *  `range` is the catch-up window when one was fetched — the warnings must say
 *  which days this pull covered, or a five-day catch-up reads like a daily one.
 *  `read` is what the history walk reported (C-6); `unfetched` hands back every
 *  span the pull did not read, each with the warning that named it.
 *  `lastPullAt` is the stamp the window was computed from — it dates the last
 *  pull's own day, the one day a tradebook would partly repeat (F-L1-3a). */
export function toParsedFile(
  trades: NormalizedTrade[],
  range?: DhanCatchUpRange | null,
  read?: DhanHistoryRead | null,
  lastPullAt?: string | null,
): ParsedFile & { unfetched: DhanUnfetchedSpan[] } {
  const mtf = trades.filter((t) => t.productHint === "mtf").length;
  const warnings: string[] = [];
  const unfetched: DhanUnfetchedSpan[] = [];
  const stampMs = Date.parse(String(lastPullAt ?? ""));
  const lastHhmm = Number.isFinite(stampMs) ? istWallClock(stampMs).slice(11, 16) : null;
  /** F-L1-3a: the last pull's own day is a plain fact, never a remedy — its
   *  fills up to that pull came from /v2/positions, and a tradebook states
   *  scrip names the API's tickers do not match, so it would import them twice. */
  const partialDay = (day: string) =>
    `Fills on ${day} after ${lastHhmm ? `${lastHhmm} IST` : "the last pull"} were not fetched; a tradebook for ${day} would repeat the fills already imported from it.`;

  if (range) {
    // C-4 (fix wave C): the reason stated is the one true of EVERY range
    // catchUpRange returns (`day < today`) — "older than the previous trading
    // day" was false on every routine next-day pull.
    warnings.push(
      `Catch-up pull: fills from ${range.from} to ${range.to} were read from Dhan's trade history, because the last pull ran before today. Today's book still comes from /v2/positions, and re-pulled fills are de-duplicated on commit.`,
    );
    if (range.unfetched) {
      // `u.from` IS the last pull's IST day (catchUpRange), so the remedy
      // starts the day after it.
      const u = range.unfetched;
      const restFrom = addDaysIso(u.from, 1);
      const remedy = restFrom <= u.to ? { from: restFrom, to: u.to } : null;
      const message =
        `Not fetched: fills from ${u.from} to ${u.to}. The last pull ran on ${u.from}, and a pull reads at most ${DHAN_MAX_PULL_RANGE_DAYS} days of Dhan's trade history, so this one started at ${range.from}. ${partialDay(u.from)}` +
        (remedy ? ` To bring the rest in, import a Dhan tradebook for ${remedy.from} to ${remedy.to}.` : "");
      warnings.push(message);
      unfetched.push({ from: u.from, to: u.to, reason: "range-cap", message, remedy, partial: { day: u.from, after: lastHhmm } });
    }
    if (read?.truncated) {
      // F-L1-3a: fetchTrades kept NONE of a truncated walk, so the span is the
      // whole history window up to YESTERDAY — `range.to` is today (the window
      // always ends on it), and today's book came from /v2/positions. Unclamped,
      // the window starts on the last pull's own day; clamped, on the floor,
      // a day no pull imported.
      const yesterday = addDaysIso(range.to, -1);
      const onLastPullDay = !range.unfetched;
      const restFrom = onLastPullDay ? addDaysIso(range.from, 1) : range.from;
      const remedy = restFrom <= yesterday ? { from: restFrom, to: yesterday } : null;
      const message = [
        `Truncated: this pull stopped at the ${DHAN_TRADES_MAX_PAGES}-page limit of Dhan's trade history and kept none of what it read, so fills from ${range.from} to ${yesterday} were not read. Today's book came from /v2/positions.`,
        onLastPullDay ? partialDay(range.from) : null,
        remedy ? `To bring ${onLastPullDay ? "the rest" : "those fills"} in, import a Dhan tradebook for ${remedy.from} to ${remedy.to}.` : null,
      ]
        .filter(Boolean)
        .join(" ");
      warnings.push(message);
      unfetched.push({
        from: range.from,
        to: yesterday,
        reason: "page-cap",
        message,
        remedy,
        partial: onLastPullDay ? { day: range.from, after: lastHhmm } : null,
      });
    }
  }
  if (trades.length === 0) {
    warnings.push(
      "Dhan returned no positions — /v2/positions covers the current trading day's book, so it is empty outside market hours with nothing carried forward.",
    );
  } else if (mtf > 0) {
    warnings.push(
      `${mtf} position${mtf === 1 ? " is" : "s are"} MTF according to Dhan itself. This is the one product no Dhan file can identify, so these need no confirmation.`,
    );
  } else {
    warnings.push(
      "No MTF positions in today's book. Product types here are stated by the broker, not inferred from charges.",
    );
  }

  return { sourceId: "dhan-api", broker: "dhan", format: "api", trades, warnings, unfetched };
}
