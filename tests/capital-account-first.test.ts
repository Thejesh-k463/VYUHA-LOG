import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * WS2 pre-req fix (v3.6) — capital resolution is ACCOUNT-FIRST everywhere.
 *
 * The performance page computed its capital base as
 * `(settings?.equityCapital ?? 0) + (settings?.activeCapital ?? 0)` — the
 * GLOBAL settings row — while every trade on the page is scoped to the
 * selected account. With two accounts, the second account's Sharpe, total
 * return and Monte Carlo all divided by the FIRST account's capital, and
 * nothing on screen looked broken (the invariant-8 failure shape, applied to
 * the denominator instead of the rows).
 *
 * `getBucketCapital()` in lib/queries/capital.ts now owns the one copy of the
 * `account ?? settings ?? 0` chain. This file proves both halves:
 *  1. the helper resolves account-first against a real migrated database, and
 *  2. the performance page actually uses it (source check — reverting the page
 *     to the settings-only read reddens here even though the maths would still
 *     be "correct" on any base).
 */

let t: TempDb;
let capital: typeof import("@/lib/queries/capital");

function selectAccount(id: number) {
  t.db.update(t.schema.settings).set({ selectedAccountId: id }).run();
}

beforeAll(async () => {
  t = await openTempDb("capital-first", { seed: true });
  capital = await import("@/lib/queries/capital");
  // Global (legacy) settings figures, distinct from every account figure so a
  // wrong fallback is unmistakable in the assertions.
  t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
  // Account 1 (seeded) carries NO capital of its own -> settings fallback.
  // Account 2 carries its own -> the account figure must win.
  t.db.insert(t.schema.accounts).values({ id: 2, name: "Swing", equityCapital: 500000, activeCapital: 70000 }).run();
});

afterAll(() => t?.cleanup());

describe("getBucketCapital resolves account-first", () => {
  it("uses the selected account's own capital when it has one", () => {
    selectAccount(2);
    const c = capital.getBucketCapital();
    expect(c.equityCapital).toBe(500000);
    expect(c.activeCapital).toBe(70000);
    expect(c.totalCapital).toBe(570000);
  });

  it("falls back to the settings figures only when the account carries none", () => {
    selectAccount(1);
    const c = capital.getBucketCapital();
    expect(c.equityCapital).toBe(111111);
    expect(c.activeCapital).toBe(22222);
    expect(c.totalCapital).toBe(133333);
  });

  it("the aggregate view falls back to settings (no single account to ask)", () => {
    selectAccount(0);
    const c = capital.getBucketCapital();
    expect(c.totalCapital).toBe(133333);
  });

  it("capital unknown stays 0 — never an invented base (invariant 6)", () => {
    selectAccount(1);
    t.db.update(t.schema.settings).set({ equityCapital: 0, activeCapital: 0 }).run();
    const c = capital.getBucketCapital();
    expect(c.totalCapital).toBe(0); // page renders "—" + nudge on this
    t.db.update(t.schema.settings).set({ equityCapital: 111111, activeCapital: 22222 }).run();
  });

  it("agrees with getCapitalSummary (which now delegates to it)", () => {
    selectAccount(2);
    const s = capital.getCapitalSummary();
    expect(s.equityCapital).toBe(500000);
    expect(s.activeCapital).toBe(70000);
    expect(s.totalCapital).toBe(570000);
  });
});

describe("the performance page reads capital through the helper", () => {
  const src = readFileSync(path.join(process.cwd(), "app/reports/performance/page.tsx"), "utf8");

  it("derives its base from getBucketCapital, not the raw settings row", () => {
    expect(src).toMatch(/getBucketCapital\(\)\.totalCapital/);
  });

  it("no longer sums the global settings capital columns (red-on-revert)", () => {
    expect(src).not.toMatch(/settings\?\.equityCapital\s*\?\?\s*0\)\s*\+\s*\(settings\?\.activeCapital/);
  });
});
