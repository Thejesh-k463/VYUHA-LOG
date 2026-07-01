// Option Greeks (PURE, no DB/React) — a bounded slice of the P1.2 "portfolio risk v2"
// roadmap item. Black-Scholes delta/gamma/theta/vega for a single option leg, plus a
// portfolio aggregator. No live feed exists yet (Vyuha stays offline-first), so implied
// volatility is either user-entered per position or falls back to a flat estimate — this
// is an APPROXIMATION for decision support, not a pricing-desk-grade model:
//   • Indian index options (NIFTY, BANKNIFTY, SENSEX…) are European-style — Black-Scholes
//     is exact for these.
//   • Indian stock options are American-style — Black-Scholes is the standard retail
//     approximation (ignores early-exercise value), same simplification brokers use.
// Position Greeks are signed: short flips the raw per-unit Greeks (short = short
// gamma/vega, long theta — the seller's decay works in their favour).

export type OptionType = "CE" | "PE";
export type Side = "long" | "short";

export const DEFAULT_RISK_FREE_RATE = 0.07; // India ~7% — same convention as performance.ts
export const DEFAULT_IV_PCT = 20; // flat fallback when no per-position IV is set

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Standard normal PDF. */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** erf via the Abramowitz–Stegun 7.1.26 approximation (max error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF. */
function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export interface BlackScholesResult {
  price: number; // theoretical premium
  delta: number; // per-unit, unitless (0..1 call, -1..0 put)
  gamma: number; // per-unit, per ₹1 move in the underlying
  thetaPerDay: number; // per-unit, ₹ premium decay per calendar day
  vega: number; // per-unit, ₹ premium change per 1 percentage-point IV move
}

/**
 * Per-unit (per-share) Black-Scholes price + Greeks.
 * @param spot   underlying price
 * @param strike option strike
 * @param dte    days to expiry (calendar)
 * @param ivPct  implied volatility, as a percentage (e.g. 20 for 20%)
 * @param rate   annual risk-free rate as a fraction (default DEFAULT_RISK_FREE_RATE)
 */
export function blackScholes(
  spot: number,
  strike: number,
  dte: number,
  optionType: OptionType,
  ivPct: number,
  rate: number = DEFAULT_RISK_FREE_RATE,
): BlackScholesResult {
  const isCall = optionType === "CE";
  const T = dte / 365;
  const sigma = ivPct / 100;

  // Expired / no time value left, or a degenerate vol input: fall back to intrinsic
  // value with the boundary Greeks (no gamma/vega/theta once time value is gone).
  if (spot <= 0 || strike <= 0 || T <= 0 || sigma <= 0) {
    const intrinsic = isCall ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
    const itm = isCall ? spot > strike : spot < strike;
    return { price: r2(intrinsic), delta: itm ? (isCall ? 1 : -1) : 0, gamma: 0, thetaPerDay: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (rate + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-rate * T);
  const pdf1 = normPdf(d1);

  const price = isCall
    ? spot * normCdf(d1) - strike * disc * normCdf(d2)
    : strike * disc * normCdf(-d2) - spot * normCdf(-d1);

  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdf1 / (spot * sigma * sqrtT);
  const vega = (spot * pdf1 * sqrtT) / 100; // per 1 percentage-point IV move
  const thetaAnnual = isCall
    ? -(spot * pdf1 * sigma) / (2 * sqrtT) - rate * strike * disc * normCdf(d2)
    : -(spot * pdf1 * sigma) / (2 * sqrtT) + rate * strike * disc * normCdf(-d2);

  return {
    price: r2(price),
    delta: r4(delta),
    gamma: r4(gamma),
    thetaPerDay: r2(thetaAnnual / 365),
    vega: r2(vega),
  };
}

export type IvSource = "position" | "market" | "default";

export interface PositionGreeksInput {
  id: number;
  symbol: string;
  spot: number | null; // underlying spot; null = can't price
  strike: number;
  dte: number | null; // null = no expiry on record
  optionType: OptionType;
  ivPct: number | null; // per-position IV the user entered; null = fall back
  marketIvPct?: number | null; // IND-12 — latest India VIX close, used when no per-position IV is set
  qty: number; // total units (lots × lot size)
  side: Side;
}

export interface PositionGreeks {
  id: number;
  symbol: string;
  ivPct: number; // the IV actually used (position, market, or flat default)
  ivIsDefault: boolean; // true whenever NOT the user's own per-position IV (market or flat)
  ivSource: IvSource;
  perUnit: BlackScholesResult;
  // Position-level (scaled by qty and signed for side — short flips the raw Greeks).
  delta: number;
  gamma: number;
  thetaPerDay: number;
  vega: number;
}

/**
 * Three-tier IV fallback: the position's own entered IV, else the latest market-wide
 * IV proxy (India VIX), else the flat DEFAULT_IV_PCT. Exported standalone so the exact
 * chain is independently testable.
 */
export function resolveIvSource(ivPct: number | null, marketIvPct: number | null | undefined): { ivPct: number; source: IvSource } {
  if (ivPct != null && ivPct > 0) return { ivPct, source: "position" };
  if (marketIvPct != null && marketIvPct > 0) return { ivPct: marketIvPct, source: "market" };
  return { ivPct: DEFAULT_IV_PCT, source: "default" };
}

/** Position Greeks for one open option leg. Returns null if it can't be priced (no spot/dte). */
export function positionGreeks(p: PositionGreeksInput): PositionGreeks | null {
  if (p.spot == null || p.dte == null || p.qty <= 0) return null;
  const { ivPct, source } = resolveIvSource(p.ivPct, p.marketIvPct);
  const perUnit = blackScholes(p.spot, p.strike, p.dte, p.optionType, ivPct);
  const sign = p.side === "long" ? 1 : -1;
  return {
    id: p.id,
    symbol: p.symbol,
    ivPct,
    ivIsDefault: source !== "position",
    ivSource: source,
    perUnit,
    delta: r2(perUnit.delta * p.qty * sign),
    gamma: r4(perUnit.gamma * p.qty * sign),
    thetaPerDay: r2(perUnit.thetaPerDay * p.qty * sign),
    vega: r2(perUnit.vega * p.qty * sign),
  };
}

export interface PortfolioGreeks {
  count: number; // positions successfully priced
  skipped: number; // positions missing spot/dte, excluded
  delta: number;
  gamma: number;
  thetaPerDay: number;
  vega: number;
  usingDefaultIvCount: number; // positions priced with the flat fallback IV
  positions: PositionGreeks[];
}

export function portfolioGreeks(inputs: PositionGreeksInput[]): PortfolioGreeks {
  const positions: PositionGreeks[] = [];
  let skipped = 0;
  for (const p of inputs) {
    const g = positionGreeks(p);
    if (g == null) { skipped++; continue; }
    positions.push(g);
  }
  const sum = (f: (g: PositionGreeks) => number) => r2(positions.reduce((s, g) => s + f(g), 0));
  return {
    count: positions.length,
    skipped,
    delta: sum((g) => g.delta),
    gamma: r4(positions.reduce((s, g) => s + g.gamma, 0)),
    thetaPerDay: sum((g) => g.thetaPerDay),
    vega: sum((g) => g.vega),
    usingDefaultIvCount: positions.filter((g) => g.ivIsDefault).length,
    positions,
  };
}
