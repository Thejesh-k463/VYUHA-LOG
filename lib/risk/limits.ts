// P1.4 — pre-trade risk limits engine (PURE, no DB/React). Turns the advisory
// risk_config into enforced guardrails: given a prospective order + the current
// portfolio state + the resolved rule set, return pass / warn / block with the
// specific rule cited. Used by the Add-open-trade form and the /risk what-if panel.
//
// Convention: a check is only evaluated when its rule is configured (null = off),
// except the always-on "no stop-loss" guardrail. The overall status is the worst
// of all checks (block > warn > pass).

export type LimitStatus = "pass" | "warn" | "block";

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

const WARN_RATIO = 0.8; // ≥80% of a limit → warn
const r2 = (n: number) => Math.round(n * 100) / 100;

const rank: Record<LimitStatus, number> = { pass: 0, warn: 1, block: 2 };
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

  // 5) Single-symbol concentration.
  if (rules.concentrationPct != null && rules.concentrationPct > 0 && state.capital > 0) {
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
