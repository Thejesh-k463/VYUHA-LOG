/**
 * The Live Desk WIRE SHAPES — what the server page hands the client.
 *
 * PURE on purpose: no `server-only`, no `@/lib/db`, no React. The client
 * component imports its types from here rather than from `load-desk.ts`, so a
 * type import can never drag the database into the browser bundle (the same
 * split `lib/quotes/index.ts` vs `lib/quotes/types.ts` makes).
 *
 * UNITS (invariant 1): every money field below is INTEGER PAISE, inherited
 * from `lib/live/types.ts`. Rupees appear only in `desk-format.ts`, at the
 * render edge. Percentages are ppm integers. Nothing here is a float rupee.
 */

import type { ConcentrationRow, HeatView } from "@/lib/live/heat";
import type { StopResult } from "@/lib/live/stop";
import type { ProviderId, Staleness } from "@/lib/quotes/types";
import type { Bar, TrackerRow } from "@/lib/live/types";

/**
 * One OHLC bar for the position chart, in PAISE.
 *
 * This is `lib/live/types.ts` `Bar` under a local name, NOT a second shape: W2's
 * real `PositionChartPanel` takes `Bar[]` (`{date, openP, highP, lowP, closeP,
 * volume}`), and a desk-local `{date,o,h,l,c,v}` would have to be re-mapped at
 * the one call site — a rename nothing type-checks end to end once the panel is
 * loaded through `next/dynamic`. `volume` stays nullable because a stored
 * bhavcopy row may carry none (invariant 6 — a fabricated 0 would drive RVOL).
 */
export type DeskBar = Bar;

/** MTF drag, present ONLY on rows whose product is MTF (owner ruling Q41). */
export interface MtfBlock {
  fundedP: number;
  ownCapitalP: number;
  accruedInterestP: number;
}

/**
 * A tracker row on the wire: everything `computeTrackerRow` produced, plus the
 * few identity fields the desk renders and the sparkline's closes.
 *
 * `accountId` is on every row by construction (owner ruling Q19, invariant 8) —
 * it arrives from `LivePosition` and is never re-derived in the client.
 */
export interface DeskRow extends TrackerRow {
  /** Display name for the account chip; null when the account row is gone. */
  accountName: string | null;
  bucket: string;
  broker: string;
  isin: string | null;
  /** ISO date of the first entry — the chart's left anchor. */
  entryDate: string | null;
  lotSize: number | null;
  mtf: MtfBlock | null;
  /**
   * The stop tree's answer for this row (`manual → structure → ATR → percent`,
   * owner ruling Q33). `{kind:"risk-not-set"}` is what routes the row to the
   * Sizing Lab; it is never rendered as a level.
   */
  stop: StopResult;
  /** Last ≤ SPARK_SESSIONS closes in paise, ascending. The sparkline's ONLY input. */
  spark: number[];
}

/** What the desk knows about the feed it printed its marks from. */
export interface FeedInfo {
  providerId: ProviderId;
  label: string;
  streaming: boolean;
  staleness: Staleness;
  ok: boolean;
  reason: string | null;
  /** Newest `asOf` across every mark on the desk; null when nothing is marked. */
  asOf: string | null;
}

/** What the chart payload held back, stated rather than silently trimmed. */
export interface BarsCap {
  sessions: number;
  symbols: number;
  /** True when at least one symbol's history was cut by either cap. */
  trimmed: boolean;
}

export interface DeskAccount {
  id: number;
  name: string;
}

/** Everything `app/live/page.tsx` loads and hands to the client, in one shape. */
export interface LiveDeskData {
  rows: DeskRow[];
  heat: HeatView;
  concentration: ConcentrationRow[];
  accounts: DeskAccount[];
  /** `getSelectedAccountId()`; 0 is the aggregate VIEW, never a write target. */
  selectedAccountId: number;
  feed: FeedInfo;
  /** True when `risk_config.risk_pct_ppm` is unset — the Sizing Lab banner. */
  riskNotSet: boolean;
  /** ATR length actually used, so the row can say "needs N sessions" honestly. */
  atrLength: number;
  barsBySymbol: Record<string, DeskBar[]>;
  barsCap: BarsCap;
  today: string;
}
