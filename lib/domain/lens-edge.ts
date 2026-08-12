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

/** Sums over the user's own record. FREE. */
export interface LensTotals {
  count: number;
  openCount: number;
  closedCount: number;
  netPnl: number;
  charges: number;
  unpricedCount: number;
  unpricedNetPnl: number;
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
}

export interface LensRow {
  totals: LensTotals;
  edge: LensEdge | null;
}

/** Split one KPI set. The allow-lists ARE the paywall boundary. */
export function toLensRow(k: Kpis, pro: boolean): LensRow {
  const totals: LensTotals = {
    count: k.count,
    openCount: k.openCount,
    closedCount: k.closedCount,
    netPnl: k.netPnl,
    charges: k.charges,
    unpricedCount: k.unpricedCount,
    unpricedNetPnl: k.unpricedNetPnl,
  };
  if (!pro) return { totals, edge: null };
  return {
    totals,
    edge: {
      wins: k.wins,
      losses: k.losses,
      winRate: k.winRate,
      profitFactor: Number.isFinite(k.profitFactor) ? k.profitFactor : null,
      expectancy: k.expectancy,
      avgR: k.avgR,
    },
  };
}
