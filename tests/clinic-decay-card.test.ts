// v4.8.0 wave F1 — the Edge Clinic's decay card (owner-picked design "N1"): numbers
// first, then a small chart, in a cell's Detail directly under the engine's decay copy.
//
// What is pinned here (the engine's own `usual` / `recent` / `trace` arithmetic is pinned
// in tests/edge-clinic.test.ts and tests/edge-clinic-stats.test.ts):
//
//   1. the card's words and figures for an ALARMED and a QUIET cell — the quiet chip is
//      the engine's claim ("no drop detected"), nothing stronger; the loss colour only
//      on an alarmed cell;
//   2. the rupee line is there for a cell whose every R is a real risk and ABSENT —
//      no "₹" anywhere in the card — when ONE cap-unit row exists (invariant 6);
//   3. the static markup: the figures are real text, the chart wrapper carries the
//      aria-label, and the chart itself is NOT in the server markup (LazyMount);
//   4. the card sits under the decay copy block, above the sizing block, and only in a
//      cell that has a decay block;
//   5. a FREE copy's serialised state carries none of `trace` / `usual` / `recent`;
//   6. the chart's two series meet at the alarm trade, and it is recharts coloured ONLY
//      through the CSS custom properties (the print palette), never animated.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { edgeClinic, type ClinicCell, type ClinicReport, type ClinicTrade, type EdgeDecay } from "@/lib/analytics/edge-clinic";
import { clinicCardFor, clinicStateFor, type ClinicState } from "@/lib/analytics/edge-clinic-contract";
import { clinicCardSummary, teaser, weeklyNote } from "@/lib/analytics/edge-clinic-note";
import type { RProvenanceCounts } from "@/lib/analytics/win-loss";
import { HELP_ENTRIES } from "@/lib/domain/help-content";
import { DecayCard, decayCardModel, everyRIsARisk } from "@/components/edge-clinic/decay-card";
import { DecayChart, decayChartRows } from "@/components/edge-clinic/decay-chart";
import { DECAY_CHART_HEIGHT } from "@/components/edge-clinic/decay-chart-height";
import { CellsGrid } from "@/components/edge-clinic/clinic-report";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MINUS = "−";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALL_RISK: RProvenanceCounts = { plan: 40, typed: 80, cap: 0, unknown: 0, noR: 0 };

/** A decay block with the design's own figures (0.548 → 0.370); `alarmIndex` null = a quiet cell. */
function decayOf(over: { alarmIndex: number | null; usual?: number; recent?: number }): EdgeDecay {
  const alarmed = over.alarmIndex != null;
  const usual = over.usual ?? 0.548;
  const recent = over.recent ?? 0.37;
  return {
    cusum: { alarmIndex: over.alarmIndex, burnIn: 60, mu0: usual, sigma0: 1, k: 0.5, h: 4, maxS: alarmed ? 5 : 0.5 },
    trace: [[30, 0.6], [60, 0.55], [90, 0.45], [120, 0.3]],
    usual: { meanR: usual, n: 60 },
    recent: alarmed ? { meanR: recent, n: 120 - over.alarmIndex!, fromTrade: over.alarmIndex! + 1 } : { meanR: recent, n: 60, fromTrade: 61 },
    window: 30,
    verb: alarmed ? "test" : "none",
    copy: { headline: "H", detail: "D", provenanceLine: "P" },
  };
}
const ALARMED = decayOf({ alarmIndex: 64 });
const QUIET = decayOf({ alarmIndex: null });

const dayPlus = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
/** One closed trade per R, a day apart, ₹1,000 risked — a typed risk unless `capAt` names the row. */
function bookOf(rs: number[], capAt: number | null = null): ClinicTrade[] {
  return rs.map((r, i) => ({
    id: i + 1, segment: "eq_intraday", buyQty: 10, sellQty: 10, side: "long", buyDate: dayPlus(i), sellDate: dayPlus(i), entryTime: null, exitTime: null,
    isOpen: false, grossPnl: r * 1000 + 20, chargesTotal: 20, netPnl: r * 1000, rMultiple: r, riskAmount: 1000, riskSource: i === capAt ? "cap" : "set",
    rPlan: false, slPlanned: null, trailingSl: null, avgBuyPrice: 100, avgSellPrice: 100, setupTag: null, ruleViolations: null, entryDte: null, lotSize: null,
  }));
}
// μ0 = 0.5, σ0 = 1 over the first 60; five −1 then −2s → alarm at trade 65 (the arithmetic is in tests/edge-clinic.test.ts).
const usual60 = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1.5 : -0.5));
const ALARM_RS = [...usual60, ...Array(5).fill(-1), ...Array(55).fill(-2)];
const QUIET_RS = [...usual60, ...Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1.3 : -0.5))];
const report = (rs: number[], capAt: number | null = null): ClinicReport => edgeClinic(bookOf(rs, capAt), { today: "2026-10-05" });
const bookCell = (r: ClinicReport): ClinicCell => r.cells.find((c) => c.key === "all|all")!;

const card = (decay: EdgeDecay, provenance: RProvenanceCounts = ALL_RISK, rUnit: "R" | "cap" = "R") =>
  renderToStaticMarkup(React.createElement(DecayCard, { decay, provenance, rUnit }));

// ── 1. the model ────────────────────────────────────────────────────────────

describe("decayCardModel — the card's words are the engine's figures", () => {
  it("ALARMED: usual → recent since the alarm trade, the signed difference on the chip, the loss colour", () => {
    const m = decayCardModel(ALARMED, ALL_RISK, "R");
    expect(m).toMatchObject({
      alarmed: true,
      usualLabel: "USUAL · first 60 trades",
      usualValue: "+0.55R",
      recentLabel: "RECENT · since trade 65",
      recentValue: "+0.37R",
      recentIsLoss: true,
      chip: `${MINUS}0.18R a trade`,
      rupeeLine: "For every ₹1,000 risked: ₹548 → ₹370",
      note: "Each point is the average of 30 trades in a row. R = profit as a multiple of what you risked.",
    });
    expect(m.ariaLabel).toBe(
      "Average of 30 trades in a row, trade by trade. Usual +0.55R over the first 60 trades; recent +0.37R since trade 65, where a possible drop was flagged.",
    );
  });

  it("QUIET: recent is 'last n trades', the chip is the engine's claim — 'no drop detected' — and nothing takes the loss colour", () => {
    const m = decayCardModel(QUIET, ALL_RISK, "R");
    expect(m).toMatchObject({
      alarmed: false,
      usualLabel: "USUAL · first 60 trades",
      recentLabel: "RECENT · last 60 trades",
      recentValue: "+0.37R",
      recentIsLoss: false,
      chip: "no drop detected",
      rupeeLine: "For every ₹1,000 risked: ₹548 → ₹370",
    });
    expect(m.ariaLabel).toBe(
      "Average of 30 trades in a row, trade by trade. Usual +0.55R over the first 60 trades; recent +0.37R over the last 60 trades; no drop detected.",
    );
    // A quiet CUSUM says it has not alarmed. It does not say the cell is "normal".
    expect(JSON.stringify(m)).not.toMatch(/normal range|within the|stable|healthy|fine/i);
    // …even when the recent mean is far below the usual one: the colour and the chip follow the ENGINE's alarm, not a comparison made here.
    const low = decayCardModel(decayOf({ alarmIndex: null, recent: -0.9 }), ALL_RISK, "R");
    expect([low.recentIsLoss, low.chip]).toEqual([false, "no drop detected"]);
  });

  it("an alarmed cell whose mean since the alarm is NOT below the usual mean is not painted as a loss", () => {
    const m = decayCardModel(decayOf({ alarmIndex: 64, recent: 0.6 }), ALL_RISK, "R");
    expect([m.alarmed, m.recentIsLoss, m.chip]).toEqual([true, false, "+0.05R a trade"]);
  });

  it("a negative figure reads −₹203 (the minus sign, then the INR formatter), whole rupees", () => {
    const m = decayCardModel(decayOf({ alarmIndex: 64, usual: 0.5484, recent: -0.2034 }), ALL_RISK, "R");
    expect(m.rupeeLine).toBe(`For every ₹1,000 risked: ₹548 → ${MINUS}₹203`);
    expect(m.recentValue).toBe(`${MINUS}0.20R`);
    // Indian grouping comes from the formatter: 12.5 R at ₹1,000 is ₹12,500.
    expect(decayCardModel(decayOf({ alarmIndex: null, usual: 12.5, recent: 125 }), ALL_RISK, "R").rupeeLine).toBe("For every ₹1,000 risked: ₹12,500 → ₹1,25,000");
  });
});

// ── 2. the rupee line and its denominator (invariant 6) ─────────────────────

describe("the rupee line exists only where every R is a multiple of a real risk", () => {
  it("everyRIsARisk: plan-derived and typed rows only — one cap-unit or unclassified row, or no R at all, is not", () => {
    expect(everyRIsARisk(ALL_RISK)).toBe(true);
    expect(everyRIsARisk({ plan: 120, typed: 0, cap: 0, unknown: 0, noR: 7 })).toBe(true); // rows with no R are not in the figures
    expect(everyRIsARisk({ ...ALL_RISK, cap: 1 })).toBe(false);
    expect(everyRIsARisk({ ...ALL_RISK, unknown: 1 })).toBe(false);
    expect(everyRIsARisk({ plan: 0, typed: 0, cap: 0, unknown: 0, noR: 0 })).toBe(false);
  });

  it("PRESENT for an all-risk cell, alarmed or quiet", () => {
    for (const d of [ALARMED, QUIET]) {
      const out = card(d);
      expect(out).toContain('data-decay-rupees=""');
      expect(out).toContain("For every ₹1,000 risked: ₹548 → ₹370");
    }
  });

  it("ABSENT — no rupee line and no ₹ anywhere in the card — when ONE row is cap-unit R", () => {
    for (const d of [ALARMED, QUIET]) {
      const out = card(d, { ...ALL_RISK, typed: 79, cap: 1 });
      expect(out).not.toContain("data-decay-rupees");
      expect(out).not.toContain("₹");
      expect(out).not.toMatch(/risked:/);
      expect(out).toContain("+0.55R"); // the R figures are still there
    }
    expect(decayCardModel(ALARMED, { ...ALL_RISK, cap: 1 }, "R").rupeeLine).toBeNull();
  });

  it("through the engine: the same book with and without ONE cap-unit row", () => {
    const real = bookCell(report(ALARM_RS));
    expect(real.provenance).toMatchObject({ cap: 0, unknown: 0 });
    expect(card(real.decay!, real.provenance, real.rUnit)).toContain("For every ₹1,000 risked: ₹500 → ");
    const capped = bookCell(report(ALARM_RS, 7));
    expect(capped.provenance.cap).toBe(1);
    expect(capped.rUnit).toBe("R"); // one cap row does not make the cell cap-unit — the line must go on its own rule
    expect(capped.decay!.recent).toEqual(real.decay!.recent);
    const out = card(capped.decay!, capped.provenance, capped.rUnit);
    expect(out).not.toContain("₹");
    expect(out).not.toContain("data-decay-rupees");
  });

  it("a cell whose every R is cap-unit is labelled 'cap', never 'R', and says what the figures are", () => {
    const out = card(ALARMED, { plan: 0, typed: 0, cap: 120, unknown: 0, noR: 0 }, "cap");
    expect(out).toContain("+0.55 cap");
    expect(out).toContain("+0.37 cap");
    expect(out).not.toMatch(/\d\dR\b/);
    expect(out).not.toContain("₹");
    expect(out).toContain("These figures are P&amp;L in units of your per-trade cap, not of the risk you took.");
    expect(out).not.toContain("what you risked");
  });
});

// ── 3. the static markup ────────────────────────────────────────────────────

describe("DecayCard markup — figures as text, the chart named, nothing built while the Detail is closed", () => {
  it("ALARMED", () => {
    const out = card(ALARMED);
    expect(out).toContain('data-clinic-decay-card="" data-alarmed="true"');
    expect(out).toMatch(/data-decay-figure="usual"><p class="[^"]*">USUAL · first 60 trades<\/p><p class="(?![^"]*text-loss)[^"]*">\+0\.55R<\/p>/);
    expect(out).toMatch(/data-decay-figure="recent"><p class="[^"]*">RECENT · since trade 65<\/p><p class="[^"]*\btext-loss\b[^"]*">\+0\.37R<\/p>/);
    expect(out).toMatch(new RegExp(`data-decay-chip=""[^>]*>${MINUS}0\\.18R a trade<`));
    expect(out).toContain("→");
    expect(out).toContain('role="img"');
    expect(out).toContain(
      'aria-label="Average of 30 trades in a row, trade by trade. Usual +0.55R over the first 60 trades; recent +0.37R since trade 65, where a possible drop was flagged."',
    );
    expect(out).toContain("Each point is the average of 30 trades in a row. R = profit as a multiple of what you risked.");
  });

  it("QUIET — no loss colour anywhere in the card", () => {
    const out = card(QUIET);
    expect(out).toContain('data-clinic-decay-card="" data-alarmed="false"');
    expect(out).toMatch(/data-decay-figure="recent"><p class="[^"]*">RECENT · last 60 trades<\/p><p class="[^"]*">\+0\.37R<\/p>/);
    expect(out).toMatch(/data-decay-chip=""[^>]*>no drop detected</);
    expect(out).not.toMatch(/\b(text|border|bg)-loss\b/);
    expect(out).not.toMatch(/normal range/i);
    expect(out).toContain("recent +0.37R over the last 60 trades; no drop detected.");
  });

  it("the chart is mounted through LazyMount: a 64 px placeholder and NO svg in the server markup", () => {
    for (const d of [ALARMED, QUIET]) {
      const out = card(d);
      expect(DECAY_CHART_HEIGHT).toBe(64);
      expect(out).toMatch(/data-decay-chart=""><div style="min-height:64px"><\/div><\/div>/);
      expect(out).not.toContain("<svg");
      expect(out).not.toContain("recharts");
    }
    const src = read("components/edge-clinic/decay-card.tsx");
    expect(src).toMatch(/<LazyMount minHeight=\{DECAY_CHART_HEIGHT\}>\s*<DecayChart /);
    expect(src).not.toMatch(/^"use client"/); // the figures are server-rendered text
  });
});

// ── 4. where the card sits ──────────────────────────────────────────────────

describe("the Detail: the card directly under the decay copy block, only where there is one", () => {
  it("decay copy → decay card → sizing copy, in that order, for the alarmed and the quiet book", () => {
    for (const [rs, alarmed] of [[ALARM_RS, true], [QUIET_RS, false]] as const) {
      const r = report(rs);
      const c = bookCell(r);
      const out = renderToStaticMarkup(React.createElement(CellsGrid, { report: r }));
      const row = out.slice(out.indexOf('data-cell-key="all|all"'));
      const copyAt = row.indexOf(c.decay!.copy.headline);
      const cardAt = row.indexOf("data-clinic-decay-card");
      const sizingAt = row.indexOf(c.sizing!.copy.headline.replace(/&/g, "&amp;"));
      expect(copyAt, "the decay copy block is kept").toBeGreaterThan(-1);
      expect(cardAt).toBeGreaterThan(copyAt);
      expect(sizingAt).toBeGreaterThan(cardAt);
      expect(row).toContain(`data-alarmed="${alarmed}"`);
      // The copy block is the engine's, unchanged, and the card names the same trade.
      expect(row).toContain(c.decay!.copy.detail);
      if (alarmed) expect(row).toContain(`RECENT · since trade ${c.decay!.cusum.alarmIndex! + 1}`);
      else expect(row).toContain(`RECENT · last ${c.decay!.recent.n} trades`);
      // Inside the closed <details>.
      expect(row.lastIndexOf("<details", cardAt)).toBeGreaterThan(-1);
      expect(row.lastIndexOf("</details>", cardAt)).toBe(-1);
    }
  });

  it("a cell with no decay block (fewer than 60 trades with an R) has no card", () => {
    const r = report(ALARM_RS.slice(0, 50));
    expect(bookCell(r).decay).toBeNull();
    const out = renderToStaticMarkup(React.createElement(CellsGrid, { report: r }));
    expect(out).toContain('data-cell-key="all|all"');
    expect(out).not.toContain("data-clinic-decay-card");
  });
});

// ── 5. the free wire ────────────────────────────────────────────────────────

describe("a FREE copy never receives trace / usual / recent", () => {
  const r = report(ALARM_RS);
  const state = (): ClinicState => ({
    status: "fresh",
    scopeKey: "acct:1",
    digest: "d1",
    computedAt: "2026-10-05T10:00:00.000Z",
    report: r,
    teaser: teaser(r),
    note: weeklyNote(r, []),
    experiments: [],
    canStartExperiment: true,
  });
  const KEYS = [/"trace":/, /"usual":/, /"recent":/, /"fromTrade":/, /"cusum":/];

  it("the Pro state carries them (the scan below is alive)", () => {
    const wire = JSON.stringify(clinicStateFor(state(), true));
    for (const k of KEYS) expect(wire, String(k)).toMatch(k);
  });

  it("clinicStateFor(…, pro:false): the serialised props carry none of them — the teaser still does its job", () => {
    const free = clinicStateFor(state(), false);
    const wire = JSON.stringify(free);
    for (const k of KEYS) expect(wire, String(k)).not.toMatch(k);
    expect(free.report).toBeNull();
    expect(free.teaser).toEqual(teaser(r));
  });

  it("the Arjun's Eye card summary (P2) never carried the decay block, Pro or free", () => {
    const summary = clinicCardSummary(r, "2026-10-05T10:00:00.000Z");
    for (const pro of [true, false]) {
      const wire = JSON.stringify(clinicCardFor({ hasReport: true, computedAt: summary.computedAt, finding: summary.finding, teaser: summary.teaser }, pro));
      for (const k of KEYS) expect(wire, String(k)).not.toMatch(k);
    }
  });

  it("the card is rendered by the report's cells grid only — the one surface behind the Pro cut", () => {
    const users = ["components", "app"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /<DecayCard\b|<DecayChart\b/.test(fs.readFileSync(f, "utf8")));
    expect(users.map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort()).toEqual([
      "components/edge-clinic/clinic-report.tsx",
      "components/edge-clinic/decay-card.tsx",
    ]);
  });
});

describe("Help — the Clinic entry describes the card that shipped", () => {
  const entry = HELP_ENTRIES.find((e) => e.href === "/reports/edge-clinic?tab=clinic")!;
  const text = entry.body.join(" ");

  it("names the card, its two figures, the rolling line and the rule the rupee line follows — in the card's own numbers", () => {
    expect(text).toContain("shows a decay card in its Detail");
    expect(text).toMatch(/at least 60 trades carrying an R/); // 2 × the window: the engine's own floor
    expect(edgeClinic(bookOf(ALARM_RS.slice(0, 59)), { today: "2026-10-05" }).cells[0].decay).toBeNull();
    expect(edgeClinic(bookOf(ALARM_RS.slice(0, 60)), { today: "2026-10-05" }).cells[0].decay).not.toBeNull();
    expect(text).toContain(`${ALARMED.window}-trade rolling average`);
    expect(text).toContain("for every ₹1,000 risked appears only when every trade in the cell has a stop or a typed risk");
    expect(text).toContain("when no drop is detected");
  });

  it("claims no outcome and prescribes nothing", () => {
    const added = entry.body.find((p) => p.includes("decay card"))!;
    expect(added).not.toMatch(/\b(recommend\w*|suggest\w*|advice|advise[sd]?|should|consider\w*|guaranteed?|will (improve|recover|make)|would have|normal range)\b/i);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── 6. the chart ────────────────────────────────────────────────────────────

describe("decayChartRows — one series when quiet, two that MEET at the alarm trade", () => {
  const trace: [number, number][] = [[30, 0.6], [60, 0.5], [90, 0.2], [120, -0.4]];

  it("quiet (no split): every point on the one series", () => {
    expect(decayChartRows(trace, null)).toEqual([
      { t: 30, usual: 0.6, recent: null },
      { t: 60, usual: 0.5, recent: null },
      { t: 90, usual: 0.2, recent: null },
      { t: 120, usual: -0.4, recent: null },
    ]);
  });

  it("a trace point AT the alarm trade belongs to both series; no row is added", () => {
    expect(decayChartRows(trace, 90)).toEqual([
      { t: 30, usual: 0.6, recent: null },
      { t: 60, usual: 0.5, recent: null },
      { t: 90, usual: 0.2, recent: 0.2 },
      { t: 120, usual: null, recent: -0.4 },
    ]);
  });

  it("no trace point at the alarm trade: ONE joining row there, on the straight segment between its neighbours", () => {
    const rows = decayChartRows(trace, 70); // a third of the way from (60, 0.5) to (90, 0.2)
    expect(rows.map((r) => r.t)).toEqual([30, 60, 70, 90, 120]);
    expect(rows[2].usual).toBeCloseTo(0.4, 12);
    expect(rows[2].recent).toBe(rows[2].usual);
    expect(rows[1]).toEqual({ t: 60, usual: 0.5, recent: null });
    expect(rows[3]).toEqual({ t: 90, usual: null, recent: 0.2 });
    // Every ORIGINAL point is still there, unchanged, on exactly one side.
    for (const [t, m] of trace) expect(rows.find((r) => r.t === t)).toEqual(t < 70 ? { t, usual: m, recent: null } : { t, usual: null, recent: m });
  });

  it("the alarm at the very last trade: the recent series is that one point", () => {
    const rows = decayChartRows(trace, 120);
    expect(rows[3]).toEqual({ t: 120, usual: -0.4, recent: -0.4 });
    expect(rows.filter((r) => r.recent != null)).toHaveLength(1);
  });

  it("an engine trace splits at the engine's alarm trade with nothing lost", () => {
    const d = bookCell(report(ALARM_RS)).decay!;
    const rows = decayChartRows(d.trace, d.recent.fromTrade);
    expect(rows.filter((r) => r.usual != null && r.recent != null).map((r) => r.t)).toEqual([d.recent.fromTrade]);
    expect(rows.length).toBe(d.trace.length + (d.trace.some(([t]) => t === d.recent.fromTrade) ? 0 : 1));
  });
});

describe("the chart source — recharts, the print palette's custom properties, never animated", () => {
  const src = read("components/edge-clinic/decay-chart.tsx");

  it("is a client recharts chart (it prints — not lightweight-charts), 64 px, no visible axis", () => {
    expect(src).toMatch(/^"use client";/);
    expect(src).toMatch(/from "recharts"/);
    expect(src).not.toMatch(/lightweight-charts/);
    // The height lives in a plain module: a VALUE imported from this "use client" file
    // into the server-rendered card would be a throwing client reference.
    expect(read("components/edge-clinic/decay-chart-height.ts")).toMatch(/DECAY_CHART_HEIGHT = 64\b/);
    expect(src).not.toMatch(/export const DECAY_CHART_HEIGHT/);
    expect(src).toMatch(/<ResponsiveContainer width="100%" height=\{DECAY_CHART_HEIGHT\}>/);
    expect((src.match(/<XAxis [^>]*\bhide\b/g) ?? []).length).toBe(1);
    expect((src.match(/<YAxis [^>]*\bhide\b/g) ?? []).length).toBe(1);
  });

  it("every stroke / fill is a CSS custom property (or none): the four the design names, and no literal colour", () => {
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    const colours = [...code.matchAll(/\b(?:stroke|fill)=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => m[1] ?? m[2]);
    expect(colours.length).toBeGreaterThanOrEqual(6);
    for (const c of colours) expect(c, c).toMatch(/^(none|var\(--color-(primary|loss|muted|warning)\)|splitAt != null \? "var\(--color-loss\)" : "var\(--color-primary\)")$/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(|color-mix\(/);
    // The design's four roles.
    expect(code).toMatch(/<Line [^>]*dataKey="usual" stroke="var\(--color-primary\)"/);
    expect(code).toMatch(/<Line [^>]*dataKey="recent" stroke="var\(--color-loss\)"/);
    expect(code).toMatch(/<ReferenceLine y=\{usualMean\} stroke="var\(--color-muted\)" strokeDasharray=/);
    expect(code).toMatch(/<ReferenceLine x=\{splitAt\} stroke="var\(--color-warning\)" strokeDasharray=/);
    expect(code).toMatch(/<ReferenceDot x=\{last\[0\]\} y=\{last\[1\]\}/);
  });

  it("no series animates, and the alarm marker and the loss stretch are drawn only when the engine alarmed", () => {
    const lines = src.match(/<Line [^>]*>/g) ?? [];
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toContain("isAnimationActive={false}");
    expect(src).toMatch(/\{splitAt != null \? <ReferenceLine x=\{splitAt\}/);
    expect(src).toMatch(/\{splitAt != null \? \(\s*<Line [^>]*dataKey="recent"/);
    // …and the card hands it the alarm trade only for an alarmed cell.
    expect(read("components/edge-clinic/decay-card.tsx")).toContain("splitAt={m.alarmed ? decay.recent.fromTrade : null}");
  });

  it("renders on the server without throwing (ResponsiveContainer draws nothing until it is measured)", () => {
    expect(() => renderToStaticMarkup(React.createElement(DecayChart, { trace: ALARMED.trace, usualMean: 0.548, splitAt: 65 }))).not.toThrow();
    expect(() => renderToStaticMarkup(React.createElement(DecayChart, { trace: [], usualMean: 0.548, splitAt: null }))).not.toThrow();
  });
});
