import { describe, it, expect } from "vitest";
import {
  evaluateLimits,
  type ProspectiveOrder,
  type RiskRules,
  type PortfolioState,
} from "@/lib/risk/limits";

const order = (over: Partial<ProspectiveOrder> = {}): ProspectiveOrder => ({
  bucket: "active",
  segment: "eq_intraday",
  symbol: "RELIANCE",
  entry: 100,
  stop: 95,
  qty: 100, // value 10,000 ; risk 500
  ...over,
});

const rules = (over: Partial<RiskRules> = {}): RiskRules => ({
  perTradeMaxLoss: 9500,
  dailyLossStop: 25000,
  maxOpen: 5,
  maxTradesDay: 10,
  concentrationPct: 20,
  ...over,
});

const state = (over: Partial<PortfolioState> = {}): PortfolioState => ({
  capital: 400000,
  openCount: 0,
  tradesToday: 0,
  realisedLossToday: 0,
  existingSymbolValue: 0,
  ...over,
});

describe("evaluateLimits — happy path", () => {
  it("passes a well-sized trade with a stop", () => {
    const r = evaluateLimits(order(), rules(), state());
    expect(r.status).toBe("pass");
    expect(r.orderValue).toBe(10000);
    expect(r.orderRisk).toBe(500);
  });
});

describe("per-trade risk", () => {
  it("blocks when risk exceeds the per-trade cap", () => {
    // entry 100, stop 50 → risk/unit 50 × 1000 = 50,000 > 9,500
    const r = evaluateLimits(order({ stop: 50, qty: 1000 }), rules(), state());
    expect(r.status).toBe("block");
    expect(r.checks.find((c) => c.rule === "per_trade_loss")?.status).toBe("block");
  });

  it("warns at ≥80% of the per-trade cap", () => {
    // risk = 9,000 (cap 9,500 → 94.7%)
    const r = evaluateLimits(order({ stop: 91, qty: 1000 }), rules(), state());
    expect(r.checks.find((c) => c.rule === "per_trade_loss")?.status).toBe("warn");
  });

  it("warns when no stop-loss is set", () => {
    const r = evaluateLimits(order({ stop: null }), rules(), state());
    expect(r.status).toBe("warn");
    expect(r.orderRisk).toBeNull();
    expect(r.checks.find((c) => c.rule === "no_stop")?.status).toBe("warn");
  });
});

describe("daily loss stop", () => {
  it("blocks new trades once the daily stop is already hit", () => {
    const r = evaluateLimits(order(), rules(), state({ realisedLossToday: 25000 }));
    expect(r.status).toBe("block");
    expect(r.checks.find((c) => c.rule === "daily_loss_stop")?.status).toBe("block");
  });

  it("warns when this trade's risk could breach the daily stop", () => {
    // lost 24,800 today; +500 risk would exceed 25,000
    const r = evaluateLimits(order(), rules(), state({ realisedLossToday: 24800 }));
    expect(r.checks.find((c) => c.rule === "daily_loss_stop")?.status).toBe("warn");
  });
});

describe("count limits", () => {
  it("blocks at max open positions", () => {
    const r = evaluateLimits(order(), rules(), state({ openCount: 5 }));
    expect(r.checks.find((c) => c.rule === "max_open")?.status).toBe("block");
  });

  it("blocks at the daily trade count", () => {
    const r = evaluateLimits(order(), rules(), state({ tradesToday: 10 }));
    expect(r.checks.find((c) => c.rule === "max_trades_day")?.status).toBe("block");
  });
});

describe("concentration", () => {
  it("blocks when a symbol would exceed the concentration cap", () => {
    // existing 75k + new 10k = 85k on 400k = 21.25% > 20%
    const r = evaluateLimits(order(), rules(), state({ existingSymbolValue: 75000 }));
    expect(r.checks.find((c) => c.rule === "concentration")?.status).toBe("block");
  });

  it("passes a small allocation", () => {
    const r = evaluateLimits(order(), rules(), state());
    expect(r.checks.find((c) => c.rule === "concentration")?.status).toBe("pass");
  });
});

describe("rule toggles", () => {
  it("skips checks whose rule is null (only the no-cap risk note remains)", () => {
    const r = evaluateLimits(
      order(),
      { perTradeMaxLoss: null, dailyLossStop: null, maxOpen: null, maxTradesDay: null, concentrationPct: null },
      state(),
    );
    expect(r.status).toBe("pass");
    // stop is set + no cap → a single informational per_trade_loss pass check
    expect(r.checks.map((c) => c.rule)).toEqual(["per_trade_loss"]);
  });

  it("overall status is the worst of all checks", () => {
    // concentration blocks even though everything else passes
    const r = evaluateLimits(order(), rules(), state({ existingSymbolValue: 75000 }));
    expect(r.status).toBe("block");
  });
});
