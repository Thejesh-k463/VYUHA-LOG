import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";
// PURE (no DB) — safe to import statically beside openTempDb.
import { DEFAULT_RISK_FREE_PPM, parseRiskFreeEdit, ppmToPct, riskFreeOf, RISK_FREE_MAX_PPM } from "@/lib/domain/risk-free";

/**
 * v4.4.0 D5 — ONE dated risk-free setting.
 *
 * It used to be three hard-coded 7% copies (the performance and monthly
 * reports, and the Greeks module). WRONG looks like: /reports/performance
 * computes Sharpe at the user's 6.5% while /risk still discounts the Greeks at
 * 7%. So:
 *   1. a SOURCE GUARD — no `0.07` literal and no `RISK_FREE =` in the code of
 *      app/ or lib/analytics (comments may still name the old copies);
 *   2. the pure parse the route validates with — 0–200000 ppm, a real ISO day,
 *      never after today (IST);
 *   3. the ROUTE itself — a refused edit writes nothing, an accepted one is
 *      read back through `getRiskFree()` with its label.
 *
 * One temp database for the file (AGENTS.md Testing).
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ts = createRequire(import.meta.url)("typescript") as typeof TS;

let t: TempDb;
let settingsRoute: typeof import("@/app/api/settings/route");
let settingsQ: typeof import("@/lib/queries/settings");

beforeAll(async () => {
  t = await openTempDb("risk-free", { seed: true });
  settingsRoute = await import("@/app/api/settings/route");
  settingsQ = await import("@/lib/queries/settings");
}, 60_000);
afterAll(() => t?.cleanup());

// ── 1. the source guard ──────────────────────────────────────────────────────

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(path.join(process.cwd(), root));
  return out;
}

/** Every hard-coded risk-free rate in one source TEXT: a `0.07` numeric literal, or a `RISK_FREE…` binding. */
function hardCodedRates(fileName: string, text: string): string[] {
  // Cheap pre-filter (the readers-follow-writers economy): a file naming neither is never parsed.
  if (!text.includes("0.07") && !text.includes("RISK_FREE")) return [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const at = (n: TS.Node) => `${fileName.replace(/\\/g, "/")}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${n.getText(sf)}`;
  const visit = (n: TS.Node) => {
    // A NUMBER, not a string: "bg-primary/[0.07]" is a colour, not a rate.
    if (ts.isNumericLiteral(n) && Number(n.text) === 0.07) hits.push(at(n));
    if ((ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) && ts.isIdentifier(n.name) && /^(DEFAULT_)?RISK_FREE/.test(n.name.text)) hits.push(at(n.name));
    n.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

describe("no second copy of the risk-free rate", () => {
  it("app/ and lib/analytics hold no `0.07` and no `RISK_FREE =` in code", () => {
    const files = [...sourceFiles("app"), ...sourceFiles("lib/analytics")];
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) => hardCodedRates(path.relative(process.cwd(), f), fs.readFileSync(f, "utf8")));
    expect(hits, "read the rate through getRiskFree() (lib/queries/settings.ts)").toEqual([]);
  });

  it("the guard SEES the class it guards (a comment naming it is not a hit)", () => {
    expect(hardCodedRates("a.ts", "const RISK_FREE = 0.07; // India ~7%")).toHaveLength(2);
    expect(hardCodedRates("b.ts", "export const DEFAULT_RISK_FREE_RATE = 0.07;")).toHaveLength(2);
    expect(hardCodedRates("c.ts", "const r = computeSharpe(xs, 0.07);")).toHaveLength(1);
    expect(hardCodedRates("d.tsx", '// was RISK_FREE = 0.07\nconst cls = "bg-primary/[0.07]"; const r = riskFree.annual;')).toEqual([]);
  });

  it("every consumer reads the ONE setting: both reports and the Greeks page call getRiskFree()", () => {
    for (const f of ["app/reports/performance/page.tsx", "app/reports/monthly/page.tsx", "app/risk/page.tsx"]) {
      expect(fs.readFileSync(f, "utf8"), f).toMatch(/getRiskFree\(\)/);
    }
    expect(fs.readFileSync("app/risk/page.tsx", "utf8")).toMatch(/portfolioGreeks\(greeksInputs, riskFree\.annual\)/);
  });
});

// ── 2. the pure parse ────────────────────────────────────────────────────────

describe("parseRiskFreeEdit — a percentage in, ppm stored, a real day not after today", () => {
  const TODAY = "2026-09-18";
  it("accepts 0% and 20% (the bounds) and rounds to whole ppm", () => {
    expect(parseRiskFreeEdit({ ratePct: "0", asOf: "2026-09-01" }, TODAY)).toEqual({ ok: true, ppm: 0, asOf: "2026-09-01" });
    expect(parseRiskFreeEdit({ ratePct: 20, asOf: TODAY }, TODAY)).toEqual({ ok: true, ppm: RISK_FREE_MAX_PPM, asOf: TODAY });
    expect(parseRiskFreeEdit({ ratePct: "6.5", asOf: TODAY }, TODAY)).toMatchObject({ ok: true, ppm: 65000 });
  });
  it("refuses a rate outside 0–200000 ppm, a blank, or not-a-number", () => {
    for (const ratePct of ["20.0001", "-0.5", "", "abc", null]) {
      expect(parseRiskFreeEdit({ ratePct, asOf: TODAY }, TODAY).ok, String(ratePct)).toBe(false);
    }
  });
  it("requires a real calendar day, not after today (IST)", () => {
    expect(parseRiskFreeEdit({ ratePct: "7", asOf: "" }, TODAY).ok).toBe(false);
    expect(parseRiskFreeEdit({ ratePct: "7", asOf: "2026-02-31" }, TODAY).ok).toBe(false);
    expect(parseRiskFreeEdit({ ratePct: "7", asOf: "18-09-2026" }, TODAY).ok).toBe(false);
    expect(parseRiskFreeEdit({ ratePct: "7", asOf: "2026-09-19" }, TODAY)).toEqual({ ok: false, message: "The as-of date cannot be in the future." });
  });
  it("labels the default as an assumption and a user's rate by its day", () => {
    expect(riskFreeOf(undefined, undefined)).toMatchObject({ ppm: DEFAULT_RISK_FREE_PPM, annual: 0.07, label: "7% · Vyuha default" });
    expect(riskFreeOf(65000, "2026-09-01")).toMatchObject({ annual: 0.065, pct: "6.5%", label: "6.5% · as of 2026-09-01" });
    expect(ppmToPct(72500)).toBe("7.25%");
  });
});

// ── 3. the route ─────────────────────────────────────────────────────────────

describe("POST /api/settings {type:'riskFree'}", () => {
  const post = async (body: Record<string, unknown>) => {
    const res = await settingsRoute.POST(
      new Request("http://localhost/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "riskFree", ...body }) }),
    );
    return { status: res.status, json: (await res.json()) as { ok: boolean; message: string } };
  };
  const stored = () => t.sqlite.prepare("SELECT risk_free_rate_ppm AS ppm, risk_free_as_of AS asOf FROM settings").get();

  it("a fresh install reads 7% · Vyuha default", () => {
    expect(stored()).toEqual({ ppm: 70000, asOf: null });
    expect(settingsQ.getRiskFree().label).toBe("7% · Vyuha default");
  });

  it("refuses out-of-range rates, a missing day and a future day — and writes nothing", async () => {
    for (const body of [{ ratePct: "25", asOf: "2026-09-01" }, { ratePct: "-1", asOf: "2026-09-01" }, { ratePct: "6.5" }, { ratePct: "6.5", asOf: "2999-01-01" }]) {
      const r = await post(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.json.ok).toBe(false);
    }
    expect(stored()).toEqual({ ppm: 70000, asOf: null });
  });

  it("stores ppm and the day, and every reader then says so", async () => {
    const r = await post({ ratePct: "6.5", asOf: "2026-09-01" });
    expect(r.status).toBe(200);
    expect(r.json.message).toContain("6.5% · as of 2026-09-01");
    expect(stored()).toEqual({ ppm: 65000, asOf: "2026-09-01" });
    expect(settingsQ.getRiskFree()).toMatchObject({ annual: 0.065, label: "6.5% · as of 2026-09-01" });
  });
});
