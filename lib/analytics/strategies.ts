// IND-10 — Option strategy recognition + payoff diagrams (PURE, no DB/React).
//
// Groups open option legs by underlying+expiry, names the strategy (straddle,
// strangle, vertical spread, iron condor/butterfly, …) and computes the EXACT
// expiry payoff: net debit/credit, max profit, max loss, breakevens and the
// payoff curve. Payoff at expiry is model-free (intrinsic value only) — no IV or
// pricing model needed. (Live Greeks need an IV feed; out of scope here.)

export interface OptionLeg {
  id?: number;
  optionType: "CE" | "PE";
  strike: number;
  side: "long" | "short";
  qty: number; // contracts (shares = lots × lot size)
  premium: number; // entry premium per unit
}

export interface StrategyGroup {
  key: string;
  symbol: string;
  expiry: string | null;
  name: string;
  legs: OptionLeg[];
  netPremium: number; // ₹ total; + = net credit received, − = net debit paid
  isCredit: boolean;
  maxProfit: number | null; // ₹ ; null = unbounded
  maxLoss: number | null; // ₹ (negative) ; null = unbounded
  breakevens: number[];
  payoff: { price: number; pnl: number }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Total P&L of the position if the underlying settles at price S at expiry. */
export function payoffAt(legs: OptionLeg[], S: number): number {
  let pnl = 0;
  for (const l of legs) {
    const intrinsic = l.optionType === "CE" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    const per = l.side === "long" ? intrinsic - l.premium : l.premium - intrinsic;
    pnl += per * l.qty;
  }
  return pnl;
}

/** Net premium: credit (+) when you collect more than you pay. */
export function netPremium(legs: OptionLeg[]): number {
  return legs.reduce((s, l) => s + (l.side === "short" ? l.premium : -l.premium) * l.qty, 0);
}

export function classifyStrategy(legs: OptionLeg[]): string {
  const n = legs.length;
  if (n === 0) return "Empty";
  const calls = legs.filter((l) => l.optionType === "CE");
  const puts = legs.filter((l) => l.optionType === "PE");
  const longs = legs.filter((l) => l.side === "long");
  const shorts = legs.filter((l) => l.side === "short");
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);

  if (n === 1) {
    const l = legs[0];
    return `${l.side === "long" ? "Long" : "Short"} ${l.optionType === "CE" ? "Call" : "Put"}`;
  }

  if (n === 2) {
    // one call + one put → straddle (same strike) / strangle (different)
    if (calls.length === 1 && puts.length === 1 && legs[0].side === legs[1].side) {
      const kind = strikes.length === 1 ? "Straddle" : "Strangle";
      return `${legs[0].side === "long" ? "Long" : "Short"} ${kind}`;
    }
    // same type, two strikes, opposite sides → vertical spread
    if (strikes.length === 2 && longs.length === 1 && shorts.length === 1) {
      if (calls.length === 2) {
        return longs[0].strike < shorts[0].strike ? "Bull Call Spread" : "Bear Call Spread";
      }
      if (puts.length === 2) {
        return longs[0].strike > shorts[0].strike ? "Bear Put Spread" : "Bull Put Spread";
      }
    }
    return "Custom (2 legs)";
  }

  if (n === 3 && (calls.length === 3 || puts.length === 3) && longs.length === 2 && shorts.length === 1) {
    // wings long, body short → butterfly
    const body = shorts[0];
    const wings = longs.map((l) => l.strike).sort((a, b) => a - b);
    if (body.strike > wings[0] && body.strike < wings[1]) {
      return `${calls.length === 3 ? "Call" : "Put"} Butterfly`;
    }
  }

  if (n === 4 && calls.length === 2 && puts.length === 2 && shorts.length === 2 && longs.length === 2) {
    const shortCall = calls.find((l) => l.side === "short");
    const shortPut = puts.find((l) => l.side === "short");
    if (shortCall && shortPut) {
      return shortCall.strike === shortPut.strike ? "Iron Butterfly" : "Iron Condor";
    }
  }

  return `Custom (${n} legs)`;
}

export function computeStrategy(symbol: string, expiry: string | null, legs: OptionLeg[]): StrategyGroup {
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const minK = strikes[0];
  const maxK = strikes[strikes.length - 1];
  const pad = Math.max((maxK - minK) * 0.6, maxK * 0.15, 50);
  const cLo = Math.max(0, minK - pad);
  const cHi = maxK + pad;

  // Net slope as S→∞ decides upside boundedness (calls only; downside bounded at S=0).
  const callSlopeUp = legs
    .filter((l) => l.optionType === "CE")
    .reduce((s, l) => s + (l.side === "long" ? l.qty : -l.qty), 0);

  // Analytic vertices (payoff is piecewise-linear with kinks at strikes).
  const vertices = [0, ...strikes, cHi].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const vy = vertices.map((p) => ({ price: p, pnl: payoffAt(legs, p) }));

  const finiteMax = Math.max(...vy.map((v) => v.pnl));
  const finiteMin = Math.min(...vy.map((v) => v.pnl));
  const maxProfit = callSlopeUp > 0 ? null : r2(finiteMax);
  const maxLoss = callSlopeUp < 0 ? null : r2(finiteMin);

  // Breakevens: zero-crossings across the analytic vertices.
  const breakevens: number[] = [];
  for (let i = 1; i < vy.length; i++) {
    const a = vy[i - 1];
    const b = vy[i];
    if ((a.pnl <= 0 && b.pnl > 0) || (a.pnl >= 0 && b.pnl < 0)) {
      const be = a.price + ((b.price - a.price) * (0 - a.pnl)) / (b.pnl - a.pnl);
      if (Number.isFinite(be)) breakevens.push(r2(be));
    }
  }

  // Chart series: evenly sampled across a focused range (exact since piecewise-linear).
  const N = 61;
  const payoff = Array.from({ length: N }, (_, i) => {
    const price = cLo + ((cHi - cLo) * i) / (N - 1);
    return { price: r2(price), pnl: r2(payoffAt(legs, price)) };
  });

  const np = netPremium(legs);
  return {
    key: `${symbol}|${expiry ?? "—"}`,
    symbol,
    expiry,
    name: classifyStrategy(legs),
    legs,
    netPremium: r2(np),
    isCredit: np > 0,
    maxProfit,
    maxLoss,
    breakevens: [...new Set(breakevens)],
    payoff,
  };
}

export interface PositionedLeg extends OptionLeg {
  symbol: string;
  expiry: string | null;
}

/** Group legs by underlying+expiry and build a strategy per group. */
export function buildStrategies(legs: PositionedLeg[]): StrategyGroup[] {
  const groups = new Map<string, PositionedLeg[]>();
  for (const l of legs) {
    const key = `${l.symbol}|${l.expiry ?? "—"}`;
    const arr = groups.get(key) ?? [];
    arr.push(l);
    groups.set(key, arr);
  }
  return [...groups.values()]
    .map((g) => computeStrategy(g[0].symbol, g[0].expiry, g.map(({ symbol: _s, expiry: _e, ...leg }) => leg)))
    .sort((a, b) => (a.expiry ?? "").localeCompare(b.expiry ?? "") || a.symbol.localeCompare(b.symbol));
}
