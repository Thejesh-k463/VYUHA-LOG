// DELETE SCOPES (PURE, no DB/React).
//
// Deleting trades is the one destructive thing this app does to a user's own
// record, so the rule throughout is: **decide what will be deleted, show it, and
// only then delete it.** This module answers the first two. It never touches the
// database — it resolves a scope descriptor against a list of trades and returns
// exactly which ones match, plus a summary honest enough to confirm against.
//
// ── Why resolution is separate from execution ───────────────────────────────
//
// A confirmation dialog that says "delete 47 trades?" is worthless if the thing
// that actually runs re-derives the set differently. Resolving here, once, means
// the preview and the deletion are literally the same list of ids — the dialog
// shows `resolve(...)`, and the executor is handed those ids, not the scope.
//
// ── What is deliberately NOT a scope ────────────────────────────────────────
//
// There is no "delete everything" scope. Wiping the journal is what Backup &
// Restore is for, where it is preceded by an export. A one-click path from a
// crowded screen to an empty database is not a feature.

export type DateBasis = "entry" | "exit" | "either";

export type DeleteScope =
  /** Explicit ids — row selection in the Trades table. */
  | { kind: "ids"; ids: number[] }
  /** Everything that arrived from one imported file. */
  | { kind: "importBatch"; batchId: number }
  /** Everything typed in by hand on one calendar day (no import batch). */
  | { kind: "manualDay"; date: string }
  | { kind: "dateRange"; from: string; to: string; basis: DateBasis }
  | { kind: "broker"; broker: string }
  | { kind: "segment"; segment: string }
  | { kind: "account"; accountId: number }
  /** Whatever the table is currently showing — the caller supplies the ids. */
  | { kind: "filter"; ids: number[]; label: string };

export interface DeletableTrade {
  id: number;
  accountId: number;
  broker: string;
  segment: string;
  symbol: string;
  tradingsymbol: string;
  buyDate: string | null;
  sellDate: string | null;
  isOpen: boolean;
  netPnl: number;
  importBatchId: number | null;
  createdAt: string;
  staged?: boolean;
}

export interface DeletePreview {
  ids: number[];
  count: number;
  /** What the caller should show before asking "are you sure?". */
  label: string;
  open: number;
  closed: number;
  staged: number;
  netPnl: number;
  /** Distinct symbols, capped for display — the full count is `symbolCount`. */
  symbols: string[];
  symbolCount: number;
  earliest: string | null;
  latest: string | null;
  /** Set when the scope resolves to nothing; callers should refuse to proceed. */
  empty: boolean;
  /** Things the user should know before confirming. Never empty for a real delete. */
  warnings: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The date a trade is filed under for range purposes. */
function datesOf(t: DeletableTrade, basis: DateBasis): (string | null)[] {
  if (basis === "entry") return [t.buyDate];
  if (basis === "exit") return [t.sellDate];
  return [t.buyDate, t.sellDate];
}

function inRange(t: DeletableTrade, from: string, to: string, basis: DateBasis): boolean {
  // A trade with no date on the chosen basis cannot be proven in range, so it is
  // left alone. Deleting on a guess is not recoverable.
  return datesOf(t, basis).some((d) => d != null && d >= from && d <= to);
}

/** The calendar day a manually-entered trade was recorded. */
export function manualDayOf(t: DeletableTrade): string {
  return (t.createdAt ?? "").slice(0, 10);
}

function matches(t: DeletableTrade, scope: DeleteScope): boolean {
  switch (scope.kind) {
    case "ids":
      return scope.ids.includes(t.id);
    case "filter":
      return scope.ids.includes(t.id);
    case "importBatch":
      return t.importBatchId === scope.batchId;
    case "manualDay":
      // Manual means "not from an import" — an imported trade recorded on the
      // same day must not be swept up by a manual-entry cleanup.
      return t.importBatchId == null && manualDayOf(t) === scope.date;
    case "dateRange":
      return inRange(t, scope.from, scope.to, scope.basis);
    case "broker":
      return t.broker === scope.broker;
    case "segment":
      return t.segment === scope.segment;
    case "account":
      return t.accountId === scope.accountId;
  }
}

function describe(scope: DeleteScope, n: number): string {
  const trades = `${n} trade${n === 1 ? "" : "s"}`;
  switch (scope.kind) {
    case "ids":
      return `${trades} selected`;
    case "filter":
      return `${trades} matching “${scope.label}”`;
    case "importBatch":
      return `${trades} from this imported file`;
    case "manualDay":
      return `${trades} entered by hand on ${scope.date}`;
    case "dateRange":
      return `${trades} between ${scope.from} and ${scope.to}`;
    case "broker":
      return `${trades} from ${scope.broker}`;
    case "segment":
      return `${trades} in ${scope.segment}`;
    case "account":
      return `${trades} in this account`;
  }
}

const SYMBOL_PREVIEW = 8;

/**
 * Resolve a scope against a candidate list.
 *
 * `candidates` must already be account-scoped by the caller — this module has no
 * opinion about which account you are in, and handing it every account's trades
 * would let a "delete all Dhan trades" reach into a book you were not looking at.
 */
export function resolveDeleteScope(candidates: DeletableTrade[], scope: DeleteScope): DeletePreview {
  const hit = candidates.filter((t) => matches(t, scope));
  const ids = hit.map((t) => t.id);
  const symbols = [...new Set(hit.map((t) => t.symbol))].sort();
  const dates = hit.flatMap((t) => [t.buyDate, t.sellDate]).filter((d): d is string => !!d).sort();

  const open = hit.filter((t) => t.isOpen).length;
  const staged = hit.filter((t) => t.staged).length;

  const warnings: string[] = [];
  if (hit.length > 0) {
    warnings.push("Deleting a trade removes its journal notes, tags, rule checklist and chart attachments with it. This cannot be undone from inside the app.");
    if (open > 0) {
      warnings.push(`${open} of these ${open === 1 ? "is an open position" : "are open positions"} — your live risk and exposure figures will change.`);
    }
    if (staged > 0) {
      warnings.push(`${staged} ${staged === 1 ? "is a staged position" : "are staged positions"}; every tranche and partial exit goes with ${staged === 1 ? "it" : "them"}.`);
    }
    warnings.push("Restore from Backup & Restore is the only way back, so export first if you are unsure.");
  }

  return {
    ids,
    count: hit.length,
    label: describe(scope, hit.length),
    open,
    closed: hit.length - open,
    staged,
    netPnl: r2(hit.reduce((s, t) => s + t.netPnl, 0)),
    symbols: symbols.slice(0, SYMBOL_PREVIEW),
    symbolCount: symbols.length,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
    empty: hit.length === 0,
    warnings,
  };
}

// ── Groupings offered in the UI ─────────────────────────────────────────────

export interface BatchGroup {
  key: string;
  label: string;
  count: number;
  scope: DeleteScope;
  sub?: string;
}

/** Manual-entry sessions, newest first — trades typed in, grouped by the day. */
export function manualBatches(candidates: DeletableTrade[]): BatchGroup[] {
  const byDay = new Map<string, DeletableTrade[]>();
  for (const t of candidates) {
    if (t.importBatchId != null) continue;
    const d = manualDayOf(t);
    if (!d) continue;
    const l = byDay.get(d) ?? [];
    l.push(t);
    byDay.set(d, l);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, ts]) => ({
      key: `manual:${date}`,
      label: `Entered by hand on ${date}`,
      count: ts.length,
      sub: [...new Set(ts.map((t) => t.symbol))].slice(0, 4).join(", "),
      scope: { kind: "manualDay", date } as DeleteScope,
    }));
}

/** Distinct brokers present, with counts. */
export function brokerGroups(candidates: DeletableTrade[]): BatchGroup[] {
  const by = new Map<string, number>();
  for (const t of candidates) by.set(t.broker, (by.get(t.broker) ?? 0) + 1);
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([broker, count]) => ({
      key: `broker:${broker}`,
      label: broker,
      count,
      scope: { kind: "broker", broker } as DeleteScope,
    }));
}

/** Distinct segments present, with counts. */
export function segmentGroups(candidates: DeletableTrade[]): BatchGroup[] {
  const by = new Map<string, number>();
  for (const t of candidates) by.set(t.segment, (by.get(t.segment) ?? 0) + 1);
  return [...by.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([segment, count]) => ({
      key: `segment:${segment}`,
      label: segment,
      count,
      scope: { kind: "segment", segment } as DeleteScope,
    }));
}
