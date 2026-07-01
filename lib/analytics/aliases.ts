// Symbol-alias resolver (PURE, no DB/React). Maps a broker scrip name to its
// canonical exchange ticker so bhavcopy / surveillance lists (keyed by ticker)
// match positions stored under full broker names.

export interface AliasRow {
  alias: string;
  ticker: string;
  isin?: string | null;
  note?: string | null;
}

/**
 * Parse a pasted alias list. One mapping per line:
 *   FULL BROKER NAME, TICKER, [isin/note]
 * Separators: comma, tab or pipe. `#` lines are comments.
 */
export function parseAliasList(text: string): AliasRow[] {
  const rows: AliasRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/[,\t|]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const alias = parts[0].toUpperCase();
    const ticker = parts[1].toUpperCase();
    if (!alias || !ticker) continue;
    rows.push({ alias, ticker, note: parts.slice(2).join(" ") || null });
  }
  return rows;
}

export function buildAliasMap(rows: AliasRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.alias && r.ticker) m.set(r.alias.toUpperCase(), r.ticker.toUpperCase());
  }
  return m;
}

/** Resolve a symbol to its canonical ticker, falling back to the symbol itself. */
export function resolveTicker(symbol: string, map: Map<string, string>): string {
  const up = symbol.toUpperCase();
  return map.get(up) ?? up;
}
