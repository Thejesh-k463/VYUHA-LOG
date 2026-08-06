/**
 * Edge by NSE theme (PURE).
 *
 * Groups closed trades by thematic index membership — "where does the
 * expectancy actually live?" is a different question from per-segment or
 * per-setup edge, because themes cut across both (a NIFTY option seller and a
 * RAILWAYS-PSU swing trader can share a segment while having none of the same
 * edge).
 *
 * Honesty rules, in order of importance:
 *
 * 1. THEMES OVERLAP. A symbol sits in up to ten indices, so one trade counts
 *    in every theme it belongs to — rows are a LENS EACH, not a partition,
 *    and their P&L deliberately sums to more than the book. The report
 *    carries this as a property (`overlapping: true`) and the UI must say it.
 * 2. Only CLOSED trades. An open position has no realised edge.
 * 3. Small samples are flagged, not hidden: `trustworthy` follows the same
 *    MIN_SAMPLE discipline as the options-seller reports.
 * 4. Untagged trades are counted and reported — a theme report over 12% of
 *    the book flattering itself as "your edge" would be a lie of omission.
 */

export const THEME_MIN_SAMPLE = 10;

export interface ThemeTradeInput {
  symbol: string;
  isOpen: boolean;
  netPnl: number;
}

export interface ThemeEdgeRow {
  theme: string;
  trades: number;
  symbols: number;
  netPnl: number;
  wins: number;
  winRate: number; // 0–100
  expectancy: number; // ₹ per trade
  trustworthy: boolean; // trades >= THEME_MIN_SAMPLE
}

export interface ThemeEdgeReport {
  /** Sorted by |netPnl| descending — biggest contributors first, either sign. */
  rows: ThemeEdgeRow[];
  closedTrades: number;
  taggedTrades: number;
  untaggedTrades: number;
  /** Always true — a permanent reminder for renderers, not a variable. */
  overlapping: true;
}

export function themeEdge(
  trades: ThemeTradeInput[],
  membership: Map<string, string[]>,
  minSample = THEME_MIN_SAMPLE,
): ThemeEdgeReport {
  const closed = trades.filter((t) => !t.isOpen);
  const byTheme = new Map<string, { pnl: number; wins: number; n: number; symbols: Set<string> }>();
  let tagged = 0;

  for (const t of closed) {
    const themes = membership.get(t.symbol.toUpperCase()) ?? [];
    if (themes.length > 0) tagged += 1;
    for (const theme of themes) {
      const cur = byTheme.get(theme) ?? { pnl: 0, wins: 0, n: 0, symbols: new Set<string>() };
      cur.pnl += t.netPnl;
      if (t.netPnl > 0) cur.wins += 1;
      cur.n += 1;
      cur.symbols.add(t.symbol.toUpperCase());
      byTheme.set(theme, cur);
    }
  }

  const rows: ThemeEdgeRow[] = [...byTheme.entries()]
    .map(([theme, s]) => ({
      theme,
      trades: s.n,
      symbols: s.symbols.size,
      netPnl: Math.round(s.pnl * 100) / 100,
      wins: s.wins,
      winRate: Math.round((s.wins / s.n) * 1000) / 10,
      expectancy: Math.round((s.pnl / s.n) * 100) / 100,
      trustworthy: s.n >= minSample,
    }))
    .sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl));

  return {
    rows,
    closedTrades: closed.length,
    taggedTrades: tagged,
    untaggedTrades: closed.length - tagged,
    overlapping: true,
  };
}
