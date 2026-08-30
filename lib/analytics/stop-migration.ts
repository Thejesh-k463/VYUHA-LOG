/**
 * STOPS THAT MOVED AFTER ENTRY — mined from the audit log.
 *
 * ZERO DB and ZERO React imports; pure functions over already-parsed entries.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `audit_log` is append-only and carries `beforeJson`/`afterJson` for every
 * edit. It has only ever been DIFFED FOR DISPLAY (`audit-diff.ts`) and never
 * mined. A 2026-08-30 schema audit put it plainly: "how often do you move a
 * stop after entry is derivable from this and is not computed".
 *
 * That question matters more than most analytics on the product. Widening a
 * stop while a trade is against you converts a planned, sized loss into an
 * unplanned one, and it is invisible in every other report — the journal stores
 * the FINAL stop, so a trade whose stop was moved three times looks identical
 * to one that was left alone. The audit log is the only place the original
 * intention survives.
 *
 * ── What it refuses to do ─────────────────────────────────────────────────
 *
 * It reports the COUNT and the COST-AS-DIFFERENCE, never a counterfactual P&L.
 * "You would have lost ₹4,200 less if you had honoured the original stop"
 * requires knowing the price path after the edit, which Vyuha does not have at
 * intraday granularity. What it CAN say is: trades whose stop was widened have
 * an expectancy of X, trades whose stop was never touched have Y, and the gap
 * is Z — the same discipline `mistakeReport` already uses (invariant 6).
 */

export interface StopEdit {
  tradeId: number;
  /** ISO timestamp of the edit. */
  ts: string;
  /** Stop before the edit; null when it was not set. */
  before: number | null;
  /** Stop after the edit. */
  after: number | null;
  /** "long" | "short" — decides which direction is a widening. */
  direction: "long" | "short";
}

export type StopMove = "widened" | "tightened" | "set" | "removed" | "unchanged";

/**
 * Which way a stop moved, in RISK terms rather than in price terms.
 *
 * Widening is moving the stop AWAY from the entry — down on a long, up on a
 * short. That is the move that increases the loss you have agreed to take.
 */
export function classifyMove(e: StopEdit): StopMove {
  const { before, after, direction } = e;
  if (before == null && after == null) return "unchanged";
  if (before == null) return "set";
  if (after == null) return "removed";
  if (Math.abs(after - before) < 1e-9) return "unchanged";
  const wider = direction === "long" ? after < before : after > before;
  return wider ? "widened" : "tightened";
}

export interface StopMigrationReport {
  /** Trades whose stop was WIDENED at least once after entry. */
  widenedTrades: number;
  /** Trades whose stop was only ever tightened or left alone. */
  disciplinedTrades: number;
  /** Trades whose stop was REMOVED entirely after being set. */
  removedTrades: number;
  /** Total widening edits, which can exceed widenedTrades. */
  widenEvents: number;
  /** Worst single trade by number of widenings. */
  worstTradeId: number | null;
  worstTradeWidenings: number;
  /**
   * Expectancy of trades whose stop was widened, against those where it was
   * not — stated as a GAP, never as a counterfactual.
   */
  expectancyWidened: number | null;
  expectancyDisciplined: number | null;
  expectancyGap: number | null;
  /** Closed trades that had any stop edit at all — the measurable population. */
  measured: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function stopMigration(
  edits: StopEdit[],
  /** Closed trades, keyed by id, for the expectancy comparison. */
  netPnlByTrade: Map<number, number>,
): StopMigrationReport {
  const widenCount = new Map<number, number>();
  const removed = new Set<number>();
  const touched = new Set<number>();

  for (const e of edits) {
    const move = classifyMove(e);
    if (move === "unchanged") continue;
    touched.add(e.tradeId);
    if (move === "widened") widenCount.set(e.tradeId, (widenCount.get(e.tradeId) ?? 0) + 1);
    if (move === "removed") removed.add(e.tradeId);
  }

  // Only trades we have a P&L for can enter the expectancy comparison; the
  // counts above are over every edit, so the two populations are stated apart.
  const scored = [...netPnlByTrade.keys()];
  const widenedIds = scored.filter((id) => (widenCount.get(id) ?? 0) > 0);
  const disciplinedIds = scored.filter((id) => (widenCount.get(id) ?? 0) === 0);

  const mean = (ids: number[]) =>
    ids.length ? r2(ids.reduce((s, id) => s + (netPnlByTrade.get(id) ?? 0), 0) / ids.length) : null;

  const expectancyWidened = mean(widenedIds);
  const expectancyDisciplined = mean(disciplinedIds);

  let worstTradeId: number | null = null;
  let worstTradeWidenings = 0;
  for (const [id, n] of widenCount) {
    if (n > worstTradeWidenings) {
      worstTradeWidenings = n;
      worstTradeId = id;
    }
  }

  return {
    widenedTrades: widenCount.size,
    disciplinedTrades: disciplinedIds.length,
    removedTrades: removed.size,
    widenEvents: [...widenCount.values()].reduce((s, n) => s + n, 0),
    worstTradeId,
    worstTradeWidenings,
    expectancyWidened,
    expectancyDisciplined,
    expectancyGap:
      expectancyWidened != null && expectancyDisciplined != null
        ? r2(expectancyWidened - expectancyDisciplined)
        : null,
    measured: touched.size,
  };
}

/**
 * The sentence the screen shows. Returns null when there is nothing honest to
 * say — no widenings, or no comparison population.
 */
export function stopMigrationFinding(r: StopMigrationReport, minSample = 10): string | null {
  if (r.widenedTrades === 0) return null;
  if (r.expectancyGap == null) return null;
  const n = r.widenedTrades + r.disciplinedTrades;
  if (n < minSample) return null;
  if (r.expectancyGap >= 0) {
    return `You widened a stop on ${r.widenedTrades} trade${r.widenedTrades === 1 ? "" : "s"}. On this book those trades did NOT do worse — the gap is ₹${r.expectancyGap} per trade in their favour, so this is not currently costing you.`;
  }
  return `You widened a stop after entry on ${r.widenedTrades} trade${r.widenedTrades === 1 ? "" : "s"} (${r.widenEvents} edit${r.widenEvents === 1 ? "" : "s"}). Those trades average ₹${Math.abs(r.expectancyGap)} WORSE per trade than the ones where the stop stood.`;
}
