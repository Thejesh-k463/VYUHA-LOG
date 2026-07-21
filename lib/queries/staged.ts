import "server-only";

import { eq, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades as tradesTable, tradeLegs } from "@/lib/db/schema";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { ChargeRates } from "@/lib/engine/types";
import type { Broker, Segment, Exchange } from "@/lib/domain/constants";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";
import { getMarginPct } from "@/lib/queries/margin";
import { recordAudit } from "@/lib/audit";
import {
  summarise,
  markToMarket,
  parentAggregate,
  legChargeShapes,
  validateLegs,
  sortLegs,
  type Leg,
  type Direction,
  type LegProblem,
} from "@/lib/domain/staged";

/**
 * Server-side half of staged positions: prices each leg with the real charge
 * engine and rebuilds the parent `trades` row from the ladder.
 *
 * All the arithmetic that decides P&L lives in lib/domain/staged.ts (pure,
 * unit-tested). This file only does I/O and charge lookup.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A short position is one whose entries are sells. */
export function directionOf(t: { buyQty: number; sellQty: number; staged?: boolean }, legs?: Leg[]): Direction {
  // For a staged trade the direction is recorded by which side opened it; for
  // legacy rows fall back to the classic heuristic (sell-first == short).
  if (legs && legs.length > 0) {
    // Direction is stored on the parent via buy/sell ordering; callers pass it
    // explicitly where known. Default long — every manual staged trade is
    // created with an explicit direction.
    return t.sellQty > 0 && t.buyQty === 0 ? "short" : "long";
  }
  return t.sellQty > 0 && t.buyQty === 0 ? "short" : "long";
}

export interface DbLegRow {
  id: number;
  tradeId: number;
  kind: string;
  seq: number;
  tradeDate: string;
  tradeTime: string | null;
  qty: number;
  price: number;
  slPlanned: number | null;
  trailingSl: number | null;
  targetPlanned: number | null;
  chargesTotal: number;
  netPnl: number;
  avgCostAtExit: number | null;
  note: string | null;
}

/** Rows straight from the DB, in execution order. */
export function loadLegs(tradeId: number): DbLegRow[] {
  return db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId))
    .orderBy(asc(tradeLegs.seq), asc(tradeLegs.id))
    .all() as DbLegRow[];
}

/** DB rows → the pure module's Leg shape. Money columns already read as
 *  rupees (the moneyPaise custom type converts at the column boundary), so no
 *  scaling happens here — doing it twice was a real bug once. */
export function toDomainLegs(rows: DbLegRow[]): Leg[] {
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === "exit" ? ("exit" as const) : ("entry" as const),
    seq: r.seq,
    tradeDate: r.tradeDate,
    tradeTime: r.tradeTime,
    qty: r.qty,
    price: r.price,
    slPlanned: r.slPlanned,
    trailingSl: r.trailingSl,
    targetPlanned: r.targetPlanned,
    chargesTotal: r.chargesTotal,
    note: r.note,
  }));
}

export interface PricedLeg {
  legId: number;
  chargesTotal: number; // rupees
  breakdown: ReturnType<typeof computeCharges>;
}

/**
 * Prices every leg independently through the real charge engine.
 *
 * Brokerage is per order and STT per execution, so a fill is priced on its
 * own — but DP is levied per scrip per DAY on the debit, so only the first
 * exit of each date carries it. That is enforced by handing the later legs a
 * rate card with dpCharge zeroed, which also removes DP from the GST base.
 *
 * MTF interest is charged per TRANCHE from its own entry date to the date it
 * was consumed (or `asOf` while still open), so a position built in three
 * tranches doesn't get billed as if all the money arrived on day one.
 *
 * KNOWN, ACCEPTED ARTEFACT: STT and stamp duty round to the nearest rupee. A
 * round-trip priced in one call rounds once per statutory head; the same trade
 * priced as two legs rounds twice, so converting an existing trade to staged
 * mode can move its total by up to about ₹2 in the worst case. Measured across
 * every segment on real journal data the observed drift was ≤ ₹1.11. The
 * per-leg figure is the more accurate of the two — statutory charges really
 * are levied per execution — so this is not corrected back.
 */
export function priceLegs(
  legs: Leg[],
  ctx: {
    broker: Broker;
    segment: Segment;
    exchange: Exchange;
    direction: Direction;
    mtfFundedAmount?: number | null;
    asOf?: string;
  },
  ratesMap: Map<string, ChargeRates>,
): PricedLeg[] {
  const rates = findRates(ratesMap, ctx.broker, ctx.segment, ctx.exchange);
  const shapes = legChargeShapes(legs, ctx.direction);
  const ordered = sortLegs(legs);

  // MTF: work out how long each entry tranche's funded money was outstanding.
  const mtfDaysByLeg = new Map<number, number>();
  const mtfFundedByLeg = new Map<number, number>();
  if (ctx.segment === "eq_mtf") {
    const pos = summarise(legs, ctx.direction);
    const asOf = ctx.asOf ?? new Date().toISOString().slice(0, 10);
    const consumedOn = new Map<number, string>();
    for (const fill of pos.fills) {
      for (const c of fill.consumed) {
        // Last consumption date wins — that is when the tranche fully closed.
        consumedOn.set(c.legId, fill.tradeDate);
      }
    }
    const ownPct = getMarginPct(ctx.broker, "eq_mtf");
    for (const leg of ordered) {
      if (leg.kind !== "entry") continue;
      const end = consumedOn.get(leg.id) ?? asOf;
      const days = Math.max(
        0,
        Math.floor((new Date(end).getTime() - new Date(leg.tradeDate).getTime()) / 86400000),
      );
      mtfDaysByLeg.set(leg.id, days);
      mtfFundedByLeg.set(leg.id, defaultMtfFundedAmount(r2(leg.qty * leg.price), ownPct));
    }
  }

  return shapes.map((shape) => {
    // Suppressing DP is done by zeroing the rate, which correctly drops it out
    // of the GST base too rather than subtracting it afterwards.
    const legRates: ChargeRates = shape.suppressDp ? { ...rates, dpCharge: 0 } : rates;

    const mtfDays = mtfDaysByLeg.get(shape.legId);
    const mtfFunded = mtfFundedByLeg.get(shape.legId);

    const breakdown = computeCharges(
      {
        segment: ctx.segment,
        buyValue: shape.buyValue,
        sellValue: shape.sellValue,
        buyQty: shape.buyQty,
        sellQty: shape.sellQty,
        buyOrderCount: shape.buyOrderCount,
        sellOrderCount: shape.sellOrderCount,
        mtf:
          ctx.segment === "eq_mtf" && mtfFunded && mtfFunded > 0 && mtfDays != null
            ? { fundedAmount: mtfFunded, daysHeld: mtfDays, pledgeScrips: 1 }
            : null,
      },
      legRates,
    );

    return { legId: shape.legId, chargesTotal: breakdown.total, breakdown };
  });
}

/** Everything the staged UI needs, fully serialisable for a client component. */
export interface StagedView {
  tradeId: number;
  staged: boolean;
  direction: Direction;
  legs: DbLegRow[];
  position: ReturnType<typeof summarise>;
  mark: ReturnType<typeof markToMarket>;
  markPrice: number | null;
}

/**
 * Read-side view of a staged position. Returns null for a trade that has no
 * ladder, so callers can render the classic single-entry UI unchanged.
 */
export function getStagedView(tradeId: number): StagedView | null {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return null;
  const rows = loadLegs(tradeId);
  if (rows.length === 0) return null;

  const legs = toDomainLegs(rows);
  const dir = directionOf(t as never, legs);
  const position = summarise(legs, dir);
  // Marks come from the same place the trackers read them, so the staged view
  // never disagrees with the position row next to it.
  const markPrice = t.closingPrice ?? null;
  const mark = markToMarket(position, markPrice);

  return { tradeId, staged: !!t.staged, direction: dir, legs: rows, position, mark, markPrice };
}

export interface RebuildResult {
  ok: boolean;
  problems: LegProblem[];
}

/**
 * Reprices every leg, writes the per-leg charge/P&L back, and collapses the
 * ladder into the parent `trades` row so that every existing report, tracker
 * and tax pack keeps reading one flat row exactly as before.
 *
 * Idempotent: running it twice produces the same numbers.
 */
export function rebuildStagedTrade(tradeId: number, direction?: Direction): RebuildResult {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, problems: [{ legId: null, message: "Trade not found." }] };

  const rows = loadLegs(tradeId);
  const legs = toDomainLegs(rows);

  const problems = validateLegs(legs);
  if (problems.length > 0) return { ok: false, problems };

  const dir: Direction = direction ?? directionOf(t as never, legs);
  const ratesMap = loadRatesMap();

  // 1) Price each fill.
  const priced = priceLegs(
    legs,
    {
      broker: t.broker as Broker,
      segment: t.segment as Segment,
      exchange: t.exchange as Exchange,
      direction: dir,
      mtfFundedAmount: t.mtfFundedAmount,
    },
    ratesMap,
  );
  const chargeByLeg = new Map(priced.map((p) => [p.legId, p.chargesTotal]));

  // 2) Replay the ladder WITH those charges so exit P&L is net of them.
  const withCharges: Leg[] = legs.map((l) => ({ ...l, chargesTotal: chargeByLeg.get(l.id) ?? 0 }));
  const pos = summarise(withCharges, dir);
  const agg = parentAggregate(withCharges, dir);

  // 3) Persist per-leg figures.
  const fillByLeg = new Map(pos.fills.map((f) => [f.legId, f]));
  for (const row of rows) {
    const fill = fillByLeg.get(row.id);
    db.update(tradeLegs)
      .set({
        chargesTotal: chargeByLeg.get(row.id) ?? 0,
        netPnl: fill ? fill.netPnl : 0,
        avgCostAtExit: fill ? fill.avgCostAtExit : null,
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(tradeLegs.id, row.id))
      .run();
  }

  // 4) Collapse into the parent. Charges are summed from the legs rather than
  //    recomputed on the aggregate — a position filled in five tranches really
  //    does pay five lots of brokerage, and the round-trip view would hide it.
  const totals = priced.reduce(
    (acc, p) => {
      acc.brokerage += p.breakdown.brokerage;
      acc.sttCtt += p.breakdown.sttCtt;
      acc.exchangeTxn += p.breakdown.exchangeTxn;
      acc.sebi += p.breakdown.sebi;
      acc.stampDuty += p.breakdown.stampDuty;
      acc.ipft += p.breakdown.ipft;
      acc.gst += p.breakdown.gst;
      acc.dpCharges += p.breakdown.dpCharges;
      acc.mtfInterest += p.breakdown.mtfInterest;
      acc.pledgeCharges += p.breakdown.pledgeCharges;
      acc.total += p.breakdown.total;
      return acc;
    },
    {
      brokerage: 0, sttCtt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0,
      ipft: 0, gst: 0, dpCharges: 0, mtfInterest: 0, pledgeCharges: 0, total: 0,
    },
  );

  const grossPnl = pos.realisedGross;
  const netPnl = r2(grossPnl - totals.total);
  const realisedPct = agg.buyValue > 0 ? Math.round((grossPnl / agg.buyValue) * 10000) / 100 : null;
  const rMultiple = pos.initialRisk && pos.initialRisk > 0 ? r2(netPnl / pos.initialRisk) : null;

  db.update(tradesTable)
    .set({
      staged: true,
      buyQty: agg.buyQty,
      avgBuyPrice: agg.avgBuyPrice,
      buyValue: agg.buyValue,
      buyOrderCount: agg.buyOrderCount,
      buyDate: agg.buyDate,
      sellQty: agg.sellQty,
      avgSellPrice: agg.avgSellPrice,
      sellValue: agg.sellValue,
      sellOrderCount: agg.sellOrderCount,
      sellDate: agg.sellDate,
      entryTime: agg.entryTime,
      exitTime: agg.exitTime,
      isOpen: agg.isOpen,
      slPlanned: agg.slPlanned,
      trailingSl: agg.trailingSl,
      targetPlanned: agg.targetPlanned,
      riskAmount: agg.riskAmount,
      grossPnl,
      chargesTotal: totals.total,
      netPnl,
      realisedPct,
      rMultiple,
      brokerage: totals.brokerage,
      sttCtt: totals.sttCtt,
      exchangeTxn: totals.exchangeTxn,
      sebi: totals.sebi,
      stampDuty: totals.stampDuty,
      ipft: totals.ipft,
      gst: totals.gst,
      dpCharges: totals.dpCharges,
      mtfInterest: totals.mtfInterest,
      pledgeCharges: totals.pledgeCharges,
      // Unrealised is owned by the MTM path, not by the ladder.
      unrealisedPnl: agg.isOpen ? t.unrealisedPnl : 0,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(tradesTable.id, tradeId))
    .run();

  return { ok: true, problems: [] };
}

/** Next execution sequence for a trade. */
export function nextSeq(tradeId: number): number {
  const rows = loadLegs(tradeId);
  return rows.reduce((m, r) => Math.max(m, r.seq), 0) + 1;
}

export interface AddLegInput {
  tradeId: number;
  kind: "entry" | "exit";
  tradeDate: string;
  tradeTime?: string | null;
  qty: number;
  price: number;
  slPlanned?: number | null;
  trailingSl?: number | null;
  targetPlanned?: number | null;
  note?: string | null;
  direction?: Direction;
}

export interface LegMutationResult {
  ok: boolean;
  message: string;
  problems?: LegProblem[];
}

/**
 * Appends a fill and reprices the whole ladder.
 *
 * Validation runs on the PROSPECTIVE ladder before anything is written, so a
 * rejected exit never leaves a half-applied position behind.
 */
export function addLeg(input: AddLegInput): LegMutationResult {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, input.tradeId)).get();
  if (!t) return { ok: false, message: "Trade not found." };

  const existing = toDomainLegs(loadLegs(input.tradeId));
  const seq = existing.reduce((m, l) => Math.max(m, l.seq), 0) + 1;

  const prospective: Leg[] = [
    ...existing,
    {
      id: -1,
      kind: input.kind,
      seq,
      tradeDate: input.tradeDate,
      tradeTime: input.tradeTime ?? null,
      qty: input.qty,
      price: input.price,
      slPlanned: input.slPlanned ?? null,
      trailingSl: input.trailingSl ?? null,
      targetPlanned: input.targetPlanned ?? null,
    },
  ];
  const problems = validateLegs(prospective);
  if (problems.length > 0) {
    return { ok: false, message: problems[0].message, problems };
  }

  db.insert(tradeLegs)
    .values({
      tradeId: input.tradeId,
      kind: input.kind,
      seq,
      tradeDate: input.tradeDate,
      tradeTime: input.tradeTime ?? null,
      qty: input.qty,
      price: input.price,
      slPlanned: input.slPlanned ?? null,
      trailingSl: input.trailingSl ?? null,
      targetPlanned: input.targetPlanned ?? null,
      note: input.note ?? null,
    })
    .run();

  const res = rebuildStagedTrade(input.tradeId, input.direction);
  if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not rebuild position.", problems: res.problems };

  recordAudit({
    entity: "trade",
    entityId: input.tradeId,
    action: input.kind === "entry" ? "leg_add_entry" : "leg_add_exit",
    summary: `${t.symbol} ${input.kind} ${input.qty} @ ${input.price}`,
    after: { kind: input.kind, qty: input.qty, price: input.price, date: input.tradeDate },
  });

  return { ok: true, message: input.kind === "entry" ? "Entry added." : "Exit booked." };
}

export function updateLeg(
  legId: number,
  patch: Partial<Pick<DbLegRow, "qty" | "price" | "slPlanned" | "trailingSl" | "targetPlanned" | "tradeDate" | "tradeTime" | "note">>,
  direction?: Direction,
): LegMutationResult {
  const row = db.select().from(tradeLegs).where(eq(tradeLegs.id, legId)).get();
  if (!row) return { ok: false, message: "Leg not found." };

  const existing = toDomainLegs(loadLegs(row.tradeId));
  const prospective = existing.map((l) =>
    l.id === legId
      ? {
          ...l,
          qty: patch.qty ?? l.qty,
          price: patch.price ?? l.price,
          slPlanned: patch.slPlanned !== undefined ? patch.slPlanned : l.slPlanned,
          trailingSl: patch.trailingSl !== undefined ? patch.trailingSl : l.trailingSl,
          targetPlanned: patch.targetPlanned !== undefined ? patch.targetPlanned : l.targetPlanned,
          tradeDate: patch.tradeDate ?? l.tradeDate,
        }
      : l,
  );
  const problems = validateLegs(prospective);
  if (problems.length > 0) return { ok: false, message: problems[0].message, problems };

  db.update(tradeLegs)
    .set({ ...patch, updatedAt: sql`(datetime('now'))` })
    .where(eq(tradeLegs.id, legId))
    .run();

  const res = rebuildStagedTrade(row.tradeId, direction);
  if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not rebuild position." };

  recordAudit({
    entity: "trade",
    entityId: row.tradeId,
    action: "leg_edit",
    summary: `leg #${legId} edited`,
    before: { qty: row.qty, price: row.price, slPlanned: row.slPlanned, trailingSl: row.trailingSl },
    after: patch as Record<string, unknown>,
  });

  return { ok: true, message: "Leg updated." };
}

export function deleteLeg(legId: number, direction?: Direction): LegMutationResult {
  const row = db.select().from(tradeLegs).where(eq(tradeLegs.id, legId)).get();
  if (!row) return { ok: false, message: "Leg not found." };

  const remaining = toDomainLegs(loadLegs(row.tradeId)).filter((l) => l.id !== legId);
  if (remaining.length > 0) {
    const problems = validateLegs(remaining);
    if (problems.length > 0) {
      return {
        ok: false,
        message: `Removing this leg would break the ladder: ${problems[0].message}`,
        problems,
      };
    }
  }

  db.delete(tradeLegs).where(eq(tradeLegs.id, legId)).run();

  if (remaining.length === 0) {
    // Last leg gone — drop back to a plain trade rather than leaving an empty
    // staged shell that every report would have to special-case.
    db.update(tradesTable)
      .set({ staged: false, updatedAt: sql`(datetime('now'))` })
      .where(eq(tradesTable.id, row.tradeId))
      .run();
  } else {
    const res = rebuildStagedTrade(row.tradeId, direction);
    if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not rebuild position." };
  }

  recordAudit({
    entity: "trade",
    entityId: row.tradeId,
    action: "leg_delete",
    summary: `leg #${legId} removed (${row.kind} ${row.qty} @ ${row.price})`,
    before: { kind: row.kind, qty: row.qty, price: row.price },
  });

  return { ok: true, message: "Leg removed." };
}

/**
 * Writes one stop across every OPEN entry tranche — the "apply to all" button.
 * Closed tranches are left alone: rewriting the stop on a tranche you already
 * exited would falsify the record of what you actually did.
 */
export function applyStopToOpenTranches(
  tradeId: number,
  stop: { slPlanned?: number | null; trailingSl?: number | null },
  direction?: Direction,
): LegMutationResult {
  const rows = loadLegs(tradeId);
  const legs = toDomainLegs(rows);
  const pos = summarise(legs, direction ?? "long");
  const openIds = new Set(pos.openTranches.map((t) => t.legId));
  if (openIds.size === 0) return { ok: false, message: "No open tranches to update." };

  for (const id of openIds) {
    db.update(tradeLegs)
      .set({
        ...(stop.slPlanned !== undefined ? { slPlanned: stop.slPlanned } : {}),
        ...(stop.trailingSl !== undefined ? { trailingSl: stop.trailingSl } : {}),
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(tradeLegs.id, id))
      .run();
  }

  const res = rebuildStagedTrade(tradeId, direction);
  if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not rebuild position." };

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "leg_stop_all",
    summary: `stop applied to ${openIds.size} open tranche(s)`,
    after: stop as Record<string, unknown>,
  });

  return { ok: true, message: `Stop applied to ${openIds.size} open tranche(s).` };
}

/**
 * Converts a classic single-entry trade into a staged one by seeding the
 * ladder from what it already holds. Non-destructive: the numbers it produces
 * are identical to the flat row it replaces, which is exactly why a one-entry
 * ladder must aggregate back to itself.
 */
export function convertToStaged(tradeId: number): LegMutationResult {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, message: "Trade not found." };
  if (t.staged) return { ok: true, message: "Already a staged position." };
  if (loadLegs(tradeId).length > 0) return { ok: true, message: "Already has legs." };

  const isShort = t.sellQty > 0 && t.buyQty === 0;
  const dir: Direction = isShort ? "short" : "long";
  const today = new Date().toISOString().slice(0, 10);

  const entryQty = isShort ? t.sellQty : t.buyQty;
  const exitQty = isShort ? t.buyQty : t.sellQty;
  const entryDate = (isShort ? t.sellDate : t.buyDate) ?? today;
  const exitDate = (isShort ? t.buyDate : t.sellDate) ?? today;

  // Rebuild the fill price from VALUE ÷ QTY rather than the stored average.
  // avg_buy_price is rounded to 2dp for display; on a 1,500-lot option that
  // half-paisa becomes several rupees of gross drift when the ladder
  // recomputes qty × price. Deriving from the value keeps the conversion
  // lossless, which is the whole promise of turning staged mode on.
  const px = (value: number, qty: number, fallback: number) =>
    qty > 0 ? Math.round((value / qty) * 1e6) / 1e6 : fallback;

  const entryPrice = isShort
    ? px(t.sellValue, entryQty, t.avgSellPrice)
    : px(t.buyValue, entryQty, t.avgBuyPrice);
  const exitPrice = isShort
    ? px(t.buyValue, exitQty, t.avgBuyPrice)
    : px(t.sellValue, exitQty, t.avgSellPrice);

  if (!(entryQty > 0)) return { ok: false, message: "This trade has no entry quantity to stage." };

  let seq = 1;
  db.insert(tradeLegs)
    .values({
      tradeId,
      kind: "entry",
      seq: seq++,
      tradeDate: entryDate,
      tradeTime: t.entryTime,
      qty: entryQty,
      price: entryPrice,
      slPlanned: t.slPlanned,
      trailingSl: t.trailingSl,
      targetPlanned: t.targetPlanned,
      note: "Seeded from the original single entry",
    })
    .run();

  if (exitQty > 0) {
    db.insert(tradeLegs)
      .values({
        tradeId,
        kind: "exit",
        seq: seq++,
        tradeDate: exitDate,
        tradeTime: t.exitTime,
        qty: exitQty,
        price: exitPrice,
        note: "Seeded from the original exit",
      })
      .run();
  }

  const res = rebuildStagedTrade(tradeId, dir);
  if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not build the ladder." };

  recordAudit({
    entity: "trade",
    entityId: tradeId,
    action: "staged_enable",
    summary: `${t.symbol} converted to a staged position`,
  });

  return { ok: true, message: "Staged mode enabled." };
}
