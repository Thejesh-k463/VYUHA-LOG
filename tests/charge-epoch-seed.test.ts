import { beforeAll, describe, expect, it } from "vitest";
import { openTempDb, type TempDb } from "./helpers/temp-db";

/**
 * THE SEEDER MUST NOT CLOBBER A HISTORICAL RATE EPOCH.
 *
 * Regression test for a BLOCKER an adversarial review reproduced against real
 * SQLite on 2026-08-30, before it shipped.
 *
 * `seed-core` refreshes `charge_config` on every desktop startup so corrected
 * broker rates reach existing installs. Its refresh path looked a row up by
 * (broker, plan, segment, exchange) — the PRE-0050 identity. The moment a key
 * held two dated epochs, that `.get()` returned an arbitrary one (SQLite walks
 * the window index in `effective_from` ASC order, so in practice the oldest),
 * and the update then wrote today's rate straight into the historical window.
 *
 * The failure was silent in every direction: the seeder logs "1 refreshed", the
 * settings screen shows two visually identical rows, and `/reports/charges`
 * reads stored values so it cannot contradict it either. The user would end up
 * with precisely the bug migration 0050 exists to fix.
 *
 * ONE temp database per FILE — `lib/db` caches its connection on globalThis
 * (tests/helpers/temp-db.ts), so `openTempDb` runs ONCE in `beforeAll` and the
 * tests below share the database DELIBERATELY and run in declaration order:
 * the second test rewrites the zerodha/future/NSE key, so it must come last.
 */

interface Row {
  broker: string;
  plan: string;
  segment: string;
  exchange: string;
  sttPct: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

describe("charge_config epochs survive a re-seed", () => {
  let t: TempDb;

  beforeAll(async () => {
    // `seed: true` runs seedDatabase once while opening the database.
    t = await openTempDb("epoch-seed", { seed: true });
  });

  const rows = (): Row[] => t.db.select().from(t.schema.chargeConfig).all() as unknown as Row[];
  const pick = (segment: string) =>
    rows().filter(
      (r) => r.broker === "zerodha" && r.plan === "default" && r.segment === segment && r.exchange === "NSE",
    );

  it("keeps the historical STT epoch intact, and invents no epoch where the statute did not move", async () => {
    const { seedDatabase } = await import("@/lib/db/seed-core");

    // --- Futures: FA 2026 moved this one, so it must carry TWO epochs. ------
    const before = pick("future");
    expect(before.length).toBe(2);
    const oldBefore = before.find((r) => r.effectiveFrom === "1970-01-01")!;
    const newBefore = before.find((r) => r.effectiveFrom === "2026-04-01")!;
    expect(oldBefore.sttPct).toBeCloseTo(0.0002, 10); // 0.02% up to 31-Mar-2026
    expect(newBefore.sttPct).toBeCloseTo(0.0005, 10); // 0.05% from 1-Apr-2026
    expect(oldBefore.effectiveTo).toBe("2026-04-01");
    expect(newBefore.effectiveTo).toBeNull();

    // --- THE REGRESSION: seed again, exactly as an app update does. ---------
    seedDatabase();

    const after = pick("future");
    expect(after.length).toBe(2); // no duplicate epoch created
    const oldAfter = after.find((r) => r.effectiveFrom === "1970-01-01")!;
    const newAfter = after.find((r) => r.effectiveFrom === "2026-04-01")!;

    // The historical window still carries the HISTORICAL rate. Before the fix
    // this read 0.0005 — today's rate written over the past.
    expect(oldAfter.sttPct).toBeCloseTo(0.0002, 10);
    expect(oldAfter.effectiveTo).toBe("2026-04-01");
    expect(newAfter.sttPct).toBeCloseTo(0.0005, 10);
    expect(newAfter.effectiveTo).toBeNull();

    // --- Equity delivery: explicitly "No Change" in circular 02/2026. -------
    // Splitting it would invent history that never happened.
    const delivery = pick("eq_delivery");
    expect(delivery.length).toBe(1);
    expect(delivery[0].effectiveFrom).toBe("1970-01-01");
    expect(delivery[0].effectiveTo).toBeNull();
    expect(delivery[0].sttPct).toBeCloseTo(0.001, 10);
  });

  /**
   * F2-seeder-shadow (verified 2026-08-30): `onConflictDoNothing` is keyed on
   * (broker, plan, segment, exchange, effective_from), so the 2026-04-01 seed
   * epoch never CONFLICTS with a user-edited 1970-01-01→open row — it inserted
   * cleanly beside it, `findRates` picks the NEWEST covering epoch, and the
   * seed row silently shadowed the user's verified rates for every trade dated
   * ≥ 2026-04-01. The seeder must skip any epoch whose start a user-edited
   * window covers.
   *
   * This test REWRITES the zerodha/future/NSE key, so it runs last in the file.
   */
  it("never inserts a seed epoch beside a user-edited row that covers it", async () => {
    const { chargeConfig } = t.schema;
    const { seedDatabase } = await import("@/lib/db/seed-core");
    const { and, eq } = await import("drizzle-orm");
    const { findRates, ratesMapOf } = await import("@/lib/engine/rates");
    type ChargeRates = import("@/lib/engine/types").ChargeRates;

    const key = and(
      eq(chargeConfig.broker, "zerodha"),
      eq(chargeConfig.plan, "default"),
      eq(chargeConfig.segment, "future"),
      eq(chargeConfig.exchange, "NSE"),
    );

    // Recreate migration 0050's landing state on an install where the user had
    // hand-verified this key: ONE row, stamped 1970-01-01 → open, userEdited.
    // The sttPct is deliberately a value the seed would never emit.
    t.db.delete(chargeConfig).where(key).run();
    t.db
      .insert(chargeConfig)
      .values({
        broker: "zerodha",
        plan: "default",
        segment: "future",
        exchange: "NSE",
        brokerageFlat: 20,
        sttPct: 0.000123,
        sttSide: "sell",
        userEdited: true,
        effectiveFrom: "1970-01-01",
        effectiveTo: null,
      })
      .run();

    // Exactly what an app update does on startup.
    seedDatabase();

    // The user's row is still the ONLY epoch on this key — the seeder inserted
    // nothing beside it and rewrote nothing in it. Before the fix this held
    // two rows: the user's, plus the 2026-04-01 seed epoch shadowing it.
    const after = pick("future");
    expect(after.length).toBe(1);
    expect(after[0].effectiveFrom).toBe("1970-01-01");
    expect(after[0].effectiveTo).toBeNull();
    expect(after[0].sttPct).toBeCloseTo(0.000123, 12);

    // And the rate that actually prices a post-epoch trade is the USER's.
    const map = ratesMapOf(after as unknown as ChargeRates[]);
    const rates = findRates(map, "zerodha", "future", "NSE", "2026-06-01");
    expect(rates.sttPct).toBeCloseTo(0.000123, 12);
  });
});
