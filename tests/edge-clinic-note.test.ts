// v4.7.0 C2 — lib/analytics/edge-clinic-note.ts: the weekly note, the free teaser
// and the experiment check (design D5 + review change 4). Pure; no DB.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { edgeClinic, type ClinicTrade, type ClinicReport } from "@/lib/analytics/edge-clinic";
import {
  checkExperiment,
  findCell,
  isoMonday,
  proposalFor,
  teaser,
  weeklyNote,
  WEEKLY_NOTE_CAP,
  type StoredExperiment,
} from "@/lib/analytics/edge-clinic-note";
import { EXPERIMENT_TARGET_N, clinicStateFor, type ClinicState } from "@/lib/analytics/edge-clinic-contract";
import { mulberry32 } from "@/lib/analytics/monte-carlo";
import { mean } from "@/lib/analytics/edge-clinic-stats";

const TODAY = "2026-10-01"; // a Thursday

let nextId = 1;
function trade(p: Partial<ClinicTrade>): ClinicTrade {
  return {
    id: nextId++, segment: "eq_intraday", buyQty: 10, sellQty: 10, side: "long",
    buyDate: "2026-01-05", sellDate: "2026-01-05", entryTime: null, exitTime: null, isOpen: false,
    grossPnl: 0, chargesTotal: 20, netPnl: 0, rMultiple: 0, riskAmount: 1000, riskSource: "set", rPlan: false,
    slPlanned: null, trailingSl: null, avgBuyPrice: 100, avgSellPrice: 100, setupTag: null, setupGrade: null,
    ruleViolations: null, entryDte: null, lotSize: null, ...p,
  };
}
const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
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
  return z.map((x) => (x - m) / sd + mu);
}
function fromR(rs: number[], base: Partial<ClinicTrade>, startDay: number): ClinicTrade[] {
  return rs.map((r, i) => trade({ ...base, rMultiple: r, netPnl: r * 1000, grossPnl: r * 1000 + 20, buyDate: dayPlus(startDay + i), sellDate: dayPlus(startDay + i) }));
}
/** Every string anywhere in a value. */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}
const COUNTERFACTUAL = /would have|could have made|missed out/i;

/** A real edge (A, established), a likely one (L), three nulls, and an after-loss behaviour gap. */
function book(): ClinicTrade[] {
  const ts: ClinicTrade[] = [];
  let day = 0;
  const add = (rs: number[], base: Partial<ClinicTrade>) => { ts.push(...fromR(rs, base, day)); day += rs.length; };
  add(exact(80, 0.5, 11), { setupTag: "A" });
  add(exact(40, 0.38, 31), { segment: "eq_delivery", setupTag: "L" });
  add(exact(40, 0, 12), { setupTag: "B" });
  add(exact(40, 0, 13), { segment: "eq_delivery", setupTag: "D" });
  return ts;
}
const report = edgeClinic(book(), { today: TODAY });

describe("weeklyNote", () => {
  const note = weeklyNote(report, []);

  it("weekOf is the ISO Monday of asOf; at most three findings", () => {
    expect(note.weekOf).toBe("2026-09-28");
    expect(isoMonday("2026-09-28")).toBe("2026-09-28");
    expect(isoMonday("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(note.findings.length).toBeLessThanOrEqual(WEEKLY_NOTE_CAP);
    expect(note.findings.length).toBeGreaterThan(0);
  });

  it("established before likely, then |mean R| × √n; only likely / established reach the note", () => {
    const grades = note.findings.map((f) => f.grade);
    for (const g of grades) expect(["likely", "established"]).toContain(g);
    const firstLikely = grades.indexOf("likely");
    if (firstLikely >= 0) expect(grades.slice(firstLikely).every((g) => g === "likely")).toBe(true);
    expect(note.findings[0].grade).toBe("established");
    const est = note.findings.filter((f) => f.grade === "established").map((f) => findCell(report, f.key)!);
    const w = est.map((c) => Math.abs(c.meanR!) * Math.sqrt(c.nWithR));
    expect(w).toEqual([...w].sort((a, b) => b - a));
  });

  it("each cell finding renders the engine's own verb and copy, and proposes ONE experiment", () => {
    for (const f of note.findings) {
      const c = findCell(report, f.key)!;
      expect(f.verb).toBe(c.verb);
      expect(f.headline).toBe(c.copy.headline);
      expect(f.experiment).toEqual(proposalFor(c));
      expect(f.experiment!.targetN).toBe(EXPERIMENT_TARGET_N);
    }
  });

  it("a key with an OPEN experiment keeps its finding but proposes nothing", () => {
    const k = note.findings[0].key;
    const again = weeklyNote(report, new Set([k]));
    const f = again.findings.find((x) => x.key === k)!;
    expect(f).toBeDefined();
    expect(f.experiment).toBeNull();
  });

  it("a likely behaviour gap is a finding with experiment null (gaps are not cells)", () => {
    // Force a likely gap: copy the report and grade one check likely.
    const r: ClinicReport = JSON.parse(JSON.stringify(report));
    const g = r.behaviour[0].checks[0];
    g.grade = "likely";
    g.gap = 9; // outranks every cell's weight among the likely
    r.cells = r.cells.filter((c) => c.grade !== "established");
    r.fno = [];
    const n = weeklyNote(r, []);
    const gap = n.findings.find((f) => f.key === `gap:${r.behaviour[0].segment}|${g.id}`)!;
    expect(gap).toBeDefined();
    expect(gap.experiment).toBeNull();
  });

  it("no counterfactual phrasing anywhere in the note", () => {
    for (const s of allStrings(note)) expect(s).not.toMatch(COUNTERFACTUAL);
  });
});

describe("teaser — the ONE free card", () => {
  it("is the whole-book cell: grade, headline, provenance, closed trades", () => {
    const t = teaser(report)!;
    const b = findCell(report, "all|all")!;
    expect(t).toMatchObject({ grade: b.grade, headline: b.copy.headline, provenanceLine: b.copy.provenanceLine, closedTrades: 200 });
    expect(t.tradesStillNeeded).toBe(b.tradesStillNeeded! > 0 ? b.tradesStillNeeded : null);
  });

  it("below the minimum sample it states how many trades are still needed to grade the book", () => {
    const small = edgeClinic(fromR([1, -1, 0.5, 0.2, -0.4], {}, 0), { today: TODAY });
    const t = teaser(small)!;
    expect(t.grade).toBe("insufficient");
    expect(t.tradesStillNeeded).toBe(15); // minN 20 − 5
  });

  it("clinicStateFor(pro=false) strips report, note and experiments and keeps the teaser", () => {
    const state: ClinicState = {
      status: "fresh", scopeKey: "acct:1", digest: "d", computedAt: "x", report, teaser: teaser(report),
      note: weeklyNote(report, []), experiments: [], canStartExperiment: true,
    };
    const free = clinicStateFor(state, false);
    expect(free.report).toBeNull();
    expect(free.note).toBeNull();
    expect(free.canStartExperiment).toBe(false);
    expect(free.teaser).toEqual(state.teaser);
    expect(clinicStateFor(state, true)).toBe(state);
  });
});

describe("checkExperiment — baseline and result from ONE array", () => {
  const START = "2026-03-01";
  const exp = (over: Partial<StoredExperiment> = {}): StoredExperiment => ({
    id: 1, accountId: 1, cellKey: "eq_intraday|setup:S", cellLabel: "Intraday · S", hypothesis: "S: the next 20 average above 0 R.",
    startedAt: START, targetN: 20, status: "open", checkedAt: null, ...over,
  });
  const before = fromR(exact(30, 0.3, 41), { setupTag: "S" }, 380); // 2026-01-16 … 2026-02-14
  const afterDays = (n: number) => fromR(exact(n, 0.1, 42), { setupTag: "S" }, 425); // 2026-03-02 …
  const other = fromR([5, 5, 5], { setupTag: "OTHER" }, 430);

  it("open: progress counts R-bearing cell trades exiting on/after startedAt; baseline = those before", () => {
    const after = afterDays(12);
    const noR = trade({ setupTag: "S", rMultiple: null, sellDate: "2026-03-10", buyDate: "2026-03-10" });
    const e = checkExperiment([...before, ...after, ...other, noR], exp(), TODAY);
    expect(e.status).toBe("open");
    expect(e.progressN).toBe(12);
    expect(e.baseline!.n).toBe(30);
    expect(e.baseline!.meanR).toBeCloseTo(0.3, 10);
    expect(e.result).toBeNull();
    expect(e.verb).toBe("test");
  });

  it("at targetN it reads checked: mean R + t-interval over the FIRST targetN, checkedAt today", () => {
    const after = afterDays(25);
    const e = checkExperiment([...before, ...after], exp(), TODAY);
    expect(e.status).toBe("checked");
    expect(e.checkedAt).toBe(TODAY);
    expect(e.progressN).toBe(25);
    const first = after.slice(0, 20).map((t) => t.rMultiple as number);
    expect(e.result!.n).toBe(20);
    expect(e.result!.meanR).toBeCloseTo(mean(first), 12);
    expect(e.result!.lo!).toBeLessThan(e.result!.meanR!);
    expect(e.result!.hi!).toBeGreaterThan(e.result!.meanR!);
    expect(e.verb).not.toBe("imperative");
    expect(e.copy!.detail).toMatch(/One pre-registered comparison/);
  });

  it("ONE unit: rescaling every R (a risk-cap reprice) moves baseline AND result by the same factor", () => {
    const all = [...before, ...afterDays(20)];
    const a = checkExperiment(all, exp(), TODAY);
    const repriced = all.map((t) => ({ ...t, rMultiple: (t.rMultiple as number) * 0.5, riskSource: "cap" }));
    const b = checkExperiment(repriced, exp(), TODAY);
    expect(b.baseline!.meanR!).toBeCloseTo(a.baseline!.meanR! * 0.5, 12);
    expect(b.result!.meanR!).toBeCloseTo(a.result!.meanR! * 0.5, 12);
    expect(b.result!.provenanceLine).toMatch(/20 default-cap/);
  });

  it("abandoned stays abandoned (verb none) however many trades arrive; a stored checkedAt is kept", () => {
    const e = checkExperiment([...before, ...afterDays(25)], exp({ status: "abandoned" }), TODAY);
    expect(e.status).toBe("abandoned");
    expect(e.verb).toBe("none");
    expect(e.result).toBeNull();
    const c = checkExperiment([...before, ...afterDays(25)], exp({ status: "checked", checkedAt: "2026-04-01" }), TODAY);
    expect(c.checkedAt).toBe("2026-04-01");
  });

  it("a short exits on its buy-back: the split reads the exit, not the sell date", () => {
    const short = trade({ setupTag: "S", side: "short", rMultiple: 1, sellDate: "2026-02-20", buyDate: "2026-03-05" });
    const e = checkExperiment([short], exp(), TODAY);
    expect(e.progressN).toBe(1);
    expect(e.baseline!.n).toBe(0);
  });

  it("no counterfactual phrasing in any experiment copy", () => {
    for (const st of ["open", "checked", "abandoned"] as const) {
      const e = checkExperiment([...before, ...afterDays(22)], exp({ status: st }), TODAY);
      for (const s of allStrings(e)) expect(s).not.toMatch(COUNTERFACTUAL);
    }
  });
});

describe("purity", () => {
  it("edge-clinic-note.ts imports nothing from lib/db, lib/queries, react or server-only", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "lib/analytics/edge-clinic-note.ts"), "utf8");
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\b|\bfrom\s+["']/.test(l));
    for (const l of imports) expect(l).not.toMatch(/lib\/db|lib\/queries|["']react|server-only/);
  });
});
