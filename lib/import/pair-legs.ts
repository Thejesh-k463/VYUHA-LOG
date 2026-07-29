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
 * ── FIFO, deliberately ────────────────────────────────────────────────────
 *
 * Quantity is retired oldest-buy-first. This matches how Indian brokers and
 * the Income Tax Act treat equity delivery, so the holding periods produced
 * here agree with the ones that decide STCG vs LTCG. It is also what the
 * staged-position engine already does, so the two never disagree.
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

  // Open buy lots, oldest first — the FIFO queue.
  const lots: { date: string; qty: number; value: number; charges: number; product: Leg["product"] }[] = [];
  const out: PairedPosition[] = [];
  const orphanSells: Leg[] = [];

  for (const leg of legs) {
    if (leg.side === "buy") {
      if (leg.qty > 0) {
        lots.push({ date: leg.date, qty: leg.qty, value: leg.value, charges: leg.charges, product: leg.product });
      }
      continue;
    }

    // A sell consumes lots oldest-first.
    let remaining = leg.qty;
    let soldValue = leg.value;
    const sellCharges = leg.charges;
    const consumed: { date: string; qty: number; value: number; charges: number; product: Leg["product"] }[] = [];

    while (remaining > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.qty);
      const share = lot.qty > 0 ? take / lot.qty : 0;
      consumed.push({
        date: lot.date,
        qty: take,
        value: r2(lot.value * share),
        charges: r2(lot.charges * share),
        product: lot.product,
      });
      lot.qty -= take;
      lot.value = r2(lot.value * (1 - share));
      lot.charges = r2(lot.charges * (1 - share));
      remaining -= take;
      if (lot.qty <= 0) lots.shift();
    }

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
        sellValue: r2(soldValue * portion),
        // Entry is the OLDEST lot consumed: FIFO decides the holding period.
        buyDate: consumed[0].date,
        sellDate: leg.date,
        charges: r2(consumed.reduce((s, c) => s + c.charges, 0) + sellCharges * portion),
        product: resolveProduct([...consumed.map((c) => c.product), leg.product]),
        basisUnknown: false,
        notes: [],
      });
      soldValue = r2(soldValue * (1 - portion));
    }

    if (remaining > 0) {
      // Nothing left to match against — acquired before this file begins.
      orphanSells.push({ ...leg, qty: remaining, value: soldValue, charges: consumed.length > 0 ? 0 : sellCharges });
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
    if (lot.qty <= 0) continue;
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

  return out;
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
}

/**
 * Conservation check.
 *
 * FIFO moves quantity and value between records, so the only way to know it
 * did not silently drop or duplicate any is to compare the totals before and
 * after. A non-zero delta here is a bug, not a rounding artefact.
 */
export function summarisePairing(legs: Leg[], paired: PairedPosition[]): PairSummary {
  const inBuyQty = legs.filter((l) => l.side === "buy").reduce((s, l) => s + l.qty, 0);
  const inSellQty = legs.filter((l) => l.side === "sell").reduce((s, l) => s + l.qty, 0);
  const outBuyQty = paired.reduce((s, p) => s + p.buyQty, 0);
  const outSellQty = paired.reduce((s, p) => s + p.sellQty, 0);

  const inValue = legs.reduce((s, l) => s + l.value, 0);
  const outValue = paired.reduce((s, p) => s + p.buyValue + p.sellValue, 0);

  return {
    closed: paired.filter((p) => p.kind === "closed").length,
    open: paired.filter((p) => p.kind === "open").length,
    openingSells: paired.filter((p) => p.kind === "opening-sell").length,
    qtyDelta: r2(outBuyQty - inBuyQty + (outSellQty - inSellQty)),
    valueDelta: r2(outValue - inValue),
  };
}
