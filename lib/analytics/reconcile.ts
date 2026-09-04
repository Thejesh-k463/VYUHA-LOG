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

/**
 * A charge figure the broker states, structurally mirrored from
 * `lib/queries/reference.ts#ReconcileChargeLine`.
 *
 * `vyuha`/`delta`/`matched` are NULLABLE and the nullability is the whole
 * point: some of a broker's charges (a CUSPA sell-off fee, delayed-payment
 * interest) have no column in the book at all. Rendering those against a zero
 * would print the whole of the broker's fee as a delta the journal disputes.
 * Null means "nothing to compare", and the screen prints exactly that.
 */
export interface ReconChargeLine {
  kind: "dp" | "note" | "ledger";
  key: string;
  label: string;
  broker: string | null;
  sourceId: string;
  fy: string | null;
  stated: Record<string, number>;
  vyuha: Record<string, number> | null;
  delta: Record<string, number> | null;
  matched: boolean | null;
  note: string;
}

/** The figure a charge line is compared on, per kind. Never derived on screen. */
export const CHARGE_FIELD: Record<ReconChargeLine["kind"], string> = {
  dp: "charges",
  note: "total",
  ledger: "amount",
};

/**
 * The status word for a charge line. `matched === null` is "Not compared" —
 * the honest reading of a fee the book has no column for, and never a match.
 *
 * WHICH SIDE IS HIGHER IS READ OFF THE SIGN, exactly as `lineStatus` does it.
 * Reading only `matched` printed "Broker higher" on every disagreement,
 * including a contract note that states LESS than the book — beside a delta
 * column showing that same row's negative number.
 */
export function chargeStatus(line: Pick<ReconChargeLine, "kind" | "delta" | "matched">): ReconStatus {
  if (line.matched == null) return "not_compared";
  if (line.matched) return "matched";
  const d = line.delta?.[CHARGE_FIELD[line.kind]];
  if (d == null || d === 0) return "matched";
  return d > 0 ? "broker_higher" : "vyuha_higher";
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
 * The statements that state the broker's OWN P&L, holdings and DP figures.
 *
 * This list is also the book-vs-reference gate in `lib/import/commit.ts`, so
 * it names only sources whose rows are a reference statement rather than a
 * book of trades. It is NOT the whole feed list any more - see
 * `RECONCILE_CHARGE_SOURCE_IDS` and `RECONCILE_FEEDS` below.
 */
export const RECONCILE_SOURCE_IDS = [
  "dhan-realised-pnl",
  "paytm-realised-pnl",
  "angelone-pnl-statement",
  "dhan-holdings",
  "dhan-dp-charges",
] as const;

/**
 * The statements that put CHARGE figures on this screen and nothing else.
 *
 * They were always parsed into `scope: "charge"` rows; "Charges the broker
 * states" is what reads them, so the screen now has seven feeds, not five.
 * They are kept apart from the list above because that one doubles as an
 * import-time gate on what counts as a book of trades, and these two files
 * import no trades to gate.
 */
export const RECONCILE_CHARGE_SOURCE_IDS = [
  "dhan-contract-note",
  "angelone-ledger",
] as const;

/**
 * EVERY file that puts a figure on Broker Truth, named from the import
 * registry so the empty state cannot advertise a file the app cannot read
 * (the drift `dropzoneHint()` exists to prevent). The empty state, the help
 * text and the docs all count this ONE list.
 */
export const RECONCILE_FEEDS: { sourceId: string; label: string }[] =
  [...RECONCILE_SOURCE_IDS, ...RECONCILE_CHARGE_SOURCE_IDS].map((id) => ({
    sourceId: id,
    label: sourceLabel(id),
  }));

/**
 * Reason codes, in the order they are worth reading. `ambiguous_symbol` leads:
 * it is the one reason that says the Vyuha side is ABSENT rather than
 * different, so it has to be read before any figure on the row is.
 */
export const REASON_ORDER = ["ambiguous_symbol", "unpriced_sales", "charges_omitted", "open_lots", "product_difference"] as const;

export function sortReasons<T extends { code: string }>(reasons: T[]): T[] {
  const rank = (c: string) => {
    const i = (REASON_ORDER as readonly string[]).indexOf(c);
    return i < 0 ? REASON_ORDER.length : i;
  };
  return [...reasons].sort((a, b) => rank(a.code) - rank(b.code));
}
