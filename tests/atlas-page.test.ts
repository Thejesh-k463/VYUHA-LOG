import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

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
        "myNames",
        "notAdviceLine",
        "payload",
        "provenanceLine",
        "rotationCaveat",
        "sessions",
        "snapshot",
        "specVersion",
        "volumeLeaders",
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

describe("the page file itself", () => {
  const page = fs.readFileSync(path.join(ROOT, "app/atlas/page.tsx"), "utf8");

  it("is force-dynamic, because it reads the database", () => {
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("wraps the body in <ProGate> and falls back to the static preview", () => {
    expect(page).toContain("<ProGate>");
    expect(page).toContain("<AtlasPreview />");
    expect(page).toMatch(/data\.view \? <AtlasPanel/);
  });

  it("makes exactly one loader call", () => {
    expect(page.match(/getAtlasPageData\(\)/g)).toHaveLength(1);
  });
});
