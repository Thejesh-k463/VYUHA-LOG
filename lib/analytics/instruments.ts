// Instruments-master parser + sector map (PURE, no DB/React). The user pastes a
// security list; we normalise it to {symbol, sector, name, lotSize, isin}. The
// primary use is symbol → sector for concentration analysis (P1.3 / P1.2).
//
// v3.8 adds the bundled sector TAXONOMY (`lib/data/sector-map.json`, NSE's
// 4-level classification keyed by ISIN with a confidence tier per row) and the
// fallback chain that `getSectorMap()` runs:
//
//   user instruments.sector  →  taxonomy by ISIN  →  index map `industry`
//
// with `sectorAliases` applied at every step so the legacy ALL-CAPS labels in
// NSE's constituent files ("AUTOMOBILE") and the modern ones ("Automobile and
// Auto Components") land in ONE bucket. The user's own tag still wins — it is
// re-labelled through the alias table, never replaced.

import sectorMap from "@/lib/data/sector-map.json";

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

// ---------------------------------------------------------------------------
// The bundled sector taxonomy
// ---------------------------------------------------------------------------

export type TaxonomyConfidence = "high" | "medium_high" | "medium";

export interface TaxonomyEntry {
  isin: string;
  /** The NSE symbol the reconciliation sheet recorded (0 disagreements with the listing snapshot on 2026-09-04). */
  symbol: string;
  bseCode: string | null;
  macro: string | null;
  sector: string;
  industry: string | null;
  basic: string | null;
  /** NSE taxonomy code (`IN…`); null for the one sector-only row. */
  code: string | null;
  confidence: TaxonomyConfidence;
  /** Which evidence classified it — the full string, e.g. "SCREENER_MAPPING+NSE_TAXONOMY". */
  source: string;
}

interface SectorMapFile {
  asOf?: string;
  provenance?: { legend?: Record<string, string> };
  taxonomy?: Record<string, string[]>;
  byIsin?: Record<string, string[]>;
  sectorAliases?: Record<string, string>;
}

const file = sectorMap as SectorMapFile;
const TAXONOMY = file.taxonomy ?? {};
const BY_ISIN = file.byIsin ?? {};
const LEGEND = file.provenance?.legend ?? {};

/** When the bundled taxonomy was taken. */
export const SECTOR_MAP_AS_OF: string = file.asOf ?? "";
/** How many ISINs the bundled taxonomy classifies. */
export const SECTOR_MAP_COUNT: number = Object.keys(BY_ISIN).length;
/** Legacy / punctuation forks of NSE's sector labels → the taxonomy's label. */
export const SECTOR_ALIASES: Readonly<Record<string, string>> = file.sectorAliases ?? {};

const asConfidence = (c: string): TaxonomyConfidence => (c === "high" || c === "medium_high" ? c : "medium");

function expand(isin: string, row: string[]): TaxonomyEntry | null {
  const [sym, bse, key, conf, src] = row;
  const labels = TAXONOMY[key];
  if (!labels || !labels[1]) return null;
  return {
    isin,
    symbol: sym,
    bseCode: bse || null,
    macro: labels[0] || null,
    sector: labels[1],
    industry: labels[2] || null,
    basic: labels[3] || null,
    code: key.startsWith("~") ? null : key,
    confidence: asConfidence(conf),
    source: LEGEND[src] ?? src,
  };
}

/** The taxonomy row for an ISIN, or null when the sheet has no company-level classification. */
export function taxonomyByIsin(isin: string): TaxonomyEntry | null {
  const key = String(isin ?? "").trim().toUpperCase();
  const row = key ? BY_ISIN[key] : undefined;
  return row ? expand(key, row) : null;
}

/** Every classified ISIN, expanded. */
export function* taxonomyEntries(): IterableIterator<TaxonomyEntry> {
  for (const [isin, row] of Object.entries(BY_ISIN)) {
    const e = expand(isin, row);
    if (e) yield e;
  }
}

/** Canonical sector labels, in the taxonomy's own spelling. */
export function taxonomySectors(): string[] {
  return [...new Set(Object.values(TAXONOMY).map((t) => t[1]).filter(Boolean))].sort();
}

/**
 * Collapse a sector label onto the taxonomy's spelling: the alias table first,
 * then a case-insensitive match against the canonical sectors and alias keys
 * (so "POWER", "Power" and "power" are one bucket). Anything the taxonomy does
 * not know — a user's own "IT", "Energy" — passes through untouched, trimmed.
 */
export function canonicalSector(label: string | null | undefined, aliases: Readonly<Record<string, string>> = SECTOR_ALIASES): string | null {
  const s = String(label ?? "").trim();
  if (!s) return null;
  if (aliases[s]) return aliases[s];
  const folded = foldedSectors(aliases).get(s.toUpperCase());
  return folded ?? s;
}

const foldCache = new WeakMap<object, Map<string, string>>();
function foldedSectors(aliases: Readonly<Record<string, string>>): Map<string, string> {
  const hit = foldCache.get(aliases);
  if (hit) return hit;
  const m = new Map<string, string>();
  for (const sector of taxonomySectors()) m.set(sector.toUpperCase(), sector);
  for (const [from, to] of Object.entries(aliases)) m.set(from.toUpperCase(), to);
  foldCache.set(aliases, m);
  return m;
}

// ---------------------------------------------------------------------------
// The sector chain
// ---------------------------------------------------------------------------

/**
 * Where a symbol's sector came from, strongest first. The user's own tag
 * outranks everything; the three taxonomy tiers are the reconciliation
 * sheet's own confidence; the index map's `industry` is last because it is
 * a constituent list's label, not a company-level classification.
 */
export type SectorTier = "user" | TaxonomyConfidence | "index";

export interface SectorResolution {
  /** Canonical label, after aliases. */
  sector: string;
  tier: SectorTier;
  source: "user" | "taxonomy" | "index";
  /** The label as the source stated it, before aliasing. */
  raw: string;
}

export interface SectorSources {
  /** The bundled taxonomy (or a synthetic one in tests). */
  taxonomy?: Iterable<Pick<TaxonomyEntry, "isin" | "symbol" | "sector" | "confidence">>;
  /** The index map's `symbols` table: SYMBOL → { industry, isin }. */
  index?: Record<string, { industry?: string | null; isin?: string | null }>;
  /** Maps a taxonomy ISIN to the ticker the app is keyed on (listing snapshot). Falls back to the taxonomy's own symbol. */
  symbolByIsin?: (isin: string) => string | null;
  /** Finds an ISIN for a user row that states none, so it can reach the taxonomy. */
  isinBySymbol?: (symbol: string) => string | null;
  aliases?: Readonly<Record<string, string>>;
}

/**
 * Run the chain over the user's rows plus every symbol the bundled sources
 * know. Precedence per symbol: user tag → taxonomy (by the row's ISIN, or by
 * an ISIN found for the symbol) → index map. Rows with no sector and no
 * reachable classification are simply absent, as before.
 */
export function buildSectorResolution(
  rows: { symbol: string; sector: string | null; isin?: string | null }[],
  sources: SectorSources = {},
): Map<string, SectorResolution> {
  const aliases = sources.aliases ?? SECTOR_ALIASES;
  const canon = (label: string | null | undefined) => canonicalSector(label, aliases);
  const out = new Map<string, SectorResolution>();
  const up = (s: string) => String(s ?? "").trim().toUpperCase();

  // 3. the index map, weakest, laid down first so anything stronger overwrites
  for (const [symbol, meta] of Object.entries(sources.index ?? {})) {
    const sector = canon(meta.industry);
    if (symbol && sector) out.set(up(symbol), { sector, tier: "index", source: "index", raw: String(meta.industry) });
  }

  // 2. the taxonomy, keyed by ISIN and re-keyed to the ticker the app uses
  const byIsin = new Map<string, Pick<TaxonomyEntry, "isin" | "symbol" | "sector" | "confidence">>();
  for (const e of sources.taxonomy ?? []) {
    byIsin.set(up(e.isin), e);
    const symbol = up(sources.symbolByIsin?.(e.isin) ?? e.symbol);
    const sector = canon(e.sector);
    if (symbol && sector) out.set(symbol, { sector, tier: e.confidence, source: "taxonomy", raw: e.sector });
  }

  // 1. the user's rows: a tag wins outright; an untagged row can still reach
  //    the taxonomy through its ISIN (a renamed ticker, a symbol the snapshot
  //    spells differently) before falling back to whatever is already there.
  for (const r of rows) {
    const symbol = up(r.symbol);
    if (!symbol) continue;
    const own = canon(r.sector);
    if (own) { out.set(symbol, { sector: own, tier: "user", source: "user", raw: String(r.sector).trim() }); continue; }
    const isin = up(r.isin ?? "") || up(sources.isinBySymbol?.(symbol) ?? "");
    const e = isin ? byIsin.get(isin) : undefined;
    const sector = e ? canon(e.sector) : null;
    if (e && sector && (!out.has(symbol) || out.get(symbol)!.tier === "index")) {
      out.set(symbol, { sector, tier: e.confidence, source: "taxonomy", raw: e.sector });
    }
  }
  return out;
}

/**
 * symbol (upper) → sector. With no `sources` this is exactly the pre-v3.8
 * behaviour — the user's tagged rows and nothing else — so every caller and
 * test that relied on "no tag, no entry" still holds. Pass `sources` to run
 * the chain.
 */
export function buildSectorMap(
  rows: { symbol: string; sector: string | null; isin?: string | null }[],
  sources?: SectorSources,
): Map<string, string> {
  if (!sources) {
    const m = new Map<string, string>();
    for (const r of rows) {
      if (r.symbol && r.sector) m.set(r.symbol.toUpperCase(), r.sector);
    }
    return m;
  }
  const m = new Map<string, string>();
  for (const [symbol, r] of buildSectorResolution(rows, sources)) m.set(symbol, r.sector);
  return m;
}
