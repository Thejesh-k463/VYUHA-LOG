import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRegime, DEFAULT_REGIME_THRESHOLDS } from "@/lib/atlas/regime";
import {
  isDefaultRegimeThresholds,
  parseRegimeThresholds,
  serializeRegimeThresholds,
  thresholdsFromObject,
  validateRegimeThresholds,
} from "@/lib/atlas/regime-thresholds";
import { BASELINE_SETTINGS_FIELDS } from "@/lib/domain/settings-baseline";
import { SETTINGS_MACHINE_COLUMNS } from "@/lib/backup-format";
import { openTempDb, type TempDb } from "./helpers/temp-db";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

/**
 * Regime thresholds as a SETTING (v4.6.0 W5, owner ruling AQ13; design review A3/A9).
 *
 *   validation — pure: 0 ≤ ppm ≤ 1,000,000; each contraction bound strictly
 *                below its expansion bound; whole-number counts.
 *   read       — NULL / alien / corrupt → the shipped defaults, never a throw.
 *   route      — `type: "atlas-regime"` on POST /api/settings: save, refuse, reset.
 *   re-derive  — the label the page and GET /api/atlas serve is read against
 *                the CURRENT thresholds, from the stored inputs (A3).
 *   floor      — an input under the coverage floor cannot vote (A9).
 *   baseline   — a CHOICE: in BASELINE_SETTINGS_FIELDS, not a machine column.
 *
 * ONE temp database per file.
 */

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");
let route: typeof import("@/app/api/settings/route");

beforeAll(async () => {
  t = await openTempDb("atlas-regime-settings", { seed: true });
  q = await import("@/lib/queries/atlas");
  route = await import("@/app/api/settings/route");
});
afterAll(() => t?.cleanup());
beforeEach(() => t.sqlite.prepare("UPDATE settings SET atlas_regime_thresholds = NULL").run());

const post = (body: unknown) =>
  route.POST(new Request("http://localhost:3011/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const stored = () => (t.sqlite.prepare("SELECT atlas_regime_thresholds AS v FROM settings").get() as { v: string | null }).v;

const STRICT = { expansionAboveSma50Ppm: 800_000, expansionNetHighLow: 10, contractionAboveSma50Ppm: 300_000, contractionNetHighLow: -100 };

describe("parse / validate / serialise (pure)", () => {
  it("round-trips the versioned envelope and reads NULL, an alien version and a corrupt blob as 'defaults'", () => {
    const json = serializeRegimeThresholds(STRICT);
    expect(JSON.parse(json).v).toBe(1);
    expect(parseRegimeThresholds(json)).toEqual(STRICT);
    expect(parseRegimeThresholds(null)).toBeNull();
    expect(parseRegimeThresholds("")).toBeNull();
    expect(parseRegimeThresholds(JSON.stringify({ v: 2, ...STRICT }))).toBeNull();
    expect(parseRegimeThresholds("{not json")).toBeNull();
    expect(parseRegimeThresholds(JSON.stringify({ v: 1, ...STRICT, contractionAboveSma50Ppm: 900_000 }))).toBeNull(); // stored but invalid → defaults
  });

  it("refuses a ppm outside [0, 1_000_000], an overlap, and a fractional count — each with a sentence", () => {
    expect(validateRegimeThresholds(DEFAULT_REGIME_THRESHOLDS)).toBeNull();
    expect(validateRegimeThresholds(STRICT)).toBeNull();
    expect(validateRegimeThresholds({ ...STRICT, expansionAboveSma50Ppm: 1_000_001 })).toMatch(/between 0 and 10,00,000 ppm/);
    expect(validateRegimeThresholds({ ...STRICT, contractionAboveSma50Ppm: -1 })).toMatch(/between 0 and/);
    expect(validateRegimeThresholds({ ...STRICT, contractionAboveSma50Ppm: 800_000 })).toMatch(/contraction ceiling for above-SMA50 must be below/);
    expect(validateRegimeThresholds({ ...STRICT, contractionNetHighLow: 10 })).toMatch(/contraction ceiling for net high-low must be below/);
    expect(validateRegimeThresholds({ ...STRICT, expansionNetHighLow: 2.5 })).toMatch(/whole number/);
  });

  it("coerces a request body's strings and refuses a missing field", () => {
    expect(thresholdsFromObject({ expansionAboveSma50Ppm: "800000", expansionNetHighLow: "10", contractionAboveSma50Ppm: 300000, contractionNetHighLow: "-100" })).toEqual(STRICT);
    expect(thresholdsFromObject({ ...STRICT, contractionNetHighLow: undefined })).toBeNull();
    expect(thresholdsFromObject({ ...STRICT, expansionNetHighLow: "abc" })).toBeNull();
    expect(thresholdsFromObject(null)).toBeNull();
    expect(isDefaultRegimeThresholds(DEFAULT_REGIME_THRESHOLDS)).toBe(true);
    expect(isDefaultRegimeThresholds(STRICT)).toBe(false);
  });
});

describe("the coverage floor (AQ44 / A9)", () => {
  const sma = (value_ppm: number | null, coverage_ppm?: number) => ({ value_ppm, denominator: 100, coverage_ppm });
  const net = (value: number | null, coverage_ppm?: number) => ({ value, denominator: 100, coverage_ppm });

  it("an input under 30% coverage yields unknown / coverage_below_floor — the label does not vote on 40 of 1,900", () => {
    const r = classifyRegime({ aboveSma50: sma(600_000, 21_000), netHighLow: net(25, 21_000) });
    expect(r.regime).toBe("unknown");
    expect(r.reason).toBe("coverage_below_floor");
    expect(r.coverageFloorPpm).toBe(300_000);
    expect(r.belowFloor).toEqual([
      { input: "aboveSma50", coverage_ppm: 21_000 },
      { input: "netHighLow", coverage_ppm: 21_000 },
    ]);
    // Even a contraction-looking input may not vote from under the floor.
    expect(classifyRegime({ aboveSma50: sma(100_000, 20_000), netHighLow: net(25, 900_000) }).regime).toBe("unknown");
  });

  it("at or above the floor the rule decides as before; a legacy caller without coverage is unaffected", () => {
    expect(classifyRegime({ aboveSma50: sma(600_000, 300_000), netHighLow: net(25, 300_000) }).regime).toBe("expansion");
    expect(classifyRegime({ aboveSma50: sma(600_000), netHighLow: net(25) }).regime).toBe("expansion");
    expect(classifyRegime({ aboveSma50: sma(600_000, 900_000), netHighLow: net(25, 900_000) }, DEFAULT_REGIME_THRESHOLDS, 950_000).reason).toBe("coverage_below_floor");
  });
});

describe("the read: defaults, then whatever the setting says", () => {
  it("reads the defaults from a NULL column and reports isDefault", () => {
    const s = q.getRegimeThresholdSetting();
    expect(s.thresholds).toEqual(DEFAULT_REGIME_THRESHOLDS);
    expect(s.isDefault).toBe(true);
    expect(s.coverageFloorPpm).toBe(300_000);
  });

  it("reads a stored envelope, and falls back to the defaults on an alien one", () => {
    t.sqlite.prepare("UPDATE settings SET atlas_regime_thresholds = ?").run(serializeRegimeThresholds(STRICT));
    expect(q.getRegimeThresholds()).toEqual(STRICT);
    expect(q.getRegimeThresholdSetting().isDefault).toBe(false);
    t.sqlite.prepare("UPDATE settings SET atlas_regime_thresholds = ?").run(JSON.stringify({ v: 9, ...STRICT }));
    expect(q.getRegimeThresholds()).toEqual(DEFAULT_REGIME_THRESHOLDS);
  });
});

describe("POST /api/settings type=atlas-regime (route handler, never a server action)", () => {
  it("saves a valid edit as the envelope and answers with it", async () => {
    const res = await post({ type: "atlas-regime", thresholds: STRICT });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.thresholds).toEqual(STRICT);
    expect(body.isDefault).toBe(false);
    expect(parseRegimeThresholds(stored())).toEqual(STRICT);
    expect(JSON.parse(stored()!).v).toBe(1);
  });

  it("refuses an invalid edit with a 400 and the validator's sentence, and stores nothing", async () => {
    const res = await post({ type: "atlas-regime", thresholds: { ...STRICT, contractionAboveSma50Ppm: 900_000 } });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/must be below/);
    expect(stored()).toBeNull();
    const missing = await post({ type: "atlas-regime", thresholds: { expansionAboveSma50Ppm: 1 } });
    expect(missing.status).toBe(400);
    const tooBig = await post({ type: "atlas-regime", ...STRICT, expansionAboveSma50Ppm: 2_000_000 });
    expect(tooBig.status).toBe(400);
    expect(stored()).toBeNull();
  });

  it("reset returns the column to NULL — the defaults — and says so", async () => {
    await post({ type: "atlas-regime", thresholds: STRICT });
    expect(stored()).not.toBeNull();
    const res = await post({ type: "atlas-regime", reset: true });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.isDefault).toBe(true);
    expect(body.thresholds).toEqual(DEFAULT_REGIME_THRESHOLDS);
    expect(stored()).toBeNull();
  });
});

describe("read-time re-derivation (A3): the page and the API print ONE label, under the CURRENT thresholds", () => {
  const snapshot = (): import("@/lib/queries/atlas").StoredSnapshot => ({
    asOf: "2026-09-03",
    generatedAt: "2026-09-03T14:00:00.000Z",
    specVersion: "atlas-core/2.0.0",
    sourceMode: "bhavcopy_local",
    inputChecksum: "x",
    universeIncluded: 100,
    universeExcluded: 0,
    anchorCoverage: 100,
    anchorCoveragePpm: 1_000_000,
    payload: {
      market_pulse: {
        moving_average_breadth: { 50: { period: 50, metric: { value_ppm: 600_000, numerator: 60, denominator: 100, coverage_ppm: 1_000_000 }, insufficient: [], deepestSessions: 100 } },
        new_high_low: { netHighLow: { value: 25, denominator: 100, coverage_ppm: 1_000_000 } },
      },
      regime: classifyRegime({ aboveSma50: { value_ppm: 600_000, denominator: 100 }, netHighLow: { value: 25, denominator: 100 } }),
    } as never,
  });

  it("swaps the stored label for the one the current thresholds give, without touching the inputs", () => {
    const s = snapshot();
    expect(s.payload!.regime.regime).toBe("expansion"); // as computed under the defaults
    t.sqlite.prepare("UPDATE settings SET atlas_regime_thresholds = ?").run(serializeRegimeThresholds(STRICT));
    const re = q.withCurrentRegime(s);
    expect(re.payload!.regime.regime).toBe("neutral"); // 60% < the 80% floor now stored
    expect(re.payload!.regime.thresholds).toEqual(STRICT);
    expect(re.payload!.regime.inputs).toEqual({ aboveSma50Ppm: 600_000, netHighLow: 25 });
    expect(re.payload!.regime.formula).toContain("Expansion when above-SMA50 >= 80.0%");
    // The stored object is not mutated — the re-derivation is a READ.
    expect(s.payload!.regime.regime).toBe("expansion");
  });

  it("applies the coverage floor to the stored inputs as well", () => {
    const s = snapshot();
    (s.payload!.market_pulse.moving_average_breadth as Record<number, { metric: { coverage_ppm: number } }>)[50].metric.coverage_ppm = 20_000;
    const re = q.withCurrentRegime(s);
    expect(re.payload!.regime.regime).toBe("unknown");
    expect(re.payload!.regime.reason).toBe("coverage_below_floor");
  });
});

describe("a per-journal CHOICE, not machine state (AQ13 + A3)", () => {
  it("is in BASELINE_SETTINGS_FIELDS (reset → defaults) and NOT in SETTINGS_MACHINE_COLUMNS (it travels in a backup)", () => {
    expect(BASELINE_SETTINGS_FIELDS as readonly string[]).toContain("atlasRegimeThresholds");
    expect(SETTINGS_MACHINE_COLUMNS as readonly string[]).not.toContain("atlasRegimeThresholds");
  });
});
