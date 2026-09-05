import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRO_FEATURES } from "@/lib/license";

/**
 * T2 — the CLIENT half of `/live`'s partial gate.
 *
 * `tests/pro-gating.test.ts` proves the PAGE side: `/live` is `partial: true`,
 * so it reads `getEntitlement()` and carries no <ProGate> (invariant 7 — a
 * user's own record of their trades is never held hostage). Nothing tested the
 * other half: that the client actually locks the Pro cells, and that the server
 * does not ship the numbers behind them anyway.
 *
 * Both are SOURCE guards on comment-stripped source, in the family of
 * `tests/live-route-budget.test.ts`. What they assert is that the mechanism is
 * wired — a `pro` prop that stops being read, or one `!pro` branch quietly
 * deleted in a refactor, changes nothing that any other test can see. The
 * BEHAVIOURAL half (a `pro:false` payload carrying no Pro numbers) needs a
 * database and lives in `tests/live-page.test.ts`, which already owns this
 * file-scoped temp DB — a second `openTempDb()` in a second file is a second
 * migrated database for three assertions.
 */

const root = path.resolve(__dirname, "..");
const stripComments = (src: string) =>
  src.replace(/(?<![\w,*])\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (p: string) => stripComments(readFileSync(path.join(root, p), "utf8"));

const TRACKER = "components/live/tracker-client.tsx";
const LOADER = "components/live/load-desk.ts";
const PAGE = "app/live/page.tsx";

describe("/live is a PARTIAL feature, and both halves say so", () => {
  it("the registry still calls it partial — the page gate would be invariant 7", () => {
    const live = PRO_FEATURES.find((f) => f.href === "/live");
    expect(live, "/live left PRO_FEATURES").toBeDefined();
    expect(live!.partial).toBe(true);
  });

  it("the page reads the entitlement and HANDS IT TO THE LOADER", () => {
    const src = read(PAGE);
    expect(src).toContain("getEntitlement()");
    // Reading it and using it only as a prop is the bug G2 found: the loader
    // computed every Pro figure regardless and the page shipped them.
    expect(src, "the loader must be told, or it computes the Pro fields anyway").toMatch(
      /loadLiveDesk\(\s*\{\s*pro\s*\}\s*\)/,
    );
    expect(src).toContain("pro={pro}");
  });
});

describe("the client locks what it is not entitled to show", () => {
  it("imports ProLock and consumes a `pro` prop", () => {
    const src = read(TRACKER);
    expect(src).toMatch(/import\s*\{\s*ProLock\s*\}\s*from\s*"@\/components\/system\/pro-lock"/);
    expect(src).toMatch(/\{\s*data,\s*pro\s*\}\s*:\s*\{\s*data:\s*LiveDeskData;\s*pro:\s*boolean\s*\}/);
  });

  it("both summary rails branch on !pro — heat and sector concentration", () => {
    const src = read(TRACKER);
    const branches = [...src.matchAll(/!pro\s*(\|\|[^?]*)?\?/g)];
    expect(branches.length, "a !pro branch was deleted; the rail would render for a free user").toBe(2);
    expect(src).toContain("DESK_COPY.heatTitle");
    expect(src).toContain("DESK_COPY.concentrationTitle");
  });

  it("the three Pro columns are declared Pro and render a lock instead of a figure", () => {
    const src = read(TRACKER);
    for (const key of ["riskAtStopP", "openRPpm", "pctOfCapital"]) {
      expect(src, `${key} is no longer declared a Pro column`).toMatch(
        new RegExp(`key:\\s*"${key}"[^}]*pro:\\s*true`),
      );
    }
    expect(src).toMatch(/pro \? fmt\.money\(row\.riskAtStopP\) : <ProLock \/>/);
    expect(src).toMatch(/pro \? fmt\.rMultiple\(row\.openRPpm\) : <ProLock \/>/);
    expect(src).toMatch(/pro \? fmt\.pct\(row\.pctOfCapital\.ppm\) : <ProLock \/>/);
    expect(src).toContain("c.pro && !pro && <ProLock />");
  });

  it("the chart panel — the Pro overlay — is behind the same flag", () => {
    const src = read(TRACKER);
    const pane = src.slice(src.indexOf("function DetailPane"));
    expect(pane).toMatch(/\{pro \? \(/);
    expect(pane).toContain("<PositionChartPanel");
  });

  it("the guard can fire: an ungated rail and an unlocked cell both fail it", () => {
    const reverted = '<p>{fmt.pct(heat.heatPpm)}</p><td>{fmt.money(row.riskAtStopP)}</td>';
    expect([...reverted.matchAll(/!pro\s*(\|\|[^?]*)?\?/g)].length).toBe(0);
    expect(/pro \? fmt\.money\(row\.riskAtStopP\) : <ProLock \/>/.test(reverted)).toBe(false);
  });
});

describe("the server strips the Pro fields rather than trusting the client to hide them", () => {
  it("the loader takes the entitlement as a REQUIRED argument", () => {
    const src = read(LOADER);
    expect(src, "an optional flag defaults to a leak").toMatch(
      /export async function loadLiveDesk\(entitlement:\s*\{\s*pro:\s*boolean\s*\}\)/,
    );
    expect(src).not.toMatch(/pro\s*=\s*true/);
  });

  it("it nulls every Pro field on the way out, the way lens-edge nulls `edge`", () => {
    const src = read(LOADER);
    expect(src).toContain("riskAtStopP: null");
    expect(src).toContain("openRPpm: null");
    expect(src).toContain("riskAmountP: null");
    expect(src).toMatch(/pctOfCapital:\s*\{\s*ppm:\s*null,\s*denominator:\s*null\s*\}/);
    expect(src, "heat must be absent, not an empty decoy").toMatch(/entitlement\.pro\s*\?[^:]*portfolioHeat/);
    expect(src).toMatch(/entitlement\.pro\s*\?[^:]*sectorConcentration/);
  });
});
