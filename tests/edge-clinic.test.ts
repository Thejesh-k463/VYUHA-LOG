import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  edgeClinic,
  expectancyShift,
  dayOf,
  EVIDENCE_GRADES,
  FNO_STT_EPOCH,
  FNO_WEEKLY_EXPIRY_CUT,
  type ClinicTrade,
  type ClinicReport,
  type ClinicCell,
  type GapCheck,
} from "@/lib/analytics/edge-clinic";
import { STT_EPOCH_2024 } from "@/lib/db/seed-data";
import { mulberry32 } from "@/lib/analytics/monte-carlo";
import { benjaminiHochberg, benjaminiYekutieli } from "@/lib/analytics/inference";
import { rProvenanceLine } from "@/lib/analytics/win-loss";
import { mean } from "@/lib/analytics/edge-clinic-stats";
import { cellTrades } from "@/lib/analytics/edge-clinic";

const TODAY = "2026-10-01";

let nextId = 1;
function trade(p: Partial<ClinicTrade>): ClinicTrade {
  return {
    id: nextId++,
    segment: "eq_intraday",
    buyQty: 10,
    sellQty: 10,
    side: "long",
    buyDate: "2026-01-05",
    sellDate: "2026-01-05",
    entryTime: null,
    exitTime: null,
    isOpen: false,
    grossPnl: 0,
    chargesTotal: 20,
    netPnl: 0,
    rMultiple: 0,
    riskAmount: 1000,
    riskSource: "set",
    rPlan: false,
    slPlanned: null,
    trailingSl: null,
    avgBuyPrice: 100,
    avgSellPrice: 100,
    setupTag: null,
    ruleViolations: null,
    entryDte: null,
    lotSize: null,
    ...p,
  };
}

/** The ISO day `i` days after 2025-01-01 (test-side date arithmetic). */
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);

/** Seeded normals, de-meaned and scaled to sample sd 1 exactly, then shifted to `mu`. */
function exact(n: number, mu: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const z: number[] = [];
  while (z.length < n) {
    const r = Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-12)));
    const th = 2 * Math.PI * rnd();
    z.push(r * Math.cos(th));
    if (z.length < n) z.push(r * Math.sin(th));
  }
  const m = mean(z);
  const sd = Math.sqrt(z.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  return z.map((x) => ((x - m) / sd) + mu);
}

/** One closed trade per R, one per day from `startDay`, ₹1,000 risked, ₹20 charges. */
function fromR(rs: number[], base: Partial<ClinicTrade>, startDay: number): ClinicTrade[] {
  return rs.map((r, i) =>
    trade({
      ...base,
      rMultiple: r,
      netPnl: r * 1000,
      grossPnl: r * 1000 + 20,
      buyDate: dayPlus(startDay + i),
      sellDate: dayPlus(startDay + i),
    }),
  );
}

/** Every string anywhere in a value. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

/** Every card (anything carrying `copy` + `verb`) with the grade it answers to. */
function cards(r: ClinicReport): { verb: string; grade: string; where: string }[] {
  const out: { verb: string; grade: string; where: string }[] = [];
  const cellCards = (c: ClinicCell) => {
    out.push({ verb: c.verb, grade: c.grade, where: c.key });
    if (c.sizing) out.push({ verb: c.sizing.verb, grade: c.grade, where: `${c.key}#sizing` });
    if (c.decay) out.push({ verb: c.decay.verb, grade: "decay", where: `${c.key}#decay` });
    if (c.ruleAdherence.check) out.push({ verb: c.ruleAdherence.check.verb, grade: c.ruleAdherence.check.grade, where: `${c.key}#rules` });
  };
  r.cells.forEach(cellCards);
  for (const f of r.fno) [...f.dte, ...(f.side ?? []), ...f.lots, ...f.expiryRegime].forEach(cellCards);
  for (const b of r.behaviour) {
    for (const c of b.checks) out.push({ verb: c.verb, grade: c.grade, where: `${b.segment}#${c.id}` });
    out.push({ verb: b.hold.verb, grade: "hold", where: `${b.segment}#hold` });
  }
  return out;
}

// ── The grid: one real edge among five nulls ─────────────────────────────────

function gridBook(): ClinicTrade[] {
  const ts: ClinicTrade[] = [];
  let day = 0;
  const add = (rs: number[], base: Partial<ClinicTrade>) => {
    ts.push(...fromR(rs, base, day));
    day += rs.length;
  };
  add(exact(80, 0.5, 11), { segment: "eq_intraday", setupTag: "A" }); // the real edge
  add(exact(40, 0, 12), { segment: "eq_intraday", setupTag: "B" });
  add(exact(40, 0, 13), { segment: "eq_intraday", setupTag: "C" });
  add(exact(40, 0, 14), { segment: "eq_delivery", setupTag: "D" });
  add(exact(40, 0, 15), { segment: "eq_delivery", setupTag: "E" });
  add(exact(40, 0, 16), { segment: "eq_delivery", setupTag: "F" });
  add(exact(10, 0, 17), { segment: "eq_delivery", setupTag: "G" }); // insufficient
  return ts;
}

const grid = edgeClinic(gridBook(), { today: TODAY });
const cell = (r: ClinicReport, key: string) => {
  const c = r.cells.find((x) => x.key === key);
  if (!c) throw new Error(`no cell ${key}`);
  return c;
};

describe("the grid: grades after Benjamini–Yekutieli", () => {
  it("m counts the cells with n ≥ 20 — book + 2 segments + 6 setups = 9 (G's 10 trades are not a test)", () => {
    expect(grid.cells).toHaveLength(1 + 2 + 7);
    expect(grid.m).toBe(9);
    expect(grid.multiplicity).toEqual({ method: "BY", q: 0.05, m: 9 });
    expect(grid.cells.filter((c) => c.tested)).toHaveLength(9);
  });

  it("exactly the real-edge setup is established among the setups; the five nulls are unclear", () => {
    const setups = grid.cells.filter((c) => c.kind === "setup");
    expect(setups.filter((c) => c.grade === "established").map((c) => c.key)).toEqual(["eq_intraday|setup:A"]);
    for (const k of ["B", "C"]) expect(cell(grid, `eq_intraday|setup:${k}`).grade).toBe("unclear");
    for (const k of ["D", "E", "F"]) expect(cell(grid, `eq_delivery|setup:${k}`).grade).toBe("unclear");
    expect(cell(grid, "eq_delivery|setup:G").grade).toBe("insufficient");
  });

  it("no cell made only of null setups is established; an established aggregate always contains A", () => {
    expect(cell(grid, "eq_delivery|all").grade).toBe("unclear");
    for (const c of grid.cells.filter((x) => x.grade === "established")) {
      expect(["all|all", "eq_intraday|all", "eq_intraday|setup:A"]).toContain(c.key);
    }
  });

  it("the established edge carries the imperative; its mean and CI are the sample's", () => {
    const a = cell(grid, "eq_intraday|setup:A");
    expect(a.verb).toBe("imperative");
    expect(a.copy.headline).toBe("Keep sizing Equity Intraday · A as you do");
    expect(a.meanR!).toBeCloseTo(0.5, 12);
    expect(a.ci!.lo).toBeGreaterThan(0);
    expect(a.copy.detail).toMatch(/survives the correction for 9 tested cells/);
  });

  it("insufficient reads \"—\" and \"n = 10, need ≥ 20\"", () => {
    const g = cell(grid, "eq_delivery|setup:G");
    expect(g.verb).toBe("none");
    expect(g.copy.headline).toBe("—");
    expect(g.copy.detail).toMatch(/^n = 10, need ≥ 20/);
    expect(g.verdict).toBe("n = 10, need ≥ 20");
  });

  it("unclear cells get a bounded experiment, never an imperative", () => {
    const b = cell(grid, "eq_intraday|setup:B");
    expect(b.verb).toBe("test");
    expect(b.copy.detail).toMatch(/^Test: next 20 trades in Equity Intraday · B/);
  });

  it("is deterministic: the same book gives the same report", () => {
    expect(edgeClinic(gridBook(), { today: TODAY })).toEqual(grid);
  });
});

describe("BY, not BH — the correction the cells' overlap requires", () => {
  // One segment, four setups: X carries a modest edge whose two-sided p falls
  // BETWEEN BH's rank-1 threshold (q/m) and BY's (q/(m·H_m)).
  const book = (() => {
    const ts: ClinicTrade[] = [];
    let day = 0;
    for (const [tag, mu, seed] of [["X", 0.47, 21], ["Y", 0, 22], ["Z", 0, 23], ["W", 0, 24]] as const) {
      ts.push(...fromR(exact(40, mu, seed), { setupTag: tag }, day));
      day += 40;
    }
    return ts;
  })();
  const r = edgeClinic(book, { today: TODAY });
  const x = cell(r, "eq_intraday|setup:X");

  it("precondition: m = 6 and X's p sits between the BY and BH thresholds", () => {
    expect(r.m).toBe(6);
    const items = r.cells.filter((c) => c.tested).map((c) => ({ item: c.key, p: c.pTwoSided ?? 1 }));
    expect(benjaminiHochberg(items).find((v) => v.item === x.key)!.significant).toBe(true);
    expect(benjaminiYekutieli(items).find((v) => v.item === x.key)!.significant).toBe(false);
  });

  it("X is 'likely' (CI excludes 0, fails BY) — it would be 'established' under BH", () => {
    expect(x.ci!.lo).toBeGreaterThan(0);
    expect(x.grade).toBe("likely");
    expect(x.verb).toBe("test");
    expect(x.copy.headline).toBe("Equity Intraday · X: a likely positive edge, not yet established");
  });
});

describe("grade rules hold on every card", () => {
  const richReport = edgeClinic(richBook(), { today: TODAY, riskCapRupees: 1000, currentRiskPct: 1 });
  const reports = [grid, richReport, edgeClinic([], { today: TODAY })];

  it("every cell has exactly one grade from the four, by the stated rule", () => {
    for (const r of reports) {
      const all = [...r.cells, ...r.fno.flatMap((f) => [...f.dte, ...(f.side ?? []), ...f.lots, ...f.expiryRegime])];
      for (const c of all) {
        expect(EVIDENCE_GRADES).toContain(c.grade);
        if (c.nWithR < r.params.minN) expect(c.grade).toBe("insufficient");
        else if (c.ci!.lo <= 0 && c.ci!.hi >= 0) expect(c.grade).toBe("unclear");
        else expect(["likely", "established"]).toContain(c.grade);
      }
    }
  });

  it("`imperative` appears ONLY on established evidence", () => {
    let imperatives = 0;
    for (const r of reports) {
      for (const k of cards(r)) {
        if (k.verb === "imperative") {
          imperatives++;
          expect(k.grade, k.where).toBe("established");
        }
      }
    }
    expect(imperatives).toBeGreaterThan(3); // the guard saw some
  });

  it("no string anywhere in the report states a counterfactual", () => {
    const bad = /would have|could have made|missed out/i;
    const strings = reports.flatMap((r) => allStrings(r));
    expect(strings.length).toBeGreaterThan(100); // the scan saw the copy, not an empty shell
    expect(strings.filter((s) => bad.test(s))).toEqual([]);
    // …and it would see one: a planted string is caught.
    expect(allStrings({ a: [{ b: "you would have made ₹5" }] }).some((s) => bad.test(s))).toBe(true);
  });

  it("every cell's provenanceLine is rProvenanceLine of its own counts", () => {
    for (const c of richReport.cells) expect(c.copy.provenanceLine).toBe(rProvenanceLine(c.provenance));
    expect(richReport.provenanceLine).toBe(rProvenanceLine(richReport.provenance));
  });
});

// ── A richer book for the behaviour, F&O and sizing paths ───────────────────

function richBook(): ClinicTrade[] {
  const ts: ClinicTrade[] = [];
  // Intraday: 25 days × 3 trades; 1st of day wins, 3rd loses.
  const rnd = mulberry32(5);
  for (let d = 0; d < 25; d++) {
    const day = dayPlus(d);
    [1, 0, -1].forEach((base, k) => {
      const r = base + (rnd() - 0.5) * 0.4;
      ts.push(
        trade({
          segment: "eq_intraday",
          setupTag: "ORB",
          rMultiple: r,
          netPnl: r * 1000,
          grossPnl: r * 1000 + 20,
          buyDate: day,
          sellDate: day,
          entryTime: `09:${String(20 + k * 10).padStart(2, "0")}`,
          exitTime: `1${k}:00`,
          ruleViolations: k === 2 ? ["Playbook: Wait for the retest"] : [],
        }),
      );
    });
  }
  // Index options: 70 trades, 1 lot, DTE 1, buyers and sellers.
  const opt = exact(70, 0.3, 31);
  opt.forEach((r, i) =>
    ts.push(
      trade({
        segment: "index_option",
        setupTag: i % 2 ? "straddle" : "breakout",
        side: i % 3 === 0 ? "short" : "long",
        buyQty: 50,
        sellQty: 50,
        lotSize: 50,
        entryDte: 1,
        rMultiple: r,
        netPnl: r * 1000,
        grossPnl: r * 1000 + 40,
        chargesTotal: 40,
        riskAmount: 1200,
        buyDate: dayPlus(100 + i),
        sellDate: dayPlus(100 + i),
      }),
    ),
  );
  return ts;
}

const rich = edgeClinic(richBook(), { today: TODAY, riskCapRupees: 1000, currentRiskPct: 1 });

describe("behaviour checks per segment", () => {
  const checks = rich.behaviour.find((b) => b.segment === "eq_intraday")!.checks;
  const byId = (id: GapCheck["id"]) => checks.find((c) => c.id === id)!;

  it("k-th trade of the day: 3rd+ minus 1st, a clear negative gap is capped at likely (uncorrected)", () => {
    const k = byId("kth-trade");
    expect(k.arms.map((a) => a.n)).toEqual([25, 25, 25]);
    expect(k.gap!).toBeCloseTo(k.arms[2].mean! - k.arms[0].mean!, 12);
    expect(k.gap!).toBeLessThan(-1.5);
    expect(k.ci!.hi).toBeLessThan(0);
    expect(k.grade).toBe("likely");
    expect(k.verb).toBe("test");
    expect(k.copy.headline).toMatch(/^Later trades of the day in Equity Intraday: a likely gap of −\d\.\d\d R per trade, not yet established$/);
    expect(k.copy.detail).toMatch(/^Test: log the next 20 trades.*not corrected for the other behaviour checks/);
  });

  it("owner ruling C2: an uncorrected gap check is never established — a huge gap is `likely`, verb `test`", () => {
    // 40 trades after a win at +3 R, 39 after a loss at −3 R: a 6 R gap, CI far from 0.
    const rs: number[] = [];
    for (let i = 0; i < 80; i++) rs.push(i % 2 ? -3 - (i % 3) * 0.01 : 3 + (i % 5) * 0.01);
    const sameSign: number[] = [];
    for (let i = 0; i < 80; i++) sameSign.push(i < 40 ? 3 + (i % 3) * 0.01 : -3 - (i % 4) * 0.01);
    const r = edgeClinic(fromR(sameSign, {}, 0), { today: TODAY });
    const al = r.behaviour[0].checks.find((c) => c.id === "after-loss")!;
    expect(Math.abs(al.gap!)).toBeGreaterThan(4);
    expect(al.ci!.hi < 0 || al.ci!.lo > 0).toBe(true);
    expect(al.grade).toBe("likely");
    expect(al.verb).toBe("test");
    expect(al.copy.detail).toMatch(/Graded on its own — not corrected for the other behaviour checks\./);

    // Every GapCheck in every synthetic report: never established, never imperative.
    const reports = [grid, rich, r, edgeClinic(fromR(rs, {}, 0), { today: TODAY }), edgeClinic(richBook(), { today: TODAY })];
    let seen = 0;
    for (const rep of reports) {
      const gaps: GapCheck[] = [
        ...rep.behaviour.flatMap((b) => b.checks),
        ...[...rep.cells, ...rep.fno.flatMap((f) => [...f.dte, ...(f.side ?? []), ...f.lots, ...f.expiryRegime])]
          .map((c) => c.ruleAdherence.check)
          .filter((c): c is GapCheck => c != null),
      ];
      for (const g of gaps) {
        seen++;
        expect(g.grade, g.id).not.toBe("established");
        expect(g.verb, g.id).not.toBe("imperative");
      }
    }
    expect(seen).toBeGreaterThan(15); // the sweep saw the checks it guards
  });

  it("same-day re-entry after a loss: the 3rd trade follows a flat-ish 2nd — arms reported with counts", () => {
    const r = byId("re-entry");
    expect(r.arms).toHaveLength(2);
    expect(r.arms[0].n + r.arms[1].n).toBe(74); // every trade but the first
  });

  it("an arm under minArm is insufficient with the counts in the copy", () => {
    const small = edgeClinic(fromR([1, -1, 1, -1, 1, -1], {}, 0), { today: TODAY });
    const al = small.behaviour[0].checks.find((c) => c.id === "after-loss")!;
    expect(al.grade).toBe("insufficient");
    expect(al.ci).toBeNull();
    expect(al.copy.headline).toBe("—");
    expect(al.copy.detail).toMatch(/need ≥ 15 in each/);
  });

  it("after-loss vs after-win: a book that loses after losses reads a likely negative gap", () => {
    const rs: number[] = [];
    for (let b = 0; b < 8; b++) rs.push(1, 1.1, 0.9, 1, 1.2, -1, -1.1, -0.9, -1, -1.2);
    const r = edgeClinic(fromR(rs, {}, 0), { today: TODAY });
    const al = r.behaviour[0].checks.find((c) => c.id === "after-loss")!;
    expect(al.arms.map((a) => a.label)).toEqual(["after a win", "after a loss"]);
    expect(al.gap!).toBeLessThan(0);
    expect(al.grade).toBe("likely");
    expect(al.copy.headline).toMatch(/^Trading straight after a loss in Equity Intraday: a likely gap of −/);
  });

  it("size creep reads riskAmount the user SET only, in rupees, with coverage", () => {
    const rs: number[] = [];
    const ts: ClinicTrade[] = [];
    for (let i = 0; i < 80; i++) rs.push(i % 2 ? 1 : -1);
    fromR(rs, {}, 0).forEach((t, i) => {
      const prevWon = i > 0 && rs[i - 1] > 0;
      ts.push({ ...t, riskAmount: prevWon ? 2000 + (i % 7) : 1000 + (i % 5), riskSource: i % 10 === 0 ? "cap" : "set" });
    });
    const sc = edgeClinic(ts, { today: TODAY }).behaviour[0].checks.find((c) => c.id === "size-creep")!;
    expect(sc.unit).toBe("rupees");
    expect(sc.coverage!.of).toBe(79);
    expect(sc.coverage!.withData).toBe(79 - 7); // the 'cap' rows at i = 10, 20, … 70 are not a size
    expect(sc.gap!).toBeGreaterThan(900);
    expect(sc.grade).toBe("likely");
    expect(sc.copy.headline).toMatch(/^Size after a win in Equity Intraday: a likely gap of \+₹\d+ per trade, not yet established$/);
  });

  it("hold clock: losers held longer than winners → disposition, but the card is a test, not an imperative", () => {
    const ts: ClinicTrade[] = [];
    for (let i = 0; i < 40; i++) {
      const win = i % 2 === 0;
      ts.push(
        trade({
          segment: "eq_delivery",
          rMultiple: win ? 1 : -1,
          netPnl: win ? 1000 : -1000,
          buyDate: dayPlus(i * 20),
          sellDate: dayPlus(i * 20 + (win ? 2 + (i % 3) : 10 + (i % 4))),
        }),
      );
    }
    const h = edgeClinic(ts, { today: TODAY }).behaviour[0].hold;
    expect(h.days.winners.n).toBe(20);
    expect(h.days.holdRatio!).toBeGreaterThan(3);
    expect(h.days.disposition).toBe(true);
    expect(h.verb).toBe("test");
    expect(h.copy.headline).toBe("You hold losers longer than winners in Equity Delivery");
  });

  it("hold clock falls to minutes on same-day trades (a 0-day winner median has no ratio)", () => {
    const h = rich.behaviour.find((b) => b.segment === "eq_intraday")!.hold;
    expect(h.days.holdRatio).toBeNull();
    expect(h.minutes.winners.n + h.minutes.losers.n).toBe(75);
  });
});

describe("rule adherence", () => {
  it("coverage is null when ruleViolations is null everywhere", () => {
    for (const c of grid.cells) {
      expect(c.ruleAdherence.coverage).toBeNull();
      expect(c.ruleAdherence.check).toBeNull();
    }
  });

  it("arms are broke-a-playbook-rule vs kept-every-rule; gap = adherent − violated", () => {
    const c = cell(rich, "eq_intraday|setup:ORB");
    expect(c.ruleAdherence.coverage).toEqual({ withData: 75, of: 75 });
    const chk = c.ruleAdherence.check!;
    expect(chk.arms.map((a) => [a.label, a.n])).toEqual([["broke a playbook rule", 25], ["kept every rule", 50]]);
    expect(chk.gap!).toBeCloseTo(chk.arms[1].mean! - chk.arms[0].mean!, 12);
    expect(chk.grade).toBe("likely");
    expect(chk.verb).toBe("test");
    expect(chk.copy.headline).toMatch(/^Keeping to your playbook rules in Equity Intraday · ORB: a likely gap of \+/);
  });

  it("a non-playbook violation (a limit breach) does not count as breaking a playbook rule", () => {
    const ts = fromR(exact(30, 0, 3), { ruleViolations: ["Daily loss: limit hit"] }, 0);
    const chk = edgeClinic(ts, { today: TODAY }).cells[0].ruleAdherence.check!;
    expect(chk.arms.map((a) => a.n)).toEqual([0, 30]);
    expect(chk.grade).toBe("insufficient");
  });
});

describe("F&O cuts", () => {
  it("are absent for an equity-only book", () => {
    expect(grid.fno).toEqual([]);
  });

  it("index options get DTE, buyer/seller, lots and the weekly-expiry regime — and they count toward m", () => {
    const f = rich.fno.find((x) => x.segment === "index_option")!;
    expect(f.dte.map((c) => c.n)).toEqual([70, 0, 0, 0, 0]);
    expect(f.side!.map((c) => [c.cut!.label, c.n])).toEqual([["buyer", 46], ["seller", 24]]);
    expect(f.lots.map((c) => c.n)).toEqual([70, 0, 0]);
    expect(f.expiryRegime.map((c) => c.n)).toEqual([0, 70]);
    // Hand count of tested cells (nWithR ≥ 20):
    //  book 145, eq_intraday all 75, ORB 75, index_option all 70, breakout 35, straddle 35  → 6
    //  F&O: DTE 0–2 70, buyer 46, seller 24, 1 lot 70, from-cut 70                         → 5
    expect(rich.m).toBe(11);
  });

  it("oneLotOverCap counts one-lot trades whose risk exceeds the cap; null without a cap", () => {
    expect(rich.fno[0].oneLotOverCap).toBe(70); // ₹1,200 risked on one lot against a ₹1,000 cap
    const noCap = edgeClinic(richBook(), { today: TODAY });
    expect(noCap.fno[0].oneLotOverCap).toBeNull();
  });

  it("FNO_STT_EPOCH can never drift from the seed's STT_EPOCH_2024; the expiry cut is SEBI's date", () => {
    expect(FNO_STT_EPOCH).toBe(STT_EPOCH_2024);
    expect(FNO_WEEKLY_EXPIRY_CUT).toBe("2024-11-20");
  });
});

describe("cost drag, win-rate × payoff, ΔE", () => {
  it("cost per trade, cost share of gross wins and cost in R", () => {
    const c = cell(grid, "eq_intraday|setup:A");
    expect(c.cost.costPerTrade).toBeCloseTo(20, 12);
    const ts = gridBook().filter((t) => t.setupTag === "A");
    const grossWins = ts.filter((t) => t.grossPnl > 0).reduce((s, t) => s + t.grossPnl, 0);
    expect(c.cost.costShareOfGrossWins!).toBeCloseTo((20 * 80) / grossWins, 12);
    expect(c.cost.costInR!).toBeCloseTo(0.02, 12);
    expect(c.cost.netMean!).toBeCloseTo(500, 9);
  });

  it("cost in R is null when riskAmount is unknown on every row (never a fabricated denominator)", () => {
    const r = edgeClinic(fromR(exact(30, 0.1, 4), { riskAmount: null }, 0), { today: TODAY });
    expect(r.cells[0].cost.costInR).toBeNull();
    expect(r.cells[0].cost.costInRN).toBe(0);
  });

  it("breakeven p* = L̄/(W̄ + L̄), and a win rate whose upper bound sits below it is flagged", () => {
    const rs = [...Array(10).fill(2), ...Array(90).fill(-1)];
    const p = edgeClinic(fromR(rs, {}, 0), { today: TODAY }).cells[0].payoff!;
    expect(p.meanWin).toBe(2);
    expect(p.meanLoss).toBe(1);
    expect(p.b).toBe(2);
    expect(p.breakevenP!).toBeCloseTo(1 / 3, 14);
    expect(p.p.point).toBeCloseTo(0.1, 14);
    expect(p.winRateProblem).toBe(true);
  });

  it("ΔE: the midpoint decomposition sums to the total EXACTLY (|sum − total| < 1e-9)", () => {
    const rnd = mulberry32(77);
    for (let k = 0; k < 25; k++) {
      const a = Array.from({ length: 30 }, () => (rnd() - 0.45) * 4);
      const b = Array.from({ length: 30 }, () => (rnd() - 0.55) * 3);
      const d = expectancyShift(a, b)!;
      expect(Math.abs(d.fromWinRate + d.fromWinners + d.fromLosers - d.total)).toBeLessThan(1e-9);
      expect(d.total).toBeCloseTo(mean(b) - mean(a), 9); // E is the mean R exactly
    }
  });

  it("ΔE on a cell splits the chronological sequence in halves; null when a half has no loss", () => {
    const d = cell(grid, "eq_intraday|setup:A").payoff!.deltaE!;
    expect(d.prev.n).toBe(40);
    expect(d.curr.n).toBe(40);
    expect(Math.abs(d.fromWinRate + d.fromWinners + d.fromLosers - d.total)).toBeLessThan(1e-9);
    expect(expectancyShift([1, 2, 3], [1, -1])).toBeNull();
  });
});

describe("R units and provenance", () => {
  it("rUnit is 'cap' when every R comes from the default cap, and the copy says so", () => {
    const r = edgeClinic(fromR(exact(30, 0.6, 8), { riskSource: "cap" }, 0), { today: TODAY });
    const c = r.cells[0];
    expect(c.rUnit).toBe("cap");
    expect(c.copy.detail).toMatch(/per-trade cap, not of the risk you took/);
    expect(c.provenance.cap).toBe(30);
  });

  it("one non-cap R makes the cell 'R'", () => {
    const ts = fromR(exact(30, 0.6, 8), { riskSource: "cap" }, 0);
    ts[0] = { ...ts[0], riskSource: "set" };
    expect(edgeClinic(ts, { today: TODAY }).cells[0].rUnit).toBe("R");
  });
});

describe("PSR / MinTRL / decay / sizing per cell", () => {
  it("below 30 R values: early, a bootstrap CI as well, and no moments / PSR / MinTRL", () => {
    const c = edgeClinic(fromR(exact(25, 0.8, 9), {}, 0), { today: TODAY }).cells[0];
    expect(c.early).toBe(true);
    expect(c.bootstrapCi).not.toBeNull();
    expect(c.g3).toBeNull();
    expect(c.psr).toBeNull();
    expect(c.minTrl).toBeNull();
    expect(c.sr).not.toBeNull();
  });

  it("MinTRL: trades still needed = max(0, ⌈MinTRL⌉ − n); capped display above 1000; null when sr ≤ 0", () => {
    const a = cell(grid, "eq_intraday|setup:A");
    expect(a.minTrl!).toBeGreaterThan(0);
    expect(a.tradesStillNeeded).toBe(Math.max(0, Math.ceil(a.minTrl!) - a.nWithR));
    const tiny = edgeClinic(fromR(exact(40, 0.02, 10), {}, 0), { today: TODAY }).cells[0];
    expect(tiny.minTrl!).toBeGreaterThan(1000);
    expect(tiny.minTrlCapped).toBe(true);
    const neg = edgeClinic(fromR(exact(40, -0.2, 10), {}, 0), { today: TODAY }).cells[0];
    expect(neg.minTrl).toBeNull();
    expect(neg.tradesStillNeeded).toBeNull();
  });

  it("edge decay only from n ≥ 60; a late drop raises a CUSUM alarm worded as a test", () => {
    expect(cell(grid, "eq_intraday|setup:B").decay).toBeNull();
    const rs = [...exact(60, 0.6, 40), ...exact(60, -0.6, 41)];
    const c = edgeClinic(fromR(rs, {}, 0), { today: TODAY }).cells[0];
    expect(c.decay!.cusum.alarmIndex!).toBeGreaterThanOrEqual(60);
    expect(c.decay!.band).toHaveLength(120 - 30 + 1);
    expect(c.decay!.verb).toBe("test");
  });

  it("sizing ceiling from n ≥ 50: half-Kelly at the lower bounds, streak copy, growth at the current risk", () => {
    const r = edgeClinic(gridBook(), { today: TODAY, currentRiskPct: 1 });
    const s = cell(r, "eq_intraday|setup:A").sizing!;
    expect(s.supportsSizingUp).toBe(true);
    expect(s.halfKellyLowerBound!).toBeGreaterThan(0);
    expect(s.halfKellyLowerBound!).toBeLessThan(s.kellyPoint! / 2);
    expect(s.verb).toBe("imperative");
    expect(s.growthAtCurrent!).toBeGreaterThan(0);
    expect(s.copy.detail).toMatch(/^Half-Kelly at the lower 95 % bounds.*at 1 % risk and a [\d.]+ % loss rate, a run of \d+ straight losses in the next 200 trades is normal/);
    expect(cell(r, "eq_intraday|setup:B").sizing).toBeNull(); // 40 < 50
    expect(cell(grid, "eq_intraday|setup:A").sizing!.growthAtCurrent).toBeNull();
  });

  it("a null-edge cell with n ≥ 50 says the data does not support sizing up", () => {
    const s = edgeClinic(fromR(exact(80, 0, 50), {}, 0), { today: TODAY }).cells[0].sizing!;
    expect(s.supportsSizingUp).toBe(false);
    expect(s.halfKellyLowerBound).toBeNull();
    expect(s.copy.headline).toMatch(/the data does not support sizing up$/);
    expect(s.verb).toBe("none");
  });

  it("deflation: the best cell is A, DSR < its PSR, N = m", () => {
    const d = grid.deflation!;
    expect(d.bestCellKey).toBe("eq_intraday|setup:A");
    expect(d.nTrials).toBe(9);
    expect(d.deflatedSr!).toBeLessThan(d.psr!);
    expect(d.withinLuck).toBe(false);
  });
});

describe("open trades, empty books, purity", () => {
  it("open trades never enter any statistic", () => {
    const base = gridBook();
    const opens = fromR([50, -50, 99], { setupTag: "A", isOpen: true }, 900);
    const r = edgeClinic([...base, ...opens], { today: TODAY });
    expect(r.openExcluded).toBe(3);
    expect(r.closedTrades).toBe(base.length);
    expect(r.cells).toEqual(grid.cells);
    expect(r.m).toBe(grid.m);
  });

  it("zero closed trades: every cell insufficient, nothing throws", () => {
    for (const ts of [[], fromR([1, 2], { isOpen: true }, 0)]) {
      const r = edgeClinic(ts, { today: TODAY });
      expect(r.closedTrades).toBe(0);
      expect(r.m).toBe(0);
      expect(r.cells.every((c) => c.grade === "insufficient")).toBe(true);
      expect(r.deflation).toBeNull();
      expect(r.cells[0].payoff).toBeNull();
      expect(r.cells[0].cost.costPerTrade).toBeNull();
    }
  });

  it("dayOf reads ISO and the 4.2.x DD-MM-YYYY form; garbage is null", () => {
    expect(dayOf("2026-03-04T10:00:00")).toBe("2026-03-04");
    expect(dayOf("04-03-2026")).toBe("2026-03-04");
    expect(dayOf("yesterday")).toBeNull();
    expect(dayOf(null)).toBeNull();
  });

  it("the two modules import nothing from lib/db, lib/queries, react or server-only", () => {
    for (const f of ["lib/analytics/edge-clinic.ts", "lib/analytics/edge-clinic-stats.ts"]) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b|\bfrom\s+["']/.test(l));
      expect(imports.length).toBeGreaterThan(0);
      for (const l of imports) {
        expect(l, `${f}: ${l}`).not.toMatch(/lib\/db|lib\/queries|["']react|server-only|["']\.\.?\/(db|queries)/);
      }
    }
  });
});

// ── v4.7.0 C2: setup grades, prefixed setup keys, cellTrades ─────────────────

describe("C2 — grade cells, the setup-key prefix and cellTrades", () => {
  /** The grid, with the real-edge setup graded A+ and setup B graded B; nothing graded A. */
  const graded = () =>
    gridBook().map((t) => ({ ...t, setupGrade: t.setupTag === "A" ? ("A+" as const) : t.setupTag === "B" ? ("B" as const) : null }));
  const g = edgeClinic(graded(), { today: TODAY });

  it("grade cells exist ONLY for the grades present, as whole-book cells, and they count in m (9 + 2 = 11)", () => {
    const grades = g.cells.filter((c) => c.kind === "grade");
    expect(grades.map((c) => c.key)).toEqual(["all|grade:A+", "all|grade:B"]);
    expect(grades.map((c) => c.setupGrade)).toEqual(["A+", "B"]);
    expect(grades.every((c) => c.segment === null && c.setup === null && c.cut === null)).toBe(true);
    expect(cell(g, "all|grade:A+").n).toBe(80);
    expect(cell(g, "all|grade:B").n).toBe(40);
    expect(g.m).toBe(11);
    expect(g.multiplicity.m).toBe(11);
    // The A+ cell holds exactly the real-edge rows, so it grades with them; B is a null.
    expect(cell(g, "all|grade:A+").grade).toBe("established");
    expect(cell(g, "all|grade:B").grade).toBe("unclear");
    expect(g.cells.filter((c) => c.kind !== "grade").every((c) => c.setupGrade === null)).toBe(true);
  });

  it("an ungraded book (null or absent) is C1's report exactly — no grade cell, the same m", () => {
    const nulls = edgeClinic(gridBook().map((t) => ({ ...t, setupGrade: null })), { today: TODAY });
    expect(nulls.cells.some((c) => c.kind === "grade")).toBe(false);
    expect(nulls.m).toBe(grid.m);
    expect(nulls.cells.map((c) => [c.key, c.grade, c.nWithR])).toEqual(grid.cells.map((c) => [c.key, c.grade, c.nWithR]));
  });

  it("a setup tagged literally 'all' gets its own cell — it no longer collides with the segment cell", () => {
    const ts = [
      ...fromR(exact(25, 0, 21), { segment: "eq_intraday", setupTag: "all" }, 0),
      ...fromR(exact(25, 0, 22), { segment: "eq_intraday", setupTag: "x" }, 30),
    ];
    const r = edgeClinic(ts, { today: TODAY });
    const keys = r.cells.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(cell(r, "eq_intraday|all").n).toBe(50);
    expect(cell(r, "eq_intraday|setup:all").n).toBe(25);
    expect(cell(r, "eq_intraday|setup:all").kind).toBe("setup");
  });

  it("cellTrades returns exactly the rows the engine put in each cell, in its chronological order", () => {
    const book = graded();
    for (const c of g.cells) expect(cellTrades(book, c.key).length, c.key).toBe(c.n);
    expect(cellTrades(book, "all|grade:A+").every((t) => t.setupTag === "A")).toBe(true);
    const a = cellTrades(book, "eq_intraday|setup:A").map((t) => t.id);
    expect(a).toEqual([...a].sort((x, y) => x - y)); // one per day in id order here
    expect(cellTrades(book, "eq_intraday|nope")).toEqual([]);
    // open rows never enter a cell
    const withOpen = [...book, trade({ isOpen: true, setupTag: "A", setupGrade: "A+" })];
    expect(cellTrades(withOpen, "all|grade:A+")).toHaveLength(80);
  });
});
