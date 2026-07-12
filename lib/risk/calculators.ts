// Pure risk calculators (position sizing, option lots, daily-loss cockpit, MTF
// break-even). No DB/React deps — usable on server and client.

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Planned reward:risk ratio at entry — "risking 1 to make X" — using the
 * ORIGINAL stop and target (not the trailing SL, which tightens as a trade
 * moves and would understate the risk actually taken at entry). Distinct from
 * the LIVE R-multiple (unrealised P&L ÷ risk amount, which changes every
 * tick); this is the static plan made before the trade was placed.
 */
export function plannedRewardRisk(entry: number, sl: number | null, target: number | null): number | null {
  if (sl == null || target == null || !(entry > 0)) return null;
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return null;
  return r2(reward / risk);
}

export interface PositionSizeInput {
  entry: number;
  stop: number;
  riskAmount: number; // ₹ willing to lose (default ₹9,500)
  lotSize?: number; // for derivatives — round qty down to whole lots
}

export interface PositionSizeResult {
  riskPerUnit: number;
  maxQty: number; // shares / units (lot-aligned if lotSize given)
  lots: number | null;
  totalRisk: number; // actual risk at maxQty
  capitalRequired: number; // entry × maxQty
}

/** Max quantity so that risk ≤ riskAmount, given entry & stop. */
export function positionSize(i: PositionSizeInput): PositionSizeResult {
  const riskPerUnit = Math.abs(i.entry - i.stop);
  if (riskPerUnit <= 0 || i.riskAmount <= 0) {
    return { riskPerUnit: 0, maxQty: 0, lots: i.lotSize ? 0 : null, totalRisk: 0, capitalRequired: 0 };
  }
  let qty = Math.floor(i.riskAmount / riskPerUnit);
  let lots: number | null = null;
  if (i.lotSize && i.lotSize > 0) {
    lots = Math.floor(qty / i.lotSize);
    qty = lots * i.lotSize;
  }
  return {
    riskPerUnit: r2(riskPerUnit),
    maxQty: qty,
    lots,
    totalRisk: r2(qty * riskPerUnit),
    capitalRequired: r2(qty * i.entry),
  };
}

export interface OptionSizeInput {
  premium: number; // entry premium per unit
  stopPremium: number; // SL premium per unit
  lotSize: number;
  riskAmount: number;
}

export interface OptionSizeResult {
  riskPerLot: number;
  maxLots: number;
  totalRisk: number;
  premiumOutlay: number; // premium × lotSize × lots (for buyers)
}

/** Max lots for an option so risk ≤ riskAmount. */
export function optionLotSize(i: OptionSizeInput): OptionSizeResult {
  const perUnit = Math.abs(i.premium - i.stopPremium);
  const riskPerLot = perUnit * i.lotSize;
  if (riskPerLot <= 0 || i.riskAmount <= 0) {
    return { riskPerLot: 0, maxLots: 0, totalRisk: 0, premiumOutlay: 0 };
  }
  const maxLots = Math.floor(i.riskAmount / riskPerLot);
  return {
    riskPerLot: r2(riskPerLot),
    maxLots,
    totalRisk: r2(maxLots * riskPerLot),
    premiumOutlay: r2(maxLots * i.lotSize * i.premium),
  };
}

export interface DailyLossInput {
  netToday: number; // realised net P&L today (can be negative)
  dailyStop: number; // e.g. ₹25,000
}
export interface DailyLossStatus {
  netToday: number;
  limit: number;
  lossSoFar: number; // positive number if losing
  remaining: number; // ₹ of loss budget left before stop
  hit: boolean;
  pctUsed: number; // 0..1
}

/** Daily aggregate max-loss cockpit. */
export function dailyLossStatus(i: DailyLossInput): DailyLossStatus {
  const loss = i.netToday < 0 ? -i.netToday : 0;
  const hit = loss >= i.dailyStop && i.dailyStop > 0;
  return {
    netToday: r2(i.netToday),
    limit: i.dailyStop,
    lossSoFar: r2(loss),
    remaining: r2(Math.max(0, i.dailyStop - loss)),
    hit,
    pctUsed: i.dailyStop > 0 ? Math.min(1, loss / i.dailyStop) : 0,
  };
}

export interface CounterStatus {
  used: number;
  limit: number;
  remaining: number;
  pctUsed: number;
  warn: boolean; // approaching (≥80%)
  exceeded: boolean;
}

/** Generic max-count monitor (trades/day, open positions). */
export function counter(used: number, limit: number, warnAt = 0.8): CounterStatus {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    pctUsed: limit > 0 ? used / limit : 0,
    warn: limit > 0 && used / limit >= warnAt && used < limit,
    exceeded: used > limit,
  };
}

export interface MtfBreakevenInput {
  fundedAmount: number;
  annualRate: number; // e.g. 0.1349
  days: number;
  positionValue: number; // total position value
  otherCharges?: number; // brokerage + statutory etc.
}
export interface MtfBreakevenResult {
  interest: number;
  totalCost: number;
  breakevenMovePct: number; // % the price must move to cover cost
  dailyInterest: number;
}

/** MTF interest accrual + break-even move % to cover interest + charges. */
export function mtfBreakeven(i: MtfBreakevenInput): MtfBreakevenResult {
  const interest = (i.fundedAmount * i.annualRate * Math.max(0, i.days)) / 365;
  const totalCost = interest + (i.otherCharges ?? 0);
  return {
    interest: r2(interest),
    totalCost: r2(totalCost),
    breakevenMovePct: i.positionValue > 0 ? r2((totalCost / i.positionValue) * 100) : 0,
    dailyInterest: r2((i.fundedAmount * i.annualRate) / 365),
  };
}

/** Concentration of a single position vs bucket capital. */
export function concentrationPct(positionValue: number, bucketCapital: number): number {
  return bucketCapital > 0 ? r2((positionValue / bucketCapital) * 100) : 0;
}
