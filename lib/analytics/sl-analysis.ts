/**
 * STOP-LOSS DISCIPLINE ANALYTICS (PURE — no DB, no React).
 *
 * v3.5.0 M1. `slPlanned` / `trailingSl` have been captured since the first
 * schema and read almost nowhere; every function here works over the trades
 * that actually RECORDED a stop and says how many did not (invariant 6 —
 * never fabricate a denominator, always state coverage).
 *
 * Data reality the caller must respect when mapping rows in:
 *   - `slPlanned` / `trailingSl` are per-unit REAL rupee PRICES (never paise).
 *   - They are null on 100% of imported trades today — only manual create /
 *     edit / staged legs write them — so coverage counts are the headline,
 *     not a footnote.
 *   - `riskAmount` is generic (default-cap) on imports, so R here is derived
 *     from the recorded stop itself (|entry − stop| × qty), never from
 *     `riskAmount`.
 *
 * Everything is DESCRIPTIVE: "trades that slipped past their stop lost this
 * much more" — never "you would have saved ₹X" (counterfactuals aren't
 * observable; see behavior.ts for the same framing).
 */

export type SlDirection = "long" | "short";

export interface SlTrade {
  isOpen: boolean;
  netPnl: number; // rupees
  qty: number; // matched units on a closed row
  avgBuyPrice: number | null; // per-unit REAL
  avgSellPrice: number | null; // per-unit REAL
  slPlanned: number | null; // per-unit REAL — the ORIGINAL stop
  trailingSl: number | null; // per-unit REAL
  setupTag: string | null;
  /**
   * Long/short when the caller knows it (staged positions, F&O sides).
   * The flat `trades` row stores no direction — see `resolveDirection`
   * for what can and cannot be derived without it.
   */
  direction?: SlDirection | null;
  /**
   * ₹/unit maximum adverse excursion (≥ 0), mapped from mae-mfe.ts
   * (`maeRs / qty`) where bar coverage exists. EOD granularity — intraday
   * extremes are invisible. Optional; winners without it are counted as
   * unmeasured, never guessed.
   */
  maePerUnit?: number | null;
}

/**
 * "At the stop" tolerance: ±0.5% of the stop PRICE. An exit inside this band
 * is a stop honoured through normal market-order slippage and tick rounding;
 * outside it is a real slip or a discretionary exit. 0.5% ≈ 2–3 ticks on a
 * ₹100 scrip and comfortably above one tick on anything liquid.
 */
export const STOP_TOLERANCE_PCT = 0.005;

/** Closed trades needed before the stats stop being mostly noise (= behavior.ts). */
export const MIN_SAMPLE = 20;

/**
 * A winner "never risked its stop" when its adverse excursion stayed inside
 * half the stop distance; it "nearly stopped out" when the excursion came
 * within tolerance of the stop (or crossed it — survivable at EOD granularity).
 */
export const NEVER_RISKED_FRACTION = 0.5;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Direction of a closed row, derived HONESTLY or not at all.
 *
 * The flat row stores buy and sell aggregates, and gross P&L is
 * `sell − buy` for BOTH directions — prices and P&L alone cannot separate a
 * losing long from a losing short. What can: a protective stop sits on the
 * loss side of its entry. Long ⇒ stop below the buy price; short ⇒ stop
 * above the sell price. When exactly one reading is protective, that is the
 * direction; when both are (stop strictly between the two prices — which is
 * where every slipped stop lands) or neither is, we return null and the row
 * is EXCLUDED and counted. Callers that know the direction should pass it.
 */
export function resolveDirection(t: SlTrade): SlDirection | null {
  if (t.direction) return t.direction;
  const b = t.avgBuyPrice;
  const s = t.avgSellPrice;
  const sl = t.slPlanned;
  if (sl == null || b == null || s == null || b <= 0 || s <= 0) return null;
  const longProtective = sl < b;
  const shortProtective = sl > s;
  if (longProtective && !shortProtective) return "long";
  if (shortProtective && !longProtective) return "short";
  return null;
}

export type StopOutcome = "held-to-stop" | "slipped-past" | "exited-early";

interface Resolved {
  dir: SlDirection;
  entry: number; // per-unit
  exit: number; // per-unit
  stop: number; // per-unit
}

/** Entry/exit/stop in direction terms, or null when the row can't be read. */
function resolve(t: SlTrade): Resolved | null {
  const dir = resolveDirection(t);
  if (dir == null || t.slPlanned == null) return null;
  const b = t.avgBuyPrice;
  const s = t.avgSellPrice;
  if (b == null || s == null || b <= 0 || s <= 0 || t.qty <= 0) return null;
  return dir === "long"
    ? { dir, entry: b, exit: s, stop: t.slPlanned }
    : { dir, entry: s, exit: b, stop: t.slPlanned };
}

export interface LoserClassification {
  outcome: StopOutcome;
  /** ₹ beyond the stop, > 0 only for "slipped-past". */
  slippageRs: number;
  /**
   * Slippage in R, denominated by the SL-DERIVED risk |entry − stop| × qty —
   * never by `riskAmount`, which is a generic cap on imports. Null when the
   * stop sits on the entry (no denominator; invariant 6).
   */
  slippageR: number | null;
}

/** Classify one LOSING trade's exit against its recorded stop. */
export function classifyLoser(t: SlTrade): LoserClassification | null {
  const rz = resolve(t);
  if (rz == null || t.netPnl >= 0) return null;
  const { dir, entry, exit, stop } = rz;
  const tol = stop * STOP_TOLERANCE_PCT;
  // Signed distance the exit sits BEYOND the stop, in the losing direction.
  const beyond = dir === "long" ? stop - exit : exit - stop;
  let outcome: StopOutcome;
  if (beyond > tol) outcome = "slipped-past";
  else if (beyond >= -tol) outcome = "held-to-stop";
  else outcome = "exited-early";
  const slippageRs = outcome === "slipped-past" ? r2(beyond * t.qty) : 0;
  const slRiskRs = Math.abs(entry - stop) * t.qty;
  return {
    outcome,
    slippageRs,
    slippageR: outcome === "slipped-past" && slRiskRs > 0 ? r2(slippageRs / slRiskRs) : null,
  };
}

export interface SlReport {
  closed: number; // closed trades seen
  withSl: number; // closed trades with a recorded stop
  /** Rows with a stop whose direction could not be derived (or prices were
   *  missing) — EXCLUDED from the classification, never guessed. */
  excluded: number;

  // ── losing trades, classified against their stop ────────────────────────
  losersClassified: number;
  heldToStop: number;
  slippedPast: number;
  exitedEarly: number;
  totalSlippageRs: number; // Σ over slipped trades
  avgSlippageRs: number | null; // per slipped trade
  avgSlippageR: number | null; // over slipped trades with an SL-derived denominator
  slippageRFrom: number; // how many slipped trades had one

  // ── coverage: how often a losing trade recorded ANY stop ────────────────
  losingTrades: number;
  losingWithSl: number;
  losingWithoutSl: number;
  slCoveragePct: number | null; // losingWithSl / losingTrades × 100

  // ── the discipline argument, expectancy-gap framing ─────────────────────
  avgLossWithSl: number | null; // mean net ₹ of losers that recorded a stop
  avgLossWithoutSl: number | null;
  /**
   * avgLossWithSl − avgLossWithoutSl: positive when stop-recorded losers lost
   * LESS per trade. Descriptive, not causal — the no-stop population may
   * simply be the imported one.
   */
  lossGapRs: number | null;

  // ── winners vs the stop they never paid (needs maePerUnit) ──────────────
  winnersWithSl: number;
  winnersMeasured: number; // winners with an MAE to measure against
  winnersNeverRisked: number; // MAE inside NEVER_RISKED_FRACTION of stop distance
  winnersNearStop: number; // MAE within tolerance of the stop, or past it
}

export function slReport(trades: SlTrade[]): SlReport {
  const closed = trades.filter((t) => !t.isOpen);
  const withSl = closed.filter((t) => t.slPlanned != null);

  const losers = closed.filter((t) => t.netPnl < 0);
  const losersWithSl = losers.filter((t) => t.slPlanned != null);
  const losersWithoutSl = losers.filter((t) => t.slPlanned == null);

  let excluded = 0;
  let held = 0, slipped = 0, early = 0;
  let totalSlippage = 0;
  let rSum = 0, rCount = 0;
  for (const t of losersWithSl) {
    const c = classifyLoser(t);
    if (c == null) {
      excluded++;
      continue;
    }
    if (c.outcome === "held-to-stop") held++;
    else if (c.outcome === "exited-early") early++;
    else {
      slipped++;
      totalSlippage += c.slippageRs;
      if (c.slippageR != null) { rSum += c.slippageR; rCount++; }
    }
  }

  // Winners: did the trade ever come near the stop it recorded?
  const winnersWithSl = closed.filter((t) => t.netPnl > 0 && t.slPlanned != null);
  let winnersResolvable = 0, winnersMeasured = 0, neverRisked = 0, nearStop = 0;
  for (const t of winnersWithSl) {
    const rz = resolve(t);
    if (rz == null) {
      excluded++;
      continue;
    }
    winnersResolvable++;
    if (t.maePerUnit == null || t.maePerUnit < 0) continue; // unmeasured, not assumed safe
    winnersMeasured++;
    const dist = Math.abs(rz.entry - rz.stop); // per-unit stop distance
    const tol = rz.stop * STOP_TOLERANCE_PCT;
    if (t.maePerUnit >= dist - tol) nearStop++;
    else if (t.maePerUnit <= dist * NEVER_RISKED_FRACTION) neverRisked++;
  }

  const sum = (xs: SlTrade[]) => xs.reduce((s, t) => s + t.netPnl, 0);
  const avgLossWithSl = losersWithSl.length ? r2(sum(losersWithSl) / losersWithSl.length) : null;
  const avgLossWithoutSl = losersWithoutSl.length
    ? r2(sum(losersWithoutSl) / losersWithoutSl.length)
    : null;

  const losersClassified = held + slipped + early;
  return {
    closed: closed.length,
    withSl: withSl.length,
    excluded,
    losersClassified,
    heldToStop: held,
    slippedPast: slipped,
    exitedEarly: early,
    totalSlippageRs: r2(totalSlippage),
    avgSlippageRs: slipped ? r2(totalSlippage / slipped) : null,
    avgSlippageR: rCount ? r2(rSum / rCount) : null,
    slippageRFrom: rCount,
    losingTrades: losers.length,
    losingWithSl: losersWithSl.length,
    losingWithoutSl: losersWithoutSl.length,
    slCoveragePct: losers.length ? r2((losersWithSl.length / losers.length) * 100) : null,
    avgLossWithSl,
    avgLossWithoutSl,
    lossGapRs:
      avgLossWithSl != null && avgLossWithoutSl != null
        ? r2(avgLossWithSl - avgLossWithoutSl)
        : null,
    winnersWithSl: winnersResolvable,
    winnersMeasured,
    winnersNeverRisked: neverRisked,
    winnersNearStop: nearStop,
  };
}

// ---------------------------------------------------------------------------
// Per-setup stop discipline
// ---------------------------------------------------------------------------

export interface SetupSlStat {
  key: string; // setupTag or "(untagged)"
  closedWithSl: number;
  losersClassified: number;
  heldToStop: number;
  slippedPast: number;
  exitedEarly: number;
  totalSlippageRs: number;
  /** < MIN_SAMPLE stop-recorded trades — read with caution, don't rank on it. */
  smallSample: boolean;
}

/**
 * The same classification grouped by setup. A local grouper rather than
 * metrics.ts's `groupBy`, whose accumulator is fixed to GroupStat — the key
 * convention ("(untagged)") matches `bySetup` there.
 */
export function slBySetup(trades: SlTrade[]): SetupSlStat[] {
  const groups = new Map<string, SlTrade[]>();
  for (const t of trades) {
    if (t.isOpen || t.slPlanned == null) continue;
    const k = t.setupTag || "(untagged)";
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  const out: SetupSlStat[] = [];
  for (const [key, list] of groups) {
    let held = 0, slipped = 0, early = 0, totalSlippage = 0;
    for (const t of list) {
      const c = classifyLoser(t);
      if (c == null) continue;
      if (c.outcome === "held-to-stop") held++;
      else if (c.outcome === "exited-early") early++;
      else {
        slipped++;
        totalSlippage += c.slippageRs;
      }
    }
    out.push({
      key,
      closedWithSl: list.length,
      losersClassified: held + slipped + early,
      heldToStop: held,
      slippedPast: slipped,
      exitedEarly: early,
      totalSlippageRs: r2(totalSlippage),
      smallSample: list.length < MIN_SAMPLE,
    });
  }
  // Worst slippage first — the group that needs looking at.
  return out.sort((a, b) => b.totalSlippageRs - a.totalSlippageRs);
}

// ---------------------------------------------------------------------------
// Trailing-stop usage vs the rest of the book
// ---------------------------------------------------------------------------

export interface TslReport {
  closed: number;
  withTsl: number; // closed trades that recorded a trailing stop
  withoutTsl: number; // the baseline: every other closed trade, same population
  /**
   * Null below MIN_SAMPLE on the respective side — a win rate over 5 trades
   * is a coin story, not a statistic.
   */
  tslWinRatePct: number | null;
  tslExpectancy: number | null; // avg net ₹ per TSL trade
  baselineWinRatePct: number | null;
  baselineExpectancy: number | null;
  /** tslExpectancy − baselineExpectancy; only when BOTH sides clear the floor. */
  expectancyGapRs: number | null;
  smallSample: boolean; // either side below MIN_SAMPLE
}

/**
 * Trades that recorded a trailing stop vs those that did not, over the SAME
 * population (all closed trades passed in). Descriptive: TSL users may also
 * be the manual-journal trades, the baseline mostly imports — the gap says
 * what happened, not what the TSL caused.
 */
export function tslReport(trades: SlTrade[]): TslReport {
  const closed = trades.filter((t) => !t.isOpen);
  const withTsl = closed.filter((t) => t.trailingSl != null);
  const withoutTsl = closed.filter((t) => t.trailingSl == null);

  const stats = (xs: SlTrade[]) => {
    if (xs.length < MIN_SAMPLE) return { winRate: null, expectancy: null };
    const wins = xs.filter((t) => t.netPnl > 0).length;
    const net = xs.reduce((s, t) => s + t.netPnl, 0);
    return { winRate: r2((wins / xs.length) * 100), expectancy: r2(net / xs.length) };
  };
  const tsl = stats(withTsl);
  const base = stats(withoutTsl);

  return {
    closed: closed.length,
    withTsl: withTsl.length,
    withoutTsl: withoutTsl.length,
    tslWinRatePct: tsl.winRate,
    tslExpectancy: tsl.expectancy,
    baselineWinRatePct: base.winRate,
    baselineExpectancy: base.expectancy,
    expectancyGapRs:
      tsl.expectancy != null && base.expectancy != null
        ? r2(tsl.expectancy - base.expectancy)
        : null,
    smallSample: withTsl.length < MIN_SAMPLE || withoutTsl.length < MIN_SAMPLE,
  };
}
