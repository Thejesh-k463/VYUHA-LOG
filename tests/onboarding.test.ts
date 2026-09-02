import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * WS3 — the first-run onboarding flag (`settings.onboarding_completed_at`,
 * migration 0057) through its ROUTE, against a real migrated temp DB.
 *
 * Wave 1 pinned the CONSTANT (the column is absent from
 * BASELINE_SETTINGS_FIELDS and present in SETTINGS_MACHINE_COLUMNS). This file
 * pins the EFFECT: completing, resetting, the completion timestamp being a
 * fact recorded once, and "Back to my defaults" neither re-running a wizard the
 * user finished nor undoing a reset they asked for.
 *
 * It also pins the two SEED PROFILES live rather than by reading source: the
 * desktop template (VYUHA_SEED_CLEAN=1) must leave the flag NULL so a fresh
 * install sees the wizard, while the dev/e2e profile must stamp it — the
 * Playwright suite shares ONE database and specs must not assume they run
 * first, so a modal over the app on first navigation would fail whichever spec
 * happened to go first.
 *
 * ONE temp database per FILE: lib/db caches its connection on globalThis.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let t: TempDb;
let route: typeof import("@/app/api/onboarding/route");
let baseline: typeof import("@/lib/queries/settings-baseline");

function req(body: unknown): Request {
  return new Request("http://local/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function flag(): string | null {
  const row = t.sqlite.prepare("select onboarding_completed_at as f from settings limit 1").get() as { f: string | null } | undefined;
  return row?.f ?? null;
}

beforeAll(async () => {
  t = await openTempDb("onboarding", { seed: true });
  route = await import("@/app/api/onboarding/route");
  baseline = await import("@/lib/queries/settings-baseline");
});

afterAll(() => {
  delete process.env.VYUHA_SEED_CLEAN;
  t?.cleanup();
});

describe("the dev/e2e seed stamps the flag", () => {
  it("so the shared e2e database never opens a wizard over a spec", () => {
    // openTempDb seeded WITHOUT VYUHA_SEED_CLEAN — the dev/e2e profile.
    expect(flag()).not.toBeNull();
  });
});

describe("the route sets and clears it", () => {
  it("reset clears the flag and says the wizard will run again", async () => {
    const res = await route.POST(req({ action: "reset" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, onboardingCompletedAt: null });
    expect(flag()).toBeNull();
  });

  it("complete sets it", async () => {
    const res = await route.POST(req({ action: "complete" }));
    expect(res.status).toBe(200);
    expect(flag()).not.toBeNull();
  });

  it("completing again keeps the FIRST timestamp — when this install finished its first run is one fact", async () => {
    t.sqlite.prepare("update settings set onboarding_completed_at = '2020-01-01T00:00:00.000Z'").run();
    expect((await route.POST(req({ action: "complete" }))).status).toBe(200);
    expect(flag()).toBe("2020-01-01T00:00:00.000Z");
  });

  it("400s anything that is not complete/reset", async () => {
    for (const body of [{ action: "skip" }, {}, { action: "" }, { action: true }, null]) {
      expect((await route.POST(req(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("leaves an audit trail for the toggle, like the Telegram switch", () => {
    const rows = t.db.select().from(t.schema.auditLog).all().filter((r) => (r.summary ?? "").includes("First-run setup"));
    expect(rows.length).toBeGreaterThanOrEqual(2); // at least one complete and one reset
  });
});

describe('"Back to my defaults" is choices, not install state', () => {
  /**
   * Each case carries a CONTROL — a genuine baseline field moved alongside the
   * flag. Without it these would pass just as happily if restoreBaseline() had
   * done nothing at all, which is the one way this assertion could go vacuous.
   */
  const theme = () => (t.sqlite.prepare("select theme as v from settings limit 1").get() as { v: string }).v;
  const density = () => (t.sqlite.prepare("select density as v from settings limit 1").get() as { v: string }).v;

  it("a baseline captured while completed does not un-reset the wizard", () => {
    // Complete → capture → reset → restore. The flag must stay NULL: restoring
    // preferences must never re-mark a first run the user asked to see again.
    t.sqlite.prepare("update settings set onboarding_completed_at = '2026-01-01T00:00:00.000Z', theme = 'dark'").run();
    expect(baseline.saveCurrentAsBaseline().ok).toBe(true);
    t.sqlite.prepare("update settings set onboarding_completed_at = null, theme = 'light'").run();

    expect(baseline.restoreBaseline().ok).toBe(true);
    expect(theme()).toBe("dark"); // control: the restore really ran
    expect(flag()).toBeNull(); // … and did not touch install state
  });

  it("…and a baseline captured while unset does not hide a wizard from someone mid-setup", async () => {
    t.sqlite.prepare("update settings set density = 'compact'").run();
    expect(baseline.saveCurrentAsBaseline().ok).toBe(true); // captured with the flag NULL
    expect((await route.POST(req({ action: "complete" }))).status).toBe(200);
    const set = flag();
    expect(set).not.toBeNull();
    t.sqlite.prepare("update settings set density = 'comfortable'").run();

    expect(baseline.restoreBaseline().ok).toBe(true);
    expect(density()).toBe("compact"); // control
    expect(flag()).toBe(set);
  });
});

describe("the desktop template leaves it NULL", () => {
  /**
   * The seed profile is chosen at MODULE LOAD (`const CLEAN =
   * process.env.VYUHA_SEED_CLEAN === "1"` in lib/db/seed-core.ts), so the CLEAN
   * branch needs a fresh module registry. vi.resetModules() gives one, and the
   * fresh lib/db reuses the SAME connection (it caches on globalThis), so the
   * re-seed lands in this very database — which is why the settings row is
   * cleared first: seedDatabase() is idempotent and would otherwise keep the
   * dev row it already wrote.
   */
  it("a clean seed leaves the flag NULL so a fresh install sees the wizard", async () => {
    t.db.delete(t.schema.settings).run();
    process.env.VYUHA_SEED_CLEAN = "1";
    vi.resetModules();
    const { seedDatabase } = await import("@/lib/db/seed-core");
    seedDatabase();

    expect(t.sqlite.prepare("select count(*) as n from settings").get()).toMatchObject({ n: 1 });
    expect(flag()).toBeNull();
    // …and it really is the clean profile that ran.
    expect(t.sqlite.prepare("select go_live_date as g from settings limit 1").get()).toMatchObject({ g: "1970-01-01" });
  });
});
