/**
 * Turning dated BUY/SELL legs into positions.
 *
 * ZERO DB and ZERO React imports; pure functions over plain data.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 *
 * A transaction report lists what happened on each settlement bill, not what
 * you traded. GM Breweries appears twice: bought 650 on 06 Jul, sold 650 on
 * 07 Jul. Those are one trade held one day, and reading them as two records
 * produces a phantom open position and a phantom naked short — which then
 * poisons holding-period analysis, Arjun's Eye and Return-on-Margin alike.
 *
 * ── Same day first, then FIFO ─────────────────────────────────────────────
 *
 * A sell is matched against the SAME DAY's buys before any older lot, and the
 * remainder retires quantity oldest-buy-first. The same-day rule is how the
 * exchange itself nets a scrip: a buy and a sell on one day in one product are
 * squared off intraday and only the net quantity ever reaches delivery — so a
 * holder of 1,000 who buys 500 and sells 500 today has one intraday trade and
 * still holds the same 1,000, not a closed old lot and a new open one. Paytm
 * Money's own realised-P&L statement pairs exactly this way (VERIFIED against
 * a real export, 2026-08-20: 05-Aug sell 10,000 ↔ 05-Aug buy 10,000 while
 * 10,000 of a 03-Aug lot stayed open), and pure FIFO disagreed with the
 * broker on 52 of 60 scrips until this rule was added. FIFO for the rest
 * matches how brokers and the Income Tax Act treat equity delivery, so the
 * holding periods produced here agree with the ones that decide STCG vs LTCG,
 * and it is what the staged-position engine already does.
 *
 * ── The three shapes that fall out ────────────────────────────────────────
 *
 *   closed        buys and sells match up            → a normal trade
 *   open          buys left over after every sell    → still holding
 *   opening-sell  sells with no buy to match         → acquired BEFORE the
 *                                                      window (very often an
 *                                                      IPO allotment), so the
 *                                                      cost basis is unknown
 *
 * The third is the one that matters. An opening sell has no purchase price
 * anywhere in the file, so its P&L is not merely unknown — it is unknowable.
 * Reporting it as a 100% gain because buyValue is zero would be a fabrication,
 * so it is marked and the caller is expected to exclude it from statistics
 * until a basis is supplied.
 */

export type LegSide = "buy" | "sell";

export interface Leg {
  symbol: string;
  side: LegSide;
  date: string; // ISO yyyy-mm-dd
  qty: number;
  value: number; // gross traded value, rupees
  /** Broker-reported charges attributable to this leg. */
  charges: number;
  exchange?: string | null;
  /** Product as inferred from the charge signature, when known. */
  product?: "delivery" | "intraday" | "mixed" | "unknown";
  /** Free-text note carried through to the trade (e.g. "product derived"). */
  note?: string | null;
}

export type PairedKind = "closed" | "open" | "opening-sell";

export interface PairedPosition {
  symbol: string;
  kind: PairedKind;
  exchange: string | null;
  buyQty: number;
  buyValue: number;
  sellQty: number;
  sellValue: number;
  buyDate: string | null;
  sellDate: string | null;
  charges: number;
  product: "delivery" | "intraday" | "mixed" | "unknown";
  /** True when no purchase leg exists in the file — cost basis unknowable. */
  basisUnknown: boolean;
  notes: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Chronological, with buys ahead of sells on the same date — you cannot sell
 *  what you have not yet bought, and same-day intraday relies on this order. */
function chronological(a: Leg, b: Leg): number {
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  if (a.side === b.side) return 0;
  return a.side === "buy" ? -1 : 1;
}

/** Pick the most specific product across the legs that formed a position. */
function resolveProduct(products: (Leg["product"] | undefined)[]): PairedPosition["product"] {
  const seen = new Set(products.filter(Boolean) as string[]);
  if (seen.has("mixed")) return "mixed";
  if (seen.has("delivery") && seen.has("intraday")) return "mixed";
  if (seen.has("delivery")) return "delivery";
  if (seen.has("intraday")) return "intraday";
  return "unknown";
}

/**
 * Pair one symbol's legs into positions.
 *
 * Same-day buy+sell collapses into a single intraday position; anything held
 * across a date boundary keeps its real entry and exit dates, which is what
 * makes the holding period real rather than assumed.
 */
export function pairSymbolLegs(legsIn: Leg[]): PairedPosition[] {
  const legs = [...legsIn].sort(chronological);
  if (legs.length === 0) return [];

  const symbol = legs[0].symbol;
  const exchange = legs.find((l) => l.exchange)?.exchange ?? null;

  type Lot = { date: string; qty: number; value: number; charges: number; product: Leg["product"]; opening?: boolean };

  /**
   * One pairing pass. `openingQty` > 0 seeds the FIFO queue with a lot of
   * that size that PRE-DATES the file: holdings the file never shows being
   * bought. It is the OLDEST lot, so FIFO retires it first — exactly where
   * the broker's own statement puts it (Paytm Money's realised-P&L lots,
   * VERIFIED 2026-08-20) — and every sell that consumes it becomes an
   * opening-sell with an unknowable cost basis. Without the seed, the
   * unmatched quantity would surface on the LAST sells instead of the first,
   * and the closed trades in between would be paired against the wrong buys.
   * The seed size is not guessed: it is the orphan quantity a seedless pass
   * measures, so total opening-sell quantity is identical either way.
   */
  const run = (openingQty: number): { out: PairedPosition[]; orphanQty: number } => {
    // Open buy lots, oldest first — the FIFO queue.
    const lots: Lot[] = [];
    /**
     * Two indexes over the SAME Lot objects, so mutating `qty` through either
     * is seen by both. They exist purely to stop each sell rescanning the
     * whole queue: with buys outnumbering sells the queue grows without bound,
     * and three O(lots) scans per sell made the walk O(n²) — 4x the legs on one
     * symbol cost 15.9x the time before this (tests/load/c8-pairing-depth).
     *
     * `head` is the oldest lot that may still have quantity. Lots are only ever
     * emptied, never refilled, and the oldest-first pass always takes the first
     * non-empty lot — so `head` moves forward only and never needs to look back.
     * That replaces the per-sell `splice` compaction, which was the worst of the
     * three scans.
     *
     * `byDate` holds each date's lots in push order with its own head, so the
     * same-day pass visits only that day's lots instead of the entire queue.
     * Legs are chronological, so once a date is passed it never gets another
     * sell and its head can advance permanently.
     */
    let head = 0;
    const byDate = new Map<string, { arr: Lot[]; head: number }>();
    const pushLot = (lot: Lot) => {
      lots.push(lot);
      // The seeded opening lot is deliberately NOT indexed by date: it pre-dates
      // the file, so it must never satisfy a same-day match.
      if (lot.opening) return;
      const e = byDate.get(lot.date);
      if (e) e.arr.push(lot);
      else byDate.set(lot.date, { arr: [lot], head: 0 });
    };
    if (openingQty > 0) pushLot({ date: "", qty: openingQty, value: 0, charges: 0, product: undefined, opening: true });
    const out: PairedPosition[] = [];
    const orphanSells: Leg[] = [];
    let orphanQty = 0;

    for (const leg of legs) {
      if (leg.side === "buy") {
        if (leg.qty > 0) {
          pushLot({ date: leg.date, qty: leg.qty, value: leg.value, charges: leg.charges, product: leg.product });
        }
        continue;
      }

      // A sell consumes the SAME DAY's lots first (exchange intraday netting),
      // then the rest oldest-first — the pre-file seed lot, when present, is the
      // oldest of all.
      let remaining = leg.qty;
      const sellCharges = leg.charges;
      const consumed: Lot[] = [];
      let openingTaken = 0;

      const takeFrom = (lot: Lot) => {
        const take = Math.min(remaining, lot.qty);
        const share = lot.qty > 0 ? take / lot.qty : 0;
        if (lot.opening) openingTaken += take;
        else consumed.push({ date: lot.date, qty: take, value: r2(lot.value * share), charges: r2(lot.charges * share), product: lot.product });
        lot.qty -= take;
        lot.value = r2(lot.value * (1 - share));
        lot.charges = r2(lot.charges * (1 - share));
        remaining -= take;
      };
      // Same day first, in push order — identical selection to scanning the
      // whole queue for `lot.date === leg.date`, just without the scan.
      const sameDay = byDate.get(leg.date);
      if (sameDay) {
        while (sameDay.head < sameDay.arr.length && sameDay.arr[sameDay.head].qty <= 0) sameDay.head++;
        for (let i = sameDay.head; i < sameDay.arr.length && remaining > 0; i++) {
          if (sameDay.arr[i].qty > 0) takeFrom(sameDay.arr[i]);
        }
      }
      // Then oldest-first. Advancing `head` past emptied lots picks exactly the
      // lot `lots.find((l) => l.qty > 0)` used to return, and exhausting the
      // queue ends the loop exactly where `lots.some(...)` used to.
      while (remaining > 0) {
        while (head < lots.length && lots[head].qty <= 0) head++;
        if (head >= lots.length) break;
        takeFrom(lots[head]);
      }

      const perShare = leg.qty > 0 ? leg.value / leg.qty : 0;
      if (consumed.length > 0) {
        const matchedQty = consumed.reduce((s, c) => s + c.qty, 0);
        const portion = leg.qty > 0 ? matchedQty / leg.qty : 1;
        out.push({
          symbol,
          kind: "closed",
          exchange,
          buyQty: matchedQty,
          buyValue: r2(consumed.reduce((s, c) => s + c.value, 0)),
          sellQty: matchedQty,
          sellValue: r2(perShare * matchedQty),
          // Entry is the OLDEST lot consumed: FIFO decides the holding period
          // (the same-day lot is consumed first but is never the oldest).
          buyDate: consumed.reduce((d, c) => (c.date < d ? c.date : d), consumed[0].date),
          sellDate: leg.date,
          charges: r2(consumed.reduce((s, c) => s + c.charges, 0) + sellCharges * portion),
          product: resolveProduct([...consumed.map((c) => c.product), leg.product]),
          basisUnknown: false,
          notes: [],
        });
      }

      const unmatched = openingTaken + remaining;
      if (unmatched > 0) {
        // Nothing (left) to match against — acquired before this file begins.
        orphanQty += remaining; // only the part NO lot covered counts as newly measured
        const portion = leg.qty > 0 ? unmatched / leg.qty : 1;
        orphanSells.push({ ...leg, qty: unmatched, value: r2(perShare * unmatched), charges: r2(sellCharges * portion) });
      }
    }

    for (const s of orphanSells) {
      out.push({
        symbol,
        kind: "opening-sell",
        exchange,
        buyQty: 0,
        buyValue: 0,
        sellQty: s.qty,
        sellValue: r2(s.value),
        buyDate: null,
        sellDate: s.date,
        charges: r2(s.charges),
        product: s.product ?? "unknown",
        basisUnknown: true,
        notes: [
          "Sold without a matching purchase in this file — acquired earlier. Often an IPO allotment. Cost basis unknown until you set it.",
        ],
      });
    }

    for (const lot of lots) {
      if (lot.qty <= 0 || lot.opening) continue;
      out.push({
        symbol,
        kind: "open",
        exchange,
        buyQty: lot.qty,
        buyValue: r2(lot.value),
        sellQty: 0,
        sellValue: 0,
        buyDate: lot.date,
        sellDate: null,
        charges: r2(lot.charges),
        product: lot.product ?? "unknown",
        basisUnknown: false,
        notes: [],
      });
    }

    return { out, orphanQty };
  };

  // Pass 1 measures how much was sold that the file never shows being bought;
  // pass 2 places that quantity where FIFO says it sits — before everything.
  const first = run(0);
  if (first.orphanQty <= 0) return first.out;
  return run(first.orphanQty).out;
}

/** Pair every symbol in a file. Order is stable by symbol then entry date. */
export function pairLegs(legs: Leg[]): PairedPosition[] {
  const bySymbol = new Map<string, Leg[]>();
  for (const l of legs) {
    const arr = bySymbol.get(l.symbol) ?? [];
    arr.push(l);
    bySymbol.set(l.symbol, arr);
  }

  const out: PairedPosition[] = [];
  for (const [, arr] of bySymbol) out.push(...pairSymbolLegs(arr));

  return out.sort(
    (a, b) =>
      a.symbol.localeCompare(b.symbol) ||
      (a.buyDate ?? a.sellDate ?? "").localeCompare(b.buyDate ?? b.sellDate ?? ""),
  );
}

export interface PairSummary {
  closed: number;
  open: number;
  openingSells: number;
  /** Quantity conservation check — must be zero, or the pairing lost shares. */
  qtyDelta: number;
  valueDelta: number;
  /**
   * The largest `valueDelta` that is arithmetic rather than loss, for this
   * many positions. Reported so a caller can say how close it got.
   */
  valueTolerance: number;
  /** False only when quantity moved, or value moved further than rounding can. */
  conserved: boolean;
}

/**
 * Conservation check.
 *
 * FIFO moves quantity and value between records, so the only way to know it
 * did not silently drop or duplicate any is to compare the totals before and
 * after.
 *
 * QUANTITY is exact and stays exact: shares are integers, nothing rounds them,
 * and a non-zero `qtyDelta` is always a bug.
 *
 * VALUE cannot be. Each paired position's buy and sell values are rounded to
 * the paisa, so N positions carry up to 2N half-paisa residues that no longer
 * cancel — a ceiling of N × 0.01, and it is REACHED in the direction of the
 * rounding, not in some vanishing fraction of runs. A real 7,544-execution
 * Paytm book lands 4 paise out on ₹75.8 crore of turnover and a 3,530-fill
 * Zerodha book 1 paisa out, and both were being reported as
 * "conservation check FAILED — please report this file" (found on the owner's
 * own demo files, 2026-08-30). That warning is meant for the case where the
 * pairing dropped a lot, which moves whole rupees and almost always moves
 * quantity too; at 1e-9 of turnover it was crying wolf on correct arithmetic,
 * on screen, during a demo.
 *
 * So the tolerance is derived from the rounding that produces it, not picked:
 * `positions × 0.01`, with a floor for tiny books. A lost lot is orders of
 * magnitude above it and still fails loudly.
 */
export function summarisePairing(legs: Leg[], paired: PairedPosition[]): PairSummary {
  const inBuyQty = legs.filter((l) => l.side === "buy").reduce((s, l) => s + l.qty, 0);
  const inSellQty = legs.filter((l) => l.side === "sell").reduce((s, l) => s + l.qty, 0);
  const outBuyQty = paired.reduce((s, p) => s + p.buyQty, 0);
  const outSellQty = paired.reduce((s, p) => s + p.sellQty, 0);

  const inValue = legs.reduce((s, l) => s + l.value, 0);
  const outValue = paired.reduce((s, p) => s + p.buyValue + p.sellValue, 0);

  const qtyDelta = r2(outBuyQty - inBuyQty + (outSellQty - inSellQty));
  const valueDelta = r2(outValue - inValue);
  const valueTolerance = r2(Math.max(0.05, paired.length * 0.01));

  return {
    closed: paired.filter((p) => p.kind === "closed").length,
    open: paired.filter((p) => p.kind === "open").length,
    openingSells: paired.filter((p) => p.kind === "opening-sell").length,
    qtyDelta,
    valueDelta,
    valueTolerance,
    conserved: qtyDelta === 0 && Math.abs(valueDelta) <= valueTolerance,
  };
}
