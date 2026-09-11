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
  exchangeTxnPct: number;
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

  it("keeps every historical epoch intact, and invents no epoch where no levy moved", async () => {
    const { seedDatabase } = await import("@/lib/db/seed-core");

    // --- Futures: STT moved on 1-Oct-2024 and 1-Apr-2026, the NSE charge on
    // 1-Apr-2023, 1-Apr-2024, 1-Oct-2024 and 1-Mar-2026 — so SIX epochs. ------
    const FUT = [
      // [effectiveFrom, effectiveTo, sttPct, exchangeTxnPct]
      ["1970-01-01", "2023-04-01", 0.000125, 0.00002], // STT 0.0125% up to 30-Sep-2024
      ["2023-04-01", "2024-04-01", 0.000125, 0.000019],
      ["2024-04-01", "2024-10-01", 0.000125, 0.0000188],
      ["2024-10-01", "2026-03-01", 0.0002, 0.0000173], // STT 0.02% 1-Oct-2024 .. 31-Mar-2026
      ["2026-03-01", "2026-04-01", 0.0002, 0.000018299],
      ["2026-04-01", null, 0.0005, 0.000018299], // STT 0.05% from 1-Apr-2026
    ];
    const shape = (rows: Row[]) =>
      [...rows]
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .map((r) => [r.effectiveFrom, r.effectiveTo, r.sttPct, r.exchangeTxnPct]);
    expect(shape(pick("future"))).toEqual(FUT);

    // --- THE REGRESSION: seed again, exactly as an app update does. ---------
    seedDatabase();

    // No duplicate epoch, and the historical windows still carry the HISTORICAL
    // rates. Before the fix the oldest read 0.0005 — today's rate written over the past.
    expect(shape(pick("future"))).toEqual(FUT);

    // --- MCX commodity futures: no levy moved, so one open row. Splitting it
    // would invent history that never happened. ---------------------------------
    const mcx = rows().filter(
      (r) => r.broker === "zerodha" && r.plan === "default" && r.segment === "commodity_future" && r.exchange === "MCX",
    );
    expect(mcx.map((r) => [r.effectiveFrom, r.effectiveTo])).toEqual([["1970-01-01", null]]);

    // --- Equity delivery: STT "No Change" in circular 02/2026 — every epoch
    // carries 0.1%; its epochs are the NSE exchange charge's alone. ------------
    const delivery = pick("eq_delivery");
    expect(delivery.map((r) => r.effectiveFrom).sort()).toEqual(["1970-01-01", "2023-04-01", "2024-04-01", "2024-10-01", "2026-03-01"]);
    for (const r of delivery) expect(r.sttPct).toBeCloseTo(0.001, 10);
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

  /**
   * seedDatabase() is ONE transaction (v4.3.0), like the desktop refresh: an
   * abort part-way through leaves charge_config exactly as it was. Before, each
   * row committed on its own, so a failure left a half-applied rate card.
   *
   * The seed walks brokers in BROKER_LIST order (dhan first, sahi last), so the
   * dhan epoch deleted here is re-INSERTED before the sahi row's UPDATE is
   * reached — and the planted trigger aborts that UPDATE. Runs last in the
   * file: it rewrites rows and plants a trigger.
   */
  it("is atomic: an abort mid-seed rolls back the rows the seed had already written", async () => {
    const { seedDatabase } = await import("@/lib/db/seed-core");
    const { sqlite } = t;
    const key = (broker: string, from: string) =>
      `broker = '${broker}' AND plan = 'default' AND segment = 'eq_delivery' AND exchange = 'NSE' AND effective_from = '${from}'`;
    expect(sqlite.prepare(`DELETE FROM charge_config WHERE ${key("dhan", "2023-04-01")}`).run().changes).toBe(1);
    expect(sqlite.prepare(`UPDATE charge_config SET brokerage_pct = 0.5 WHERE ${key("sahi", "2026-03-01")}`).run().changes).toBe(1);
    sqlite.exec(`CREATE TRIGGER planted_abort BEFORE UPDATE ON charge_config BEGIN SELECT RAISE(ABORT, 'planted abort'); END;`);
    const snap = () => sqlite.prepare("SELECT * FROM charge_config ORDER BY id").all();
    const before = snap();
    try {
      expect(() => seedDatabase()).toThrow(/planted abort/);
      // The dhan epoch the seed inserted before the abort is rolled back with it.
      expect(sqlite.prepare(`SELECT count(*) AS n FROM charge_config WHERE ${key("dhan", "2023-04-01")}`).get()).toEqual({ n: 0 });
      expect(snap()).toEqual(before);
    } finally {
      sqlite.exec("DROP TRIGGER planted_abort");
    }
  });
});
