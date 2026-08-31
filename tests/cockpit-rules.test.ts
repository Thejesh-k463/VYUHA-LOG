import { describe, expect, it } from "vitest";
import {
  cockpitReport,
  type CockpitTrade,
  type Finding,
  type HoldingBehaviour,
  type SegmentRow,
  type SizingBehaviour,
  type TiltBehaviour,
  type TimeEdge,
} from "@/lib/analytics/cockpit";
import { wilsonInterval } from "@/lib/analytics/inference";
import { insightTexts, PRESCRIPTIVE_LANGUAGE, runRules } from "@/lib/intelligence/insight";
import {
  COCKPIT_RULES,
  CONTRACT_FIXTURES,
  FAST_REENTRY_MINUTES,
  SIZE_ESCALATION_PCT,
  toFinding,
  type CockpitRuleInput,
} from "@/lib/intelligence/rules/cockpit";

let id = 1;
function t(p: Partial<CockpitTrade> = {}): CockpitTrade {
  return {
    id: p.id ?? id++,
    symbol: "TEST",
    segment: "eq_delivery",
    netPnl: 0,
    buyValue: 100000,
    sellValue: 100000,
    buyDate: "2026-06-01",
    sellDate: "2026-06-01",
    entryTime: null,
    exitTime: null,
    isOpen: false,
    rMultiple: null,
    ...p,
  };
}
const many = (n: number, p: Partial<CockpitTrade> = {}) => Array.from({ length: n }, () => t(p));

const rule = (rid: string) => {
  const r = COCKPIT_RULES.find((x) => x.id === rid);
  if (!r) throw new Error(`no rule ${rid}`);
  return r;
};

/**
 * The pre-migration `findings()` implementation, FROZEN VERBATIM from
 * lib/analytics/cockpit.ts as it stood before v3.5.0 moved the rules into
 * lib/intelligence/rules/cockpit.ts. The migration's promise is that the
 * registry + adapter reproduce this byte-for-byte; this copy is what makes
 * that promise checkable rather than circular.
 */
function originalFindings(
  time: TimeEdge,
  hold: HoldingBehaviour,
  sizing: SizingBehaviour,
  tilt: TiltBehaviour,
  segments: SegmentRow[],
): Finding[] {
  const out: Finding[] = [];

  // Best vs worst session.
  const sessions = time.bySession.filter((b) => !b.thin && b.expectancy != null);
  if (sessions.length >= 2) {
    const sorted = [...sessions].sort((a, b) => (b.expectancy ?? 0) - (a.expectancy ?? 0));
    const best = sorted[0], worst = sorted[sorted.length - 1];
    if (best.key !== worst.key && (best.expectancy ?? 0) > (worst.expectancy ?? 0)) {
      out.push({
        tone: "info",
        title: `${best.label} is your strongest window`,
        detail: `₹${Math.round(best.expectancy ?? 0).toLocaleString("en-IN")} per trade across ${best.trades} trades, against ₹${Math.round(worst.expectancy ?? 0).toLocaleString("en-IN")} in the ${worst.label.toLowerCase()} over ${worst.trades}.`,
      });
    }
  }

  // Holding asymmetry.
  if (!hold.insufficient && hold.ratio != null && hold.ratio > 1.5) {
    out.push({
      tone: "warn",
      title: "Losers are held longer than winners",
      detail: `Losing trades average ${hold.avgLossDays} days against ${hold.avgWinDays} for winners — ${hold.ratio}x. Cutting winners early while giving losers room is the most common structural leak in retail trading.`,
    });
  } else if (!hold.insufficient && hold.ratio != null && hold.ratio < 0.8) {
    out.push({
      tone: "good",
      title: "Winners are held longer than losers",
      detail: `Winners average ${hold.avgWinDays} days against ${hold.avgLossDays} for losers. That is the right way round.`,
    });
  }

  // Sizing.
  if (!sizing.insufficient && sizing.biggerIsBetter === false) {
    const sm = sizing.quartiles[0], lg = sizing.quartiles[3];
    out.push({
      tone: "warn",
      title: "Your largest positions are not your best",
      detail: `Biggest quartile: ₹${Math.round(lg.expectancy ?? 0).toLocaleString("en-IN")} per trade. Smallest: ₹${Math.round(sm.expectancy ?? 0).toLocaleString("en-IN")}. Conviction is not being rewarded — that is a sizing question, not a selection one.`,
    });
  }

  // Tilt.
  if (!tilt.insufficient && tilt.afterLoss.expectancy != null && tilt.afterWin.expectancy != null) {
    const gap = tilt.afterWin.expectancy - tilt.afterLoss.expectancy;
    if (gap > 0 && tilt.afterLoss.expectancy < 0) {
      out.push({
        tone: "warn",
        title: "You trade worse immediately after a loss",
        detail: `₹${Math.round(tilt.afterLoss.expectancy).toLocaleString("en-IN")} per trade after a loser, against ₹${Math.round(tilt.afterWin.expectancy).toLocaleString("en-IN")} after a winner${tilt.sameDayReentryAfterLoss > 0 ? `, with ${tilt.sameDayReentryAfterLoss} same-day re-entries` : ""}.`,
      });
    }
  }

  // Segment worth questioning.
  const weak = segments.filter((s) => !s.thin && s.expectancy != null && s.expectancy < 0);
  if (weak.length > 0) {
    const worst = weak[weak.length - 1];
    out.push({
      tone: "warn",
      title: `${worst.label} is losing money`,
      detail: `₹${Math.round(worst.expectancy ?? 0).toLocaleString("en-IN")} per trade over ${worst.trades} trades, ${worst.winRate}% of them winners.`,
    });
  }

  // Charge drag.
  const dragged = segments.filter((s) => !s.thin && s.chargeDragPct != null && s.chargeDragPct > 30);
  for (const s of dragged.slice(0, 1)) {
    out.push({
      tone: "warn",
      title: `Charges eat ${s.chargeDragPct}% of your ${s.label} gross`,
      detail: `₹${Math.round(s.charges).toLocaleString("en-IN")} in costs across ${s.trades} trades. Fewer, larger positions carry the same edge for less friction.`,
    });
  }

  return out;
}

/** Assert the migrated registry reproduces the frozen implementation exactly. */
function expectByteEqual(
  rows: CockpitTrade[],
  charges: Record<number, number> = {},
  labels: Record<string, string> = {},
  mustFire = true,
) {
  const rep = cockpitReport(rows, charges, labels);
  const expected = originalFindings(rep.time, rep.holding, rep.sizing, rep.tilt, rep.segments);
  expect(rep.findings).toEqual(expected);
  if (mustFire) expect(expected.length).toBeGreaterThan(0);
}

describe("migrated findings are byte-identical to the pre-migration implementation", () => {
  it("loser-holding leak scenario", () => {
    expectByteEqual([
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-21" }),
    ]);
  });

  it("healthy holding scenario", () => {
    expectByteEqual([
      ...many(20, { netPnl: 500, buyDate: "2026-06-01", sellDate: "2026-06-21" }),
      ...many(20, { netPnl: -500, buyDate: "2026-06-01", sellDate: "2026-06-03" }),
    ]);
  });

  it("losing segment scenario", () => {
    expectByteEqual(
      [
        ...many(20, { segment: "eq_delivery", netPnl: 900 }),
        ...many(20, { segment: "index_option", netPnl: -800 }),
      ],
      {},
      { index_option: "Index Options" },
    );
  });

  it("session + tilt + sizing scenario", () => {
    // Two full sessions, wins first then losses — exercises the session,
    // tilt and sizing rules in one report.
    expectByteEqual([
      ...many(20, { entryTime: "10:30", netPnl: 500 }),
      ...many(20, { entryTime: "12:00", netPnl: -300 }),
    ]);
  });

  it("charge-drag scenario", () => {
    const rows = many(20, { netPnl: 800 });
    const charges = Object.fromEntries(rows.map((r) => [r.id, 600]));
    expectByteEqual(rows, charges);
  });

  it("sizing quartile scenario", () => {
    expectByteEqual(
      Array.from({ length: 40 }, (_, i) => t({ buyValue: (i + 1) * 10000, netPnl: i < 20 ? 1000 : -1000 })),
    );
  });

  it("empty and tiny books say nothing — identically", () => {
    expectByteEqual([], {}, {}, false);
    expectByteEqual(many(4, { netPnl: 100, entryTime: "09:30" }), {}, {}, false);
    expect(cockpitReport([]).findings).toEqual([]);
  });
});

describe("toFinding adapter", () => {
  it("maps headline → title, detail → detail, tone → tone", () => {
    expect(
      toFinding({ id: "x", tone: "warn", headline: "H", detail: "D", evidence: [], sampleSize: 20 }),
    ).toEqual({ tone: "warn", title: "H", detail: "D" });
  });
});

describe("revenge-reentry-minutes", () => {
  const revenge = rule("revenge-reentry-minutes");
  // 12 days: a loss exits 10:00 every day; six days re-enter after 5 minutes
  // and lose, six re-enter after 90 minutes and win.
  const fixture = CONTRACT_FIXTURES[2];

  it("fires on the contract fixture with coverage and the median gap", () => {
    const insight = revenge.compute(fixture);
    expect(insight).not.toBeNull();
    expect(insight!.tone).toBe("warn");
    expect(insight!.sampleSize).toBe(12);
    expect(insight!.coverage).toEqual({ have: 24, of: 24, noun: "closed trades with entry and exit times" });
    expect(insight!.evidence.find((e) => e.label === "median re-entry gap")?.value).toBe("47.5 min");
    expect(insight!.headline).toContain(`${FAST_REENTRY_MINUTES} minutes`);
  });

  it("refuses below the pair floor", () => {
    // Nine days = nine loss→re-entry pairs, one under the floor of 10.
    const nine: CockpitRuleInput = { ...fixture, trades: fixture.trades.slice(0, 18) };
    expect(revenge.compute(nine)).toBeNull();
  });

  it("refuses when fast re-entries are NOT losing money", () => {
    const profitable: CockpitRuleInput = {
      ...fixture,
      trades: fixture.trades.map((tr) => (tr.netPnl === -800 ? { ...tr, netPnl: 800 } : tr)),
    };
    expect(revenge.compute(profitable)).toBeNull();
  });

  it("refuses when no trades carry both time stamps — never invents a gap", () => {
    const untimed: CockpitRuleInput = {
      ...fixture,
      trades: fixture.trades.map((tr) => ({ ...tr, entryTime: null })),
    };
    expect(revenge.compute(untimed)).toBeNull();
  });
});

describe("sizing-after-loss", () => {
  const escalation = rule("sizing-after-loss");
  // 30 alternating trades: 1L loss, then a 2L trade — after-loss median 2L
  // against a 1.5L baseline = +33.33%.
  const fixture = CONTRACT_FIXTURES[3];

  it("fires on the contract fixture with the medians as evidence", () => {
    const insight = escalation.compute(fixture);
    expect(insight).not.toBeNull();
    expect(insight!.tone).toBe("warn");
    expect(insight!.sampleSize).toBe(15);
    expect(insight!.evidence.find((e) => e.label === "step up")?.value).toBe("33.33%");
    expect(insight!.detail).toContain("2,00,000");
    expect(insight!.detail).toContain("1,50,000");
  });

  it("refuses below the after-loss floor", () => {
    const nine: CockpitRuleInput = { ...fixture, trades: fixture.trades.slice(0, 18) };
    expect(escalation.compute(nine)).toBeNull();
  });

  it(`refuses a step-up at or under ${SIZE_ESCALATION_PCT}% — that is noise, not escalation`, () => {
    const flat: CockpitRuleInput = {
      ...fixture,
      trades: fixture.trades.map((tr) => ({ ...tr, buyValue: 100000 })),
    };
    expect(escalation.compute(flat)).toBeNull();
  });
});

describe("win-rate claims carry a Wilson interval", () => {
  it("segment-negative-expectancy attaches the 95% CI as evidence", () => {
    const insight = rule("segment-negative-expectancy").compute(CONTRACT_FIXTURES[0]);
    expect(insight).not.toBeNull();
    const ev = insight!.evidence.find((e) => e.label === "win rate");
    expect(ev).toBeTruthy();
    // Fixture segment: 35% winners of 20 trades → 7 wins.
    const ci = wilsonInterval(7, 20);
    expect(ev!.value).toBe(`35% (CI ${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%)`);
    expect(ev!.value).toMatch(/^\d+% \(CI \d+–\d+%\)$/);
  });
});

describe("the registry as a whole", () => {
  it("every rule fires at least once across CONTRACT_FIXTURES", () => {
    const fired = new Set<string>();
    for (const fixture of CONTRACT_FIXTURES) {
      for (const insight of runRules(COCKPIT_RULES, fixture)) fired.add(insight.id);
    }
    expect([...fired].sort()).toEqual(COCKPIT_RULES.map((r) => r.id).sort());
  });

  it("ids are unique, kebab-case, and floors are at least 10", () => {
    const ids = COCKPIT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of COCKPIT_RULES) {
      expect(r.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(r.sampleFloor, r.id).toBeGreaterThanOrEqual(10);
    }
  });

  it("no fired insight uses prescriptive language, anywhere in its text", () => {
    for (const fixture of CONTRACT_FIXTURES) {
      for (const insight of runRules(COCKPIT_RULES, fixture)) {
        for (const text of insightTexts(insight)) {
          expect(PRESCRIPTIVE_LANGUAGE.test(text), `${insight.id}: ${text}`).toBe(false);
        }
        expect(insight.sampleSize, insight.id).toBeGreaterThan(0);
      }
    }
  });
});
