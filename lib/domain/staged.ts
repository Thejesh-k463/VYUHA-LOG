/**
 * Staged (scaled) positions — the pure math behind building a position in
 * tranches and scaling out of it.
 *
 * ZERO DB and ZERO React imports. Everything here is a pure function over
 * plain data so it can be unit-tested exhaustively, which matters more here
 * than anywhere else in the app: this module decides what your P&L IS.
 *
 * ── The three rules, decided deliberately ──────────────────────────────────
 *
 * 1. PRICING IS WEIGHTED-AVERAGE.
 *    An exit books against the moving average cost of everything still open at
 *    that moment. This is what your broker's average price shows, so the
 *    journal never disagrees with the broker app. After an exit the remaining
 *    cost basis is unchanged (that is what makes it a *moving average* rather
 *    than FIFO).
 *
 * 2. QUANTITY CONSUMPTION IS FIFO.
 *    Weighted-average pricing cannot say WHICH stop is still live once you
 *    scale out — the money is fungible but the stops are not. So an exit
 *    retires the oldest open entry legs first. This keeps quantities whole (no
 *    fractional shares) and matches how traders describe it: "I booked my
 *    first tranche."
 *
 *    These two rules are INDEPENDENT and both are enforced. A consequence
 *    worth stating plainly: the remaining tranches' original fill prices will
 *    NOT generally sum to the remaining cost basis. That is expected, not a
 *    bug. Money questions (invested, unrealised, P&L) are answered from
 *    `avgOpenPrice`; stop questions (which stop, how far) are answered from
 *    the tranche rows. Never mix them.
 *
 * 3. R IS FROZEN AT THE FIRST ENTRY.
 *    initialRisk = |entry1.price − entry1.stop| × entry1.qty, fixed for the
 *    life of the position. Every exit contributes netPnl ÷ initialRisk and
 *    those contributions sum. Scale half at +2R and the rest at +3R and you
 *    booked +2.5R. This is the industry convention and the only one that keeps
 *    R comparable between a single-shot trade and a pyramided one.
 */

export type LegKind = "entry" | "exit";
export type Direction = "long" | "short";

/** One executed fill. `qty` is always a positive magnitude — `kind` and
 *  `direction` carry the sign. */
export interface Leg {
  id: number;
  kind: LegKind;
  /** 1-based execution order. Ties broken by id. */
  seq: number;
  tradeDate: string; // ISO yyyy-mm-dd
  tradeTime?: string | null;
  qty: number;
  price: number;
  /** Entry legs only — each tranche carries its own stop. */
  slPlanned?: number | null;
  trailingSl?: number | null;
  targetPlanned?: number | null;
  /** Charges attributable to this fill, in rupees. */
  chargesTotal?: number;
  note?: string | null;
}

/** An entry leg with quantity still open after FIFO consumption. */
export interface OpenTranche {
  legId: number;
  seq: number;
  tradeDate: string;
  price: number;
  originalQty: number;
  openQty: number;
  slPlanned: number | null;
  trailingSl: number | null;
  /** Trailing stop wins when set — that is the stop actually working. */
  effectiveSl: number | null;
  targetPlanned: number | null;
}

/** Which entry legs an exit consumed, oldest first. */
export interface Consumption {
  legId: number;
  qty: number;
}

/** A realised exit, priced at the weighted average in force at the time. */
export interface ExitFill {
  legId: number;
  seq: number;
  tradeDate: string;
  qty: number;
  price: number;
  /** Moving-average cost this exit booked against. */
  avgCostAtExit: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  /** netPnl ÷ initialRisk. Null when the first entry carried no stop. */
  rContribution: number | null;
  consumed: Consumption[];
}

export type WarningLevel = "info" | "caution" | "action";

export interface StagedWarning {
  level: WarningLevel;
  code:
    | "averaging_down"
    | "unstopped_tranche"
    | "risk_exceeds_initial"
    | "no_initial_stop";
  message: string;
  legId?: number;
}

export interface StagedPosition {
  direction: Direction;
  isClosed: boolean;

  entryCount: number;
  exitCount: number;
  totalEntryQty: number;
  totalExitQty: number;
  openQty: number;

  /** Weighted average of every entry ever made (display/reference). */
  avgEntryPrice: number | null;
  /** Moving-average cost basis of the quantity still open. Use THIS for money. */
  avgOpenPrice: number | null;
  /** Quantity-weighted average of all exit fills. */
  avgExitPrice: number | null;

  /** openQty × avgOpenPrice — capital still deployed. */
  invested: number;
  realisedGross: number;
  realisedCharges: number;
  realisedNet: number;

  openTranches: OpenTranche[];
  fills: ExitFill[];

  /** Frozen at the first entry. Null when that entry had no stop. */
  initialRisk: number | null;
  realisedR: number | null;

  warnings: StagedWarning[];
}

/** Live figures that need a current mark. */
export interface StagedMark {
  unrealised: number;
  openR: number | null;
  totalR: number | null;
  /** From the CURRENT MARK down to each tranche's stop — matches the risk
   *  cockpit's "Open Risk @ SL" semantics. Floors at 0 per tranche: a stop
   *  already through the mark cannot lose you more by falling further. */
  openRiskAtSl: number | null;
  /** What you would actually book if every stop hit, measured from the cost
   *  basis. Negative means the stops have locked in a profit. */
  lossIfAllStopsHit: number | null;
  unstoppedQty: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** Chronological order: seq first, id as the tiebreaker. */
export function sortLegs(legs: Leg[]): Leg[] {
  return [...legs].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.id - b.id));
}

/** The stop actually working on a tranche — a trailing stop supersedes the
 *  original whenever one is set. */
export function effectiveStop(leg: { slPlanned?: number | null; trailingSl?: number | null }): number | null {
  if (leg.trailingSl != null) return leg.trailingSl;
  return leg.slPlanned ?? null;
}

// ---------------------------------------------------------------------------
// Validation — server actions call this BEFORE writing anything.
// ---------------------------------------------------------------------------

export interface LegProblem {
  legId: number | null;
  message: string;
}

/**
 * Replays the ladder and reports anything that makes it unbookable. An empty
 * array means the ladder is internally consistent.
 */
export function validateLegs(legs: Leg[]): LegProblem[] {
  const problems: LegProblem[] = [];
  const ordered = sortLegs(legs);

  if (ordered.length > 0 && ordered[0].kind !== "entry") {
    problems.push({ legId: ordered[0].id, message: "A position must start with an entry, not an exit." });
  }

  let open = 0;
  for (const leg of ordered) {
    if (!Number.isFinite(leg.qty) || leg.qty <= 0) {
      problems.push({ legId: leg.id, message: "Quantity must be greater than zero." });
      continue;
    }
    if (!Number.isFinite(leg.price) || leg.price < 0) {
      problems.push({ legId: leg.id, message: "Price must be zero or greater." });
      continue;
    }
    if (leg.kind === "entry") {
      open += leg.qty;
    } else {
      if (leg.qty > open + 1e-9) {
        problems.push({
          legId: leg.id,
          message: `Exit of ${leg.qty} exceeds the ${r4(open)} still open at that point.`,
        });
      }
      open -= leg.qty;
    }
  }
  return problems;
}

/** True when this exit quantity can be booked against the ladder as it stands. */
export function canExit(legs: Leg[], qty: number): boolean {
  const s = summarise(legs, "long");
  return qty > 0 && qty <= s.openQty + 1e-9;
}

// ---------------------------------------------------------------------------
// The ladder replay
// ---------------------------------------------------------------------------

/**
 * Replays every leg in execution order and returns the full position state.
 *
 * Runs a moving-average cost basis for money and a FIFO queue for tranche
 * quantities, side by side. Invalid ladders (over-exit) are clamped rather
 * than thrown — `validateLegs` is the gate; this stays total so the UI can
 * always render something.
 */
export function summarise(legs: Leg[], direction: Direction): StagedPosition {
  const ordered = sortLegs(legs);
  const warnings: StagedWarning[] = [];

  // Moving-average book (money).
  let openQty = 0;
  let openCost = 0; // openQty × movingAvg

  // FIFO queue of entry tranches (stops).
  const queue: OpenTranche[] = [];

  const fills: ExitFill[] = [];
  let totalEntryQty = 0;
  let totalExitQty = 0;
  let entryValue = 0; // Σ qty × price over ALL entries
  let exitValue = 0;
  let realisedGross = 0;
  let realisedCharges = 0;
  let entryCount = 0;
  let exitCount = 0;

  // Frozen at the first entry leg.
  let initialRisk: number | null = null;
  let firstEntrySeen = false;

  for (const leg of ordered) {
    if (!Number.isFinite(leg.qty) || leg.qty <= 0) continue;

    if (leg.kind === "entry") {
      entryCount++;
      const stop = effectiveStop(leg);

      if (!firstEntrySeen) {
        firstEntrySeen = true;
        if (leg.slPlanned != null) {
          initialRisk = r2(Math.abs(leg.price - leg.slPlanned) * leg.qty);
        } else {
          warnings.push({
            level: "caution",
            code: "no_initial_stop",
            legId: leg.id,
            message: "First entry has no stop, so R cannot be computed for this position.",
          });
        }
      } else {
        // Adding to a position that has moved AGAINST you is averaging down —
        // the single most reliable way retail turns a small loss into a large
        // one. Adding in your favour is pyramiding and is not flagged.
        const avg = openQty > 0 ? openCost / openQty : leg.price;
        const worse = direction === "long" ? leg.price < avg - 1e-9 : leg.price > avg + 1e-9;
        if (worse && openQty > 0) {
          warnings.push({
            level: "caution",
            code: "averaging_down",
            legId: leg.id,
            message: `Averaging down — added at ${r2(leg.price)} against an average of ${r2(avg)}.`,
          });
        }
      }

      if (stop == null) {
        warnings.push({
          level: "caution",
          code: "unstopped_tranche",
          legId: leg.id,
          message: "This tranche has no stop — its full value is at risk.",
        });
      }

      openQty += leg.qty;
      openCost += leg.qty * leg.price;
      totalEntryQty += leg.qty;
      entryValue += leg.qty * leg.price;

      queue.push({
        legId: leg.id,
        seq: leg.seq,
        tradeDate: leg.tradeDate,
        price: leg.price,
        originalQty: leg.qty,
        openQty: leg.qty,
        slPlanned: leg.slPlanned ?? null,
        trailingSl: leg.trailingSl ?? null,
        effectiveSl: stop,
        targetPlanned: leg.targetPlanned ?? null,
      });
    } else {
      exitCount++;
      // Clamp: never book more than is open (validateLegs is the real gate).
      const qty = Math.min(leg.qty, openQty);
      if (qty <= 0) continue;

      const avgCost = openQty > 0 ? openCost / openQty : 0;
      const gross =
        direction === "long" ? (leg.price - avgCost) * qty : (avgCost - leg.price) * qty;
      const charges = leg.chargesTotal ?? 0;
      const net = gross - charges;

      // FIFO: retire the oldest open tranches first.
      const consumed: Consumption[] = [];
      let need = qty;
      for (const t of queue) {
        if (need <= 1e-9) break;
        if (t.openQty <= 1e-9) continue;
        const take = Math.min(t.openQty, need);
        t.openQty = r4(t.openQty - take);
        need = r4(need - take);
        consumed.push({ legId: t.legId, qty: take });
      }

      // Moving average: the remaining basis per unit is unchanged.
      openCost -= avgCost * qty;
      openQty -= qty;
      if (openQty <= 1e-9) {
        openQty = 0;
        openCost = 0;
      }

      totalExitQty += qty;
      exitValue += qty * leg.price;
      realisedGross += gross;
      realisedCharges += charges;

      fills.push({
        legId: leg.id,
        seq: leg.seq,
        tradeDate: leg.tradeDate,
        qty,
        price: leg.price,
        avgCostAtExit: r2(avgCost),
        grossPnl: r2(gross),
        charges: r2(charges),
        netPnl: r2(net),
        rContribution: initialRisk && initialRisk > 0 ? r2(net / initialRisk) : null,
        consumed,
      });
    }
  }

  const openTranches = queue.filter((t) => t.openQty > 1e-9);
  const realisedNet = r2(realisedGross - realisedCharges);

  // Adding tranches can quietly push you past the risk you originally signed
  // up for. Measure the still-open exposure against the frozen initial risk.
  if (initialRisk && initialRisk > 0 && openTranches.length > 0) {
    const avgOpen = openQty > 0 ? openCost / openQty : 0;
    let plannedLoss = 0;
    for (const t of openTranches) {
      if (t.effectiveSl == null) {
        plannedLoss += avgOpen * t.openQty; // no stop — the whole position is the risk
      } else {
        plannedLoss +=
          direction === "long"
            ? (avgOpen - t.effectiveSl) * t.openQty
            : (t.effectiveSl - avgOpen) * t.openQty;
      }
    }
    if (plannedLoss > initialRisk * 1.01) {
      warnings.push({
        level: "action",
        code: "risk_exceeds_initial",
        message: `Open risk of ₹${Math.round(plannedLoss).toLocaleString("en-IN")} is above the ₹${Math.round(
          initialRisk,
        ).toLocaleString("en-IN")} you risked on the first entry.`,
      });
    }
  }

  const realisedR =
    initialRisk && initialRisk > 0 && fills.length > 0 ? r2(realisedNet / initialRisk) : null;

  return {
    direction,
    isClosed: firstEntrySeen && openQty <= 1e-9,
    entryCount,
    exitCount,
    totalEntryQty: r4(totalEntryQty),
    totalExitQty: r4(totalExitQty),
    openQty: r4(openQty),
    avgEntryPrice: totalEntryQty > 0 ? r2(entryValue / totalEntryQty) : null,
    avgOpenPrice: openQty > 0 ? r2(openCost / openQty) : null,
    avgExitPrice: totalExitQty > 0 ? r2(exitValue / totalExitQty) : null,
    invested: r2(openCost),
    realisedGross: r2(realisedGross),
    realisedCharges: r2(realisedCharges),
    realisedNet,
    openTranches,
    fills,
    initialRisk,
    realisedR,
    warnings,
  };
}

/**
 * The live half — everything that needs a current mark. Separated from
 * `summarise` so the historical replay stays deterministic and testable
 * without inventing a price.
 */
export function markToMarket(pos: StagedPosition, mark: number | null | undefined): StagedMark {
  const { direction, openQty, avgOpenPrice, initialRisk, realisedR } = pos;

  if (openQty <= 0 || avgOpenPrice == null || mark == null || !Number.isFinite(mark)) {
    return {
      unrealised: 0,
      openR: null,
      totalR: realisedR,
      openRiskAtSl: openQty > 0 ? null : 0,
      lossIfAllStopsHit: openQty > 0 ? null : 0,
      unstoppedQty: pos.openTranches.filter((t) => t.effectiveSl == null).reduce((s, t) => s + t.openQty, 0),
    };
  }

  const unrealised = r2(
    direction === "long" ? (mark - avgOpenPrice) * openQty : (avgOpenPrice - mark) * openQty,
  );

  let riskFromMark = 0;
  let lossFromCost = 0;
  let unstoppedQty = 0;
  for (const t of pos.openTranches) {
    if (t.effectiveSl == null) {
      unstoppedQty += t.openQty;
      // No stop: the honest worst case is the whole position, from both angles.
      riskFromMark += mark * t.openQty;
      lossFromCost += avgOpenPrice * t.openQty;
      continue;
    }
    const fromMark =
      direction === "long" ? (mark - t.effectiveSl) * t.openQty : (t.effectiveSl - mark) * t.openQty;
    riskFromMark += Math.max(0, fromMark);
    lossFromCost +=
      direction === "long"
        ? (avgOpenPrice - t.effectiveSl) * t.openQty
        : (t.effectiveSl - avgOpenPrice) * t.openQty;
  }

  const openR = initialRisk && initialRisk > 0 ? r2(unrealised / initialRisk) : null;

  return {
    unrealised,
    openR,
    totalR: openR != null && realisedR != null ? r2(realisedR + openR) : (openR ?? realisedR),
    openRiskAtSl: r2(riskFromMark),
    lossIfAllStopsHit: r2(lossFromCost),
    unstoppedQty: r4(unstoppedQty),
  };
}

// ---------------------------------------------------------------------------
// Charge inputs — pure, so the DP-once-per-day rule is unit-testable.
// ---------------------------------------------------------------------------

export interface LegChargeShape {
  legId: number;
  buyValue: number;
  sellValue: number;
  buyQty: number;
  sellQty: number;
  buyOrderCount: number;
  sellOrderCount: number;
  /** DP is levied per scrip per DAY on the debit, not per fill. Only the first
   *  exit of each date carries it; later same-day exits must suppress it. */
  suppressDp: boolean;
}

/**
 * Turns each leg into a one-sided charge input. Brokerage is per order and STT
 * per execution, so every fill is priced on its own — but DP would otherwise
 * be charged once per exit leg instead of once per day, which is why
 * `suppressDp` exists.
 */
export function legChargeShapes(legs: Leg[], direction: Direction): LegChargeShape[] {
  const ordered = sortLegs(legs);
  const seenExitDates = new Set<string>();
  const out: LegChargeShape[] = [];

  for (const leg of ordered) {
    if (!Number.isFinite(leg.qty) || leg.qty <= 0) continue;
    const value = r2(leg.qty * leg.price);
    // A long's entry is a buy; a short's entry is a sell.
    const isBuySide = direction === "long" ? leg.kind === "entry" : leg.kind === "exit";

    let suppressDp = false;
    if (leg.kind === "exit") {
      if (seenExitDates.has(leg.tradeDate)) suppressDp = true;
      else seenExitDates.add(leg.tradeDate);
    }

    out.push({
      legId: leg.id,
      buyValue: isBuySide ? value : 0,
      sellValue: isBuySide ? 0 : value,
      buyQty: isBuySide ? leg.qty : 0,
      sellQty: isBuySide ? 0 : leg.qty,
      buyOrderCount: isBuySide ? 1 : 0,
      sellOrderCount: isBuySide ? 0 : 1,
      suppressDp,
    });
  }
  return out;
}

/**
 * The aggregate the parent `trades` row must carry so that every existing
 * report, tax pack and tracker keeps working without knowing legs exist.
 */
export interface ParentAggregate {
  buyQty: number;
  avgBuyPrice: number;
  buyValue: number;
  buyOrderCount: number;
  sellQty: number;
  avgSellPrice: number;
  sellValue: number;
  sellOrderCount: number;
  buyDate: string | null;
  sellDate: string | null;
  entryTime: string | null;
  exitTime: string | null;
  isOpen: boolean;
  slPlanned: number | null;
  trailingSl: number | null;
  targetPlanned: number | null;
  riskAmount: number | null;
}

/**
 * Collapses a ladder back into the flat shape the rest of the app reads.
 *
 * Buy/sell are assigned by DIRECTION, not by leg kind: a short position's
 * entries are sells. Dates are the first entry and the last exit, matching how
 * an aggregated broker P&L row would report the same activity. The parent's
 * stop fields report the WIDEST open stop, which is the one that would be hit
 * last — reporting anything tighter would understate the position's risk.
 */
export function parentAggregate(legs: Leg[], direction: Direction): ParentAggregate {
  const ordered = sortLegs(legs);
  const pos = summarise(legs, direction);

  const entries = ordered.filter((l) => l.kind === "entry");
  const exits = ordered.filter((l) => l.kind === "exit");

  const entryQty = entries.reduce((s, l) => s + l.qty, 0);
  const entryValue = entries.reduce((s, l) => s + l.qty * l.price, 0);
  const exitQty = exits.reduce((s, l) => s + l.qty, 0);
  const exitValue = exits.reduce((s, l) => s + l.qty * l.price, 0);

  const isLong = direction === "long";
  const firstEntry = entries[0] ?? null;
  const lastExit = exits[exits.length - 1] ?? null;

  // Widest = the stop that would be hit LAST, i.e. lowest for a long and
  // highest for a short. Reporting anything tighter would understate risk.
  const widest = (pick: (t: OpenTranche) => number | null): number | null => {
    let out: number | null = null;
    for (const t of pos.openTranches) {
      const v = pick(t);
      if (v == null) continue;
      out = out == null ? v : isLong ? Math.min(out, v) : Math.max(out, v);
    }
    return out;
  };
  const widestSl = widest((t) => t.slPlanned);
  const widestTsl = widest((t) => t.trailingSl);

  return {
    buyQty: r4(isLong ? entryQty : exitQty),
    avgBuyPrice: isLong
      ? entryQty > 0 ? r2(entryValue / entryQty) : 0
      : exitQty > 0 ? r2(exitValue / exitQty) : 0,
    buyValue: r2(isLong ? entryValue : exitValue),
    buyOrderCount: Math.max(1, isLong ? entries.length : exits.length),
    sellQty: r4(isLong ? exitQty : entryQty),
    avgSellPrice: isLong
      ? exitQty > 0 ? r2(exitValue / exitQty) : 0
      : entryQty > 0 ? r2(entryValue / entryQty) : 0,
    sellValue: r2(isLong ? exitValue : entryValue),
    sellOrderCount: Math.max(1, isLong ? exits.length : entries.length),
    buyDate: isLong ? (firstEntry?.tradeDate ?? null) : (lastExit?.tradeDate ?? null),
    sellDate: isLong ? (lastExit?.tradeDate ?? null) : (firstEntry?.tradeDate ?? null),
    entryTime: firstEntry?.tradeTime ?? null,
    exitTime: lastExit?.tradeTime ?? null,
    isOpen: !pos.isClosed,
    slPlanned: widestSl ?? firstEntry?.slPlanned ?? null,
    trailingSl: widestTsl,
    targetPlanned: pos.openTranches.find((t) => t.targetPlanned != null)?.targetPlanned ?? null,
    riskAmount: pos.initialRisk,
  };
}
