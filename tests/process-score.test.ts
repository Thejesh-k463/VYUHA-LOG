import { describe, it, expect } from "vitest";
import {
  PROCESS_SCORE_FLOOR,
  processScore,
  processScoreByWeek,
  type ProcessComponentId,
  type ProcessScoreConfig,
  type ProcessTrade,
} from "@/lib/analytics/process-score";
import { PLAYBOOK_RULE_PREFIX } from "@/lib/analytics/behavior";
import { PRESCRIPTIVE_LANGUAGE } from "@/lib/intelligence/insight";

const trade = (over: Partial<ProcessTrade> = {}): ProcessTrade => ({
  sellDate: "2026-06-01",
  netPnl: 1000,
  riskAmount: null,
  slPlanned: null,
  targetPlanned: null,
  isOpen: false,
  playbookId: null,
  ruleViolations: null,
  reviewedAt: null,
  ...over,
});

const CFG: ProcessScoreConfig = { perTradeCap: 9500, dailyStop: 25000, floor: 0 };
const comp = (trades: ProcessTrade[], id: ProcessComponentId, cfg: ProcessScoreConfig = CFG) =>
  processScore(trades, cfg).components.find((c) => c.id === id)!;

describe("processScore — planned", () => {
  const trades = [
    trade({ slPlanned: 100 }),
    trade({ targetPlanned: 250 }),
    trade({ slPlanned: 100, targetPlanned: 250 }),
    trade(),
    trade({ isOpen: true, sellDate: null, slPlanned: 100 }),
  ];

  it("counts SL OR target, over closed trades in the window", () => {
    const c = comp(trades, "planned");
    expect([c.numerator, c.denominator, c.pct]).toEqual([3, 4, 75]);
    expect(c.coverage).toEqual({ have: 4, of: 4, noun: "closed trades in the window" });
  });
});

describe("processScore — risk-cap (the component that refuses to invent a limit)", () => {
  it("is null when there are no losers to judge", () => {
    const c = comp([trade({ netPnl: 500 }), trade({ netPnl: 900 })], "risk-cap");
    expect(c.pct).toBeNull();
    expect(c.denominator).toBe(0);
    expect(c.coverage).toEqual({ have: 0, of: 0, noun: "losing trades had a risk limit to measure against" });
  });

  it("judges a loser against its OWN riskAmount first", () => {
    const c = comp(
      [trade({ netPnl: -4000, riskAmount: 5000 }), trade({ netPnl: -8000, riskAmount: 5000 })],
      "risk-cap",
    );
    expect([c.numerator, c.denominator, c.pct]).toEqual([1, 2, 50]);
  });

  it("falls back to the CONFIGURED per-trade cap when the trade carries no risk", () => {
    const trades = [trade({ netPnl: -9000 }), trade({ netPnl: -12000 })];
    expect(comp(trades, "risk-cap").pct).toBe(50); // cap 9500: one within, one over
  });

  // v3.6 read `cap = perTradeCap || 9500` — a limit no user had set, silently
  // deciding whether their losses were "respected". Invariant 6.
  it("is NULL, never 9500, when a loser has neither its own risk nor a configured cap", () => {
    const trades = [trade({ netPnl: -20000 }), trade({ netPnl: -1000 })];
    const c = comp(trades, "risk-cap", { perTradeCap: null, dailyStop: 25000, floor: 0 });
    expect(c.pct).toBeNull();
    expect(c.coverage).toEqual({ have: 0, of: 2, noun: "losing trades had a risk limit to measure against" });
    // …and a cap of 0 is "not set", not "zero rupees allowed".
    expect(comp(trades, "risk-cap", { perTradeCap: 0, dailyStop: 25000, floor: 0 }).pct).toBeNull();
  });

  it("refuses the whole component when even ONE loser is unjudgeable", () => {
    const trades = [trade({ netPnl: -4000, riskAmount: 5000 }), trade({ netPnl: -30000 })];
    const c = comp(trades, "risk-cap", { perTradeCap: null, dailyStop: 25000, floor: 0 });
    expect(c.pct).toBeNull();
    expect(c.coverage.have).toBe(1);
    expect(c.coverage.of).toBe(2);
  });
});

describe("processScore — daily-stop", () => {
  const trades = [
    trade({ sellDate: "2026-06-01", netPnl: -10000 }),
    trade({ sellDate: "2026-06-01", netPnl: -20000 }),
    trade({ sellDate: "2026-06-02", netPnl: 5000 }),
  ];

  it("measures DAY net against the stop, over trading days", () => {
    const c = comp(trades, "daily-stop");
    expect([c.numerator, c.denominator, c.pct]).toEqual([1, 2, 50]); // −30,000 breaches ₹25k
  });

  it("is null when no daily stop is configured", () => {
    const c = comp(trades, "daily-stop", { perTradeCap: 9500, dailyStop: null, floor: 0 });
    expect(c.pct).toBeNull();
    expect(c.coverage).toEqual({ have: 0, of: 2, noun: "trading days had a daily stop to measure against" });
  });
});

describe("processScore — rules-followed", () => {
  const trades = [
    trade({ playbookId: 1 }),
    trade({ playbookId: 1, ruleViolations: [`${PLAYBOOK_RULE_PREFIX}Wait for the retest`] }),
    trade({ playbookId: 2, ruleViolations: ["Per-trade risk: ₹12,000 over the limit"] }),
    trade({ playbookId: 2 }),
    trade(),
    trade({ ruleViolations: [`${PLAYBOOK_RULE_PREFIX}Wait for the retest`] }),
  ];

  it("denominates on trades that HAVE a playbook, and says how many that was", () => {
    const c = comp(trades, "rules-followed");
    expect([c.numerator, c.denominator, c.pct]).toEqual([3, 4, 75]);
    expect(c.coverage).toEqual({ have: 4, of: 6, noun: "trades had a playbook" });
  });

  it("reads only the 'Playbook: ' population — an entry-time limit breach is not a broken rule", () => {
    const c = comp([trade({ playbookId: 2, ruleViolations: ["Per-trade risk: ₹12,000 over the limit"] })], "rules-followed");
    expect(c.pct).toBe(100);
  });
});

describe("processScore — reviewed", () => {
  it("a blank reviewedAt is UNREVIEWED, never a silent pass", () => {
    const trades = [
      trade({ reviewedAt: "2026-06-08T05:00:00Z" }),
      trade({ reviewedAt: "2026-06-08T05:00:00Z" }),
      trade({ reviewedAt: null }),
      trade({ reviewedAt: "" }),
    ];
    const c = comp(trades, "reviewed");
    expect([c.numerator, c.denominator, c.pct]).toEqual([2, 4, 50]);
  });
});

// One fixture, hand-checked: planned 50, risk-cap 50, daily-stop 100,
// rules-followed 75, reviewed 30.
const TEN: ProcessTrade[] = [
  trade({ sellDate: "2026-06-01", netPnl: -4000, riskAmount: 5000, slPlanned: 100, playbookId: 1, reviewedAt: "2026-06-08" }),
  trade({ sellDate: "2026-06-01", netPnl: -6000, riskAmount: 5000, playbookId: 1, ruleViolations: [`${PLAYBOOK_RULE_PREFIX}Wait for the retest`] }),
  trade({ sellDate: "2026-06-01", netPnl: 3000, slPlanned: 100, playbookId: 1, ruleViolations: ["Per-trade risk: over"], reviewedAt: "2026-06-08" }),
  trade({ sellDate: "2026-06-01", netPnl: 2000, playbookId: 1 }),
  trade({ sellDate: "2026-06-01", netPnl: 1000, slPlanned: 100, reviewedAt: "2026-06-08" }),
  trade({ sellDate: "2026-06-02", netPnl: 500 }),
  trade({ sellDate: "2026-06-02", netPnl: 500, slPlanned: 100 }),
  trade({ sellDate: "2026-06-02", netPnl: 500 }),
  trade({ sellDate: "2026-06-02", netPnl: 500, slPlanned: 100 }),
  trade({ sellDate: "2026-06-02", netPnl: 500 }),
];

describe("processScore — the score is the mean of what could be measured", () => {
  it("averages the five components and rounds to an integer", () => {
    const s = processScore(TEN, { perTradeCap: 9500, dailyStop: 25000 });
    expect(s.components.map((c) => [c.id, c.pct])).toEqual([
      ["planned", 50], ["risk-cap", 50], ["daily-stop", 100], ["rules-followed", 75], ["reviewed", 30],
    ]);
    expect(s.score).toBe(61); // (50+50+100+75+30)/5
    expect(s.refusal).toBeNull();
    expect(s.closedTrades).toBe(10);
  });

  it("a refusing component drops OUT of the mean rather than scoring zero", () => {
    const s = processScore(TEN, { perTradeCap: 9500, dailyStop: null });
    expect(s.components.find((c) => c.id === "daily-stop")!.pct).toBeNull();
    expect(s.score).toBe(51); // (50+50+75+30)/4 = 51.25
  });

  it("is null when no component had anything to measure at all", () => {
    const s = processScore([], { perTradeCap: 9500, dailyStop: 25000, floor: 0 });
    expect(s.score).toBeNull();
    expect(s.refusal?.reason).toContain("None of the five components");
    expect(s.components).toHaveLength(5);
  });
});

describe("processScore — the sample floor", () => {
  it("defaults to 10 closed trades and says what was short", () => {
    expect(PROCESS_SCORE_FLOOR).toBe(10);
    const s = processScore(TEN.slice(0, 4), { perTradeCap: 9500, dailyStop: 25000 });
    expect(s.score).toBeNull();
    expect(s.refusal).toEqual({ reason: "4 closed trades in this window; the score needs 10" });
    expect(s.closedTrades).toBe(4);
    expect(s.floor).toBe(10);
  });

  it("still returns all five components under the floor — the arithmetic stays visible", () => {
    const s = processScore(TEN.slice(0, 4), { perTradeCap: 9500, dailyStop: 25000 });
    expect(s.components.map((c) => c.id)).toEqual(["planned", "risk-cap", "daily-stop", "rules-followed", "reviewed"]);
    expect(s.components.find((c) => c.id === "planned")!.numerator).toBe(2);
  });

  it("one trade short is still short, and reads as one trade", () => {
    const nine = [...TEN.slice(0, 9)];
    expect(processScore(nine, { perTradeCap: 9500, dailyStop: 25000 }).score).toBeNull();
    const one = processScore([TEN[0]], { perTradeCap: 9500, dailyStop: 25000 });
    expect(one.refusal?.reason).toBe("1 closed trade in this window; the score needs 10");
  });

  it("the floor is caller-configurable", () => {
    const s = processScore(TEN.slice(0, 4), { perTradeCap: 9500, dailyStop: 25000, floor: 4 });
    expect(s.score).not.toBeNull();
    expect(s.floor).toBe(4);
  });
});

describe("processScoreByWeek", () => {
  // RECORDED NEWEST-FIRST, ON PURPOSE — W24 goes in before W23. The production
  // caller (app/review/page.tsx) feeds `getTrades()`, which is ordered
  // newest-first, so the Map below is populated newest week first and the
  // trailing `.sort((a, b) => a.weekStart.localeCompare(b.weekStart))` is the
  // ONLY thing putting the Review Desk's history strip into reading order. Fed
  // a chronological fixture that sort is a no-op, and deleting it would leave
  // this file green while the strip rendered backwards.
  const spread: ProcessTrade[] = [
    trade({ sellDate: "2026-06-10", netPnl: -700 }),
    trade({ sellDate: "2026-06-09", netPnl: 100, isOpen: true }),
    trade({ sellDate: "2026-06-08", netPnl: 700 }),
    ...TEN, // 2026-W23
  ];

  it("the fixture really is fed backwards — otherwise the next case proves nothing", () => {
    const fed = spread.filter((t) => !t.isOpen).map((t) => t.sellDate!);
    expect(fed[0] > fed[fed.length - 1]).toBe(true);
  });

  it("buckets by ISO week, oldest first, with the week's own Monday", () => {
    const weeks = processScoreByWeek(spread, { perTradeCap: 9500, dailyStop: 25000 });
    // A LITERAL sequence. The assertion IS the order, so it must never be
    // compared against a sorted copy of what came back.
    expect(weeks.map((w) => [w.week, w.weekStart, w.trades])).toEqual([
      ["2026-W23", "2026-06-01", 10],
      ["2026-W24", "2026-06-08", 2],
    ]);
  });

  it("scores the week that clears the floor and refuses the one that does not", () => {
    const weeks = processScoreByWeek(spread, { perTradeCap: 9500, dailyStop: 25000 });
    expect(weeks[0].score).toBe(61);
    expect(weeks[0].refusal).toBeNull();
    expect(weeks[1].score).toBeNull();
    // The exact sentence the Review Desk shows.
    expect(weeks[1].refusal).toEqual({ reason: "2 closed trades this week; the score needs 10" });
  });
});

describe("processScore — copy stays descriptive", () => {
  it("no label, coverage noun or refusal reason is prescriptive", () => {
    const cases = [
      processScore(TEN, { perTradeCap: 9500, dailyStop: 25000 }),
      processScore(TEN.slice(0, 3), { perTradeCap: null, dailyStop: null }),
      processScore([], { perTradeCap: null, dailyStop: null, floor: 0 }),
    ];
    const strings = cases.flatMap((s) => [
      ...s.components.flatMap((c) => [c.label, c.coverage.noun]),
      s.refusal?.reason ?? "",
    ]);
    expect(strings.length).toBeGreaterThan(10);
    for (const s of strings) expect(PRESCRIPTIVE_LANGUAGE.test(s)).toBe(false);
  });
});
