// Instruments-master parser + sector map (PURE, no DB/React). The user pastes a
// security list; we normalise it to {symbol, sector, name, lotSize, isin}. The
// primary use is symbol → sector for concentration analysis (P1.3 / P1.2).

export interface InstrumentRow {
  symbol: string; // canonical ticker (upper-cased)
  sector: string | null;
  name: string | null;
  lotSize: number | null;
  isin: string | null;
}

const ISIN_RE = /^IN[A-Z0-9]{10}$/i;

/**
 * Parse a pasted instruments list. One per line, separated by comma / tab / pipe:
 *   SYMBOL, SECTOR, [NAME], [LOT_SIZE], [ISIN]
 * The first column is the symbol; the second (if present) is the sector. Any
 * remaining columns are classified by shape — a pure integer → lot size, an
 * ISIN-shaped token → ISIN, otherwise treated as the name. `#` lines are comments,
 * and a leading "SYMBOL,..." header row is skipped.
 */
export function parseInstrumentList(text: string): InstrumentRow[] {
  const rows: InstrumentRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/[,\t|]/).map((p) => p.trim());
    const symbol = (parts[0] ?? "").toUpperCase();
    if (!symbol || symbol === "SYMBOL") continue; // skip blanks / header

    const sector = parts[1] ? parts[1].trim() : null;

    let lotSize: number | null = null;
    let isin: string | null = null;
    const nameParts: string[] = [];
    for (const raw of parts.slice(2)) {
      const p = raw.trim();
      if (!p) continue;
      if (lotSize == null && /^\d+$/.test(p)) lotSize = Number(p);
      else if (isin == null && ISIN_RE.test(p)) isin = p.toUpperCase();
      else nameParts.push(p);
    }

    rows.push({
      symbol,
      sector: sector || null,
      name: nameParts.join(" ") || null,
      lotSize,
      isin,
    });
  }
  return rows;
}

/** symbol (upper) → sector, for entries that carry a sector. */
export function buildSectorMap(rows: { symbol: string; sector: string | null }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.symbol && r.sector) m.set(r.symbol.toUpperCase(), r.sector);
  }
  return m;
}
