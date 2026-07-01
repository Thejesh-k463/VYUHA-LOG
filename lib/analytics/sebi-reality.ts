// IND-16 — SEBI reality-check & discipline nudge (PURE, no DB/React).
//
// SEBI's studies on individual traders in the equity-derivatives (F&O) segment
// found the overwhelming majority lose money. This module positions the user's
// OWN realised F&O record against that backdrop — a behavioural guardrail, not
// advice. Facts are static, dated and attributed; treat as informational.

export interface SebiFacts {
  period: string;
  lossMakingPct: number; // % of individual F&O traders with net losses
  avgNetLoss: number; // ₹ average net loss per loss-making trader
  sourceNote: string;
}

// SEBI study on individual traders in equity F&O, published Sept 2024 (FY2024).
export const SEBI_FNO_FACTS: SebiFacts = {
  period: "FY2024",
  lossMakingPct: 91.1,
  avgNetLoss: 120000,
  sourceNote: "SEBI study on individual traders in the equity F&O segment, Sept 2024.",
};

const FNO_SEGMENTS = new Set([
  "stock_option",
  "index_option",
  "future",
  "commodity_future",
  "commodity_option",
]);

export function isFnoSegment(segment: string): boolean {
  return FNO_SEGMENTS.has(segment);
}

export interface FnoTradeInput {
  segment: string;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  isOpen: boolean;
}

export interface FnoReality {
  closed: number; // closed F&O trades counted
  wins: number;
  losses: number;
  winRatePct: number;
  netPnl: number;
  grossPnl: number;
  chargesTotal: number;
  chargeDragPct: number; // charges as % of |gross F&O P&L|
  avgPerTrade: number; // expectancy (net ÷ trades)
  avgWin: number;
  avgLoss: number; // negative
  profitFactor: number | null; // gross win ÷ |gross loss|
  biggestLoss: number; // most negative single net
  profitable: boolean; // netPnl > 0
  hasData: boolean;
  verdict: string;
  facts: SebiFacts;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeFnoReality(
  trades: FnoTradeInput[],
  facts: SebiFacts = SEBI_FNO_FACTS,
): FnoReality {
  const fno = trades.filter((t) => isFnoSegment(t.segment) && !t.isOpen);
  const empty: FnoReality = {
    closed: 0, wins: 0, losses: 0, winRatePct: 0, netPnl: 0, grossPnl: 0,
    chargesTotal: 0, chargeDragPct: 0, avgPerTrade: 0, avgWin: 0, avgLoss: 0,
    profitFactor: null, biggestLoss: 0, profitable: false, hasData: false,
    verdict: "No closed F&O trades yet — when you trade derivatives, this card benchmarks your edge against SEBI's findings.",
    facts,
  };
  if (fno.length === 0) return empty;

  const winners = fno.filter((t) => t.netPnl > 0);
  const losers = fno.filter((t) => t.netPnl < 0);
  const netPnl = fno.reduce((s, t) => s + t.netPnl, 0);
  const grossPnl = fno.reduce((s, t) => s + t.grossPnl, 0);
  const chargesTotal = fno.reduce((s, t) => s + t.chargesTotal, 0);
  const grossWin = winners.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = losers.reduce((s, t) => s + t.netPnl, 0); // negative
  const profitable = netPnl > 0;

  return {
    closed: fno.length,
    wins: winners.length,
    losses: losers.length,
    winRatePct: r2((winners.length / fno.length) * 100),
    netPnl: r2(netPnl),
    grossPnl: r2(grossPnl),
    chargesTotal: r2(chargesTotal),
    chargeDragPct: r2((chargesTotal / Math.max(Math.abs(grossPnl), 1)) * 100),
    avgPerTrade: r2(netPnl / fno.length),
    avgWin: winners.length ? r2(grossWin / winners.length) : 0,
    avgLoss: losers.length ? r2(grossLoss / losers.length) : 0,
    profitFactor: grossLoss < 0 ? r2(grossWin / Math.abs(grossLoss)) : grossWin > 0 ? null : 0,
    biggestLoss: r2(fno.reduce((m, t) => Math.min(m, t.netPnl), 0)),
    profitable,
    hasData: true,
    verdict: profitable
      ? `Your F&O book is net positive — you're in the minority (~${r2(100 - facts.lossMakingPct)}%) SEBI found profitable. The edge is thin and costs compound; protect it with strict size and stops.`
      : `Your F&O book is net negative — the same outcome SEBI found for ~${facts.lossMakingPct}% of individual traders. Cut size, demand an edge per trade, or step back from derivatives.`,
    facts,
  };
}
