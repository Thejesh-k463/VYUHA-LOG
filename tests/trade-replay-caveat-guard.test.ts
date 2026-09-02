import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { metricCaveatLine } from "@/lib/domain/metric-help";

/**
 * Source guard for the v3.6.0 WS5 fix — the EOD-replay caveat has ONE source
 * of truth: lib/domain/metric-help.ts (`metricCaveatLine("replayEod")`),
 * rendered by app/reports/scaling/page.tsx directly above <TradeReplay/>.
 *
 * components/reports/trade-replay.tsx used to hardcode a near-identical second
 * sentence ("EOD closes cannot show the intraday path between fills. Markers
 * use recorded fill prices; the line uses imported bhavcopy closes."), so the
 * same caveat rendered twice, stacked. This test fails if a hand-written copy
 * creeps back in. It is deliberately a TEXT check, in the style of
 * tests/capital-fallback-guard.test.ts: the bug class is duplicated copy that
 * no unit test of behaviour can see.
 */

const root = process.cwd();
const src = readFileSync(path.join(root, "components/reports/trade-replay.tsx"), "utf8");

// Strip block and line comments first — the file legitimately EXPLAINS the
// rule in a comment that names the old phrasing's subject matter.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("trade-replay caveat single source of truth", () => {
  it("trade-replay.tsx does not hand-write the intraday-path caveat", () => {
    // The load-bearing phrase of the deleted duplicate. Case-insensitive and
    // whitespace-tolerant so a reworded-but-recognisable copy still trips it.
    expect(code).not.toMatch(/cannot\s+show\s+the\s+intraday\s+path/i);
  });

  it("trade-replay.tsx does not hand-write the markers/line explanation", () => {
    // Second sentence of the old duplicate ("Markers use recorded fill
    // prices; the line uses imported bhavcopy closes.") — metric-help's
    // meaning/formula fields carry this already.
    expect(code).not.toMatch(/markers\s+use\s+recorded\s+fill\s+prices/i);
    expect(code).not.toMatch(/bhavcopy/i);
  });

  it("the registry caveat the page renders still says what the duplicate said", () => {
    // If someone reworded the metric-help entry away from the intraday-path
    // caveat, deleting the local line would have LOST the information rather
    // than de-duplicated it. Pin the registry side too.
    const line = metricCaveatLine("replayEod");
    expect(line).toMatch(/cannot show the intraday path/i);
    expect(line).toMatch(/bhavcopy/i);
  });
});
