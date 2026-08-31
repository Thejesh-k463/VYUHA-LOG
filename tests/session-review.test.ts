import { describe, expect, it } from "vitest";
import { reviewSession, type SessionPlanInput, type SessionTradeInput } from "@/lib/analytics/session-review";

/**
 * B1 — the session review is deliberately DETERMINISTIC: the same plan and the
 * same trades must always produce the same verdict. That is the whole reason it
 * is arithmetic rather than a language model, so the tests pin the arithmetic.
 */

const plan = (over: Partial<SessionPlanInput> = {}): SessionPlanInput => ({
  sessionDate: "2026-08-01",
  plannedSymbols: [],
  plannedPlaybookIds: [],
  maxTrades: null,
  maxLoss: null,
  cutoffTime: null,
  ...over,
});

const trade = (over: Partial<SessionTradeInput> = {}): SessionTradeInput => ({
  id: 1,
  symbol: "NIFTY",
  playbookId: null,
  entryDate: "2026-08-01",
  entryTime: "10:00",
  netPnl: 0,
  ...over,
});

describe("session review — scoping", () => {
  it("only counts trades entered on the session's own date", () => {
    const r = reviewSession(plan(), [
      trade({ id: 1, netPnl: 100 }),
      trade({ id: 2, entryDate: "2026-07-31", netPnl: -9999 }),
      trade({ id: 3, entryDate: null, netPnl: -9999 }),
    ]);
    expect(r.tradeCount).toBe(1);
    expect(r.netPnl).toBe(100);
  });

  it("reports an empty session honestly rather than as perfect adherence", () => {
    const r = reviewSession(plan({ plannedSymbols: ["NIFTY"] }), []);
    expect(r.tradeCount).toBe(0);
    expect(r.findings).toEqual(["No entries were recorded for this session."]);
  });
});

describe("session review — watchlist", () => {
  it("flags symbols that were not on the plan", () => {
    const r = reviewSession(plan({ plannedSymbols: ["NIFTY"] }), [
      trade({ id: 1, symbol: "NIFTY" }),
      trade({ id: 2, symbol: "BANKNIFTY" }),
    ]);
    expect(r.offPlanSymbols).toEqual(["BANKNIFTY"]);
  });

  it("matches the watchlist case-insensitively and ignores blank entries", () => {
    // A watchlist typed as "nifty " must not convict a NIFTY trade.
    const r = reviewSession(plan({ plannedSymbols: ["  nifty ", "", "   "] }), [trade({ symbol: "NIFTY" })]);
    expect(r.offPlanSymbols).toEqual([]);
  });

  it("does not police the watchlist when none was planned", () => {
    // An empty watchlist is "no plan", not "nothing is allowed".
    const r = reviewSession(plan(), [trade({ symbol: "ANYTHING" })]);
    expect(r.offPlanSymbols).toEqual([]);
    expect(r.adherencePct).toBe(100);
  });

  it("does not convict an alias of its own planned ticker (the v3.4 latent bug)", () => {
    // The trade is stored under the broker's full name; the plan holds the
    // canonical ticker. Without the alias map this scored as "traded
    // off-watchlist" — with it, both sides resolve to the same symbol.
    const aliasMap = new Map([["BAJAJ AUTO LIMITED", "BAJAJ-AUTO"]]);
    const trades = [trade({ symbol: "BAJAJ AUTO LIMITED" })];
    const withMap = reviewSession(plan({ plannedSymbols: ["BAJAJ-AUTO"] }), trades, aliasMap);
    expect(withMap.offPlanSymbols).toEqual([]);
    expect(withMap.adherencePct).toBe(100);
    // And the map resolves the PLANNED side too: a plan typed as the broker
    // name must match a trade recorded under the ticker.
    const planned = reviewSession(plan({ plannedSymbols: ["BAJAJ AUTO LIMITED"] }), [trade({ symbol: "BAJAJ-AUTO" })], aliasMap);
    expect(planned.offPlanSymbols).toEqual([]);
    // Without the map the old behaviour (and the bug) is unchanged.
    const withoutMap = reviewSession(plan({ plannedSymbols: ["BAJAJ-AUTO"] }), trades);
    expect(withoutMap.offPlanSymbols).toEqual(["BAJAJ AUTO LIMITED"]);
  });

  it("still reports the off-plan symbol AS RECORDED, not its resolved form", () => {
    const aliasMap = new Map([["HDFC BANK LIMITED", "HDFCBANK"]]);
    const r = reviewSession(plan({ plannedSymbols: ["NIFTY"] }), [trade({ symbol: "HDFC BANK LIMITED" })], aliasMap);
    expect(r.offPlanSymbols).toEqual(["HDFC BANK LIMITED"]);
  });

  it("lists each off-plan symbol once even when traded repeatedly", () => {
    const r = reviewSession(plan({ plannedSymbols: ["NIFTY"] }), [
      trade({ id: 1, symbol: "BANKNIFTY" }),
      trade({ id: 2, symbol: "BANKNIFTY" }),
    ]);
    expect(r.offPlanSymbols).toEqual(["BANKNIFTY"]);
  });
});

describe("session review — playbooks", () => {
  it("counts trades on an unplanned playbook, and untagged ones too", () => {
    const r = reviewSession(plan({ plannedPlaybookIds: [1] }), [
      trade({ id: 1, playbookId: 1 }),
      trade({ id: 2, playbookId: 2 }),
      trade({ id: 3, playbookId: null }),
    ]);
    expect(r.offPlanPlaybooks).toBe(2);
  });

  it("does not police playbooks when none were planned", () => {
    const r = reviewSession(plan(), [trade({ playbookId: null })]);
    expect(r.offPlanPlaybooks).toBe(0);
  });
});

describe("session review — cutoff", () => {
  it("counts entries placed after the planned cutoff", () => {
    const r = reviewSession(plan({ cutoffTime: "14:30" }), [
      trade({ id: 1, entryTime: "14:29" }),
      trade({ id: 2, entryTime: "14:31" }),
    ]);
    expect(r.afterCutoff).toBe(1);
  });

  it("treats the cutoff minute itself as inside the plan", () => {
    const r = reviewSession(plan({ cutoffTime: "14:30" }), [trade({ entryTime: "14:30" })]);
    expect(r.afterCutoff).toBe(0);
  });

  it("cannot convict a trade whose entry time is unknown", () => {
    // Same honesty rule as Arjun's Eye: no invented session for a missing time.
    const r = reviewSession(plan({ cutoffTime: "14:30" }), [trade({ entryTime: null })]);
    expect(r.afterCutoff).toBe(0);
  });
});

describe("session review — budgets", () => {
  it("breaches max trades only when the plan is exceeded, not met", () => {
    expect(reviewSession(plan({ maxTrades: 2 }), [trade({ id: 1 }), trade({ id: 2 })]).maxTradesBreached).toBe(false);
    expect(reviewSession(plan({ maxTrades: 2 }), [trade({ id: 1 }), trade({ id: 2 }), trade({ id: 3 })]).maxTradesBreached).toBe(true);
  });

  it("breaches the loss budget on net, and reads the budget as a magnitude", () => {
    // A user may type the budget as 500 or -500; both mean the same thing.
    expect(reviewSession(plan({ maxLoss: 500 }), [trade({ netPnl: -600 })]).maxLossBreached).toBe(true);
    expect(reviewSession(plan({ maxLoss: -500 }), [trade({ netPnl: -600 })]).maxLossBreached).toBe(true);
    expect(reviewSession(plan({ maxLoss: 500 }), [trade({ netPnl: -400 })]).maxLossBreached).toBe(false);
  });

  it("a profitable session never breaches a loss budget", () => {
    const r = reviewSession(plan({ maxLoss: 500 }), [trade({ netPnl: 5000 })]);
    expect(r.maxLossBreached).toBe(false);
  });

  it("nets the session to two decimals", () => {
    const r = reviewSession(plan(), [trade({ id: 1, netPnl: 100.005 }), trade({ id: 2, netPnl: 0.004 })]);
    expect(r.netPnl).toBe(100.01);
  });
});

describe("session review — adherence score", () => {
  it("is 100 when every measurable part of the plan held", () => {
    const r = reviewSession(
      plan({ plannedSymbols: ["NIFTY"], plannedPlaybookIds: [1], maxTrades: 3, maxLoss: 5000, cutoffTime: "15:00" }),
      [trade({ symbol: "NIFTY", playbookId: 1, entryTime: "10:00", netPnl: 200 })],
    );
    expect(r.adherencePct).toBe(100);
    expect(r.findings).toEqual(["The recorded session stayed inside every measurable part of the plan."]);
  });

  it("drops one fifth per breached check", () => {
    // Five checks: symbols, playbooks, cutoff, trade count, loss budget.
    const r = reviewSession(plan({ plannedSymbols: ["NIFTY"] }), [trade({ symbol: "BANKNIFTY" })]);
    expect(r.adherencePct).toBe(80);
  });

  it("reaches 0 only when all five checks break", () => {
    const r = reviewSession(
      plan({ plannedSymbols: ["NIFTY"], plannedPlaybookIds: [1], maxTrades: 1, maxLoss: 100, cutoffTime: "10:00" }),
      [
        trade({ id: 1, symbol: "BANKNIFTY", playbookId: null, entryTime: "11:00", netPnl: -500 }),
        trade({ id: 2, symbol: "BANKNIFTY", playbookId: null, entryTime: "12:00", netPnl: -500 }),
      ],
    );
    expect(r.adherencePct).toBe(0);
    expect(r.findings).toHaveLength(5);
  });

  it("states findings as observations, never instructions", () => {
    const r = reviewSession(
      plan({ plannedSymbols: ["NIFTY"], maxTrades: 0, maxLoss: 1, cutoffTime: "09:00" }),
      [trade({ symbol: "XYZ", entryTime: "10:00", netPnl: -900 })],
    );
    // The house rule: reports describe what happened, they do not instruct.
    for (const f of r.findings) expect(f.toLowerCase()).not.toMatch(/you should|you must|stop doing/);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("is deterministic — the same inputs always give the same review", () => {
    const p = plan({ plannedSymbols: ["NIFTY"], maxTrades: 1, cutoffTime: "14:30" });
    const t = [trade({ id: 1, symbol: "BANKNIFTY", entryTime: "15:00", netPnl: -100 }), trade({ id: 2, netPnl: -50 })];
    expect(reviewSession(p, t)).toEqual(reviewSession(p, t));
  });

  it("keeps the original v2.97 scenario green", () => {
    const r = reviewSession(
      plan({ plannedSymbols: ["NIFTY"], plannedPlaybookIds: [1], maxTrades: 1, maxLoss: 500, cutoffTime: "14:30" }),
      [
        trade({ id: 1, symbol: "NIFTY", playbookId: 1, entryTime: "10:00", netPnl: -300 }),
        trade({ id: 2, symbol: "BANKNIFTY", playbookId: null, entryTime: "15:00", netPnl: -400 }),
      ],
    );
    expect(r.offPlanSymbols).toEqual(["BANKNIFTY"]);
    expect(r.afterCutoff).toBe(1);
    expect(r.maxTradesBreached).toBe(true);
    expect(r.maxLossBreached).toBe(true);
  });
});
