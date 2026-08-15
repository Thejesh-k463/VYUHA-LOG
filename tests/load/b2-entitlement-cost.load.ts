import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "../helpers/temp-db";
import { countStatements, report, time } from "./helpers/measure";

/**
 * B2 — what an entitlement read costs.
 *
 * `getEntitlement()` runs on essentially every Pro-gated render (React `cache`
 * makes it once per request, but every request). Two things are measured:
 *
 *   1. SQL statements per call, in steady state. The clock high-water mark is
 *      guarded by `now > mark`, which is true one millisecond after the last
 *      write — so the guard never guards, and every render of every Pro page
 *      is a SQLite UPDATE. That is the app's most frequent writer, on a WAL
 *      file that every other read shares. A ratchet only needs to move when
 *      the DAY moves.
 *   2. Wall time per call, reported only. `verifyLicenseKey` re-parses the
 *      PEM public key on every call and hashes the key twice; those live in
 *      lib/license.ts (pure) and are outside this test's fix scope, so the
 *      number is recorded for the decision log rather than asserted.
 *
 * VYUHA_VAULT_PROVIDER=machine pins the vault wrap so the temp DB's vault key
 * behaves the same on every OS (tests/vault.test.ts does the same).
 */

process.env.VYUHA_VAULT_PROVIDER = "machine";

let t: TempDb;
let lic: typeof import("@/lib/queries/license");

beforeAll(async () => {
  t = await openTempDb("b2-entitlement", { seed: true });
  lic = await import("@/lib/queries/license");
});
afterAll(() => t?.cleanup());

const CALLS = 200;

describe("B2 · entitlement read cost", () => {
  it("does not write the clock high-water mark on every read", () => {
    // First call: may stamp the trial and the mark. That is legitimate.
    lic.getEntitlement();
    const before = t.sqlite.prepare("select clock_high_water_mark as m from settings").get() as { m: string | null };
    expect(before.m).not.toBeNull();

    // Steady state: CALLS reads within the same day.
    let updates = 0;
    const origPrepare = t.sqlite.constructor.prototype.prepare;
    let result: { statements: number } | null = null;
    try {
      // Count UPDATEs specifically alongside total statements.
      t.sqlite.constructor.prototype.prepare = function patched(this: unknown, sqlText: string, ...rest: unknown[]) {
        if (/^\s*update\s+/i.test(sqlText)) updates++;
        return origPrepare.call(this, sqlText, ...rest);
      };
      // Renders are milliseconds apart, not microseconds: back-to-back calls
      // land in the same millisecond and the `now > mark` guard happens to
      // hold, which understates the write rate 10× (measured: 16 UPDATEs for
      // 200 calls in 15 ms — one per elapsed millisecond). Space them ≥ 1 ms.
      const spin = () => { const until = performance.now() + 1.05; while (performance.now() < until) { /* spin */ } };
      const timing = time(`getEntitlement × ${CALLS}`, CALLS, () => {
        result = countStatements(t.sqlite, () => {
          for (let i = 0; i < CALLS; i++) { spin(); lic.getEntitlement(); }
        });
      });
      report(timing, { test: "b2", statements: result!.statements, updates });
      console.log(`    ${CALLS} calls: ${result!.statements} statements, ${updates} UPDATEs, ${timing.perItemUs.toFixed(0)} µs/call`);
    } finally {
      t.sqlite.constructor.prototype.prepare = origPrepare;
    }

    const after = t.sqlite.prepare("select clock_high_water_mark as m from settings").get() as { m: string | null };
    // The mark must still be a valid, non-null timestamp no earlier than before.
    expect(after.m).not.toBeNull();
    expect(new Date(after.m!).getTime()).toBeGreaterThanOrEqual(new Date(before.m!).getTime());

    // Reads in the same day must not each be a write. Allow a handful for
    // legitimate reasons (a day boundary crossed mid-test), never one per read.
    expect(
      updates,
      `${updates} UPDATE statements for ${CALLS} entitlement reads in the same day — the clock ratchet writes on every render (guard is now > mark, true after 1 ms).`,
    ).toBeLessThan(CALLS / 10);
    // And the whole read should be O(1) statements: a SELECT, not a SELECT + UPDATE.
    expect(result!.statements).toBeLessThanOrEqual(CALLS * 1 + 5);
  });

  it("reports the pure per-read cost (no spacing) for the decision log", () => {
    // Report-only: this is where a memoised PEM / single SHA-256 would show,
    // both of which live in lib/license.ts and are outside this test's scope.
    for (let i = 0; i < 50; i++) lic.getEntitlement(); // warm
    const timing = time("getEntitlement × 1,000, back-to-back", 1_000, () => {
      for (let i = 0; i < 1_000; i++) lic.getEntitlement();
    });
    report(timing, { test: "b2-pure" });
    console.log(`    pure read: ${timing.perItemUs.toFixed(0)} µs/call`);
  });

  it("still advances the mark when the day changes (the ratchet is coarser, not gone)", () => {
    // Wind the stored mark back two days: the next read must move it forward.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    t.sqlite.prepare("update settings set clock_high_water_mark = ?").run(twoDaysAgo);
    lic.getEntitlement();
    const row = t.sqlite.prepare("select clock_high_water_mark as m from settings").get() as { m: string };
    expect(new Date(row.m).getTime()).toBeGreaterThan(new Date(twoDaysAgo).getTime() + 86_400_000);
  });
});
