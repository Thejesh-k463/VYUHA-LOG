// THE LENSES PAGE — one book, several cuts (PURE, no DB/React).
//
// The trades table answers "what did I do?". This answers "where does it come
// from?" — the same trades re-grouped by month, by broker, by what kind of
// trade it was, by the file it arrived in, by the play behind it, by how it
// ended. Each cut is a TAB; picking one re-groups the book without leaving the
// page.
//
// ── Why the groups carry ids, not predicates ────────────────────────────────
//
// Every group can be deleted from this page, and `lib/domain/delete-scope.ts`
// has one rule above all others: what the confirmation counted is what gets
// removed. So a group is a list of ids plus a `DeleteScope` that resolves to
// exactly the same set — either because the scope IS the grouping predicate
// (`broker`, `segment`, `importBatch`) or because it literally carries the
// group's own ids (`filter`). Nothing here re-derives a set at delete time.
//
// ── Partitions only ─────────────────────────────────────────────────────────
//
// All six cuts are PARTITIONS: every trade lands in exactly one group, and the
// groups' P&L sums to the book. That is a deliberate constraint, not a
// coincidence — an overlapping cut (mistake tags, NSE themes, where one trade
// belongs to several groups) must announce itself, because its totals exceed
// the book by design. `lib/analytics/theme-edge.ts` carries `overlapping: true`
// for exactly that reason. If a lens is ever added here that overlaps, it must
// set the flag and the UI must say so — never present it as a breakdown.
//
// Untagged / undated / not-imported trades get their own honest group rather
// than being dropped. A cut whose groups do not add up to the book is a lie
// about the book.

import {
  brokerGroups,
  segmentGroups,
  importFileGroups,
  monthGroups,
  type BatchGroup,
  type DeletableTrade,
  type ImportFileMeta,
} from "./delete-scope";
import { BROKER_LABELS, SEGMENT_LABELS, type Broker, type Segment } from "./constants";

/**
 * A trade as the Lenses page needs it: delete-scope's shape, plus the two
 * journal fields the setup cut groups on, plus the four figures
 * `computeKpis` needs to report a group's performance.
 *
 * The extra four are spelled out rather than inherited from
 * `lib/analytics/metrics.ts`'s `AnalyticsTrade` — this module is domain, and
 * pointing it at analytics to borrow an interface would invert the dependency
 * for no benefit. Structural typing means a `LensTrade` is accepted by
 * `computeKpis` regardless. Every field is already in `SlimTrade`, so nothing
 * new crosses the RSC payload.
 */
export interface LensTrade extends DeletableTrade {
  setupTag: string | null;
  playbookId: number | null;
  bucket: string;
  grossPnl: number;
  chargesTotal: number;
  rMultiple: number | null;
}

export type LensKind = "month" | "broker" | "tradeType" | "importFile" | "setup" | "outcome";

export interface LensDef {
  kind: LensKind;
  /** Tab label. */
  label: string;
  /** One line under the strip saying what this cut answers. */
  hint: string;
  /**
   * True when one trade can appear in more than one group. Every lens here is
   * false; the field exists so that a future overlapping cut cannot be added
   * without answering the question.
   */
  overlapping: boolean;
}

export const LENSES: readonly LensDef[] = [
  { kind: "month", label: "Month", hint: "Filed by exit date for a closed trade, entry date for one still open.", overlapping: false },
  { kind: "broker", label: "Broker", hint: "Where the trade was actually placed — charges differ per broker.", overlapping: false },
  { kind: "tradeType", label: "Trade type", hint: "Delivery, MTF, intraday, options and futures each carry their own cost and tax treatment.", overlapping: false },
  { kind: "importFile", label: "Import file", hint: "Exactly what each imported file produced, in isolation.", overlapping: false },
  { kind: "setup", label: "Setup", hint: "The play behind the trade — its playbook if one is linked, otherwise its setup tag.", overlapping: false },
  { kind: "outcome", label: "Outcome", hint: "How it ended. Open positions are held apart: they have no realised result yet.", overlapping: false },
] as const;

export function lensDef(kind: LensKind): LensDef {
  return LENSES.find((l) => l.kind === kind) ?? LENSES[0];
}

export function isLensKind(v: string | null | undefined): v is LensKind {
  return LENSES.some((l) => l.kind === v);
}

/** Everything a lens may need beyond the trades themselves. */
export interface LensContext {
  batches: ImportFileMeta[];
  playbooks: { id: number; name: string }[];
}

// ── The two cuts that have no counterpart in delete-scope ───────────────────

/**
 * By the play behind the trade.
 *
 * A trade may carry a structured `playbookId`, a free-text `setupTag`, both, or
 * neither. Grouping on both at once would double-count, so there is a strict
 * precedence — playbook first, because it is the one the user maintains
 * deliberately — and each group says which it came from. One trade, one group.
 */
export function setupGroups(candidates: LensTrade[], playbooks: { id: number; name: string }[]): BatchGroup[] {
  const names = new Map(playbooks.map((p) => [p.id, p.name]));
  const byKey = new Map<string, { label: string; sub: string; ts: LensTrade[] }>();

  for (const t of candidates) {
    let key: string, label: string, sub: string;
    const pb = t.playbookId != null ? names.get(t.playbookId) : undefined;
    if (t.playbookId != null) {
      key = `pb:${t.playbookId}`;
      // A playbook that has since been deleted still linked these trades; say
      // so rather than filing them under "untagged", which they are not.
      label = pb ?? `Playbook #${t.playbookId}`;
      sub = pb ? "playbook" : "playbook no longer on record";
    } else if (t.setupTag && t.setupTag.trim()) {
      key = `tag:${t.setupTag.trim()}`;
      label = t.setupTag.trim();
      sub = "setup tag";
    } else {
      key = "untagged";
      label = "No setup recorded";
      sub = "neither a playbook nor a setup tag";
    }
    const g = byKey.get(key) ?? { label, sub, ts: [] };
    g.ts.push(t);
    byKey.set(key, g);
  }

  return [...byKey.entries()]
    .sort((a, b) => {
      // Untagged always last: it is a gap in the record, not a strategy.
      if (a[0] === "untagged") return 1;
      if (b[0] === "untagged") return -1;
      return b[1].ts.length - a[1].ts.length;
    })
    .map(([key, g]) => ({
      key: `setup:${key}`,
      label: g.label,
      sub: g.sub,
      count: g.ts.length,
      scope: { kind: "filter" as const, ids: g.ts.map((t) => t.id), label: g.label },
    }));
}

/**
 * By how the trade ended.
 *
 * Open positions are their own group, never folded into winners or losers. An
 * unrealised mark is not a result, and counting it as one is how a losing book
 * flatters itself.
 */
export function outcomeGroups(candidates: LensTrade[]): BatchGroup[] {
  const open = candidates.filter((t) => t.isOpen);
  const closed = candidates.filter((t) => !t.isOpen);
  const buckets: { key: string; label: string; sub: string; ts: LensTrade[] }[] = [
    { key: "win", label: "Winners", sub: "closed above cost after charges", ts: closed.filter((t) => t.netPnl > 0) },
    { key: "loss", label: "Losers", sub: "closed below cost after charges", ts: closed.filter((t) => t.netPnl < 0) },
    { key: "flat", label: "Breakeven", sub: "closed at exactly zero net", ts: closed.filter((t) => t.netPnl === 0) },
    { key: "open", label: "Still open", sub: "no realised result yet", ts: open },
  ];
  return buckets
    .filter((b) => b.ts.length > 0)
    .map((b) => ({
      key: `outcome:${b.key}`,
      label: b.label,
      sub: b.sub,
      count: b.ts.length,
      scope: { kind: "filter" as const, ids: b.ts.map((t) => t.id), label: b.label },
    }));
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * Group the book by one lens.
 *
 * `candidates` must already be account-scoped — the same requirement
 * `resolveDeleteScope` states, and for the same reason: a "delete every Zerodha
 * trade" built from an unscoped list would reach into a book the user is not
 * looking at.
 */
export function lensGroups(kind: LensKind, candidates: LensTrade[], ctx: LensContext): BatchGroup[] {
  switch (kind) {
    case "month":
      return monthGroups(candidates);
    case "importFile":
      return importFileGroups(candidates, ctx.batches);
    case "broker":
      return brokerGroups(candidates).map((g) => ({
        ...g,
        label: BROKER_LABELS[g.label as Broker] ?? g.label,
      }));
    case "tradeType":
      return segmentGroups(candidates).map((g) => ({
        ...g,
        label: SEGMENT_LABELS[g.label as Segment] ?? g.label,
      }));
    case "setup":
      return setupGroups(candidates, ctx.playbooks);
    case "outcome":
      return outcomeGroups(candidates);
  }
}

/**
 * The ids a group covers.
 *
 * `filter` groups carry them directly. `broker` / `segment` / `importBatch`
 * groups describe a predicate instead, so the ids are recovered by re-applying
 * it to the same candidate list the groups were built from — which is what
 * makes the drill-down show precisely the rows the group counted.
 */
export function groupIds(group: BatchGroup, candidates: LensTrade[]): number[] {
  const s = group.scope;
  switch (s.kind) {
    case "filter":
    case "ids":
      return s.ids;
    case "broker":
      return predicateIndex(candidates).broker.get(s.broker) ?? [];
    case "segment":
      return predicateIndex(candidates).segment.get(s.segment) ?? [];
    case "importBatch":
      return predicateIndex(candidates).batch.get(s.batchId) ?? [];
    default:
      return [];
  }
}

/**
 * One pass over the book, then O(1) per group.
 *
 * The Lenses page calls `groupIds` once per group of every lens against the
 * same candidate array. Filtering the book inside each call is O(groups ×
 * trades), and import-batch groups grow WITH the book, so that was quadratic
 * (tests/load/b1-lenses-grouping.load.ts measured t(4n)/t(n) = 14.3). The
 * index is keyed on the array's identity in a WeakMap: a new array (a new
 * request, a re-scoped book) is a new index, and nothing is retained past
 * the array's own lifetime. Ids keep candidate order, exactly as the filter
 * did, so a drill-down shows the same rows in the same order.
 */
interface PredicateIndex {
  /** Length at indexing time — an array grown in place is re-indexed. */
  n: number;
  broker: Map<string, number[]>;
  segment: Map<string, number[]>;
  batch: Map<number, number[]>;
}
const indexCache = new WeakMap<LensTrade[], PredicateIndex>();

function predicateIndex(candidates: LensTrade[]): PredicateIndex {
  const hit = indexCache.get(candidates);
  if (hit && hit.n === candidates.length) return hit;
  const idx: PredicateIndex = { n: candidates.length, broker: new Map(), segment: new Map(), batch: new Map() };
  const push = <K,>(m: Map<K, number[]>, k: K, id: number) => {
    const l = m.get(k);
    if (l) l.push(id);
    else m.set(k, [id]);
  };
  for (const t of candidates) {
    push(idx.broker, t.broker, t.id);
    push(idx.segment, t.segment, t.id);
    if (t.importBatchId != null) push(idx.batch, t.importBatchId, t.id);
  }
  indexCache.set(candidates, idx);
  return idx;
}
