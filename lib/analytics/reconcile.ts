/**
 * v3.9 "Trust the numbers" — the VIEW MODEL of the Broker-truth screen.
 *
 * ZERO DB and ZERO React imports (invariant 2). Everything here is a reading
 * of figures `lib/queries/reference.ts#reconcile()` has already computed: a
 * status word, a sort key, a filter, a source list. It adds NO arithmetic of
 * its own — the only number it produces is `Math.abs` of a delta the query
 * stated, for ordering. A screen that recomputed a total on its way to the
 * page would be a second arithmetic path over the same cells, and the app
 * would then show two figures for one file.
 *
 * The line/holding shapes are declared STRUCTURALLY rather than imported from
 * lib/queries: that module is `server-only`, and this one is imported by a
 * client component.
 */

import { IMPORT_SOURCES } from "@/lib/import/registry-meta";

export interface ReconLine {
  scope: "fy" | "scrip" | "segment";
  key: string;
  label: string;
  isin: string | null;
  fy: string | null;
  broker: string | null;
  stated: Record<string, number>;
  vyuha: Record<string, number>;
  delta: Record<string, number>;
  matched: boolean;
  reasons: { code: string; detail: string; count?: number; amount?: number }[];
  /** Present only on an out-of-tolerance line with no computed reason: the
   *  facts that were checked and came back zero. Never the word "mismatch". */
  checkedNote?: string | null;
}

export interface ReconHolding {
  key: string;
  label: string;
  isin: string | null;
  broker: string | null;
  asOf: string | null;
  brokerQty: number;
  vyuhaQty: number;
  delta: number;
}

/** The figure the status word is read off. Gross P&L is the one every one of
 *  the five reference sources states; net and charges are not. */
export const COMPARE_FIELD = "grossPnl";

export type ReconStatus = "matched" | "broker_higher" | "vyuha_higher" | "not_compared";

/**
 * Deliberately four words, never "mismatch": a delta is a direction, and the
 * direction is the first thing a trader needs in order to know where to look.
 * "Not compared" is the honest answer when the file states no gross P&L at all
 * (invariant 6) — not a zero, and not a match.
 */
export const STATUS_LABEL: Record<ReconStatus, string> = {
  matched: "Within tolerance",
  broker_higher: "Broker higher",
  vyuha_higher: "Vyuha higher",
  not_compared: "Not compared",
};

export const STATUS_CLASS: Record<ReconStatus, string> = {
  matched: "text-profit",
  broker_higher: "text-loss font-semibold",
  vyuha_higher: "text-warning font-semibold",
  not_compared: "text-muted-foreground",
};

/** The status of one line — read off `matched` and the sign of its delta. */
export function lineStatus(line: Pick<ReconLine, "stated" | "delta" | "matched">): ReconStatus {
  if (line.stated[COMPARE_FIELD] == null) return "not_compared";
  if (line.matched) return "matched";
  const d = line.delta[COMPARE_FIELD];
  if (d == null || d === 0) return "matched";
  return d > 0 ? "broker_higher" : "vyuha_higher";
}

/**
 * Which identity the row was joined on. ISIN is the only stable one — Paytm
 * restated the same security under a ticker and then a numeric BSE code
 * mid-window — so a symbol join is SAID OUT LOUD on the screen rather than
 * left to be assumed.
 */
export function joinedOn(line: Pick<ReconLine, "isin" | "key">): "isin" | "symbol" {
  return line.isin && line.isin === line.key ? "isin" : "symbol";
}

export const JOIN_LABEL: Record<"isin" | "symbol", string> = {
  isin: "ISIN",
  symbol: "symbol",
};

/** |Δ| on the compared figure; a line the file states nothing for sorts last. */
export function absDelta(line: Pick<ReconLine, "delta">): number {
  const d = line.delta[COMPARE_FIELD];
  return d == null ? 0 : Math.abs(d);
}

/** Order by the SIZE of the gap. The sign is a direction, not a rank. */
export function sortByAbsDelta<T extends Pick<ReconLine, "delta">>(lines: T[], dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...lines].sort((a, b) => sign * (absDelta(a) - absDelta(b)));
}

export interface LineFilter {
  fy?: string;
  broker?: string;
}

/** "" and undefined both mean "everything" — the select's own empty option. */
export function filterLines<T extends Pick<ReconLine, "fy" | "broker">>(lines: T[], f: LineFilter): T[] {
  return lines.filter(
    (l) => (!f.fy || l.fy === f.fy) && (!f.broker || l.broker === f.broker),
  );
}

export function fyOptions(lines: Pick<ReconLine, "fy">[]): string[] {
  return [...new Set(lines.map((l) => l.fy).filter((v): v is string => !!v))].sort();
}

export function brokerOptions(lines: Pick<ReconLine, "broker">[]): string[] {
  return [...new Set(lines.map((l) => l.broker).filter((v): v is string => !!v))].sort();
}

// ---------------------------------------------------------------------------
// Sources — what is actually loaded, so an empty table can be told apart from
// a table with nothing to say.
// ---------------------------------------------------------------------------

export interface ReferenceRowLike {
  broker: string;
  sourceId: string;
  scope: string;
  fy: string | null;
  asOf: string | null;
  importBatchId: number | null;
}

export interface SourceSummary {
  broker: string;
  sourceId: string;
  /** The registry's own name for the file, so the screen and the dropzone agree. */
  label: string;
  rows: number;
  scopes: string[];
  fys: string[];
  /** Earliest / latest `as_of` the source stated, or null when it states none. */
  asOfFrom: string | null;
  asOfTo: string | null;
  batches: number[];
}

const LABELS = new Map(IMPORT_SOURCES.map((s) => [s.sourceId, s.label]));

/** The registry label, falling back to the raw id — never an invented name. */
export function sourceLabel(sourceId: string): string {
  return LABELS.get(sourceId) ?? sourceId;
}

export function summariseSources(rows: ReferenceRowLike[]): SourceSummary[] {
  const by = new Map<string, SourceSummary>();
  for (const r of rows) {
    const k = `${r.broker}|${r.sourceId}`;
    const s = by.get(k) ?? {
      broker: r.broker, sourceId: r.sourceId, label: sourceLabel(r.sourceId),
      rows: 0, scopes: [], fys: [], asOfFrom: null, asOfTo: null, batches: [],
    };
    s.rows++;
    if (!s.scopes.includes(r.scope)) s.scopes.push(r.scope);
    if (r.fy && !s.fys.includes(r.fy)) s.fys.push(r.fy);
    if (r.asOf) {
      if (!s.asOfFrom || r.asOf < s.asOfFrom) s.asOfFrom = r.asOf;
      if (!s.asOfTo || r.asOf > s.asOfTo) s.asOfTo = r.asOf;
    }
    if (r.importBatchId != null && !s.batches.includes(r.importBatchId)) s.batches.push(r.importBatchId);
    by.set(k, s);
  }
  for (const s of by.values()) {
    s.scopes.sort();
    s.fys.sort();
    s.batches.sort((a, b) => a - b);
  }
  return [...by.values()].sort((a, b) => a.broker.localeCompare(b.broker) || a.sourceId.localeCompare(b.sourceId));
}

/**
 * The statements that put figures on this screen, named from the import
 * registry so the empty state cannot advertise a file the app cannot read
 * (the drift `dropzoneHint()` exists to prevent).
 */
export const RECONCILE_SOURCE_IDS = [
  "dhan-realised-pnl",
  "paytm-realised-pnl",
  "angelone-pnl-statement",
  "dhan-holdings",
  "dhan-dp-charges",
] as const;

export const RECONCILE_FEEDS: { sourceId: string; label: string }[] = RECONCILE_SOURCE_IDS.map((id) => ({
  sourceId: id,
  label: sourceLabel(id),
}));

/** Reason codes, in the order they are worth reading. */
export const REASON_ORDER = ["unpriced_sales", "charges_omitted", "open_lots", "product_difference"] as const;

export function sortReasons<T extends { code: string }>(reasons: T[]): T[] {
  const rank = (c: string) => {
    const i = (REASON_ORDER as readonly string[]).indexOf(c);
    return i < 0 ? REASON_ORDER.length : i;
  };
  return [...reasons].sort((a, b) => rank(a.code) - rank(b.code));
}
