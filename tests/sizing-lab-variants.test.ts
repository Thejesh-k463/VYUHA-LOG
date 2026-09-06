/**
 * The volatility tab's two-position variant switch (owner ruling Q-6, shape
 * ruled 2026-09-06).
 *
 * `sizeVolatilityUnit` and `sizePctVolatility` answer the same question with
 * different arithmetic: the Turtle divides ONE UNIT'S fraction of the account
 * by an ATR, Varsity divides the WHOLE risk budget by it. At the Turtle's own
 * numbers (2% budget, 1% unit) the second is twice the first — so a screen
 * that shows both and does not name which produced which is ambiguous by a
 * factor of two, and that ambiguity is the whole failure mode this file
 * guards.
 *
 * The Lab renders in a browser and vitest runs in `node` here, so the pairing
 * itself lives in `components/sizing/lab-config.ts` as a PURE function over
 * `compareAll`'s own rows. That is what is asserted numerically; the wiring
 * that puts it on screen is read out of the real component source, the same
 * technique `tests/sizing-lab-copy.test.ts` uses.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compareAll,
  sizePctVolatility,
  sizeVolatilityUnit,
  type SizeResult,
} from "@/lib/risk/sizing";
import {
  LAB_METHODS,
  VOLATILITY_SIZE_CAPTION,
  VOLATILITY_SWITCH_LABEL,
  VOLATILITY_VARIANTS,
  atrToP3,
  buildSetup,
  sampleInputs,
  seedFromParams,
  volatilityVariants,
} from "@/components/sizing/lab-config";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const CLIENT = "components/sizing/lab-client.tsx";

/**
 * The Turtle rulebook's own numbers — a 2% risk budget and a 1% unit — which
 * is the setup the ~2x relation in `sizePctVolatility`'s header is stated at.
 * The deploy cap is OFF so each row is the method's own output and can be
 * compared against a direct call with nothing clipped in between.
 */
const FIXTURE = sampleInputs({
  riskPctPpm: 20_000,
  unitRiskPpm: 10_000,
  deployCapOn: false,
});

const SETUP = buildSetup(FIXTURE);
const ROWS: SizeResult[] = compareAll(SETUP);

describe("both volatility variants render, each labelled by the variant that produced it", () => {
  it("returns exactly the two variants, primary first", () => {
    const turtleFirst = volatilityVariants(ROWS, "volatility-unit");
    expect(turtleFirst.map((v) => v.id)).toEqual(["volatility-unit", "pct-volatility"]);
    expect(turtleFirst.map((v) => v.label)).toEqual(["Turtle unit (N)", "Varsity (% volatility)"]);
    expect(turtleFirst.map((v) => v.primary)).toEqual([true, false]);

    const varsityFirst = volatilityVariants(ROWS, "pct-volatility");
    expect(varsityFirst.map((v) => v.id)).toEqual(["pct-volatility", "volatility-unit"]);
    expect(varsityFirst.map((v) => v.label)).toEqual(["Varsity (% volatility)", "Turtle unit (N)"]);
    expect(varsityFirst.map((v) => v.primary)).toEqual([true, false]);
  });

  it("the Varsity panel's number IS sizePctVolatility at the same inputs", () => {
    const direct = sizePctVolatility({
      capitalP: SETUP.capitalP,
      riskPpm: SETUP.riskPpm,
      atrP3: atrToP3(FIXTURE.atrRupees),
      entryP: SETUP.entryP,
      stopP: SETUP.stopP,
      lotSize: SETUP.lotSize ?? 1,
      nStopMult: SETUP.nStopMult ?? 2000,
    });
    const varsity = volatilityVariants(ROWS, "volatility-unit").find((v) => v.id === "pct-volatility")!;
    expect(varsity.result).toEqual(direct);
    expect(varsity.result.ok).toBe(true);
    expect(varsity.result.qty).toBe(direct.qty);
  });

  it("the Turtle panel's number IS sizeVolatilityUnit at the same inputs", () => {
    const direct = sizeVolatilityUnit({
      capitalP: SETUP.capitalP,
      unitRiskPpm: SETUP.unitRiskPpm ?? 10_000,
      atrP3: atrToP3(FIXTURE.atrRupees),
      entryP: SETUP.entryP,
      stopP: SETUP.stopP,
      lotSize: SETUP.lotSize ?? 1,
      nStopMult: SETUP.nStopMult ?? 2000,
    });
    const turtle = volatilityVariants(ROWS, "pct-volatility").find((v) => v.id === "volatility-unit")!;
    expect(turtle.result).toEqual(direct);
  });

  it("the two numbers differ by about 2x, which is why each carries its own name", () => {
    const [turtle, varsity] = volatilityVariants(ROWS, "volatility-unit");
    expect(turtle.result.ok && varsity.result.ok).toBe(true);
    // 117 vs 235 at this fixture: not a rounding difference, a different rulebook.
    expect(varsity.result.qty).toBeGreaterThan(turtle.result.qty * 1.9);
  });

  it("selects from the rows it is given and never recomputes them", () => {
    // The cap ON is the case that would expose a second computation: compareAll
    // clips its rows through applyDeployCap, and a pair that re-derived from
    // the setup would print the UNCLIPPED figure beside a clipped table.
    const capped = compareAll(buildSetup(sampleInputs({ riskPctPpm: 20_000, unitRiskPpm: 10_000 })));
    for (const v of volatilityVariants(capped, "volatility-unit")) {
      expect(v.result).toBe(capped.find((r) => r.method === v.id));
    }
  });
});

describe("the switch is inside the tab, and changes nothing outside it", () => {
  it("both tabs stay in the rail, on their own keys", () => {
    expect(LAB_METHODS.map((m) => m.id)).toContain("volatility-unit");
    expect(LAB_METHODS.map((m) => m.id)).toContain("pct-volatility");
    expect(LAB_METHODS.find((m) => m.id === "volatility-unit")?.keyHint).toBe("3");
    expect(LAB_METHODS.find((m) => m.id === "pct-volatility")?.keyHint).toBe("4");
    expect(LAB_METHODS).toHaveLength(7);
  });

  it("seedFromParams still ignores a method param entirely", () => {
    const withMethod = seedFromParams({ from: "live", method: "pct-volatility" } as never);
    expect(withMethod).toEqual(seedFromParams({ from: "live" }));
    expect(withMethod.symbol).toBeNull();
  });

  it("the client renders the pair only in the Turtle tab, and does not move the tab", () => {
    const src = read(CLIENT);
    expect(src, "the pair is not gated on the volatility-unit tab").toContain(
      'active.method === "volatility-unit"',
    );
    expect(src, "the switch is not rendered").toContain("<VolatilityPair");
    expect(src, "the pair does not read the shared rows").toMatch(/volatilityVariants\(rows, primary\)/);
    // The switch writes its own state and nothing else: a setMethod here would
    // move the tab and break the ?method= deep link the rail owns.
    expect(src).toMatch(/onPrimary=\{setVolPrimary\}/);
    expect(src).not.toMatch(/onPrimary=\{setMethod\}/);
  });
});

describe("the switch's copy states arithmetic and ranks nothing (SEBI-safe)", () => {
  it("the switch label names both variants, verbatim", () => {
    expect(VOLATILITY_SWITCH_LABEL).toBe("Turtle unit (N) ⇄ Varsity (% volatility)");
    expect(read(CLIENT)).toContain("VOLATILITY_SWITCH_LABEL");
  });

  it("each panel's caption says the figure was produced and computed, never ranked", () => {
    expect(VOLATILITY_SIZE_CAPTION).toBe("the size this method produces, computed from your inputs");
    expect(VOLATILITY_SIZE_CAPTION).toContain("the size this method produces");
    expect(VOLATILITY_SIZE_CAPTION).toContain("computed from your inputs");
    expect(read(CLIENT)).toContain("VOLATILITY_SIZE_CAPTION");
  });

  it("no ranking adjective reaches the variant vocabulary", () => {
    // Neither variant is better, safer, recommended or optimal than the other —
    // they are two rulebooks, and the tab states which produced which number.
    const RANKING = /\b(better|best|safer|safest|recommended|optimal|preferred|superior|ideal)\b/i;
    for (const v of VOLATILITY_VARIANTS) expect(v.label).not.toMatch(RANKING);
    expect(VOLATILITY_SWITCH_LABEL).not.toMatch(RANKING);
    expect(VOLATILITY_SIZE_CAPTION).not.toMatch(RANKING);
  });
});
