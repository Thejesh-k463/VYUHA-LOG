// P1.4 — pre-trade risk limits engine (PURE, no DB/React). Turns the advisory
// risk_config into enforced guardrails: given a prospective order + the current
// portfolio state + the resolved rule set, return pass / warn / block with the
// specific rule cited. Used by the Add-open-trade form and the /risk what-if panel.
//
// Convention: a check is only evaluated when its rule is configured (null = off),
// except the always-on "no stop-loss" guardrail. The overall status is the worst
// of all checks (block > warn > pass).

/**
 * "skipped" = the rule is configured but could not be evaluated (e.g. a
 * %-of-capital rule with no capital configured — invariant 6: never fabricate
 * a denominator). It is reported, never silent, and never worsens the overall
 * verdict: a check that did not run is not a pass and not a breach.
 */
export type LimitStatus = "pass" | "warn" | "block" | "skipped";

export interface ProspectiveOrder {
  bucket: string; // equity | active
  segment: string;
  symbol: string; // canonical (upper-cased)
  entry: number; // price per unit
  stop: number | null; // SL per unit (null = no stop)
  qty: number; // units (lots × lotSize already applied)
}

export interface RiskRules {
  perTradeMaxLoss: number | null; // ₹ a single trade may risk
  dailyLossStop: number | null; // ₹ aggregate loss that halts trading (positive)
  maxOpen: number | null; // max concurrent open positions
  maxTradesDay: number | null; // max new trades per day
  concentrationPct: number | null; // max % of capital in one symbol
}

export interface PortfolioState {
  capital: number; // bucket capital (₹)
  openCount: number; // current open positions in scope
  tradesToday: number; // trades already entered today in scope
  realisedLossToday: number; // ₹ already lost today (positive; 0 if net up)
  existingSymbolValue: number; // ₹ already deployed in this symbol (open)
}

export interface LimitCheck {
  rule: string; // short id (e.g. "per_trade_loss")
  label: string; // human label
  status: LimitStatus;
  message: string;
}

export interface LimitResult {
  status: LimitStatus; // worst of all checks
  checks: LimitCheck[];
  orderValue: number; // entry × qty
  orderRisk: number | null; // |entry − stop| × qty (null if no stop)
}

// ---------------------------------------------------------------------------
// THE per-trade cap (v4.4.0, D1) — ONE resolver for every reader and writer.
// ---------------------------------------------------------------------------

/**
 * The literal the v1–v4.3 seed stamped on EVERY bucket and segment row. On a
 * bucket/segment row whose `capScheme` is NULL (written before migration 0073)
 * this exact value is indistinguishable from "never set", so it reads as UNSET
 * and the row inherits the broader cap. Untouched install → ₹9,500 everywhere,
 * nothing moves; an edited GLOBAL cap reaches every segment (imports already
 * used it). The undetectable edge: a user who edited the global cap AND typed
 * exactly ₹9,500 on a segment before 0073 sees that segment inherit. The global
 * row is never legacy — it keeps its value whatever it is.
 */
export const LEGACY_SEED_CAP = 9500;

/** The four columns the resolver reads — a `risk_config` row, or its snapshot. */
export interface CapRow {
  scope: string;
  key: string;
  perTradeMaxLoss: number | null;
  capScheme?: number | null;
}

/** The cap THIS row states, after the legacy-seed rule — null = inherit. */
export function statedCap(row: CapRow | null | undefined): number | null {
  if (!row || row.perTradeMaxLoss == null) return null;
  if (row.scope !== "global" && row.capScheme == null && row.perTradeMaxLoss === LEGACY_SEED_CAP) return null;
  return row.perTradeMaxLoss;
}

/** The global row, then the bucket row, then the segment row — broadest first. */
function capLayers(rows: readonly CapRow[], bucket: string, segment: string): (CapRow | undefined)[] {
  const pick = (scope: string, key: string) => rows.find((r) => r.scope === scope && r.key === key);
  return [pick("global", ""), bucket ? pick("bucket", bucket) : undefined, segment ? pick("segment", segment) : undefined];
}

/**
 * The per-trade cap for a bucket + segment: the most specific STATED value,
 * global < bucket < segment (the precedence `resolveRules` has always used for
 * every other rule). A null at a narrower scope does not clear a broader one.
 * Null when nothing is stated — and then there is NO risk and NO R (invariant
 * 6): the importer used to fall back to a literal ₹9,500 nobody configured.
 *
 * The importer, the manual create, the breach checks (`resolveRules`), the
 * re-pricer and every page read the cap through here and nowhere else;
 * tests/readers-follow-writers.test.ts (`risk-cap-resolver`) reports a raw
 * `perTradeMaxLoss` read off a `risk_config` select anywhere in the tree.
 */
export function resolvePerTradeCap(rows: readonly CapRow[], bucket: string, segment: string): number | null {
  let cap: number | null = null;
  for (const layer of capLayers(rows, bucket, segment)) {
    const v = statedCap(layer);
    if (v != null) cap = v;
  }
  return cap;
}

/**
 * What `row` would resolve to if it stated nothing — the figure the risk
 * editor prints as "inherits ₹X from …" in a blank cell, and where it comes
 * from. `from` is null when no broader row states a cap either.
 */
export function inheritedPerTradeCap(
  rows: readonly CapRow[],
  row: CapRow,
  bucketOfSegment: (segment: string) => string,
): { cap: number | null; from: "global" | "bucket" | null } {
  if (row.scope === "global") return { cap: null, from: null };
  const bucket = row.scope === "bucket" ? "" : bucketOfSegment(row.key);
  const global = statedCap(capLayers(rows, "", "")[0]);
  const fromBucket = bucket ? statedCap(capLayers(rows, bucket, "")[1]) : null;
  if (fromBucket != null) return { cap: fromBucket, from: "bucket" };
  if (global != null) return { cap: global, from: "global" };
  return { cap: null, from: null };
}

/**
 * The Process Score's "losses within the risk taken" measures each loser
 * against its OWN recorded risk, else the configured per-trade cap. v4.4.0:
 * that cap is the one the trade's OWN bucket/segment resolves to — the pages
 * used to hand the score the global row alone, so an index_option loser was
 * judged against a cap its segment never had. A row with a risk (> 0) is
 * returned untouched; a row the resolver has no cap for stays unjudgeable, and
 * the component refuses rather than invent one (invariant 6).
 */
export function withSegmentCap<T extends { riskAmount: number | null; bucket: string; segment: string }>(
  rows: readonly CapRow[],
  trades: readonly T[],
): T[] {
  return trades.map((t) =>
    t.riskAmount != null && t.riskAmount > 0 ? t : { ...t, riskAmount: resolvePerTradeCap(rows, t.bucket, t.segment) },
  );
}

/** True when the editor should render this row's cap cell BLANK (a legacy seed literal). */
export const isLegacySeedCap = (row: CapRow): boolean => row.perTradeMaxLoss != null && statedCap(row) == null;

const WARN_RATIO = 0.8; // ≥80% of a limit → warn
const r2 = (n: number) => Math.round(n * 100) / 100;

const rank: Record<LimitStatus, number> = { skipped: 0, pass: 0, warn: 1, block: 2 };
function worst(a: LimitStatus, b: LimitStatus): LimitStatus {
  return rank[a] >= rank[b] ? a : b;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

export function evaluateLimits(
  order: ProspectiveOrder,
  rules: RiskRules,
  state: PortfolioState,
): LimitResult {
  const orderValue = r2(Math.max(0, order.entry * order.qty));
  const orderRisk =
    order.stop != null && order.qty > 0 ? r2(Math.abs(order.entry - order.stop) * order.qty) : null;

  const checks: LimitCheck[] = [];
  let overall: LimitStatus = "pass";
  const add = (rule: string, label: string, status: LimitStatus, message: string) => {
    checks.push({ rule, label, status, message });
    overall = worst(overall, status);
  };

  // 1) Per-trade max loss (+ always-on no-stop guardrail).
  if (order.stop == null) {
    add("no_stop", "Stop-loss", "warn", "No stop-loss set — downside is unbounded.");
  } else if (rules.perTradeMaxLoss != null && rules.perTradeMaxLoss > 0) {
    const cap = rules.perTradeMaxLoss;
    const risk = orderRisk ?? 0;
    if (risk > cap) {
      add("per_trade_loss", "Per-trade risk", "block", `Risk ${inr(risk)} exceeds the per-trade cap of ${inr(cap)}.`);
    } else if (risk >= cap * WARN_RATIO) {
      add("per_trade_loss", "Per-trade risk", "warn", `Risk ${inr(risk)} is near the per-trade cap of ${inr(cap)}.`);
    } else {
      add("per_trade_loss", "Per-trade risk", "pass", `Risk ${inr(risk)} within the ${inr(cap)} cap.`);
    }
  } else if (orderRisk != null) {
    add("per_trade_loss", "Per-trade risk", "pass", `Risk ${inr(orderRisk)} (no cap configured).`);
  }

  // 2) Daily aggregate loss stop.
  if (rules.dailyLossStop != null && rules.dailyLossStop > 0) {
    const stop = rules.dailyLossStop;
    const lost = Math.max(0, state.realisedLossToday);
    if (lost >= stop) {
      add("daily_loss_stop", "Daily loss stop", "block", `Daily loss stop of ${inr(stop)} already hit (lost ${inr(lost)} today) — stop trading.`);
    } else if (orderRisk != null && lost + orderRisk > stop) {
      add("daily_loss_stop", "Daily loss stop", "warn", `If stopped out, today's loss (${inr(lost)} + ${inr(orderRisk)}) would breach the ${inr(stop)} daily stop.`);
    } else if (lost >= stop * WARN_RATIO) {
      add("daily_loss_stop", "Daily loss stop", "warn", `Today's loss ${inr(lost)} is near the ${inr(stop)} daily stop.`);
    } else {
      add("daily_loss_stop", "Daily loss stop", "pass", `Today's loss ${inr(lost)} within the ${inr(stop)} stop.`);
    }
  }

  // 3) Max open positions.
  if (rules.maxOpen != null && rules.maxOpen > 0) {
    const max = rules.maxOpen;
    if (state.openCount >= max) {
      add("max_open", "Max open positions", "block", `Already at the max of ${max} open positions (${state.openCount}/${max}).`);
    } else if (state.openCount + 1 >= max || state.openCount >= max * WARN_RATIO) {
      add("max_open", "Max open positions", "warn", `This would be ${state.openCount + 1} of ${max} open positions.`);
    } else {
      add("max_open", "Max open positions", "pass", `${state.openCount + 1} of ${max} open positions.`);
    }
  }

  // 4) Max trades per day.
  if (rules.maxTradesDay != null && rules.maxTradesDay > 0) {
    const max = rules.maxTradesDay;
    if (state.tradesToday >= max) {
      add("max_trades_day", "Max trades/day", "block", `Already at the daily limit of ${max} trades (${state.tradesToday}/${max}).`);
    } else if (state.tradesToday + 1 >= max || state.tradesToday >= max * WARN_RATIO) {
      add("max_trades_day", "Max trades/day", "warn", `This would be trade ${state.tradesToday + 1} of ${max} today.`);
    } else {
      add("max_trades_day", "Max trades/day", "pass", `Trade ${state.tradesToday + 1} of ${max} today.`);
    }
  }

  // 5) Single-symbol concentration — the one capital-RELATIVE rule. With no
  // capital configured it is reported as NOT EVALUATED: zeroing the % would
  // pass every order (fake safety), and any invented base could block one
  // (fake danger). This used to be silently dropped, which read as a pass.
  if (rules.concentrationPct != null && rules.concentrationPct > 0 && state.capital <= 0) {
    add(
      "concentration",
      "Concentration",
      "skipped",
      `Not evaluated — the ${rules.concentrationPct}% cap is a share of capital, and no capital is configured. Set it in Settings → Capital.`,
    );
  } else if (rules.concentrationPct != null && rules.concentrationPct > 0 && state.capital > 0) {
    const limit = rules.concentrationPct;
    const newValue = state.existingSymbolValue + orderValue;
    const pct = r2((newValue / state.capital) * 100);
    if (pct > limit) {
      add("concentration", "Concentration", "block", `${order.symbol} would be ${pct}% of capital — over the ${limit}% cap.`);
    } else if (pct >= limit * WARN_RATIO) {
      add("concentration", "Concentration", "warn", `${order.symbol} would be ${pct}% of capital, near the ${limit}% cap.`);
    } else {
      add("concentration", "Concentration", "pass", `${order.symbol} would be ${pct}% of capital (cap ${limit}%).`);
    }
  }

  return { status: overall, checks, orderValue, orderRisk };
}
