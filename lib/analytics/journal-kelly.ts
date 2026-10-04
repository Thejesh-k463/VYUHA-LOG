/**
 * JOURNAL KELLY — the Sizing Lab's "Use my journal" source (PURE: no DB, no
 * React, no server-only). v4.7.0 wave C3.
 *
 * The win rate and payoff the Lab's Kelly tab may fill, measured over ONE slice
 * of ONE account's closed trades. Every number comes from the Clinic engine's
 * own pieces — `cellTrades()` for the slice rows (the same rows, in the same
 * chronological order, as the Clinic's cell with that key), `kellySample()` for
 * the sample and `kellyCeiling()` for the figures — so the book slice here and
 * the Clinic's book cell agree number for number (design D1, D2, D4). There is
 * no second Kelly formula in this file.
 *
 * Rules (owner answers K1–K7, design D5–D7):
 *  - The sample is the trades with a REAL risk (a stop or a typed risk);
 *    `risk_source = 'cap'` rows are out (K1). Floor: `KELLY_MIN_N` (30) in the
 *    ACTIVE slice and window (K2, K4) — a narrowed slice can refuse while the
 *    whole account qualifies.
 *  - A refusal is TYPED and carries no payoff or win-rate field at all (D5), so
 *    no caller can `?? 0` one into existence.
 *  - No losing trade → b is +∞: refused ("no-losing-trades"), a payoff cannot be
 *    stated. No winning trade → b = 0: filled as p 0 and marked (K7).
 *  - The slice list is in a FIXED order — book, segments in SEGMENTS order, then
 *    segment × setup by segment then setup — never sorted by f or by n (D7).
 *  - "12m" = exit day (`sellDate`, read through the engine's `dayOf`) within the
 *    365 days ending `today`, inclusive (D6).
 */
import { SEGMENT_LABELS, SEGMENTS, type Segment } from "@/lib/domain/constants";
import { wilsonInterval } from "@/lib/analytics/inference";
import {
  CLINIC_SEED,
  KELLY_MIN_N,
  cellTrades,
  dayOf,
  kellyCeiling,
  kellySample,
  type ClinicTrade,
} from "@/lib/analytics/edge-clinic";

export type JournalKellyWindow = "all" | "12m";
export const JOURNAL_KELLY_WINDOWS: readonly JournalKellyWindow[] = ["all", "12m"];

/** One slice the Lab can read: the whole account, a segment, or a segment × setup. */
export interface JournalKellySlice {
  /** The Clinic's cell key: `all|all`, `${segment}|all`, `${segment}|setup:${tag}`. */
  key: string;
  kind: "book" | "segment" | "setup";
  segment: Segment | null;
  /** The setup tag ("untagged" for a null tag, as the Clinic keys it); null on book / segment. */
  setup: string | null;
  label: string;
  /** Trades in `kellySample()` for the active window. */
  n: number;
  /** Closed trades in the slice for the active window. */
  of: number;
}

export interface JournalKellyOk {
  ok: true;
  label: string;
  n: number;
  of: number;
  /** round(p × 1e6) — the Lab's own unit. */
  winPpm: number;
  /** round(b × 1e6) — the Lab's own unit. */
  payoffPpm: number;
  p: number;
  /** Wilson 95 % interval of p (the lower bound is kellyCeiling's own). */
  pLo: number;
  pHi: number;
  b: number;
  bLo: number | null;
  kellyPoint: number | null;
  /** ½ Kelly at the lower 95 % bounds, a fraction of capital at risk per trade; null = not supported. */
  halfKellyLowerBound: number | null;
  supportsSizingUp: boolean;
}

export type JournalKellyRefusalReason = "all-view" | "below-floor" | "no-losing-trades";

/** A refusal: deliberately NO winPpm / payoffPpm / p / b key (D5). */
export interface JournalKellyRefusal {
  ok: false;
  reason: JournalKellyRefusalReason;
  /** Trades in the sample (0 in the All view: nothing was read). */
  n: number;
  /** Closed trades in the slice. */
  of: number;
  /** The floor. */
  need: number;
}

export type JournalKellyResult = JournalKellyOk | JournalKellyRefusal;

/** GET /api/sizing/journal-kelly's 200 body. */
export interface JournalKellyResponse {
  slices: JournalKellySlice[];
  result: JournalKellyResult;
}

export interface JournalKellyQuery {
  segment?: Segment | null;
  setup?: string | null;
  window: JournalKellyWindow;
  /** IST ISO day the window ends on (`todayIstIso()` at the route). */
  today: string;
}

const BOOK_LABEL = "Whole account";
const setupOf = (t: ClinicTrade): string => t.setupTag ?? "untagged";

/** The All-accounts refusal (owner K6) — the route answers it without reading a row. */
export function allViewRefusal(): JournalKellyRefusal {
  return { ok: false, reason: "all-view", n: 0, of: 0, need: KELLY_MIN_N };
}

/** Whole days since the epoch for an ISO day; null when it is not a real day. */
function dayNumber(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return Math.round(ms / 86_400_000);
}

/** The closed rows inside the window, in the engine's chronological order. */
function windowed(closed: readonly ClinicTrade[], window: JournalKellyWindow, today: string): ClinicTrade[] {
  if (window === "all") return [...closed];
  const end = dayNumber(today);
  if (end == null) return [];
  const start = end - 364; // the 365 days ending today, inclusive
  return closed.filter((t) => {
    const d = dayNumber(dayOf(t.sellDate));
    return d != null && d >= start && d <= end;
  });
}

const segIndex = (s: Segment) => SEGMENTS.indexOf(s);

/**
 * Every slice present in the account's closed book, each counted for the
 * active window, in the fixed order (D7). The list is drawn from the WHOLE
 * closed book, so toggling the window never removes the slice a user chose — it
 * reads "0 of 0" instead.
 */
export function journalKellySlices(
  trades: readonly ClinicTrade[],
  opts: { window: JournalKellyWindow; today: string },
): JournalKellySlice[] {
  const closed = cellTrades(trades, "all|all");
  const inWindow = windowed(closed, opts.window, opts.today);
  const count = (pred: (t: ClinicTrade) => boolean) => {
    const rows = inWindow.filter(pred);
    return { n: kellySample(rows).length, of: rows.length };
  };
  const segments = [...new Set(closed.map((t) => t.segment))].sort((a, b) => segIndex(a) - segIndex(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out: JournalKellySlice[] = [
    { key: "all|all", kind: "book", segment: null, setup: null, label: BOOK_LABEL, ...count(() => true) },
  ];
  for (const seg of segments) {
    out.push({ key: `${seg}|all`, kind: "segment", segment: seg, setup: null, label: SEGMENT_LABELS[seg] ?? seg, ...count((t) => t.segment === seg) });
  }
  for (const seg of segments) {
    const setups = [...new Set(closed.filter((t) => t.segment === seg).map(setupOf))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const setup of setups) {
      out.push({
        key: `${seg}|setup:${setup}`,
        kind: "setup",
        segment: seg,
        setup,
        label: `${SEGMENT_LABELS[seg] ?? seg} · ${setup}`,
        ...count((t) => t.segment === seg && setupOf(t) === setup),
      });
    }
  }
  return out;
}

/** The label a query reads under — the slice list's own wording. */
function labelOf(q: JournalKellyQuery): string {
  if (!q.segment) return BOOK_LABEL;
  const seg = SEGMENT_LABELS[q.segment] ?? q.segment;
  return q.setup != null ? `${seg} · ${q.setup}` : seg;
}

/**
 * The journal's Kelly inputs for ONE slice of ONE account's book. `setup`
 * without `segment` reads the whole account (the route refuses that shape
 * before it gets here). Deterministic: the bootstrap is seeded with the
 * Clinic's seed over the engine's chronological order.
 */
export function journalKelly(trades: readonly ClinicTrade[], q: JournalKellyQuery): JournalKellyResult {
  const closed = cellTrades(trades, "all|all");
  const slice = closed.filter(
    (t) => (q.segment ? t.segment === q.segment : true) && (q.segment && q.setup != null ? setupOf(t) === q.setup : true),
  );
  const rows = windowed(slice, q.window, q.today);
  const sample = kellySample(rows);
  const n = sample.length;
  const of = rows.length;
  if (n < KELLY_MIN_N) return { ok: false, reason: "below-floor", n, of, need: KELLY_MIN_N };
  const rs = sample.map((t) => t.rMultiple as number);
  const k = kellyCeiling(rs, { seed: CLINIC_SEED });
  if (!Number.isFinite(k.b)) return { ok: false, reason: "no-losing-trades", n, of, need: KELLY_MIN_N };
  return {
    ok: true,
    label: labelOf(q),
    n,
    of,
    winPpm: Math.round(k.p * 1_000_000),
    payoffPpm: Math.round(k.b * 1_000_000),
    p: k.p,
    pLo: k.pLo,
    pHi: wilsonInterval(rs.filter((r) => r > 0).length, n).hi,
    b: k.b,
    bLo: k.bLo,
    kellyPoint: k.kellyPoint,
    halfKellyLowerBound: k.halfKellyLowerBound,
    supportsSizingUp: k.supportsSizingUp,
  };
}
