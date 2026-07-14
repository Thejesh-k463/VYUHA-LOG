// Per-trade MAE / MFE (PURE, no DB/React) — quick-win item unlocked by
// price_history (P1.3). For each CLOSED, dated trade whose symbol has EOD bars
// covering its holding window, compute the Maximum Adverse / Favorable
// Excursion from entry, plus how much of the favorable move the exit captured.
//
// EOD granularity caveat (stated in the UI): intraday extremes between bars are
// invisible, and same-day round-trips only see that day's high/low. Options
// aren't covered by the cash bhavcopy, so this effectively covers equity.

export interface MaeBar {
  date: string; // ISO
  high: number | null;
  low: number | null;
  close: number;
}

export interface MaeTradeInput {
  id: number;
  symbol: string; // display name
  ticker: string; // canonical (bars key)
  side: "long" | "short";
  qty: number;
  entry: number; // per-unit
  exit: number; // per-unit
  entryDate: string | null;
  exitDate: string | null;
  netPnl: number;
  isOpen: boolean;
  riskAmount?: number | null; // planned ₹ risk (1R) — unlocks R-normalized stop tuning
}

export interface MaeMfeRow {
  id: number;
  symbol: string;
  side: "long" | "short";
  qty: number;
  entry: number;
  exit: number;
  entryDate: string;
  exitDate: string;
  barsUsed: number;
  maeRs: number; // ₹ worst move against entry over the window (≥0)
  mfeRs: number; // ₹ best move in favour over the window (≥0)
  capturedPct: number | null; // (exit move ₹) / mfeRs × 100, null when mfeRs = 0
  edgeRatio: number | null; // mfeRs / maeRs, null when maeRs = 0
  netPnl: number;
  maeR: number | null; // maeRs / riskAmount — heat taken in R, null without a recorded risk
  mfeR: number | null; // mfeRs / riskAmount
}

export interface MaeMfeReport {
  rows: MaeMfeRow[]; // covered trades, most recent exit first
  covered: number;
  uncovered: number; // closed dated trades without bar coverage
  undated: number; // closed trades missing entry/exit dates (aggregated imports)
  avgCapturedPct: number | null;
  avgEdgeRatio: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeMaeMfe(
  trades: MaeTradeInput[],
  barsByTicker: Map<string, MaeBar[]>,
): MaeMfeReport {
  const rows: MaeMfeRow[] = [];
  let uncovered = 0;
  let undated = 0;

  for (const t of trades) {
    if (t.isOpen || t.qty <= 0 || t.entry <= 0) continue;
    if (!t.entryDate || !t.exitDate) {
      undated += 1;
      continue;
    }
    const bars = (barsByTicker.get(t.ticker.toUpperCase()) ?? []).filter(
      (b) => b.date >= t.entryDate! && b.date <= t.exitDate!,
    );
    if (bars.length === 0) {
      uncovered += 1;
      continue;
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (const b of bars) {
      hi = Math.max(hi, b.high ?? b.close);
      lo = Math.min(lo, b.low ?? b.close);
    }
    const sign = t.side === "short" ? -1 : 1;
    // favorable move per unit: long → hi − entry; short → entry − lo
    const favPerUnit = Math.max(0, sign === 1 ? hi - t.entry : t.entry - lo);
    const advPerUnit = Math.max(0, sign === 1 ? t.entry - lo : hi - t.entry);
    const mfeRs = r2(favPerUnit * t.qty);
    const maeRs = r2(advPerUnit * t.qty);
    const exitMoveRs = (t.exit - t.entry) * t.qty * sign; // gross ₹ captured by the exit
    const capturedPct = mfeRs > 0 ? r2(Math.max(0, exitMoveRs) / mfeRs * 100) : null;
    const edgeRatio = maeRs > 0 ? r2(mfeRs / maeRs) : null;

    const risk = t.riskAmount != null && t.riskAmount > 0 ? t.riskAmount : null;
    rows.push({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      entry: t.entry,
      exit: t.exit,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      barsUsed: bars.length,
      maeRs,
      mfeRs,
      capturedPct,
      edgeRatio,
      netPnl: t.netPnl,
      maeR: risk ? r2(maeRs / risk) : null,
      mfeR: risk ? r2(mfeRs / risk) : null,
    });
  }

  rows.sort((a, b) => b.exitDate.localeCompare(a.exitDate));
  const caps = rows.map((r) => r.capturedPct).filter((v): v is number => v != null);
  const edges = rows.map((r) => r.edgeRatio).filter((v): v is number => v != null);
  return {
    rows,
    covered: rows.length,
    uncovered,
    undated,
    avgCapturedPct: caps.length ? r2(caps.reduce((s, v) => s + v, 0) / caps.length) : null,
    avgEdgeRatio: edges.length ? r2(edges.reduce((s, v) => s + v, 0) / edges.length) : null,
  };
}

// ---------------------------------------------------------------------------
// Stop-tuning report — descriptive, R-normalized read on where your stop sits
// relative to the heat your trades actually take. NOT advice: it describes THIS
// sample at EOD granularity, and moving a stop changes which trades survive.
// ---------------------------------------------------------------------------

export interface StopTuningReport {
  sampled: number; // rows with a recorded risk (maeR available)
  winners: number;
  losers: number;
  avgWinnerMaeR: number | null; // heat the winners took before paying
  avgLoserMaeR: number | null;
  medianWinnerMaeR: number | null;
  winnersHeatOver50Pct: number | null; // % of winners with MAE ≥ 0.5R
  winnersHeatOver80Pct: number | null; // % of winners with MAE ≥ 0.8R — near-stopouts that paid
  losersBeyond1RPct: number | null; // % of losers whose MAE exceeded 1R (stop slippage / no stop honored)
  suggestions: string[]; // plain-language observations, each hedged appropriately
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : r2((s[mid - 1] + s[mid]) / 2);
};

export function stopTuningReport(rows: MaeMfeRow[]): StopTuningReport {
  const sampled = rows.filter((r) => r.maeR != null);
  const winners = sampled.filter((r) => r.netPnl > 0);
  const losers = sampled.filter((r) => r.netPnl < 0);
  const wMae = winners.map((r) => r.maeR!);
  const lMae = losers.map((r) => r.maeR!);

  const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((s, v) => s + v, 0) / xs.length) : null);
  const pct = (n: number, d: number) => (d > 0 ? r2((n / d) * 100) : null);

  const heat50 = pct(wMae.filter((m) => m >= 0.5).length, winners.length);
  const heat80 = pct(wMae.filter((m) => m >= 0.8).length, winners.length);
  const beyond1R = pct(lMae.filter((m) => m > 1.1).length, losers.length); // >1.1R: real slippage, not rounding

  const suggestions: string[] = [];
  if (sampled.length < 30) {
    suggestions.push(
      `Only ${sampled.length} covered trade${sampled.length === 1 ? "" : "s"} carry a recorded risk amount — below ~30, every number here is mostly noise. Record SL/risk on every trade before acting on this.`,
    );
  }
  if (heat80 != null && heat80 >= 25) {
    suggestions.push(
      `${heat80}% of your winners took ≥0.8R heat before paying — a tighter stop would have cut many of them. Your current stop distance looks load-bearing, not lazy; be cautious about tightening.`,
    );
  } else if (heat50 != null && heat50 <= 15 && winners.length >= 10) {
    suggestions.push(
      `Only ${heat50}% of winners ever took more than 0.5R heat — your winners tend to work quickly. A somewhat tighter stop MIGHT cut losses without costing many winners, but re-check after 20+ more trades before changing anything.`,
    );
  }
  if (beyond1R != null && beyond1R >= 20) {
    suggestions.push(
      `${beyond1R}% of losers ran past 1.1R of adverse excursion — stops are being honored late, moved, or skipped. This is execution discipline, not stop placement; the fix is behavioral.`,
    );
  }
  if (suggestions.length === 0 && sampled.length > 0) {
    suggestions.push("Nothing alarming in this sample: winners' heat and losers' excursions both look consistent with your planned stops.");
  }

  return {
    sampled: sampled.length,
    winners: winners.length,
    losers: losers.length,
    avgWinnerMaeR: avg(wMae),
    avgLoserMaeR: avg(lMae),
    medianWinnerMaeR: median(wMae),
    winnersHeatOver50Pct: heat50,
    winnersHeatOver80Pct: heat80,
    losersBeyond1RPct: beyond1R,
    suggestions,
  };
}
