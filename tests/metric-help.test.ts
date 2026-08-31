import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  METRIC_HELP,
  METRIC_HELP_IDS,
  metricCaveatLine,
  metricDetail,
  metricGlossary,
  type MetricHelpId,
} from "@/lib/domain/metric-help";

/**
 * Drift test in the help-content.ts style: the registry describes the KPIs the
 * pages actually render, in both directions. The pages call the adapters with
 * LITERAL ids (`metricDetail("sharpe", …)`, `metricGlossary([…])`,
 * `metricCaveatLine("replayEod")`, `also: […]`), so parsing the two page
 * sources is the cheapest honest join — no extra export shape smuggled through
 * a Next page file.
 */

const PAGES = [
  join(process.cwd(), "app/reports/performance/page.tsx"),
  join(process.cwd(), "app/reports/scaling/page.tsx"),
];

function usedIds(): Set<string> {
  const ids = new Set<string>();
  for (const p of PAGES) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(/metric(?:Detail|CaveatLine)\(\s*"([a-zA-Z0-9]+)"/g)) ids.add(m[1]);
    for (const m of src.matchAll(/(?:metricGlossary\(\s*\[|also:\s*\[)([^\]]*)\]/g)) {
      for (const q of m[1].matchAll(/"([a-zA-Z0-9]+)"/g)) ids.add(q[1]);
    }
  }
  return ids;
}

describe("the registry and the pages agree, exactly", () => {
  const used = usedIds();

  it("every metric id the pages render has a registry entry", () => {
    const registry = new Set<string>(METRIC_HELP_IDS);
    const ghosts = [...used].filter((id) => !registry.has(id));
    expect(ghosts, `pages render ids the registry does not know: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("every registry entry is rendered somewhere", () => {
    const orphans = METRIC_HELP_IDS.filter((id) => !used.has(id));
    expect(orphans, `registry entries no page renders: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the pages actually render explainers (the parse found ids)", () => {
    // Guards the drift test itself: if a refactor changes the call shapes so
    // the regexes match nothing, both set-difference tests above would pass
    // vacuously on one side.
    expect(used.size).toBeGreaterThanOrEqual(20);
  });
});

describe("every entry keeps the house rules", () => {
  it("all five fields are substantial strings", () => {
    for (const id of METRIC_HELP_IDS) {
      const e = METRIC_HELP[id];
      for (const field of ["title", "meaning", "formula", "healthyRange", "caveat", "whatToDo"] as const) {
        expect(e[field].length, `${id}.${field}`).toBeGreaterThan(20);
      }
    }
  });

  it("healthyRange is always a hedged heuristic with its assumption stated", () => {
    for (const id of METRIC_HELP_IDS) {
      const h = METRIC_HELP[id].healthyRange;
      expect(h, `${id}.healthyRange must be phrased as a common reading`).toMatch(/commonly|typically/i);
      expect(h, `${id}.healthyRange must state what it depends on / assumes`).toMatch(/depend|assum/i);
    }
  });

  it("whatToDo is descriptive, never prescriptive", () => {
    for (const id of METRIC_HELP_IDS) {
      const w = METRIC_HELP[id].whatToDo;
      expect(w, `${id}.whatToDo`).not.toMatch(/\byou (should|must|need to|have to)\b/i);
    }
  });

  it("keeps the house voice — no marketing superlatives", () => {
    for (const id of METRIC_HELP_IDS) {
      const e = METRIC_HELP[id];
      const text = [e.title, e.meaning, e.formula, e.healthyRange, e.caveat, e.whatToDo].join(" ").toLowerCase();
      expect(text, id).not.toMatch(/world[- ]class|revolutionary|best[- ]in[- ]class|amazing/);
    }
  });

  it("states the risk-free rate ONLY via the {riskFreePct} placeholder — never a hardcoded second copy", () => {
    const needRf: MetricHelpId[] = [];
    for (const id of METRIC_HELP_IDS) {
      const e = METRIC_HELP[id];
      const text = [e.title, e.meaning, e.formula, e.healthyRange, e.caveat, e.whatToDo].join(" ");
      expect(text, `${id} hardcodes a risk-free rate`).not.toMatch(/7\s*%/);
      if (text.includes("{riskFreePct}")) needRf.push(id);
    }
    // The entries that reference the rate — the page supplies it from RISK_FREE.
    expect(needRf.sort()).toEqual(["alpha", "sharpe", "sortino"]);
  });
});

describe("label honesty — the explainers state the verified conventions", () => {
  it("names BOTH max-drawdown conventions, each in its own entry", () => {
    // The performance card: %-of-equity daily walk, with the dashboard's
    // trade-by-trade convention named as the other one.
    expect(METRIC_HELP.maxDrawdown.formula).toMatch(/dashboard/i);
    expect(METRIC_HELP.maxDrawdown.formula).toMatch(/peak/i);
    // The share-card ₹ figure: same daily walk; the dashboard's differs.
    expect(METRIC_HELP.shareMaxDrawdown.formula).toMatch(/trade by trade from zero/i);
  });

  it("expectancy is ₹ per priced closed trade, NOT R-expectancy", () => {
    expect(METRIC_HELP.expectancy.meaning).toMatch(/NOT R-expectancy/);
    expect(METRIC_HELP.expectancy.meaning).toMatch(/Avg R/);
    expect(METRIC_HELP.avgR.meaning).toMatch(/THE R figure/);
  });

  it("Sharpe/Sortino/volatility admit the realised-only series and √252 annualisation", () => {
    for (const id of ["sharpe", "sortino", "volatility"] as const) {
      const e = METRIC_HELP[id];
      expect(`${e.formula} ${e.caveat}`, id).toMatch(/realised|days with realised P&L/i);
      expect(`${e.formula} ${e.caveat}`, id).toMatch(/252/);
    }
    expect(METRIC_HELP.sharpe.caveat).toMatch(/limited/i);
  });

  it("alpha admits arithmetic ×252 annualisation, not geometric", () => {
    expect(METRIC_HELP.alpha.formula).toMatch(/arithmetic/i);
    expect(METRIC_HELP.alpha.formula).toMatch(/NOT geometrically/i);
  });

  it("profit factor documents the ∞-free-of-error handling", () => {
    expect(METRIC_HELP.profitFactor.formula).toMatch(/∞/);
    expect(METRIC_HELP.profitFactor.formula).toMatch(/no losing trades/i);
  });

  it("the replay entry states the EOD caveat", () => {
    expect(metricCaveatLine("replayEod")).toMatch(/end-of-day|EOD/i);
    expect(metricCaveatLine("replayEod")).toMatch(/intraday path/i);
  });
});

describe("the adapters", () => {
  it("metricDetail produces the KpiDetail row shape with all four sections", () => {
    const d = metricDetail("calmar");
    expect(d.title).toBe(METRIC_HELP.calmar.title);
    expect(d.summary).toBe(METRIC_HELP.calmar.meaning);
    expect(d.rows.map((r) => r.label)).toEqual([
      "How it's computed",
      "Commonly read as",
      "The caveat",
      "What traders change",
    ]);
    for (const r of d.rows) expect(typeof r.value).toBe("string");
  });

  it("interpolates vars and refuses to render an unresolved placeholder", () => {
    const d = metricDetail("sharpe", { vars: { riskFreePct: "7%" }, also: ["sortino"] });
    expect(JSON.stringify(d)).toContain("7%");
    expect(JSON.stringify(d)).not.toContain("{riskFreePct}");
    // The also-block folded Sortino in as one extra row.
    expect(d.rows.some((r) => r.label === METRIC_HELP.sortino.title)).toBe(true);
    // Forgetting the rate fails loudly rather than shipping a literal "{riskFreePct}".
    expect(() => metricDetail("sharpe")).toThrow(/riskFreePct/);
  });

  it("carries the page-state note through — the '—' card explains itself", () => {
    const note = 'shows "—" because no starting capital is configured';
    expect(metricDetail("cagr", { note }).note).toBe(note);
  });

  it("metricGlossary derives short terms from titles", () => {
    const g = metricGlossary(["expectancy", "shareMaxDrawdown"]);
    expect(g[0].term).toBe("Expectancy");
    expect(g[1].term).toBe("Max drawdown (share card)");
    for (const row of g) {
      expect(row.meaning.length).toBeGreaterThan(20);
      expect(row.caveat.length).toBeGreaterThan(20);
    }
  });
});
