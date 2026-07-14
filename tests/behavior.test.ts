import { describe, it, expect } from "vitest";
import {
  playbookStats,
  mistakeReport,
  emotionReport,
  playbookRuleCost,
  PLAYBOOK_RULE_PREFIX,
  type BehaviorTrade,
} from "@/lib/analytics/behavior";

function trade(p: Partial<BehaviorTrade>): BehaviorTrade {
  return { id: 1, isOpen: false, netPnl: 0, rMultiple: null, playbookId: null, emotionTag: null, mistakeTags: null, ...p };
}

const PLAYBOOKS = [
  { id: 1, name: "Breakout" },
  { id: 2, name: "Pullback" },
];

describe("playbookStats", () => {
  it("groups closed trades per playbook with win rate, net, expectancy, avgR", () => {
    const trades = [
      trade({ id: 1, playbookId: 1, netPnl: 1000, rMultiple: 2 }),
      trade({ id: 2, playbookId: 1, netPnl: -500, rMultiple: -1 }),
      trade({ id: 3, playbookId: 2, netPnl: 300 }),
      trade({ id: 4, netPnl: -200 }), // untagged
    ];
    const stats = playbookStats(trades, PLAYBOOKS);
    const breakout = stats.find((s) => s.name === "Breakout")!;
    expect(breakout.trades).toBe(2);
    expect(breakout.winRatePct).toBe(50);
    expect(breakout.net).toBe(500);
    expect(breakout.expectancy).toBe(250);
    expect(breakout.avgR).toBe(0.5);
    const untagged = stats.find((s) => s.playbookId === null)!;
    expect(untagged.name).toBe("Untagged");
    expect(untagged.trades).toBe(1);
  });

  it("ignores open trades and treats unknown playbook ids as untagged", () => {
    const trades = [
      trade({ id: 1, playbookId: 1, netPnl: 999, isOpen: true }), // open — excluded
      trade({ id: 2, playbookId: 99, netPnl: 100 }), // deleted playbook → untagged
    ];
    const stats = playbookStats(trades, PLAYBOOKS);
    expect(stats).toHaveLength(1);
    expect(stats[0].playbookId).toBeNull();
    expect(stats[0].net).toBe(100);
  });

  it("sorts by net descending", () => {
    const trades = [
      trade({ id: 1, playbookId: 1, netPnl: -100 }),
      trade({ id: 2, playbookId: 2, netPnl: 900 }),
    ];
    const stats = playbookStats(trades, PLAYBOOKS);
    expect(stats[0].name).toBe("Pullback");
  });

  it("profit factor = gross wins / |gross losses|; null with no losses; smallSample under 20", () => {
    const trades = [
      trade({ id: 1, playbookId: 1, netPnl: 1000 }),
      trade({ id: 2, playbookId: 1, netPnl: 500 }),
      trade({ id: 3, playbookId: 1, netPnl: -600 }),
      trade({ id: 4, playbookId: 2, netPnl: 300 }), // wins only → PF undefined
    ];
    const stats = playbookStats(trades, PLAYBOOKS);
    const breakout = stats.find((s) => s.name === "Breakout")!;
    expect(breakout.profitFactor).toBe(2.5); // 1500 / 600
    expect(breakout.smallSample).toBe(true);
    const pullback = stats.find((s) => s.name === "Pullback")!;
    expect(pullback.profitFactor).toBeNull();
  });
});

describe("playbookRuleCost", () => {
  const v = (rule: string) => `${PLAYBOOK_RULE_PREFIX}${rule}`;

  it("groups by full rule text, closed net only, worst first", () => {
    const rows = playbookRuleCost([
      { ruleViolations: [v("Wait for the retest")], netPnl: -2000, isOpen: false },
      { ruleViolations: [v("Wait for the retest"), v("Risk ≤ 1%")], netPnl: -1000, isOpen: false },
      { ruleViolations: [v("Risk ≤ 1%")], netPnl: 500, isOpen: false },
      { ruleViolations: [v("Wait for the retest")], netPnl: -999, isOpen: true }, // open → counted, not in closedNet
    ]);
    expect(rows[0].rule).toBe("Wait for the retest");
    expect(rows[0].trades).toBe(3);
    expect(rows[0].closedTrades).toBe(2);
    expect(rows[0].closedNet).toBe(-3000);
    expect(rows[0].avgNet).toBe(-1500);
    const risk = rows.find((r) => r.rule === "Risk ≤ 1%")!;
    expect(risk.closedNet).toBe(-500);
  });

  it("ignores non-playbook violations (pre-trade limit breaches keep their own report)", () => {
    const rows = playbookRuleCost([
      { ruleViolations: ["Per-trade risk: over cap"], netPnl: -5000, isOpen: false },
      { ruleViolations: null, netPnl: 100, isOpen: false },
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("mistakeReport", () => {
  it("splits clean vs mistake-tagged trades and computes the expectancy gap", () => {
    const trades = [
      trade({ id: 1, netPnl: 1000 }), // clean
      trade({ id: 2, netPnl: 500 }), // clean
      trade({ id: 3, netPnl: -800, mistakeTags: ["revenge_trade"] }),
      trade({ id: 4, netPnl: -200, mistakeTags: ["no_stop", "oversized"] }),
    ];
    const r = mistakeReport(trades);
    expect(r.cleanTrades).toBe(2);
    expect(r.mistakeTrades).toBe(2);
    expect(r.cleanNet).toBe(1500);
    expect(r.mistakeNet).toBe(-1000);
    expect(r.cleanExpectancy).toBe(750);
    expect(r.mistakeExpectancy).toBe(-500);
    expect(r.expectancyGap).toBe(1250);
  });

  it("a multi-tag trade counts once in the headline but under each tag in perTag", () => {
    const trades = [trade({ id: 1, netPnl: -300, mistakeTags: ["no_stop", "oversized"] })];
    const r = mistakeReport(trades);
    expect(r.mistakeTrades).toBe(1);
    expect(r.mistakeNet).toBe(-300);
    expect(r.perTag).toHaveLength(2);
    expect(r.perTag.every((t) => t.net === -300 && t.trades === 1)).toBe(true);
  });

  it("perTag is sorted worst-first and duplicate tags on one trade count once", () => {
    const trades = [
      trade({ id: 1, netPnl: -900, mistakeTags: ["revenge_trade", "revenge_trade"] }),
      trade({ id: 2, netPnl: -100, mistakeTags: ["early_exit"] }),
      trade({ id: 3, netPnl: 50, mistakeTags: ["early_exit"] }),
    ];
    const r = mistakeReport(trades);
    expect(r.perTag[0].tag).toBe("revenge_trade");
    expect(r.perTag[0].trades).toBe(1); // deduped within the trade
    const early = r.perTag.find((t) => t.tag === "early_exit")!;
    expect(early.trades).toBe(2);
    expect(early.net).toBe(-50);
  });

  it("labels unknown tags with the raw tag string", () => {
    const r = mistakeReport([trade({ id: 1, netPnl: -10, mistakeTags: ["custom_thing"] })]);
    expect(r.perTag[0].label).toBe("custom_thing");
  });
});

describe("emotionReport", () => {
  it("groups by emotion with net and win rate, most-traded first", () => {
    const trades = [
      trade({ id: 1, netPnl: 500, emotionTag: "calm" }),
      trade({ id: 2, netPnl: -300, emotionTag: "fomo" }),
      trade({ id: 3, netPnl: 200, emotionTag: "calm" }),
      trade({ id: 4, netPnl: 100 }), // no emotion — excluded
    ];
    const r = emotionReport(trades);
    expect(r[0].tag).toBe("calm");
    expect(r[0].trades).toBe(2);
    expect(r[0].winRatePct).toBe(100);
    expect(r[1].tag).toBe("fomo");
    expect(r[1].net).toBe(-300);
  });
});
