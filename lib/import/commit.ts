import "server-only";
import { db } from "@/lib/db";
import {
  trades as tradesTable,
  importBatches,
  classificationOverrides,
  riskConfig,
  settings as settingsTable,
  mtmPrices,
} from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { classify } from "@/lib/engine/classify";
import { computeCharges, mtfRateFor } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { ChargeBreakdown, ChargeRates, NormalizedTrade } from "@/lib/engine/types";
import type { Broker, Bucket, Exchange, Segment } from "@/lib/domain/constants";
import { SEGMENT_BUCKET } from "@/lib/domain/constants";
import type { CommitResult, ParsedFile } from "./types";
import { dedupHash } from "./dedup";
import { recordAudit } from "@/lib/audit";

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
  rates: Map<string, ChargeRates>,
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

  const r = findRates(rates, t.broker, cls.segment, cls.exchange);
  const charges = computeCharges(
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

  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;
  // Net non-zero, not just buyQty>sellQty — a pure sell-to-open (short) row has
  // buyQty=0 and must still be OPEN, not silently marked closed.
  const isOpen = t.buyQty !== t.sellQty;
  const riskAmount = defaults.perTradeRisk;
  const rMultiple = riskAmount > 0 ? Math.round((netPnl / riskAmount) * 100) / 100 : null;
  const realisedPct = t.buyValue > 0 && !isOpen ? Math.round((t.grossPnl / t.buyValue) * 10000) / 100 : null;

  return { classification: cls, charges, netPnl, isOpen, dedup, buyOrderCount, sellOrderCount, riskAmount, rMultiple, realisedPct };
}

function loadContext() {
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
  summary: { total: number; newCount: number; dupCount: number; grossPnl: number; chargesTotal: number; netPnl: number };
  reconciliation?: { reported: Record<string, number>; computed: Record<string, number> };
}

export function previewParsedFile(parsed: ParsedFile): PreviewResult {
  const { rates, defaults } = loadContext();
  const overrides = loadOverrides(parsed.broker);
  const existing = new Set(
    db.select({ h: tradesTable.dedupHash }).from(tradesTable).where(eq(tradesTable.broker, parsed.broker)).all().map((r) => r.h),
  );

  const rows: PreviewRow[] = [];
  let grossPnl = 0, chargesTotal = 0, netPnl = 0, dupCount = 0;
  const agg: Record<string, number> = { brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, ipft: 0, gst: 0, dpCharges: 0 };

  for (const t of parsed.trades) {
    const b = buildRow(t, rates, overrides, defaults);
    const isDuplicate = existing.has(b.dedup);
    if (isDuplicate) dupCount++;
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
  };
}

export function commitParsedFile(parsed: ParsedFile, fileName: string): CommitResult {
  const { rates, defaults } = loadContext();
  const overrides = loadOverrides(parsed.broker);

  return db.transaction((tx) => {
    const existing = new Set(
      tx.select({ h: tradesTable.dedupHash }).from(tradesTable).where(eq(tradesTable.broker, parsed.broker)).all().map((r) => r.h),
    );

    const batch = tx
      .insert(importBatches)
      .values({ broker: parsed.broker, fileName, rowCount: parsed.trades.length, status: "completed" })
      .returning({ id: importBatches.id })
      .get();
    const batchId = batch!.id;

    let added = 0, skipped = 0, netPnl = 0;
    const seenInThisFile = new Set<string>();

    for (const t of parsed.trades) {
      const b = buildRow(t, rates, overrides, defaults);
      if (existing.has(b.dedup) || seenInThisFile.has(b.dedup)) {
        skipped++;
        continue;
      }
      seenInThisFile.add(b.dedup);

      tx.insert(tradesTable)
        .values({
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
        })
        .run();
      added++;
      netPnl += b.netPnl;
    }

    tx.update(importBatches)
      .set({ addedCount: added, skippedCount: skipped })
      .where(eq(importBatches.id, batchId))
      .run();

    return {
      batchId,
      broker: parsed.broker,
      fileName,
      added,
      skipped,
      total: parsed.trades.length,
      netPnl: Math.round(netPnl * 100) / 100,
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
  fundedAmount?: number | null;
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
): { id: number | null; duplicate: boolean } {
  const { rates, defaults } = loadContext();

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
    .where(and(eq(tradesTable.broker, t.broker), eq(tradesTable.dedupHash, dedup)))
    .all();
  if (dup.length > 0) return { id: null, duplicate: true };

  const buyOrderCount = t.buyQty > 0 ? fields.buyOrders ?? defaults.buyOrders : 0;
  const sellOrderCount = t.sellQty > 0 ? fields.sellOrders ?? defaults.sellOrders : 0;
  const r = findRates(rates, t.broker, cls.segment, cls.exchange);
  const charges = computeCharges(
    {
      segment: cls.segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount,
      sellOrderCount,
      mtf:
        cls.segment === "eq_mtf" && fields.fundedAmount
          ? { fundedAmount: fields.fundedAmount, daysHeld: fields.daysHeld ?? 0, pledgeScrips: 1 }
          : null,
    },
    r,
  );
  const netPnl = Math.round((t.grossPnl - charges.total) * 100) / 100;
  // Net non-zero, not just buyQty>sellQty — a pure sell-to-open (short option/future)
  // row has buyQty=0 and must still be OPEN, not silently marked closed.
  const isOpen = t.buyQty !== t.sellQty;
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
        asOfDate: new Date().toISOString().slice(0, 10),
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
  const exitDateIso = normalizeDate(exitDate) ?? new Date().toISOString().slice(0, 10);

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

  const { rates } = loadContext();
  const r = findRates(rates, t.broker as Broker, t.segment as Segment, t.exchange as Exchange);

  // MTF interest over the holding period (buy → exit), if this is an MTF position.
  // MTF is equity-only (never a short-open segment), so buyDate is always the entry.
  let mtf: { fundedAmount: number; daysHeld: number; pledgeScrips: number } | null = null;
  if (t.segment === "eq_mtf") {
    const funded = t.buyValue;
    const days = t.buyDate
      ? Math.max(0, Math.floor((new Date(exitDateIso).getTime() - new Date(t.buyDate).getTime()) / 86400000) - 1)
      : 0;
    mtf = { fundedAmount: funded, daysHeld: days, pledgeScrips: 1 };
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
  const { rates } = loadContext();
  const r = findRates(rates, t.broker as Broker, segment, exchange);
  const charges = computeCharges(
    {
      segment,
      buyValue: t.buyValue,
      sellValue: t.sellValue,
      buyQty: t.buyQty,
      sellQty: t.sellQty,
      buyOrderCount: t.buyOrderCount,
      sellOrderCount: t.sellOrderCount,
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
