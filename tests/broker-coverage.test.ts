import { describe, it, expect, beforeAll } from "vitest";

// One temp database per FILE (lib/db caches its connection on globalThis).
import os from "node:os";
import path from "node:path";
const TMP = path.join(os.tmpdir(), `vyuha-coverage-${process.pid}-${Date.now()}.sqlite`);
process.env.VYUHA_DB_PATH = TMP;

import { BROKERS } from "@/lib/domain/constants";

let dbMod: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");

beforeAll(async () => {
  dbMod = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbMod.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed-core");
  seedDatabase();
  schema = await import("@/lib/db/schema");
});

/**
 * EVERY BROKER THE APP OFFERS MUST BE FULLY EQUIPPED.
 *
 * `tests/broker-rates.test.ts` already guards charge_config this way. The same
 * guard did not exist for margin_config: a broker added to BROKERS with no
 * margin rows would price every position at a default and nothing would fail.
 * Adding a broker should break a test, not silently ship a half-supported one.
 */
describe("margin_config covers every broker the app offers", () => {
  it("each broker has a margin row for each segment it can trade", () => {
    const rows = dbMod.db.select().from(schema.marginConfig).all();
    const bySegment = new Set(rows.map((r) => r.segment));
    expect(bySegment.size).toBeGreaterThan(0);

    for (const broker of BROKERS) {
      const mine = rows.filter((r) => r.broker === broker);
      expect(mine.length, `${broker} has no margin_config rows at all`).toBeGreaterThan(0);
      for (const segment of bySegment) {
        expect(
          mine.some((r) => r.segment === segment),
          `${broker} is missing a margin row for ${segment}`,
        ).toBe(true);
      }
    }
  });

  it("every margin percentage is a real percentage", () => {
    for (const r of dbMod.db.select().from(schema.marginConfig).all()) {
      expect(r.marginPct, `${r.broker}/${r.segment}`).toBeGreaterThan(0);
      expect(r.marginPct, `${r.broker}/${r.segment}`).toBeLessThanOrEqual(100);
    }
  });

  it("no broker outside the canonical list has snuck into the seed", () => {
    // The reverse direction: a typo like "kotak-neo" would create rows that
    // nothing ever reads, and the real broker would fall back to defaults.
    const seeded = new Set(dbMod.db.select().from(schema.marginConfig).all().map((r) => r.broker));
    for (const b of seeded) {
      expect(BROKERS as readonly string[], `${b} is seeded but not in BROKERS`).toContain(b);
    }
  });
});
