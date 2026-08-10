// Pre-trade charges calculator (PURE). Reuses the paise charges engine so the
// quoted brokerage/STT/etc. exactly match what a real trade would book. Works for
// equity (delivery / intraday / MTF) and F&O (option / future), long or short, and
// projects the cost across N trades. Money is integer paise; prices are rupees.

import { computeChargesPaise, mtfRateFor, type ChargeBreakdownPaise } from "@/lib/engine/charges";
import type { ChargeRates } from "@/lib/engine/types";
import type { OptionType, Segment } from "@/lib/domain/constants";
import { mtfBreakeven } from "@/lib/risk/calculators";
import { capitalBlocked, type MarginRates } from "@/lib/risk/margin";

export type Side = "long" | "short";

export interface TradeCalcInput {
  segment: Segment;
  side: Side;
  entry: number; // ₹ per unit (premium for options)
  sl: number;
  target: number;
  qty: number; // shares (equity) or lots × lot size (F&O)
  buyOrders?: number;
  sellOrders?: number;
  mtf?: { fundedAmount: number; daysHeld: number } | null; // ₹
  numTrades?: number;
}

export interface Scenario {
  exitPrice: number;
  grossPaise: number;
  charges: ChargeBreakdownPaise;
  netPaise: number;
  netPctOnTurnover: number;
}

/**
 * The MTF financing lens — what the broker's money costs, and how far the price
 * has to move before the position is merely square. Only ever populated for a
 * funded `eq_mtf` trade; `null` everywhere else rather than a zero, because a
 * delivery trade has no financing cost to report, it has *no such thing*.
 */
export interface MtfCostView {
  /** Annual rate actually applied (tier-aware — see `mtfRateFor`). */
  annualRate: number;
  fundedAmount: number; // ₹ financed by the broker
  positionValue: number; // ₹ entry × qty
  interestPaise: number; // financing cost over the held days
  otherChargesPaise: number; // round-trip charges EXCLUDING that interest
  totalCostPaise: number;
  /** % the price must move from entry just to cover interest + charges. */
  breakevenMovePct: number;
  dailyInterestPaise: number;
}

export interface TradeCalcResult {
  qty: number;
  side: Side;
  buyTurnoverPaise: number; // entry notional
  target: Scenario;
  sl: Scenario;
  rewardPaise: number; // net at target
  riskPaise: number; // net at SL (negative for a loss)
  rrGross: number | null;
  rrNet: number | null;
  chargesPerTradePaise: number; // round-trip charges (target scenario)
  chargesPctOfTurnover: number;
  breakevenPrice: number; // price needed to cover round-trip charges
  /** MTF carry + breakeven MOVE %; null when the trade is not funded. */
  mtfCost: MtfCostView | null;
  numTrades: number;
  totalChargesPaise: number;
  totalSttPaise: number;
  totalNetTargetPaise: number;
  totalNetSlPaise: number;
}

const P = (rupees: number) => Math.round(rupees * 100);
const r2 = (n: number) => Math.round(n * 100) / 100;

function scenario(input: TradeCalcInput, rates: ChargeRates, exitPrice: number): Scenario {
  const qty = input.qty;
  const longLike = input.side === "long";
  // Map entry/exit onto buy/sell legs so STT (sell side) and stamp (buy side) land correctly.
  const buyPrice = longLike ? input.entry : exitPrice;
  const sellPrice = longLike ? exitPrice : input.entry;
  const buyValue = P(buyPrice * qty);
  const sellValue = P(sellPrice * qty);

  const charges = computeChargesPaise(
    {
      segment: input.segment,
      buyValue,
      sellValue,
      buyQty: qty,
      sellQty: qty,
      buyOrderCount: input.buyOrders ?? 1,
      sellOrderCount: input.sellOrders ?? 1,
      mtf: input.mtf ? { fundedAmount: P(input.mtf.fundedAmount), daysHeld: input.mtf.daysHeld, pledgeScrips: 1 } : null,
    },
    rates,
  );

  const grossPaise = P((longLike ? exitPrice - input.entry : input.entry - exitPrice) * qty);
  const netPaise = grossPaise - charges.total;
  const turnover = P(input.entry * qty);
  return { exitPrice, grossPaise, charges, netPaise, netPctOnTurnover: turnover > 0 ? r2((netPaise / turnover) * 100) : 0 };
}

/**
 * Breakeven MOVE % and daily carry for a funded MTF position, via the shared
 * `mtfBreakeven` risk calculator so the calculator and the /risk cockpit can
 * never quote a different cost of carry for the same position.
 *
 * `otherCharges` is the round-trip total MINUS the engine's own MTF interest —
 * feeding the whole total in would count the financing twice.
 */
function mtfCostView(input: TradeCalcInput, rates: ChargeRates, charges: ChargeBreakdownPaise): MtfCostView | null {
  if (input.segment !== "eq_mtf" || !input.mtf || !(input.mtf.fundedAmount > 0)) return null;
  const positionValue = input.entry * input.qty;
  const annualRate = mtfRateFor(input.mtf.fundedAmount, rates);
  const be = mtfBreakeven({
    fundedAmount: input.mtf.fundedAmount,
    annualRate,
    days: input.mtf.daysHeld,
    positionValue,
    otherCharges: (charges.total - charges.mtfInterest) / 100,
  });
  return {
    annualRate,
    fundedAmount: r2(input.mtf.fundedAmount),
    positionValue: r2(positionValue),
    interestPaise: P(be.interest),
    otherChargesPaise: charges.total - charges.mtfInterest,
    totalCostPaise: P(be.totalCost),
    breakevenMovePct: be.breakevenMovePct,
    dailyInterestPaise: P(be.dailyInterest),
  };
}

export function computeTradeCalc(input: TradeCalcInput, rates: ChargeRates): TradeCalcResult {
  const qty = input.qty;
  const buyTurnoverPaise = P(input.entry * qty);
  const tgt = scenario(input, rates, input.target);
  const sl = scenario(input, rates, input.sl);
  const N = Math.max(1, Math.floor(input.numTrades ?? 1));

  const grossReward = Math.abs(tgt.grossPaise);
  const grossRisk = Math.abs(sl.grossPaise);
  const rrGross = grossRisk > 0 ? r2(grossReward / grossRisk) : null;
  const rrNet = sl.netPaise < 0 && tgt.netPaise > 0 ? r2(tgt.netPaise / Math.abs(sl.netPaise)) : null;

  const chargesPerTradePaise = tgt.charges.total;
  const breakevenMove = qty > 0 ? chargesPerTradePaise / 100 / qty : 0;
  const breakevenPrice = r2(input.side === "long" ? input.entry + breakevenMove : input.entry - breakevenMove);

  return {
    qty,
    side: input.side,
    buyTurnoverPaise,
    target: tgt,
    sl,
    rewardPaise: tgt.netPaise,
    riskPaise: sl.netPaise,
    rrGross,
    rrNet,
    chargesPerTradePaise,
    chargesPctOfTurnover: buyTurnoverPaise > 0 ? r2((chargesPerTradePaise / buyTurnoverPaise) * 100) : 0,
    breakevenPrice,
    mtfCost: mtfCostView(input, rates, tgt.charges),
    numTrades: N,
    totalChargesPaise: chargesPerTradePaise * N,
    totalSttPaise: tgt.charges.sttCtt * N,
    totalNetTargetPaise: tgt.netPaise * N,
    totalNetSlPaise: sl.netPaise * N,
  };
}

// ───────────────────────── reverse solve: target for a net R:R ──────────────

export interface ReverseTargetInput {
  segment: Segment;
  side: Side;
  entry: number;
  sl: number;
  qty: number;
  buyOrders?: number;
  sellOrders?: number;
  mtf?: { fundedAmount: number; daysHeld: number } | null;
  /** Desired reward:risk AFTER every charge (2 = "make 2 for every 1 risked"). */
  desiredRR: number;
}

export interface ReverseTargetResult {
  /** ₹ per unit, rounded to the paisa, always on the profitable side of entry. */
  target: number;
  /** Net R:R actually delivered at that price — always ≥ `desiredRR`. */
  achievedRR: number;
  netRewardPaise: number;
  netRiskPaise: number; // negative
  requiredNetRewardPaise: number;
  /** Charge evaluations spent. Diagnostic; the answer does not depend on it. */
  iterations: number;
}

/** Enough halvings to resolve any sane price to well under a paisa. */
const MAX_BISECTIONS = 80;
/** Doubling the search window 60× overflows long before it gives up honestly. */
const MAX_EXPANSIONS = 60;
/** Paise of local walk allowed to step over a statutory rounding jump. */
const MAX_NUDGE_PAISE = 400;

/**
 * The target price that yields a given NET reward:risk — the inverse of
 * `computeTradeCalc`.
 *
 * ── Why this is not algebra ────────────────────────────────────────────────
 *
 * Reward is `(target − entry) × qty − charges(target)`, and charges are
 * turnover-linked: raising the target raises the sell value, which raises
 * brokerage, exchange, SEBI, IPFT, GST and STT. So `target` appears on both
 * sides. Worse, the function is not even smooth — STT/CTT and stamp duty round
 * to the whole RUPEE, and the DP fee switches on at `dpMinValue`, so net-at-
 * target is a monotone STAIRCASE, not a line. Inverting the linear part and
 * calling it done overshoots or undershoots by the whole staircase.
 *
 * ── Method ─────────────────────────────────────────────────────────────────
 *
 *  1. Net-at-SL does not depend on the target at all, so it is evaluated ONCE.
 *     If it is not a loss there is no risk to scale against and the answer is
 *     `null` — a reward:risk with no risk in the denominator is not a number
 *     worth inventing.
 *  2. requiredReward = desiredRR × |netAtSL|.
 *  3. Bracket, then bisect on the predicate `net(price) ≥ requiredReward`,
 *     which is monotone in the direction of profit: for a long the window opens
 *     at `entry` (where net is exactly minus the charges, i.e. failing) and
 *     doubles outward until it passes; for a short it runs from `entry` down to
 *     a price of 0, the theoretical maximum profit. If the far end still fails,
 *     the ask is impossible and the answer is `null` — charges can genuinely
 *     exceed every reward a short can reach.
 *  4. Round the bisected price to the paisa AWAY from entry (never quote a
 *     target that under-delivers), then walk one paisa at a time over any
 *     rounding step until the recomputed net clears the bar.
 *
 * Pure and deterministic: same inputs, same rate card, same answer.
 */
export function solveTargetForNetRR(i: ReverseTargetInput, rates: ChargeRates): ReverseTargetResult | null {
  if (!(i.desiredRR > 0) || !(i.qty > 0) || !(i.entry > 0) || !(i.sl > 0)) return null;
  const long = i.side === "long";
  // The stop has to sit on the losing side of entry, or "risk" is meaningless.
  if (long ? i.sl >= i.entry : i.sl <= i.entry) return null;

  // `target` here is a placeholder — every evaluation passes its own exit price.
  const base: TradeCalcInput = {
    segment: i.segment,
    side: i.side,
    entry: i.entry,
    sl: i.sl,
    target: i.entry,
    qty: i.qty,
    buyOrders: i.buyOrders,
    sellOrders: i.sellOrders,
    mtf: i.mtf ?? null,
  };

  let iterations = 0;
  const netAt = (price: number): number => {
    iterations++;
    return scenario(base, rates, price).netPaise;
  };

  const netRiskPaise = netAt(i.sl);
  if (!(netRiskPaise < 0)) return null; // no loss at the stop ⇒ no denominator
  const required = Math.abs(netRiskPaise) * i.desiredRR;

  const passes = (price: number) => netAt(price) >= required;

  // ── bracket ───────────────────────────────────────────────────────────────
  let lo: number; // fails, for a long; passes, for a short
  let hi: number;
  if (long) {
    lo = i.entry;
    let span = Math.max(i.entry, 1);
    hi = i.entry + span;
    let n = 0;
    while (!passes(hi)) {
      if (++n > MAX_EXPANSIONS) return null;
      lo = hi;
      span *= 2;
      hi = i.entry + span;
    }
  } else {
    hi = i.entry; // zero profit at entry — fails
    lo = 0; // a price of 0 is the most a short can ever make
    if (!passes(lo)) return null; // charges swallow every achievable reward
  }

  // ── bisect ────────────────────────────────────────────────────────────────
  for (let n = 0; n < MAX_BISECTIONS && hi - lo > 0.005; n++) {
    const mid = (lo + hi) / 2;
    if (passes(mid)) {
      if (long) hi = mid;
      else lo = mid;
    } else if (long) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // ── settle on a real, quotable price ──────────────────────────────────────
  const step = 0.01;
  let target = long ? Math.ceil(hi * 100) / 100 : Math.max(0, Math.floor(lo * 100) / 100);
  let reward = netAt(target);
  for (let n = 0; n < MAX_NUDGE_PAISE && reward < required; n++) {
    const next = r2(long ? target + step : target - step);
    if (!long && next <= 0) return null;
    target = next;
    reward = netAt(target);
  }
  if (reward < required) return null;
  if (long ? target <= i.entry : target >= i.entry) return null;

  return {
    target,
    achievedRR: r2(reward / Math.abs(netRiskPaise)),
    netRewardPaise: reward,
    netRiskPaise,
    // Net P&L is whole paise, so ceil() is the exact bar the answer clears —
    // `netRewardPaise ≥ requiredNetRewardPaise` holds without a tolerance.
    requiredNetRewardPaise: Math.ceil(required),
    iterations,
  };
}

// ───────────────────────────── margin / capital blocked ─────────────────────

export interface CalcMarginInput {
  broker: string;
  segment: Segment;
  side: Side;
  qty: number;
  entry: number; // premium for options
  symbol?: string;
  strike?: number | null;
  optionType?: OptionType | null;
  /** Underlying spot, when the user knows it. Preferred over strike. */
  spot?: number | null;
  /** Per-stock MTF own-margin % resolved by the caller (upload → broker list). */
  mtfStockPct?: number | null;
}

export interface CalcMarginResult {
  /** Capital blocked, or null when it cannot be derived from these inputs. */
  marginPaise: number | null;
  basis: string | null;
  rateUsed: number | null;
  missingRate: string | null;
  /** Non-null when the margin is UNKNOWABLE here — says what is missing. */
  needs: string | null;
}

/**
 * Capital blocked for a hypothetical trade, through the same
 * `capitalBlocked` rule the live margin cockpit and the ROM report use.
 *
 * The one thing this adds is a refusal. A SHORT option's margin is a
 * percentage of the UNDERLYING notional; given neither strike nor spot,
 * `capitalBlocked` falls back to the premium as its reference level, which for
 * a ₹120 option on a ₹24,000 index understates the requirement by two orders
 * of magnitude. A pre-trade screen that quietly prints that number is worse
 * than one that prints nothing, so this returns `needs` instead (invariant #6).
 */
export function marginForTrade(i: CalcMarginInput, rates: MarginRates): CalcMarginResult {
  const none = (needs: string): CalcMarginResult => ({
    marginPaise: null, basis: null, rateUsed: null, missingRate: null, needs,
  });
  if (!(i.qty > 0) || !(i.entry > 0)) return none("enter a quantity and an entry price");

  const isOption = i.optionType === "CE" || i.optionType === "PE";
  const ref = (i.spot ?? 0) > 0 ? i.spot! : (i.strike ?? 0) > 0 ? i.strike! : null;
  if (isOption && i.side === "short" && ref == null) {
    return none("needs strike or spot — a short option blocks margin against the underlying notional, not the premium");
  }

  const b = capitalBlocked(
    {
      id: 0,
      symbol: i.symbol ?? "",
      bucket: i.segment.startsWith("eq_") ? "equity" : "active",
      broker: i.broker,
      segment: i.segment,
      side: i.side,
      qty: i.qty,
      entry: i.entry,
      // Pre-trade there is no live mark; entry IS the contract value at the
      // moment the capital would be committed (same stand-in ROM makes).
      mtm: i.entry,
      strike: i.strike ?? null,
      optionType: i.optionType ?? null,
      spot: i.spot ?? null,
      mtfStockPct: i.mtfStockPct ?? null,
    },
    rates,
  );

  return {
    marginPaise: P(b.margin),
    basis: b.basis,
    rateUsed: b.rateUsed,
    missingRate: b.missingRate,
    needs: null,
  };
}
