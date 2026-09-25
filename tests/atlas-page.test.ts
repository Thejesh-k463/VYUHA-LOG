import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { computeAtlasDaily, type Bar, type ClassificationRef } from "@/lib/atlas";
import { MetricTile, coverageSentence } from "@/components/atlas/metric-tile";

// The panel's BackfillPanel calls `useRouter()`; a static render has no app
// router, so the hook is stubbed. Nothing under test navigates.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));

/**
 * `/atlas`'s loader — `getAtlasPageData()` — and the one decision it makes
 * before anything else: Pro or preview (research answers Q55/Q57).
 *
 * Atlas is Pro and the tab is LOCKED, never hidden, so a copy without a
 * licence has to get a screen that says what Atlas is and no market numbers.
 * That is not only a copy rule: computing breadth across the whole stored
 * universe for a visitor who cannot read the result is a full-market recompute
 * spent on a locked door. So the free case must come back with `view: null`
 * and must not have touched the bars at all.
 *
 * The entitlement is mocked because the licence state is the INPUT under test;
 * everything below it is the real query module against a temp database.
 */

const ROOT = path.resolve(__dirname, "..");

const ent = vi.hoisted(() => ({
  value: { pro: false, state: "unlicensed" } as { pro: boolean; state: string },
}));

vi.mock("@/lib/queries/license", () => ({
  getEntitlement: () => ent.value,
}));

let t: TempDb;
let q: typeof import("@/lib/queries/atlas");

beforeAll(async () => {
  t = await openTempDb("atlas-page", { seed: true });
  q = await import("@/lib/queries/atlas");
});

afterAll(() => t?.cleanup());

describe("a free copy gets the static preview", () => {
  it("returns preview mode and no view", () => {
    ent.value = { pro: false, state: "unlicensed" };
    const data = q.getAtlasPageData();
    expect(data.preview).toBe(true);
    expect(data.view).toBeNull();
    expect(data.entitlementState).toBe("unlicensed");
  });

  it("does not compute a snapshot for a screen nobody can read", () => {
    ent.value = { pro: false, state: "expired-key" };
    q.getAtlasPageData();
    expect(q.getStoredSnapshot()).toBeNull();
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_daily").get()).toEqual({ n: 0 });
  });

  it("reports the state that locked it, so the page never re-reads the licence", () => {
    ent.value = { pro: false, state: "expired-key" };
    expect(q.getAtlasPageData().entitlementState).toBe("expired-key");
  });
});

describe("a trial is Pro while it lasts", () => {
  it("loads the real view, not the preview", () => {
    ent.value = { pro: true, state: "trial" };
    const data = q.getAtlasPageData();
    expect(data.preview).toBe(false);
    expect(data.entitlementState).toBe("trial");
    expect(data.view).not.toBeNull();
  });
});

describe("the loader hands the panel everything it renders", () => {
  it("carries the five tabs' data, the backfill state and both footer lines", () => {
    ent.value = { pro: true, state: "licensed" };
    const view = q.getAtlasPageData().view!;
    expect(Object.keys(view).sort()).toEqual(
      [
        "backfill",
        "backfillConsented",
        "backfillDefaultDays",
        "backfillRateLimitMs",
        "capBands",
        // v4.6.0 W2 (U2): the Nifty size-index membership lens, beside the AMFI cap band.
        "indexBands",
        // Q52: the bundled classification maps, each with its sha256 and its
        // own as-of date — the panel prints both beside the rotation table.
        "mapDigests",
        "myNames",
        "notAdviceLine",
        "payload",
        "provenanceLine",
        "rotationCaveat",
        "sessions",
        "snapshot",
        "specVersion",
        "volumeLeaders",
        // v4.6.0 W5 (Q51 + Atlas v3): the group statistic, rank Δ per group kind
        // (same-spec snapshots), the trades join, the stored regime thresholds,
        // the coverage floor, the leaderboard floor, the index filters, the
        // catch-up status and the honesty list.
        "statistic",
        "rankDeltas",
        "entryDayBreadth",
        "regimeThresholds",
        "coverageFloorPpm",
        "groupMinRank",
        "indexFilters",
        "catchup",
        "notComputed",
        // W5 phase 2 (Q51 #7): the rotation table's sparse-history spans.
        "windowSpans",
      ].sort(),
    );
    expect(view.provenanceLine).toBe(q.NO_CHARTINK_LINE);
    expect(view.notAdviceLine).toBe(q.NOT_ADVICE_LINE);
  });

  it("is honest about an empty database instead of printing a zero", () => {
    ent.value = { pro: true, state: "licensed" };
    const view = q.getAtlasPageData().view!;
    expect(view.sessions).toBe(0);
    expect(view.payload).toBeNull();
    expect(view.myNames.enabled).toBe(false);
    expect(view.capBands.rows.every((r) => r.members === 0)).toBe(true);
  });

  it("exposes the backfill progress the coverage tab polls", () => {
    ent.value = { pro: true, state: "licensed" };
    const view = q.getAtlasPageData().view!;
    expect(view.backfill).toBeTypeOf("object");
    expect(typeof view.backfillConsented).toBe("boolean");
    expect(view.backfillDefaultDays).toBeGreaterThan(0);
  });
});

/**
 * The v3 panel renders over the NEW view shape (v4.6.0 W5). A static render
 * (react-dom/server) is what a client component does on the server before
 * hydration — the stored preferences are null there, so the defaults paint:
 * tab 1, sector, median, "All". The payload comes from the pure library over a
 * synthetic universe (six symbols, 30 sessions, two sectors), stitched onto the
 * real loader's view so every other field is the loader's own.
 */
describe("the v3 panel renders over the new view shape", () => {
  const DAY = 86_400_000;
  const iso = (i: number) => new Date(Date.UTC(2026, 0, 5) + Math.floor(i / 5) * 7 * DAY + (i % 5) * DAY).toISOString().slice(0, 10);
  const bars = (symbol: string, drift: number): Bar[] =>
    Array.from({ length: 30 }, (_, i) => {
      const close = 100 + i * drift;
      return { symbol, date: iso(i), high: close + 1, low: close - 1, close, volume: 1_000 + i };
    });
  const UNIVERSE: Bar[] = [
    ...bars("AAA", 1),
    ...bars("BBB", 0.5),
    ...bars("CCC", -0.5),
    ...bars("DDD", 0.25),
    ...bars("EEE", -1),
    ...bars("FFF", 0),
  ];
  const REF: Record<string, ClassificationRef> = {
    AAA: { macro: "M", sector: "Information Technology", industry: "IT - Software", basic: null },
    BBB: { macro: "M", sector: "Information Technology", industry: "IT - Software", basic: null },
    CCC: { macro: "M", sector: "Information Technology", industry: "IT - Services", basic: null },
    DDD: { macro: "M", sector: "Financial Services", industry: "Banks", basic: null },
    EEE: { macro: "M", sector: "Financial Services", industry: "Banks", basic: null },
    FFF: { macro: "M", sector: "Financial Services", industry: "Banks", basic: null },
  };
  const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

  const payloadOf = () =>
    computeAtlasDaily(UNIVERSE, (s) => (REF[s] ? { sector: REF[s].sector! } : null), {
      generatedAt: "2026-02-13T12:00:00.000Z",
      sha256,
      classificationOf: (s) => REF[s] ?? null,
      capBandOf: (s) => (s === "AAA" || s === "BBB" ? "large" : s === "CCC" ? "mid" : "small"),
    }).payload!;

  const renderPanel = async (initialTab?: "market" | "sectors" | "cap" | "mine" | "coverage") => {
    ent.value = { pro: true, state: "licensed" };
    const base = q.getAtlasPageData().view!;
    const payload = payloadOf();
    const view = {
      ...base,
      payload,
      snapshot: {
        asOf: payload.as_of!,
        generatedAt: payload.generated_at,
        specVersion: payload.spec_version,
        sourceMode: payload.source_mode,
        inputChecksum: payload.input_checksum,
        universeIncluded: payload.universe.included,
        universeExcluded: payload.universe.excluded,
        anchorCoverage: payload.universe.anchor_coverage,
        anchorCoveragePpm: payload.universe.anchor_coverage_ppm,
        payload,
      },
    };
    const { AtlasPanel } = await import("@/components/atlas/atlas-panel");
    // Radix mounts only the ACTIVE tab's content, exactly as the browser does;
    // `initialTab` is the panel's fallback when nothing is stored.
    return { html: renderToStaticMarkup(createElement(AtlasPanel, { view, initialTab })), view };
  };

  it("paints the five tabs, the regime card with its thresholds in words, and the filter, on the defaults", async () => {
    const { html, view } = await renderPanel();
    for (const label of ["Market", "Sectors", "Cap bands", "My names", "Coverage"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain("Regime —");
    expect(html).toContain("Thresholds (the shipped defaults)");
    // The printed bounds are the SETTING's, not literals typed into the panel.
    const t = view.regimeThresholds.thresholds;
    expect(html).toContain(`above-SMA50 ≥ ${t.expansionAboveSma50Ppm / 10_000}%`);
    expect(html).toContain(`above-SMA50 ≤ ${t.contractionAboveSma50Ppm / 10_000}%`);
    expect(html).toContain("does not vote");
    expect(html).toContain("Restrict to");
    expect(html).toContain("the whole stored universe");
    expect(html).toContain('data-filtered="no"');
    // Tab 1 card order (AQ1): regime → my names → sector RS → cap ladder → breadth.
    const order = ["atlas-regime", "atlas-my-names-headline", "atlas-sector-rs", "atlas-cap-headline", "atlas-breadth"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The footer lines, verbatim.
    expect(html).toContain(q.NO_CHARTINK_LINE);
    expect(html).toContain(q.NOT_ADVICE_LINE);
  });

  it("renders the rotation table at sector / median by default, with the level and statistic toggles", async () => {
    const { html } = await renderPanel("sectors");
    expect(html).toContain('data-level="sector"');
    expect(html).toContain('data-statistic="median"');
    expect(html).toContain('data-testid="atlas-level-toggle"');
    expect(html).toContain('data-testid="atlas-statistic-toggle"');
    expect(html).toContain("Turnover share");
    expect(html).toContain("Information Technology");
    // Two sectors of three: neither reaches the ranking floor, and the table says so rather than ranking them.
    expect(html).toMatch(/No group has \d+ priced members yet, so none is ranked/);
  });

  it("names the honesty list's gates and the catch-up line on Coverage", async () => {
    const { html, view } = await renderPanel("coverage");
    expect(html).toContain('data-testid="atlas-not-computed"');
    expect(html).toContain("Needs an intraday feed");
    expect(html).toContain("Not computed here");
    expect(html).toContain(view.catchup.line);
  });

  it("renders the AMFI ladder with NSE Emerge named as not ranked, and the index lens beside it", async () => {
    const { html } = await renderPanel("cap");
    expect(html).toContain('data-testid="atlas-cap-ladder"');
    expect(html).toContain("not ranked by AMFI");
    expect(html).toContain('data-band="large"');
    expect(html).toContain('data-testid="atlas-index-bands"');
  });

  it("renders the cohort tab's honest empty state and the trades-join card", async () => {
    const { html, view } = await renderPanel("mine");
    // The temp database has no bars, so the loader's cohort view is the dark state — rendered verbatim.
    expect(html).toContain(view.myNames.reason);
    expect(html).toContain('data-testid="atlas-entry-days"');
    expect(html).toContain(view.entryDayBreadth.open.sentence);
  });
});

/**
 * AQ44 — the collapsed denominator. Below the floor a tile prints its COVERAGE
 * instead of its value; above it the value prints with its coverage beneath.
 * Never 0, never blank (invariant 6).
 */
describe("MetricTile below the coverage floor (AQ44)", () => {
  const render = (props: Parameters<typeof MetricTile>[0]) => renderToStaticMarkup(createElement(MetricTile, props));

  it("prints the coverage sentence INSTEAD of the value at 2% coverage", () => {
    const html = render({ label: "Above SMA200", valuePpm: 500_000, numerator: 20, denominator: 40, coveragePpm: 21_053, formula: "f" });
    expect(html).toContain("40 of 1,900 priced (2%)");
    expect(html).not.toContain("50.0%");
    expect(html).toContain('data-coverage="below-floor"');
    expect(html).toContain("below the 30% coverage floor");
  });

  it("prints the value with its coverage beneath at 40% coverage", () => {
    const html = render({ label: "Above SMA200", valuePpm: 500_000, numerator: 20, denominator: 40, coveragePpm: 400_000, formula: "f" });
    expect(html).toContain("50.0%");
    expect(html).toContain("20 of 40");
    expect(html).toContain("40% coverage");
    expect(html).not.toContain("below-floor");
  });

  it("the floor is the shipped constant and can be overridden per tile", () => {
    const strict = render({ label: "x", valuePpm: 500_000, numerator: 20, denominator: 40, coveragePpm: 400_000, coverageFloorPpm: 500_000 });
    expect(strict).toContain("below-floor");
    expect(strict).toContain("40 of 100 priced (40%)");
  });

  it("a shortfall still wins, and an empty denominator is 'nothing to divide by', not a coverage sentence", () => {
    expect(render({ label: "x", valuePpm: null, denominator: 40, coveragePpm: 1_000, shortfall: "needs 200 sessions, you have 43" })).toContain("needs 200 sessions, you have 43");
    expect(render({ label: "x", valuePpm: null, denominator: 0, coveragePpm: 0 })).toContain("no denominator");
  });

  it("the sentence recovers the universe from denominator and coverage, and never prints 0%", () => {
    expect(coverageSentence(40, 21_053)).toBe("40 of 1,900 priced (2%)");
    expect(coverageSentence(3, 1_500)).toBe("3 of 2,000 priced (<1%)");
    expect(coverageSentence(7, 0)).toBe("7 priced (0%)");
  });
});

/**
 * The regime editor's 400 echo (AQ13): the route's sentence reaches the card
 * VERBATIM — never paraphrased, never swallowed. Tested at the submit seam
 * (`submitRegime`) with a fake fetch; the browser half is e2e/z-atlas.spec.ts.
 */
describe("the regime editor echoes the route's 400 message verbatim", () => {
  const MESSAGE = "The contraction ceiling for above-SMA50 must be below the expansion floor, or a market could be both at once.";
  const fake = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

  it("returns the server's message on a 400", async () => {
    const { submitRegime } = await import("@/components/settings/atlas-regime-editor");
    const r = await submitRegime({ thresholds: { expansionAboveSma50Ppm: 1, expansionNetHighLow: 0, contractionAboveSma50Ppm: 2, contractionNetHighLow: -1 } }, fake(400, { ok: false, message: MESSAGE }));
    expect(r).toEqual({ ok: false, message: MESSAGE });
  });

  it("posts type atlas-regime to /api/settings, and reports a saved message on 200", async () => {
    const { submitRegime } = await import("@/components/settings/atlas-regime-editor");
    let seen: { url: string; body: unknown } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true, message: "Regime thresholds saved." }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await submitRegime({ reset: true }, spy);
    expect(r).toEqual({ ok: true, message: "Regime thresholds saved." });
    expect(seen).toEqual({ url: "/api/settings", body: { type: "atlas-regime", reset: true } });
  });

  it("a network failure is a sentence, not a throw", async () => {
    const { submitRegime } = await import("@/components/settings/atlas-regime-editor");
    const r = await submitRegime({ reset: true }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toBe("Could not reach the app's own server.");
  });

  it("converts the typed percentages to ppm and leaves the counts whole", async () => {
    const { fromInputs } = await import("@/components/settings/atlas-regime-editor");
    expect(fromInputs({ expansionAboveSma50Ppm: "55", expansionNetHighLow: "0", contractionAboveSma50Ppm: "40", contractionNetHighLow: "-50" })).toEqual({
      expansionAboveSma50Ppm: 550_000,
      expansionNetHighLow: 0,
      contractionAboveSma50Ppm: 400_000,
      contractionNetHighLow: -50,
    });
  });

  it("a cleared field is not 0: blank input stays a non-number, so the route's 400 fires instead of a 0% ceiling saving", async () => {
    const { fromInputs } = await import("@/components/settings/atlas-regime-editor");
    // `Number("") === 0` — the bug: a cleared contraction ceiling posted 0 and saved silently.
    const out = fromInputs({ expansionAboveSma50Ppm: "55", expansionNetHighLow: "0", contractionAboveSma50Ppm: "", contractionNetHighLow: "   " });
    expect(out.contractionAboveSma50Ppm).toBeNaN();
    expect(out.contractionNetHighLow).toBeNaN();
    expect(out.expansionAboveSma50Ppm).toBe(550_000);
    expect(out.expansionNetHighLow).toBe(0); // a typed "0" is still 0
    // Over the wire NaN is `null`, which `thresholdsFromObject` refuses.
    expect(JSON.parse(JSON.stringify(out)).contractionAboveSma50Ppm).toBeNull();
  });
});

describe("the page file itself", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/atlas/page.tsx"), "utf8");

  it("is force-dynamic, because it reads the database", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("wraps the real panel in <ProGate> and still renders the static preview", () => {
    expect(page).toContain("<ProGate>");
    expect(page).toContain("<AtlasPreview />");
    expect(page).toContain("<AtlasPanel view={data.view!} />");
  });

  it("renders the preview OUTSIDE the gate — inside it, the block branch eats it", () => {
    // <ProGate>'s "block" branch returns the upsell panel INSTEAD of its
    // children, and LICENSE_ENFORCEMENT is "block", so <AtlasPreview /> nested
    // inside the gate was unreachable in every shipped state — Q57 says the
    // Atlas tab is LOCKED WITH A STATIC PREVIEW, never hidden. This reads the
    // real file: anything the gate wraps is a child, and the preview must not
    // be one.
    // Comments first: this file's own header explains the rule in prose and
    // names <ProGate> while doing it, and a scanner that reads prose as code
    // would fail on the explanation rather than on the code.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const inside = [...code.matchAll(/<ProGate>([\s\S]*?)<\/ProGate>/g)].map((m) => m[1]);
    expect(inside.length, "the gate must still be on this page").toBeGreaterThan(0);
    for (const body of inside) {
      expect(body, "AtlasPreview is a ProGate child and cannot render under 'block'").not.toContain("AtlasPreview");
    }
    // …and the preview really is on the page, just beside the gate.
    expect(code.replace(/<ProGate>[\s\S]*?<\/ProGate>/g, "")).toContain("<AtlasPreview />");
  });

  it("takes the preview branch from the LOADER's decision, not a second licence read", () => {
    // The loader already resolved entitlement (`preview`); a page that asked
    // again could disagree with the answer it was handed.
    expect(page).toMatch(/if \(data\.preview\)/);
    expect(page).not.toContain("getEntitlement");
  });

  it("makes exactly one loader call", () => {
    expect(page.match(/getAtlasPageData\(\)/g)).toHaveLength(1);
  });
});
