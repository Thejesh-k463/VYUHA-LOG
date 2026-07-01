// Pre-trade charges calculator (PURE). Reuses the paise charges engine so the
// quoted brokerage/STT/etc. exactly match what a real trade would book. Works for
// equity (delivery / intraday / MTF) and F&O (option / future), long or short, and
// projects the cost across N trades. Money is integer paise; prices are rupees.

import { computeChargesPaise, type ChargeBreakdownPaise } from "@/lib/engine/charges";
import type { ChargeRates } from "@/lib/engine/types";
import type { Segment } from "@/lib/domain/constants";

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
    numTrades: N,
    totalChargesPaise: chargesPerTradePaise * N,
    totalSttPaise: tgt.charges.sttCtt * N,
    totalNetTargetPaise: tgt.netPaise * N,
    totalNetSlPaise: sl.netPaise * N,
  };
}
