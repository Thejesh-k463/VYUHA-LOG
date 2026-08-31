import { describe, expect, it } from "vitest";
import { computeKpis } from "@/lib/analytics/metrics";
import { fmtDate } from "@/lib/format";
import { PRESCRIPTIVE_LANGUAGE, insightTexts, runRules, type Insight } from "@/lib/intelligence/insight";
import {
  CONTRACT_FIXTURES,
  GROUP_RULES,
  type GroupMember,
  type GroupRuleInput,
} from "@/lib/intelligence/rules/group";

// ── Local factory ───────────────────────────────────────────────────────────

type TestMember = GroupMember & {
  acquisition?: string | null;
  buyValue?: number;
  acquisitionPrice?: number | null;
};

let seq = 0;
function m(netPnl: number, over: Partial<TestMember> = {}): TestMember {
  seq += 1;
  const chargesTotal = over.chargesTotal ?? 100;
  return {
    id: seq,
    symbol: "TCS",
    tradingsymbol: over.symbol ?? "TCS",
    buyDate: "2026-03-01",
    sellDate: "2026-03-05",
    isOpen: false,
    netPnl,
    grossPnl: netPnl + chargesTotal,
    chargesTotal,
    rMultiple: null,
    setupTag: null,
    playbookId: null,
    broker: "zerodha",
    segment: "equity-delivery",
    bucket: "delivery",
    ...over,
  };
}

function input(members: TestMember[], label = "Test group"): GroupRuleInput {
  return { label, kpis: computeKpis(members), members };
}

function fire(id: string, inp: GroupRuleInput): Insight | null {
  const rule = GROUP_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`no rule ${id}`);
  return rule.compute(inp);
}

const d2 = (n: number) => String(n).padStart(2, "0");
/** n losers with distinct, ascending sell dates in March. */
const datedLosers = (n: number, net = -1000, over: Partial<TestMember> = {}) =>
  Array.from({ length: n }, (_, i) =>
    m(net, { buyDate: `2026-03-${d2(i + 1)}`, sellDate: `2026-03-${d2(i + 3)}`, ...over }),
  );

// ── Registry shape ──────────────────────────────────────────────────────────

describe("GROUP_RULES registry", () => {
  it("has the six rules with unique kebab-case ids and floors of at least 10", () => {
    const ids = GROUP_RULES.map((r) => r.id);
    expect(ids).toEqual([
      "setup-concentration",
      "top-loser-share",
      "charge-drag",
      "streak-note",
      "holding-skew",
      "unpriced-share",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of GROUP_RULES) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.sampleFloor, r.id).toBeGreaterThanOrEqual(10);
    }
  });

  it("CONTRACT_FIXTURES make every rule fire at least once", () => {
    const fired = new Set<string>();
    for (const fixture of CONTRACT_FIXTURES) {
      for (const insight of runRules(GROUP_RULES, fixture)) fired.add(insight.id);
    }
    for (const r of GROUP_RULES) expect([...fired], r.id).toContain(r.id);
  });

  it("no fired insight uses prescriptive language, and each carries a sample size", () => {
    for (const fixture of CONTRACT_FIXTURES) {
      for (const insight of runRules(GROUP_RULES, fixture)) {
        for (const text of insightTexts(insight)) {
          expect(PRESCRIPTIVE_LANGUAGE.test(text), `${insight.id}: ${text}`).toBe(false);
        }
        expect(insight.sampleSize, insight.id).toBeGreaterThan(0);
      }
    }
  });
});

// ── setup-concentration ─────────────────────────────────────────────────────

describe("setup-concentration", () => {
  it("fires when one tag carries more than 60% of the losing total", () => {
    const members = [
      ...datedLosers(7, -3000, { setupTag: "breakout" }), // 21,000
      ...datedLosers(5, -1000, { setupTag: "reversal" }), // 5,000
      m(2000),
    ];
    const out = fire("setup-concentration", input(members));
    expect(out).not.toBeNull();
    expect(out!.headline).toContain('"breakout"');
    expect(out!.headline).toContain("81%"); // 21,000 / 26,000
    expect(out!.coverage).toEqual({ have: 12, of: 13, noun: "closed trades ended in a loss" });
    expect(out!.sampleSize).toBe(12);
  });

  it("files a blank tag under (untagged)", () => {
    const members = [...datedLosers(8, -5000, { setupTag: "  " }), ...datedLosers(4, -500, { setupTag: "x" })];
    const out = fire("setup-concentration", input(members));
    expect(out!.headline).toContain("(untagged)");
  });

  it("refuses below ten losers even when concentration is total", () => {
    const members = [...datedLosers(9, -5000, { setupTag: "breakout" }), m(1000), m(1000)];
    expect(fire("setup-concentration", input(members))).toBeNull();
  });

  it("refuses when the loss is spread across tags", () => {
    const members = [
      ...datedLosers(6, -1000, { setupTag: "a" }),
      ...datedLosers(6, -1000, { setupTag: "b" }),
    ];
    expect(fire("setup-concentration", input(members))).toBeNull();
  });
});

// ── top-loser-share ─────────────────────────────────────────────────────────

describe("top-loser-share", () => {
  it("fires and names the trade when one loss exceeds 40% of the losing total", () => {
    const members = [m(-9000, { symbol: "HDFCBANK", buyDate: "2026-03-01", sellDate: "2026-03-02" }), ...datedLosers(10, -1000)];
    const out = fire("top-loser-share", input(members));
    expect(out).not.toBeNull();
    expect(out!.headline).toContain("HDFCBANK");
    expect(out!.headline).toContain("47%"); // 9,000 / 19,000
    expect(out!.sampleSize).toBe(11);
  });

  it("refuses when losses are even", () => {
    expect(fire("top-loser-share", input(datedLosers(12, -1000)))).toBeNull();
  });

  it("refuses below ten losers", () => {
    const members = [m(-9000), ...datedLosers(8, -100)];
    expect(fire("top-loser-share", input(members))).toBeNull();
  });
});

// ── charge-drag ─────────────────────────────────────────────────────────────

describe("charge-drag", () => {
  it("fires beyond 30% of gross", () => {
    // 12 × (gross 100, charges 40): drag 40%.
    const members = Array.from({ length: 12 }, () => m(60, { chargesTotal: 40 }));
    const out = fire("charge-drag", input(members));
    expect(out).not.toBeNull();
    expect(out!.headline).toContain("40%");
    expect(out!.coverage).toBeUndefined(); // nothing open — no subset to state
  });

  it("states closed-only coverage when the group holds open positions", () => {
    const members = [
      ...Array.from({ length: 12 }, () => m(60, { chargesTotal: 40 })),
      m(0, { isOpen: true, netPnl: 0, grossPnl: 0, chargesTotal: 0 }),
    ];
    const out = fire("charge-drag", input(members));
    expect(out!.coverage).toEqual({ have: 12, of: 13, noun: "trades in this group are closed" });
  });

  it("refuses at exactly 30%", () => {
    const members = Array.from({ length: 12 }, () => m(70, { chargesTotal: 30 }));
    expect(fire("charge-drag", input(members))).toBeNull();
  });

  it("refuses when gross is zero — no denominator is invented", () => {
    const members = Array.from({ length: 12 }, () => m(-100, { chargesTotal: 100 }));
    expect(fire("charge-drag", input(members))).toBeNull();
  });

  it("refuses below ten closed trades", () => {
    const members = Array.from({ length: 9 }, () => m(60, { chargesTotal: 40 }));
    expect(fire("charge-drag", input(members))).toBeNull();
  });
});

// ── streak-note ─────────────────────────────────────────────────────────────

describe("streak-note", () => {
  it("fires on a run of five with its dates", () => {
    const members = [
      ...Array.from({ length: 5 }, (_, i) => m(1000, { sellDate: `2026-03-${d2(i + 1)}` })),
      ...Array.from({ length: 5 }, (_, i) => m(-1000, { sellDate: `2026-03-${d2(i + 10)}` })),
    ];
    const out = fire("streak-note", input(members));
    expect(out).not.toBeNull();
    expect(out!.headline).toContain("5 consecutive losses");
    expect(out!.headline).toContain(fmtDate("2026-03-10"));
    expect(out!.headline).toContain(fmtDate("2026-03-14"));
    expect(out!.sampleSize).toBe(10);
  });

  it("lets a breakeven exit continue a run, matching the streak KPI", () => {
    const members = [
      ...Array.from({ length: 4 }, (_, i) => m(1000, { sellDate: `2026-03-${d2(i + 1)}` })),
      m(-1000, { sellDate: "2026-03-10" }),
      m(-1000, { sellDate: "2026-03-11" }),
      m(0, { sellDate: "2026-03-12" }),
      m(-1000, { sellDate: "2026-03-13" }),
      m(-1000, { sellDate: "2026-03-14" }),
      m(-1000, { sellDate: "2026-03-15" }),
    ];
    const inp = input(members);
    expect(inp.kpis.maxLossStreak).toBe(5);
    const out = fire("streak-note", inp);
    expect(out!.headline).toContain("5 consecutive losses");
  });

  it("refuses on a run of four", () => {
    const members = [
      ...Array.from({ length: 6 }, (_, i) => m(1000, { sellDate: `2026-03-${d2(i + 1)}` })),
      ...Array.from({ length: 4 }, (_, i) => m(-1000, { sellDate: `2026-03-${d2(i + 10)}` })),
    ];
    expect(fire("streak-note", input(members))).toBeNull();
  });

  it("refuses below ten closed trades even with a long run", () => {
    const members = Array.from({ length: 9 }, (_, i) => m(-1000, { sellDate: `2026-03-${d2(i + 1)}` }));
    expect(fire("streak-note", input(members))).toBeNull();
  });
});

// ── holding-skew ────────────────────────────────────────────────────────────

const heldFor = (days: number, net: number, over: Partial<TestMember> = {}) =>
  m(net, { buyDate: "2026-03-01", sellDate: `2026-03-${d2(1 + days)}`, ...over });

describe("holding-skew", () => {
  it("fires when winners are held more than 1.5x longer", () => {
    const members = [
      ...Array.from({ length: 5 }, () => heldFor(10, 1000)),
      ...Array.from({ length: 5 }, () => heldFor(2, -1000)),
    ];
    const out = fire("holding-skew", input(members));
    expect(out).not.toBeNull();
    expect(out!.headline).toContain("winners stay open about 5.0× longer than losers");
    expect(out!.evidence.map((e) => e.value)).toEqual(["10.0 days", "2.0 days"]);
  });

  it("fires the other way round when losers are held longer", () => {
    const members = [
      ...Array.from({ length: 5 }, () => heldFor(2, 1000)),
      ...Array.from({ length: 5 }, () => heldFor(10, -1000)),
    ];
    const out = fire("holding-skew", input(members));
    expect(out!.headline).toContain("losers stay open about 5.0× longer than winners");
  });

  it("skips undated rows, counts them in coverage, and floors a same-day hold at one day", () => {
    const members = [
      ...Array.from({ length: 5 }, () => heldFor(10, 1000)),
      ...Array.from({ length: 5 }, () => m(-1000, { buyDate: "2026-03-01", sellDate: "2026-03-01" })), // 0 days -> 1
      ...Array.from({ length: 3 }, () => m(-1000, { buyDate: null })),
    ];
    const out = fire("holding-skew", input(members));
    expect(out).not.toBeNull();
    expect(out!.coverage).toEqual({ have: 10, of: 13, noun: "closed win/loss trades carry both dates" });
    expect(out!.detail).toContain("3 closed trades without both dates");
    expect(out!.evidence[1].value).toBe("1.0 days");
    expect(out!.sampleSize).toBe(10);
  });

  it("refuses when the divergence is within 1.5x", () => {
    const members = [
      ...Array.from({ length: 5 }, () => heldFor(3, 1000)),
      ...Array.from({ length: 5 }, () => heldFor(2, -1000)),
    ];
    expect(fire("holding-skew", input(members))).toBeNull();
  });

  it("refuses when undated rows pull the dated count below ten", () => {
    const members = [
      ...Array.from({ length: 5 }, () => heldFor(10, 1000)),
      ...Array.from({ length: 4 }, () => heldFor(2, -1000)),
      ...Array.from({ length: 3 }, () => m(-1000, { sellDate: null, isOpen: false })),
    ];
    expect(fire("holding-skew", input(members))).toBeNull();
  });

  it("refuses when either side has fewer than three dated trades", () => {
    const members = [
      ...Array.from({ length: 2 }, () => heldFor(10, 1000)),
      ...Array.from({ length: 10 }, () => heldFor(2, -1000)),
    ];
    expect(fire("holding-skew", input(members))).toBeNull();
  });
});

// ── unpriced-share ──────────────────────────────────────────────────────────

const unpriced = (net: number) =>
  m(net, { acquisition: "off-market", buyValue: 0, acquisitionPrice: null });

describe("unpriced-share", () => {
  it("fires with priced-of-closed coverage and the unpriced cash", () => {
    const members = [...Array.from({ length: 10 }, () => m(500)), unpriced(4000), unpriced(4000)];
    const inp = input(members);
    expect(inp.kpis.unpricedCount).toBe(2);
    const out = fire("unpriced-share", inp);
    expect(out).not.toBeNull();
    expect(out!.headline).toContain("2 of");
    expect(out!.headline).toContain("12 closed trades");
    expect(out!.coverage).toEqual({ have: 10, of: 12, noun: "closed trades carry a cost basis" });
    expect(out!.detail).toContain("₹8,000");
  });

  it("refuses when every closed trade is priced", () => {
    expect(fire("unpriced-share", input(Array.from({ length: 12 }, () => m(500))))).toBeNull();
  });

  it("refuses below ten closed trades", () => {
    const members = [...Array.from({ length: 8 }, () => m(500)), unpriced(4000)];
    expect(fire("unpriced-share", input(members))).toBeNull();
  });
});
