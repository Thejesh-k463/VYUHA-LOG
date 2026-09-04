import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { brokerReference, trades as tradesTable } from "@/lib/db/schema";
import { getSelectedAccountId } from "./accounts";
import { getSettings } from "./settings";
import { withinTolerance } from "@/lib/analytics/ais";
import { currentFy } from "@/lib/analytics/tax";
import type { ReferenceScope } from "@/lib/import/types";
import type { Segment } from "@/lib/domain/constants";

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
  code: "unpriced_sales" | "charges_omitted" | "product_difference" | "open_lots" | "ambiguous_symbol";
  detail: string;
  /** Rows/lots the reason counts, when it counts something. */
  count?: number;
  /** Rupees the reason accounts for, when it can put a figure on itself. */
  amount?: number;
}

export interface ReconcileLine {
  scope: "fy" | "scrip" | "segment";
  /** FY label, the segment family, or the ISIN (symbol when none was stated). */
  key: string;
  label: string;
  isin: string | null;
  /**
   * The FY every row in this bucket belongs to, or null when the broker
   * stated none or stated more than one. It exists so the screen can FILTER
   * by year without re-deriving a year from a date — two bucketings of the
   * same rows is exactly the kind of delta this module refuses to invent.
   */
  fy: string | null;
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
  /**
   * Set ONLY on a line that is out of tolerance and for which none of the four
   * computed facts fired: it names the facts that were checked and came back
   * zero. Never a generic "mismatch" — see `checkedNote`'s construction.
   */
  checkedNote: string | null;
}

/**
 * A broker's demat statement beside the book's own open quantity.
 *
 * Quantities only, and on purpose: a holdings file states a CLOSING PRICE and
 * a valuation, the journal states a cost basis, and subtracting one from the
 * other is not a difference in anything — it is unrealised P&L wearing the
 * costume of a reconciliation.
 */
export interface ReconcileHolding {
  /** ISIN (symbol when the file stated none). */
  key: string;
  label: string;
  isin: string | null;
  broker: string | null;
  /** Statement date, verbatim. */
  asOf: string | null;
  brokerQty: number;
  vyuhaQty: number;
  /** broker − vyuha. Positive = the broker holds more than the book. */
  delta: number;
}

export interface Reconciliation {
  fy: ReconcileLine[];
  /**
   * Segment families (equity, fno, commodity, currency). The Dhan Realised
   * P&L states its figures ONLY per segment — no FY row, no scrip row — so
   * without this the owner's own primary reference file reconciles against an
   * empty screen.
   */
  segment: ReconcileLine[];
  scrip: ReconcileLine[];
  holdings: ReconcileHolding[];
  /**
   * The charge figures three parsers have been WRITING since v3.9 and nothing
   * read: Dhan's DP charges report, a Dhan contract note's own charge lines,
   * and Angel One's ledger charge tables. Help, the source registry and the
   * CHANGELOG all said DP charges feed Broker Truth; this is the table that
   * makes that sentence true.
   */
  charges: ReconcileChargeLine[];
}

/** A trade as this module needs it — the projection `reconcile` reads. */
export interface ReconcileTrade {
  /**
   * WHOSE trade this is. A charge line is one broker's statement, so its Vyuha
   * side is that broker's trades and no one else's: keyed on FY alone, two
   * brokers' DP fees were added together and handed to BOTH brokers' lines,
   * which manufactured a delta on a book that agreed to the paisa. Optional on
   * the type only so the FY/scrip/segment tests need not restate it; absent
   * reads as one unnamed broker, which is what a book with one broker is.
   */
  broker?: string | null;
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
  /**
   * The charge columns the "Charges the broker states" table compares against.
   * They are OPTIONAL on the type so the pure function stays callable from the
   * FY/scrip/segment tests without restating a whole charge breakdown; absent
   * reads as zero, which is what a projection that does not select them means.
   */
  buyDate?: string | null;
  brokerage?: number;
  sttCtt?: number;
  exchangeTxn?: number;
  sebi?: number;
  stampDuty?: number;
  ipft?: number;
  gst?: number;
  dpCharges?: number;
  pledgeCharges?: number;
}

/**
 * One line of "Charges the broker states" — a broker's own charge figure
 * beside the book's, or beside nothing when the book has no counterpart.
 *
 * `vyuha` is NULL, not zero, when Vyuha holds no comparable column. A zero
 * would make the whole of the broker's figure a delta and read as a
 * disagreement; there is no disagreement, there is nothing to compare
 * (invariant 6 — never fabricate a denominator, and never a Δ).
 */
export interface ReconcileChargeLine {
  /** dp = DP charges per FY; note = one contract note's stated charges; ledger = a ledger charge table. */
  kind: "dp" | "note" | "ledger";
  key: string;
  label: string;
  broker: string | null;
  sourceId: string;
  /** The FY this line belongs to, derived from the file's own `asOf`. */
  fy: string | null;
  /** The broker's figures, verbatim. */
  stated: Record<string, number>;
  /** Vyuha's counterpart, or null when the book states no such charge. */
  vyuha: Record<string, number> | null;
  /** stated − vyuha, per shared figure. Null exactly when `vyuha` is. */
  delta: Record<string, number> | null;
  /** Agreement under the AIS tolerance on `total`. Null when nothing compares. */
  matched: boolean | null;
  /** What the row is, or why it has no counterpart. Never an invented cause. */
  note: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The broker half of every charge key. Trimmed and lower-cased because the
 * reference row and the trade row are written by two different importers over
 * the same word, and a charge line that failed to join on casing alone would
 * report the broker's whole fee as a delta.
 */
const brokerKey = (broker: string | null | undefined) => (broker ?? "").trim().toLowerCase();

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

/**
 * EVERY identity one of the book's trades can be joined on — its ISIN AND its
 * upper-cased symbol/tradingsymbol, so the book is indexed under all of them.
 *
 * A reference row still picks ONE key (`scripKey` above): a row that states an
 * ISIN joins on the ISIN, a row that states none joins on the symbol. Indexing
 * the book on the ISIN alone meant the Angel One P&L statement — which emits
 * `isin: null, key: symbol` for every scrip row — could never join a single
 * line: each one landed beside a Vyuha side of zero and reported the whole of
 * the broker's figure as the delta. The two keys never double-count a line,
 * because a line looks up exactly one of them.
 */
function scripKeysOf(t: Pick<ReconcileTrade, "isin" | "symbol" | "tradingsymbol">): string[] {
  const out: string[] = [];
  for (const v of [t.isin, t.symbol, t.tradingsymbol]) {
    const k = (v ?? "").trim().toUpperCase();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Vyuha's segment → the broker's segment family.
 *
 * TYPED `Record<Segment, …>` ON PURPOSE: this map used to be hand-written from
 * a vocabulary that does not exist (`fut_index`, `opt_stock`, `comm_fut`, …),
 * so EVERY F&O trade fell through `FAMILY_OF[t.segment] ?? null` and the F&O
 * segment line reported Vyuha's side as ₹0 against the broker's own total —
 * a 100%-of-the-figure error that looked like a reconciliation result. Keyed
 * on `Segment`, tsc now fails the build when `lib/domain/constants.ts` gains
 * a segment nobody classified here.
 *
 * There is no `currency` entry because Vyuha has no currency segment: a
 * broker's currency row therefore compares against a real, stated zero.
 */
const FAMILY_OF: Record<Segment, "equity" | "fno" | "commodity" | "currency"> = {
  eq_delivery: "equity",
  eq_mtf: "equity",
  eq_intraday: "equity",
  index_option: "fno",
  stock_option: "fno",
  future: "fno",
  commodity_future: "commodity",
  commodity_option: "commodity",
};

/** The reverse, for naming a disagreement. Derived, never re-typed. */
export const SEGMENT_WORDS: Record<string, string[]> = Object.entries(FAMILY_OF).reduce(
  (acc, [seg, fam]) => ((acc[fam] ??= []).push(seg), acc),
  {} as Record<string, string[]>,
);

/** The family a book segment belongs to, or null when nothing classifies it. */
const familyOf = (segment: string): string | null =>
  (FAMILY_OF as Record<string, string>)[segment] ?? null;

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
  const vyuhaByFamily = new Map<string, ReturnType<typeof emptyFigures>>();
  const openQtyByScrip = new Map<string, number>();
  /** Open positions per segment family — the segment-scope twin of the above. */
  const openByFamily = new Map<string, { count: number; qty: number }>();
  /**
   * Open positions across the WHOLE book. An open lot has no sell date, so
   * `fyOf(null)` puts it in the current FY and in no other — which is exactly
   * where an FY line may state it, and the only FY line that may.
   */
  const openAll = { count: 0, qty: 0 };
  /** Closed trades whose segment no family classifies — the one line that owns them. */
  const vyuhaUnclassified = emptyFigures();
  /** Book segments no family classifies. A fact, and the guard on FAMILY_OF. */
  const unclassified = new Map<string, number>();
  const unpricedByScrip = new Map<string, { count: number; sellValue: number }>();
  const unpricedByFy = new Map<string, { count: number; sellValue: number }>();
  const unpricedByFamily = new Map<string, { count: number; sellValue: number }>();
  const segmentsByScrip = new Map<string, Set<string>>();
  const labelByScrip = new Map<string, string>();
  /**
   * ISINs seen under each SYMBOL key. Two ISINs under one ticker means the
   * book holds two securities that answer to the same string — `scripKeysOf`
   * indexes both under it, so a symbol-keyed reference row (Angel One's P&L
   * statement states `isin: null` on every scrip line) read the SUM of two
   * securities as its Vyuha side and manufactured the other one's P&L as a
   * delta. A sum of two securities is not this scrip's figure at any price.
   */
  const isinsBySymbol = new Map<string, Set<string>>();
  /**
   * DP and pledge charges the BOOK holds, per BROKER and per FY of the sale
   * that incurred them, and every trade touching a date per BROKER.
   *
   * THE BROKER IS PART OF EVERY KEY. A charge line is one broker's statement;
   * comparing it against every broker's charges reported the other brokers'
   * fees as a delta this one's statement disputes — on a two-broker book that
   * agreed to the paisa, ₹60 of Dhan DP fees and ₹40 of Angel One's each read
   * against ₹100, printing Δ −40 and Δ −60. Both figures were fabrications.
   */
  const dpByFy = new Map<string, number>();
  const pledgeByFy = new Map<string, number>();
  const tradesByDate = new Map<string, ReconcileTrade[]>();
  /**
   * `broker|fy` pairs the book actually holds a SALE for. It is what tells an
   * empty comparison ("this broker sold nothing that year") apart from a real
   * zero, so the line can say "not compared" instead of claiming the broker's
   * whole fee as a gap (invariant 6).
   */
  const soldByBrokerFy = new Set<string>();

  for (const t of trades) {
    const keys = scripKeysOf(t);
    const ownIsin = (t.isin ?? "").trim().toUpperCase();
    for (const key of keys) {
      if (ownIsin && key !== ownIsin) {
        const set = isinsBySymbol.get(key) ?? new Set<string>();
        set.add(ownIsin);
        isinsBySymbol.set(key, set);
      }
      if (!labelByScrip.has(key)) labelByScrip.set(key, t.symbol ?? t.tradingsymbol ?? key);
      const segs = segmentsByScrip.get(key) ?? new Set<string>();
      segs.add(t.segment);
      segmentsByScrip.set(key, segs);
    }
    const family = familyOf(t.segment);
    if (!family) unclassified.set(t.segment, (unclassified.get(t.segment) ?? 0) + 1);
    const fy = fyOf(t.sellDate, fyStartMonth, fallbackFy);

    // A DP fee is levied on a DELIVERY SALE, so the sale's year owns it. An
    // open position has not incurred one, and `fyOf(null)` would file it under
    // the current year on the strength of nothing.
    const bk = brokerKey(t.broker);
    if (t.sellDate) {
      const fyKey = `${bk}|${fy}`;
      soldByBrokerFy.add(fyKey);
      dpByFy.set(fyKey, r2((dpByFy.get(fyKey) ?? 0) + (t.dpCharges ?? 0)));
      pledgeByFy.set(fyKey, r2((pledgeByFy.get(fyKey) ?? 0) + (t.pledgeCharges ?? 0)));
    }
    for (const d of new Set([t.buyDate ?? null, t.sellDate])) {
      if (!d) continue;
      const dateKey = `${bk}|${d}`;
      const arr = tradesByDate.get(dateKey) ?? [];
      arr.push(t);
      tradesByDate.set(dateKey, arr);
    }

    // An unpriced sale is a SALE WITH NO PURCHASE, and whether the position is
    // closed or still open changes nothing about that. It used to be counted
    // only for closed trades, below the `isOpen` guard — so the one shape that
    // is ALWAYS unpriced, an opening sell, was the one shape never counted,
    // and the line it explains carried no reason at all.
    if (t.acquisition === "unknown" && t.sellQty > 0) {
      const u = unpricedByFy.get(fy) ?? { count: 0, sellValue: 0 };
      u.count++; u.sellValue += t.sellValue;
      unpricedByFy.set(fy, u);
      if (family) {
        const uf = unpricedByFamily.get(family) ?? { count: 0, sellValue: 0 };
        uf.count++; uf.sellValue += t.sellValue;
        unpricedByFamily.set(family, uf);
      }
      for (const key of keys) {
        const us = unpricedByScrip.get(key) ?? { count: 0, sellValue: 0 };
        us.count++; us.sellValue += t.sellValue;
        unpricedByScrip.set(key, us);
      }
    }

    if (t.isOpen) {
      // An open lot is the commonest honest reason for a gap: the broker has
      // realised a position Vyuha still holds open (or vice versa).
      for (const key of keys) openQtyByScrip.set(key, (openQtyByScrip.get(key) ?? 0) + (t.buyQty - t.sellQty));
      if (family) {
        const o = openByFamily.get(family) ?? { count: 0, qty: 0 };
        o.count++; o.qty += Math.abs(t.buyQty - t.sellQty);
        openByFamily.set(family, o);
      }
      openAll.count++; openAll.qty += Math.abs(t.buyQty - t.sellQty);
      continue;
    }
    const fyAcc = vyuhaByFy.get(fy) ?? emptyFigures();
    addTrade(fyAcc, t);
    vyuhaByFy.set(fy, fyAcc);
    if (family) {
      const famAcc = vyuhaByFamily.get(family) ?? emptyFigures();
      addTrade(famAcc, t);
      vyuhaByFamily.set(family, famAcc);
    } else {
      addTrade(vyuhaUnclassified, t);
    }
    for (const key of keys) {
      const sAcc = vyuhaByScrip.get(key) ?? emptyFigures();
      addTrade(sAcc, t);
      vyuhaByScrip.set(key, sAcc);
    }
  }

  // ── The broker's side, aggregated to the same buckets ────────────────────
  interface Bucket { stated: Record<string, number>; brokers: Set<string>; isin: string | null; label: string; statesCharges: boolean; fys: Set<string> }
  const fyBuckets = new Map<string, Bucket>();
  const scripBuckets = new Map<string, Bucket>();
  const segmentBuckets = new Map<string, Bucket>();
  /** Segment families this broker states any non-zero figure for. */
  const claimedSegments = new Set<string>();
  /** Demat rows, kept apart from the realised ones — see ReconcileHolding. */
  interface HoldingBucket { qty: number; label: string; isin: string | null; brokers: Set<string>; asOf: string | null }
  const holdingBuckets = new Map<string, HoldingBucket>();

  const put = (map: Map<string, Bucket>, key: string, r: ReferenceRowRecord, label: string) => {
    const b = map.get(key) ?? { stated: {}, brokers: new Set<string>(), isin: r.isin ?? null, label, statesCharges: false, fys: new Set<string>() };
    for (const [f, v] of Object.entries(r.figures ?? {})) b.stated[f] = r2((b.stated[f] ?? 0) + v);
    b.brokers.add(r.broker);
    if (r.isin && !b.isin) b.isin = r.isin;
    if (typeof r.figures?.totalCharges === "number") b.statesCharges = true;
    if (r.fy) b.fys.add(r.fy);
    map.set(key, b);
  };

  for (const r of refs) {
    if (r.scope === "fy") {
      put(fyBuckets, r.key, r, r.key);
    } else if (r.scope === "scrip") {
      const key = scripKey(r.isin ?? r.key, r.symbol ?? r.key);
      put(scripBuckets, key, r, r.symbol ?? r.key);
      // A dated scrip figure also belongs to its FY, but only the broker's
      // OWN fy rows are compared per FY — summing scrip rows into an FY total
      // would state the same money twice when the file gives both.
    } else if (r.scope === "holding") {
      // A demat quantity is NOT a realised quantity. Adding it to the scrip
      // bucket puts a holding beside a sale and calls the sum a disagreement.
      const key = scripKey(r.isin ?? r.key, r.symbol ?? r.key);
      const h = holdingBuckets.get(key) ?? { qty: 0, label: r.symbol ?? r.key, isin: r.isin ?? null, brokers: new Set<string>(), asOf: r.asOf };
      h.qty = r2(h.qty + (r.figures?.qty ?? 0));
      h.brokers.add(r.broker);
      if (r.isin && !h.isin) h.isin = r.isin;
      // The LATEST statement date wins the label: an older demat file states
      // an older truth, and dating the row with the earlier one would blame
      // the book for a position opened since.
      if (r.asOf && (!h.asOf || r.asOf > h.asOf)) h.asOf = r.asOf;
      holdingBuckets.set(key, h);
    } else if (r.scope === "segment") {
      // A segment total states which families this broker trades in — a family
      // whose every figure is zero is not a claim, it is a row the report
      // prints because it prints all four. Only a non-empty segment names one.
      if (Object.values(r.figures ?? {}).some((v) => v !== 0)) {
        claimedSegments.add(r.key);
        put(segmentBuckets, r.key, r, r.key);
      }
    }
  }

  const lines = (
    scope: "fy" | "scrip" | "segment",
    buckets: Map<string, Bucket>,
    vyuhaMap: Map<string, ReturnType<typeof emptyFigures>>,
    unpricedMap: Map<string, { count: number; sellValue: number }>,
  ): ReconcileLine[] =>
    [...buckets].map(([key, b]) => {
      // A symbol-keyed row whose ticker covers more than one security in the
      // book is NOT COMPARABLE. It gets the broker's side, no Vyuha side and
      // no delta — the honest answer, and the only one that is not a sum of
      // two companies wearing this row's name.
      const shared = scope === "scrip" ? isinsBySymbol.get(key) : undefined;
      if (shared && shared.size >= 2) {
        return {
          scope, key, label: b.label, isin: b.isin,
          fy: b.fys.size === 1 ? [...b.fys][0] : null,
          broker: b.brokers.size === 1 ? [...b.brokers][0] : null,
          stated: b.stated,
          vyuha: {},
          delta: {},
          matched: false,
          reasons: [{
            code: "ambiguous_symbol" as const,
            count: shared.size,
            detail: `ambiguous symbol: ${shared.size} securities in your book share this ticker (${[...shared].sort().join(", ")}). This row states no ISIN, so there is no way to tell which one it is about — Vyuha states no figure rather than the sum of ${shared.size}.`,
          }],
          checkedNote: null,
        };
      }
      const v = vyuhaMap.get(key) ?? emptyFigures();
      const vyuha: Record<string, number> = {
        qty: r2(v.qty), buyValue: r2(v.buyValue), sellValue: r2(v.sellValue),
        grossPnl: r2(v.grossPnl), netPnl: r2(v.netPnl), totalCharges: r2(v.totalCharges),
      };
      const reasons: ReconcileReason[] = [];

      const unpriced = unpricedMap.get(key);
      if (unpriced && unpriced.count > 0) {
        reasons.push({
          code: "unpriced_sales",
          count: unpriced.count,
          amount: r2(unpriced.sellValue),
          detail: `${unpriced.count} sale${unpriced.count === 1 ? "" : "s"} worth ₹${r2(unpriced.sellValue).toLocaleString("en-IN")} ${unpriced.count === 1 ? "has" : "have"} no purchase in your book, so Vyuha states no cost for ${unpriced.count === 1 ? "it" : "them"} — the broker's figure does.`,
        });
      }

      if (!b.statesCharges && v.totalCharges > 0) {
        reasons.push({
          code: "charges_omitted",
          amount: r2(v.totalCharges),
          detail: `The file states no charges; Vyuha's own charges for these rows are ₹${r2(v.totalCharges).toLocaleString("en-IN")}, which is the whole of any gross-vs-net gap.`,
        });
      }

      /**
       * OPEN LOTS, at every scope. Which lines may state the fact, and so
       * which lines may later claim to have CHECKED it, differs:
       *   segment — the family's own open positions;
       *   scrip   — that scrip's own open quantity;
       *   fy      — the whole book's open lots, and ONLY on the current-FY
       *           line: an open lot has no sell date, so it belongs to that
       *           year and to no other. An older FY line does not check this.
       */
      let openChecked = true;
      if (scope === "segment") {
        // The facts the scrip table states, asked of a segment family. They
        // were computed for scrip lines ONLY, so the Dhan Realised P&L —
        // which states segment rows and nothing else — put every one of its
        // lines on screen with an empty "Why" column.
        const open = openByFamily.get(key);
        if (open && open.count > 0) {
          reasons.push({
            code: "open_lots",
            count: open.count,
            detail: `${open.qty.toLocaleString("en-IN")} share${open.qty === 1 ? "" : "s"} across ${open.count} position${open.count === 1 ? "" : "s"} are still open in your book; a segment total states only what the broker has already realised.`,
          });
        }
      } else if (scope === "fy") {
        openChecked = key === fallbackFy;
        if (openChecked && openAll.count > 0) {
          reasons.push({
            code: "open_lots",
            count: openAll.count,
            detail: `${openAll.qty.toLocaleString("en-IN")} share${openAll.qty === 1 ? "" : "s"} across ${openAll.count} position${openAll.count === 1 ? "" : "s"} are still open in your book. An open lot has no sell date, so it falls in ${fallbackFy}, the current year; an FY total states only what the broker has already realised.`,
          });
        }
      }

      if (scope === "scrip") {
        // NOT gated on a stated quantity: the Angel One P&L statement states a
        // gross P&L per scrip and no qty at all, so the gate silently turned
        // every one of its lines into a claim of "0 open lots" on a book that
        // was holding the scrip.
        const open = openQtyByScrip.get(key) ?? 0;
        if (open !== 0) {
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
      // A gap the book cannot account for is NOT a "mismatch" — that word says
      // nothing a reader can act on. It is a list of the facts that were
      // checked and came back zero, so the next question is obvious and the
      // screen never pretends to an explanation it does not have (invariant 6).
      // ONLY the facts THIS scope actually computed. The note used to recite
      // all four on every line, so an FY line — where neither open lots nor
      // segment tagging is looked at — swore it had checked both and found
      // them zero. A note that names a check nobody ran is worse than no note.
      const checkedFacts = [
        "0 sales without a purchase",
        ...(openChecked ? ["0 open lots"] : []),
        ...(scope === "scrip" ? ["no segment tagged outside the broker's families"] : []),
        b.statesCharges ? "this file states its own charges" : "your book states no charges for these rows either",
      ];
      const checkedNote = !matched && reasons.length === 0
        ? `Nothing in your book accounts for this gap: ${checkedFacts.join(", ")}. Checked, and found nothing — the cause is outside these ${checkedFacts.length} facts.`
        : null;
      return {
        scope,
        key,
        label: b.label,
        isin: b.isin,
        fy: b.fys.size === 1 ? [...b.fys][0] : null,
        broker: b.brokers.size === 1 ? [...b.brokers][0] : null,
        stated: b.stated,
        vyuha,
        delta,
        matched,
        reasons,
        checkedNote,
      };
    }).sort((a, b) => a.key.localeCompare(b.key));

  const holdings: ReconcileHolding[] = [...holdingBuckets].map(([key, h]) => {
    const vyuhaQty = r2(openQtyByScrip.get(key) ?? 0);
    return {
      key,
      label: labelByScrip.get(key) ?? h.label,
      isin: h.isin,
      broker: h.brokers.size === 1 ? [...h.brokers][0] : null,
      asOf: h.asOf,
      brokerQty: h.qty,
      vyuhaQty,
      delta: r2(h.qty - vyuhaQty),
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  /**
   * Trades tagged with a segment no family classifies are attributed ONCE, to
   * a line of their own. They used to be pushed as a `product_difference`
   * reason onto EVERY segment line, so one stray trade blamed equity, F&O and
   * commodity alike for a gap none of them contains it in. The line states
   * Vyuha's side and no broker side, because the broker states none — it reads
   * as "not compared", which is what it is.
   */
  const segmentLines = lines("segment", segmentBuckets, vyuhaByFamily, unpricedByFamily);
  if (unclassified.size > 0 && segmentBuckets.size > 0) {
    const n = [...unclassified.values()].reduce((a, b) => a + b, 0);
    const u = vyuhaUnclassified;
    segmentLines.push({
      scope: "segment",
      key: "unclassified",
      label: "Unclassified segment",
      isin: null,
      fy: null,
      broker: null,
      stated: {},
      vyuha: {
        qty: r2(u.qty), buyValue: r2(u.buyValue), sellValue: r2(u.sellValue),
        grossPnl: r2(u.grossPnl), netPnl: r2(u.netPnl), totalCharges: r2(u.totalCharges),
      },
      delta: {},
      matched: false,
      reasons: [{
        code: "product_difference",
        count: n,
        detail: `${n} trade${n === 1 ? "" : "s"} in your book are tagged ${[...unclassified.keys()].sort().join(", ")}, which belongs to no segment family — they are counted on neither side of the rows above, and are stated here instead.`,
      }],
      checkedNote: null,
    });
  }

  return {
    fy: lines("fy", fyBuckets, vyuhaByFy, unpricedByFy),
    segment: segmentLines,
    scrip: lines("scrip", scripBuckets, vyuhaByScrip, unpricedByScrip),
    holdings,
    charges: chargeLines(
      refs.filter((r) => r.scope === "charge"),
      { dpByFy, pledgeByFy, tradesByDate, soldByBrokerFy, fyStartMonth, fallbackFy },
    ),
  };
}

/** A contract note's charge key -> the book's own column for the same money. */
const NOTE_CHARGE_COLUMNS: Record<string, keyof ReconcileTrade> = {
  brokerage: "brokerage",
  stt: "sttCtt",
  exchangeTxn: "exchangeTxn",
  sebi: "sebi",
  stamp: "stampDuty",
  ipft: "ipft",
  gst: "gst",
};

interface ChargeContext {
  /** Keyed `broker|fy` — never `fy` alone. See `soldByBrokerFy`'s comment. */
  dpByFy: Map<string, number>;
  pledgeByFy: Map<string, number>;
  /** Keyed `broker|date`. */
  tradesByDate: Map<string, ReconcileTrade[]>;
  soldByBrokerFy: Set<string>;
  fyStartMonth: number;
  fallbackFy: string;
}

/**
 * "Charges the broker states" - the read side of `scope: "charge"`.
 *
 * Three sources state charges, and they state DIFFERENT THINGS, so each gets
 * its own comparison and none is forced into another's shape:
 *
 *   - Dhan's DP charges report: a fee per ISIN per day. Compared per FY
 *     against the book's own `dp_charges` on trades SOLD in that year, because
 *     a delivery sale is the event a DP fee is levied on.
 *   - A Dhan contract note: brokerage/STT/GST and the rest, for one trading
 *     day. Compared per NOTE DATE against the book's charges on trades of that
 *     day. A position's charges are the WHOLE position's, so a multi-day
 *     position carries its buy-day and sell-day charges together; the line
 *     says so rather than reporting that arithmetic as a disagreement.
 *   - Angel One's ledger tables: dp, pledge, cuspa, interest. Only dp and
 *     pledge have a column in the book. CUSPA sell-off and delayed-payment
 *     interest have none, and are shown STATED with no delta at all - an
 *     invented zero on the Vyuha side would report the whole of the broker's
 *     fee as a gap the book disagrees with, which it does not (invariant 6).
 *
 * EVERY GROUP IS KEYED ON THE BROKER FIRST. A line is one broker's statement:
 * its stated side is that broker's file and its Vyuha side is that broker's
 * trades. Two brokers' figures are never added together - a sum of two
 * statements is a figure neither statement states - and a broker whose book
 * holds nothing for the year or the day gets NO Vyuha side at all rather than
 * a zero another broker's fees would then appear to disagree with.
 */
function chargeLines(refs: ReferenceRowRecord[], ctx: ChargeContext): ReconcileChargeLine[] {
  const out: ReconcileChargeLine[] = [];
  const fyOfDate = (d: string | null) => (d ? fyOf(d, ctx.fyStartMonth, ctx.fallbackFy) : null);

  interface Group { stated: Record<string, number>; brokers: Set<string>; sourceIds: Set<string>; fy: string | null }
  const group = (m: Map<string, Group>, key: string, r: ReferenceRowRecord, fy: string | null, figures: Record<string, number>) => {
    const g = m.get(key) ?? { stated: {}, brokers: new Set<string>(), sourceIds: new Set<string>(), fy };
    for (const [f, v] of Object.entries(figures)) g.stated[f] = r2((g.stated[f] ?? 0) + v);
    g.brokers.add(r.broker);
    g.sourceIds.add(r.sourceId);
    m.set(key, g);
  };

  const dp = new Map<string, Group>();
  const notes = new Map<string, Group>();
  const ledger = new Map<string, Group>();

  for (const r of refs) {
    const bk = brokerKey(r.broker);
    if (r.sourceId === "dhan-dp-charges") {
      // The FY comes from the file's OWN `asOf`, never from today: a report of
      // last year's fees belongs to last year.
      const fy = fyOfDate(r.asOf);
      group(dp, `${bk}|${fy ?? "undated"}`, r, fy, { charges: r.figures.charges ?? 0, qty: r.figures.qty ?? 0 });
    } else if (r.sourceId === "dhan-contract-note") {
      const date = r.asOf ?? "undated";
      group(notes, `${bk}|${date}`, r, fyOfDate(r.asOf), { [r.key]: r.figures.amount ?? 0 });
    } else {
      const fy = r.fy ?? fyOfDate(r.asOf);
      group(ledger, `${bk}|${r.sourceId}|${r.key}|${fy ?? ""}`, r, fy, { amount: r.figures.amount ?? 0 });
    }
  }

  const one = (set: Set<string>) => (set.size === 1 ? [...set][0] : null);

  for (const [key, g] of [...dp].sort((a, b) => a[0].localeCompare(b[0]))) {
    const broker = one(g.brokers);
    const stated = { charges: r2(g.stated.charges ?? 0), qty: r2(g.stated.qty ?? 0) };
    const sold = g.fy ? ctx.soldByBrokerFy.has(`${brokerKey(broker)}|${g.fy}`) : false;
    const vyuha = sold ? { charges: r2(ctx.dpByFy.get(`${brokerKey(broker)}|${g.fy}`) ?? 0) } : null;
    out.push({
      kind: "dp", key, label: g.fy ? `DP charges - FY ${g.fy}` : "DP charges - undated",
      broker, sourceId: one(g.sourceIds) ?? "dhan-dp-charges", fy: g.fy,
      stated,
      vyuha,
      delta: vyuha ? { charges: r2(stated.charges - vyuha.charges) } : null,
      matched: vyuha ? withinTolerance(stated.charges, vyuha.charges) : null,
      note: !g.fy
        ? "The file states no date, so no year owns these fees and nothing in your book is comparable to them."
        : sold
          ? `The broker's DP fee per sale, against your book's own dp_charges on trades sold in this year at ${broker ?? "this broker"}.`
          : `Your book holds no trades sold at ${broker ?? "this broker"} in FY ${g.fy}, so there is nothing to compare these fees against - another broker's charges are not this statement's counterpart.`,
    });
  }

  for (const [key, g] of [...notes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const broker = one(g.brokers);
    const date = key.slice(key.indexOf("|") + 1);
    const stated: Record<string, number> = {};
    for (const [k, v] of Object.entries(g.stated)) stated[k] = r2(v);
    stated.total = r2(Object.values(g.stated).reduce((a, v) => a + v, 0));
    const dayTrades = ctx.tradesByDate.get(`${brokerKey(broker)}|${date}`) ?? [];
    /**
     * NO position of this broker's on this date means there is nothing to
     * compare, not a comparison against zero. Against a zero the whole of the
     * note printed as "Broker higher" beside a note reading "0 positions touch
     * this date" - a disagreement stated in the same breath as the fact that
     * nothing was compared (invariant 6).
     */
    let vyuha: Record<string, number> | null = null;
    if (dayTrades.length > 0) {
      const v: Record<string, number> = {};
      let total = 0;
      for (const k of Object.keys(stated)) {
        if (k === "total") continue;
        const col = NOTE_CHARGE_COLUMNS[k];
        if (!col) continue;
        const sum = r2(dayTrades.reduce((a, t) => a + ((t[col] as number | undefined) ?? 0), 0));
        v[k] = sum;
        total += sum;
      }
      v.total = r2(total);
      vyuha = v;
    }
    const spanning = dayTrades.filter((t) => t.buyDate && t.sellDate && t.buyDate !== t.sellDate).length;
    out.push({
      kind: "note", key, label: `Contract note - ${date}`,
      broker, sourceId: one(g.sourceIds) ?? "dhan-contract-note", fy: g.fy,
      stated,
      vyuha,
      delta: vyuha ? deltaOf(stated, vyuha) : null,
      matched: vyuha ? withinTolerance(stated.total, vyuha.total) : null,
      note: !vyuha
        ? `No position in your book at ${broker ?? "this broker"} touches this date, so there is nothing to compare this note's charges against.`
        : spanning > 0
          ? `The note states ONE day's charges; ${spanning} of the ${dayTrades.length} position${dayTrades.length === 1 ? "" : "s"} touching this date also carries its other leg's charges, which this day's note does not state.`
          : `${dayTrades.length} position${dayTrades.length === 1 ? "" : "s"} in your book touch${dayTrades.length === 1 ? "es" : ""} this date.`,
    });
  }

  const LEDGER_LABELS: Record<string, string> = {
    dp: "DP charges", pledge: "Pledge / unpledge charges",
    cuspa: "CUSPA sell-off charges", interest: "Interest charges",
  };
  for (const [key, g] of [...ledger].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = key.split("|");
    const type = parts[2] ?? key;
    const broker = one(g.brokers);
    const sold = g.fy ? ctx.soldByBrokerFy.has(`${brokerKey(broker)}|${g.fy}`) : false;
    const stated = { amount: r2(g.stated.amount ?? 0) };
    let vyuha: Record<string, number> | null = null;
    let note: string;
    if ((type === "dp" || type === "pledge") && g.fy && !sold) {
      note = `Your book holds no trades sold at ${broker ?? "this broker"} in FY ${g.fy}, so there is nothing to compare this charge against - another broker's charges are not this statement's counterpart.`;
    } else if (type === "dp" && g.fy) {
      vyuha = { amount: r2(ctx.dpByFy.get(`${brokerKey(broker)}|${g.fy}`) ?? 0) };
      note = `Against your book's own dp_charges on trades sold at ${broker ?? "this broker"} in this year.`;
    } else if (type === "pledge" && g.fy) {
      vyuha = { amount: r2(ctx.pledgeByFy.get(`${brokerKey(broker)}|${g.fy}`) ?? 0) };
      note = `Against your book's own pledge_charges on trades sold at ${broker ?? "this broker"} in this year.`;
    } else {
      note = `Stated by the broker - no Vyuha counterpart: your book has no column for ${LEDGER_LABELS[type] ?? type}, so there is nothing to subtract and no delta to state.`;
    }
    out.push({
      kind: "ledger", key,
      label: `${LEDGER_LABELS[type] ?? type}${g.fy ? ` - FY ${g.fy}` : ""}`,
      broker, sourceId: one(g.sourceIds) ?? "angelone-ledger", fy: g.fy,
      stated,
      vyuha,
      delta: vyuha ? { amount: r2(stated.amount - vyuha.amount) } : null,
      matched: vyuha ? withinTolerance(stated.amount, vyuha.amount) : null,
      note,
    });
  }

  return out;
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
    // Selected because a charge line's Vyuha side is ONE broker's trades.
    broker: tradesTable.broker,
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
    buyDate: tradesTable.buyDate,
    brokerage: tradesTable.brokerage,
    sttCtt: tradesTable.sttCtt,
    exchangeTxn: tradesTable.exchangeTxn,
    sebi: tradesTable.sebi,
    stampDuty: tradesTable.stampDuty,
    ipft: tradesTable.ipft,
    gst: tradesTable.gst,
    dpCharges: tradesTable.dpCharges,
    pledgeCharges: tradesTable.pledgeCharges,
  }).from(tradesTable);
  const rows = (where.length ? q.where(and(...where)) : q).all() as ReconcileTrade[];
  return reconcileFrom(refs, rows, getSettings()?.fyStartMonth ?? 4);
}
