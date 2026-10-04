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

import type { OwnCapitalUnstated } from "@/lib/analytics/positions";
import type { ConcentrationRow, HeatView } from "@/lib/live/heat";
import type { StopResult } from "@/lib/live/stop";
import type { Exchange, ProviderId, Staleness } from "@/lib/quotes/types";
import type { Bar, Paise, TrackerRow } from "@/lib/live/types";
import type { CorpActionChip, PartialBooking } from "@/lib/live/positions-view";

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
  fundedP: number | null; // null when the journal never recorded what the broker funded — NEVER the margin estimate (wave 2N D7, invariant 6)
  ownCapitalP: number | null; // null unless the row is a plain held buy leg with a stated funded amount (wave 2L L2 + wave 2N D7)
  accruedInterestP: number;
  /** WHY the two above are null, so the desk states the reason next to the dash
   *  rather than a bare em dash (invariant 6). Null when the row states them. */
  unstated: OwnCapitalUnstated;
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
  /**
   * The exchange this position's quotes are keyed on — the same value
   * `load-desk.ts` puts in the `QuoteKey` it asks the provider for.
   *
   * It rides on the row because the LIVE stream is keyed on
   * `quoteKeyId()` = `exchange:tradingsymbol`, and the client has to match a
   * tick frame to a row without re-deriving an exchange it was never told.
   * Guessing "NSE" would price a BSE-only holding — and two contracts of one
   * underlying — from the wrong book. It is NOT on `TrackerRow`: the row
   * engine does no arithmetic with it, exactly like `isin` and `accountName`.
   */
  exchange: Exchange;
  isin: string | null;
  /**
   * `equity | option | future` (`lib/domain/constants.ts`), or null when the
   * journal never recorded one.
   *
   * It rides on the row for the same reason `exchange` does: the client has to
   * tell a contract from a cash scrip WITHOUT re-deriving it. Ruling 4.2-8
   * labels a derivative's mark cell "Not priced by this feed" under a feed that
   * quotes cash only, and guessing from the tradingsymbol would label the wrong
   * rows. It stays OUT of `TrackerRow` (`lib/live/types.ts`) because the row
   * engine does no arithmetic with it — an identity fact, like `isin`.
   */
  instrumentType: string | null;
  /** ISO date of the first entry — the chart's left anchor. */
  entryDate: string | null;
  lotSize: number | null;
  /**
   * `instruments.results_date` for this symbol — ISO `YYYY-MM-DD`, or null.
   *
   * A STRING, not a computed distance: the distance depends on `today`, which
   * the payload already carries once (`LiveDeskData.today`), and shipping a
   * per-row number would put the same date arithmetic on 40+ rows and let a
   * cached payload go stale at midnight. `daysToResults()` derives it at
   * render. It stays OUT of `TrackerRow` because it is not arithmetic the row
   * engine does — it is an identity fact, like `isin` and `accountName` above.
   */
  resultsDate: string | null;
  mtf: MtfBlock | null;
  /**
   * The stop tree's answer for this row (`manual → structure → ATR → percent`,
   * owner ruling Q33). `{kind:"risk-not-set"}` is what routes the row to the
   * Sizing Lab; it is never rendered as a level.
   */
  stop: StopResult;
  /** Last ≤ SPARK_SESSIONS closes in paise, ascending. The sparkline's ONLY input. */
  spark: number[];

  // ── v4.7.0 wave C4 — the Positions tab (design C4-DESIGN-2026-10-04) ──────
  // The trade id the deep link `/trades?trade=<id>` and Edit levels need is
  // `TrackerRow.id` — it IS the parent trade's id — so no `tradeId` is added.

  /** D4 — the exchanges' industry; null for a user tag / index-map hit (sector-only → falls UP). */
  industry: string | null;
  /** D4 — the sector from `getClassificationResolution()`; null = unclassified. */
  sectorName: string | null;
  /** D4 — "user" | "taxonomy" | "index", or null when unclassified. */
  classSource: string | null;
  /** D6 (free) — what the parent row already booked, before charges; null when nothing is. */
  partial: PartialBooking | null;
  /** P5 (free) — recorded bonus/split actions with exDate ≥ today − 30 days, ascending. */
  corpActions: CorpActionChip[];
  /** P7 — the close of the last session BEFORE `today`, from the bars already read; null if none. */
  prevCloseP: Paise | null;
  /** D10 — the inline calculator's defaults. PRO ONLY: null on free, and null when capital or risk % is unset. */
  sizing: { capitalP: Paise; riskPpm: number } | null;
  /** D8 — the contract's STORED expiry (`trades.expiry`), derivatives only; null otherwise. Never parsed from a symbol. */
  expiry: string | null;
  /**
   * D11 — the two stored stop levels SEPARATELY (the row's `effectiveStopP` is
   * `trailing ?? planned`). Edit levels must pre-fill both, or a save would move
   * a trailing SL into the original-SL field. Levels are free (P6). Paise,
   * rounded from the journal's REAL level like `avgEntryP`.
   */
  slPlannedP: Paise | null;
  trailingSlP: Paise | null;
}

/**
 * Why the feed cannot run, as a value rather than as a sentence.
 *
 * Mirrors `OpenAlgoHealth["state"]` (`lib/quotes/openalgo.ts`) and the same
 * field `/api/live/feed` publishes. A provider that reports no state gets the
 * `ok`/`disabled` fallback the feed route already applies.
 */
export type FeedHealthState = "ok" | "no-key" | "unreachable" | "disabled";

/** What the desk knows about the feed it printed its marks from. */
export interface FeedInfo {
  providerId: ProviderId;
  label: string;
  streaming: boolean;
  staleness: Staleness;
  ok: boolean;
  /**
   * WHICH failure, so the desk can act on it. `reason` below is the sentence
   * the user reads; this is what the once-a-day connect prompt (owner answer
   * Q24) branches on — it shows for `no-key` and `unreachable`, the two states
   * a reconnection actually fixes, and never for `disabled`.
   */
  healthState: FeedHealthState;
  reason: string | null;
  /** Newest `asOf` across every mark on the desk; null when nothing is marked. */
  asOf: string | null;
  /**
   * How many DISTINCT quote keys the SSR render handed the provider — the
   * deduped `quoteKeyId()` count, not the row count (two open trades in one
   * scrip are one subscription; `load-desk.ts` dedupes exactly as
   * `app/api/live/stream/route.ts` and `lib/quotes/persist-mark.ts` do).
   *
   * It is on the wire because the client has to state the Angel One quote
   * cadence BEFORE the stream connects, and the cadence is a function of the
   * subscription size (`ANGELONE_CADENCE_TIERS`, `lib/quotes/types.ts`).
   * Counting rows in the client would over-state it on any book that holds one
   * scrip twice, and inventing a number is what invariant 6 forbids — so
   * `null` means NO PROVIDER SNAPSHOT WAS TAKEN (the provider threw), and the
   * client must say it does not know rather than print a cadence.
   */
  symbolCount: number | null;
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
  /**
   * PRO (Q55). `null` means NOT ENTITLED — the same shape `lib/domain/lens-edge.ts`
   * uses for `edge`. It is never an empty `HeatView`: a zeroed strip would read
   * as "no risk on this book", which is the opposite of "you cannot see this".
   */
  heat: HeatView | null;
  /** PRO (Q55). `null` = not entitled; `[]` = an empty book. Two facts, two values. */
  concentration: ConcentrationRow[] | null;
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
  /**
   * v4.7.0 C4 — the Positions tab's settings. `deployCapPpm` and
   * `atrMultPermille` are the user's stored `risk_config` values (null = unset);
   * `capitalP` (the heat strip's denominator, total capital) is PRO ONLY — null
   * on free, exactly as `pctOfCapital` is.
   */
  positions: { deployCapPpm: number | null; atrMultPermille: number | null; capitalP: Paise | null };
}
