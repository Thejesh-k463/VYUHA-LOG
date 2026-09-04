import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { brokerReference, trades as tradesTable } from "@/lib/db/schema";
import { getSelectedAccountId } from "./accounts";
import { getSettings } from "./settings";
import { withinTolerance } from "@/lib/analytics/ais";
import { currentFy } from "@/lib/analytics/tax";
import type { ReferenceScope } from "@/lib/import/types";

/**
 * v3.9 "Trust the numbers" — reading `broker_reference`, and reconciling it
 * against the book.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: the broker's figures and Vyuha's are
 * never averaged, blended or corrected into each other. They are shown side by
 * side with the DELTA and, where the difference has a knowable cause, the
 * cause. Every "reason" below is a COMPUTED FACT read out of the journal — a
 * count of unpriced sales, a charge total the file does not state, a product
 * tag that disagrees, open quantity the broker has already realised. None of
 * them is an explanation invented to make a number look accounted for; a delta
 * with no reason is reported with no reason, which is the honest answer
 * (invariant 6).
 *
 * The maths is PURE (`reconcileFrom`), so it is exhaustively unit-testable;
 * the two exported wrappers do nothing but read the account's rows and hand
 * them over.
 */

export interface ReferenceRowRecord {
  id: number;
  accountId: number;
  broker: string;
  sourceId: string;
  scope: ReferenceScope;
  key: string;
  isin: string | null;
  symbol: string | null;
  fy: string | null;
  asOf: string | null;
  figures: Record<string, number>;
  note: string | null;
  importBatchId: number | null;
  createdAt: string;
}

export interface ReferenceFilter {
  broker?: string;
  scope?: ReferenceScope;
  fy?: string;
}

/** Why the broker's figure and Vyuha's differ — each one a fact, not a guess. */
export interface ReconcileReason {
  code: "unpriced_sales" | "charges_omitted" | "product_difference" | "open_lots";
  detail: string;
  /** Rows/lots the reason counts, when it counts something. */
  count?: number;
  /** Rupees the reason accounts for, when it can put a figure on itself. */
  amount?: number;
}

export interface ReconcileLine {
  scope: "fy" | "scrip";
  /** FY label, or the ISIN (symbol when the broker stated no ISIN). */
  key: string;
  label: string;
  isin: string | null;
  broker: string | null;
  /** The broker's stated figures, verbatim. */
  stated: Record<string, number>;
  /** Vyuha's own figures for the same bucket. */
  vyuha: Record<string, number>;
  /** stated − vyuha, per shared figure. Positive = the broker states more. */
  delta: Record<string, number>;
  /** Gross P&L agreement under the AIS tolerance (max ₹10, 0.5%). */
  matched: boolean;
  reasons: ReconcileReason[];
}

export interface Reconciliation {
  fy: ReconcileLine[];
  scrip: ReconcileLine[];
}

/** A trade as this module needs it — the projection `reconcile` reads. */
export interface ReconcileTrade {
  isin: string | null;
  symbol: string | null;
  tradingsymbol: string | null;
  segment: string;
  sellDate: string | null;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  grossPnl: number;
  netPnl: number;
  chargesTotal: number;
  isOpen: boolean;
  acquisition: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The FY a closed trade belongs to — `lib/analytics/tax.ts`'s rule, restated
 * over the same inputs: the SELL date owns the year, and a closed trade with
 * no sell date falls to the current FY rather than to a frozen literal. Kept
 * compatible on purpose: a reconciliation that bucketed trades differently
 * from the tax pack would report a delta that is nothing but two bucketings.
 */
function fyOf(sellDate: string | null, fyStartMonth: number, fallback: string): string {
  if (!sellDate) return fallback;
  const d = new Date(sellDate + "T00:00:00");
  if (Number.isNaN(d.getTime())) return fallback;
  const start = d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** The identity a scrip figure is compared on: ISIN first, symbol as fallback. */
function scripKey(isin: string | null | undefined, symbol: string | null | undefined): string {
  const i = (isin ?? "").trim().toUpperCase();
  if (i) return i;
  return (symbol ?? "").trim().toUpperCase();
}

/** Vyuha's segment for a scrip, as a set — used only to NAME a disagreement. */
const SEGMENT_WORDS: Record<string, string[]> = {
  equity: ["eq_delivery", "eq_intraday", "eq_mtf"],
  fno: ["fut_index", "fut_stock", "opt_index", "opt_stock"],
  commodity: ["comm_fut", "comm_opt"],
  currency: ["cur_fut", "cur_opt"],
};

function emptyFigures() {
  return { qty: 0, buyValue: 0, sellValue: 0, grossPnl: 0, netPnl: 0, totalCharges: 0 };
}

function addTrade(acc: ReturnType<typeof emptyFigures>, t: ReconcileTrade) {
  acc.qty += t.sellQty;
  acc.buyValue += t.buyValue;
  acc.sellValue += t.sellValue;
  acc.grossPnl += t.grossPnl;
  acc.netPnl += t.netPnl;
  acc.totalCharges += t.chargesTotal;
}

/** stated − vyuha, over the figures BOTH sides actually state. */
function deltaOf(stated: Record<string, number>, vyuha: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(stated)) {
    if (!(k in vyuha)) continue;
    out[k] = r2(stated[k] - vyuha[k]);
  }
  return out;
}

/**
 * The pure half. `refs` are the broker's rows for ONE account; `trades` is
 * that account's book. Returns one line per FY and one per scrip the broker
 * states — a bucket Vyuha has no trades for still appears, with zeroes and,
 * where it applies, a reason.
 */
export function reconcileFrom(
  refs: ReferenceRowRecord[],
  trades: ReconcileTrade[],
  fyStartMonth = 4,
  today: Date = new Date(),
): Reconciliation {
  const fallbackFy = currentFy(fyStartMonth, today);

  // ── Vyuha's side, bucketed once ─────────────────────────────────────────
  const vyuhaByFy = new Map<string, ReturnType<typeof emptyFigures>>();
  const vyuhaByScrip = new Map<string, ReturnType<typeof emptyFigures>>();
  const openQtyByScrip = new Map<string, number>();
  const unpricedByScrip = new Map<string, { count: number; sellValue: number }>();
  const unpricedByFy = new Map<string, { count: number; sellValue: number }>();
  const segmentsByScrip = new Map<string, Set<string>>();
  const labelByScrip = new Map<string, string>();

  for (const t of trades) {
    const key = scripKey(t.isin, t.symbol ?? t.tradingsymbol);
    if (key && !labelByScrip.has(key)) labelByScrip.set(key, t.symbol ?? t.tradingsymbol ?? key);
    if (key) {
      const segs = segmentsByScrip.get(key) ?? new Set<string>();
      segs.add(t.segment);
      segmentsByScrip.set(key, segs);
    }
    if (t.isOpen) {
      // An open lot is the commonest honest reason for a gap: the broker has
      // realised a position Vyuha still holds open (or vice versa).
      if (key) openQtyByScrip.set(key, (openQtyByScrip.get(key) ?? 0) + (t.buyQty - t.sellQty));
      continue;
    }
    const fy = fyOf(t.sellDate, fyStartMonth, fallbackFy);
    const fyAcc = vyuhaByFy.get(fy) ?? emptyFigures();
    addTrade(fyAcc, t);
    vyuhaByFy.set(fy, fyAcc);
    if (key) {
      const sAcc = vyuhaByScrip.get(key) ?? emptyFigures();
      addTrade(sAcc, t);
      vyuhaByScrip.set(key, sAcc);
    }
    if (t.acquisition === "unknown") {
      const u = unpricedByFy.get(fy) ?? { count: 0, sellValue: 0 };
      u.count++; u.sellValue += t.sellValue;
      unpricedByFy.set(fy, u);
      if (key) {
        const us = unpricedByScrip.get(key) ?? { count: 0, sellValue: 0 };
        us.count++; us.sellValue += t.sellValue;
        unpricedByScrip.set(key, us);
      }
    }
  }

  // ── The broker's side, aggregated to the same buckets ────────────────────
  interface Bucket { stated: Record<string, number>; brokers: Set<string>; isin: string | null; label: string; statesCharges: boolean }
  const fyBuckets = new Map<string, Bucket>();
  const scripBuckets = new Map<string, Bucket>();
  /** Segment families this broker states any non-zero figure for. */
  const claimedSegments = new Set<string>();

  const put = (map: Map<string, Bucket>, key: string, r: ReferenceRowRecord, label: string) => {
    const b = map.get(key) ?? { stated: {}, brokers: new Set<string>(), isin: r.isin ?? null, label, statesCharges: false };
    for (const [f, v] of Object.entries(r.figures ?? {})) b.stated[f] = r2((b.stated[f] ?? 0) + v);
    b.brokers.add(r.broker);
    if (r.isin && !b.isin) b.isin = r.isin;
    if (typeof r.figures?.totalCharges === "number") b.statesCharges = true;
    map.set(key, b);
  };

  for (const r of refs) {
    if (r.scope === "fy") {
      put(fyBuckets, r.key, r, r.key);
    } else if (r.scope === "scrip" || r.scope === "holding") {
      const key = scripKey(r.isin ?? r.key, r.symbol ?? r.key);
      put(scripBuckets, key, r, r.symbol ?? r.key);
      // A dated scrip figure also belongs to its FY, but only the broker's
      // OWN fy rows are compared per FY — summing scrip rows into an FY total
      // would state the same money twice when the file gives both.
    } else if (r.scope === "segment") {
      // A segment total is neither an FY nor a scrip, so it is never COMPARED.
      // What it states is which segment families this broker trades in — and
      // a family whose every figure is zero is not a claim, it is a row the
      // report prints because it prints all four. Only a non-empty segment
      // names a family.
      if (Object.values(r.figures ?? {}).some((v) => v !== 0)) claimedSegments.add(r.key);
    }
  }

  const lines = (
    scope: "fy" | "scrip",
    buckets: Map<string, Bucket>,
    vyuhaMap: Map<string, ReturnType<typeof emptyFigures>>,
  ): ReconcileLine[] =>
    [...buckets].map(([key, b]) => {
      const v = vyuhaMap.get(key) ?? emptyFigures();
      const vyuha: Record<string, number> = {
        qty: r2(v.qty), buyValue: r2(v.buyValue), sellValue: r2(v.sellValue),
        grossPnl: r2(v.grossPnl), netPnl: r2(v.netPnl), totalCharges: r2(v.totalCharges),
      };
      const reasons: ReconcileReason[] = [];

      const unpriced = scope === "fy" ? unpricedByFy.get(key) : unpricedByScrip.get(key);
      if (unpriced && unpriced.count > 0) {
        reasons.push({
          code: "unpriced_sales",
          count: unpriced.count,
          amount: r2(unpriced.sellValue),
          detail: `${unpriced.count} sale${unpriced.count === 1 ? "" : "s"} worth ₹${r2(unpriced.sellValue).toLocaleString("en-IN")} have no purchase in your book, so Vyuha states no cost for them — the broker's figure does.`,
        });
      }

      if (!b.statesCharges && v.totalCharges > 0) {
        reasons.push({
          code: "charges_omitted",
          amount: r2(v.totalCharges),
          detail: `The file states no charges; Vyuha's own charges for these rows are ₹${r2(v.totalCharges).toLocaleString("en-IN")}, which is the whole of any gross-vs-net gap.`,
        });
      }

      if (scope === "scrip") {
        const open = openQtyByScrip.get(key) ?? 0;
        if (open !== 0 && (b.stated.qty ?? 0) > 0) {
          reasons.push({
            code: "open_lots",
            count: Math.abs(open),
            detail: `${Math.abs(open)} share${Math.abs(open) === 1 ? "" : "s"} are still open in your book while the broker states this scrip as realised.`,
          });
        }
        const mine = segmentsByScrip.get(key);
        if (mine && mine.size > 0 && claimedSegments.size > 0) {
          const claimed = [...claimedSegments].flatMap((sg) => SEGMENT_WORDS[sg] ?? []);
          if (claimed.length && ![...mine].some((sg) => claimed.includes(sg))) {
            reasons.push({
              code: "product_difference",
              detail: `The broker files these figures under ${[...claimedSegments].join(", ")}; your book has this scrip as ${[...mine].join(", ")}.`,
            });
          }
        }
      }

      const delta = deltaOf(b.stated, vyuha);
      const matched = b.stated.grossPnl != null && withinTolerance(b.stated.grossPnl, vyuha.grossPnl);
      return {
        scope,
        key,
        label: b.label,
        isin: b.isin,
        broker: b.brokers.size === 1 ? [...b.brokers][0] : null,
        stated: b.stated,
        vyuha,
        delta,
        matched,
        reasons,
      };
    }).sort((a, b) => a.key.localeCompare(b.key));

  return { fy: lines("fy", fyBuckets, vyuhaByFy), scrip: lines("scrip", scripBuckets, vyuhaByScrip) };
}

// ---------------------------------------------------------------------------
// DB wrappers — account resolution and nothing else (invariant 8).
// ---------------------------------------------------------------------------

function decode(row: typeof brokerReference.$inferSelect): ReferenceRowRecord {
  let figures: Record<string, number> = {};
  try {
    const parsed = JSON.parse(row.figuresJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      // A non-numeric value would silently become NaN in every subtraction
      // below; drop it instead and let the figure be absent, which the delta
      // already knows how to render.
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) figures[k] = v;
      }
    }
  } catch {
    figures = {};
  }
  return {
    id: row.id, accountId: row.accountId, broker: row.broker, sourceId: row.sourceId,
    scope: row.scope, key: row.key, isin: row.isin, symbol: row.symbol, fy: row.fy,
    asOf: row.asOf, figures, note: row.note, importBatchId: row.importBatchId,
    createdAt: row.createdAt,
  };
}

/**
 * Broker-stated figures for one account, or for every account in the
 * All-accounts view (0 — a view, never a write target).
 */
export function getReferenceRows(accountId?: number, filter: ReferenceFilter = {}): ReferenceRowRecord[] {
  const id = accountId ?? getSelectedAccountId();
  const where = [
    ...(id > 0 ? [eq(brokerReference.accountId, id)] : []),
    ...(filter.broker ? [eq(brokerReference.broker, filter.broker)] : []),
    ...(filter.scope ? [eq(brokerReference.scope, filter.scope)] : []),
    ...(filter.fy ? [eq(brokerReference.fy, filter.fy)] : []),
  ];
  const q = db.select().from(brokerReference);
  return (where.length ? q.where(and(...where)) : q).all().map(decode);
}

/** Distinct brokers that have stated figures for this account. */
export function getReferenceBrokers(accountId?: number): string[] {
  return [...new Set(getReferenceRows(accountId).map((r) => r.broker))].sort();
}

/**
 * The broker's figures beside Vyuha's, per FY and per scrip, with the reasons
 * they differ. Reads the same account both sides — comparing one account's
 * broker statement against every account's trades is the merged-books defect
 * invariant 8 exists to prevent.
 */
export function reconcile(accountId?: number): Reconciliation {
  const id = accountId ?? getSelectedAccountId();
  const refs = getReferenceRows(id);
  const brokers = [...new Set(refs.map((r) => r.broker))];
  const where = [
    ...(id > 0 ? [eq(tradesTable.accountId, id)] : []),
    ...(brokers.length ? [inArray(tradesTable.broker, brokers)] : []),
  ];
  const q = db.select({
    isin: tradesTable.isin,
    symbol: tradesTable.symbol,
    tradingsymbol: tradesTable.tradingsymbol,
    segment: tradesTable.segment,
    sellDate: tradesTable.sellDate,
    buyQty: tradesTable.buyQty,
    sellQty: tradesTable.sellQty,
    buyValue: tradesTable.buyValue,
    sellValue: tradesTable.sellValue,
    grossPnl: tradesTable.grossPnl,
    netPnl: tradesTable.netPnl,
    chargesTotal: tradesTable.chargesTotal,
    isOpen: tradesTable.isOpen,
    acquisition: tradesTable.acquisition,
  }).from(tradesTable);
  const rows = (where.length ? q.where(and(...where)) : q).all() as ReconcileTrade[];
  return reconcileFrom(refs, rows, getSettings()?.fyStartMonth ?? 4);
}
