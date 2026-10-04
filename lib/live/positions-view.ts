/**
 * The `/live` POSITIONS tab — the pure arithmetic behind its header, rows,
 * Risk lens and pop-up (v4.7.0 wave C4, design `C4-DESIGN-2026-10-04.md`).
 *
 * PURITY (invariant 2): no DB, no React, no clock. `today` is passed in. Every
 * function takes the narrowest structural slice of a desk row (`Pick<…>` of
 * `PositionViewRow`), so `DeskRow` satisfies it and a test can build a row from
 * the handful of fields that function reads.
 *
 * UNITS (invariant 1): every money field is INTEGER PAISE, ratios are ppm.
 * The ONE function here that sees rupees is `partialOf`, because the journal's
 * per-unit averages are REAL levels — rounding them to paise BEFORE multiplying
 * is the qty × price corruption `load-desk.ts` documents — so it multiplies the
 * real levels and rounds the product once.
 *
 * NULL IS A VALUE (invariant 6): a figure whose denominator is missing returns
 * null, never 0. `heat === null` is NOT ENTITLED (free) or "no capital"; every
 * capital-relative figure below is then null and the UI shows the lock / dash.
 */

import { ppmFloor, ppmTrunc } from "./tracker-row";
import type { HeatView } from "./heat";
import type { StopResult } from "./stop";
import type { Bar, EffectiveStopSource, Paise, Ppm, Ratio, Side } from "./types";

// ─── Wire sub-shapes (desk-types.ts re-uses these; they are pure) ─────────────

/** D6 — what the PARENT row says was already booked on an open position. */
export interface PartialBooking {
  /** closedQty / entryQty in ppm (floored). */
  bookedPpm: Ppm;
  closedQty: number;
  /** (avgExit − avgEntry) × closedQty × sign, BEFORE CHARGES. Never `grossPnl`. */
  realisedGrossP: Paise;
}

/** P5 — a recorded bonus or split, with its ratio. Dividends are never chips. */
export interface CorpActionChip {
  type: "bonus" | "split";
  exDate: string;
  fromUnits: number;
  toUnits: number;
}

/** The structural row every function below reads a slice of. `DeskRow` satisfies it. */
export interface PositionViewRow {
  id: number;
  symbol: string;
  side: Side;
  qty: number;
  avgEntryP: Paise;
  investedP: Paise;
  markP: Paise | null;
  markAsOf: string | null;
  unrealisedP: Paise | null;
  holdingDays: number | null;
  effectiveStopP: Paise | null;
  effectiveStopSource: EffectiveStopSource;
  distanceToStopP: Paise | null;
  distanceToStopAtrX100: number | null;
  /** Pro — null on the free wire. */
  riskAtStopP: Paise | null;
  stop: StopResult;
  industry: string | null;
  sectorName: string | null;
  partial: PartialBooking | null;
  corpActions: CorpActionChip[];
  prevCloseP: Paise | null;
  resultsDate: string | null;
  expiry: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ISO date `days` before `iso`, in UTC calendar arithmetic (a date, not an instant). */
export function isoMinusDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) - days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// ─── D6 partial booking ───────────────────────────────────────────────────────

/** The slice of the PARENT trade row partial booking reads (rupee LEVELS, real). */
export interface PartialInput {
  side: Side;
  buyQty: number;
  sellQty: number;
  avgBuyPrice: number | null;
  avgSellPrice: number | null;
}

/**
 * What an OPEN position already booked, from the parent row (invariant 5).
 *
 * Long: entered on buys, `closedQty = sellQty` of `buyQty`, exit = avgSellPrice.
 * Short: entered on sells, `closedQty = buyQty` of `sellQty`, exit = avgBuyPrice.
 * `realisedGrossP = (avgExit − avgEntry) × closedQty × sign` (sign −1 for a
 * short), BEFORE CHARGES — deliberately not `grossPnl`, whose partial-exit
 * meaning differs by importer.
 *
 * null when nothing is booked, when the row is not partially open (closed ≥
 * entered), or when either average is not a positive price (a booked quantity
 * with no exit price cannot be valued — invariant 6).
 */
export function partialOf(t: PartialInput): PartialBooking | null {
  const long = t.side !== "short";
  const entryQty = long ? t.buyQty : t.sellQty;
  const closedQty = long ? t.sellQty : t.buyQty;
  const entry = long ? t.avgBuyPrice : t.avgSellPrice;
  const exit = long ? t.avgSellPrice : t.avgBuyPrice;
  if (!(Number.isFinite(closedQty) && closedQty > 0)) return null;
  if (!(Number.isFinite(entryQty) && entryQty > closedQty)) return null;
  if (entry == null || exit == null || !(entry > 0) || !(exit > 0)) return null;
  const sign = long ? 1 : -1;
  // Multiply the REAL levels, round the product once (invariant 1).
  const realisedGrossP = Math.round((exit - entry) * closedQty * 100) * sign;
  return {
    bookedPpm: ppmFloor(closedQty, entryQty) ?? 0,
    closedQty,
    realisedGrossP: realisedGrossP === 0 ? 0 : realisedGrossP, // no −0 on the wire
  };
}

// ─── P5 corporate actions / P7 previous close ────────────────────────────────

/** The slice of a `corporate_actions` row the chips read. */
export interface CorpActionInput {
  symbol: string;
  type: string;
  exDate: string;
  fromUnits: number | null;
  toUnits: number | null;
}

/** How far back a recorded action still earns a chip. */
export const CORP_ACTION_LOOKBACK_DAYS = 30;

/**
 * This symbol's recorded bonus/split actions with `exDate ≥ today − 30 days`,
 * ascending by date. Dividends are never chips (plan ruling); a row without a
 * positive ratio is skipped (the writer refuses one — a ratio is the chip).
 */
export function corpActionsFor(actions: readonly CorpActionInput[], symbol: string, today: string): CorpActionChip[] {
  const sym = symbol.trim().toUpperCase();
  const from = isoMinusDays(today, CORP_ACTION_LOOKBACK_DAYS);
  const out: CorpActionChip[] = [];
  for (const a of actions) {
    if (a.symbol.trim().toUpperCase() !== sym) continue;
    if (a.type !== "bonus" && a.type !== "split") continue;
    if (!ISO_DATE.test(a.exDate) || a.exDate < from) continue;
    if (a.fromUnits == null || a.toUnits == null || !(a.fromUnits > 0) || !(a.toUnits > 0)) continue;
    out.push({ type: a.type, exDate: a.exDate, fromUnits: a.fromUnits, toUnits: a.toUnits });
  }
  return out.sort((x, y) => (x.exDate < y.exDate ? -1 : x.exDate > y.exDate ? 1 : 0));
}

/** P7 — the close of the last bar strictly BEFORE `today`; null when there is none. */
export function prevCloseOf(bars: readonly Pick<Bar, "date" | "closeP">[], today: string): Paise | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].date < today) return bars[i].closeP;
  return null;
}

// ─── D4 cohort concentration ──────────────────────────────────────────────────

export type CohortLevel = "industry" | "sector";

export interface CohortNode {
  /** The label, or null for the Unclassified bucket. */
  group: string | null;
  /** The level that labelled this node — "sector" at Industry view means it FELL UP. */
  level: CohortLevel | null;
  deployedP: Paise;
  /** deployedP / Σ deployedP over the WHOLE book (unclassified included). */
  share: Ratio;
  constituents: number;
}

export interface CohortView {
  level: CohortLevel;
  nodes: CohortNode[];
  /** Rows labelled at the asked level OR (industry view) fallen up to a sector. */
  classified: number;
  /** Rows at Industry view labelled by their sector because they carry no industry. */
  fellUp: number;
  total: number;
  deployedP: Paise;
}

/**
 * Share of DEPLOYED rupees (`investedP`) per cohort — never market value.
 *
 * Industry view: a row with no industry (a user tag, an index-map hit) falls UP
 * to its sector, and the node says so (`level: "sector"`), the way the Atlas
 * cohort does. A row with neither is "Unclassified" (`group: null`), its own
 * node, never spread or dropped — dropping it would inflate every other share.
 * Order: deployed descending, then name; Unclassified last.
 */
export function cohortConcentration(
  rows: readonly Pick<PositionViewRow, "investedP" | "industry" | "sectorName">[],
  level: CohortLevel,
): CohortView {
  const totalP = rows.reduce((s, r) => s + r.investedP, 0);
  const denominator = totalP > 0 ? totalP : null;
  const nodes = new Map<string, { group: string | null; level: CohortLevel | null; deployedP: Paise; constituents: number }>();
  let classified = 0;
  let fellUp = 0;
  const clean = (s: string | null) => (s && s.trim() ? s.trim() : null);
  for (const r of rows) {
    const industry = clean(r.industry);
    const sector = clean(r.sectorName);
    let group: string | null = null;
    let used: CohortLevel | null = null;
    if (level === "industry" && industry) {
      group = industry;
      used = "industry";
    } else if (sector) {
      group = sector;
      used = "sector";
      if (level === "industry") fellUp += 1;
    }
    if (group !== null) classified += 1;
    const key = group === null ? "\0unclassified" : `${used}:${group}`;
    const node = nodes.get(key) ?? { group, level: used, deployedP: 0, constituents: 0 };
    node.deployedP += r.investedP;
    node.constituents += 1;
    nodes.set(key, node);
  }
  const out: CohortNode[] = [...nodes.values()].map((n) => ({
    group: n.group,
    level: n.level,
    deployedP: n.deployedP,
    share: { ppm: ppmFloor(n.deployedP, denominator), denominator },
    constituents: n.constituents,
  }));
  out.sort((a, b) => {
    if ((a.group === null) !== (b.group === null)) return a.group === null ? 1 : -1;
    return b.deployedP - a.deployedP || (a.group ?? "").localeCompare(b.group ?? "");
  });
  return { level, nodes: out, classified, fellUp, total: rows.length, deployedP: totalP };
}

// ─── D5 header bars ───────────────────────────────────────────────────────────

export interface HeaderTotals {
  /** Σ investedP — free. */
  deployedP: Paise;
  /** deployedP / capital. Pro (null when `heat` is null or capital unknown). */
  deployedPpm: Ppm | null;
  /** Σ unrealisedP over MARKED rows; null when no row is marked. Free. */
  unrealisedP: Paise | null;
  /** Rows with no mark — excluded from `unrealisedP`, and counted so the UI says so. */
  unmarked: number;
  /** unrealisedP / capital. Pro. */
  unrealisedOnCapitalPpm: Ppm | null;
  /** The heat strip's own figures, or null (free / no capital). */
  heatPpm: Ppm | null;
  ceilingPpm: Ppm | null;
  /** Σ partial.realisedGrossP, before charges; null when no row booked anything. Free. */
  realisedPartialP: Paise | null;
  /**
   * realisedPartialP / the ENTRY COST of the booked quantity (Σ closedQty ×
   * avgEntryP). The "+x% realised on partials" figure; null with no partials.
   */
  realisedPartialPpm: Ppm | null;
  partials: number;
  rows: number;
}

/** The three header bars (deployed / heat / unrealised) plus the partials line. */
export function headerTotals(
  rows: readonly Pick<PositionViewRow, "investedP" | "unrealisedP" | "partial" | "avgEntryP">[],
  heat: HeatView | null,
): HeaderTotals {
  let deployedP = 0;
  let unrealisedP: Paise | null = null;
  let unmarked = 0;
  let realisedPartialP: Paise | null = null;
  let bookedCostP = 0;
  let partials = 0;
  for (const r of rows) {
    deployedP += r.investedP;
    if (r.unrealisedP === null) unmarked += 1;
    else unrealisedP = (unrealisedP ?? 0) + r.unrealisedP;
    if (r.partial) {
      partials += 1;
      realisedPartialP = (realisedPartialP ?? 0) + r.partial.realisedGrossP;
      bookedCostP += Math.round(r.partial.closedQty * r.avgEntryP);
    }
  }
  const capitalP = heat?.capitalP != null && heat.capitalP > 0 ? heat.capitalP : null;
  return {
    deployedP,
    deployedPpm: ppmFloor(deployedP, capitalP),
    unrealisedP,
    unmarked,
    unrealisedOnCapitalPpm: ppmTrunc(unrealisedP, capitalP),
    heatPpm: heat?.heatPpm ?? null,
    ceilingPpm: heat?.ceilingPpm ?? null,
    realisedPartialP,
    realisedPartialPpm: ppmTrunc(realisedPartialP, bookedCostP > 0 ? bookedCostP : null),
    partials,
    rows: rows.length,
  };
}

// ─── Feed state: stale marks ──────────────────────────────────────────────────

export interface StaleCount {
  /** Rows whose `markAsOf` is OLDER than the newest one on the desk. */
  stale: number;
  newestAsOf: string | null;
  /** Rows with a mark but no `asOf` (stored / EOD marks) — age unknown, not counted stale. */
  undated: number;
}

const instant = (s: string): number => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
};

/** How many marks lag the newest one — the header's stale-mark count (free). */
export function staleCount(rows: readonly Pick<PositionViewRow, "markP" | "markAsOf">[]): StaleCount {
  let newest: string | null = null;
  let newestT = -Infinity;
  for (const r of rows) {
    if (!r.markAsOf) continue;
    const t = instant(r.markAsOf);
    const later = Number.isNaN(t) ? newest === null || r.markAsOf > newest : t > newestT;
    if (later) {
      newest = r.markAsOf;
      newestT = Number.isNaN(t) ? newestT : t;
    }
  }
  let stale = 0;
  let undated = 0;
  for (const r of rows) {
    if (r.markP === null) continue;
    if (!r.markAsOf) {
      undated += 1;
      continue;
    }
    if (newest === null || r.markAsOf === newest) continue;
    const t = instant(r.markAsOf);
    const older = Number.isNaN(t) || Number.isNaN(newestT) ? r.markAsOf < newest : t < newestT;
    if (older) stale += 1;
  }
  return { stale, newestAsOf: newest, undated };
}

// ─── D7 stop cell ─────────────────────────────────────────────────────────────

export type StopState = "at-entry" | "at-risk" | "locked-in";

/**
 * Where the stop sits relative to entry, by side — level arithmetic, FREE.
 * Long: stop < entry at risk, = entry at entry, > entry locked in. Short mirrored.
 * null with no stop recorded.
 */
export function stopState(row: Pick<PositionViewRow, "side" | "effectiveStopP" | "avgEntryP">): StopState | null {
  const s = row.effectiveStopP;
  if (s === null) return null;
  if (s === row.avgEntryP) return "at-entry";
  const beyond = row.side === "short" ? s < row.avgEntryP : s > row.avgEntryP;
  return beyond ? "locked-in" : "at-risk";
}

export type StopChipKind = "manual" | "trailing" | "atr" | "structure" | "percent";

export interface StopChip {
  kind: StopChipKind;
  /** Short display text: "manual", "trailing", "ATR 21 × 2", "structure", "%". */
  label: string;
}

/** 2000 → "2", 2500 → "2.5", 1750 → "1.75". */
function permilleText(permille: number): string {
  return String(Math.round(permille) / 1000);
}

/**
 * P4 — the stop SOURCE chip, from STORED sources only.
 *
 * A recorded trailing SL is "trailing" with NO parameters (none is stored); a
 * recorded planned SL is "manual". Otherwise the stop tree's source: ATR shows
 * `ATR n × k` with n = the ATR length in use and k = `stop_atr_mult_permille`
 * / 1000 (both stored settings); structure; "%". No stop → null.
 */
export function stopChip(
  row: Pick<PositionViewRow, "effectiveStopSource" | "stop">,
  atrLength: number,
  atrMultPermille: number | null,
): StopChip | null {
  if (row.effectiveStopSource === "trailing") return { kind: "trailing", label: "trailing" };
  if (row.effectiveStopSource === "planned") return { kind: "manual", label: "manual" };
  const st = row.stop;
  const source = st.kind === "ok" || st.kind === "zero" || st.kind === "error" || st.kind === "gated" ? st.source : null;
  switch (source) {
    case "manual":
      return { kind: "manual", label: "manual" };
    case "atr":
      return atrMultPermille !== null && atrMultPermille > 0
        ? { kind: "atr", label: `ATR ${atrLength} × ${permilleText(atrMultPermille)}` }
        : { kind: "atr", label: "ATR" };
    case "structure":
      return { kind: "structure", label: "structure" };
    case "percent":
      return { kind: "percent", label: "%" };
    default:
      return null;
  }
}

/** The near-stop tint: within 1 ATR of the stop (`distanceToStopAtrX100 ≤ 100`). */
export function nearStop(row: Pick<PositionViewRow, "distanceToStopAtrX100">): boolean {
  return row.distanceToStopAtrX100 !== null && row.distanceToStopAtrX100 <= 100;
}

// ─── P7 since the previous close ──────────────────────────────────────────────

/** `qty × (price − stop)`, mirrored for shorts, floored at 0 — what a stop fill gives back FROM `price`. */
function givesBackFrom(side: Side, qty: number, priceP: Paise, stopP: Paise): Paise {
  const d = side === "short" ? stopP - priceP : priceP - stopP;
  return Math.max(qty * d, 0);
}

/** `qty × price − investedP`, mirrored for shorts. */
function unrealisedAt(side: Side, qty: number, investedP: Paise, priceP: Paise): Paise {
  return side === "short" ? investedP - qty * priceP : qty * priceP - investedP;
}

export interface SinceClose {
  /** Rows priced at BOTH the previous close and now, and not opened today. */
  compared: number;
  unrealisedAtCloseP: Paise | null;
  unrealisedNowP: Paise | null;
  unrealisedChangeP: Paise | null;
  /**
   * The book's give-back if every stop filled, measured FROM the price, at
   * TODAY's stops, at the previous close and now (rows with a stop among
   * `compared`). Stop edits are NOT tracked day to day — both sides use today's.
   */
  givesBackAtCloseP: Paise | null;
  givesBackNowP: Paise | null;
  /** The two above over capital. Pro (null when `heat` is null / no capital). */
  givesBackAtClosePpm: Ppm | null;
  givesBackNowPpm: Ppm | null;
  /** Rows entered today (`holdingDays === 0`) — they had no previous close. */
  openedToday: number[];
  /** Rows within 1 ATR of the stop now. */
  nearStop: number[];
  /** Always false: the copy states it. Kept on the value so it cannot be forgotten. */
  stopEditsTracked: false;
}

/**
 * Ideas B #3 / P7 — marks only, said plainly: unrealised and give-back at the
 * previous session's close vs now, BOTH at today's stops; positions opened
 * today; stops within 1 ATR.
 */
export function sinceClose(
  rows: readonly Pick<
    PositionViewRow,
    "id" | "side" | "qty" | "investedP" | "markP" | "prevCloseP" | "effectiveStopP" | "holdingDays" | "distanceToStopAtrX100"
  >[],
  heat: HeatView | null,
): SinceClose {
  let compared = 0;
  let uClose = 0;
  let uNow = 0;
  let gbClose: Paise | null = null;
  let gbNow: Paise | null = null;
  const openedToday: number[] = [];
  const near: number[] = [];
  for (const r of rows) {
    if (nearStop(r)) near.push(r.id);
    if (r.holdingDays === 0) {
      openedToday.push(r.id);
      continue;
    }
    if (r.markP === null || r.prevCloseP === null) continue;
    compared += 1;
    uClose += unrealisedAt(r.side, r.qty, r.investedP, r.prevCloseP);
    uNow += unrealisedAt(r.side, r.qty, r.investedP, r.markP);
    if (r.effectiveStopP !== null) {
      gbClose = (gbClose ?? 0) + givesBackFrom(r.side, r.qty, r.prevCloseP, r.effectiveStopP);
      gbNow = (gbNow ?? 0) + givesBackFrom(r.side, r.qty, r.markP, r.effectiveStopP);
    }
  }
  const capitalP = heat?.capitalP != null && heat.capitalP > 0 ? heat.capitalP : null;
  return {
    compared,
    unrealisedAtCloseP: compared > 0 ? uClose : null,
    unrealisedNowP: compared > 0 ? uNow : null,
    unrealisedChangeP: compared > 0 ? uNow - uClose : null,
    givesBackAtCloseP: gbClose,
    givesBackNowP: gbNow,
    givesBackAtClosePpm: ppmFloor(gbClose, capitalP),
    givesBackNowPpm: ppmFloor(gbNow, capitalP),
    openedToday,
    nearStop: near,
    stopEditsTracked: false,
  };
}

// ─── D8 upcoming on your book ─────────────────────────────────────────────────

export type UpcomingKind = "results" | "bonus" | "split" | "expiry";

export interface UpcomingEvent {
  kind: UpcomingKind;
  date: string;
  symbol: string;
  /** Desk rows the event touches (two trades in one scrip share one event). */
  rowIds: number[];
  /** Ratio for bonus/split; null otherwise. */
  fromUnits: number | null;
  toUnits: number | null;
}

/**
 * Dated events on today-or-later: results dates, RECORDED bonus/split ex-dates,
 * and a derivative's stored contract expiry (never guessed from a symbol).
 * Ascending by date, then kind, then symbol; deduplicated per (kind, date, symbol).
 */
export function upcoming(
  rows: readonly Pick<PositionViewRow, "id" | "symbol" | "resultsDate" | "corpActions" | "expiry">[],
  today: string,
): UpcomingEvent[] {
  const byKey = new Map<string, UpcomingEvent>();
  const add = (kind: UpcomingKind, date: string | null, r: { id: number; symbol: string }, ratio?: { fromUnits: number; toUnits: number }) => {
    if (!date || !ISO_DATE.test(date) || date < today) return;
    const key = `${kind}|${date}|${r.symbol.toUpperCase()}|${ratio ? `${ratio.fromUnits}:${ratio.toUnits}` : ""}`;
    const ev = byKey.get(key) ?? {
      kind,
      date,
      symbol: r.symbol,
      rowIds: [],
      fromUnits: ratio?.fromUnits ?? null,
      toUnits: ratio?.toUnits ?? null,
    };
    if (!ev.rowIds.includes(r.id)) ev.rowIds.push(r.id);
    byKey.set(key, ev);
  };
  for (const r of rows) {
    add("results", r.resultsDate, r);
    for (const a of r.corpActions) add(a.type, a.exDate, r, a);
    add("expiry", r.expiry, r);
  }
  const order: Record<UpcomingKind, number> = { expiry: 0, results: 1, split: 2, bonus: 3 };
  return [...byKey.values()].sort(
    (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || order[a.kind] - order[b.kind] || a.symbol.localeCompare(b.symbol),
  );
}

// ─── D8 Risk lens ─────────────────────────────────────────────────────────────

export interface RiskLensRow {
  id: number;
  symbol: string;
  /** What a stop fill gives back FROM THE MARK; null with no mark. */
  givesBackP: Paise | null;
  /** max(riskAtStopP, 0) / Σ — the row's slice of the stacked heat bar. Pro. */
  heatSharePpm: Ppm | null;
  /** Stop distance in ATR × 100. */
  atrAwayX100: number | null;
  state: StopState;
}

export interface RiskLensSummary {
  /** The heat strip's own figure — the WHOLE book's, whatever rows the lens was given. */
  heatPpm: Ppm | null;
  /**
   * Σ max(riskAtStopP, 0) over the rows the lens was GIVEN — the denominator of
   * every `heatSharePpm` below (C4 fix 2: a filtered view's shares are of the
   * filtered Σ, so this, not `heat.openRiskP`, is the figure printed beside a
   * share). null when no row carries a risk figure and `heat` is null (free);
   * 0 for an entitled book whose rows carry no stop risk.
   */
  openRiskP: Paise | null;
  /** Stops on the loss side of entry. */
  withRisk: number;
  lockedIn: number;
  atEntry: number;
  /** No stop recorded — out of heat, and counted. */
  excluded: number;
  /** Rows WITH a stop, ranked by give-back from the mark (largest first; unmarked last). */
  ranked: RiskLensRow[];
}

/** The collapsed line ("Heat x% · N stops with risk · N locked in · N excluded") and the ranked list. */
export function riskLensSummary(
  rows: readonly Pick<
    PositionViewRow,
    "id" | "symbol" | "side" | "qty" | "avgEntryP" | "markP" | "effectiveStopP" | "riskAtStopP" | "distanceToStopAtrX100"
  >[],
  heat: HeatView | null,
): RiskLensSummary {
  let withRisk = 0;
  let lockedIn = 0;
  let atEntry = 0;
  let excluded = 0;
  let riskSum = 0;
  let anyRisk = false;
  for (const r of rows) {
    if (r.riskAtStopP !== null) {
      anyRisk = true;
      riskSum += Math.max(r.riskAtStopP, 0);
    }
  }
  const ranked: RiskLensRow[] = [];
  for (const r of rows) {
    const state = stopState(r);
    if (state === null) {
      excluded += 1;
      continue;
    }
    if (state === "at-risk") withRisk += 1;
    else if (state === "locked-in") lockedIn += 1;
    else atEntry += 1;
    ranked.push({
      id: r.id,
      symbol: r.symbol,
      givesBackP: r.markP === null || r.effectiveStopP === null ? null : givesBackFrom(r.side, r.qty, r.markP, r.effectiveStopP),
      heatSharePpm: r.riskAtStopP === null || !anyRisk ? null : ppmFloor(Math.max(r.riskAtStopP, 0), riskSum > 0 ? riskSum : null),
      atrAwayX100: r.distanceToStopAtrX100,
      state,
    });
  }
  ranked.sort((a, b) => {
    if ((a.givesBackP === null) !== (b.givesBackP === null)) return a.givesBackP === null ? 1 : -1;
    return (b.givesBackP ?? 0) - (a.givesBackP ?? 0) || a.symbol.localeCompare(b.symbol) || a.id - b.id;
  });
  const openRiskP = anyRisk ? riskSum : heat !== null ? 0 : null;
  return { heatPpm: heat?.heatPpm ?? null, openRiskP, withRisk, lockedIn, atEntry, excluded, ranked };
}
