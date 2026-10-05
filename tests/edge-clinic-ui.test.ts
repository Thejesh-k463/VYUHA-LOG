import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CLINIC_CARD_MISSING, clinicCardFor, clinicStateFor, type ClinicCard, type ClinicState } from "@/lib/analytics/edge-clinic-contract";
import type { ClinicReport } from "@/lib/analytics/edge-clinic";
import { ArjunClinicCard } from "@/components/edge-clinic/arjun-clinic-card";
import { ClinicCopyBlock, ageLabel, fmtR } from "@/components/edge-clinic/clinic-copy";
import { ClinicTeaserCard } from "@/components/edge-clinic/teaser-card";

/**
 * v4.7.0 C2, the UI half (builder B). Three things a reviewer cannot see on the
 * screen and a regression would not announce:
 *
 *   1. a FREE copy's Clinic state carries the teaser and the status only — the
 *      report, the weekly note and the experiments never reach its payload
 *      (design review change 5; the page cuts with `clinicStateFor`);
 *   2. no Clinic surface states a counterfactual rupee ("would have …"), and
 *      no page, tab or component runs the engine — the compute route is the
 *      ONLY caller (design D3: computed off the page render);
 *   3. the imperative treatment appears only where the engine's verb says so.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const MARK = {
  report: "REPORT-ONLY-MARKER-7f3a",
  note: "NOTE-ONLY-MARKER-91c2",
  experiment: "EXPERIMENT-ONLY-MARKER-4d8e",
  teaser: "TEASER-HEADLINE-b6e0",
};

/** A full (Pro) state. The report is a stand-in: only its presence and its marker matter here. */
function fullState(): ClinicState {
  return {
    status: "fresh",
    scopeKey: "acct:1",
    digest: "d1",
    computedAt: "2026-10-03T10:00:00.000Z",
    report: { provenanceLine: MARK.report } as unknown as ClinicReport,
    teaser: { grade: "unclear", headline: MARK.teaser, tradesStillNeeded: 12, closedTrades: 18, provenanceLine: "R from your stops on 18 of 18." },
    note: {
      weekOf: "2026-09-28",
      findings: [
        { key: "all|all", label: "Whole book", grade: "likely", verb: "test", headline: MARK.note, detail: "d", provenanceLine: "p", experiment: { hypothesis: "h", targetN: 20 } },
      ],
    },
    experiments: [
      {
        id: 1, accountId: 1, cellKey: "all|all", cellLabel: "Whole book", hypothesis: MARK.experiment, startedAt: "2026-09-01",
        targetN: 20, status: "open", progressN: 3, baseline: null, result: null, checkedAt: null, verb: "test", copy: null,
      },
    ],
    canStartExperiment: true,
  };
}

describe("clinicStateFor — what a free copy may receive", () => {
  it("free: report, note and experiments are cut; the teaser, status, digest and computedAt survive", () => {
    const free = clinicStateFor(fullState(), false);
    expect(free.report).toBeNull();
    expect(free.note).toBeNull();
    expect(free.experiments).toEqual([]);
    expect(free.canStartExperiment).toBe(false);
    expect(free.teaser?.headline).toBe(MARK.teaser);
    expect([free.status, free.digest, free.computedAt]).toEqual(["fresh", "d1", "2026-10-03T10:00:00.000Z"]);
    // The serialised payload — what an RSC prop would carry — names none of the Pro values.
    const wire = JSON.stringify(free);
    for (const m of [MARK.report, MARK.note, MARK.experiment]) expect(wire, m).not.toContain(m);
    expect(wire).toContain(MARK.teaser);
  });

  it("Pro: the state passes through unchanged", () => {
    const s = fullState();
    expect(clinicStateFor(s, true)).toBe(s);
  });

  it("the hub page hands state to components ONLY through clinicStateFor(…, getEntitlement().pro)", () => {
    for (const rel of ["app/reports/edge-clinic/page.tsx"]) {
      const src = read(rel);
      const reads = src.match(/getClinicState\(\)/g) ?? [];
      const cut = src.match(/clinicStateFor\(getClinicState\(\), getEntitlement\(\)\.pro\)/g) ?? [];
      expect(reads.length, `${rel} reads the clinic state`).toBeGreaterThan(0);
      expect(cut.length, `${rel}: every getClinicState() read is cut by the entitlement`).toBe(reads.length);
    }
  });

  // v4.8.0 P2: Arjun's Eye no longer reads the whole state (a second book projection, a digest and a parse of the
  // full cached report, to print one finding) — it reads the stored card summary, cut by the SAME entitlement.
  it("Arjun's Eye reads ONLY the card summary, and hands it to the card ONLY through clinicCardFor(…, getEntitlement().pro)", () => {
    const src = read("app/arjuns-eye/page.tsx");
    const reads = src.match(/getClinicCard\(\)/g) ?? [];
    const cut = src.match(/<ArjunClinicCard card=\{clinicCardFor\(getClinicCard\(\), getEntitlement\(\)\.pro\)\} \/>/g) ?? [];
    expect(reads.length, "the page reads the clinic card").toBeGreaterThan(0);
    expect(cut.length, "every getClinicCard() read is cut by the entitlement").toBe(reads.length);
    expect(src, "the whole-state read is back on the page").not.toMatch(/getClinicState|clinicInputs|clinicStateFor/);
  });
});

describe("clinicCardFor — what a free copy's Arjun's Eye card may receive (v4.8.0 P2)", () => {
  const TEASER = fullState().teaser!;
  /** The Pro card of `fullState()`: its note's first finding, as the summary stores it. */
  function fullCard(): ClinicCard {
    const f = fullState().note!.findings[0];
    return {
      hasReport: true,
      computedAt: "2026-10-03T10:00:00.000Z",
      finding: { label: f.label, grade: f.grade, verb: f.verb, headline: f.headline, provenanceLine: f.provenanceLine },
      teaser: TEASER,
    };
  }
  const render = (card: ClinicCard) => renderToStaticMarkup(React.createElement(ArjunClinicCard, { card }));

  it("free: the finding and the report flag are cut — exactly what clinicStateFor withholds; the teaser and computedAt survive", () => {
    const free = clinicCardFor(fullCard(), false);
    expect(free).toEqual({ hasReport: false, computedAt: "2026-10-03T10:00:00.000Z", finding: null, teaser: TEASER });
    // The same cut, read off the v4.7.0 state: note → no finding, report → no flag.
    const freeState = clinicStateFor(fullState(), false);
    expect({ hasReport: freeState.report != null, finding: freeState.note?.findings[0] ?? null, teaser: freeState.teaser }).toEqual({
      hasReport: free.hasReport,
      finding: free.finding,
      teaser: free.teaser,
    });
    const wire = JSON.stringify(free);
    expect(wire).not.toContain(MARK.note);
    expect(wire).toContain(MARK.teaser);
    const out = render(free);
    expect(out).not.toContain(MARK.note);
    expect(out).not.toContain("data-grade=");
    expect(out).not.toContain("No finding in your book"); // that sentence states a report exists — Pro only
    expect(out).not.toContain("has not read this book"); // seam D3: the book HAS been read
    expect(out).toContain(MARK.teaser);
  });

  it("Pro: the card passes through unchanged and prints the finding, not the teaser", () => {
    const c = fullCard();
    expect(clinicCardFor(c, true)).toBe(c);
    const out = render(c);
    expect(out).toContain(MARK.note);
    expect(out).toContain('data-grade="likely"');
    expect(out).toContain('data-verb="test"');
    expect(out).not.toContain(MARK.teaser);
  });

  it("no finding: Pro reads 'no finding this week', a free copy reads the teaser; nothing cached reads 'has not read this book yet'", () => {
    const none: ClinicCard = { ...fullCard(), finding: null };
    expect(render(none)).toContain("No finding in your book is past the evidence bar this week.");
    expect(render(clinicCardFor(none, false))).toContain(MARK.teaser);
    for (const pro of [true, false]) expect(render(clinicCardFor(CLINIC_CARD_MISSING, pro))).toContain("The Clinic has not read this book yet.");
  });
});

/** Every .ts/.tsx under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("source scans", () => {
  const clinicUi = [...walk(path.join(ROOT, "components/edge-clinic")), path.join(ROOT, "app/reports/edge-clinic/_tabs/clinic.tsx")];

  it("the Clinic UI exists where the scan looks (a scan over nothing proves nothing)", () => {
    expect(clinicUi.length).toBeGreaterThanOrEqual(6);
    for (const f of clinicUi) expect(fs.existsSync(f), f).toBe(true);
  });

  it("no Clinic surface states a counterfactual: no 'would have', 'could have made' or 'missed out'", () => {
    const bad = clinicUi.filter((f) => /would have|could have made|missed out/i.test(fs.readFileSync(f, "utf8")));
    expect(bad.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("no page, tab or component runs the engine — edgeClinic( / computeClinic( live behind the compute route only", () => {
    const appFiles = walk(path.join(ROOT, "app")).filter((f) => !f.split(path.sep).includes("api"));
    const files = [...appFiles, ...walk(path.join(ROOT, "components"))];
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => /\b(?:edgeClinic|computeClinic)\s*\(/.test(fs.readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
    // …and the one caller is still where the design puts it.
    expect(read("app/api/edge-clinic/compute/route.ts")).toMatch(/computeClinic\(\)/);
  });

  it("the runner POSTs the compute route and refreshes; it never polls", () => {
    const src = read("components/edge-clinic/clinic-runner.tsx");
    expect(src).toContain('"/api/edge-clinic/compute"');
    expect(src).toContain('method: "POST"');
    expect(src).toContain("router.refresh()");
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });
});

describe("rendering — the engine's words, the engine's verb", () => {
  const html = (verb: "imperative" | "test" | "none") =>
    renderToStaticMarkup(React.createElement(ClinicCopyBlock, { verb, headline: "H", detail: "D", provenanceLine: "P" }));

  it("the imperative treatment appears ONLY on verb === 'imperative'", () => {
    expect(html("imperative")).toContain("border-l-2");
    expect(html("test")).not.toContain("border-l-2");
    expect(html("none")).not.toContain("border-l-2");
    for (const v of ["imperative", "test", "none"] as const) expect(html(v)).toContain(`data-verb="${v}"`);
  });

  it("the teaser card renders the engine's headline and provenance unchanged, and how many trades are still needed", () => {
    const out = renderToStaticMarkup(React.createElement(ClinicTeaserCard, { teaser: fullState().teaser }));
    expect(out).toContain(MARK.teaser);
    expect(out).toContain("R from your stops on 18 of 18.");
    expect(out).toContain("12 more trades");
    expect(out).toContain('data-grade="unclear"');
    const none = renderToStaticMarkup(React.createElement(ClinicTeaserCard, { teaser: null }));
    expect(none).toContain("has not read this book yet");
  });

  it("fmtR signs and dashes; ageLabel is pure on the clock it is handed", () => {
    expect([fmtR(0.4249), fmtR(-0.18), fmtR(null), fmtR(Number.NaN)]).toEqual(["+0.42", "−0.18", "—", "—"]);
    const t0 = Date.parse("2026-10-03T10:00:00.000Z");
    expect(ageLabel("2026-10-03T10:00:00.000Z", t0 + 20_000)).toBe("under a minute");
    expect(ageLabel("2026-10-03T10:00:00.000Z", t0 + 12 * 60_000)).toBe("12 min");
    expect(ageLabel("2026-10-03T10:00:00.000Z", t0 + 3 * 3_600_000)).toBe("3 h");
    expect(ageLabel("2026-10-03T10:00:00.000Z", t0 + 72 * 3_600_000)).toBe("3 days");
    expect(ageLabel(null, t0)).toBeNull();
    expect(ageLabel("garbage", t0)).toBeNull();
  });
});
