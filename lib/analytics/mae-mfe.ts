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
