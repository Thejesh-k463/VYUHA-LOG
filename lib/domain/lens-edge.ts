// THE LENSES FREE/PRO SPLIT (PURE, no DB/React).
//
// The Lenses screen is HYBRID-gated: grouping, counts, sums and the per-group
// delete are free — that is journal hygiene, the recovery path from a bad
// import, and invariant 7 says the user's own record is never held hostage.
// The derived EDGE — win rate, profit factor, expectancy, average R — is the
// intelligence layer, and it is Pro.
//
// ── Why the split lives here and not in the component ───────────────────────
//
// The client used to call `computeKpis` itself, which made any gate
// decoration: the numbers were already in the browser. Now the SERVER
// computes, this module decides which half crosses the wire, and the client
// simply renders what it was given. `tests/lens-gating.test.ts` asserts the
// serialised payload contains no Pro field when unlicensed — a proof about
// the wire, not about CSS.
//
// ── Allow-list, never a spread ──────────────────────────────────────────────
//
// `Kpis` has ~20 fields (drawdown, streaks, best day…). `toLensRow` names
// every field it forwards; a new `Kpis` field lands on NEITHER side of the
// paywall until a human decides which side it belongs on. `...kpis` here
// would be the leak that ships next release.
//
// ── `edge: null` means NOT ENTITLED, never "no data" ────────────────────────
//
// The UI already uses "—" for "cannot be computed from your data" (a group
// with nothing closed — invariant 6). Locked must be structurally different,
// which one nullable OBJECT gives us: you cannot half-lock a row, and every
// read site is forced to branch.

import type { Kpis } from "@/lib/analytics/metrics";
import { chargesTotals, type ChargeReportTrade } from "@/lib/analytics/charges-report";
import type { Insight } from "@/lib/intelligence/insight";
import type { BatchGroup } from "./delete-scope";
import type { LensTrade } from "./lenses";

/**
 * Per-head charge sums for one group — the ~10 numbers behind the Charges KPI.
 * FREE: charges are the user's own costs, not derived intelligence (the same
 * side of the line the Charges & MTF Leak page sits on). Aggregated over
 * CLOSED trades only, so `total` reconciles with `LensTotals.charges`
 * (computeKpis sums closed trades — the card and its popup must agree).
 */
export interface LensChargeHeads {
  turnover: number;
  brokerage: number;
  sttCtt: number;
  exchangeTxn: number;
  /** SEBI + stamp duty + IPFT, the charges-report grouping. */
  statutory: number;
  gst: number;
  dpCharges: number;
  mtfInterest: number;
  pledgeCharges: number;
  total: number;
  /** Total charges as % of turnover — the average move needed to break even. */
  breakevenPct: number;
}

/** The charge-projection row this module aggregates: the charges-report shape
 *  plus the open flag it filters on. */
export type LensChargeTrade = ChargeReportTrade & { isOpen: boolean };

/** Per-group charge-head sums; `null` when nothing is closed — a popup with
 *  ten zeroes would read as "this group cost nothing" (invariant 6). */
export function lensChargeHeads(rows: LensChargeTrade[]): LensChargeHeads | null {
  const closed = rows.filter((r) => !r.isOpen);
  if (closed.length === 0) return null;
  const t = chargesTotals(closed);
  return {
    turnover: t.turnover,
    brokerage: t.brokerage,
    sttCtt: t.sttCtt,
    exchangeTxn: t.exchangeTxn,
    statutory: t.statutory,
    gst: t.gst,
    dpCharges: t.dpCharges,
    mtfInterest: t.mtfInterest,
    pledgeCharges: t.pledgeCharges,
    total: t.total,
    breakevenPct: t.breakevenPct,
  };
}

/** Sums over the user's own record. FREE. */
export interface LensTotals {
  count: number;
  openCount: number;
  closedCount: number;
  netPnl: number;
  charges: number;
  unpricedCount: number;
  unpricedNetPnl: number;
  /** Per-head split of `charges`; `null` = not computed (no closed trade, or
   *  a caller that did not load the charge projection). */
  chargeHeads: LensChargeHeads | null;
}

/** Derived edge. PRO. `null` at the row level = not entitled. */
export interface LensEdge {
  wins: number;
  losses: number;
  /** 0..1 */
  winRate: number;
  /** `null` = no losing trade to divide by. Normalised from Infinity HERE:
   *  this value now crosses the RSC payload, where JSON silently turns
   *  Infinity into null — better to do it deliberately than trust an encoder. */
  profitFactor: number | null;
  expectancy: number;
  /** `null` = no R recorded on any trade in the group. */
  avgR: number | null;
  avgWin: number;
  avgLoss: number;
  maxWinStreak: number;
  maxLossStreak: number;
  /** +n consecutive wins / -n consecutive losses, at the group's latest exit. */
  currentStreak: number;
}

/** Insights per group the popups will render. The cap is a presentation
 *  budget, not a sample rule — rules refuse individually before this. */
export const GROUP_INSIGHT_CAP = 3;

export interface LensRow {
  totals: LensTotals;
  edge: LensEdge | null;
  /** Server-run group insights. They cite edge-class figures, so they are PRO:
   *  absent from the wire entirely when unlicensed — never an empty decoy. */
  insights?: Insight[];
}

/** Split one KPI set. The allow-lists ARE the paywall boundary — the optional
 *  extras route through here too, so a call site cannot leak an insight past
 *  the gate by attaching it itself. */
export function toLensRow(
  k: Kpis,
  pro: boolean,
  extras?: { chargeHeads?: LensChargeHeads | null; insights?: Insight[] },
): LensRow {
  const totals: LensTotals = {
    count: k.count,
    openCount: k.openCount,
    closedCount: k.closedCount,
    netPnl: k.netPnl,
    charges: k.charges,
    unpricedCount: k.unpricedCount,
    unpricedNetPnl: k.unpricedNetPnl,
    chargeHeads: extras?.chargeHeads ?? null,
  };
  if (!pro) return { totals, edge: null };
  const row: LensRow = {
    totals,
    edge: {
      wins: k.wins,
      losses: k.losses,
      winRate: k.winRate,
      profitFactor: Number.isFinite(k.profitFactor) ? k.profitFactor : null,
      expectancy: k.expectancy,
      avgR: k.avgR,
      avgWin: k.avgWin,
      avgLoss: k.avgLoss,
      maxWinStreak: k.maxWinStreak,
      maxLossStreak: k.maxLossStreak,
      currentStreak: k.currentStreak,
    },
  };
  if (extras?.insights?.length) row.insights = extras.insights.slice(0, GROUP_INSIGHT_CAP);
  return row;
}

/**
 * ONE ROW OF THE LENSES LIST — the wire shape /lenses actually ships.
 *
 * The page used to send the whole book (`LensTrade[]`) and let the client
 * re-run `lensGroups` to rebuild these; on the 25,001-trade perf book that was
 * ~9.3 MB of RSC flight for a list of 45 rows (measured 2026-09-02). The
 * grouping already ran on the server to compute the KPIs, so shipping its
 * OUTPUT costs nothing extra and the client stops grouping altogether.
 *
 * The descriptor keeps its `scope` — including the ids a `filter` group
 * carries. That is the delete guarantee (`delete-scope.ts`): what the row
 * counted and what a delete removes are the same list, fixed at the moment the
 * page was rendered, not re-derived later from a different read.
 */
export interface LensGroupRow {
  group: BatchGroup;
  row: LensRow;
}

/**
 * What the DRILL-DOWN adds, fetched per group from `/api/lenses/members`.
 *
 * These three are rendered only after a group is opened, so computing them for
 * every group of all six lenses on every page load was work for screens nobody
 * had asked for: `runRules` alone was 214 ms of the 381 ms server loop, and the
 * charge heads cost a second whole-book projection read.
 *
 * `chargeHeads` and `insights` still route through `toLensRow`, so the paywall
 * allow-list stays the single gate — an unlicensed copy gets no `insights` key
 * from the route either.
 */
export interface LensGroupDetail {
  /** The group's FULL member list, in the same order `groupIds` produced —
   *  the drill-down's own `DRILL_LIMIT` slice is a rendering budget, and the
   *  top-5 ledger and delete preview read the whole array. */
  members: LensTrade[];
  chargeHeads: LensChargeHeads | null;
  insights?: Insight[];
}
