import "server-only";
import { db } from "@/lib/db";
import {
  trades as tradesTable,
  importBatches,
  classificationOverrides,
  riskConfig,
  settings as settingsTable,
  mtmPrices,
  tradeLegs,
  accounts as accountsTable,
  brokerReference,
} from "@/lib/db/schema";
import { eq, and, ne, sql } from "drizzle-orm";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate, type RatesMap } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { ChargeBreakdown, Execution, NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { Broker, Bucket, Exchange, Segment } from "@/lib/domain/constants";
import { SEGMENT_BUCKET } from "@/lib/domain/constants";
import type { CommitResult, EnrichmentRow, ParsedFile, ReferenceRow } from "./types";
import { relabelledFromWarnings, type ImportShape } from "@/lib/domain/import-shape";
import { getWriteAccountId } from "@/lib/queries/accounts";
import { detectCrossBrokerEchoes, detectCrossSourceDuplicates, type CrossSourceReport } from "./cross-source";
import { dedupHash } from "./dedup";
import { recordAudit } from "@/lib/audit";
import { getMarginPct } from "@/lib/queries/margin";
import { getSymbolsByIsin } from "@/lib/queries/instruments";
import { bundledSymbolByIsin, isCodedSymbol, resolveCodedSymbols } from "./isin-symbol";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";

/** eq_mtf own-margin % for THIS trade's broker (from margin_config — real
 * leverage varies by broker), falling back to the seeded default if missing. */
function mtfOwnMarginPct(broker: string): number {
  return getMarginPct(broker, "eq_mtf");
}

function normalizeDate(s: string | null): string | null {
  if (!s) return null;
  const t = s.trim();
  // DD-MM-YYYY or DD/MM/YYYY
  const m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // YYYY-MM-DD (optionally with time)
  const m2 = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
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
  dedup: string;
  buyOrderCount: number;
  sellOrderCount: number;
  riskAmount: number;
  rMultiple: number | null;
  realisedPct: number | null;
}

/** Apply auto-classification + any persisted override, then compute charges. */
function buildRow(
  t: NormalizedTrade,
  rates: RatesMap,
  overrides: Map<string, Override>,
  defaults: { buyOrders: number; sellOrders: number; perTradeRisk: number },
): BuiltRow {
  const dedup = dedupHash(t);
  let cls = classify({
    tradingsymbol: t.tradingsymbol,
    broker: t.broker,
    isin: t.isin,
    productHint: t.productHint,
    exchangeHint: t.exchangeHint,
  });

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

  const r = findRates(rates, t.broker, cls.segment, cls.exchange, pricingDate(t, todayIstIso()));
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
  const riskAmount = defaults.perTradeRisk;
  const rMultiple = riskAmount > 0 ? Math.round((netPnl / riskAmount) * 100) / 100 : null;
  const realisedPct = t.buyValue > 0 && !isOpen ? Math.round((t.grossPnl / t.buyValue) * 10000) / 100 : null;

  return { classification: cls, charges, netPnl, isOpen, dedup, buyOrderCount, sellOrderCount, riskAmount, rMultiple, realisedPct };
}

/** Rates and defaults only — for mutations of a row that already has an account. */
function loadRatesContext() {
  const rates = loadRatesMap();
  const s = db.select().from(settingsTable).limit(1).all()[0];
  const globalRisk = db.select().from(riskConfig).where(eq(riskConfig.scope, "global")).all()[0];
  return {
    rates,
    defaults: {
      buyOrders: s?.defaultBuyOrders ?? 1,
      sellOrders: s?.defaultSellOrders ?? 1,
      perTradeRisk: globalRisk?.perTradeMaxLoss ?? 9500,
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
  summary: { total: number; newCount: number; dupCount: number; grossPnl: number; chargesTotal: number; netPnl: number };
  reconciliation?: { reported: Record<string, number>; computed: Record<string, number> };
  /** Rows that look like trades already held from a DIFFERENT file kind. */
  crossSource?: CrossSourceReport;
  /** Same instrument, same day, DIFFERENT broker — informational only. */
  crossBroker?: string | null;
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
  const existing = new Set(existingRows.map((r) => r.dedupHash));

  const rows: PreviewRow[] = [];
  let grossPnl = 0, chargesTotal = 0, netPnl = 0, dupCount = 0, openCount = 0, openingSells = 0;
  const agg: Record<string, number> = { brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, dpCharges: 0 };

  for (const t of parsed.trades) {
    const b = buildRow(t, rates, overrides, defaults);
    const isDuplicate = existing.has(b.dedup);
    if (isDuplicate) dupCount++;
    // Disjoint by construction: an opening sell also has buyQty !== sellQty, so
    // counting it as "open" as well would make the three counts overlap and
    // stop summing to the position total.
    if (t.basisUnknown) openingSells++;
    else if (b.isOpen) openCount++;
    grossPnl += t.grossPnl;
    chargesTotal += b.charges.total;
    netPnl += b.netPnl;
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
      grossPnl: t.grossPnl,
      chargesTotal: b.charges.total,
      netPnl: b.netPnl,
      isOpen: b.isOpen,
      isDuplicate,
    });
  }

  return {
    sourceId: parsed.sourceId,
    broker: parsed.broker,
    format: parsed.format,
    warnings: parsed.warnings,
    rawText: parsed.rawText,
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
      newCount: rows.length - dupCount,
      dupCount,
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
        dedupHash: dedupHash({ ...t, broker: parsed.broker } as never),
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
function persistReference(
  tx: { run: (q: ReturnType<typeof sql>) => unknown },
  rows: ReferenceRow[],
  accountId: number,
  broker: string,
  sourceId: string,
  batchId: number,
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
 * Matching is (symbol, date, side, qty), symbol case-insensitively against
 * BOTH `symbol` and `tradingsymbol` because a broker's contract note names the
 * scrip its own way. Writes are one-directional and non-destructive:
 *   - entry_time / exit_time are set ONLY where NULL — a time the book already
 *     has came from the tradebook, which is the better source.
 *   - instrument_type is set ONLY where the classifier left "equity" AND the
 *     note says option or future. A stated derivative beats a defaulted
 *     equity; nothing ever demotes a classified derivative back to equity.
 */
function applyEnrichments(
  tx: typeof db,
  rows: EnrichmentRow[],
  accountId: number,
): { applied: number; unmatched: number } {
  let applied = 0;
  let unmatched = 0;
  for (const e of rows) {
    const wantSymbol = e.symbol.trim().toLowerCase();
    const isBuy = e.side === "buy";
    const dateCol = isBuy ? tradesTable.buyDate : tradesTable.sellDate;
    const qtyCol = isBuy ? tradesTable.buyQty : tradesTable.sellQty;
    const candidate = tx
      .select({
        id: tradesTable.id,
        entryTime: tradesTable.entryTime,
        exitTime: tradesTable.exitTime,
        instrumentType: tradesTable.instrumentType,
      })
      .from(tradesTable)
      .where(and(
        eq(tradesTable.accountId, accountId),
        eq(dateCol, normalizeDate(e.date) ?? e.date),
        eq(qtyCol, e.qty),
        sql`(lower(${tradesTable.symbol}) = ${wantSymbol} OR lower(${tradesTable.tradingsymbol}) = ${wantSymbol})`,
      ))
      .get();
    if (!candidate) {
      unmatched++;
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (e.time && isBuy && candidate.entryTime == null) patch.entryTime = e.time;
    if (e.time && !isBuy && candidate.exitTime == null) patch.exitTime = e.time;
    if (
      (e.instrumentType === "option" || e.instrumentType === "future")
      && candidate.instrumentType === "equity"
    ) patch.instrumentType = e.instrumentType;
    if (Object.keys(patch).length) tx.update(tradesTable).set(patch).where(eq(tradesTable.id, candidate.id)).run();
    applied++;
  }
  return { applied, unmatched };
}

export function commitParsedFile(
  parsedIn: ParsedFile,
  fileName: string,
  productOverrides: Record<string, ProductHint> | null = null,
  accountIdIn?: number | null,
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
    const existing = new Set(
      tx.select({ h: tradesTable.dedupHash }).from(tradesTable).where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, parsed.broker))).all().map((r) => r.h),
    );

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

    for (const t of parsed.trades) {
      const b = buildRow(t, rates, overrides, defaults);
      // Counted BEFORE the duplicate check, and over every parsed row: the
      // shape sentence describes the FILE, which is what the user reconciles
      // against their broker's statement. Added/skipped is a separate fact.
      if (t.basisUnknown) openingSells++;
      else if (b.isOpen) openCount++;
      if (existing.has(b.dedup) || seenInThisFile.has(b.dedup)) {
        skipped++;
        continue;
      }
      seenInThisFile.add(b.dedup);

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
          importNotes: noteLines.length ? noteLines.join(" | ") : null,
        })
        .returning({ id: tradesTable.id })
        .get();
      added++;
      netPnl += b.netPnl;

      // Preserve the entry ladder from a tradebook export. The parent row keeps
      // the aggregate the rest of the app reads; the legs give the position its
      // real shape — three entries at three prices instead of one blended
      // average. Charges stay as computed on the aggregate here; opening the
      // staged panel reprices per fill.
      if (inserted && stagedFromExecutions(t)) {
        let seq = 1;
        const isShort = t.sellQty > t.buyQty; // must match orderExecutions (fix A6)
        for (const ex of orderExecutions(t)) {
          const opening = isShort ? ex.side === "sell" : ex.side === "buy";
          tx.insert(tradeLegs)
            .values({
              tradeId: inserted.id,
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
      }
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

    let enrichApplied = 0;
    const enrichTotal = parsed.enrich?.length ?? 0;
    if (enrichTotal > 0) {
      const outcome = applyEnrichments(tx as unknown as typeof db, parsed.enrich!, accountId);
      enrichApplied = outcome.applied;
      commitWarnings.push(`Fill times applied to ${enrichApplied} of ${enrichTotal} contract-note lines`);
      if (outcome.unmatched > 0) {
        commitWarnings.push(
          `${outcome.unmatched} contract-note line${outcome.unmatched === 1 ? "" : "s"} matched no trade in this account and were NOT imported — a contract note enriches trades the book already holds, it never creates one.`,
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

  const dedup = dedupHash(t);
  const dup = db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(and(eq(tradesTable.accountId, accountId), eq(tradesTable.broker, t.broker), eq(tradesTable.dedupHash, dedup)))
    .all();
  if (dup.length > 0) return { id: null, duplicate: true };

  const buyOrderCount = t.buyQty > 0 ? fields.buyOrders ?? defaults.buyOrders : 0;
  const sellOrderCount = t.sellQty > 0 ? fields.sellOrders ?? defaults.sellOrders : 0;
  const r = findRates(rates, t.broker, cls.segment, cls.exchange, pricingDate(t, todayIstIso()));

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
  const riskQty = Math.abs(isOpen ? t.buyQty - t.sellQty : t.buyQty) || t.buyQty;
  const riskAmount =
    fields.riskAmount ??
    (fields.slPlanned != null && riskQty > 0
      ? Math.round(Math.abs(entryPrice - fields.slPlanned) * riskQty * 100) / 100
      : defaults.perTradeRisk);

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
      rMultiple: riskAmount > 0 ? Math.round((netPnl / riskAmount) * 100) / 100 : null,
      setupTag: fields.setupTag ?? null,
      notes: fields.notes ?? null,
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
    after: { symbol: cls.symbol, segment: cls.segment, buyQty: t.buyQty, sellQty: t.sellQty, netPnl, isOpen, ...(breaches ? { ruleViolations: breaches } : {}) },
    source: "manual",
  });

  // Store the current MTM so an open position shows a live mark on the trackers.
  if (fields.currentPrice != null && fields.currentPrice > 0) {
    db.insert(mtmPrices)
      .values({
        symbol: cls.symbol.toUpperCase(),
        tradingsymbol: t.tradingsymbol,
        price: fields.currentPrice,
        asOfDate: todayIstIso(),
      })
      .run();
  }

  return { id: row!.id, duplicate: false };
}

/**
 * Close an open position at an exit price: completes the missing leg (sell-to-close
 * for a long; buy-to-cover for a short sell-to-open, e.g. a written CE/PE), recomputes
 * the full (buy+sell) charges, MTF interest over the holding period, and realised net P&L.
 */
export function closePosition(
  tradeId: number,
  exitPrice: number,
  exitDate: string | null,
): { ok: boolean; message: string } {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, message: "Trade not found" };
  if (!t.isOpen) return { ok: false, message: "Position is already closed" };

  // Short (sell-to-open) has the open leg on sellQty with buyQty still 0 — closing
  // means BUYING to cover, not selling. Long (the common case) closes by selling.
  const isShort = t.sellQty > t.buyQty;
  const qty = Math.abs(t.buyQty - t.sellQty) || (isShort ? t.sellQty : t.buyQty);
  const exitValue = Math.round(exitPrice * qty * 100) / 100;
  const exitDateIso = normalizeDate(exitDate) ?? todayIstIso();

  const buyQty = isShort ? qty : t.buyQty;
  const avgBuyPrice = isShort ? exitPrice : t.avgBuyPrice;
  const buyValue = isShort ? exitValue : t.buyValue;
  const buyDate = isShort ? exitDateIso : t.buyDate;
  const buyOrderCount = isShort ? t.buyOrderCount || 1 : t.buyOrderCount;

  const sellQty = isShort ? t.sellQty : qty;
  const avgSellPrice = isShort ? t.avgSellPrice : exitPrice;
  const sellValue = isShort ? t.sellValue : exitValue;
  const sellDate = isShort ? t.sellDate : exitDateIso;
  const sellOrderCount = isShort ? t.sellOrderCount : t.sellOrderCount || 1;

  const { rates } = loadRatesContext();
  // The COMPUTED dates, not the stale row: `t.sellDate` is null for an open long,
  // so pricing off `t` would charge the exit at the ENTRY date's epoch — the exact
  // inverse of pricingDate's own rule that the sell side dominates the bill.
  const r = findRates(rates, t.broker as Broker, t.segment as Segment, t.exchange as Exchange, pricingDate({ buyDate, sellDate }, todayIstIso()));

  // MTF interest over the holding period (buy → exit), if this is an MTF position.
  // MTF is equity-only (never a short-open segment), so buyDate is always the entry.
  // Reuse the fundedAmount locked in at entry (explicit or auto-estimated) — NEVER
  // recompute from the full buyValue, which would assume 100% broker financing and
  // overstate interest (a real bug fixed here: it previously did exactly that).
  let mtf: { fundedAmount: number; daysHeld: number; pledgeScrips: number } | null = null;
  let mtfFundedAmount: number | null = t.mtfFundedAmount;
  if (t.segment === "eq_mtf") {
    const funded = t.mtfFundedAmount && t.mtfFundedAmount > 0 ? t.mtfFundedAmount : defaultMtfFundedAmount(t.buyValue, mtfOwnMarginPct(t.broker));
    // Interest accrues from T+1 settlement (day after buy) through the day
    // BEFORE sale proceeds settle — which works out to exactly (sellDate −
    // buyDate) calendar days, confirmed against Dhan's own MTF documentation.
    // No extra "-1": that undercounted every position by one day of interest.
    const days = t.buyDate
      ? Math.max(0, Math.floor((new Date(exitDateIso).getTime() - new Date(t.buyDate).getTime()) / 86400000))
      : 0;
    mtf = { fundedAmount: funded, daysHeld: days, pledgeScrips: 1 };
    mtfFundedAmount = funded;
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
  const rMultiple = t.riskAmount && t.riskAmount > 0 ? Math.round((netPnl / t.riskAmount) * 100) / 100 : t.rMultiple;

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
      isOpen: false,
      unrealisedPnl: 0,
      grossPnl,
      chargesTotal: charges.total,
      netPnl,
      realisedPct,
      rMultiple,
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

  const { rates, defaults } = loadRatesContext();

  const buyQty = fields.buyQty ?? t.buyQty;
  const avgBuyPrice = fields.avgBuyPrice ?? t.avgBuyPrice;
  const buyDate = fields.buyDate !== undefined ? normalizeDate(fields.buyDate) : t.buyDate;
  const sellQty = fields.sellQty ?? t.sellQty;
  const avgSellPrice = fields.avgSellPrice ?? t.avgSellPrice;
  const sellDate = fields.sellDate !== undefined ? normalizeDate(fields.sellDate) : t.sellDate;

  // Resolved AFTER the edited dates are known. Moving a trade's sell date across
  // an epoch boundary must re-price it at the epoch it now falls in, otherwise
  // the stored charges disagree with what importing the same trade would produce.
  const r = findRates(rates, t.broker as Broker, t.segment as Segment, t.exchange as Exchange, pricingDate({ buyDate, sellDate }, todayIstIso()));

  if (buyQty <= 0 && sellQty <= 0) return { ok: false, message: "At least one side (buy or sell) needs a positive quantity." };

  const buyValue = Math.round(buyQty * avgBuyPrice * 100) / 100;
  const sellValue = Math.round(sellQty * avgSellPrice * 100) / 100;
  const isOpen = buyQty !== sellQty;
  const buyOrderCount = buyQty > 0 ? t.buyOrderCount || defaults.buyOrders : 0;
  const sellOrderCount = sellQty > 0 ? t.sellOrderCount || defaults.sellOrders : 0;

  // MTF: an explicit edit to ownCapitalUsed always wins; otherwise keep the
  // persisted funded amount; only estimate if the trade somehow has none yet.
  const isMtf = t.segment === "eq_mtf";
  let fundedAmount: number | null = null;
  if (isMtf) {
    if (fields.ownCapitalUsed != null && fields.ownCapitalUsed >= 0) {
      fundedAmount = Math.max(0, Math.round((buyValue - fields.ownCapitalUsed) * 100) / 100);
    } else {
      fundedAmount = t.mtfFundedAmount && t.mtfFundedAmount > 0 ? t.mtfFundedAmount : defaultMtfFundedAmount(buyValue, mtfOwnMarginPct(t.broker));
    }
  }
  // Same T+1-through-day-before-settlement convention as close/accrual; open
  // trades accrue nothing here — the daily job takes over from the next run.
  const daysHeld = isMtf && !isOpen && buyDate && sellDate
    ? Math.max(0, Math.floor((new Date(sellDate).getTime() - new Date(buyDate).getTime()) / 86400000))
    : 0;

  const charges = computeCharges(
    {
      segment: t.segment as Segment,
      buyValue,
      sellValue,
      buyQty,
      sellQty,
      buyOrderCount,
      sellOrderCount,
      mtf: isMtf ? { fundedAmount: fundedAmount!, daysHeld, pledgeScrips: 1 } : null,
    },
    r,
  );
  const grossPnl = !isOpen ? Math.round((sellValue - buyValue) * 100) / 100 : 0;
  const netPnl = Math.round((grossPnl - charges.total) * 100) / 100;
  const realisedPct = buyValue > 0 && !isOpen ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
  const riskAmount = fields.riskAmount !== undefined ? fields.riskAmount : t.riskAmount;
  const rMultiple = riskAmount && riskAmount > 0 ? Math.round((netPnl / riskAmount) * 100) / 100 : null;

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
      slPlanned: fields.slPlanned !== undefined ? fields.slPlanned : t.slPlanned,
      trailingSl: fields.trailingSl !== undefined ? fields.trailingSl : t.trailingSl,
      targetPlanned: fields.targetPlanned !== undefined ? fields.targetPlanned : t.targetPlanned,
      setupTag: fields.setupTag !== undefined ? fields.setupTag : t.setupTag,
      exitTrigger: fields.exitTrigger !== undefined ? fields.exitTrigger : t.exitTrigger,
      notes: fields.notes !== undefined ? fields.notes : t.notes,
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

  if (fields.currentPrice != null && fields.currentPrice > 0) {
    db.insert(mtmPrices)
      .values({ symbol: t.symbol.toUpperCase(), tradingsymbol: t.tradingsymbol, price: fields.currentPrice, asOfDate: todayIstIso() })
      .run();
  }

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "update",
    summary: `${t.symbol} edited · ${isOpen ? "open" : "closed"} · net ${netPnl}`,
    before: { buyQty: t.buyQty, avgBuyPrice: t.avgBuyPrice, sellQty: t.sellQty, avgSellPrice: t.avgSellPrice, netPnl: t.netPnl, isOpen: t.isOpen },
    after: { buyQty, avgBuyPrice, sellQty, avgSellPrice, netPnl, isOpen },
  });

  return { ok: true, message: "Trade updated." };
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
  const { rates } = loadRatesContext();
  const r = findRates(rates, t.broker as Broker, segment, exchange, pricingDate(t, todayIstIso()));
  // MTF accrual follows the segment (same rules as updateManualTrade): a flip
  // TO eq_mtf estimates the funded principal (persisted amount first, else the
  // margin-config estimate) and, for a closed trade, the held days; a flip
  // AWAY zeroes interest/pledge. Without this the stored mtfInterest column
  // kept its OLD segment's figure while chargesTotal was recomputed without
  // it, so the breakdown no longer summed to the total (B4).
  const isMtf = segment === "eq_mtf";
  const fundedAmount = isMtf
    ? t.mtfFundedAmount && t.mtfFundedAmount > 0
      ? t.mtfFundedAmount
      : defaultMtfFundedAmount(t.buyValue, mtfOwnMarginPct(t.broker))
    : null;
  // Open positions accrue nothing here — the daily job (lib/jobs/mtf-accrual.ts)
  // takes over from its next run, per-epoch.
  const daysHeld = isMtf && !t.isOpen && t.buyDate && t.sellDate
    ? Math.max(0, Math.floor((new Date(t.sellDate).getTime() - new Date(t.buyDate).getTime()) / 86400000))
    : 0;
  const charges = computeCharges(
    {
      segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount: t.buyOrderCount,
      sellOrderCount: t.sellOrderCount,
      mtf: isMtf ? { fundedAmount: fundedAmount!, daysHeld, pledgeScrips: 1 } : null,
    },
    r,
  );
  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;

  db.update(tradesTable)
    .set({
      segment,
      bucket,
      exchange,
      setupTag: ov.setupTag ?? t.setupTag ?? null,
      chargesTotal: charges.total,
      netPnl,
      rMultiple: t.riskAmount && t.riskAmount > 0 ? Math.round((netPnl / t.riskAmount) * 100) / 100 : t.rMultiple,
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
