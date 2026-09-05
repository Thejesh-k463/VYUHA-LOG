/**
 * The staleness ledger (04 section 4.4). It publishes exactly four things,
 * and the panel is not allowed to render a figure without them:
 *
 *   1. the ANCHOR — which session the whole screen is as of, and how many
 *      symbols were on it (2,821 of 2,957 is a different screen from 2,957);
 *   2. the PER-METRIC DENOMINATOR — the universe count is never reused as the
 *      denominator of a metric that needs 200 sessions;
 *   3. the INSUFFICIENT-HISTORY count, kept SEPARATE from "excluded" — a
 *      symbol that is too young is not a symbol that was thrown out;
 *   4. the CORPORATE-ACTION state — how many symbols an unreconciled price
 *      gap removed from the return windows, and on which dates.
 *
 * Plus the two identifiers that make a stored snapshot re-checkable:
 * `spec_version` (semver on the FORMULA SET) and `input_checksum`. If the
 * checksum no longer matches the bars, the snapshot is stale evidence, not
 * data.
 */
import type { StaleSymbol } from "./anchor";
import type { ExclusionReason, IsoDate } from "./types";

export interface LedgerSymbol {
  symbol: string;
  lastSeen?: IsoDate;
  sessionsBehind?: number;
  detail?: string;
}

export interface LedgerExclusion {
  reason: ExclusionReason;
  count: number;
  symbols: LedgerSymbol[];
}

export interface MetricDenominator {
  metric: string;
  denominator: number;
  coverage_ppm: number;
  /** Symbols that had a bar on the anchor but not enough history for THIS metric. */
  insufficient_history: number;
}

export interface HistoryShortfall {
  metric: string;
  needsSessions: number;
  youHaveSessions: number;
  line: string;
}

export interface StalenessLedger {
  as_of: IsoDate | null;
  generated_at: string;
  spec_version: string;
  input_checksum: string;
  anchor: {
    date: IsoDate | null;
    policy: string;
    coverage: number;
    total: number;
    coverage_ppm: number;
    truncated: number;
  };
  denominators: MetricDenominator[];
  shortfalls: HistoryShortfall[];
  exclusions: LedgerExclusion[];
  /** Sum over `exclusions`, so the screen can print one honest total. */
  excluded_total: number;
}

export const ANCHOR_POLICY = "latest modal session, ties to the later date";

/** The depth-shortfall sentence, verbatim from the approved copy list. */
export function shortfallLine(needsSessions: number, youHaveSessions: number): string {
  return `Needs ${needsSessions} sessions of price history. You have ${youHaveSessions}.`;
}

export interface LedgerInput {
  asOf: IsoDate | null;
  generatedAt: string;
  specVersion: string;
  inputChecksum: string;
  anchorCoverage: number;
  anchorTotal: number;
  truncated: string[];
  stale: StaleSymbol[];
  nonEquity: string[];
  /** Symbols with a bar on the anchor but too little history for every depth metric. */
  insufficientHistory: string[];
  corporateAction: { symbol: string; date: IsoDate; ratioPpm: number }[];
  denominators: MetricDenominator[];
  shortfalls: HistoryShortfall[];
}

/** Assemble the ledger. Ordering is deterministic so two runs serialise alike. */
export function buildLedger(input: LedgerInput): StalenessLedger {
  const exclusions: LedgerExclusion[] = [];

  const push = (reason: ExclusionReason, symbols: LedgerSymbol[]) => {
    if (symbols.length === 0) return;
    exclusions.push({
      reason,
      count: symbols.length,
      symbols: [...symbols].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
    });
  };

  push(
    "no_bar_on_anchor",
    input.stale.map((s) => ({ symbol: s.symbol, lastSeen: s.lastSeen, sessionsBehind: s.sessionsBehind })),
  );
  push(
    "truncated_to_anchor",
    input.truncated.map((symbol) => ({ symbol, lastSeen: input.asOf ?? undefined, sessionsBehind: 0 })),
  );
  push(
    "non_equity",
    input.nonEquity.map((symbol) => ({ symbol })),
  );
  push(
    "insufficient_history",
    input.insufficientHistory.map((symbol) => ({ symbol })),
  );
  push(
    "corporate_action_unreconciled",
    input.corporateAction.map((c) => ({
      symbol: c.symbol,
      lastSeen: c.date,
      detail: `close gap ${(c.ratioPpm / 10_000).toFixed(1)}% on ${c.date}`,
    })),
  );

  const coverage_ppm =
    input.anchorTotal > 0 ? Math.round((input.anchorCoverage * 1_000_000) / input.anchorTotal) : 0;

  return {
    as_of: input.asOf,
    generated_at: input.generatedAt,
    spec_version: input.specVersion,
    input_checksum: input.inputChecksum,
    anchor: {
      date: input.asOf,
      policy: ANCHOR_POLICY,
      coverage: input.anchorCoverage,
      total: input.anchorTotal,
      coverage_ppm,
      truncated: input.truncated.length,
    },
    denominators: [...input.denominators].sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)),
    shortfalls: [...input.shortfalls].sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0)),
    exclusions,
    excluded_total: exclusions.reduce((n, e) => n + e.count, 0),
  };
}
