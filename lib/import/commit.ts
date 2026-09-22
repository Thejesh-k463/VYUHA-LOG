import "server-only";
import { db } from "@/lib/db";
import { isDerivativeInstrument, writeTypedMark } from "@/lib/queries/mtm";
import {
  trades as tradesTable,
  importBatches,
  classificationOverrides,
  riskConfig,
  settings as settingsTable,
  tradeLegs,
  tradeAttachments,
  accounts as accountsTable,
  brokerReference,
} from "@/lib/db/schema";
import { eq, and, ne, or, sql, isNull, inArray, notInArray } from "drizzle-orm";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { pricingDate, ratesForTrade, resolvePlan, type PlanAccount, type RatesMap } from "@/lib/engine/rates";
// Wave U — WHICH PLAN prices this write. The plan is the ACCOUNT's, resolved
// against the TRADE's broker and its own pricing date, so an account on a paid
// tier never asks charge_config for another broker's plan key (design review
// item 2). The account row is read ONCE per call here and the pure
// `resolvePlan` decides per trade; it returns "default" for every case that is
// not a match and cannot throw.
import { planAccountOf } from "@/lib/queries/broker-plan";
import { todayIstIso, normalizeDate, storedDateProblem, calendarDaysHeld, sameDay } from "@/lib/domain/trading-day";
import { closingAggregate } from "@/lib/domain/close-aggregate";
import { classifyStoredSignal, SIGNAL_TOMBSTONE } from "@/lib/domain/signal";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { ChargeBreakdown, Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Broker, Bucket, Exchange, Segment } from "@/lib/domain/constants";
import { SEGMENT_BUCKET } from "@/lib/domain/constants";
import type { CommitResult, EnrichmentRow, ParsedFile, ReferenceRow } from "./types";
import { referenceVsBookNote, relabelledFromWarnings, type ImportShape } from "@/lib/domain/import-shape";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";
import { detectCrossBrokerEchoes, detectCrossSourceDuplicates, type CrossSourceReport } from "./cross-source";
import { executionIdentity, scopedHashes } from "./trade-identity";
import { recordAudit } from "@/lib/audit";
import { getMarginPct } from "@/lib/queries/margin";
import { getSymbolsByIsin } from "@/lib/queries/instruments";
import { bundledSymbolByIsin, isCodedSymbol, nameByIsin, resolveCodedSymbols } from "./isin-symbol";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";
import { resolvePerTradeCap, type CapRow } from "@/lib/risk/limits";
import { capR, type RiskSource } from "@/lib/queries/risk-cap";
import { ipoEditCharges, type IpoEditPricing } from "@/lib/analytics/ipo";
import { sellChargerFor } from "@/lib/queries/ipos";
// D20 (wave 2O): the ladder is the SINGLE writer of a staged parent's priced heads,
// so the editor's own save hands them back to it. Server-only, like this module and
// `lib/queries/ipos` above; `lib/queries/staged.ts` imports nothing from here, so
// the graph stays acyclic.
import { rebuildStagedTrade, legCountOf, hasLadder } from "@/lib/queries/staged";
import { chargeInputsChanged, chargeInputsOf, patchMovesChargeInput, statesNoCharges, storedCharges } from "@/lib/domain/trade-edit";
import { RECONCILE_SOURCE_IDS } from "@/lib/analytics/reconcile";
import { deleteTradesByIds } from "@/lib/queries/delete";
import {
  heldIdentityHashes,
  isLotIdentityFrozen,
  STALE_CLOSE_NOTE,
  withStaleCloseNote,
  // W2a — the applier (dormant behind `options.autoClose`, default false).
  planLotCloses,
  matchKey,
  AUTO_CLOSE_NOTE,
  splitByRemainder,
  withLotCloseNote,
  withAutoClosedLotNote,
  withClosedByNote,
  withExecBillNote,
  withScaledRemainderNote,
  // W3 — lifecycle: un-close, the delete refusals, the merge refusal.
  closedByHash,
  execBillFromNotes,
  withoutAutoCloseNotes,
  PARTIAL_CLOSE_NOTE,
  DEDUP_ALIAS_PREFIX,
  autoCloseSentences,
  emptyAutoCloseCounters,
  type AutoCloseCounters,
  type LotClose,
  type OpenLot,
} from "./close-open-lots";
import { withoutSyncChargesNote } from "@/lib/analytics/ipo-link";
import { saleJournalFields, staleAmbiguousNote, staleFillsNote, staleJournalNote, staleOpenPairs } from "@/lib/analytics/data-quality";

/** eq_mtf own-margin % for THIS trade's broker (from margin_config — real
 * leverage varies by broker), falling back to the seeded default if missing. */
function mtfOwnMarginPct(broker: string): number {
  return getMarginPct(broker, "eq_mtf");
}

/**
 * L3 (v4.3.0 wave 2L) — the shape matched, and then the CALENDAR.
 *
 * `isRealDay` / `normalizeDate` were private to this server-only module, so the close
 * dialog restated the rule and the staged ladder went without it (finding G-G3-1:
 * `new Date(leg.tradeDate)` billed 1,449.86 of MTF interest for a real 192.33 on
 * '2026-02-31'). Wave 2M moved them VERBATIM into the pure `lib/domain/trading-day.ts`,
 * which both graphs can reach — ONE calendar implementation. Behaviour here is
 * unchanged: every caller below, `unreadableDate`, and the `normalizeDate` this module
 * re-exports all read the same function they always did.
 */

/**
 * L3 (wave 2L) — the refusal a writer returns for a date a user typed and this
 * module cannot read. Null when the value is blank (the caller's own fallback
 * applies) or readable.
 */
function unreadableDate(label: string, value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (raw === "" || normalizeDate(raw) != null) return null;
  return `The ${label} “${raw}” is not a real calendar day — enter it as a day that exists, for example 2026-06-15. Nothing was changed.`;
}

interface Override {
  segment: Segment | null;
  bucket: Bucket | null;
  exchange: Exchange | null;
  isMtf: boolean | null;
  setupTag: string | null;
}

interface BuiltRow {
  classification: ReturnType<typeof classify>;
  charges: ChargeBreakdown;
  netPnl: number;
  isOpen: boolean;
  /**
   * The hash this row is stored and de-duplicated under. `executionIdentity`'s
   * own hash until `applyScopedIdentity` re-keys it — which happens only where
   * rows of THIS file share a hash across more than one scope (F-L1-7).
   */
  dedup: string;
  /**
   * `segment|exchange` from the FILE's own classification, before any
   * `classification_overrides` row is applied (lib/import/trade-identity.ts).
   * Compared between rows of one file and never against a stored row.
   */
  scope: string;
  buyOrderCount: number;
  sellOrderCount: number;
  riskAmount: number | null;
  rMultiple: number | null;
  /** 'cap' — or 'frozen' for a staged import (invariant 4); null with no risk. */
  riskSource: RiskSource | null;
  realisedPct: number | null;
}

/**
 * The risk a writer stores when it RE-PRICES an existing row (a supersede, a
 * reclassification, a close, a Data Quality join): a `'cap'` row re-resolves to
 * today's cap for the bucket/segment it will hold AFTER this write (D1 — a cap
 * is a unit, and the row must read in the one the book reads in); any other row
 * keeps the risk it states, because a typed or frozen risk is not the cap's.
 */
function keptRisk(
  row: { riskSource: string | null; riskAmount: number | null },
  bucket: string,
  segment: string,
  capRows: readonly CapRow[],
): { riskAmount: number | null; followsCap: boolean } {
  if (row.riskSource === "cap") return { riskAmount: resolvePerTradeCap(capRows, bucket, segment), followsCap: true };
  return { riskAmount: row.riskAmount, followsCap: false };
}

/** Apply auto-classification + any persisted override, then compute charges. */
function buildRow(
  t: NormalizedTrade,
  rates: RatesMap,
  overrides: Map<string, Override>,
  defaults: { buyOrders: number; sellOrders: number; capRows: readonly CapRow[] },
  /** The account this import lands in, for the plan (wave U). Null = "default". */
  planAccount: PlanAccount | null = null,
): BuiltRow {
  let cls = classify({
    tradingsymbol: t.tradingsymbol,
    broker: t.broker,
    isin: t.isin,
    productHint: t.productHint,
    exchangeHint: t.exchangeHint,
  });
  // W1: the ONE identity door (lib/import/trade-identity.ts). `hash` is
  // `dedupHash` unchanged; `scope` is taken HERE, off the file's own
  // classification, so it cannot depend on an override keyed by the hash.
  const id = executionIdentity({ ...t, segment: cls.segment, exchange: cls.exchange });
  const dedup = id.hash;

  const ov = overrides.get(dedup);
  if (ov) {
    const segment = ov.segment ?? (ov.isMtf ? "eq_mtf" : cls.segment);
    cls = {
      ...cls,
      segment,
      bucket: ov.bucket ?? SEGMENT_BUCKET[segment],
      exchange: ov.exchange ?? cls.exchange,
    };
  }

  const buyOrderCount = t.buyQty > 0 ? defaults.buyOrders : 0;
  const sellOrderCount = t.sellQty > 0 ? defaults.sellOrders : 0;

  const on = pricingDate(t, todayIstIso());
  const r = ratesForTrade(
    rates,
    { broker: t.broker, segment: cls.segment, exchange: cls.exchange, isin: t.isin, symbol: cls.symbol },
    on,
    resolvePlan(planAccount, t.broker, on, rates),
  );
  const computed = computeCharges(
    {
      segment: cls.segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount,
      sellOrderCount,
    },
    r,
  );

  /**
   * When the file states what the broker ACTUALLY charged, that is the truth.
   *
   * This is real money that really left the account; the engine cannot be more
   * accurate about a charge than the charge itself, and storing a computed
   * figure that differs from the contract note would make the journal disagree
   * with the broker. The computed breakdown is kept alongside as a cross-check
   * so drift in the rate table stays visible instead of silently overriding.
   */
  const reported = t.reportedCharges;
  const charges = reported
    ? {
        ...computed,
        ...reported,
        total:
          reported.total ??
          Math.round(
            ((reported.brokerage ?? 0) + (reported.sttCtt ?? 0) + (reported.exchangeTxn ?? 0) +
              (reported.sebi ?? 0) + (reported.stampDuty ?? 0) + (reported.ipft ?? 0) +
              (reported.gst ?? 0) + (reported.dpCharges ?? 0) + (reported.mtfInterest ?? 0) +
              (reported.pledgeCharges ?? 0)) * 100,
          ) / 100,
      }
    : computed;

  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;
  // Net non-zero, not just buyQty>sellQty — a pure sell-to-open (short) row has
  // buyQty=0 and must still be OPEN, not silently marked closed.
  const isOpen = t.buyQty !== t.sellQty;
  // D1 (v4.4.0) — THE per-trade cap for the segment this row classified into
  // (global < bucket < segment, lib/risk/limits.ts). It used to be the GLOBAL
  // row only, with a `?? 9500` nobody configured: an index_option import
  // ignored the index_option cap the breach checks enforced. No cap → no risk
  // and no R (invariant 6). A staged import is 'frozen' like every staged row
  // (invariant 4); anything else follows the cap.
  const riskAmount = resolvePerTradeCap(defaults.capRows, cls.bucket, cls.segment);
  const riskSource: RiskSource | null = stagedFromExecutions(t) ? (riskAmount == null ? null : "frozen") : "cap";
  const rMultiple = capR(netPnl, riskAmount);
  const realisedPct = t.buyValue > 0 && !isOpen ? Math.round((t.grossPnl / t.buyValue) * 10000) / 100 : null;

  return { classification: cls, charges, netPnl, isOpen, dedup, scope: id.scope, buyOrderCount, sellOrderCount, riskAmount, rMultiple, riskSource, realisedPct };
}

/**
 * W1 / F-L1-7 — give each row of THIS file the hash it must be stored and
 * de-duplicated under, in place.
 *
 * `dedupHash` carries no exchange and no segment, so an NSE sale and a BSE sale
 * of the same symbol, quantity, price and day collide and the second was
 * dropped as a duplicate of the first (since v1.10.0). `scopedHashes` re-keys
 * only the rows that actually collide across scopes — every other file's hashes
 * come back byte-for-byte as v4.4.0 wrote them, which is what makes a re-import
 * of a pre-4.5.0 file neither duplicate nor drop anything.
 *
 * A re-keyed row is then re-built when a classification override is stored
 * under its NEW hash: `buildRow` had to read overrides under the legacy one
 * (the override lookup precedes the classification that scope is taken from),
 * and a re-tag saved on such a row is keyed by what the ROW stores. Scope is
 * pre-override, so the second build cannot move the hash again.
 */
function applyScopedIdentity(
  built: { t: NormalizedTrade; b: BuiltRow }[],
  overrides: Map<string, Override>,
  rebuild: (t: NormalizedTrade, overrides: Map<string, Override>) => BuiltRow,
): void {
  const hashes = scopedHashes(built.map(({ b }) => ({ hash: b.dedup, scope: b.scope })));
  for (const [i, hash] of hashes.entries()) {
    const row = built[i]!;
    if (hash === row.b.dedup) continue;
    const ov = overrides.get(hash);
    if (ov) row.b = rebuild(row.t, new Map([[row.b.dedup, ov]]));
    row.b = { ...row.b, dedup: hash };
  }
}

// ───────────────────── W2a — the auto-close applier (DORMANT) ───────────────
//
// v4.5.0 W2a rebuilds the applier wave 1 switched off, and rebuilds it BEHIND
// an option: `commitParsedFile`/`previewParsedFile` take `{ autoClose }` and it
// defaults to FALSE, so every caller on this tree (the import route, the broker
// route, the auto-pull job) behaves exactly as v4.4.0 did. W2b turns it on,
// after W3 has built un-close and the delete/merge refusals — a close nobody
// can undo is not a feature.
//
// THE ONE-HOLDER RULE (design review revision 9). One execution hash may be
// held by exactly ONE row. Wave 1 put it on the slice AND on the lot as a held
// alias, and `lib/trash.ts:546-551` then skipped the slice's restore with
// "recorded in the position it closed" — 40 shares of realised P&L gone, and
// the re-import de-duplicated too. So, per execution:
//
//   1. a lot consumed WHOLE becomes the closed row itself and takes the
//      execution's hash as a HELD alias (`withLotCloseNote`); no slice exists;
//   2. else, if part of the execution is left over, the REMAINDER row keeps the
//      execution's own hash and is frozen by `withScaledRemainderNote` — the
//      one place a re-import of the file must still find it;
//   3. else the FIRST slice stores the execution's hash as its own.
//
// Every other piece takes `dedupHash` of its OWN legs and carries a
// `closed-by:<execHash>` segment, which `lotIdentityHashes` never reads. A
// partly consumed lot gets `AUTO_CLOSE_NOTE` and NOTHING else.
//
// CHARGES (R3/R6) follow `closeStaleLot`: each side keeps the bill it STATES, a
// side stating none is priced from `charge_config` on its own date, and every
// component is split BY REMAINDER (`splitByRemainder`) so the pieces always sum
// to what was charged. Every derived column (R60) comes from `buildRow` — the
// same code the ordinary insert uses — by handing it the closed row as a
// synthetic trade whose `reportedCharges` are the merged bill.

/** The ten stored charge heads of a computed or stored row. */
const partsOf = (c: StaleChargeParts): StaleChargeParts =>
  Object.fromEntries(STALE_CHARGE_PARTS.map((k) => [k, c[k] ?? 0])) as StaleChargeParts;

/**
 * R3, the ONE rule, shared by `closeStaleLot` (R26) and the applier: the bill a
 * stored row STATES, else `charge_config` priced for that row's own leg on its
 * own day. Never both for one side, and never a re-sum of the ten components
 * (`buildRow` keeps the ENGINE's value for a head the broker did not state
 * while `total` stays the BROKER's, so re-summing swaps ₹12.50 of engine DP in
 * for Dhan's stated total).
 */
function statedOrPricedCharges(
  row: StaleChargeParts & { chargesTotal: number },
  leg: { buyValue: number; sellValue: number; buyQty: number; sellQty: number; buyOrderCount: number; sellOrderCount: number },
  segment: Segment,
  day: string,
  ratesOn: (day: string) => Parameters<typeof computeCharges>[1],
): { parts: StaleChargeParts; total: number } {
  if (row.chargesTotal > 0) return { parts: partsOf(row), total: row.chargesTotal };
  const c = computeCharges({ segment, ...leg }, ratesOn(day));
  return { parts: partsOf(c as unknown as StaleChargeParts & { total: number }), total: c.total };
}

const r2m = (n: number) => Math.round(n * 100) / 100;

/** Split every component of a bill by remainder; the two halves always sum. */
function splitParts(parts: StaleChargeParts, share: number): { slice: StaleChargeParts; keep: StaleChargeParts } {
  const slice = {} as StaleChargeParts;
  const keep = {} as StaleChargeParts;
  for (const k of STALE_CHARGE_PARTS) {
    const s = splitByRemainder(parts[k] ?? 0, share);
    slice[k] = s.slice;
    keep[k] = s.keep;
  }
  return { slice, keep };
}

/**
 * The closed row one `LotClose` describes, as a trade `buildRow` can price —
 * the lot's leg on one side, the execution's on the other, and the merged bill
 * as `reportedCharges` so `buildRow` keeps it verbatim and still derives
 * `netPnl`, `isOpen`, `realisedPct`, `rMultiple` and the risk the way the
 * ordinary insert does (R60).
 *
 * R41: the entry time comes from the LOT, the exit time from the execution.
 * R62: `importNotes` is null here — the piece gets a FRESH note, never a copy
 * of the lot's.
 */
function closedTradeOf(
  t: NormalizedTrade,
  c: LotClose,
  entryTime: string | null,
  parts: StaleChargeParts,
  total: number,
): NormalizedTrade {
  const long = c.side === "long";
  const closeValue = r2m(c.qty * c.price);
  const buyValue = long ? c.openValue : closeValue;
  const sellValue = long ? closeValue : c.openValue;
  return {
    ...t,
    buyQty: c.qty,
    sellQty: c.qty,
    avgBuyPrice: long ? c.openPrice : c.price,
    avgSellPrice: long ? c.price : c.openPrice,
    buyValue,
    sellValue,
    buyDate: long ? c.openDate : c.date,
    sellDate: long ? c.date : c.openDate,
    entryTime: entryTime ?? null,
    exitTime: t.exitTime ?? null,
    closingPrice: null,
    grossPnl: r2m(sellValue - buyValue),
    unrealisedPnl: 0,
    basisUnknown: false,
    suggestedBasisPrice: null,
    // One fill against one lot is not a staged position (invariant 4): the
    // file's own ladder describes the WHOLE execution, not this piece of it.
    executions: null,
    reportedCharges: { ...parts, total },
    importNotes: null,
  };
}

/** What is LEFT of an execution that closed something: the same row, scaled. */
function scaledRemainderOf(t: NormalizedTrade, qty: number, parts: StaleChargeParts, total: number): NormalizedTrade {
  const sells = t.sellQty > 0;
  const price = sells ? t.avgSellPrice : t.avgBuyPrice;
  const value = r2m(qty * price);
  const wholeQty = sells ? t.sellQty : t.buyQty;
  return {
    ...t,
    buyQty: sells ? 0 : qty,
    sellQty: sells ? qty : 0,
    buyValue: sells ? 0 : value,
    sellValue: sells ? value : 0,
    grossPnl: wholeQty > 0 ? r2m(t.grossPnl * (qty / wholeQty)) : 0,
    unrealisedPnl: wholeQty > 0 ? r2m(t.unrealisedPnl * (qty / wholeQty)) : 0,
    // The file's fills describe the whole execution; which of them are left is
    // not derivable, so the remainder states none rather than a guess.
    executions: null,
    reportedCharges: { ...parts, total },
  };
}

/** An incoming row is a candidate close only while it states exactly one side. */
function singleSidedOf(t: NormalizedTrade): { side: "buy" | "sell"; qty: number; price: number; value: number } | null {
  if (t.buyQty > 0 && t.sellQty === 0) return { side: "buy", qty: t.buyQty, price: t.avgBuyPrice, value: t.buyValue };
  if (t.sellQty > 0 && t.buyQty === 0) return { side: "sell", qty: t.sellQty, price: t.avgSellPrice, value: t.sellValue };
  return null;
}

/** A stored row read as a lot an execution may close, or null when it may not. */
function openLotOf(r: typeof tradesTable.$inferSelect, hasLegs: boolean): OpenLot | null {
  // Seq 11: a STAGED position (or any row with a ladder) is refused — its
  // exit is booked on its own ladder, which prices each tranche and keeps R
  // frozen at the first entry (invariant 4). `closeStaleLot` refuses it too.
  if (!r.isOpen || r.staged || hasLegs || r.accountId <= 0) return null;
  if (storedDateProblem(r)) return null;
  // D3 sequence 2 — an OPENING SELL is not a short lot. Its stock was acquired
  // before the file's window and its cost basis is unknowable (invariant 6), so
  // a later purchase is a NEW long position, not a cover: covering it would
  // book a P&L against a basis nobody stated. The user says how it was acquired
  // (setAcquisitionAction) and only then does it read as a real position.
  if (r.acquisition === "unknown") return null;
  const long = r.buyQty > 0 && r.sellQty === 0;
  const short = r.sellQty > 0 && r.buyQty === 0;
  if (!long && !short) return null;
  return {
    id: r.id,
    accountId: r.accountId,
    broker: r.broker,
    tradingsymbol: r.tradingsymbol,
    segment: r.segment,
    exchange: r.exchange,
    side: long ? "long" : "short",
    qty: long ? r.buyQty : r.sellQty,
    price: long ? r.avgBuyPrice : r.avgSellPrice,
    value: long ? r.buyValue : r.sellValue,
    charges: r.chargesTotal,
    date: long ? r.buyDate : r.sellDate,
  };
}

interface ExecutionClosePlan {
  /** One piece per lot this execution consumed, with its merged bill. */
  pieces: { c: LotClose; parts: StaleChargeParts; total: number; entryTime: string | null; execShare: { parts: StaleChargeParts; total: number } }[];
  /** What is left of each touched lot, with the bill it KEEPS (R6). */
  remainders: { lotId: number; qty: number; value: number; charges: number; parts: StaleChargeParts | null }[];
  /** What is left of the execution after the closes (0 = consumed whole). */
  untouchedQty: number;
  /** Which piece holds the execution's hash — the one-holder rule. */
  holder: { kind: "lot" | "remainder" | "slice"; at: number };
  /** The remainder's share of the execution's bill. */
  execRest: StaleChargeParts;
  execRestTotal: number;
  /** True when a lot was there to close and the execution states no date. */
  refusedNoDate: boolean;
}

/**
 * The PURE half of the applier: what this execution closes, and what each piece
 * costs — no writes, no ids minted, nothing read from the database that the
 * caller did not hand in.
 *
 * Both the preview and the commit call it, which is what makes the preview's
 * Net P&L the commit's to the paisa (R2). The commit then writes the plan; the
 * preview only adds it up.
 */
function planExecutionCloses(
  t: NormalizedTrade,
  b: BuiltRow,
  accountId: number,
  lots: readonly OpenLot[],
  lotRows: ReadonlyMap<number, typeof tradesTable.$inferSelect>,
  ratesOnFor: (row: typeof tradesTable.$inferSelect) => (day: string) => Parameters<typeof computeCharges>[1],
): ExecutionClosePlan | null {
  const exec = singleSidedOf(t);
  if (!exec) return null;
  const execDate = normalizeDate(exec.side === "sell" ? t.sellDate : t.buyDate);
  const incoming = {
    key: b.dedup,
    accountId,
    broker: t.broker,
    tradingsymbol: t.tradingsymbol,
    segment: b.classification.segment,
    exchange: b.classification.exchange,
    side: exec.side,
    qty: exec.qty,
    price: exec.price,
    value: exec.value,
    charges: b.charges.total,
    date: execDate,
  };
  const plan = planLotCloses(lots, [incoming]);
  if (plan.closes.length === 0) {
    // R72 / ruling A2 — worth SAYING only when a lot was actually there to
    // close: a dateless row in a book holding nothing is an ordinary open
    // position, not a refused close.
    let refusedNoDate = false;
    if (!execDate) {
      const wanted = exec.side === "sell" ? "long" : "short";
      const key = matchKey(incoming);
      refusedNoDate = lots.some((l) => l.qty > 0 && l.side === wanted && matchKey(l) === key);
    }
    return refusedNoDate
      ? { pieces: [], remainders: [], untouchedQty: exec.qty, holder: { kind: "remainder", at: -1 }, execRest: partsOf(b.charges as unknown as StaleChargeParts), execRestTotal: b.charges.total, refusedNoDate }
      : null;
  }

  // R6 — every component split BY REMAINDER, per side, in plan order.
  let execRest = partsOf(b.charges as unknown as StaleChargeParts);
  let execRestTotal = b.charges.total;
  let execQtyLeft = exec.qty;
  const lotBill = new Map<number, { parts: StaleChargeParts; total: number }>();
  const pieces: ExecutionClosePlan["pieces"] = [];
  for (const c of plan.closes) {
    const share = execQtyLeft > 0 ? c.qty / execQtyLeft : 0;
    const ep = splitParts(execRest, share);
    const et = splitByRemainder(execRestTotal, share);
    execRest = ep.keep;
    execRestTotal = et.keep;
    execQtyLeft = r2m(execQtyLeft - c.qty);

    const row = lotRows.get(c.lotId)!;
    let bill = lotBill.get(c.lotId);
    if (!bill) {
      // R3 — the lot's OWN stated bill, or charge_config on the lot's own day.
      bill = statedOrPricedCharges(
        row as unknown as StaleChargeParts & { chargesTotal: number },
        { buyValue: row.buyValue, sellValue: row.sellValue, buyQty: row.buyQty, sellQty: row.sellQty, buyOrderCount: row.buyOrderCount, sellOrderCount: row.sellOrderCount },
        row.segment as Segment,
        pricingDate(row, execDate ?? todayIstIso()),
        ratesOnFor(row),
      );
      lotBill.set(c.lotId, bill);
    }
    const lp = splitParts(bill.parts, c.lotShare);
    const lt = splitByRemainder(bill.total, c.lotShare);
    bill.parts = lp.keep;
    bill.total = lt.keep;
    const parts = {} as StaleChargeParts;
    for (const k of STALE_CHARGE_PARTS) parts[k] = r2m(lp.slice[k] + ep.slice[k]);
    // `execShare` is the EXECUTION's half of this piece's bill, kept because the
    // merge of the two halves is not invertible from the ten columns (W3).
    pieces.push({ c, parts, total: r2m(lt.slice + et.slice), entryTime: row.entryTime, execShare: { parts: ep.slice, total: et.slice } });
  }

  const untouchedQty = plan.untouched[0]?.qty ?? 0;
  const wholeIdx = pieces.findIndex((p) => p.c.fullyConsumed);
  const holder: ExecutionClosePlan["holder"] =
    wholeIdx >= 0
      ? { kind: "lot", at: wholeIdx }
      : untouchedQty > 0
        ? { kind: "remainder", at: -1 }
        : { kind: "slice", at: pieces.findIndex((p) => !p.c.fullyConsumed) };

  return {
    pieces,
    remainders: plan.remainders.map((rm) => ({
      ...rm,
      charges: lotBill.get(rm.lotId)?.total ?? rm.charges,
      parts: lotBill.get(rm.lotId)?.parts ?? null,
    })),
    untouchedQty,
    holder,
    execRest,
    execRestTotal,
    refusedNoDate: false,
  };
}

/** Rates and defaults only — for mutations of a row that already has an account. */
function loadRatesContext() {
  const rates = loadRatesMap();
  const s = db.select().from(settingsTable).limit(1).all()[0];
  // Every risk_config row, handed to the ONE resolver — never read here.
  const capRows = db.select().from(riskConfig).all();
  return {
    rates,
    defaults: {
      buyOrders: s?.defaultBuyOrders ?? 1,
      sellOrders: s?.defaultSellOrders ?? 1,
      capRows,
    },
  };
}

/**
 * Context for a write that CREATES rows, so it needs an account to land on.
 *
 * @param explicitAccountId the account the USER chose for this write. Only the
 *   "All accounts" view can produce that question, and only when more than one
 *   account exists — see getWriteAccountId. A value naming no real account is
 *   ignored in favour of the selection, so a stale or hand-crafted id can never
 *   redirect a write; 0, or nothing while All accounts is selected, THROWS
 *   `AccountRequiredError` (v3.8 — the lowest-id fallback is gone). Routes map
 *   it to 400 `code: "ACCOUNT_REQUIRED"`.
 */
function loadContext(explicitAccountId?: number | null) {
  return { ...loadRatesContext(), accountId: getWriteAccountId(explicitAccountId) };
}

function loadOverrides(broker: string): Map<string, Override> {
  const rows = db
    .select()
    .from(classificationOverrides)
    .where(eq(classificationOverrides.broker, broker))
    .all();
  const map = new Map<string, Override>();
  for (const r of rows) {
    map.set(r.dedupHash, {
      segment: (r.segment as Segment) ?? null,
      bucket: (r.bucket as Bucket) ?? null,
      exchange: (r.exchange as Exchange) ?? null,
      isMtf: r.isMtf,
      setupTag: r.setupTag ?? null,
    });
  }
  return map;
}


/**
 * Order a tradebook's fills for the ladder. Broker exports are not reliably
 * sorted, and an exit can never precede the entry it closes, so opening-side
 * fills are placed first within each date and the whole list is date-ordered.
 * Without a date the file's own order is kept.
 */
function orderExecutions(t: NormalizedTrade): Execution[] {
  const ex = t.executions ?? [];
  // sellQty > buyQty, not buyQty === 0 — a partially covered short has
  // buyQty > 0 and must not be ordered as a long (fix A6).
  const isShort = t.sellQty > t.buyQty;
  const opening = isShort ? "sell" : "buy";
  return [...ex]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const da = a.e.date ?? "";
      const db = b.e.date ?? "";
      if (da !== db) return da < db ? -1 : 1;
      const oa = a.e.side === opening ? 0 : 1;
      const ob = b.e.side === opening ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

/**
 * A trade becomes a staged position only when a SIDE was actually filled more
 * than once — that is what scaling in or out means.
 *
 * Counting total fills instead would stage every single tradebook row, because
 * an ordinary round trip is already two executions (one buy, one sell). That
 * would hang a ladder off every imported trade while telling the trader
 * nothing they did not already know.
 */
function stagedFromExecutions(t: NormalizedTrade): boolean {
  const ex = t.executions ?? [];
  if (ex.length < 2) return false;
  const buys = ex.filter((e) => e.side === "buy").length;
  const sells = ex.length - buys;
  return buys > 1 || sells > 1;
}


/**
 * The BOOK vs the REFERENCE, decided on the ACCOUNT rather than on the file.
 *
 * `RECONCILE_SOURCE_IDS` names the statements that state the broker's own
 * figures. Four of the five emit no trades at all; the Dhan Realised P&L still
 * emits per-scrip positions, because in v3.8 it was the only Dhan source there
 * was. Import it into an account that already holds the Dhan Global
 * Transaction Report and every position is booked twice — and dedup skips
 * ZERO, because a P&L row and a transaction row state the same trade
 * differently and so hash differently by construction. On the owner's own
 * a2 pair the F&O segment read exactly 2x the broker's figure.
 *
 * KEYING: neither `trades` nor `import_batches` carries a source id — only
 * `broker_reference` does. So a batch that stored reference figures is
 * identifiable by `broker_reference.import_batch_id`, and a BOOK trade is one
 * whose batch is not among those (a manually entered trade has no batch at all
 * and is book by the same reading). Adding a `source_id` column to trades
 * would say the same thing twice.
 */
const REFERENCE_SOURCE_IDS: readonly string[] = RECONCILE_SOURCE_IDS;

type TxLike = Pick<typeof db, "select">;

function holdsBookTrades(tx: TxLike, accountId: number, broker: string): boolean {
  const refBatches = tx
    .select({ b: brokerReference.importBatchId })
    .from(brokerReference)
    .where(and(
      eq(brokerReference.accountId, accountId),
      eq(brokerReference.broker, broker),
      inArray(brokerReference.sourceId, REFERENCE_SOURCE_IDS),
    ))
    .all()
    .map((r) => r.b)
    .filter((b): b is number => b != null);

  const row = tx
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(and(
      eq(tradesTable.accountId, accountId),
      eq(tradesTable.broker, broker),
      // `x NOT IN (...)` is NULL for a NULL x, which would silently drop every
      // manual trade out of the answer — hence the explicit IS NULL arm.
      refBatches.length
        ? or(isNull(tradesTable.importBatchId), notInArray(tradesTable.importBatchId, refBatches))
        : undefined,
    ))
    .limit(1)
    .get();
  return row != null;
}

/** Would this file's trades be SKIPPED as already-held book rows? */
function supersededByBookNow(tx: TxLike, parsed: ParsedFile, accountId: number): boolean {
  if (parsed.trades.length === 0) return false;
  if (!REFERENCE_SOURCE_IDS.includes(parsed.sourceId)) return false;
  return holdsBookTrades(tx, accountId, parsed.broker);
}


// ---------------------------------------------------------------------------
// R43 (4.3.0) — a same-day re-pull supersedes today's earlier snapshot IN PLACE
// ---------------------------------------------------------------------------

/**
 * A broker pull's snapshot identity: the pull's own file name,
 * `${broker}-api-<IST day>`. Passed ONLY by the Dhan, Angel One and Upstox pull
 * callers (the route's commit path and the auto-pull sweep).
 *
 * Every pull on one IST day files under the same name, and the cross-source
 * check deliberately ignores rows from the same file — so when a position
 * changed between two pulls (bought 100 in the morning, sold by the evening),
 * the evening row hashed differently, nothing saw the morning row, and the
 * book held the position twice.
 *
 * The evening row now REPLACES the morning row, but only when that is
 * unambiguous: exactly one stored row and exactly one incoming row for the same
 * account + broker + file + day + instrument (tradingsymbol, symbol, segment,
 * exchange). The trades table has no product column, so an INTRADAY and a
 * MARGIN position in one contract share that key; overwriting one with the
 * other would erase a held position. In that case — and when the stored row
 * carries a ladder (trade_legs), an identity alias, or a basis or journal entry
 * the user recorded (W2R N1) — nothing is replaced and the earlier snapshot ON
 * THAT KEY stops being hidden from the collision check, so the user is asked,
 * whether or not the two rows relate by quantity or value (W2R N2). A row of
 * today's snapshot the user re-classified (a classification_overrides row on
 * its hash) counts as on the key of every incoming row of its tradingsymbol,
 * and is asked about, never replaced (W2F OVERRIDE-DOUBLE). A row with nothing
 * stored on its key, while today's snapshot holds its tradingsymbol in another
 * segment or exchange, is asked about against those rows (W2G M1, reversing
 * W2R N3): the broker may have converted the position's product between the two
 * pulls. Only a row with no same-symbol row in today's snapshot is a plain new
 * position. A product-keyed snapshot identity is 4.3.1 work.
 */
export interface SupersedeSnapshot {
  fileName: string;
}

/** Rows today's earlier snapshot would be replaced by, and rows to ask about. */
interface SnapshotPlan {
  day: string;
  /** incoming row index → the stored row it replaces */
  supersede: Map<number, { id: number }>;
  /**
   * incoming row index → the ids of today's earlier snapshot rows on its key,
   * for a snapshot row with a new hash that is NOT replaced — or, when nothing
   * is on its key, of every row of that snapshot with its tradingsymbol (W2G
   * M1). Never empty: a row with no such stored row is a new position.
   */
  ask: Map<number, number[]>;
  /**
   * W2H: the incoming row indexes whose `ask` exists ONLY because of W2G M1
   * (nothing on the key; the ids are same-symbol rows of another segment or
   * exchange). The ask is unchanged; only its sentence differs (cross-source.ts).
   */
  offKey: Set<number>;
}

interface SnapshotStoredRow {
  id: number;
  tradingsymbol: string;
  symbol: string;
  segment: string;
  exchange: string;
  buyDate: string | null;
  sellDate: string | null;
  sourceFile: string | null;
  dedupHash: string;
  importNotes: string | null;
  // W2R N1: what setAcquisitionAction and the journal route write.
  acquisition: string | null;
  acquisitionPrice: number | null;
  acquisitionDate: string | null;
  notes: string | null;
  playbookId: number | null;
  emotionTag: string | null;
  mistakeTags: string[] | null;
  exitTrigger: string | null;
  ruleViolations: string[] | null;
  reviewedAt: string | null;
}

/**
 * W2R N1 (4.3.0): has the USER recorded something on this row?
 *
 * A cost basis (setAcquisitionAction: an acquisition other than the import's
 * own 'unknown' flag, an acquisition price or date — the price also writes
 * buy_qty, buy_value, gross and buy_date) or anything the journal writes
 * (playbook, emotion, mistakes, notes, exit trigger, rule violations, the
 * review stamp). The supersede patch restates the broker's columns, so it
 * would half-wipe a recorded basis — buy_qty back to 0 while the row still
 * reads as priced — and a note describes a position the broker has since
 * restated. Such a row is never replaced in place; the incoming row is asked.
 */
function carriesUserRecord(r: SnapshotStoredRow): boolean {
  const said = (s: string | null) => s != null && s.trim() !== "";
  return (
    (said(r.acquisition) && r.acquisition !== "unknown") ||
    r.acquisitionPrice != null ||
    said(r.acquisitionDate) ||
    said(r.notes) ||
    r.playbookId != null ||
    said(r.emotionTag) ||
    (r.mistakeTags?.length ?? 0) > 0 ||
    said(r.exitTrigger) ||
    (r.ruleViolations?.length ?? 0) > 0 ||
    said(r.reviewedAt)
  );
}

/** The IST day the pull's file name carries; today when it carries none. */
function snapshotDayOf(snap: SupersedeSnapshot): string {
  return /(\d{4}-\d{2}-\d{2})$/.exec(snap.fileName)?.[1] ?? todayIstIso();
}

/** A row of today's book: dated `day`, with every execution (if any) on `day`.
 *  Dhan's /positions rows carry no executions; a history fill is never dated
 *  today (fetchTrades drops those); an Angel One / Upstox trade-book row is
 *  today's fills. */
function isSnapshotRow(t: NormalizedTrade, day: string): boolean {
  if (normalizeDate(t.buyDate) !== day && normalizeDate(t.sellDate) !== day) return false;
  return (t.executions ?? []).every((e) => normalizeDate(e.date) === day);
}

const tradingsymbolKey = (tradingsymbol: string) => tradingsymbol.trim().toUpperCase();
const snapshotKey = (tradingsymbol: string, symbol: string, segment: string, exchange: string) =>
  `${tradingsymbolKey(tradingsymbol)}|${symbol}|${segment}|${exchange}`;

/**
 * W2F OVERRIDE-DOUBLE (4.3.0): does the row carry a classification the USER
 * set — a classification_overrides row (applyOverride / the Re-tag dialog) on
 * its dedup hash, stating a segment or an exchange? The override moves the row
 * off the key an evening pull classifies to, so the key alone would call the
 * evening row a new position and the book would hold the position twice.
 */
const reclassifiedBy = (overrides: ReadonlyMap<string, Override>) => (hash: string) => {
  const o = overrides.get(hash);
  return o != null && (o.segment != null || o.exchange != null);
};

function planSnapshot(
  snap: SupersedeSnapshot | null | undefined,
  incoming: readonly { t: NormalizedTrade; b: BuiltRow }[],
  isKnown: (hash: string) => boolean,
  stored: readonly SnapshotStoredRow[],
  hasLegs: (tradeIds: number[]) => Set<number>,
  isReclassified: (hash: string) => boolean,
): SnapshotPlan | null {
  if (!snap) return null;
  const day = snapshotDayOf(snap);
  const storedByKey = new Map<string, SnapshotStoredRow[]>();
  // W2F: today's snapshot rows the user re-classified, by tradingsymbol alone —
  // a key candidate for any incoming row of that tradingsymbol.
  const reclassifiedBySymbol = new Map<string, SnapshotStoredRow[]>();
  // W2G M1: every row of today's snapshot, by tradingsymbol alone (any segment or exchange).
  const storedBySymbol = new Map<string, SnapshotStoredRow[]>();
  for (const r of stored) {
    if (r.sourceFile !== snap.fileName || (r.buyDate !== day && r.sellDate !== day)) continue;
    const k = snapshotKey(r.tradingsymbol, r.symbol, r.segment, r.exchange);
    storedByKey.set(k, [...(storedByKey.get(k) ?? []), r]);
    const bySymbol = storedBySymbol.get(tradingsymbolKey(r.tradingsymbol));
    if (bySymbol) bySymbol.push(r);
    else storedBySymbol.set(tradingsymbolKey(r.tradingsymbol), [r]);
    if (isReclassified(r.dedupHash)) {
      const s = tradingsymbolKey(r.tradingsymbol);
      reclassifiedBySymbol.set(s, [...(reclassifiedBySymbol.get(s) ?? []), r]);
    }
  }
  const keyOf = ({ t, b }: { t: NormalizedTrade; b: BuiltRow }) =>
    snapshotKey(t.tradingsymbol, b.classification.symbol, b.classification.segment, b.classification.exchange);
  const incomingPerKey = new Map<string, number>();
  const snapshotRows: number[] = [];
  incoming.forEach((row, i) => {
    if (!isSnapshotRow(row.t, day)) return;
    snapshotRows.push(i);
    incomingPerKey.set(keyOf(row), (incomingPerKey.get(keyOf(row)) ?? 0) + 1);
  });

  const supersede = new Map<number, { id: number }>();
  const ask = new Map<number, number[]>();
  const offKey = new Set<number>();
  const single = new Map<number, SnapshotStoredRow>();
  for (const i of snapshotRows) {
    const row = incoming[i]!;
    if (isKnown(row.b.dedup)) continue; // a duplicate: nothing to replace, nothing to ask
    const k = keyOf(row);
    const onKey = storedByKey.get(k) ?? [];
    // W2F: a re-classified row of this tradingsymbol counts as on the key, so a
    // user's correction never turns the evening row into a silent second position.
    const reclassified = (reclassifiedBySymbol.get(tradingsymbolKey(row.t.tradingsymbol)) ?? []).filter(
      (r) => !onKey.includes(r),
    );
    const candidates = [...onKey, ...reclassified];
    if (candidates.length === 0) {
      // W2G M1 (reverses W2R N3's narrowing): nothing on the key, but today's
      // snapshot holds this tradingsymbol in another segment or exchange. The
      // broker may have converted the position's product between two pulls
      // (intraday 10 → CNC 20 read as a new position held 30 against the
      // broker's 20), so the row is ASKED about against those rows, never added
      // silently. A genuinely new position of another product is asked too: a
      // question is always better than a confident wrong answer.
      const sameSymbol = storedBySymbol.get(tradingsymbolKey(row.t.tradingsymbol)) ?? [];
      if (sameSymbol.length > 0) {
        ask.set(i, sameSymbol.map((r) => r.id));
        offKey.add(i); // W2H: this ask's sentence names its own reason
      }
      continue;
    }
    if (
      candidates.length === 1 &&
      incomingPerKey.get(k) === 1 &&
      !isLotIdentityFrozen(candidates[0]!) &&
      !carriesUserRecord(candidates[0]!) &&
      // W2F: a classification the user set is a user record (like N1) — asked, never replaced in place.
      !isReclassified(candidates[0]!.dedupHash)
    ) {
      single.set(i, candidates[0]!);
    } else {
      ask.set(i, candidates.map((r) => r.id));
    }
  }
  // A stored row with a ladder is never rewritten: its legs would describe a
  // position the parent no longer holds (invariant 5), and they can carry the
  // user's per-tranche stops.
  const laddered = single.size ? hasLegs([...single.values()].map((r) => r.id)) : new Set<number>();
  for (const [i, r] of single) {
    if (laddered.has(r.id)) ask.set(i, [r.id]);
    else supersede.set(i, { id: r.id });
  }
  return { day, supersede, ask, offKey };
}

/** The ids among `ids` that have at least one trade_legs row. */
function tradeIdsWithLegs(tx: TxLike, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  return new Set(
    tx.select({ tradeId: tradeLegs.tradeId }).from(tradeLegs).where(inArray(tradeLegs.tradeId, ids)).all().map((r) => r.tradeId),
  );
}

/** The commit's words for rows replaced in place ("1 position updated from
 *  today's earlier pull"); the commit's warning is this plus a full stop. */
export const supersededPhrase = (n: number) =>
  `${n} position${n === 1 ? "" : "s"} updated from today's earlier pull`;

/** The count a commit's warnings state for rows replaced in place; 0 when none. */
export function supersededFromWarnings(warnings: readonly string[] | undefined): number {
  for (const w of warnings ?? []) {
    const m = /^(\d+) positions? updated from today's earlier pull\.$/.exec(w);
    if (m) return Number(m[1]);
  }
  return 0;
}

/**
 * What a preview or a commit may be asked to do beyond writing the file's rows.
 *
 * `autoClose` (W2a) defaults to FALSE and every caller on this tree leaves it
 * so: the applier is built, unit-tested and dormant. W2b turns it on — with a
 * per-import "Keep sells as separate rows" toggle (ruling A1) — AFTER W3 has
 * built un-close and the delete/merge refusals, because a close the user cannot
 * undo is not a feature. A pull passes whatever it is given (revision 13); it
 * has no toggle of its own this wave.
 */
export interface ImportWriteOptions {
  /** R43: a broker pull's snapshot identity — see `SupersedeSnapshot`. */
  supersedeSnapshot?: SupersedeSnapshot | null;
  /** W2a: FIFO-close open lots this execution closes. Default false. */
  autoClose?: boolean;
}

export interface PreviewRow {
  tradingsymbol: string;
  symbol: string;
  segment: Segment;
  bucket: Bucket;
  exchange: Exchange;
  optionType: string | null;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  grossPnl: number;
  chargesTotal: number;
  netPnl: number;
  isOpen: boolean;
  isDuplicate: boolean;
}

export interface PreviewResult {
  sourceId: string;
  broker: string;
  format: string;
  warnings: string[];
  rawText?: string;
  rows: PreviewRow[];
  /**
   * How the file's own row count became this many positions, plus the two
   * sub-counts whose P&L is legitimately blank. Rendered by
   * `lib/domain/import-shape.ts` so the preview, the commit result and the
   * Recent-imports row all say the same sentence.
   */
  shape: ImportShape;
  /**
   * `newCount` rows would be inserted and `dupCount` skipped as already held.
   * `supersededCount` (R43, a pull only) would REPLACE today's earlier snapshot
   * of the same position in place — neither new nor a duplicate, so
   * `total = newCount + dupCount + supersededCount`.
   */
  summary: { total: number; newCount: number; dupCount: number; supersededCount: number; grossPnl: number; chargesTotal: number; netPnl: number };
  /** W2a: what the FIFO auto-close WOULD do. Present only when asked for. */
  autoClose?: AutoCloseCounters;
  reconciliation?: { reported: Record<string, number>; computed: Record<string, number> };
  /** Rows that look like trades already held from a DIFFERENT file kind. */
  crossSource?: CrossSourceReport;
  /** Same instrument, same day, DIFFERENT broker — informational only. */
  crossBroker?: string | null;
  /**
   * v3.9: this file states the broker's figures AND carries trades, and the
   * target account already holds this broker's book. The commit will store the
   * figures and skip the trades — so the button must offer to STORE, not to
   * commit rows that will never land.
   */
  supersededByBook?: boolean;
}


/**
 * Apply a user-chosen product type to a P&L file's rows.
 *
 * A P&L statement has no product column, so `productHint` arrives null and the
 * classifier falls back to delivery. When the user has told us what these
 * trades actually were, that answer must be applied BEFORE classification —
 * segment, charges, MTF interest and Return-on-Margin all derive from it.
 *
 * Keyed by tradingsymbol so a bulk correction ("these 14 rows are MTF")
 * survives the row ordering of the preview table.
 */
function applyProductOverrides(
  parsed: ParsedFile,
  overrides: Record<string, ProductHint> | null,
): ParsedFile {
  if (!overrides || Object.keys(overrides).length === 0) return parsed;
  return {
    ...parsed,
    trades: parsed.trades.map((t) => {
      const hint = overrides[t.tradingsymbol];
      return hint ? { ...t, productHint: hint } : t;
    }),
  };
}

/**
 * Turn numeric SCRIP CODES into tickers before anything else looks at them.
 *
 * Paytm Money's tradebook states `216463` where every other broker states a
 * ticker, and a book of scrip codes is invisible to sector analytics, the
 * index map and the user's own memory alike. The ISIN on each row is what
 * resolves it: the user's Instruments table first, the bundled NSE index map
 * second, and the code itself when neither knows it.
 *
 * Runs FIRST in both preview and commit, so the two see identical rows — the
 * dedup hash is derived from `tradingsymbol` inside `buildRow`, so resolving
 * in only one of them would make every previewed row miss its own commit.
 * The DB is only touched when a coded symbol actually exists, leaving every
 * other broker's import path byte-for-byte as it was.
 */
function resolveSymbols(parsed: ParsedFile): ParsedFile {
  const coded = parsed.trades.filter((t) => isCodedSymbol(t.tradingsymbol) && t.isin);
  if (coded.length === 0) return parsed;
  const fromDb = getSymbolsByIsin(coded.map((t) => t.isin!));
  const trades = resolveCodedSymbols(
    parsed.trades,
    (isin) => fromDb.get(isin.trim().toUpperCase()) ?? bundledSymbolByIsin(isin),
  );
  return { ...parsed, trades };
}

export function previewParsedFile(
  parsedIn: ParsedFile,
  productOverrides: Record<string, ProductHint> | null = null,
  // Dedup is per (account, broker), so a preview run against a different
  // account than the commit would report the wrong duplicate count.
  accountIdIn?: number | null,
  /** Name of the file being previewed — lets the cross-source check exclude
   *  rows that came from this very file on an earlier import. */
  fileName = "",
  /** R43: a broker pull's snapshot identity — see `SupersedeSnapshot`. */
  options: ImportWriteOptions = {},
): PreviewResult {
  const parsed = applyProductOverrides(resolveSymbols(parsedIn), productOverrides);
  const { rates, defaults, accountId } = loadContext(accountIdIn);
  const overrides = loadOverrides(parsed.broker);
  // Full rows, not just hashes: the cross-source check below needs quantities,
  // values and the file each row came from, because a P&L export and a
  // transaction report state the same trade differently and so hash differently.
  const existingRows = db
    .select()
    .from(tradesTable)
    .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, parsed.broker)))
    .all();
  // R26 (4.3.0): every hash a row answers to — its own AND any alias. A lot
  // Data Quality joined to its stored sale answers to the sale's record, so a
  // re-pull of that sale is a duplicate here exactly as it is at commit. A book
  // with no alias rows gets v4.2.0's set, own hashes only. V1: an alias counts
  // only while its lot still closes on the sale (`heldIdentityHashes`).
  const existing = new Set(existingRows.flatMap((r) => heldIdentityHashes(r)));

  const rows: PreviewRow[] = [];
  let grossPnl = 0, chargesTotal = 0, netPnl = 0, dupCount = 0, supersededCount = 0, openCount = 0, openingSells = 0;
  const agg: Record<string, number> = { brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, dpCharges: 0 };

  // Wave U: the account row is read ONCE, not once per trade.
  const planAccount = planAccountOf(accountId);
  const built = parsed.trades.map((t) => ({ t, b: buildRow(t, rates, overrides, defaults, planAccount) }));
  // W1 (F-L1-7): the same re-key the commit makes, so the preview's duplicate
  // count is the commit's.
  applyScopedIdentity(built, overrides, (t, ov) => buildRow(t, rates, ov, defaults, planAccount));
  // R43: the same plan the commit makes, against the same rows.
  const snapshot = planSnapshot(
    options.supersedeSnapshot,
    built,
    (h) => existing.has(h),
    existingRows,
    (ids) => tradeIdsWithLegs(db, ids),
    reclassifiedBy(overrides),
  );

  // W2a (R2) — the preview runs the SAME pure plan the commit will run, over a
  // virtual copy of the book's open lots, so its Net/Gross/Charges are what the
  // commit will store to the paisa. OFF by default, like the commit.
  const autoClose = options.autoClose === true;
  const counters = emptyAutoCloseCounters();
  const previewLotRows = new Map<number, typeof tradesTable.$inferSelect>();
  const previewLots: OpenLot[] = [];
  // W2a-F1, the preview's half: what this file already counted for a row it
  // would open, taken back when the same file closes it.
  const previewCounted = new Map<number, { gross: number; charges: number; net: number }>();
  if (autoClose) {
    const laddered = tradeIdsWithLegs(db, existingRows.filter((r) => r.isOpen).map((r) => r.id));
    for (const r of existingRows) {
      const lot = openLotOf(r, laddered.has(r.id));
      if (!lot) continue;
      previewLotRows.set(r.id, r);
      previewLots.push(lot);
    }
  }
  const previewRatesOn = (row: typeof tradesTable.$inferSelect) => (day: string) =>
    ratesForTrade(
      rates,
      { broker: row.broker as Broker, segment: row.segment as Segment, exchange: row.exchange as Exchange, isin: row.isin, symbol: row.symbol },
      day,
      resolvePlan(planAccount, row.broker, day, rates),
    );

  for (const [i, { t, b }] of built.entries()) {
    const isDuplicate = existing.has(b.dedup);
    if (isDuplicate) dupCount++;
    else if (snapshot?.supersede.has(i)) supersededCount++;

    // The plan this row would produce at commit — and the row's own figures
    // become the pieces it would write.
    let rowGross = t.grossPnl, rowCharges = b.charges.total, rowNet = b.netPnl, rowOpen = b.isOpen, rowBasisUnknown = !!t.basisUnknown;
    if (autoClose && !isDuplicate && !snapshot?.supersede.has(i)) {
      const plan = planExecutionCloses(t, b, accountId, previewLots, previewLotRows, previewRatesOn);
      if (plan?.refusedNoDate) counters.refusedNoDate++;
      else if (plan && plan.pieces.length > 0) {
        rowGross = 0; rowCharges = 0; rowNet = 0;
        for (const [pi, piece] of plan.pieces.entries()) {
          const closed = closedTradeOf(t, piece.c, piece.entryTime, piece.parts, piece.total);
          const cb = buildRow(closed, rates, overrides, defaults, planAccount);
          rowGross = r2m(rowGross + closed.grossPnl);
          rowCharges = r2m(rowCharges + cb.charges.total);
          rowNet = r2m(rowNet + cb.netPnl);
          if (piece.c.fullyConsumed) counters.closedWhole++;
          else counters.reduced++;
          // A negative id is a lot THIS file opened (the virtual rows below).
          if (piece.c.lotId < 0) counters.closedAgainstThisFilesLot++;
          else counters.closedAgainstStoredLot++;
          const already = previewCounted.get(piece.c.lotId);
          if (already) {
            rowGross = r2m(rowGross - already.gross);
            rowCharges = r2m(rowCharges - already.charges);
            rowNet = r2m(rowNet - already.net);
            previewCounted.delete(piece.c.lotId);
          }
          void pi;
        }
        if (plan.untouchedQty > 0) {
          const scaled = scaledRemainderOf(t, plan.untouchedQty, plan.execRest, plan.execRestTotal);
          const rb = buildRow(scaled, rates, overrides, defaults, planAccount);
          rowGross = r2m(rowGross + scaled.grossPnl);
          rowCharges = r2m(rowCharges + rb.charges.total);
          rowNet = r2m(rowNet + rb.netPnl);
          rowOpen = rb.isOpen;
          counters.openedNew++;
        } else {
          rowOpen = false;
          rowBasisUnknown = false; // R31
        }
        for (const rem of plan.remainders) {
          const l = previewLots.find((x) => x.id === rem.lotId);
          if (!l) continue;
          l.qty = rem.qty;
          l.value = rem.value;
          l.charges = rem.charges;
        }
      } else if (b.isOpen) counters.openedNew++;
      // M-2 / R58, in the preview too: a lot this file OPENS is a lot a later
      // row of the same file can close, so the virtual book grows as the commit's
      // would. The row is synthesised from what the commit would store.
      if (rowOpen) {
        const vid = -(i + 1);
        const vrow = {
          id: vid,
          accountId,
          broker: t.broker,
          tradingsymbol: t.tradingsymbol,
          symbol: b.classification.symbol,
          segment: b.classification.segment,
          exchange: b.classification.exchange,
          isin: t.isin,
          isOpen: true,
          staged: stagedFromExecutions(t),
          buyQty: t.buyQty,
          sellQty: t.sellQty,
          avgBuyPrice: t.avgBuyPrice,
          avgSellPrice: t.avgSellPrice,
          buyValue: t.buyValue,
          sellValue: t.sellValue,
          buyDate: normalizeDate(t.buyDate),
          sellDate: normalizeDate(t.sellDate),
          buyOrderCount: b.buyOrderCount,
          sellOrderCount: b.sellOrderCount,
          chargesTotal: b.charges.total,
          entryTime: t.entryTime ?? null,
          ...partsOf(b.charges as unknown as StaleChargeParts),
        } as unknown as typeof tradesTable.$inferSelect;
        const vlot = openLotOf(vrow, false);
        if (vlot) {
          previewLotRows.set(vid, vrow);
          previewLots.push(vlot);
          previewCounted.set(vid, { gross: rowGross, charges: rowCharges, net: rowNet });
        }
      }
    }
    // Disjoint by construction: an opening sell also has buyQty !== sellQty, so
    // counting it as "open" as well would make the three counts overlap and
    // stop summing to the position total.
    if (rowBasisUnknown) openingSells++;
    else if (rowOpen) openCount++;
    grossPnl += rowGross;
    chargesTotal += rowCharges;
    netPnl += rowNet;
    for (const k of Object.keys(agg)) agg[k] += (b.charges as unknown as Record<string, number>)[k];
    rows.push({
      tradingsymbol: t.tradingsymbol,
      symbol: b.classification.symbol,
      segment: b.classification.segment,
      bucket: b.classification.bucket,
      exchange: b.classification.exchange,
      optionType: b.classification.optionType,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      grossPnl: rowGross,
      chargesTotal: rowCharges,
      netPnl: rowNet,
      isOpen: rowOpen,
      isDuplicate,
    });
  }

  return {
    sourceId: parsed.sourceId,
    broker: parsed.broker,
    format: parsed.format,
    // W2a: the same sentences the commit will say, from the same pure function.
    warnings: autoClose ? [...parsed.warnings, ...autoCloseSentences(counters)] : parsed.warnings,
    ...(autoClose ? { autoClose: counters } : {}),
    rawText: parsed.rawText,
    supersededByBook: supersededByBookNow(db, parsed, accountId),
    rows,
    shape: {
      sourceRows: parsed.sourceRows ?? null,
      positions: rows.length,
      open: openCount,
      openingSells,
      relabelled: relabelledFromWarnings(parsed.warnings),
    },
    summary: {
      total: rows.length,
      newCount: rows.length - dupCount - supersededCount,
      dupCount,
      supersededCount,
      grossPnl: Math.round(grossPnl * 100) / 100,
      chargesTotal: Math.round(chargesTotal * 100) / 100,
      netPnl: Math.round(netPnl * 100) / 100,
    },
    reconciliation: parsed.reported
      ? { reported: parsed.reported, computed: { ...agg, total: Math.round(chargesTotal * 100) / 100 } }
      : undefined,
    // Rows that slipped past dedupHash because they came from a file kind that
    // states different facts. Reported, never merged — see cross-source.ts.
    crossSource: detectCrossSourceDuplicates(
      parsed.trades.map((t, i) => ({
        broker: parsed.broker,
        symbol: t.tradingsymbol,
        tradingsymbol: t.tradingsymbol,
        buyQty: t.buyQty ?? 0,
        sellQty: t.sellQty ?? 0,
        buyValue: t.buyValue ?? 0,
        sellValue: t.sellValue ?? 0,
        buyDate: t.buyDate ?? null,
        sellDate: t.sellDate ?? null,
        // W1: the row's OWN identity, the one the commit will store — not a
        // second derivation of it (this line used to re-hash the trade here).
        dedupHash: built[i]!.b.dedup,
        // R43: a snapshot row that will NOT replace today's earlier one meets
        // that earlier one — on its own key only — here, and is reported
        // whatever the relation, so the pull asks instead of adding a second row.
        ...(snapshot?.ask.has(i) ? { snapshotIds: snapshot.ask.get(i), ...(snapshot.offKey.has(i) ? { snapshotOffKey: true } : {}) } : {}),
      })),
      existingRows.map((r) => ({
        id: r.id,
        broker: r.broker,
        symbol: r.symbol,
        tradingsymbol: r.tradingsymbol,
        buyQty: r.buyQty,
        sellQty: r.sellQty,
        buyValue: r.buyValue,
        sellValue: r.sellValue,
        buyDate: r.buyDate,
        sellDate: r.sellDate,
        sourceFile: r.sourceFile,
        dedupHash: r.dedupHash,
      })),
      fileName,
    ),
    // Same instrument on the same day under ANOTHER broker: two real books,
    // both kept — reported so a multi-broker day reads as intentional.
    crossBroker: detectCrossBrokerEchoes(
      parsed.trades.map((t) => ({
        broker: parsed.broker,
        symbol: t.tradingsymbol,
        tradingsymbol: t.tradingsymbol,
        buyQty: t.buyQty ?? 0,
        sellQty: t.sellQty ?? 0,
        buyValue: t.buyValue ?? 0,
        sellValue: t.sellValue ?? 0,
        buyDate: t.buyDate ?? null,
        sellDate: t.sellDate ?? null,
        dedupHash: "",
      })),
      db
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.accountId, accountId), ne(tradesTable.broker, parsed.broker)))
        .all()
        .map((r) => ({
          id: r.id,
          broker: r.broker,
          symbol: r.symbol,
          tradingsymbol: r.tradingsymbol,
          buyQty: r.buyQty,
          sellQty: r.sellQty,
          buyValue: r.buyValue,
          sellValue: r.sellValue,
          buyDate: r.buyDate,
          sellDate: r.sellDate,
          sourceFile: r.sourceFile,
          dedupHash: r.dedupHash,
        })),
    ),
  };
}


// ---------------------------------------------------------------------------
// v3.9 "Trust the numbers" — the BROKER's figures, and facts about trades the
// book already holds. Neither writes a trade; both are additive to the commit.
// ---------------------------------------------------------------------------

/**
 * `reported` → `reference`, for a source that states segment totals but was
 * written before the reference contract existed.
 *
 * `reported` is flat and DOUBLY keyed: `equity.grossPnl` for a segment's own
 * figure AND `grossPnl` for the file-wide sum of those. Only the dotted keys
 * become rows — the bare ones are a third copy of the same money, and storing
 * them would make the broker's side of a reconciliation add up to twice the
 * file. A source that already emits `reference` never reaches this.
 */
export function referenceFromReported(reported: Record<string, number> | undefined): ReferenceRow[] {
  if (!reported) return [];
  const bySegment = new Map<string, Record<string, number>>();
  for (const [k, v] of Object.entries(reported)) {
    const dot = k.indexOf(".");
    if (dot < 0) continue;
    const seg = k.slice(0, dot);
    const cur = bySegment.get(seg) ?? {};
    cur[k.slice(dot + 1)] = v;
    bySegment.set(seg, cur);
  }
  return [...bySegment].map(([key, figures]) => ({
    scope: "segment" as const, key, isin: null, symbol: null, fy: null, asOf: null, figures, note: null,
  }));
}

/**
 * Persist broker-stated figures, REPLACING what the same statement said before.
 *
 * The identity of a figure is (account, broker, source, scope, key, as_of) —
 * `broker_reference_uq`, which coalesces a NULL `as_of` to '' because SQLite
 * counts NULLs in a unique index as distinct and an FY total imported twice
 * would otherwise be admitted twice. ON CONFLICT DO UPDATE rather than INSERT
 * OR REPLACE: the row keeps its id and its created_at, so "when did this
 * figure first arrive" survives a re-import.
 *
 * Returns how many figures landed.
 */
export function persistReference(
  tx: { run: (q: ReturnType<typeof sql>) => unknown },
  rows: ReferenceRow[],
  accountId: number,
  broker: string,
  sourceId: string,
  /** The import batch that carried these figures, when there was one. The
   *  Cash & Ledger door writes reference rows without creating a trade batch. */
  batchId: number | null,
): number {
  let stored = 0;
  for (const r of rows) {
    const figures = JSON.stringify(r.figures ?? {});
    tx.run(sql`
      INSERT INTO ${brokerReference}
        (account_id, broker, source_id, scope, "key", isin, symbol, fy, as_of, figures_json, note, import_batch_id)
      VALUES (${accountId}, ${broker}, ${sourceId}, ${r.scope}, ${r.key}, ${r.isin ?? null}, ${r.symbol ?? null},
              ${r.fy ?? null}, ${r.asOf ?? null}, ${figures}, ${r.note ?? null}, ${batchId})
      ON CONFLICT (account_id, broker, source_id, scope, "key", coalesce(as_of, '')) DO UPDATE SET
        isin = excluded.isin, symbol = excluded.symbol, fy = excluded.fy,
        figures_json = excluded.figures_json, note = excluded.note,
        import_batch_id = excluded.import_batch_id`);
    stored++;
  }
  return stored;
}

/**
 * Apply a secondary source's facts to trades the book ALREADY holds.
 *
 * A contract note knows two things a P&L export does not: the exact fill time,
 * and whether a line was an option or a future. It knows them about trades
 * that are already in the journal — so this NEVER creates a trade. An
 * enrichment that matches nothing is counted and reported, not stored: a row
 * conjured from a contract note would be an execution with no cost basis, no
 * charges and no dedup hash, and it would double-count the moment the real
 * tradebook arrives.
 *
 * ── Why this is not a row-for-row lookup (2026-09-04) ─────────────────────
 *
 * It used to match (symbol, date, side, qty) one enrichment row at a time, and
 * against the owner's own files that matched ZERO of 1,161 real fills. Three
 * independent reasons, all of them structural:
 *
 *   • A note prints one line per FILL — 11, 19, 2, 11 shares at 10:56:35 —
 *     while the book holds the paired POSITION (2,000). No fill's quantity is
 *     ever a position's quantity, so `qty` could not match.
 *   • A note names an equity by its exchange TICKER (`BBOX`); the Global
 *     Transaction Report names it by the company (`Black Box`). Neither
 *     `symbol` nor `tradingsymbol` ever equalled the other.
 *   • A note named a derivative by its bare underlying (`NIFTY`) with the
 *     strike and expiry in a prose note, while the book carries the whole
 *     contract name. Every option on a busy day looked like one instrument.
 *
 * So: fills are AGGREGATED per (identity, date, side) before anything is
 * looked up — earliest fill for the entry, latest for the exit, quantities
 * summed — and identity is resolved through the ISIN and the registered
 * company name, not through one string. When a day's fills for one contract
 * cover more than one position, they are consumed as a CUMULATIVE PREFIX in
 * time order (the first N fills that sum to a position's quantity are that
 * position's), and the warning says so rather than pretending to certainty.
 *
 * Writes are one-directional and non-destructive:
 *   - entry_time / exit_time are set ONLY where NULL — a time the book already
 *     has came from the tradebook, which is the better source.
 *   - instrument_type is set ONLY where the classifier left "equity" AND the
 *     note says option or future. A stated derivative beats a defaulted
 *     equity; nothing ever demotes a classified derivative back to equity.
 *
 * Candidates are filtered by BROKER as well as account — a Dhan note has no
 * business writing a time onto a Zerodha position — read in `id asc` order so
 * the same file always resolves the same way, and each (trade, side) is
 * claimed at most once per import.
 */
interface EnrichOutcome {
  /** Groups whose match actually WROTE a column. */
  applied: number;
  /** Groups that matched a trade which already held every fact offered. */
  alreadyHad: number;
  /** Groups that matched no trade at all. */
  unmatched: number;
  /** Aggregated (identity, date, side) groups the rows collapsed into.
   *  INVARIANT: applied + alreadyHad + unmatched === groups, always. */
  groups: number;
  /**
   * Contract-days that DID place at least one position and still had fills
   * left over. The day is counted once above (it wrote something); this says
   * some of its fills enriched nothing, which no counter above can say.
   */
  tails: number;
  /** Why the unmatched ones missed, most common first. */
  reasons: { reason: string; count: number }[];
  /** Facts only the matching knew — e.g. that a prefix split was used. */
  notes: string[];
}

/**
 * A name reduced to what two documents can agree on: letters and digits, no
 * leading "The", no trailing Limited/Ltd. `Black Box` and
 * `Black Box Limited` become the same string; `BBOX` does not, which is why
 * the ISIN carries the equity case.
 */
function normIdent(s: string | null | undefined): string {
  let v = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (v.startsWith("THE")) v = v.slice(3);
  for (;;) {
    const next = v.replace(/(?:LIMITED|LTD)$/, "");
    if (next === v) break;
    v = next;
  }
  return v;
}

interface EnrichGroup {
  key: string;
  date: string;
  side: "buy" | "sell";
  qty: number;
  fills: { time: string | null; qty: number }[];
  instrumentType: EnrichmentRow["instrumentType"];
  /** Every string this contract could be called in the book. */
  names: string[];
  isin: string | null;
  lines: number;
}

type EnrichCandidate = {
  id: number;
  symbol: string | null;
  tradingsymbol: string | null;
  isin: string | null;
  buyDate: string | null;
  sellDate: string | null;
  buyQty: number;
  sellQty: number;
  entryTime: string | null;
  exitTime: string | null;
  instrumentType: string | null;
};

/**
 * How a book row was recognised as the security the enrichment names, or null
 * when it was not recognised at all.
 *
 * A STATED ISIN IS DECISIVE IN BOTH DIRECTIONS. It used to be decisive only
 * when it agreed: `Tata Motors / INE155A01022` in the book and `INE155A01029`
 * (the DVR, a different security) on the note fell through to the name rule,
 * where `TATAMOTORS` is a prefix of `TATAMOTORSDVR`, and the note's fill times
 * were written onto the wrong instrument. Two ISINs that disagree are two
 * securities; nothing a name says can outvote that.
 *
 * The name rules are ranked, and the RANK is the point (see `identityRank`):
 * an exact normalised name is evidence, a prefix is a guess that is only
 * allowed to stand when it is the ONLY guess on the day and nothing matched
 * exactly. `HDFC` is a prefix of `HDFCBANK`, and `TATAMOTORS` of
 * `TATAMOTORSDVR`, so a prefix that competes with anything is not a match.
 */
function identityMatch(c: EnrichCandidate, g: EnrichGroup): "isin" | "equal" | "prefix" | null {
  const ci = c.isin ? c.isin.trim().toUpperCase() : null;
  // Both sides state one: they agree and it is the same security, or they
  // disagree and it is not — either way the name is never consulted.
  if (g.isin && ci) return ci === g.isin ? "isin" : null;
  const book = [normIdent(c.symbol), normIdent(c.tradingsymbol)].filter((x) => x.length > 0);
  for (const n of g.names) for (const b of book) if (n === b) return "equal";
  for (const n of g.names) {
    for (const b of book) {
      // `Granules` (book) inside `Granules India Limited` (registry), and the
      // other way round. Four characters minimum, because a three-letter
      // prefix is a coincidence waiting to happen — and the caller still has
      // to find it UNCONTESTED before it counts.
      if (b.length >= 4 && n.length >= 4 && (n.startsWith(b) || b.startsWith(n))) return "prefix";
    }
  }
  return null;
}

function applyEnrichments(
  tx: typeof db,
  rows: EnrichmentRow[],
  accountId: number,
  broker: string,
): EnrichOutcome {
  const notes: string[] = [];
  const reasons = new Map<string, number>();
  const miss = (r: string) => reasons.set(r, (reasons.get(r) ?? 0) + 1);

  // ── 1. Fills → contract-days ────────────────────────────────────────────
  const groups = new Map<string, EnrichGroup>();
  for (const e of rows) {
    const date = normalizeDate(e.date) ?? e.date;
    const isin = e.isin ? e.isin.trim().toUpperCase() : null;
    const key = `${isin ?? e.symbol.trim().toUpperCase()}|${date}|${e.side}`;
    let g = groups.get(key);
    if (!g) {
      // Every alias this contract answers to: the book-style name the source
      // built, the company name it printed, and — through the ISIN — the
      // ticker and registered name the bundled listing snapshot knows.
      const names = new Set<string>();
      const add = (s: string | null | undefined) => { const n = normIdent(s); if (n) names.add(n); };
      add(e.symbol);
      add(e.name);
      if (isin) { add(bundledSymbolByIsin(isin)); add(nameByIsin(isin)); }
      g = {
        key, date, side: e.side, qty: 0, fills: [],
        instrumentType: e.instrumentType ?? null,
        names: [...names], isin, lines: 0,
      };
      groups.set(key, g);
    }
    g.qty += e.qty;
    g.lines++;
    g.fills.push({ time: e.time ?? null, qty: e.qty });
    if (!g.instrumentType && e.instrumentType) g.instrumentType = e.instrumentType;
  }

  // ── 2. The book's rows for those days, once ─────────────────────────────
  const dates = [...new Set([...groups.values()].map((g) => g.date))];
  const candidates: EnrichCandidate[] = dates.length === 0 ? [] : tx
    .select({
      id: tradesTable.id,
      symbol: tradesTable.symbol,
      tradingsymbol: tradesTable.tradingsymbol,
      isin: tradesTable.isin,
      buyDate: tradesTable.buyDate,
      sellDate: tradesTable.sellDate,
      buyQty: tradesTable.buyQty,
      sellQty: tradesTable.sellQty,
      entryTime: tradesTable.entryTime,
      exitTime: tradesTable.exitTime,
      instrumentType: tradesTable.instrumentType,
    })
    .from(tradesTable)
    .where(and(
      eq(tradesTable.accountId, accountId),
      eq(tradesTable.broker, broker),
      or(inArray(tradesTable.buyDate, dates), inArray(tradesTable.sellDate, dates)),
    ))
    .orderBy(tradesTable.id)
    .all() as EnrichCandidate[];

  // One (trade, side) is claimed at most once per import: the buy leg and the
  // sell leg of the same position are two different columns, but two different
  // contract-days must never both write the same one.
  const claimed = new Set<string>();
  let applied = 0, alreadyHad = 0, unmatched = 0, prefixSplits = 0, tails = 0;

  const write = (c: EnrichCandidate, g: EnrichGroup, first: string | null, last: string | null): boolean => {
    const patch: Record<string, unknown> = {};
    const isBuy = g.side === "buy";
    if (isBuy && first && c.entryTime == null) patch.entryTime = first;
    if (!isBuy && last && c.exitTime == null) patch.exitTime = last;
    if (
      (g.instrumentType === "option" || g.instrumentType === "future")
      && c.instrumentType === "equity"
    ) {
      patch.instrumentType = g.instrumentType;
      c.instrumentType = g.instrumentType; // the row is reused across groups
    }
    if (Object.keys(patch).length === 0) return false;
    if (patch.entryTime) c.entryTime = patch.entryTime as string;
    if (patch.exitTime) c.exitTime = patch.exitTime as string;
    tx.update(tradesTable).set(patch).where(eq(tradesTable.id, c.id)).run();
    return true;
  };

  // ── 3. Match, in a deterministic order ──────────────────────────────────
  for (const g of [...groups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const isBuy = g.side === "buy";
    const qtyOf = (c: EnrichCandidate) => (isBuy ? c.buyQty : c.sellQty);
    const onDay = candidates.filter((c) => (isBuy ? c.buyDate : c.sellDate) === g.date && qtyOf(c) > 0);
    if (onDay.length === 0) { unmatched++; miss("no trade of this broker in this account on that date"); continue; }

    // Ranked, not merely filtered: an exact identity always beats a prefix
    // guess, and a prefix guess that competes with another prefix guess is no
    // evidence at all. `HDFC` vs `HDFCBANK` on the same day used to resolve by
    // whichever row had the lower id.
    const strong = onDay.filter((c) => { const m = identityMatch(c, g); return m === "isin" || m === "equal"; });
    const weak = strong.length > 0 ? [] : onDay.filter((c) => identityMatch(c, g) === "prefix");
    let byName: EnrichCandidate[];
    if (strong.length > 0) byName = strong;
    else if (weak.length === 1) byName = weak;
    else if (weak.length > 1) {
      unmatched++;
      miss(`ambiguous: ${weak.length} candidates share this security's name by prefix and none by an exact name or ISIN`);
      continue;
    } else { unmatched++; miss("no trade on that date carries this security's name or ISIN"); continue; }

    const free = byName.filter((c) => !claimed.has(`${c.id}|${g.side}`));
    if (free.length === 0) { unmatched++; miss("every matching trade was already claimed by an earlier line of this note"); continue; }

    const times = g.fills.map((f) => f.time).filter((t): t is string => !!t).sort();
    const first = times[0] ?? null;
    const last = times[times.length - 1] ?? null;

    // Quantity is the last discriminator there is. Two trades of the same
    // security, side, day AND quantity are indistinguishable on everything the
    // note states, so picking one is picking by row id — refuse and say so.
    const exacts = free.filter((c) => qtyOf(c) === g.qty);
    if (exacts.length > 1) {
      unmatched++;
      miss(`ambiguous: ${exacts.length} candidates match this security, date, side and quantity`);
      continue;
    }
    if (exacts.length === 1) {
      const exact = exacts[0];
      claimed.add(`${exact.id}|${g.side}`);
      if (write(exact, g, first, last)) applied++; else alreadyHad++;
      continue;
    }

    // A day's fills covered more than one position: consume them as a
    // cumulative prefix in time order. The first N fills that sum to a
    // position's quantity ARE that position — the note states no position id,
    // so this is an inference, and it says so.
    const sorted = [...g.fills].sort((a, b) => String(a.time ?? "").localeCompare(String(b.time ?? "")));
    let cum = 0, from: string | null = null, to: string | null = null, hits = 0, wrote = false, ambiguous = 0;
    for (const f of sorted) {
      cum += f.qty;
      if (!from) from = f.time ?? null;
      if (f.time) to = f.time;
      const candidates = free.filter((c) => !claimed.has(`${c.id}|${g.side}`) && qtyOf(c) === cum);
      if (candidates.length > 1) { ambiguous = candidates.length; break; }
      const hit = candidates[0];
      if (!hit) continue;
      claimed.add(`${hit.id}|${g.side}`);
      if (write(hit, g, from, to)) wrote = true;
      hits++;
      cum = 0; from = null; to = null;
    }
    // ONE contract-day, ONE outcome. The counts used to be incremented per HIT
    // inside the split, so a day that filled three positions was reported as
    // three days applied out of one — and `applied + alreadyHad + unmatched`
    // could exceed the number of contract-days the same sentence stated.
    if (ambiguous > 0 && hits === 0) {
      unmatched++;
      miss(`ambiguous: ${ambiguous} candidates match this security, date, side and quantity`);
    } else if (hits > 0) {
      if (wrote) applied++; else alreadyHad++;
      prefixSplits++;
      // A tail that summed to no position is fills that enriched NOTHING. It
      // used to call miss() without touching any counter, so the reason lived
      // in a list the warning only prints when `unmatched > 0` — on a file
      // where every day matched, the loss was recorded nowhere at all.
      if (cum > 0 || ambiguous > 0) tails++;
    } else {
      unmatched++;
      miss(`the day's fills sum to a quantity no trade holds`);
    }
  }

  if (prefixSplits > 0) {
    notes.push(
      `${prefixSplits} contract-day${prefixSplits === 1 ? "" : "s"} held more fills than one position, so the fills were split by CUMULATIVE PREFIX in time order — the first fills that sum to a position's quantity were treated as that position's. The note states no position id, so that is an inference, not a fact it printed.`,
    );
  }

  return {
    applied,
    alreadyHad,
    unmatched,
    tails,
    groups: groups.size,
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    notes,
  };
}

export function commitParsedFile(
  parsedIn: ParsedFile,
  fileName: string,
  productOverrides: Record<string, ProductHint> | null = null,
  accountIdIn?: number | null,
  /** R43: a broker pull's snapshot identity — see `SupersedeSnapshot`. */
  options: ImportWriteOptions = {},
): CommitResult {
  const parsed = applyProductOverrides(resolveSymbols(parsedIn), productOverrides);
  const { rates, defaults, accountId } = loadContext(accountIdIn);
  const overrides = loadOverrides(parsed.broker);

  return db.transaction((tx) => {
    // A live pull or import can race an account delete: the id resolved above
    // may be gone by the time this transaction runs, and writing anyway would
    // put ghost trades into a dead account_id — rows no scoped read can ever
    // show. Verify INSIDE the transaction, where the answer cannot change
    // again before the writes land.
    if (!tx.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.id, accountId)).get()) {
      throw new Error(`The destination account (id ${accountId}) no longer exists — it was deleted while this import was in flight. Nothing was imported.`);
    }
    // R26: own hashes AND aliases, the same set the preview reads.
    const heldRows = tx
      .select({
        id: tradesTable.id,
        dedupHash: tradesTable.dedupHash,
        importNotes: tradesTable.importNotes,
        // V1: the legs `heldIdentityHashes` reads.
        buyQty: tradesTable.buyQty,
        sellQty: tradesTable.sellQty,
        tradingsymbol: tradesTable.tradingsymbol,
        symbol: tradesTable.symbol,
        segment: tradesTable.segment,
        exchange: tradesTable.exchange,
        buyDate: tradesTable.buyDate,
        sellDate: tradesTable.sellDate,
        sourceFile: tradesTable.sourceFile,
        // W2R N1: what the user may have recorded on the row (carriesUserRecord).
        acquisition: tradesTable.acquisition,
        acquisitionPrice: tradesTable.acquisitionPrice,
        acquisitionDate: tradesTable.acquisitionDate,
        notes: tradesTable.notes,
        playbookId: tradesTable.playbookId,
        emotionTag: tradesTable.emotionTag,
        mistakeTags: tradesTable.mistakeTags,
        exitTrigger: tradesTable.exitTrigger,
        ruleViolations: tradesTable.ruleViolations,
        reviewedAt: tradesTable.reviewedAt,
      })
      .from(tradesTable)
      .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, parsed.broker)))
      .all();
    const existing = new Set(heldRows.flatMap((r) => heldIdentityHashes(r)));
    // Wave U: the account row is read ONCE, not once per trade.
    const planAccount = planAccountOf(accountId);
    const built = parsed.trades.map((t) => ({ t, b: buildRow(t, rates, overrides, defaults, planAccount) }));
    // W1 (F-L1-7): two rows of this file that differ only by exchange or
    // segment are two executions, not one — the second no longer dies as a
    // duplicate of the first. Nothing stored is re-keyed.
    applyScopedIdentity(built, overrides, (t, ov) => buildRow(t, rates, ov, defaults, planAccount));
    // R43: decided ONCE, against the account as it stands before any write.
    const snapshot = planSnapshot(
      options.supersedeSnapshot,
      built,
      (h) => existing.has(h),
      heldRows,
      (ids) => tradeIdsWithLegs(tx as unknown as TxLike, ids),
      reclassifiedBy(overrides),
    );
    let superseded = 0;

    const batch = tx
      .insert(importBatches)
      .values({
        accountId,
        broker: parsed.broker,
        fileName,
        rowCount: parsed.trades.length,
        status: "completed",
        // When the parser paired statement lines into positions, record the
        // line count so the imports table can show "92 lines → 73 trades".
        notes:
          parsed.sourceRows != null && parsed.sourceRows !== parsed.trades.length
            ? `${parsed.sourceRows} source lines`
            : null,
      })
      .returning({ id: importBatches.id })
      .get();
    const batchId = batch!.id;

    let added = 0, skipped = 0, netPnl = 0, openCount = 0, openingSells = 0;
    const seenInThisFile = new Set<string>();

    // ── The book wins over the reference ───────────────────────────────────
    // Decided ONCE, before any row is written, and against the account as it
    // stands at the start of this transaction — evaluating it per row would
    // let this file's own first insert make itself the book.
    const referenceCarryingTrades =
      parsed.trades.length > 0 && REFERENCE_SOURCE_IDS.includes(parsed.sourceId);
    const bookHeld = referenceCarryingTrades && holdsBookTrades(tx as unknown as TxLike, accountId, parsed.broker);

    const writeLadder = (tradeId: number, t: NormalizedTrade) => {
      let seq = 1;
      const isShort = t.sellQty > t.buyQty; // must match orderExecutions (fix A6)
      for (const ex of orderExecutions(t)) {
        const opening = isShort ? ex.side === "sell" : ex.side === "buy";
        tx.insert(tradeLegs)
          .values({
            tradeId,
            kind: opening ? "entry" : "exit",
            seq: seq++,
            tradeDate: normalizeDate(ex.date) ?? normalizeDate(t.buyDate) ?? normalizeDate(t.sellDate) ?? "",
            tradeTime: ex.time ?? null,
            qty: ex.qty,
            price: ex.price,
            note: "Imported execution",
          })
          .run();
      }
    };

    // ── W2a: the auto-close applier. OFF unless the caller asks for it ──────
    // `options.autoClose` defaults to FALSE, so every production caller on this
    // tree (app/api/import/route.ts, app/api/import/broker/route.ts,
    // lib/jobs/auto-pull.ts) writes exactly what v4.4.0 wrote. W2b flips it.
    const autoClose = options.autoClose === true;
    const counters = emptyAutoCloseCounters();
    const lotRows = new Map<number, typeof tradesTable.$inferSelect>();
    const lots: OpenLot[] = [];
    const openedHere = new Set<number>();
    // W2a-F1 — the SUMMARY reports what the BOOK moved, each leg charged once.
    // A buy and a sell in ONE file were counted twice: the buy as an open row
    // (net = -its own bill) and again inside the merged close that consumed it
    // (Rs 51.96 shown against Rs 39.58 in the book). What this file already
    // counted for a lot it opened is taken back when that lot is closed.
    const countedNet = new Map<number, number>();
    if (autoClose) {
      const openRows = tx
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, parsed.broker), eq(tradesTable.isOpen, true)))
        .all();
      const laddered = tradeIdsWithLegs(tx as unknown as TxLike, openRows.map((r) => r.id));
      for (const r of openRows) {
        const lot = openLotOf(r, laddered.has(r.id));
        if (!lot) continue;
        lotRows.set(r.id, r);
        lots.push(lot);
      }
    }
    const ratesOnFor = (row: typeof tradesTable.$inferSelect) => (day: string) =>
      ratesForTrade(
        rates,
        { broker: row.broker as Broker, segment: row.segment as Segment, exchange: row.exchange as Exchange, isin: row.isin, symbol: row.symbol },
        day,
        resolvePlan(planAccount, row.broker, day, rates),
      );

    /**
     * Close what this execution closes. Returns null when it closed nothing
     * (the caller then writes it as an ordinary row, exactly as v4.2.0 did),
     * or the scaled remainder to write instead — `null` remainder meaning the
     * execution was consumed whole and nothing more is to be written.
     */
    const runAutoClose = (
      t: NormalizedTrade,
      b: BuiltRow,
    ): { remainder: { t: NormalizedTrade; hash: string; note: (n: string | null) => string } | null; netPnl: number; added: number } | null => {
      const plan = planExecutionCloses(t, b, accountId, lots, lotRows, ratesOnFor);
      if (!plan) return null;
      if (plan.refusedNoDate) {
        counters.refusedNoDate++;
        return null;
      }
      const { pieces, untouchedQty, holder, execRest, execRestTotal } = plan;

      let netDelta = 0;
      let inserted = 0;
      for (const [pi, piece] of pieces.entries()) {
        const { c } = piece;
        const row = lotRows.get(c.lotId)!;
        const execBill = { ...piece.execShare.parts, total: piece.execShare.total };
        const closed = closedTradeOf(t, c, piece.entryTime, piece.parts, piece.total);
        const cb = buildRow(closed, rates, overrides, defaults, planAccount);
        const holdsHash = holder.kind !== "remainder" && holder.at === pi;
        netDelta = r2m(netDelta + cb.netPnl);
        // W2a-F1: this lot's own bill was counted when THIS file opened it.
        if (countedNet.has(c.lotId)) {
          netDelta = r2m(netDelta - countedNet.get(c.lotId)!);
          countedNet.delete(c.lotId);
        }

        if (c.fullyConsumed) {
          // The LOT ROW becomes the closed row: no slice, its own hash kept,
          // the execution's hash held as an alias when it holds it.
          const kept = keptRisk(row, row.bucket, row.segment, defaults.capRows);
          const notes = holdsHash
            ? withExecBillNote(withLotCloseNote(row.importNotes, b.dedup), execBill)
            : withExecBillNote(withClosedByNote(withAutoClosedLotNote(row.importNotes), b.dedup), execBill);
          const patch = {
            buyQty: closed.buyQty,
            avgBuyPrice: closed.avgBuyPrice,
            buyValue: closed.buyValue,
            buyDate: normalizeDate(closed.buyDate),
            sellQty: closed.sellQty,
            avgSellPrice: closed.avgSellPrice,
            sellValue: closed.sellValue,
            sellDate: normalizeDate(closed.sellDate),
            exitTime: closed.exitTime ?? null,
            isOpen: cb.isOpen,
            grossPnl: closed.grossPnl,
            unrealisedPnl: 0,
            chargesTotal: cb.charges.total,
            netPnl: cb.netPnl,
            realisedPct: cb.realisedPct,
            ...(kept.followsCap ? { riskAmount: kept.riskAmount } : {}),
            rMultiple: capR(cb.netPnl, kept.followsCap ? kept.riskAmount : row.riskAmount),
            brokerage: piece.parts.brokerage,
            sttCtt: piece.parts.sttCtt,
            exchangeTxn: piece.parts.exchangeTxn,
            sebi: piece.parts.sebi,
            stampDuty: piece.parts.stampDuty,
            ipft: piece.parts.ipft,
            gst: piece.parts.gst,
            dpCharges: piece.parts.dpCharges,
            mtfInterest: piece.parts.mtfInterest,
            pledgeCharges: piece.parts.pledgeCharges,
            importNotes: notes,
            updatedAt: sql`(datetime('now'))`,
          };
          tx.update(tradesTable).set(patch).where(eq(tradesTable.id, row.id)).run();
          recordAudit({
            entity: "trade",
            entityId: row.id,
            action: "close",
            summary: `${row.symbol} closed automatically against this import (${fileName}) · ${c.qty} @ ${c.price} · net ${cb.netPnl}`,
            before: { isOpen: true, buyQty: row.buyQty, sellQty: row.sellQty, chargesTotal: row.chargesTotal, netPnl: row.netPnl, importNotes: row.importNotes },
            after: { isOpen: false, buyQty: closed.buyQty, sellQty: closed.sellQty, chargesTotal: cb.charges.total, netPnl: cb.netPnl, importNotes: notes },
            source: "import",
          });
          counters.closedWhole++;
        } else {
          // The lot stays open with less of it, and the CLOSE is a new row.
          const rem = plan.remainders.find((x) => x.lotId === c.lotId)!;
          const bill = { total: rem.charges, parts: rem.parts ?? partsOf(row as unknown as StaleChargeParts) };
          const long = c.side === "long";
          const before = { buyQty: row.buyQty, sellQty: row.sellQty, buyValue: row.buyValue, sellValue: row.sellValue, chargesTotal: row.chargesTotal, netPnl: row.netPnl, importNotes: row.importNotes };
          // W3: the reduced lot names the execution that took part of it —
          // `closed-by:` is not an identity, and without it un-close could not
          // find the lot at all (it holds no alias, by the one-holder rule).
          const lotNotes = withClosedByNote(withAutoClosedLotNote(row.importNotes), b.dedup);
          const lotPatch = {
            ...(long
              ? { buyQty: rem.qty, buyValue: rem.value }
              : { sellQty: rem.qty, sellValue: rem.value }),
            chargesTotal: bill.total,
            grossPnl: 0,
            netPnl: r2m(0 - bill.total),
            brokerage: bill.parts.brokerage,
            sttCtt: bill.parts.sttCtt,
            exchangeTxn: bill.parts.exchangeTxn,
            sebi: bill.parts.sebi,
            stampDuty: bill.parts.stampDuty,
            ipft: bill.parts.ipft,
            gst: bill.parts.gst,
            dpCharges: bill.parts.dpCharges,
            mtfInterest: bill.parts.mtfInterest,
            pledgeCharges: bill.parts.pledgeCharges,
            importNotes: lotNotes,
            updatedAt: sql`(datetime('now'))`,
          };
          tx.update(tradesTable).set(lotPatch).where(eq(tradesTable.id, row.id)).run();
          Object.assign(row, lotPatch, { updatedAt: row.updatedAt });
          recordAudit({
            entity: "trade",
            entityId: row.id,
            action: "update",
            summary: `${row.symbol} reduced to ${rem.qty} by this import (${fileName}) — ${c.qty} of it closed`,
            before,
            after: { buyQty: long ? rem.qty : row.buyQty, sellQty: long ? row.sellQty : rem.qty, buyValue: long ? rem.value : row.buyValue, sellValue: long ? row.sellValue : rem.value, chargesTotal: bill.total, netPnl: r2m(0 - bill.total), importNotes: lotNotes },
            source: "import",
          });
          counters.reduced++;

          const sliceHash = holdsHash ? b.dedup : executionIdentity({ ...closed, segment: cb.classification.segment, exchange: cb.classification.exchange }).hash;
          const sliceNotes = holdsHash
            ? withExecBillNote(withLotCloseNote(null, b.dedup), execBill)
            : withExecBillNote(withClosedByNote(AUTO_CLOSE_NOTE, b.dedup), execBill);
          const ins = tx
            .insert(tradesTable)
            .values({
              accountId,
              broker: closed.broker,
              bucket: cb.classification.bucket,
              segment: cb.classification.segment,
              instrumentType: cb.classification.instrumentType,
              exchange: cb.classification.exchange,
              symbol: cb.classification.symbol,
              tradingsymbol: closed.tradingsymbol,
              isin: closed.isin,
              expiry: cb.classification.expiry,
              strike: cb.classification.strike,
              optionType: cb.classification.optionType,
              buyQty: closed.buyQty,
              avgBuyPrice: closed.avgBuyPrice,
              buyValue: closed.buyValue,
              sellQty: closed.sellQty,
              avgSellPrice: closed.avgSellPrice,
              sellValue: closed.sellValue,
              closingPrice: null,
              buyDate: normalizeDate(closed.buyDate),
              sellDate: normalizeDate(closed.sellDate),
              entryTime: closed.entryTime ?? null,
              exitTime: closed.exitTime ?? null,
              grossPnl: closed.grossPnl,
              chargesTotal: cb.charges.total,
              netPnl: cb.netPnl,
              unrealisedPnl: 0,
              realisedPct: cb.realisedPct,
              isOpen: cb.isOpen,
              buyOrderCount: cb.buyOrderCount,
              sellOrderCount: cb.sellOrderCount,
              riskAmount: cb.riskAmount,
              rMultiple: cb.rMultiple,
              riskSource: cb.riskSource,
              brokerage: piece.parts.brokerage,
              sttCtt: piece.parts.sttCtt,
              exchangeTxn: piece.parts.exchangeTxn,
              sebi: piece.parts.sebi,
              stampDuty: piece.parts.stampDuty,
              ipft: piece.parts.ipft,
              gst: piece.parts.gst,
              dpCharges: piece.parts.dpCharges,
              mtfInterest: piece.parts.mtfInterest,
              pledgeCharges: piece.parts.pledgeCharges,
              sourceFile: fileName,
              importBatchId: batchId,
              dedupHash: sliceHash,
              staged: false,
              importNotes: sliceNotes,
            })
            .returning({ id: tradesTable.id })
            .get();
          inserted++;
          recordAudit({
            entity: "trade",
            entityId: ins!.id,
            action: "create",
            summary: `${cb.classification.symbol} closed automatically against position #${row.id} (${fileName}) · ${c.qty} @ ${c.price} · net ${cb.netPnl}`,
            after: { buyQty: closed.buyQty, sellQty: closed.sellQty, chargesTotal: cb.charges.total, netPnl: cb.netPnl, importNotes: sliceNotes },
            source: "import",
          });
        }
        if (openedHere.has(c.lotId)) counters.closedAgainstThisFilesLot++;
        else counters.closedAgainstStoredLot++;
      }

      // The live lot view follows the plan, so the next row of this same file
      // sees the book as it now stands (M-2 / R58).
      for (const rem of plan.remainders) {
        const l = lots.find((x) => x.id === rem.lotId);
        if (!l) continue;
        l.qty = rem.qty;
        l.value = rem.value;
        l.charges = rem.charges;
      }

      if (untouchedQty <= 0) return { remainder: null, netPnl: netDelta, added: inserted };
      const scaled = scaledRemainderOf(t, untouchedQty, execRest, execRestTotal);
      const scaledHash = holder.kind === "remainder"
        ? b.dedup
        : executionIdentity({ ...scaled, segment: b.classification.segment, exchange: b.classification.exchange }).hash;
      return {
        remainder: {
          t: scaled,
          hash: scaledHash,
          note: (n) =>
            withExecBillNote(
              holder.kind === "remainder" ? withScaledRemainderNote(n, scaledHash) : withClosedByNote(n, b.dedup),
              { ...execRest, total: execRestTotal },
            ),
        },
        netPnl: netDelta,
        added: inserted,
      };
    };

    for (const [i, entry] of built.entries()) {
      // `let`, not a destructured const: an execution that closed part of a lot
      // is written as its SCALED remainder, and the rest of this body must see
      // that row rather than the whole one the file stated (W2a).
      let { t, b } = entry;
      // Counted BEFORE the duplicate check, and over every parsed row: the
      // shape sentence describes the FILE, which is what the user reconciles
      // against their broker's statement. Added/skipped is a separate fact.
      if (t.basisUnknown) openingSells++;
      else if (b.isOpen) openCount++;
      // Superseded rows are neither ADDED nor SKIPPED-as-duplicate: they are a
      // third outcome, counted in `total` and named in its own warning. Calling
      // them duplicates would be a lie — dedup could not see them.
      if (bookHeld) continue;
      if (existing.has(b.dedup) || seenInThisFile.has(b.dedup)) {
        skipped++;
        continue;
      }
      seenInThisFile.add(b.dedup);

      // W2a — does this execution close something the book holds? (dormant)
      let noteDecorator: ((n: string | null) => string) | null = null;
      if (autoClose) {
        const done = runAutoClose(t, b);
        if (done) {
          added += done.added;
          netPnl = r2m(netPnl + done.netPnl);
          if (done.remainder) {
            // Part of it closed lots; this row is what was left of it.
            t = done.remainder.t;
            b = { ...buildRow(t, rates, overrides, defaults, planAccount), dedup: done.remainder.hash };
            noteDecorator = done.remainder.note;
          } else {
            // R31 — a row the plan closed is not an "opening sell with no cost
            // basis", and not an open position either. The file's shape counted
            // it as one before the plan was known; it is now neither.
            if (t.basisUnknown) openingSells--;
            else if (b.isOpen) openCount--;
            continue;
          }
        }
      }

      // A derived fact must not wear a reported fact's clothes (invariant 6):
      // when an MTF trade's file states no interest figure, whatever later
      // shows in mtfInterest (the daily accrual job for open positions, the
      // close path) is the engine's estimate from charge_config, not a broker
      // statement — say so on the row, where importNotes already surfaces.
      const mtfInterestDerived =
        b.classification.segment === "eq_mtf" && t.reportedCharges?.mtfInterest == null;
      const noteLines = [
        ...(t.importNotes ?? []),
        ...(mtfInterestDerived
          ? ["MTF interest not stated by the file — any interest shown is estimated from your configured rates"]
          : []),
      ];

      // R43: today's earlier snapshot of this position is REPLACED in place —
      // the broker's later statement of the same book. Only the columns the
      // broker states change; the id, the import batch (the row stays in the
      // morning's batch) and everything the user wrote on the row are kept.
      const target = snapshot?.supersede.get(i);
      if (target) {
        const before = tx.select().from(tradesTable).where(eq(tradesTable.id, target.id)).get();
        if (before) {
          // D1 (v4.4.0): a 'cap' row re-resolves for the segment it holds (the
          // supersede never re-classifies); a typed or frozen risk is kept.
          const kept = keptRisk(before, before.bucket, before.segment, defaults.capRows);
          const staged = stagedFromExecutions(t);
          const patch = {
            isin: t.isin,
            buyQty: t.buyQty,
            avgBuyPrice: t.avgBuyPrice,
            buyValue: t.buyValue,
            sellQty: t.sellQty,
            avgSellPrice: t.avgSellPrice,
            sellValue: t.sellValue,
            closingPrice: t.closingPrice,
            buyDate: normalizeDate(t.buyDate),
            sellDate: normalizeDate(t.sellDate),
            entryTime: t.entryTime ?? null,
            exitTime: t.exitTime ?? null,
            grossPnl: t.grossPnl,
            chargesTotal: b.charges.total,
            netPnl: b.netPnl,
            unrealisedPnl: t.unrealisedPnl,
            realisedPct: b.realisedPct,
            isOpen: b.isOpen,
            buyOrderCount: b.buyOrderCount,
            sellOrderCount: b.sellOrderCount,
            // R is the row's own risk figure (the user may have set it), not the
            // default — unless the row follows the cap, which it then re-reads.
            ...(kept.followsCap
              ? { riskAmount: kept.riskAmount, riskSource: staged ? (kept.riskAmount == null ? null : ("frozen" as const)) : ("cap" as const) }
              : {}),
            rMultiple: capR(b.netPnl, kept.riskAmount),
            brokerage: b.charges.brokerage,
            sttCtt: b.charges.sttCtt,
            exchangeTxn: b.charges.exchangeTxn,
            sebi: b.charges.sebi,
            stampDuty: b.charges.stampDuty,
            ipft: b.charges.ipft,
            gst: b.charges.gst,
            dpCharges: b.charges.dpCharges,
            mtfInterest: b.charges.mtfInterest,
            pledgeCharges: b.charges.pledgeCharges,
            dedupHash: b.dedup,
            staged,
            // An unknown basis is the file's fact; a basis the user chose is theirs.
            acquisition:
              before.acquisition == null || before.acquisition === "unknown"
                ? (t.basisUnknown ? "unknown" : null)
                : before.acquisition,
            suggestedBasisPrice: t.suggestedBasisPrice ?? null,
            importNotes: noteLines.length ? noteLines.join(" | ") : null,
          };
          tx.update(tradesTable).set(patch).where(eq(tradesTable.id, target.id)).run();
          const keys = Object.keys(patch) as (keyof typeof patch)[];
          const pick = (r: Record<string, unknown>) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
          recordAudit({
            entity: "trade",
            entityId: target.id,
            action: "update",
            summary: `${t.tradingsymbol}: updated from today's earlier pull (${fileName})`,
            before: pick(before),
            after: pick({ ...before, ...patch }),
            source: "import",
          });
          // The candidate had no ladder (planSnapshot), so a staged row gets its
          // own, written exactly as an insert writes one.
          if (patch.staged) writeLadder(target.id, t);
          superseded++;
          continue;
        }
      }

      const inserted = tx.insert(tradesTable)
        .values({
          accountId,
          broker: t.broker,
          bucket: b.classification.bucket,
          segment: b.classification.segment,
          instrumentType: b.classification.instrumentType,
          exchange: b.classification.exchange,
          symbol: b.classification.symbol,
          tradingsymbol: t.tradingsymbol,
          isin: t.isin,
          expiry: b.classification.expiry,
          strike: b.classification.strike,
          optionType: b.classification.optionType,
          buyQty: t.buyQty,
          avgBuyPrice: t.avgBuyPrice,
          buyValue: t.buyValue,
          sellQty: t.sellQty,
          avgSellPrice: t.avgSellPrice,
          sellValue: t.sellValue,
          closingPrice: t.closingPrice,
          buyDate: normalizeDate(t.buyDate),
          sellDate: normalizeDate(t.sellDate),
          // Execution times, when the source carried them. These columns
          // existed since the first schema but nothing ever wrote them, so
          // time-of-day analytics had no data to read.
          entryTime: t.entryTime ?? null,
          exitTime: t.exitTime ?? null,
          grossPnl: t.grossPnl,
          chargesTotal: b.charges.total,
          netPnl: b.netPnl,
          unrealisedPnl: t.unrealisedPnl,
          realisedPct: b.realisedPct,
          isOpen: b.isOpen,
          buyOrderCount: b.buyOrderCount,
          sellOrderCount: b.sellOrderCount,
          riskAmount: b.riskAmount,
          rMultiple: b.rMultiple,
          riskSource: b.riskSource,
          brokerage: b.charges.brokerage,
          sttCtt: b.charges.sttCtt,
          exchangeTxn: b.charges.exchangeTxn,
          sebi: b.charges.sebi,
          stampDuty: b.charges.stampDuty,
          ipft: b.charges.ipft,
          gst: b.charges.gst,
          dpCharges: b.charges.dpCharges,
          mtfInterest: b.charges.mtfInterest,
          pledgeCharges: b.charges.pledgeCharges,
          sourceFile: fileName,
          importBatchId: batchId,
          dedupHash: b.dedup,
          staged: stagedFromExecutions(t),
          // A sell with no matching purchase in the file: the cost basis is
          // unknowable until the user says how the stock was acquired, so it
          // is flagged rather than reported as an all-profit trade.
          acquisition: t.basisUnknown ? "unknown" : null,
          suggestedBasisPrice: t.suggestedBasisPrice ?? null,
          // W2a: a remainder row states WHY it is smaller than the file's own
          // row, and (when it holds it) freezes the execution's hash on itself.
          importNotes: (() => {
            const base = noteLines.length ? noteLines.join(" | ") : null;
            return noteDecorator ? noteDecorator(base) : base;
          })(),
        })
        .returning({ id: tradesTable.id })
        .get();
      added++;
      netPnl += b.netPnl;
      if (autoClose) {
        if (b.isOpen) counters.openedNew++;
        // M-2 / R58: a lot this file just opened is a lot the NEXT row of the
        // same file can close. Re-read, so the pool holds exactly what is stored.
        if (inserted && b.isOpen && !stagedFromExecutions(t)) {
          const fresh = tx.select().from(tradesTable).where(eq(tradesTable.id, inserted.id)).get();
          const lot = fresh ? openLotOf(fresh, false) : null;
          if (fresh && lot) {
            lotRows.set(fresh.id, fresh);
            lots.push(lot);
            openedHere.add(fresh.id);
            countedNet.set(fresh.id, b.netPnl);
          }
        }
      }

      // Preserve the entry ladder from a tradebook export. The parent row keeps
      // the aggregate the rest of the app reads; the legs give the position its
      // real shape — three entries at three prices instead of one blended
      // average. Charges stay as computed on the aggregate here; opening the
      // staged panel reprices per fill.
      if (inserted && stagedFromExecutions(t)) writeLadder(inserted.id, t);
    }

    tx.update(importBatches)
      .set({ addedCount: added, skippedCount: skipped })
      .where(eq(importBatches.id, batchId))
      .run();

    // ── v3.9: the broker's own figures, and facts about existing trades ─────
    // Both run INSIDE the same transaction as the trades: a file that states
    // both must land wholly or not at all, or a failed import leaves a
    // reconciliation screen quoting figures for trades that were never
    // written. A reference-only file (Paytm's Realized P&L, a holdings
    // statement) reaches here with `parsed.trades.length === 0` and commits
    // successfully — that is the sanctioned exception to "nothing to import",
    // which stays a refusal for a TRADEBOOK that produced no rows.
    const commitWarnings: string[] = [];
    if (superseded > 0) commitWarnings.push(`${supersededPhrase(superseded)}.`);
    // W2a — R14/R15/R31: what the import did to the book's open positions, in
    // the ONE wording the preview uses too (`autoCloseSentences`, pure).
    for (const s of autoCloseSentences(counters)) commitWarnings.push(s);
    const referenceRows = parsed.reference?.length ? parsed.reference : referenceFromReported(parsed.reported);
    const referenceStored = referenceRows.length
      ? persistReference(tx, referenceRows, accountId, parsed.broker, parsed.sourceId, batchId)
      : 0;
    if (referenceStored > 0) {
      commitWarnings.push(
        `${referenceStored} reference figure${referenceStored === 1 ? "" : "s"} stored — the broker's own numbers, kept beside yours for reconciliation, not merged into them.`,
      );
      // ONE audit entry per reference import, not one per figure: what changed
      // is the broker's side of the reconciliation, and which file changed it.
      recordAudit({
        entity: "broker_reference",
        entityId: batchId,
        action: "create",
        summary: `${referenceStored} broker-stated figure${referenceStored === 1 ? "" : "s"} from ${fileName}`,
        before: null,
        after: { accountId, broker: parsed.broker, sourceId: parsed.sourceId, figures: referenceStored, importBatchId: batchId },
        source: "import",
      });
    }

    if (referenceCarryingTrades) {
      const note = referenceVsBookNote(parsed.trades.length, bookHeld);
      if (note) commitWarnings.push(note);
    }

    let enrichApplied = 0;
    const enrichTotal = parsed.enrich?.length ?? 0;
    if (enrichTotal > 0) {
      const outcome = applyEnrichments(tx as unknown as typeof db, parsed.enrich!, accountId, parsed.broker);
      enrichApplied = outcome.applied;
      // Three outcomes, named separately. "Applied" used to count a row whose
      // patch was EMPTY — a trade that already had both times was reported as
      // enriched, which is the one thing the number was for.
      commitWarnings.push(
        `${enrichTotal} contract-note fill${enrichTotal === 1 ? "" : "s"} aggregated into ${outcome.groups} contract-day${outcome.groups === 1 ? "" : "s"}: applied ${outcome.applied}, already had times ${outcome.alreadyHad}, unmatched ${outcome.unmatched}.`,
      );
      for (const n of outcome.notes) commitWarnings.push(n);
      if (outcome.tails > 0) {
        commitWarnings.push(
          `${outcome.tails} of those contract-day${outcome.tails === 1 ? "" : "s"} placed some positions and still had fills left over: part of a day's fills for one contract summed to no position this account holds, so those fills enriched nothing. The day is counted once above, under its own outcome.`,
        );
      }
      if (outcome.unmatched > 0) {
        const why = outcome.reasons.slice(0, 3).map((r) => `${r.count}× ${r.reason}`).join("; ");
        commitWarnings.push(
          `${outcome.unmatched} contract-day${outcome.unmatched === 1 ? "" : "s"} matched no trade in this account and ${outcome.unmatched === 1 ? "was" : "were"} NOT imported — a contract note enriches trades the book already holds, it never creates one. Why: ${why}.`,
        );
      }
    }

    return {
      batchId,
      broker: parsed.broker,
      fileName,
      added,
      skipped,
      total: parsed.trades.length,
      netPnl: Math.round(netPnl * 100) / 100,
      shape: {
        sourceRows: parsed.sourceRows ?? null,
        positions: parsed.trades.length,
        open: openCount,
        openingSells,
        relabelled: relabelledFromWarnings(parsed.warnings),
      },
      referenceStored,
      enrichApplied,
      enrichTotal,
      warnings: commitWarnings,
      ...(autoClose ? { autoClose: counters } : {}),
    };
  });
}

export interface ManualJournalFields {
  forcedSegment?: Segment | null;
  forcedExchange?: Exchange | null;
  setupTag?: string | null;
  notes?: string | null;
  slPlanned?: number | null;
  trailingSl?: number | null;
  targetPlanned?: number | null;
  riskAmount?: number | null;
  /** MTF only: how much of YOUR OWN money went into this trade — the primary,
   * verifiable input (it's what actually left your account). fundedAmount
   * (broker-financed principal) is derived as buyValue − ownCapitalUsed. */
  ownCapitalUsed?: number | null;
  daysHeld?: number | null;
  buyOrders?: number;
  sellOrders?: number;
  /** Current MTM price for an open position — stored so it shows live on trackers. */
  currentPrice?: number | null;
  /** Pre-trade limit breaches recorded at entry (P1.4) — stored + audited. */
  ruleViolations?: string[] | null;
  /** Derivatives lot size (shares = lots × lotSize) — user-entered, varies by contract. */
  lotSize?: number | null;
  /**
   * The Signal book's envelope (v4.3.0), ALREADY SERIALISED by
   * `signalFromForm` server-side — this writer never sees the form's raw
   * strings and never validates them. Stored only on an OPTION; anything else
   * forces null, because a signal describes a strike's chain.
   */
  signalJson?: string | null;
}

/** Insert a single manually-entered trade (source_file = "manual"). */
export function commitManualTrade(
  t: NormalizedTrade,
  fields: ManualJournalFields = {},
  accountIdIn?: number | null,
): { id: number | null; duplicate: boolean } {
  const { rates, defaults, accountId } = loadContext(accountIdIn);

  let cls = classify({
    tradingsymbol: t.tradingsymbol,
    broker: t.broker,
    isin: t.isin,
    productHint: t.productHint,
    exchangeHint: t.exchangeHint ?? fields.forcedExchange ?? null,
  });
  if (fields.forcedSegment) {
    cls = {
      ...cls,
      segment: fields.forcedSegment,
      bucket: SEGMENT_BUCKET[fields.forcedSegment],
      exchange: fields.forcedExchange ?? cls.exchange,
    };
  }

  // W1: the same identity door as the import path. One manual row is its own
  // file, so there is no second scope to disambiguate it against and the hash
  // is `dedupHash` exactly as before.
  const dedup = executionIdentity({ ...t, segment: cls.segment, exchange: cls.exchange }).hash;
  const dup = db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, t.broker), eq(tradesTable.dedupHash, dedup)))
    .all();
  if (dup.length > 0) return { id: null, duplicate: true };

  const buyOrderCount = t.buyQty > 0 ? fields.buyOrders ?? defaults.buyOrders : 0;
  const sellOrderCount = t.sellQty > 0 ? fields.sellOrders ?? defaults.sellOrders : 0;
  const onDate = pricingDate(t, todayIstIso());
  const r = ratesForTrade(
    rates,
    { broker: t.broker, segment: cls.segment, exchange: cls.exchange, isin: t.isin, symbol: cls.symbol },
    onDate,
    // Wave U — the plan of the account this trade is being FILED IN, on the
    // trade's own pricing date. `getWriteAccountId` above already resolved
    // which account that is, so the preview (/api/charges/preview, which now
    // takes the same accountId) and this save ask the same question.
    resolvePlan(planAccountOf(accountId), t.broker, onDate, rates),
  );

  // Net non-zero, not just buyQty>sellQty — a pure sell-to-open (short option/future)
  // row has buyQty=0 and must still be OPEN, not silently marked closed.
  const isOpen = t.buyQty !== t.sellQty;

  // MTF: ownCapitalUsed (what YOU actually put in) is the primary, verifiable
  // input; fundedAmount (the broker-financed principal, which is what interest
  // accrues on) is derived as buyValue − ownCapitalUsed — never the full
  // position value. No explicit own-capital entry → auto-estimate from
  // margin_config's eq_mtf %. daysHeld is forced to 0 for a freshly-opened
  // position — interest can't have accrued before the daily accrual job runs
  // from T+1 (see lib/jobs/mtf-accrual.ts).
  const isMtf = cls.segment === "eq_mtf";
  const effectiveFundedAmount = isMtf
    ? fields.ownCapitalUsed != null && fields.ownCapitalUsed >= 0
      ? Math.max(0, Math.round((t.buyValue - fields.ownCapitalUsed) * 100) / 100)
      : defaultMtfFundedAmount(t.buyValue, mtfOwnMarginPct(t.broker))
    : null;
  const effectiveDaysHeld = isOpen ? 0 : fields.daysHeld ?? 0;

  const charges = computeCharges(
    {
      segment: cls.segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount,
      sellOrderCount,
      mtf: isMtf ? { fundedAmount: effectiveFundedAmount!, daysHeld: effectiveDaysHeld, pledgeScrips: 1 } : null,
    },
    r,
  );
  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;
  // Short-open (sell-to-open, e.g. writing a CE/PE): the entry leg is the SELL side.
  const isShortOpen = isOpen && t.sellQty > t.buyQty;
  const entryPrice = isShortOpen ? t.avgSellPrice : t.avgBuyPrice;
  // Risk = explicit amount, else derived from SL (|entry − SL| × qty), else the cap.
  // D1 (v4.4.0): the first two are the user's ('set'); the cap is THE resolver's
  // for this row's segment ('cap' — it follows every later cap edit), and no cap
  // configured means no risk and no R rather than a literal ₹9,500.
  const riskQty = Math.abs(isOpen ? t.buyQty - t.sellQty : t.buyQty) || t.buyQty;
  const typedRisk =
    fields.riskAmount ??
    (fields.slPlanned != null && riskQty > 0
      ? Math.round(Math.abs(entryPrice - fields.slPlanned) * riskQty * 100) / 100
      : null);
  const riskAmount = typedRisk ?? resolvePerTradeCap(defaults.capRows, cls.bucket, cls.segment);
  const riskSource: RiskSource = typedRisk != null ? "set" : "cap";

  const row = db
    .insert(tradesTable)
    .values({
      accountId,
      broker: t.broker,
      bucket: cls.bucket,
      segment: cls.segment,
      instrumentType: cls.instrumentType,
      exchange: cls.exchange,
      symbol: cls.symbol,
      tradingsymbol: t.tradingsymbol,
      isin: t.isin,
      expiry: cls.expiry,
      strike: cls.strike,
      optionType: cls.optionType,
      lotSize: fields.lotSize ?? null,
      buyQty: t.buyQty,
      avgBuyPrice: t.avgBuyPrice,
      buyValue: t.buyValue,
      sellQty: t.sellQty,
      avgSellPrice: t.avgSellPrice,
      sellValue: t.sellValue,
      closingPrice: t.closingPrice,
      buyDate: normalizeDate(t.buyDate),
      sellDate: normalizeDate(t.sellDate),
      grossPnl: t.grossPnl,
      chargesTotal: charges.total,
      netPnl,
      unrealisedPnl: t.unrealisedPnl,
      realisedPct: t.buyValue > 0 && !isOpen ? Math.round((t.grossPnl / t.buyValue) * 10000) / 100 : null,
      isOpen,
      buyOrderCount,
      sellOrderCount,
      slPlanned: fields.slPlanned ?? null,
      trailingSl: fields.trailingSl ?? null,
      targetPlanned: fields.targetPlanned ?? null,
      riskAmount,
      rMultiple: capR(netPnl, riskAmount),
      riskSource,
      setupTag: fields.setupTag ?? null,
      notes: fields.notes ?? null,
      // v4.3.0 — the Signal book. An option only (the classifier's verdict, not
      // the form's claim), and null on an Add that recorded none: an empty
      // envelope would make the trade a signal trade with nothing in it.
      // NOTHING above this line changes because of it — a trade committed with
      // a signal stores identical money, charge, qty, dedup_hash and r_multiple
      // columns to the same trade committed without one.
      signalJson: cls.instrumentType === "option" ? fields.signalJson ?? null : null,
      ruleViolations: fields.ruleViolations && fields.ruleViolations.length ? fields.ruleViolations : null,
      brokerage: charges.brokerage,
      sttCtt: charges.sttCtt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      ipft: charges.ipft,
      gst: charges.gst,
      dpCharges: charges.dpCharges,
      mtfInterest: charges.mtfInterest,
      mtfFundedAmount: effectiveFundedAmount,
      pledgeCharges: charges.pledgeCharges,
      sourceFile: "manual",
      dedupHash: dedup,
    })
    .returning({ id: tradesTable.id })
    .get();

  const breaches = fields.ruleViolations && fields.ruleViolations.length ? fields.ruleViolations : null;
  recordAudit({
    entity: "trade",
    entityId: row!.id,
    action: "create",
    summary: `${cls.symbol} ${cls.segment} · ${isOpen ? "open" : "closed"} · net ${netPnl}${breaches ? ` · ⚠ ${breaches.length} limit breach${breaches.length === 1 ? "" : "es"}` : ""}`,
    // The audit records THAT a signal was recorded, not its levels — the trail
    // is a history of actions, and the envelope itself lives on the row.
    after: { symbol: cls.symbol, segment: cls.segment, buyQty: t.buyQty, sellQty: t.sellQty, netPnl, isOpen, ...(breaches ? { ruleViolations: breaches } : {}), ...(cls.instrumentType === "option" && fields.signalJson ? { signal: true } : {}) },
    source: "manual",
  });

  // Store the current MTM so an open position shows a live mark on the trackers.
  if (fields.currentPrice != null && fields.currentPrice > 0 && !isDerivativeInstrument(cls)) {
    // (Derivatives skipped: the premium would land under the underlying's
    // symbol and erase its cash mark — owner ruling, fix wave 3 audit.)
    // A typed door like the risk dialog and the paste: the number the user
    // typed is the day's mark, so it REPLACES the day's row (a bare insert
    // left it behind the automatic 15:31 row, unread — fix wave 3 audit).
    writeTypedMark({
      symbol: cls.symbol,
      tradingsymbol: t.tradingsymbol,
      price: fields.currentPrice,
      asOfDate: todayIstIso(),
    });
  }

  return { id: row!.id, duplicate: false };
}

/**
 * H1 (v4.3.0 wave 2H, M2 variant (c)) — `import_notes` without the Data
 * Quality join sentence. A writer that re-makes a joined lot's close (the trade
 * editor changing its exit leg, `closePosition`) calls this: the close is no
 * longer the join's, so `closedByStaleJoin` must stop exempting it. Every other
 * segment — each `dedup-alias:` above all, which is identity for re-import
 * dedup — is kept in order. A value without the sentence is returned as is.
 */
function withoutStaleCloseNote(importNotes: string | null): string | null {
  if (!importNotes || !importNotes.includes(STALE_CLOSE_NOTE)) return importNotes;
  const parts = importNotes
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && s !== STALE_CLOSE_NOTE);
  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Close an open position at an exit price: completes the missing leg (sell-to-close
 * for a long; buy-to-cover for a short sell-to-open, e.g. a written CE/PE), recomputes
 * the full (buy+sell) charges, MTF interest over the holding period, and realised net P&L.
 *
 * H1 (wave 2H) — a PARTLY closed row closes its REMAINING quantity by adding the
 * exit to the leg already on the closing side (a long's sell leg, a short's buy
 * leg): quantity and value are summed, the average is the weighted one (REAL),
 * and the exit is one more order. It used to REPLACE that leg with the remainder,
 * so 100 bought / 60 sold closed as 100 / 40 and a +5,200 trade booked −9,800.
 * A row with nothing on its closing side is written exactly as before.
 */
export function closePosition(
  tradeId: number,
  exitPrice: number,
  exitDate: string | null,
): { ok: boolean; message: string; code?: "STAGED" | "BAD_DATE" } {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, message: "Trade not found" };
  if (!t.isOpen) return { ok: false, message: "Position is already closed" };

  // L3 (v4.3.0 wave 2L) — an exit date that is not a real calendar day is refused
  // BEFORE anything is computed or written. It used to be stored as typed ('2026-02-31'),
  // and on an eq_mtf row it threw an unhandled SqliteError through the NaN day count.
  // A BLANK date still falls back to today below: that is an unanswered field, not an
  // unreadable one.
  const badDate = unreadableDate("exit date", exitDate);
  if (badDate) return { ok: false, code: "BAD_DATE", message: badDate };

  // D3 (v4.3.0 wave 2N, ipo#1) — the wave validated the date the user TYPES and
  // not the one the row STORES, so the same crash was still reachable on exactly
  // the legacy rows L3 was written for: `new Date(t.buyDate)` below is an Invalid
  // Date for a stored '9999-99-99' (NaN days → NaN charges → the NOT NULL write
  // failure, a 500 rather than {ok:false}), and rolls a stored '2026-02-31'
  // forward to 3 March and bills MTF interest for a day the row does not state.
  // Refused before anything is computed or written, like every other bad day.
  const badStored = storedDateProblem(t);
  if (badStored) return { ok: false, code: "BAD_DATE", message: badStored };

  // R2-DQ N11 — a STAGED position (or any row holding trade_legs) is never
  // closed here. This writes the parent row only: no exit leg lands in
  // trade_legs, so the ladder still reads the position open beside a closed
  // parent (invariant 5), and the next ladder action rebuilds the parent from
  // its legs — re-opening it and erasing the realised P&L (measured
  // 2026-09-15). The ladder's own exit records the leg, prices each tranche
  // and keeps R frozen at the first entry (invariant 4). Nothing is written.
  // D5 (wave 2P): the ONE leg-count predicate (`hasLadder`, lib/queries/staged).
  if (hasLadder(t, tradeId)) {
    return {
      ok: false,
      code: "STAGED",
      message:
        "This is a staged position built from more than one fill, so the manual close is not used for it: its exit is booked on its own ladder in Trades, which records the exit fill and prices each tranche. Nothing was changed.",
    };
  }

  // Short (sell-to-open) has the open leg on sellQty with buyQty still 0 — closing
  // means BUYING to cover, not selling. Long (the common case) closes by selling.
  // H1 — the closing leg is the prior leg + the remainder × exit (an empty leg
  // keeps the pre-H1 write exactly). ONE helper, which the Trades close dialog's
  // live preview also reads, so the preview prices this write (seam S1).
  // Rupees at runtime; the column converts to paise (invariant 1), never here.
  // V4 — a closing leg gaining its first quantity with no stored count bills the
  // settings default, as updateManualTrade does (the preview route fills the same).
  const { rates, defaults } = loadRatesContext();
  const { isShort, closeQty, closeValue, closeAvg, closeOrderCount } = closingAggregate(t, exitPrice, defaults);
  const exitDateIso = normalizeDate(exitDate) ?? todayIstIso();

  const buyQty = isShort ? closeQty : t.buyQty;
  const avgBuyPrice = isShort ? closeAvg : t.avgBuyPrice;
  const buyValue = isShort ? closeValue : t.buyValue;
  const buyDate = isShort ? exitDateIso : t.buyDate;
  const buyOrderCount = isShort ? closeOrderCount : t.buyOrderCount;

  const sellQty = isShort ? t.sellQty : closeQty;
  const avgSellPrice = isShort ? t.avgSellPrice : closeAvg;
  const sellValue = isShort ? t.sellValue : closeValue;
  const sellDate = isShort ? t.sellDate : exitDateIso;
  const sellOrderCount = isShort ? t.sellOrderCount : closeOrderCount;

  // The COMPUTED dates, not the stale row: `t.sellDate` is null for an open long,
  // so pricing off `t` would charge the exit at the ENTRY date's epoch — the exact
  // inverse of pricingDate's own rule that the sell side dominates the bill.
  const onDate = pricingDate({ buyDate, sellDate }, todayIstIso());
  const r = ratesForTrade(
    rates,
    { broker: t.broker as Broker, segment: t.segment as Segment, exchange: t.exchange as Exchange, isin: t.isin, symbol: t.symbol },
    onDate,
    // Wave U — the plan of the account this row ALREADY belongs to (never the
    // selected one: a close from the All-accounts view prices the row's own
    // book), on the date this close is priced at.
    resolvePlan(planAccountOf(t.accountId), t.broker, onDate, rates),
  );

  // MTF interest over the holding period (buy → exit), if this is an MTF position.
  // MTF is equity-only (never a short-open segment), so buyDate is always the entry.
  // Reuse the fundedAmount locked in at entry (explicit or auto-estimated) — NEVER
  // recompute from the full buyValue, which would assume 100% broker financing and
  // overstate interest (a real bug fixed here: it previously did exactly that).
  let mtf: { fundedAmount: number; daysHeld: number; pledgeScrips: number } | null = null;
  // Q-A: what the close STORES back — the row keeps what it states, null included.
  const mtfFundedAmount: number | null = t.mtfFundedAmount;
  if (t.segment === "eq_mtf") {
    // V3 — a stored 0 is a STATED amount (all own capital) and is kept.
    // Q-A (owner ruling, wave 2N) — a NULL stays null: the close used to
    // PERSIST `defaultMtfFundedAmount(buyValue, margin_config)` into
    // `mtf_funded_amount`, so closing a row the journal never priced stated a
    // margin-default figure as the trade's own and billed interest on it for
    // the whole holding period. Nothing is estimated; the column keeps its
    // null, and the close bills NO interest for it (the engine is handed 0
    // below). The close dialog's preview reads it the same way.
    const funded = t.mtfFundedAmount;
    // Interest accrues from T+1 settlement (day after buy) through the day
    // BEFORE sale proceeds settle — which works out to exactly (sellDate −
    // buyDate) calendar days, confirmed against Dhan's own MTF documentation.
    // No extra "-1": that undercounted every position by one day of interest.
    // D3 — through the same calendar the refusal above read it by: a day-first
    // '15-07-2026' is a real day the row states, and `new Date` cannot read it.
    // D7 (wave 2P) — the ONE day count (`calendarDaysHeld`, lib/domain/trading-day)
    // the three writers, the ladder, the one-click close and both dialogs share.
    const days = calendarDaysHeld(t.buyDate, exitDateIso);
    // Q-A: interest 0 on an unstated principal — AND NO PLEDGE CHARGE EITHER, which
    // is the RECORDED DEVIATION (DECISIONS 2026-09-16, wave 2N; D12, wave 2O). This
    // comment used to claim the pledge fee "still billed", because pledging the
    // scrip is a fact of the MTF product independent of how the position was split.
    // The code does not do that: `lib/engine/charges.ts:106` gates interest AND
    // pledge on the same `input.mtf.fundedAmount > 0`, so handing it 0 bills neither
    // and an unpriced row is billed IDENTICALLY to a stated 0 (probed: [null, 0, 0]).
    // Billing pledge alone would need an engine change, which was not made.
    mtf = { fundedAmount: funded ?? 0, daysHeld: days, pledgeScrips: 1 };
  }

  const charges = computeCharges(
    {
      segment: t.segment as Segment,
      buyValue,
      sellValue,
      buyQty,
      sellQty,
      buyOrderCount,
      sellOrderCount,
      mtf,
    },
    r,
  );
  const grossPnl = Math.round((sellValue - buyValue) * 100) / 100;
  const netPnl = Math.round((grossPnl - charges.total) * 100) / 100;
  const realisedPct = buyValue > 0 ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
  // D1 (v4.4.0): the row keeps its own risk source; a 'cap' row re-reads today's cap.
  const kept = keptRisk(t, t.bucket, t.segment, defaults.capRows);
  const rMultiple = kept.followsCap
    ? capR(netPnl, kept.riskAmount)
    : t.riskAmount && t.riskAmount > 0 ? Math.round((netPnl / t.riskAmount) * 100) / 100 : t.rMultiple;

  db.update(tradesTable)
    .set({
      ...(kept.followsCap ? { riskAmount: kept.riskAmount } : {}),
      buyQty,
      avgBuyPrice,
      buyValue,
      buyDate,
      buyOrderCount,
      sellQty,
      avgSellPrice,
      sellValue,
      sellDate,
      sellOrderCount,
      isOpen: false,
      unrealisedPnl: 0,
      grossPnl,
      chargesTotal: charges.total,
      netPnl,
      realisedPct,
      rMultiple,
      // H1 — this close is made here, not by the Data Quality join (M2 (c)).
      importNotes: withoutStaleCloseNote(t.importNotes),
      brokerage: charges.brokerage,
      sttCtt: charges.sttCtt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      ipft: charges.ipft,
      gst: charges.gst,
      dpCharges: charges.dpCharges,
      mtfInterest: charges.mtfInterest,
      mtfFundedAmount,
      pledgeCharges: charges.pledgeCharges,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(tradesTable.id, tradeId))
    .run();

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "close",
    summary: `${t.symbol} ${isShort ? "covered" : "closed"} @ ${exitPrice} · net ${netPnl}`,
    before: { isOpen: true, buyQty: t.buyQty, sellQty: t.sellQty, netPnl: t.netPnl },
    after: { isOpen: false, buyQty, sellQty, netPnl },
  });

  return { ok: true, message: "Position closed." };
}

/**
 * Why `closeStaleLot` refused — the stable wire value the route maps to an HTTP
 * status. Every refusal changes nothing.
 */
export type StaleCloseCode =
  | "BAD_DATE"
  | "NOT_FOUND"
  | "OTHER_ACCOUNT"
  | "NO_PAIR"
  | "PARTIAL"
  | "STAGED"
  | "AMBIGUOUS"
  | "FILLS"
  | "JOURNAL"
  | "DELETE_FAILED";

export interface StaleCloseResult {
  ok: boolean;
  message: string;
  code?: StaleCloseCode;
}

/** The ten stored charge components, in the order the row lists them. */
const STALE_CHARGE_PARTS = [
  "brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty",
  "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges",
] as const;
type StaleChargeParts = Record<(typeof STALE_CHARGE_PARTS)[number], number>;

/** Thrown inside the transaction to roll it back with a sentence for the user. */
class StaleCloseAbort extends Error {}

/**
 * R26 (v4.3.0; ruling R10 half b, 06-ANSWERS:224 — with auto-close OFF,
 * 06-ANSWERS:353, the only remedy) — close an open lot L with the
 * opposite-side row S the book already stored for it, from Data Quality.
 *
 * "One click" is a button plus a confirm, and needs no user entry: L closes at
 * S's stored price and quantity. The ONE thing confirmed is the date — a
 * 4.2.0 Dhan sale row stored `sell_date` NULL, and a close date sets the
 * charge epoch, the holding period and MTF interest, so it is never invented
 * (invariant 6): `exitDate` is required, and the caller pre-fills it with S's
 * own date or the IST day S was pulled.
 *
 * In ONE transaction:
 *  1. the pair is RE-DERIVED from the book (`staleOpenPairs`, the same pure
 *     rule the screen used) and refused unless it still holds one-to-one;
 *     a staged lot (or any lot with `trade_legs`) is refused (STAGED); a pair
 *     in a book holding a closed lot entered on or before the sale is refused
 *     (AMBIGUOUS, R2-DQ N7/N8); a sale recorded in several fills (staged, or
 *     with `trade_legs`) is refused (FILLS, R2-DQ N10);
 *  2. S is refused when it carries the user's own journal fields (notes,
 *     tags, a playbook, an exit reason, attachments) — removing it would
 *     remove them, and merging two rows' journals is not what the user wrote;
 *  3. CHARGES: each side keeps the bill it STATES — L's stored charges plus
 *     S's stored charges. A side that states none is priced from
 *     `charge_config` (invariant 3) on its own date; never both for one side.
 *     MTF interest (and pledge) is re-priced to the confirmed date exactly as
 *     `closePosition` prices it, replacing whatever either side carried;
 *  4. S goes through `deleteTradesByIds` — recovery snapshot, audit row, legs
 *     and attachments with it (there are none: step 2) — and L records S's
 *     hash as an alias (`withStaleCloseNote`), so re-pulling S is a duplicate;
 *  5. L is audited with action "close".
 *
 * Money is rupees here; the paise conversion is the column's (invariant 1).
 * The write lands on L's own account, never the All-accounts view (invariant
 * 9), and is refused when a different book is selected (invariant 8).
 *
 * `deleteTradesByIds` writes its snapshot file before its (nested, savepoint)
 * transaction. If the lot's update below it then threw, the outer rollback
 * would put S back and leave that snapshot behind — an orphan whose restore
 * skips the row, because its id is taken. Nothing is lost either way.
 */
export type UnCloseCode = "NOT_FOUND" | "OTHER_ACCOUNT" | "SHAPE" | "STAGED" | "JOURNAL";

/**
 * W3 (design review revision 10) — UNDO one import auto-close, exactly.
 *
 * The applier turns one execution and the lots it consumed into a new set of
 * rows; this turns them back. It is the door every refusal in W3 points at: a
 * delete or a merge that would break a close is refused and the user is sent
 * here, rather than being allowed to leave half a close behind.
 *
 * THE INVERSE, PER SHAPE (the three the applier can produce):
 *
 *  • PARTIAL — a reduced lot (open, `closed-by:H`) plus a slice (closed). The
 *    lot gets back the slice's OPEN leg (quantity and value) and the slice's
 *    bill MINUS the execution's half of it (`exec-bill:`), which is
 *    `splitByRemainder`'s inverse: keep + slice = the total that was split. The
 *    slice row goes.
 *  • WHOLE — the lot row itself was converted (closed, holding `dedup-alias:H`).
 *    Its closing leg and the execution's half of its bill are subtracted and it
 *    reads open again; no slice exists to remove.
 *  • REMAINDER — what an execution had left over (open, holds H, frozen by
 *    `PARTIAL_CLOSE_NOTE`). It is folded into the reinstated execution row and
 *    removed, so the execution comes back as ONE row, the way the file stated
 *    it.
 *
 * Then the execution is reinstated as one ORDINARY row: its original hash, the
 * bill it stated (the sum of the halves recorded on the pieces), its own dates
 * and its own single side. One audit row per row touched, all in ONE
 * transaction — a half-undone close is worse than either state.
 *
 * Money is rupees here (invariant 1). The write lands on the rows' own account
 * and is refused from another book (invariant 8); account 0 is a view and can
 * never be a subject (invariant 9).
 */
export function unCloseExecution(
  accountId: number,
  broker: string,
  execHash: string,
): { ok: boolean; message: string; code?: UnCloseCode } {
  const hash = (execHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) return { ok: false, code: "NOT_FOUND", message: "That is not a trade identity. Nothing was changed." };
  if (!(accountId > 0)) return { ok: false, code: "OTHER_ACCOUNT", message: "Choose the account this position is in first. Nothing was changed." };
  const view = getSelectedAccountId();
  if (view > 0 && view !== accountId) {
    return { ok: false, code: "OTHER_ACCOUNT", message: "Those rows belong to a different account from the one you are viewing. Nothing was changed." };
  }

  return db.transaction((tx): { ok: boolean; message: string; code?: UnCloseCode } => {
    const book = tx
      .select()
      .from(tradesTable)
      .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, broker)))
      .all();
    const touched = book.filter(
      (r) => r.dedupHash === hash || closedByHash(r.importNotes) === hash || (r.importNotes ?? "").includes(`${DEDUP_ALIAS_PREFIX}${hash}`),
    );
    if (touched.length === 0) {
      return { ok: false, code: "NOT_FOUND", message: "Nothing in this account was closed by that execution. Nothing was changed." };
    }
    const notes = (r: typeof tradesTable.$inferSelect) => r.importNotes ?? "";
    const converted = touched.find((r) => !r.isOpen && r.dedupHash !== hash && notes(r).includes(`${DEDUP_ALIAS_PREFIX}${hash}`));
    const slices = touched.filter((r) => !r.isOpen && r !== converted && notes(r).includes(AUTO_CLOSE_NOTE));
    // What the execution had LEFT OVER, in both shapes the applier writes it:
    // as the holder of its own scaled hash (`PARTIAL_CLOSE_NOTE`, when no lot
    // was consumed whole), and as a plain leftover carrying only the thread back
    // (`closed-by:`, when a lot WAS consumed whole and took the hash). Reading
    // the sentence alone left that second row in the book, so a sale of 100 that
    // closed a lot of 60 came back as 60 plus a stray 40 — not as the one row
    // the file stated.
    const remainder = touched.find(
      (r) => r.isOpen && !notes(r).includes(AUTO_CLOSE_NOTE) && (notes(r).includes(PARTIAL_CLOSE_NOTE) || closedByHash(r.importNotes) === hash),
    );
    const reduced = touched.filter((r) => r.isOpen && r !== remainder && notes(r).includes(AUTO_CLOSE_NOTE));
    if (!converted && slices.length === 0) {
      // Nothing CLOSED answers to that execution — the commonest reason being
      // that it has already been un-closed and the row standing under the hash
      // is the reinstated execution itself. Undoing twice is not a broken shape;
      // it is nothing left to undo, and the second press says so (idempotence).
      return { ok: false, code: "NOT_FOUND", message: "Nothing in this account was closed by that execution. Nothing was changed." };
    }
    // A ladder is never rebuilt from here (invariant 4/5), and a piece the user
    // has written on is never deleted by a machine.
    const laddered = tradeIdsWithLegs(tx as unknown as TxLike, touched.map((r) => r.id));
    for (const r of touched) {
      if (r.staged || laddered.has(r.id)) {
        return { ok: false, code: "STAGED", message: `${r.tradingsymbol} is a staged position built from more than one fill; its exit is booked on its own ladder in Trades. Nothing was changed.` };
      }
    }
    for (const r of [...slices, ...(remainder ? [remainder] : [])]) {
      const journal = saleJournalFields(r, { attachments: tx.select({ id: tradeAttachments.id }).from(tradeAttachments).where(eq(tradeAttachments.tradeId, r.id)).all().length });
      if (journal.length > 0) {
        return { ok: false, code: "JOURNAL", message: `Nothing was changed. ${staleJournalNote(journal, "long")}` };
      }
    }

    const billOf = (r: typeof tradesTable.$inferSelect) => partsOf(r as unknown as StaleChargeParts);
    const zero = () => Object.fromEntries(STALE_CHARGE_PARTS.map((k) => [k, 0])) as StaleChargeParts;
    const add = (a: StaleChargeParts, b: StaleChargeParts, sign = 1) => {
      const out = {} as StaleChargeParts;
      for (const k of STALE_CHARGE_PARTS) out[k] = r2m((a[k] ?? 0) + sign * (b[k] ?? 0));
      return out;
    };
    const sum = (p: StaleChargeParts) => r2m(STALE_CHARGE_PARTS.reduce((s, k) => s + (p[k] ?? 0), 0));

    // What the execution stated: the halves recorded on every piece it made.
    let execParts = zero();
    let execTotal = 0;
    let execQty = 0;
    let execValue = 0;
    let execPrice = 0;
    let execDate: string | null = null;
    let execSide: "buy" | "sell" = "sell";
    const pieces = [...(converted ? [converted] : []), ...slices];
    for (const p of pieces) {
      const bill = execBillFromNotes(p.importNotes);
      if (!bill) {
        return { ok: false, code: "SHAPE", message: `${p.tradingsymbol} does not record what the closing execution itself was charged, so it cannot be undone without inventing that figure. Nothing was changed.` };
      }
      execParts = add(execParts, bill as unknown as StaleChargeParts);
      execTotal = r2m(execTotal + bill.total);
      // The piece's CLOSING leg is the execution's; the other leg is the lot's.
      // A closed piece states its direction through its dates: the exit is the
      // later leg (the ONE definition, `readsLong` in close-open-lots).
      const long = p.buyDate != null && p.sellDate != null ? p.buyDate <= p.sellDate : p.buyQty > 0;
      const qty = long ? p.sellQty : p.buyQty;
      execSide = long ? "sell" : "buy";
      execPrice = long ? p.avgSellPrice : p.avgBuyPrice;
      execDate = long ? p.sellDate : p.buyDate;
      execQty = r2m(execQty + qty);
      execValue = r2m(execValue + (long ? p.sellValue : p.buyValue));
    }
    if (remainder) {
      const rb = execBillFromNotes(remainder.importNotes);
      const rbParts = rb ? (rb as unknown as StaleChargeParts) : billOf(remainder);
      execParts = add(execParts, rbParts);
      execTotal = r2m(execTotal + (rb ? rb.total : remainder.chargesTotal));
      const sells = remainder.sellQty > 0;
      execQty = r2m(execQty + (sells ? remainder.sellQty : remainder.buyQty));
      execValue = r2m(execValue + (sells ? remainder.sellValue : remainder.buyValue));
      execPrice = sells ? remainder.avgSellPrice : remainder.avgBuyPrice;
      execDate = sells ? remainder.sellDate : remainder.buyDate;
      execSide = sells ? "sell" : "buy";
    }

    const model = pieces[0]!;
    const audits: { id: number; action: "update" | "delete" | "create"; summary: string; before?: Record<string, unknown>; after?: Record<string, unknown> }[] = [];

    // 1 — every reduced lot gets its quantity and its own half of the bill back.
    for (const slice of slices) {
      const bill = execBillFromNotes(slice.importNotes)!;
      const long = slice.buyDate != null && slice.sellDate != null ? slice.buyDate <= slice.sellDate : slice.buyQty > 0;
      const openQty = long ? slice.buyQty : slice.sellQty;
      const openValue = long ? slice.buyValue : slice.sellValue;
      const openPrice = long ? slice.avgBuyPrice : slice.avgSellPrice;
      const openDate = long ? slice.buyDate : slice.sellDate;
      const lot = reduced.find(
        (r) =>
          r.tradingsymbol.trim().toUpperCase() === slice.tradingsymbol.trim().toUpperCase() &&
          r.segment === slice.segment &&
          r.exchange === slice.exchange &&
          (long ? r.avgBuyPrice === openPrice && r.buyDate === openDate : r.avgSellPrice === openPrice && r.sellDate === openDate),
      );
      if (!lot) {
        return { ok: false, code: "SHAPE", message: `The position ${slice.tradingsymbol} was closed against is no longer in this account, so the close cannot be undone. Nothing was changed.` };
      }
      const lotParts = add(billOf(lot), add(billOf(slice), bill as unknown as StaleChargeParts, -1));
      const lotTotal = sum(lotParts);
      const before = { buyQty: lot.buyQty, sellQty: lot.sellQty, chargesTotal: lot.chargesTotal, netPnl: lot.netPnl, importNotes: lot.importNotes };
      const patch = {
        ...(long
          ? { buyQty: r2m(lot.buyQty + openQty), buyValue: r2m(lot.buyValue + openValue) }
          : { sellQty: r2m(lot.sellQty + openQty), sellValue: r2m(lot.sellValue + openValue) }),
        chargesTotal: lotTotal,
        grossPnl: 0,
        netPnl: r2m(0 - lotTotal),
        isOpen: true,
        ...lotParts,
        importNotes: withoutAutoCloseNotes(lot.importNotes),
        updatedAt: sql`(datetime('now'))`,
      };
      tx.update(tradesTable).set(patch).where(eq(tradesTable.id, lot.id)).run();
      Object.assign(lot, patch, { updatedAt: lot.updatedAt });
      audits.push({ id: lot.id, action: "update", summary: `${lot.symbol} un-closed — ${openQty} put back on the position`, before, after: { buyQty: lot.buyQty, sellQty: lot.sellQty, chargesTotal: lotTotal, netPnl: patch.netPnl, importNotes: patch.importNotes } });
      tx.delete(tradesTable).where(eq(tradesTable.id, slice.id)).run();
      audits.push({ id: slice.id, action: "delete", summary: `${slice.symbol} — the closed row this un-close replaced with its two originals`, before: slice as unknown as Record<string, unknown> });
    }

    // 2 — a lot consumed WHOLE reads open again; there is no slice to remove.
    if (converted) {
      const bill = execBillFromNotes(converted.importNotes)!;
      const long = converted.buyDate != null && converted.sellDate != null ? converted.buyDate <= converted.sellDate : converted.buyQty > 0;
      const lotParts = add(billOf(converted), bill as unknown as StaleChargeParts, -1);
      const lotTotal = sum(lotParts);
      const before = { isOpen: false, buyQty: converted.buyQty, sellQty: converted.sellQty, chargesTotal: converted.chargesTotal, netPnl: converted.netPnl, importNotes: converted.importNotes };
      const patch = {
        ...(long
          ? { sellQty: 0, sellValue: 0, avgSellPrice: 0, sellDate: null }
          : { buyQty: 0, buyValue: 0, avgBuyPrice: 0, buyDate: null }),
        isOpen: true,
        grossPnl: 0,
        unrealisedPnl: 0,
        realisedPct: null,
        chargesTotal: lotTotal,
        netPnl: r2m(0 - lotTotal),
        // The R of the row it becomes, by the ONE rule every writer uses
        // (`capR(netPnl, riskAmount)`): an open lot carries a number, and
        // blanking it left the re-opened position reading "—" where it had read
        // an R before the import ever closed it.
        rMultiple: capR(r2m(0 - lotTotal), converted.riskAmount),
        ...lotParts,
        importNotes: withoutAutoCloseNotes(converted.importNotes),
        updatedAt: sql`(datetime('now'))`,
      };
      tx.update(tradesTable).set(patch).where(eq(tradesTable.id, converted.id)).run();
      audits.push({ id: converted.id, action: "update", summary: `${converted.symbol} un-closed — the position reads open again`, before, after: { isOpen: true, buyQty: long ? converted.buyQty : 0, sellQty: long ? 0 : converted.sellQty, chargesTotal: lotTotal, netPnl: patch.netPnl, importNotes: patch.importNotes } });
    }

    // 3 — the execution comes back as ONE ordinary row, its own hash and bill.
    if (remainder) {
      tx.delete(tradesTable).where(eq(tradesTable.id, remainder.id)).run();
      audits.push({ id: remainder.id, action: "delete", summary: `${remainder.symbol} — what was left of the execution, folded back into it`, before: remainder as unknown as Record<string, unknown> });
    }
    const sells = execSide === "sell";
    const restored = tx
      .insert(tradesTable)
      .values({
        accountId,
        broker,
        bucket: model.bucket,
        segment: model.segment,
        instrumentType: model.instrumentType,
        exchange: model.exchange,
        symbol: model.symbol,
        tradingsymbol: model.tradingsymbol,
        isin: model.isin,
        expiry: model.expiry,
        strike: model.strike,
        optionType: model.optionType,
        buyQty: sells ? 0 : execQty,
        avgBuyPrice: sells ? 0 : execPrice,
        buyValue: sells ? 0 : execValue,
        sellQty: sells ? execQty : 0,
        avgSellPrice: sells ? execPrice : 0,
        sellValue: sells ? execValue : 0,
        buyDate: sells ? null : execDate,
        sellDate: sells ? execDate : null,
        grossPnl: 0,
        chargesTotal: execTotal,
        netPnl: r2m(0 - execTotal),
        unrealisedPnl: 0,
        isOpen: true,
        buyOrderCount: sells ? 0 : 1,
        sellOrderCount: sells ? 1 : 0,
        riskAmount: model.riskAmount,
        riskSource: model.riskSource,
        // R by the one rule every writer uses — a row that states a risk states
        // its R (I7, tests/harness-book-sequences.test.ts).
        rMultiple: capR(r2m(0 - execTotal), model.riskAmount),
        ...execParts,
        sourceFile: remainder?.sourceFile ?? model.sourceFile,
        importBatchId: remainder?.importBatchId ?? model.importBatchId,
        dedupHash: hash,
        staged: false,
        // A sale with no purchase beside it is exactly what it was before the
        // close: its basis is the book's question, not this function's.
        acquisition: sells ? "unknown" : null,
        importNotes: remainder ? withoutAutoCloseNotes(remainder.importNotes) : null,
      })
      .returning({ id: tradesTable.id })
      .get();
    audits.push({
      id: restored!.id,
      action: "create",
      summary: `${model.symbol} — the closing execution reinstated as its own row (${execQty} @ ${execPrice}), charges ${execTotal}`,
      after: { qty: execQty, price: execPrice, chargesTotal: execTotal, dedupHash: hash },
    });

    for (const a of audits) {
      recordAudit({ entity: "trade", entityId: a.id, action: a.action, summary: a.summary, before: a.before, after: a.after, source: "ui" });
    }
    return {
      ok: true,
      message: `Un-closed. ${model.tradingsymbol}: the position is open again and the ${sells ? "sale" : "purchase"} of ${execQty} is back as its own row.`,
    };
  });
}

export function closeStaleLot(lotId: number, saleId: number, exitDateIn: string | null): StaleCloseResult {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const raw = typeof exitDateIn === "string" ? exitDateIn.trim() : "";
  const exitDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
  if (!exitDate) {
    return { ok: false, code: "BAD_DATE", message: "Confirm the date of the recorded sale (YYYY-MM-DD) first. Nothing was changed." };
  }
  if (exitDate > todayIstIso()) {
    return { ok: false, code: "BAD_DATE", message: `${exitDate} is in the future. Nothing was changed.` };
  }
  const view = getSelectedAccountId();

  try {
    return db.transaction((tx): StaleCloseResult => {
      const lot = tx.select().from(tradesTable).where(eq(tradesTable.id, lotId)).get();
      const sale = tx.select().from(tradesTable).where(eq(tradesTable.id, saleId)).get();
      if (!lot || !sale) {
        return { ok: false, code: "NOT_FOUND", message: "That position or its recorded sale is no longer in the journal. Nothing was changed." };
      }
      if (lot.accountId <= 0 || (view > 0 && view !== lot.accountId)) {
        return { ok: false, code: "OTHER_ACCOUNT", message: "That position belongs to a different account from the one you are viewing. Nothing was changed." };
      }
      // v4.4.0 fix list (wave 2P's recorded unreadable-lot finding) — the join
      // prices from the LOT's stored dates (the rate epoch, the MTF day count),
      // so a lot stored as '2026-02-31' or '9999-99-99' is refused here in the
      // sentence the other three stored-date writers state, before the pair is
      // re-derived: the pure rule reads only the ISO shape, so the first joined
      // (0 days of interest from a day the row does not state) and the second
      // was refused NO_PAIR, a reason that is not the reason. Nothing is written.
      const badStored = storedDateProblem(lot);
      if (badStored) return { ok: false, code: "BAD_DATE", message: badStored };

      // 1 — re-derive, over the lot's own book only (pairs never cross books).
      const sym = lot.tradingsymbol.trim().toUpperCase();
      const book = tx
        .select()
        .from(tradesTable)
        .where(and(eq(tradesTable.accountId, lot.accountId), eq(tradesTable.broker, lot.broker), eq(tradesTable.segment, lot.segment), eq(tradesTable.exchange, lot.exchange)))
        .all()
        .filter((r) => r.tradingsymbol.trim().toUpperCase() === sym);
      const pair = staleOpenPairs(book).find((p) => p.lotId === lot.id && p.saleId === sale.id);
      if (!pair) {
        return { ok: false, code: "NO_PAIR", message: "These two rows no longer pair — the position is closed, the sale has gone, or an older position now takes the sale first. Nothing was changed." };
      }
      // W2-FIXD2 — a STAGED lot is never joined here, read from the stored row
      // and its ladder rather than from the pure rule (defence in depth). This
      // join writes the parent row only: no exit leg lands in trade_legs, so
      // the ladder still reads the position open beside a closed parent
      // (invariant 5), and the next rebuild of the ladder re-opens the parent
      // with the sale row already removed (measured 2026-09-15). The ladder's
      // own exit prices each tranche and keeps R frozen at the first entry
      // (invariant 4).
      const lotLegs = tx.select({ id: tradeLegs.id }).from(tradeLegs).where(eq(tradeLegs.tradeId, lot.id)).all().length;
      if (lot.staged || lotLegs > 0) {
        const what = pair.side === "long" ? "sale" : "purchase";
        return {
          ok: false,
          code: "STAGED",
          message: `This is a staged position built from more than one fill, so it is not joined with the recorded ${what} in one step: its exit is booked on its own ladder in Trades, which prices each tranche. Nothing was changed.`,
        };
      }
      // R2-DQ N7/N8 — a closed lot in this book, entered on or before the sale,
      // may already have taken it (a ladder exit, the manual close): joining
      // would count the sale twice. Listed for review, never joined here.
      if (pair.ambiguous) {
        return { ok: false, code: "AMBIGUOUS", message: `${staleAmbiguousNote(pair)} Nothing was changed.` };
      }
      // R2-DQ N10 — a sale recorded in several fills (staged, or holding
      // trade_legs) is never joined: the join removes the row with its fills.
      // Read from the stored row, not only the pure rule (defence in depth).
      const saleLegs = tx.select({ id: tradeLegs.id }).from(tradeLegs).where(eq(tradeLegs.tradeId, sale.id)).all().length;
      if (sale.staged || saleLegs > 0) {
        return { ok: false, code: "FILLS", message: `Nothing was changed. ${staleFillsNote(pair.side)}` };
      }
      if (!pair.oneClick) {
        return { ok: false, code: "PARTIAL", message: `The recorded sale is ${pair.saleQty} and the position holds ${pair.lotQty}, so they are not joined in one step. Nothing was changed.` };
      }
      if (exitDate < pair.lotDate) {
        return { ok: false, code: "BAD_DATE", message: `${exitDate} is before the position was opened (${pair.lotDate}). Nothing was changed.` };
      }

      // 2 — the user's own record on S is never deleted by a data fix.
      const attachments = tx.select({ id: tradeAttachments.id }).from(tradeAttachments).where(eq(tradeAttachments.tradeId, sale.id)).all().length;
      const journal = saleJournalFields(sale, { attachments });
      if (journal.length > 0) {
        return { ok: false, code: "JOURNAL", message: `Nothing was changed. ${staleJournalNote(journal, pair.side)}` };
      }

      // 3 — the joined row's legs.
      const isShort = pair.side === "short";
      const buyQty = isShort ? lot.buyQty + sale.buyQty : lot.buyQty;
      const buyValue = isShort ? r2(lot.buyValue + sale.buyValue) : lot.buyValue;
      const avgBuyPrice = isShort ? (lot.buyQty > 0 ? buyValue / buyQty : sale.avgBuyPrice) : lot.avgBuyPrice;
      const buyDate = isShort ? exitDate : lot.buyDate;
      const buyOrderCount = isShort ? (lot.buyQty > 0 ? lot.buyOrderCount : 0) + (sale.buyOrderCount || 1) : lot.buyOrderCount;
      const sellQty = isShort ? lot.sellQty : lot.sellQty + sale.sellQty;
      const sellValue = isShort ? lot.sellValue : r2(lot.sellValue + sale.sellValue);
      const avgSellPrice = isShort ? lot.avgSellPrice : lot.sellQty > 0 ? sellValue / sellQty : sale.avgSellPrice;
      const sellDate = isShort ? lot.sellDate : exitDate;
      const sellOrderCount = isShort ? lot.sellOrderCount : (lot.sellQty > 0 ? lot.sellOrderCount : 0) + (sale.sellOrderCount || 1);
      if (Math.abs(buyQty - sellQty) > 1e-9) {
        return { ok: false, code: "NO_PAIR", message: "The joined quantities would not balance. Nothing was changed." };
      }

      // 3 — charges: the bill each side STATES, else charge_config for that side alone.
      const { rates, defaults } = loadRatesContext();
      // Wave U — the plan of the account the LOT belongs to (the sale is joined
      // into it), resolved on each day this helper is asked about.
      const lotPlanAccount = planAccountOf(lot.accountId);
      const ratesOn = (day: string) =>
        ratesForTrade(
          rates,
          { broker: lot.broker as Broker, segment: lot.segment as Segment, exchange: lot.exchange as Exchange, isin: lot.isin, symbol: lot.symbol },
          day,
          resolvePlan(lotPlanAccount, lot.broker, day, rates),
        );
      // R3 — the ONE stated-bill rule, shared with the W2a applier so the two
      // doors onto "this lot was closed by that execution" can never price the
      // same pair differently (`statedOrPricedCharges`, module level).
      const side = (
        row: typeof lot,
        leg: { buyValue: number; sellValue: number; buyQty: number; sellQty: number; buyOrderCount: number; sellOrderCount: number },
        day: string,
      ): { parts: StaleChargeParts; total: number } =>
        statedOrPricedCharges(row as unknown as StaleChargeParts & { chargesTotal: number }, leg, lot.segment as Segment, day, ratesOn);
      const lotSide = side(
        lot,
        { buyValue: lot.buyValue, sellValue: lot.sellValue, buyQty: lot.buyQty, sellQty: lot.sellQty, buyOrderCount: lot.buyOrderCount, sellOrderCount: lot.sellOrderCount },
        pricingDate(lot, exitDate),
      );
      const saleSide = side(
        sale,
        isShort
          ? { buyValue: sale.buyValue, sellValue: 0, buyQty: sale.buyQty, sellQty: 0, buyOrderCount: sale.buyOrderCount || 1, sellOrderCount: 0 }
          : { buyValue: 0, sellValue: sale.sellValue, buyQty: 0, sellQty: sale.sellQty, buyOrderCount: 0, sellOrderCount: sale.sellOrderCount || 1 },
        exitDate,
      );
      const parts = {} as StaleChargeParts;
      for (const k of STALE_CHARGE_PARTS) parts[k] = r2(lotSide.parts[k] + saleSide.parts[k]);
      let chargesTotal = r2(lotSide.total + saleSide.total);

      // MTF interest over the holding period (buy → the CONFIRMED date), with
      // closePosition's funded amount and day count. It REPLACES what either
      // side carried (the daily accrual writes interest-to-today onto an open
      // lot), and so does the pledge fee with the GST levied on it.
      // Q-A: the one-click close stores what the lot states, null included.
      const mtfFundedAmount = lot.mtfFundedAmount;
      if (lot.segment === "eq_mtf") {
        const r = ratesOn(exitDate);
        // V3: a stored 0 is kept. Q-A (wave 2N): so is a NULL — the FOURTH copy
        // of this rule. Left estimating, the Data Quality one-click close would
        // write a margin-default amount and bill interest on it for a row the
        // manual close beside it leaves null and bills 0 for: two doors, one
        // row, two answers.
        const funded = lot.mtfFundedAmount;
        // D7 (wave 2P) — the ONE day count; a lot whose stored buy date is
        // whitespace counts 0 days here as it does in `closePosition`, rather than
        // NaN into the engine and a NOT NULL throw out of the one-click close.
        const days = calendarDaysHeld(lot.buyDate, exitDate);
        const m = computeCharges(
          { segment: "eq_mtf", buyValue: 0, sellValue: 0, buyQty: 0, sellQty: 0, buyOrderCount: 0, sellOrderCount: 0, mtf: { fundedAmount: funded ?? 0, daysHeld: days, pledgeScrips: 1 } },
          r,
        );
        const carriedPledge = r2(lotSide.parts.pledgeCharges + saleSide.parts.pledgeCharges);
        const carriedPledgeGst = r2(r.gstPct * carriedPledge);
        chargesTotal = r2(chargesTotal - parts.mtfInterest - carriedPledge - carriedPledgeGst + m.total);
        parts.gst = r2(parts.gst - carriedPledgeGst + m.gst);
        parts.mtfInterest = m.mtfInterest;
        parts.pledgeCharges = m.pledgeCharges;
      }

      const grossPnl = r2(sellValue - buyValue);
      const netPnl = r2(grossPnl - chargesTotal);
      const realisedPct = buyValue > 0 ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
      // D1 (v4.4.0): the lot keeps ITS risk source (the sale's leaves with the
      // sale row); a 'cap' lot re-reads today's cap for its own segment.
      const kept = keptRisk(lot, lot.bucket, lot.segment, defaults.capRows);
      const rMultiple = kept.followsCap
        ? capR(netPnl, kept.riskAmount)
        : lot.riskAmount && lot.riskAmount > 0 ? Math.round((netPnl / lot.riskAmount) * 100) / 100 : lot.rMultiple;
      const importNotes = withStaleCloseNote(lot.importNotes, sale.dedupHash);
      const what = isShort ? "purchase" : "sale";

      // 4 — S leaves through the one delete path (snapshot + audit).
      const del = deleteTradesByIds([sale.id], `joined to trade #${lot.id} (${lot.tradingsymbol}) as its recorded ${what} — Data Quality`, "data-quality");
      if (!del.ok) throw new StaleCloseAbort(del.message);

      tx.update(tradesTable)
        .set({
          buyQty,
          avgBuyPrice,
          buyValue,
          buyDate,
          buyOrderCount,
          sellQty,
          avgSellPrice,
          sellValue,
          sellDate,
          sellOrderCount,
          isOpen: false,
          unrealisedPnl: 0,
          grossPnl,
          chargesTotal,
          netPnl,
          realisedPct,
          rMultiple,
          ...(kept.followsCap ? { riskAmount: kept.riskAmount } : {}),
          ...parts,
          mtfFundedAmount,
          importNotes,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(tradesTable.id, lot.id))
        .run();

      // 5
      recordAudit({
        entity: "trade",
        entityId: lot.id,
        action: "close",
        summary: `${lot.symbol} ${isShort ? "covered" : "closed"} @ ${pair.salePrice} with the recorded ${what} #${sale.id} (Data Quality) · net ${netPnl}`,
        before: { isOpen: true, buyQty: lot.buyQty, sellQty: lot.sellQty, sellDate: lot.sellDate, chargesTotal: lot.chargesTotal, netPnl: lot.netPnl, importNotes: lot.importNotes },
        after: { isOpen: false, buyQty, sellQty, sellDate, chargesTotal, netPnl, importNotes },
        source: "data-quality",
      });

      return {
        ok: true,
        message: `${lot.tradingsymbol} ${isShort ? "covered" : "closed"} with the recorded ${what}: ${pair.saleQty} at ${pair.salePrice} on ${exitDate}. The ${what} row was removed — recoverable from Backup & Restore → Deleted items.`,
      };
    });
  } catch (e) {
    if (e instanceof StaleCloseAbort) return { ok: false, code: "DELETE_FAILED", message: e.message };
    throw e;
  }
}

/**
 * D4(b) (wave 2N) — an `acquisition: 'ipo'` holding's charges, priced the way
 * /ipos prices the record it came from: the sale's own charges plus the
 * allotment's stamp (N14), and NO purchase STT — an allotment is not a purchase on
 * a recognised exchange, so none is due (06-ANSWERS "v4.3.0 fix-work rulings" row
 * (1)). ONE helper (`ipoHoldingCharges`, lib/analytics/ipo.ts) for the listing,
 * the sync and this editor, so no two of them state a different bill for one sale.
 *
 * D14 (wave 2O): the pure half now LIVES in `lib/analytics/ipo.ts#ipoEditCharges`
 * beside `ipoHoldingCharges`, because the editor's live PREVIEW
 * (`app/api/charges/preview`) has to read it too — it had learned only the keep
 * branch, and its fall-through priced an allotment as a delivery round trip while
 * the save priced it the IPO way (dates-charges#1). This wrapper is the save's own
 * door: it injects the server-only charger (invariants 2 and 3) and nothing else.
 */
function ipoEditChargesFor(
  t: { acquisition: string | null; broker: string; exchange: string },
  v: { buyValue: number; sellValue: number; sellQty: number; buyDate: string | null; sellDate: string | null },
  rates: RatesMap,
  /** Wave U — the row's account plan, so the IPO branch prices like the rest. */
  plan = "default",
): IpoEditPricing | null {
  if (t.acquisition !== "ipo") return null;
  return ipoEditCharges(t as unknown as Record<string, unknown>, v, sellChargerFor(t.broker, t.exchange, v.sellDate, rates, plan));
}

export interface UpdateTradeFields {
  buyQty?: number;
  avgBuyPrice?: number;
  buyDate?: string | null;
  sellQty?: number;
  avgSellPrice?: number;
  sellDate?: string | null;
  slPlanned?: number | null;
  trailingSl?: number | null;
  targetPlanned?: number | null;
  riskAmount?: number | null;
  /** MTF only; omit/undefined = keep the persisted funded amount unchanged. */
  ownCapitalUsed?: number | null;
  setupTag?: string | null;
  /** WHY the trade was closed — free text; null = unanswered (never ""). */
  exitTrigger?: string | null;
  notes?: string | null;
  currentPrice?: number | null; // MTM for a still-open position
  /**
   * The Signal book's envelope (v4.3.0), already serialised server-side.
   * `undefined` = NOT MENTIONED, so the stored value is kept (the D9 rule the
   * dates follow); `null` = an explicit clear, which on a row that HAD a signal
   * stores the tombstone rather than SQL NULL. See the write below.
   */
  signalJson?: string | null;
}

/**
 * Edit any trade (open or closed) at any time — quantities, prices, dates, SL/
 * TSL/target, risk, MTF own-capital, tags/notes. Recomputes classification-
 * unchanged charges/P&L/R the exact same way commitManualTrade/closePosition
 * do (same engine, same MTF funded/day-count rules), so an edit never drifts
 * from what a fresh entry would compute. Filling in sell qty/price on an open
 * row closes it via the same path — the create/close/edit forms share one
 * mental model. Only symbol/broker/segment/exchange (identity) are NOT
 * editable here — use the existing re-tag override for reclassification.
 */
export function updateManualTrade(
  tradeId: number,
  fields: UpdateTradeFields,
): { ok: boolean; message: string } {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, message: "Trade not found" };

  // L3 (v4.3.0 wave 2L) — a date the editor cannot read is refused, not stored and not
  // silently cleared. Before the calendar check in `normalizeDate` this save stored
  // '2026-02-31' as a sell date; after it, passing the same value through would blank
  // the date on a closed row instead. Blank still means "clear this", as every other
  // field in this form does.
  for (const [label, value] of [["buy date", fields.buyDate], ["sell date", fields.sellDate]] as const) {
    const bad = value === undefined ? null : unreadableDate(label, value);
    if (bad) return { ok: false, message: bad };
  }

  const { rates, defaults } = loadRatesContext();

  const buyQty = fields.buyQty ?? t.buyQty;
  const avgBuyPrice = fields.avgBuyPrice ?? t.avgBuyPrice;
  const buyDate = fields.buyDate !== undefined ? normalizeDate(fields.buyDate) : t.buyDate;
  const sellQty = fields.sellQty ?? t.sellQty;
  const avgSellPrice = fields.avgSellPrice ?? t.avgSellPrice;
  const sellDate = fields.sellDate !== undefined ? normalizeDate(fields.sellDate) : t.sellDate;

  // D17 (v4.3.0 wave 2O, dates-charges#4) — THE THIRD WRITER OF THE ONE RULE.
  //
  // Each date above falls back to the STORED column when the patch omits that
  // field, and `daysHeld` below then counts from it: for an eq_mtf row storing
  // '9999-99-99' (what the pre-2L writer made of a typed '99-99-9999') that is an
  // Invalid Date, so NaN went into `computeCharges` and the write died with the
  // `NOT NULL constraint failed: trades.charges_total_paise` D3 removed from
  // `closePosition` and `applyOverride` — a 500 rather than an {ok:false}.
  // `lib/domain/trading-day.ts` already promised "ONE implementation for the three
  // writers" and named two. Refused before anything is priced or written; a patch
  // that CLEARS the bad date still saves (blank means clear, above), and one that
  // SENDS a bad value is already refused by `unreadableDate`, so the UI's own path
  // is unchanged and only the throw is closed.
  const badStored = storedDateProblem({ buyDate, sellDate });
  if (badStored) return { ok: false, message: badStored };

  // Resolved AFTER the edited dates are known. Moving a trade's sell date across
  // an epoch boundary must re-price it at the epoch it now falls in, otherwise
  // the stored charges disagree with what importing the same trade would produce.
  const onDate = pricingDate({ buyDate, sellDate }, todayIstIso());
  // Wave U — the plan of the row's OWN account, on the edited dates. The
  // editor's preview (/api/charges/preview, which reads the stored row) asks
  // the same question of the same account, so the dialog cannot show a figure
  // priced on a different plan from the one this save stores.
  const editPlan = resolvePlan(planAccountOf(t.accountId), t.broker, onDate, rates);
  const r = ratesForTrade(
    rates,
    { broker: t.broker as Broker, segment: t.segment as Segment, exchange: t.exchange as Exchange, isin: t.isin, symbol: t.symbol },
    onDate,
    editPlan,
  );

  if (buyQty <= 0 && sellQty <= 0) return { ok: false, message: "At least one side (buy or sell) needs a positive quantity." };

  const isMtf = t.segment === "eq_mtf";
  // MTF: an explicit edit to ownCapitalUsed always wins, as the funded principal
  // below — resolved from the value basis this save writes (a staged parent's own
  // roll-up, a flat row's recomputed aggregate), so the refusal and the write ask
  // the same question of the same figure.
  const ownCapitalPatched = isMtf && fields.ownCapitalUsed != null && fields.ownCapitalUsed >= 0;
  const fundedFrom = (base: number) => Math.max(0, Math.round((base - fields.ownCapitalUsed!) * 100) / 100);

  // D20 (v4.3.0 wave 2O, the owed guard) — A STAGED PARENT IS PRICED ONLY BY ITS
  // LADDER.
  //
  // After D6/D7 `rebuildStagedTrade` is the SINGLE writer of a staged row's priced
  // heads (invariant 5: parent = Σ legs), and `closePosition` (STAGED),
  // `closeStaleLot` and the /ipos route all refuse such a row. This writer did not:
  // it rewrote the parent from the flat aggregate with no knowledge of legs, no exit
  // leg landed in `trade_legs`, and the next ladder action rebuilt the parent from
  // its legs — erasing what was written here. Worse, `statesNoCharges` made it fire
  // on a notes-only save of a staged row whose heads a release had zeroed.
  //
  // So: a patch that moves NO charge input saves the journal fields and hands the
  // pricing back to the ladder (`rebuildStagedTrade`, idempotent — legs and parent
  // together); a patch that MOVES one is refused, because the quantities, prices and
  // dates of a staged position ARE its fills.
  //
  // THE QUESTION IS ASKED OF THE PATCH (the wave 2O seam pass, defect 2 —
  // `wave2h-reports/wave2o-seams.md` §5), and asked BEFORE any aggregate is derived.
  // It used to be asked of values this function RESOLVES, and on a staged parent one
  // of them moved by itself: `r2(buyQty × avgBuyPrice)` disagrees with the stored Σ
  // of leg values by the weighted average's rounding, so EVERY save on a ladder
  // built at two prices was refused — a patch carrying nothing but a note included,
  // which is exactly what this refusal is not for (measured: `[150, 103.33, 15500]`
  // against 15,499.50; notes, setup tag, stop, target, risk and the mark were all
  // unsaveable through both doors). `patchMovesChargeInput` (lib/domain/trade-edit,
  // the same paisa comparison) asks only of the fields THIS patch carries.
  // D5 (wave 2P): `legCountOf` is the ONE leg-count query; the hand-back at the
  // end of this save needs the count itself, so the predicate is spelt out here.
  const legCount = legCountOf(tradeId);
  const isStaged = t.staged || legCount > 0;
  const stagedFillMoved =
    isStaged &&
    patchMovesChargeInput(
      {
        ...(fields.buyQty !== undefined ? { buyQty } : {}),
        ...(fields.avgBuyPrice !== undefined ? { avgBuyPrice } : {}),
        ...(fields.buyDate !== undefined ? { buyDate } : {}),
        ...(fields.sellQty !== undefined ? { sellQty } : {}),
        ...(fields.avgSellPrice !== undefined ? { avgSellPrice } : {}),
        ...(fields.sellDate !== undefined ? { sellDate } : {}),
        // Own capital IS a charge input (it sets the funded principal the ladder
        // apportions across the tranches), so a patch that states a different one
        // is refused too — the ladder is the only writer of a staged row's
        // interest. A patch that states none keeps the stored principal and moves
        // nothing. Read against the parent's OWN roll-up, which is the basis the
        // write below uses for a staged row.
        ...(ownCapitalPatched ? { fundedAmount: fundedFrom(t.buyValue) } : {}),
      },
      t,
    );
  if (stagedFillMoved) {
    return {
      ok: false,
      message:
        "This is a staged position built from more than one fill, so its quantities, prices and dates are not edited here: they are the fills on its own ladder in Trades, which prices each tranche and rolls them up into this row. Edit the fill there. Nothing was changed.",
    };
  }

  // D20 / defect 2: past that refusal a staged parent's fills provably did not move,
  // so its own roll-up stands — `buyValue` is Σ its LEG values while `avgBuyPrice` is
  // the ROUNDED weighted average, and re-deriving `r2(qty × avg)` would write
  // 15,499.50 over a stored 15,500 on a 100 @100 + 50 @110 ladder. The ladder
  // re-derives both at the end of this save, but a staged row it cannot rebuild (no
  // legs, or legs that fail validation) would otherwise keep the rounding as a silent
  // change of its cost basis. A FLAT row is recomputed exactly as before — an edit is
  // how its aggregate is stated.
  const buyValue = isStaged ? t.buyValue : Math.round(buyQty * avgBuyPrice * 100) / 100;
  const sellValue = isStaged ? t.sellValue : Math.round(sellQty * avgSellPrice * 100) / 100;
  const isOpen = buyQty !== sellQty;
  const buyOrderCount = buyQty > 0 ? t.buyOrderCount || defaults.buyOrders : 0;
  const sellOrderCount = sellQty > 0 ? t.sellOrderCount || defaults.sellOrders : 0;

  let fundedAmount: number | null = null;
  if (isMtf) {
    if (ownCapitalPatched) {
      fundedAmount = fundedFrom(buyValue);
    } else {
      // V3 — a stored 0 (the whole position from own capital) is kept.
      // Q-A (wave 2N) — and a NULL stays null: a save with nothing typed in
      // "Own capital used" no longer turns a row the journal never priced into
      // a stated margin-default amount. The editor's preview reads it the same
      // way (`editPreviewBody` sends no own-capital figure for such a row).
      fundedAmount = t.mtfFundedAmount;
    }
  }
  // Same T+1-through-day-before-settlement convention as close/accrual; open
  // trades accrue nothing here — the daily job takes over from the next run.
  // D7 (wave 2P) — through the ONE day count. This copy tested the raw strings
  // for emptiness, so a stored ' ' (which `storedDateProblem` above reads as
  // ABSENT) was PRESENT here: `new Date(' ')` is Invalid, NaN reached the engine
  // and the write died with `NOT NULL constraint failed: trades.charges_total_paise`
  // — the D17 throw, through the whitespace hole D17's trim left. Zero days now,
  // the answer `closePosition` and `applyOverride` already gave that row.
  const daysHeld = isMtf && !isOpen ? calendarDaysHeld(buyDate, sellDate) : 0;

  // D4 (v4.3.0 wave 2N, ipo#2) — DOES THIS SAVE CHANGE ANYTHING THE ENGINE IS FED?
  //
  // It used to re-price on every save and compare the result against the stored
  // heads only to decide the marker. So a notes / tags / levels / setup save
  // replaced an IMPORTED row's broker-stated bill with the engine's estimate
  // (owner ruling F1, in the one door that had not applied it), and replaced an
  // IPO-synced holding's charges with a delivery ROUND TRIP's — purchase STT on an
  // allotment, which is not due — while stripping the sync's provenance marker, so
  // /ipos could never re-price that row again. Both sides of the comparison are
  // built by ONE pure rule (lib/domain/trade-edit.ts), which the preview's server
  // half reads too, so the dialog cannot show a figure this save will not store.
  const storedInputs = chargeInputsOf(t, { buyOrders: defaults.buyOrders, sellOrders: defaults.sellOrders });
  const nextInputs = chargeInputsOf(
    { buyQty, avgBuyPrice, buyValue, buyDate, sellQty, avgSellPrice, sellValue, sellDate, isOpen, buyOrderCount, sellOrderCount, mtfFundedAmount: fundedAmount },
    { buyOrders: defaults.buyOrders, sellOrders: defaults.sellOrders },
  );
  // A row that states NO charge at all is priced whatever this save changed:
  // nothing stated is destroyed by it (the /ipos sync's own `statesNoCharges`
  // rule), so a manual row, an import whose file carried no charge columns and a
  // fixture are all priced on their first editor save, exactly as before.
  const inputsMoved = chargeInputsChanged(storedInputs, nextInputs);

  // A row that states NO charge at all is priced whatever this save changed —
  // except a STAGED one, whose ladder owns every priced head (D20).
  const repriced = !isStaged && (inputsMoved || statesNoCharges(t));

  // D4(b) / D14: a holding that came from an allotment is priced the way the IPO
  // model prices it — the sale plus the allotment's stamp, no purchase STT
  // (06-ANSWERS row (1)) — through the SAME pure helper the preview route and
  // /ipos price it by. D15: for an allotment with NO sale that helper answers the
  // row's own stored heads and `repriced: false`, so this save prices nothing at
  // all and the net and the marker stand.
  const ipoPriced = repriced ? ipoEditChargesFor(t, { buyValue, sellValue, sellQty, buyDate, sellDate }, rates, editPlan) : null;
  const pricedHere = repriced && (ipoPriced == null || ipoPriced.repriced);

  const charges = repriced
    ? ipoPriced?.charges ??
      computeCharges(
        {
          segment: t.segment as Segment,
          buyValue,
          sellValue,
          buyQty,
          sellQty,
          buyOrderCount,
          sellOrderCount,
          // Q-A: an unstated principal bills 0 interest — and no pledge charge either
          // (D12, wave 2O): `lib/engine/charges.ts:106` gates BOTH on the same
          // `fundedAmount > 0`, so an unpriced row is billed identically to a stated 0.
          // That is the recorded deviation (DECISIONS 2026-09-16, wave 2N); billing the
          // pledge fee alone would need an engine change, which was not made.
          mtf: isMtf ? { fundedAmount: fundedAmount ?? 0, daysHeld, pledgeScrips: 1 } : null,
        },
        r,
      )
    : storedCharges(t);
  const grossPnl = !isOpen ? Math.round((sellValue - buyValue) * 100) / 100 : 0;
  // A save that changes no charge input changes no money: the net stands as
  // stored, and R and realised % are recomputed FROM it (a risk-amount-only edit
  // still updates R).
  // D15: an un-exited allotment prices nothing, so `pricedHere` is false for it
  // and both the net and the marker below take the not-repriced path.
  const netPnl = pricedHere ? Math.round((grossPnl - charges.total) * 100) / 100 : t.netPnl;
  const realisedPct = buyValue > 0 && !isOpen ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
  // D1 (v4.4.0) — WHOSE risk this save stores. The dialog posts the risk on
  // every save (prefilled from the row, edit-trade-dialog.tsx), so a posted
  // figure is the user's choice ('set') only when it differs from BOTH the
  // stored value AND today's cap for the row's segment: re-posting what the row
  // holds, or typing exactly the cap, leaves a cap row following the cap. A
  // posted null clears risk, source and R together; an omitted risk keeps the
  // row's own, a 'cap' row re-reading today's cap.
  const capNow = resolvePerTradeCap(defaults.capRows, t.bucket, t.segment);
  const posted = fields.riskAmount;
  let riskAmount: number | null;
  let riskSource: string | null;
  if (posted === null) {
    riskAmount = null;
    riskSource = null;
  } else if (posted !== undefined && posted !== t.riskAmount && posted !== capNow) {
    riskAmount = posted;
    riskSource = "set";
  } else if (t.riskSource === "cap" || (posted !== undefined && posted === capNow && posted !== t.riskAmount)) {
    riskAmount = capNow;
    riskSource = "cap";
  } else {
    riskAmount = t.riskAmount;
    riskSource = t.riskSource;
  }
  const rMultiple = capR(netPnl, riskAmount);

  // H1 (M2 variant (c)) — an edit that re-makes the EXIT leg of a lot joined
  // from Data Quality leaves a close that is no longer the join's, so the join
  // sentence goes and every alias stays. Compared by value: the editor sends
  // every field back on each save. A long exits on its sell leg; a closed row
  // states its direction only through its dates (the exit is the later one),
  // so the buy leg counts too unless the row reads long. An edit that touches
  // no exit-leg field (notes, tags, levels, the other leg of a long) keeps it.
  const readsLong = t.buyQty > t.sellQty || (t.buyQty === t.sellQty && !!t.buyDate && !!t.sellDate && t.buyDate < t.sellDate);
  // D4 (wave 2P): a date is "changed" when the DAY it states moved (`sameDay`),
  // not when a legacy '05-01-2026' is re-stored as '2026-01-05' by this save.
  const sellLegChanged = sellQty !== t.sellQty || avgSellPrice !== t.avgSellPrice || !sameDay(sellDate, t.sellDate);
  const buyLegChanged = buyQty !== t.buyQty || avgBuyPrice !== t.avgBuyPrice || !sameDay(buyDate, t.buyDate);
  const exitLegChanged = isOpen !== t.isOpen || sellLegChanged || (!readsLong && buyLegChanged);

  // L3 (v4.3.0 wave 2L) — a save that PRICES the row makes the charges on it THIS
  // save's, so the IPO sync's provenance marker goes with them (it claims the eight
  // heads it priced) and the next exit edit on /ipos keeps what is here (owner
  // ruling F1). Every other note is kept in order, the way the Data Quality join
  // sentence is dropped on an exit-leg change just above. `closePosition` and
  // `applyOverride` do not touch it.
  //
  // D4 (wave 2N) — asked of the INPUTS, not of the output: the old comparison
  // re-priced first and then noticed the figures had moved, which for an IPO-synced
  // holding they always had (two different pricings of one sale), so every save
  // dropped the marker.
  const keptNotes = pricedHere ? withoutSyncChargesNote(t.importNotes) : t.importNotes;
  const nextNotes = exitLegChanged ? withoutStaleCloseNote(keptNotes) : keptNotes;

  // v4.3.0 — THE SIGNAL BOOK's edit rule, in three parts and no more.
  //
  //   1. NOT AN OPTION, or NOT MENTIONED (`undefined`): the stored value stands.
  //      A form that does not carry the field — a stale tab, a non-dialog client,
  //      the trade table's own quick edits — must not clear it; the `notes` idiom
  //      two lines down, and D9's "absent = not mentioned".
  //   2. A STORED ENVELOPE THIS RELEASE CANNOT READ (a `v:2` written by a newer
  //      version, restored from that machine's backup) is KEPT and the save says
  //      so. `parseSignal` answers null for it, so the section seeds BLANK — and
  //      without this one keystroke elsewhere in the form would replace a richer
  //      envelope with a one-field v1. The tombstone is NOT this case: it is a
  //      readable v1 that states nothing, and clearing or re-recording it is
  //      exactly what the user should be able to do.
  //   3. AN EXPLICIT CLEAR of a row that HAD a signal stores the tombstone
  //      `{"v":1}`, never SQL NULL — `rerunDataFixesAfterRestore` forgets every
  //      marker, so a NULL would let the seeded-notes backfill resurrect, on the
  //      next restore, the signal the user deliberately deleted.
  const storedSignalUnreadable = t.signalJson != null && classifyStoredSignal(t.signalJson) === "unreadable";
  const signalMentioned = fields.signalJson !== undefined && t.instrumentType === "option" && !storedSignalUnreadable;
  const nextSignalJson = signalMentioned ? fields.signalJson ?? (t.signalJson != null ? SIGNAL_TOMBSTONE : null) : t.signalJson;

  db.update(tradesTable)
    .set({
      buyQty,
      avgBuyPrice,
      buyValue,
      buyDate,
      buyOrderCount,
      sellQty,
      avgSellPrice,
      sellValue,
      sellDate,
      sellOrderCount,
      isOpen,
      unrealisedPnl: isOpen ? t.unrealisedPnl : 0,
      grossPnl,
      chargesTotal: charges.total,
      netPnl,
      realisedPct,
      riskAmount,
      rMultiple,
      riskSource,
      slPlanned: fields.slPlanned !== undefined ? fields.slPlanned : t.slPlanned,
      trailingSl: fields.trailingSl !== undefined ? fields.trailingSl : t.trailingSl,
      targetPlanned: fields.targetPlanned !== undefined ? fields.targetPlanned : t.targetPlanned,
      setupTag: fields.setupTag !== undefined ? fields.setupTag : t.setupTag,
      exitTrigger: fields.exitTrigger !== undefined ? fields.exitTrigger : t.exitTrigger,
      notes: fields.notes !== undefined ? fields.notes : t.notes,
      signalJson: nextSignalJson,
      ...(nextNotes !== t.importNotes ? { importNotes: nextNotes } : {}),
      brokerage: charges.brokerage,
      sttCtt: charges.sttCtt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      ipft: charges.ipft,
      gst: charges.gst,
      dpCharges: charges.dpCharges,
      mtfInterest: charges.mtfInterest,
      mtfFundedAmount: fundedAmount,
      pledgeCharges: charges.pledgeCharges,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(tradesTable.id, tradeId))
    .run();

  // D20 — the ladder re-derives every priced head of a staged parent, so the row
  // this save just wrote back verbatim is confirmed to equal Σ legs (invariant 5)
  // and a legacy row whose heads were released is priced through the one writer
  // that knows its tranches. Idempotent; nothing to rebuild without legs.
  if (isStaged && legCount > 0) rebuildStagedTrade(tradeId);

  let markNote = "";
  if (fields.currentPrice != null && fields.currentPrice > 0) {
    if (isDerivativeInstrument(t)) {
      // The premium would land under the underlying's symbol and erase its
      // cash mark (owner ruling, fix wave 3 audit) — say so instead.
      markNote = " The current price was not stored: marks for options and futures are not stored in this version.";
    } else {
      // Same typed-door rule as the create path above: replace the day's row.
      writeTypedMark({ symbol: t.symbol, tradingsymbol: t.tradingsymbol, price: fields.currentPrice, asOfDate: todayIstIso() });
    }
  }

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "update",
    summary: `${t.symbol} edited · ${isOpen ? "open" : "closed"} · net ${netPnl}`,
    // `signal` is on BOTH sides, always: `assertSymmetricSnapshots` (lib/audit)
    // refuses an asymmetric pair, and "the signal was removed" is exactly the
    // transition the trail must be able to show. The trail records THAT a signal
    // is on the row, never its levels — those live on the row itself.
    before: { buyQty: t.buyQty, avgBuyPrice: t.avgBuyPrice, sellQty: t.sellQty, avgSellPrice: t.avgSellPrice, netPnl: t.netPnl, isOpen: t.isOpen, signal: t.signalJson != null },
    after: { buyQty, avgBuyPrice, sellQty, avgSellPrice, netPnl, isOpen, signal: nextSignalJson != null },
  });

  // Part 2 above, said out loud: a save that silently dropped a newer release's
  // signal would be indistinguishable from one that kept it.
  const signalNote =
    storedSignalUnreadable && fields.signalJson !== undefined
      ? " Its signal was recorded by a newer version of Vyuha and was left exactly as it is."
      : "";
  return { ok: true, message: "Trade updated." + markNote + signalNote };
}

/**
 * Persist a manual classification override (keyed by broker + dedup_hash so it
 * re-applies on re-import) and immediately recompute the affected trade.
 */
export function applyOverride(
  tradeId: number,
  ov: { segment?: Segment | null; isMtf?: boolean | null; exchange?: Exchange | null; setupTag?: string | null },
): boolean {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return false;
  // D3 (v4.3.0 wave 2N, ipo#1) — the same refusal `closePosition` makes: a stored
  // date that states no day prices nothing, and `new Date` on it took the re-tag
  // down with `NOT NULL constraint failed: trades.charges_total_paise`. Nothing is
  // written (the override row included); the re-tag dialog states the sentence
  // itself (`storedDateProblem`, lib/domain/trading-day) rather than submitting a
  // save that can only refuse.
  if (storedDateProblem(t)) return false;

  // D20 (v4.3.0 wave 2O, the owed guard) — a STAGED parent's priced heads belong to
  // its ladder alone (invariant 5), and this writer recomputed them from the flat
  // aggregate: a re-tag TO eq_mtf billed the whole position one round trip's
  // interest beside legs that state each tranche's, and the next ladder action
  // erased it. Refused like `closePosition`'s own STAGED case; the override row is
  // not written either, so "nothing was changed" is the fact. The re-tag dialog can
  // reach a staged row (nothing gates it) and `overrideTrade` discards the boolean,
  // exactly as it does for the stored-date refusal above.
  // D5 (wave 2P): the ONE leg-count predicate (`hasLadder`, lib/queries/staged).
  if (hasLadder(t, tradeId)) return false;

  const segment = ov.segment ?? (ov.isMtf ? "eq_mtf" : (t.segment as Segment));
  const exchange = ov.exchange ?? (t.exchange as Exchange);
  const bucket = SEGMENT_BUCKET[segment];

  // upsert override
  const existing = db
    .select()
    .from(classificationOverrides)
    .where(and(eq(classificationOverrides.broker, t.broker), eq(classificationOverrides.dedupHash, t.dedupHash)))
    .get();
  const values = {
    broker: t.broker,
    dedupHash: t.dedupHash,
    segment,
    bucket,
    exchange,
    isMtf: ov.isMtf ?? segment === "eq_mtf",
    setupTag: ov.setupTag ?? t.setupTag ?? null,
  };
  if (existing) {
    db.update(classificationOverrides).set(values).where(eq(classificationOverrides.id, existing.id)).run();
  } else {
    db.insert(classificationOverrides).values(values).run();
  }

  // recompute charges for the trade under the new segment/exchange
  const { rates, defaults } = loadRatesContext();
  const onDate = pricingDate(t, todayIstIso());
  const r = ratesForTrade(
    rates,
    { broker: t.broker as Broker, segment, exchange, isin: t.isin, symbol: t.symbol },
    onDate,
    // Wave U — the re-tag re-prices the row, so it prices it on the row's own
    // account's plan; pricing a re-tag at "default" would move a Plus account's
    // stored charges to Basic's figure.
    resolvePlan(planAccountOf(t.accountId), t.broker, onDate, rates),
  );
  // MTF accrual follows the segment (same rules as updateManualTrade): a flip
  // TO eq_mtf estimates the funded principal (persisted amount first, else the
  // margin-config estimate) and, for a closed trade, the held days; a flip
  // AWAY zeroes interest/pledge. Without this the stored mtfInterest column
  // kept its OLD segment's figure while chargesTotal was recomputed without
  // it, so the breakdown no longer summed to the total (B4).
  const isMtf = segment === "eq_mtf";
  // V3: a stored 0 is kept. Q-A (wave 2N): a null stays null — a re-tag TO
  // eq_mtf no longer invents a funded principal for a row nobody priced, and
  // bills no interest for it (and no pledge charge either — D12, wave 2O: the
  // engine gates both on the same `fundedAmount > 0`, so this row is billed
  // exactly like one that states 0; the recorded deviation, not an oversight).
  const fundedAmount = isMtf ? t.mtfFundedAmount : null;
  // Open positions accrue nothing here — the daily job (lib/jobs/mtf-accrual.ts)
  // takes over from its next run, per-epoch.
  // D3 — both ends through the shared calendar (the guard above refused a stored
  // value it cannot read, so these resolve or the row states no date at all).
  // D7 (wave 2P) — the ONE day count, `calendarDaysHeld`.
  const daysHeld = isMtf && !t.isOpen ? calendarDaysHeld(t.buyDate, t.sellDate) : 0;
  const charges = computeCharges(
    {
      segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount: t.buyOrderCount,
      sellOrderCount: t.sellOrderCount,
      // Q-A: an unstated principal bills 0 interest — and no pledge charge either
      // (D12, wave 2O): `lib/engine/charges.ts:106` gates BOTH on the same
      // `fundedAmount > 0`, so an unpriced row is billed identically to a stated 0.
      // That is the recorded deviation (DECISIONS 2026-09-16, wave 2N); billing the
      // pledge fee alone would need an engine change, which was not made.
      mtf: isMtf ? { fundedAmount: fundedAmount ?? 0, daysHeld, pledgeScrips: 1 } : null,
    },
    r,
  );
  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;
  // D1 (v4.4.0): a 'cap' row re-resolves for its NEW segment — it used to keep
  // the old segment's denominator; a typed risk stays the user's.
  const kept = keptRisk(t, bucket, segment, defaults.capRows);

  db.update(tradesTable)
    .set({
      segment,
      bucket,
      exchange,
      setupTag: ov.setupTag ?? t.setupTag ?? null,
      chargesTotal: charges.total,
      netPnl,
      ...(kept.followsCap ? { riskAmount: kept.riskAmount } : {}),
      rMultiple: kept.followsCap
        ? capR(netPnl, kept.riskAmount)
        : t.riskAmount && t.riskAmount > 0 ? Math.round((netPnl / t.riskAmount) * 100) / 100 : t.rMultiple,
      brokerage: charges.brokerage,
      sttCtt: charges.sttCtt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      ipft: charges.ipft,
      gst: charges.gst,
      dpCharges: charges.dpCharges,
      mtfInterest: charges.mtfInterest,
      mtfFundedAmount: fundedAmount,
      pledgeCharges: charges.pledgeCharges,
    })
    .where(eq(tradesTable.id, tradeId))
    .run();

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "override",
    summary: `${t.symbol} reclassified → ${segment}`,
    before: { segment: t.segment, bucket: t.bucket, exchange: t.exchange },
    after: { segment, bucket, exchange },
  });

  return true;
}

/** Used by the override UI to recompute a single trade after re-tagging. */
export { buildRow, loadContext, normalizeDate };
export type { Override };
