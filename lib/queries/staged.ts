import "server-only";

import { eq, asc, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades as tradesTable, tradeLegs } from "@/lib/db/schema";
import { computeCharges } from "@/lib/engine/charges";
import { ratesForTrade, resolvePlan, type PlanAccount, type RatesMap } from "@/lib/engine/rates";
import { todayIstIso, normalizeDate, unreadableDateMessage, calendarDaysHeld } from "@/lib/domain/trading-day";
import { sideOf, type SideInput } from "@/lib/domain/side";
import { loadRatesMap } from "@/lib/engine/rates-db";
import type { ChargeRates } from "@/lib/engine/types";
import type { Broker, Segment, Exchange } from "@/lib/domain/constants";
// D6/D7 (wave 2O): no margin_config read is left in the ladder — `getMarginPct`
// and `defaultMtfFundedAmount` are gone from this file, so no stored figure on a
// staged row is a function of that table (owner ruling Q-A, invariant 6).
import { recordAudit } from "@/lib/audit";
import { getSelectedAccountId } from "./accounts";
import { planAccountOf } from "./broker-plan";
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
export function directionOf(t: SideInput & { staged?: boolean }, _legs?: Leg[]): Direction {
  // NOT buyQty === 0: a short that has been PARTIALLY covered has buyQty > 0,
  // and the === 0 test flipped it long — which sign-inverted the P&L rebuilt
  // onto the parent row. v4.6.0 W6: the stored direction column landed —
  // `sideOf` reads the quantities, and a FLAT (fully closed) row its `side`, so
  // a closed short ladder rebuilds as the short it is.
  return sideOf(t);
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
/**
 * The trade behind a MUTATION — only if the user's view can reach it.
 *
 * Enforced here, not trusted from the caller, exactly like
 * `deleteTradesByIds` (invariant 8): a stale panel or a hand-made request
 * carries a raw trade id, and until 2026-08-12 every leg mutation in this
 * file accepted it unchecked — the one query module that touched an
 * account-scoped table without the guard (defect D17). Reads stay unscoped
 * (a view over ids the caller already resolved); WRITES go through this.
 */
function loadOwnTrade(tradeId: number) {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return null;
  const accountId = getSelectedAccountId();
  if (accountId !== 0 && t.accountId !== accountId) return null;
  return t;
}

const NOT_YOURS = { ok: false as const, message: "That trade is not in the account you are viewing." };

export function loadLegs(tradeId: number): DbLegRow[] {
  return db
    .select()
    .from(tradeLegs)
    .where(eq(tradeLegs.tradeId, tradeId))
    .orderBy(asc(tradeLegs.seq), asc(tradeLegs.id))
    .all() as DbLegRow[];
}

/**
 * D5 (v4.3.0 fix wave 2P) — ONE leg-count question. The query below was copied
 * six times across the editor, the close, the override, the preview route, the
 * /ipos route and the IPO push (`t.staged || legCount > 0`), and the accrual job
 * had none: it rebuilt a `staged`-flagged row with ZERO legs from an empty
 * ladder on every /equity render (`buyQty / buyValue / chargesTotal / netPnl → 0`).
 * `closeStaleLot` keeps its own copy inside its transaction — a transaction
 * cannot borrow a non-transactional helper — and `tests/wave2p-mtf-dates.test.ts`
 * pins that this literal appears nowhere else.
 */
export function legCountOf(tradeId: number): number {
  return db.select({ id: tradeLegs.id }).from(tradeLegs).where(eq(tradeLegs.tradeId, tradeId)).all().length;
}

/** Is this row a ladder — flagged staged, or holding any leg at all? */
export function hasLadder(t: { staged?: boolean | null }, tradeId: number): boolean {
  return !!t.staged || legCountOf(tradeId) > 0;
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
 * THE PRINCIPAL IS THE ONE THE ROW STATES, NEVER AN ESTIMATE (D6/D7, v4.3.0 fix
 * wave 2O — mtf#0 and mtf#1, two silent wrong numbers). This function used to
 * price every entry tranche on `defaultMtfFundedAmount(leg value, margin_config)`
 * while `ctx.mtfFundedAmount` — the amount the parent row actually records — sat
 * unread, and `rebuildStagedTrade` collapses these legs into the parent's stored
 * `mtf_interest` / `charges_total` / `net_pnl`. That made the ladder the FIFTH
 * writer of stored MTF interest, the one owner ruling Q-A ("no writer persists an
 * estimate", wave 2N) was never applied to: a null-funded staged row stored 71.38
 * of interest on `convertToStaged`, the accrual job took it straight back out on
 * the next /equity render, and `addLeg` put it back — stored money oscillating
 * with no prompt and no audit row (DECISIONS 2026-08-30 decision 6). So:
 *
 *   - `mtfFundedAmount` null (never recorded) → nothing is billed, exactly as
 *     closePosition / updateManualTrade / applyOverride / closeStaleLot and the
 *     accrual job now leave it. `lib/engine/charges.ts:106` gates interest AND
 *     pledge on the same `fundedAmount > 0`, so this is identical to a stated 0
 *     (the recorded deviation, DECISIONS 2026-09-16 wave 2N);
 *   - a stated 0 → nothing is billed (V3/X2: a stored 0 is a STATEMENT, the
 *     position paid for in full, not "never set");
 *   - a stated amount → APPORTIONED across the entry tranches by tranche value
 *     (owner ruling, 2O row 2: `stated × legValue ÷ Σ entry legValue`, which is
 *     invariant 4's weighted rule), so the shares sum to the stated principal
 *     and Σ per-leg interest equals what the accrual job bills on the whole leg
 *     for the same spans. The ladder is now the SINGLE writer of a staged row's
 *     charges (`lib/jobs/mtf-accrual.ts` skips `staged` rows and re-prices them
 *     through `rebuildStagedTrade`), so the two doors cannot state two answers.
 *
 * No margin_config read is left in the ladder's pricing path, so no stored
 * figure moves when that table moves.
 *
 * KNOWN, ACCEPTED ARTEFACT: STT and stamp duty round to the nearest rupee, and
 * MTF interest (D3, wave 2P) rounds to the paisa PER TRANCHE. A round-trip
 * priced in one call rounds once per statutory head; the same trade priced as
 * two legs rounds twice, so converting an existing trade to staged mode can
 * move its total by up to about ₹2 in the worst case. Measured across every
 * segment on real journal data the observed drift was ≤ ₹1.11; for MTF
 * interest it is at most a paisa per extra tranche (dhan 8L in two same-day
 * tranches: 2 × 2,808.88 = 5,617.76 beside the job's 5,617.75). The per-leg
 * figure is the more accurate of the two — statutory charges really are levied
 * per execution — so this is not corrected back.
 *
 * D3 (wave 2P): a TIERED broker's slab is evaluated on the row's whole STATED
 * principal (`slabBasis`), and each tranche bills its share at that rate — the
 * slab is the broker's price for the size of the book it finances, not for
 * the journal's bookkeeping unit. Rating each share on its own size under-priced
 * a Dhan row straddling a boundary by ₹416.43 and made the figure depend on how
 * many fills a position happened to have.
 *
 * D1 (wave 2P, owner ruling 2O row 1 — "no stored money on a closed trade moves
 * without the owner's say-so"): `ctx.mtfCarry` is the interest and pledge a
 * CLOSED null-funded ladder stored before 4.3.0. It is apportioned across the
 * entry tranches — interest by tranche value × the tranche's own billed days
 * (the two factors the estimate was computed from; value alone when every
 * weight is 0), pledge equally (the legacy ladder billed one pledge+unpledge per
 * entry leg) — remainder on the last tranche, so Σ shares is the stored figure
 * to the paisa (invariant 1) and parent = Σ legs (invariant 5). The engine bills
 * the carry as is and derives GST on the carried pledge itself (invariant 3);
 * every OTHER head is priced fresh from the fills. Never applied beside a stated
 * principal: a stated principal is billed by the D3 rule.
 */
export function priceLegs(
  legs: Leg[],
  ctx: {
    broker: Broker;
    segment: Segment;
    exchange: Exchange;
    direction: Direction;
    /**
     * v4.5.0 wave 3a — the instrument, so `ratesForTrade` can apply the ETF STT
     * overlay (ruling R90). A ladder is priced through the SAME entry point as a
     * flat trade; without these two keys a staged NIFTYBEES ladder billed the
     * equity-share delivery STT on every leg. Optional: omitted, the overlay
     * cannot fire and pricing is exactly what it was.
     */
    isin?: string | null;
    symbol?: string | null;
    mtfFundedAmount?: number | null;
    asOf?: string;
    /** D1 — the stored MTF figures of a closed null-funded ladder, kept through this rebuild. */
    mtfCarry?: { mtfInterest: number; pledgeCharges: number } | null;
    /**
     * Wave U — the plan facts of the account this ladder belongs to. The plan
     * is resolved PER LEG, on the leg's own `tradeDate`: a ladder can straddle
     * the day the account moved to a paid tier, and a tranche filled before it
     * was billed at the old rate. The rate EPOCH is still the ladder's single
     * `asOf` (the stated approximation in this module's header, unchanged) —
     * only the plan varies per leg. Omitted = every leg prices on "default",
     * exactly as before this existed.
     */
    planAccount?: PlanAccount | null;
  },
  ratesMap: RatesMap,
): PricedLeg[] {
  const pricingDay = ctx.asOf ?? todayIstIso();
  // One lookup per distinct plan, not per leg.
  const ratesByPlan = new Map<string, ChargeRates>();
  const ratesOnPlan = (plan: string): ChargeRates => {
    const hit = ratesByPlan.get(plan);
    if (hit) return hit;
    const r = ratesForTrade(
      ratesMap,
      { broker: ctx.broker, segment: ctx.segment, exchange: ctx.exchange, isin: ctx.isin, symbol: ctx.symbol },
      pricingDay,
      plan,
    );
    ratesByPlan.set(plan, r);
    return r;
  };
  const legDate = new Map(legs.map((l) => [l.id, l.tradeDate]));
  const planForLeg = (legId: number): string =>
    resolvePlan(ctx.planAccount ?? null, ctx.broker, normalizeDate(legDate.get(legId) ?? null) ?? pricingDay, ratesMap);
  // Resolved eagerly, as the single `findRates` call here always was: a ladder
  // whose broker has no rate epoch covering `asOf` must THROW before anything
  // is written, which is what `lib/jobs/mtf-accrual.ts` catches to skip the row.
  ratesOnPlan(resolvePlan(ctx.planAccount ?? null, ctx.broker, pricingDay, ratesMap));
  const shapes = legChargeShapes(legs, ctx.direction);
  const ordered = sortLegs(legs);

  // MTF: work out how long each entry tranche's funded money was outstanding.
  const mtfDaysByLeg = new Map<number, number>();
  const mtfFundedByLeg = new Map<number, number>();
  const mtfCarryByLeg = new Map<number, { mtfInterest: number; pledgeCharges: number }>();
  // D3: the principal the slab is evaluated on — the row's, for every tranche.
  const slabBasis = ctx.mtfFundedAmount ?? undefined;
  if (ctx.segment === "eq_mtf") {
    const pos = summarise(legs, ctx.direction);
    const asOf = ctx.asOf ?? todayIstIso();
    // Q-B (owner ruling, wave 2N) in the ladder (D7's revision, wave 2O): a
    // tranche that is only PARTLY consumed keeps accruing on its whole share
    // until it CLOSES — no funding is treated as released for the units already
    // sold, because how a broker releases it is the broker's rule. Taking the
    // last consumption date unconditionally billed a partly sold tranche only to
    // that partial sale's day, while the accrual job billed the same row to
    // today. `pos.openTranches` is the domain's own answer to "what is still
    // open", so a tranche listed there has no consumption date at all.
    const stillOpen = new Set(pos.openTranches.map((o) => o.legId));
    const consumedOn = new Map<number, string>();
    for (const fill of pos.fills) {
      for (const c of fill.consumed) {
        if (stillOpen.has(c.legId)) continue;
        // Last consumption date wins — that is when the tranche fully closed.
        consumedOn.set(c.legId, fill.tradeDate);
      }
    }
    // The principal the ROW states, split by tranche value (D6/D7 — see the
    // header). The shares are rounded per tranche with the REMAINDER on the last
    // one, so Σ shares is the stated principal to the paisa (invariant 1: money
    // is exact, and a lost paisa here is a lost paisa of stored interest).
    const stated = ctx.mtfFundedAmount;
    const entries = ordered.filter((l) => l.kind === "entry");
    const entryValue = new Map(entries.map((l) => [l.id, r2(l.qty * l.price)]));
    const totalEntryValue = r2([...entryValue.values()].reduce((s, v) => s + v, 0));
    // `stated != null`, never a truthiness or `> 0` test: a stated 0 must reach
    // the apportionment and come out as a share of 0 (which the engine bills
    // nothing for), not fall into the "never recorded" branch — the null-vs-0
    // rule every writer and reader keeps (V3/X2, tests/helpers/field-rules.ts).
    if (stated != null && totalEntryValue > 0) {
      let allocated = 0;
      entries.forEach((leg, i) => {
        const share =
          i === entries.length - 1
            ? r2(stated - allocated)
            : r2((stated * (entryValue.get(leg.id) ?? 0)) / totalEntryValue);
        allocated = r2(allocated + share);
        mtfFundedByLeg.set(leg.id, share);
      });
    }
    for (const leg of entries) {
      const end = consumedOn.get(leg.id) ?? asOf;
      // G-G3-1 — BOTH ends resolved through the one calendar (lib/domain/trading-day)
      // before any day is counted. A raw `new Date(leg.tradeDate)` rolled '2026-02-31'
      // forward to 3 March and billed seven months of interest, and made 'not-a-date'
      // NaN all the way into the INSERT. `validateLegs` now refuses either before a
      // write, so an unresolvable leg date is unreachable through the writers; it
      // counts ZERO days here rather than inventing one (invariant 6).
      // D7 (wave 2P) — the ONE day count every writer prices by (`calendarDaysHeld`,
      // lib/domain/trading-day): 0 for a date that states no day. Both ends are
      // resolved here first (tests/readers-follow-writers.test.ts pins the read
      // half by name), and the shared count is idempotent over an ISO day.
      const legDay = normalizeDate(leg.tradeDate);
      const endDay = normalizeDate(end) ?? asOf;
      mtfDaysByLeg.set(leg.id, legDay ? calendarDaysHeld(legDay, endDay) : 0);
    }
    // D1 — the carry, only when the row states NO principal (see the header).
    if (stated == null && ctx.mtfCarry && entries.length > 0) {
      const carry = ctx.mtfCarry;
      const byDays = entries.map((l) => (entryValue.get(l.id) ?? 0) * (mtfDaysByLeg.get(l.id) ?? 0));
      const totalByDays = byDays.reduce((s, w) => s + w, 0);
      // Value × days is what the legacy estimate was computed from; value alone
      // when every tranche billed 0 days (all on asOf), so the split still exists.
      const weights = totalByDays > 0 ? byDays : entries.map((l) => entryValue.get(l.id) ?? 0);
      const totalWeight = weights.reduce((s, w) => s + w, 0);
      let interestAllocated = 0;
      let pledgeAllocated = 0;
      entries.forEach((leg, i) => {
        const last = i === entries.length - 1;
        const interest = last
          ? r2(carry.mtfInterest - interestAllocated)
          : totalWeight > 0
            ? r2((carry.mtfInterest * weights[i]) / totalWeight)
            : 0;
        const pledge = last ? r2(carry.pledgeCharges - pledgeAllocated) : r2(carry.pledgeCharges / entries.length);
        interestAllocated = r2(interestAllocated + interest);
        pledgeAllocated = r2(pledgeAllocated + pledge);
        mtfCarryByLeg.set(leg.id, { mtfInterest: interest, pledgeCharges: pledge });
      });
    }
  }

  return shapes.map((shape) => {
    // Suppressing DP is done by zeroing the rate, which correctly drops it out
    // of the GST base too rather than subtracting it afterwards.
    const ownRates = ratesOnPlan(planForLeg(shape.legId));
    const legRates: ChargeRates = shape.suppressDp ? { ...ownRates, dpCharge: 0 } : ownRates;

    const mtfDays = mtfDaysByLeg.get(shape.legId);
    const mtfFunded = mtfFundedByLeg.get(shape.legId);
    const mtfCarry = mtfCarryByLeg.get(shape.legId);

    const breakdown = computeCharges(
      {
        segment: ctx.segment,
        buyValue: shape.buyValue,
        sellValue: shape.sellValue,
        buyQty: shape.buyQty,
        sellQty: shape.sellQty,
        buyOrderCount: shape.buyOrderCount,
        sellOrderCount: shape.sellOrderCount,
        // A tranche of a row that states NO principal carries no share at all,
        // so nothing MTF reaches the engine and it bills neither interest nor
        // pledge — identical to the stated 0 that DOES reach it, because
        // `lib/engine/charges.ts:106` gates both on the same `fundedAmount > 0`
        // (the recorded deviation, DECISIONS 2026-09-16 wave 2N; billing pledge
        // alone would need an engine change, which was not made).
        //
        // D1: a CLOSED null-funded ladder's stored estimate reaches the engine as a
        // `carry` (fundedAmount 0, nothing rated). D3: a stated tranche carries the
        // row's principal as `slabBasis`, so the slab is the row's, the share its own.
        mtf:
          ctx.segment === "eq_mtf" && mtfDays != null && mtfCarry
            ? { fundedAmount: 0, daysHeld: mtfDays, pledgeScrips: 1, carry: mtfCarry }
            : ctx.segment === "eq_mtf" && mtfFunded != null && mtfDays != null
              ? { fundedAmount: mtfFunded, daysHeld: mtfDays, pledgeScrips: 1, ...(slabBasis != null ? { slabBasis } : {}) }
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
function buildStagedView(t: typeof tradesTable.$inferSelect, rows: DbLegRow[]): StagedView {
  const legs = toDomainLegs(rows);
  const dir = directionOf(t as never, legs);
  const position = summarise(legs, dir);
  // Marks come from the same place the trackers read them, so the staged view
  // never disagrees with the position row next to it.
  const markPrice = t.closingPrice ?? null;
  const mark = markToMarket(position, markPrice);
  return { tradeId: t.id, staged: !!t.staged, direction: dir, legs: rows, position, mark, markPrice };
}

/**
 * Staged views for MANY trades in two queries total. The per-id variant below
 * costs 2 queries each; /risk called it in a loop over every open staged
 * position (audited 2026-08-10 as the page's N+1). Ids without legs are
 * simply absent from the result, same contract as the null return below.
 */
export function getStagedViews(tradeIds: number[]): Map<number, StagedView> {
  const out = new Map<number, StagedView>();
  if (tradeIds.length === 0) return out;
  const ts = db.select().from(tradesTable).where(inArray(tradesTable.id, tradeIds)).all();
  const legRows = db
    .select()
    .from(tradeLegs)
    .where(inArray(tradeLegs.tradeId, tradeIds))
    .orderBy(asc(tradeLegs.tradeId), asc(tradeLegs.seq), asc(tradeLegs.id))
    .all() as DbLegRow[];
  const legsByTrade = new Map<number, DbLegRow[]>();
  for (const r of legRows) {
    const arr = legsByTrade.get(r.tradeId) ?? [];
    arr.push(r);
    legsByTrade.set(r.tradeId, arr);
  }
  for (const t of ts) {
    const rows = legsByTrade.get(t.id);
    if (rows && rows.length > 0) out.set(t.id, buildStagedView(t, rows));
  }
  return out;
}

export function getStagedView(tradeId: number): StagedView | null {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return null;
  const rows = loadLegs(tradeId);
  if (rows.length === 0) return null;
  return buildStagedView(t, rows);
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
 *
 * `asOf` is the day an OPEN MTF tranche's interest is counted to (D6, wave 2O):
 * the daily accrual job hands it its own `today` so one run states one day for
 * every row, flat or staged. Omitted — every UI writer — it is today, as before.
 */
export function rebuildStagedTrade(tradeId: number, direction?: Direction, asOf?: string): RebuildResult {
  const t = db.select().from(tradesTable).where(eq(tradesTable.id, tradeId)).get();
  if (!t) return { ok: false, problems: [{ legId: null, message: "Trade not found." }] };

  const rows = loadLegs(tradeId);
  const legs = toDomainLegs(rows);

  const problems = validateLegs(legs);
  if (problems.length > 0) return { ok: false, problems };

  const dir: Direction = direction ?? directionOf(t as never, legs);
  const ratesMap = loadRatesMap();

  // D1 (v4.3.0 wave 2P, mtf-staged#0 — OWNER RULING 2O row 1: "leave the closed
  // rows alone — no stored money on a closed trade moves without the owner's
  // say-so"). A staged parent that is CLOSED as stored, states no funded amount
  // and holds an MTF figure keeps that figure through THIS rebuild — the editor's
  // hand-back on a notes-only save, a leg-note edit, a stop edit, a conversion —
  // where it used to be released (+₹80.20 of interest, pledge and its GST on the
  // finding's row, from a save that touched only the notes). An OPEN one still
  // bills 0 (Q-A). The gate is the STORED `isOpen`, deliberately: a row closed
  // BEFORE 4.3.0 is the ruling's row; an open legacy row whose closing exit leg
  // triggers this rebuild is open at that moment, so it is released and closes at
  // 0 — a row closed after 4.3.0 is not protected. Two consequences, accepted:
  // a `deleteLeg` / `updateLeg` that RE-OPENS such a ladder applies the carry to
  // the reopened row and the job's next run releases it once (edit-and-undo loses
  // it); and a closed row stating 0 with a pre-2O estimate is not this class (a
  // stated 0 is a statement) and is released on its next rebuild. The
  // `mtfFundedAmount == null` read is the null-vs-0 idiom every reader keeps.
  const mtfCarry =
    t.segment === "eq_mtf" && !t.isOpen && t.mtfFundedAmount == null && (t.mtfInterest > 0 || t.pledgeCharges > 0)
      ? { mtfInterest: t.mtfInterest, pledgeCharges: t.pledgeCharges }
      : null;

  // 1) Price each fill.
  const priced = priceLegs(
    legs,
    {
      broker: t.broker as Broker,
      segment: t.segment as Segment,
      exchange: t.exchange as Exchange,
      direction: dir,
      // Wave 3a — the ETF STT overlay's two keys, from the parent row.
      isin: t.isin,
      symbol: t.symbol,
      mtfFundedAmount: t.mtfFundedAmount,
      mtfCarry,
      // Wave U — the plan of the account this ladder belongs to, per leg date.
      planAccount: planAccountOf(t.accountId),
      ...(asOf ? { asOf } : {}),
    },
    ratesMap,
  );
  const chargeByLeg = new Map(priced.map((p) => [p.legId, p.chargesTotal]));

  // 2) Replay the ladder WITH those charges so exit P&L is net of them.
  const withCharges: Leg[] = legs.map((l) => ({ ...l, chargesTotal: chargeByLeg.get(l.id) ?? 0 }));
  const pos = summarise(withCharges, dir);
  const agg = parentAggregate(withCharges, dir);

  // 3) Persist per-leg figures.
  //
  // ATOMICITY, not speed. This loop and the parent collapse at the end of the
  // function were previously unwrapped writes — this module had NO transaction
  // at all — so a crash, a kill, or a power loss between them left the legs
  // repriced and the parent aggregate stale. That silently breaks invariant 5
  // ("the parent trades row always holds the aggregate"), and nothing on screen
  // looks wrong: every report reads the flat parent row, which would be quietly
  // describing a ladder that no longer exists. A 500-leg position is 501
  // separate commits, each its own fsync, with 500 windows to be interrupted in.
  //
  // The whole rebuild is now one transaction: the legs and the aggregate they
  // roll up into either both land or neither does.
  const fillByLeg = new Map(pos.fills.map((f) => [f.legId, f]));
  db.transaction((tx) => {
    for (const row of rows) {
      const fill = fillByLeg.get(row.id);
      tx.update(tradeLegs)
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

    tx.update(tradesTable)
    .set({
      staged: true,
      // v4.6.0 W6: the ladder's direction is the side that opened it — a first
      // entry leg that SELLS makes a short, and a rebuild never flips it.
      side: dir,
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
      // D1 (v4.4.0): a staged R is frozen at the first entry (invariant 4) and
      // never re-priced by a cap edit; no first-entry stop → no risk, no source.
      riskSource: agg.riskAmount != null ? "frozen" : null,
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
  });

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
  const t = loadOwnTrade(input.tradeId);
  if (!t) return NOT_YOURS;

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

  // The NORMALISED day is what is stored (G-G3-1): `validateLegs` above has
  // already proved this date readable, and storing '31-08-2026' as typed would
  // leave `sortLegs`'s string ordering and every leg-date reader with two
  // conventions in one column. Same rule as `updateManualTrade`'s buy/sell date.
  const tradeDate = normalizeDate(input.tradeDate)!;

  db.insert(tradeLegs)
    .values({
      tradeId: input.tradeId,
      kind: input.kind,
      seq,
      tradeDate,
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
    after: { kind: input.kind, qty: input.qty, price: input.price, date: tradeDate },
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
  if (!loadOwnTrade(row.tradeId)) return NOT_YOURS;

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

  // The stored day is the normalised one, as in `addLeg` — validated above.
  const written = {
    ...patch,
    ...(patch.tradeDate !== undefined ? { tradeDate: normalizeDate(patch.tradeDate)! } : {}),
  };

  db.update(tradeLegs)
    .set({ ...written, updatedAt: sql`(datetime('now'))` })
    .where(eq(tradeLegs.id, legId))
    .run();

  const res = rebuildStagedTrade(row.tradeId, direction);
  if (!res.ok) return { ok: false, message: res.problems[0]?.message ?? "Could not rebuild position." };

  // ONE key list, BOTH snapshots projected from the row read before the write
  // (lib/audit.ts, the single-binding convention). `after: patch` described a
  // different set of columns from `before`: a date-only edit — the very edit this
  // wave validates — threw `AuditShapeError` outside production (the action 500d
  // AFTER the write had landed), and inside it recorded "note: … → —" for changes
  // that never happened.
  const AUDIT_KEYS = ["qty", "price", "tradeDate", "slPlanned", "trailingSl", "targetPlanned", "note"] as const;
  const stated = Object.fromEntries(Object.entries(written).filter(([, v]) => v !== undefined));
  const project = (r: Record<string, unknown>) => Object.fromEntries(AUDIT_KEYS.map((k) => [k, r[k] ?? null]));

  recordAudit({
    entity: "trade",
    entityId: row.tradeId,
    action: "leg_edit",
    summary: `leg #${legId} edited`,
    before: project(row as unknown as Record<string, unknown>),
    after: project({ ...(row as unknown as Record<string, unknown>), ...stated }),
  });

  return { ok: true, message: "Leg updated." };
}

export function deleteLeg(legId: number, direction?: Direction): LegMutationResult {
  const row = db.select().from(tradeLegs).where(eq(tradeLegs.id, legId)).get();
  if (!row) return { ok: false, message: "Leg not found." };
  if (!loadOwnTrade(row.tradeId)) return NOT_YOURS;

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
    // D1 (v4.4.0): the frozen risk the ladder left becomes the plain trade's
    // own figure — 'set' when there is one (a cap edit must not move it), no
    // source when there is none.
    db.update(tradesTable)
      .set({
        staged: false,
        riskSource: sql`CASE WHEN risk_amount_paise IS NOT NULL THEN 'set' ELSE NULL END`,
        updatedAt: sql`(datetime('now'))`,
      })
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
  if (!loadOwnTrade(tradeId)) return NOT_YOURS;
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
  const t = loadOwnTrade(tradeId);
  if (!t) return NOT_YOURS;
  if (t.staged) return { ok: true, message: "Already a staged position." };
  if (loadLegs(tradeId).length > 0) return { ok: true, message: "Already has legs." };

  const dir: Direction = directionOf(t);
  const isShort = dir === "short";
  const today = todayIstIso();

  const entryQty = isShort ? t.sellQty : t.buyQty;
  const exitQty = isShort ? t.buyQty : t.sellQty;
  // Through the same calendar the ladder prices with (G-G3-1), and REFUSING a
  // stored date it cannot read rather than seeding today in its place (D4, the
  // wave-2M seam round): this copies the PARENT's own date onto the leg, so
  // `?? today` silently MOVED a legacy trade's entry day — with {ok:true} and
  // "Staged mode enabled." — and with it the tax pack's financial year, the MTF
  // day count and the holding period. Refusing costs nothing here (unlike
  // `addLeg`, whose leg is already written): both dates resolve before the first
  // INSERT, so no half-applied ladder is possible (invariant 5). An undated row
  // is still seeded at today, which is what it has always done. Only a date this
  // conversion really WRITES is judged: an open row seeds no exit leg, so its exit
  // date resolves to the unused `today` and is never inspected.
  const entryRaw = isShort ? t.sellDate : t.buyDate;
  const exitRaw = isShort ? t.buyDate : t.sellDate;
  const entryDate = entryRaw == null ? today : normalizeDate(entryRaw);
  const exitDate = exitQty > 0 && exitRaw != null ? normalizeDate(exitRaw) : today;

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

  // The refusals, in the sentence `validateLegs` and the trade editor already
  // state, named by the COLUMN the leg would have copied. (`?? ""` is for the
  // type checker only — a null raw date resolved to today above.)
  if (entryDate === null)
    return { ok: false, message: unreadableDateMessage(isShort ? "sell date" : "buy date", entryRaw ?? "") };
  if (exitDate === null)
    return { ok: false, message: unreadableDateMessage(isShort ? "buy date" : "sell date", exitRaw ?? "") };

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
