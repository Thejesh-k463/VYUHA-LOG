// The bundled stock universe (PURE, no DB/React) — v4.6.0 W2, owner rulings U1–U4.
//
// `lib/data/stock-universe.json` is a SNAPSHOT built by `scripts/build-stock-universe.mjs`
// on the owner's machine (a polite crawl of NSE `getSymbolData`/`getMetaData` and BSE
// `ComHeadernew`, AMFI's half-yearly cap-band workbook, NSE Indices' July-2023 structure) —
// never hand-edited, and the app contacts none of those hosts. It carries, per ISIN of
// `lib/data/isin-symbols.json` (the same listing snapshot, so the two cannot disagree on a
// symbol — the universe carries none of its own):
//
//   - the exchanges' 4-level classification as ONE structure code (labels in the structure's
//     spelling, decoded through `taxonomy.nodes`), and which exchange(s) stated it;
//   - AMFI's cap band — THE cap band (ruling U2): large / mid / small with AMFI's rank. NSE
//     Emerge is never banded (U3): the band is null with a reason. Nifty size-index membership
//     is a separate lens (`getIndexBandMap()` in lib/queries/instruments.ts), and "micro" lives
//     only there;
//   - the asset class (equity / sme-equity / etf) and the listing status NSE reported.
//
// An absent or empty snapshot reads as NO universe — every lookup returns null and nothing
// throws, so a build without the file degrades to the fallback chain rather than failing.

import universeJson from "@/lib/data/stock-universe.json";

export type AmfiCapBand = "large" | "mid" | "small";
export type UniverseSource = "nse+bse" | "nse" | "bse";
export type UniverseAssetClass = "equity" | "sme-equity" | "etf";

export interface UniverseClassification {
  isin: string;
  /** The deepest NSE Indices structure code known (`IN…`, 4 / 6 / 8 / 11 characters). */
  code: string;
  macro: string | null;
  sector: string | null;
  industry: string | null;
  basic: string | null;
  source: UniverseSource;
}

export interface UniverseCap {
  band: AmfiCapBand | null;
  /** AMFI's rank by six-month average market cap (1 = largest), or null. */
  rank: number | null;
  /** Why there is no band (`nse-emerge`, `post-period-listing`, `not-in-amfi`), or null. */
  reason: string | null;
  /** The reason in the user's words ("SME — not ranked by AMFI"). */
  reasonText: string | null;
  /** AMFI's averaging period end, e.g. 2026-06-30. */
  periodEnd: string | null;
  /** The half-year the list governs from, e.g. 2026-07-01. */
  effectiveFrom: string | null;
}

type Row = [string | null, string | null, string | null, string | null, string | null, number | null, string | null];

export interface Universe {
  asOf: string;
  capturedAt: string;
  digest: string | null;
  nodes: Record<string, string>;
  byIsin: Record<string, Row>;
  aliases: Record<string, string>;
  cap: { periodEnd: string | null; effectiveFrom: string | null; reasons: Record<string, string> };
  dq: {
    equity: number;
    classified: number;
    coverage: number;
    bands: Record<AmfiCapBand, number>;
    capUnmatched: Record<string, number>;
    disagreements: number;
  };
  provenance: { id: string; url?: string | null; sha256?: string | null; periodEnd?: string | null; rows?: number }[];
}

const CODE_LEN = [4, 6, 8, 11] as const;

/** Validate the parsed file; null when it is absent, empty or of another schema (never throws). */
export function readUniverse(raw: unknown): Universe | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (f.schema !== 1) return null;
  const byIsin = f.byIsin && typeof f.byIsin === "object" ? (f.byIsin as Record<string, Row>) : null;
  if (!byIsin || Object.keys(byIsin).length === 0) return null;
  const taxonomy = (f.taxonomy ?? {}) as { nodes?: Record<string, string> };
  const cap = (f.cap ?? {}) as Universe["cap"];
  const dq = (f.dq ?? {}) as Record<string, unknown>;
  return {
    asOf: String(f.asOf ?? ""),
    capturedAt: String(f.capturedAt ?? ""),
    digest: typeof f.digest === "string" ? f.digest : null,
    nodes: taxonomy.nodes ?? {},
    byIsin,
    aliases: (f.aliases as Record<string, string>) ?? {},
    cap: { periodEnd: cap.periodEnd ?? null, effectiveFrom: cap.effectiveFrom ?? null, reasons: cap.reasons ?? {} },
    dq: {
      equity: Number(dq.equity ?? 0),
      classified: Number(dq.classified ?? 0),
      coverage: Number(dq.coverage ?? 0),
      bands: (dq.bands as Record<AmfiCapBand, number>) ?? { large: 0, mid: 0, small: 0 },
      capUnmatched: (dq.capUnmatched as Record<string, number>) ?? {},
      disagreements: Array.isArray(dq.disagreements) ? dq.disagreements.length : 0,
    },
    provenance: Array.isArray(f.provenance) ? (f.provenance as Universe["provenance"]) : [],
  };
}

/** The bundled snapshot, or null. */
export const UNIVERSE: Universe | null = readUniverse(universeJson);
export const UNIVERSE_AS_OF: string = UNIVERSE?.asOf ?? "";
export const UNIVERSE_COUNT: number = UNIVERSE ? Object.keys(UNIVERSE.byIsin).length : 0;

const up = (s: string | null | undefined) => String(s ?? "").trim().toUpperCase();

/** The universe row for an ISIN — through the alias table when the ISIN was reissued (a face-value split). */
function rowOf(isin: string, u: Universe | null): { isin: string; row: Row } | null {
  if (!u) return null;
  const key = up(isin);
  if (!key) return null;
  const direct = u.byIsin[key];
  if (direct) return { isin: key, row: direct };
  const to = u.aliases[key];
  const aliased = to ? u.byIsin[to] : undefined;
  return aliased ? { isin: to, row: aliased } : null;
}

/** Decode a structure code into its four labels. */
export function decodeCode(code: string, u: Universe | null = UNIVERSE): Pick<UniverseClassification, "macro" | "sector" | "industry" | "basic"> {
  const at = (i: number) => (u && code.length >= CODE_LEN[i] ? u.nodes[code.slice(0, CODE_LEN[i])] ?? null : null);
  return { macro: at(0), sector: at(1), industry: at(2), basic: at(3) };
}

/** The exchanges' classification of an ISIN, or null (unclassified, an ETF, or no snapshot). */
export function universeClassification(isin: string, u: Universe | null = UNIVERSE): UniverseClassification | null {
  const hit = rowOf(isin, u);
  const code = hit?.row[0];
  if (!hit || !code) return null;
  const source = (hit.row[1] ?? "nse") as UniverseSource;
  return { isin: hit.isin, code, ...decodeCode(code, u), source };
}

/** AMFI's cap band for an ISIN (ruling U2), with the reason when there is none; null when the ISIN is unknown or an ETF. */
export function universeCap(isin: string, u: Universe | null = UNIVERSE): UniverseCap | null {
  const hit = rowOf(isin, u);
  if (!hit || !u) return null;
  const [, , assetClass, , band, rank, reason] = hit.row;
  if (assetClass === "etf") return null;
  return {
    band: band === "large" || band === "mid" || band === "small" ? band : null,
    rank: typeof rank === "number" ? rank : null,
    reason: reason ?? null,
    reasonText: reason ? u.cap.reasons[reason] ?? reason : null,
    periodEnd: u.cap.periodEnd,
    effectiveFrom: u.cap.effectiveFrom,
  };
}

/** Every classified ISIN, decoded — the universe half of the sector chain. */
export function* universeEntries(u: Universe | null = UNIVERSE): IterableIterator<UniverseClassification> {
  if (!u) return;
  for (const isin of Object.keys(u.byIsin)) {
    const c = universeClassification(isin, u);
    if (c) yield c;
  }
}

/** Every ISIN AMFI bands, with its band and rank. */
export function* universeCapEntries(u: Universe | null = UNIVERSE): IterableIterator<{ isin: string; band: AmfiCapBand; rank: number | null }> {
  if (!u) return;
  for (const [isin, row] of Object.entries(u.byIsin)) {
    const band = row[4];
    if (band === "large" || band === "mid" || band === "small") yield { isin, band, rank: typeof row[5] === "number" ? row[5] : null };
  }
}
