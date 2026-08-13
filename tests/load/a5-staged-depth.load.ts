import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { openTempDb, tradeRow, type TempDb } from "../helpers/temp-db";
import { countStatements, report, time } from "./helpers/measure";

/**
 * A5 — staged positions at depth.
 *
 * `rebuildStagedTrade` writes one UPDATE per leg and then collapses the ladder
 * into the parent `trades` row. Until this test, `lib/queries/staged.ts`
 * contained ZERO `db.transaction` calls — every one of those writes committed
 * on its own.
 *
 * The speed is the lesser half. The real exposure is invariant 5: the parent
 * row always holds the aggregate. A crash between the leg writes and the parent
 * collapse left legs repriced and the aggregate stale, and NOTHING ON SCREEN
 * WOULD LOOK WRONG — every report, tracker and tax pack reads the flat parent
 * row and needs no knowledge that legs exist, so it would quietly describe a
 * ladder that no longer matched.
 *
 * The ABUSIVE tier here is depth, not count: one position with 500 legs, which
 * used to mean 501 separate commits and 500 windows to be interrupted in.
 */

const LEGS = 500;

let t: TempDb;
let staged: typeof import("@/lib/queries/staged");
let tradeId: number;

beforeAll(async () => {
  t = await openTempDb("a5-staged-depth", { seed: true });
  staged = await import("@/lib/queries/staged");

  const trade = t.db.insert(t.schema.trades).values(tradeRow({ symbol: "DEEP", tradingsymbol: "DEEP", staged: true })).returning().get();
  tradeId = trade.id;

  // A ladder that is mostly buys with a tail of sells, so the FIFO consumption
  // and the exit pricing both have real work to do.
  t.db.transaction((tx) => {
    for (let i = 0; i < LEGS; i++) {
      // Leg kinds are "entry" | "exit" (lib/db/schema.ts) — buy/sell is derived
      // from those plus DIRECTION, because a short's entry is a sell.
      const isEntry = i < LEGS * 0.8;
      tx.insert(t.schema.tradeLegs)
        .values({
          tradeId,
          kind: isEntry ? "entry" : "exit",
          seq: i + 1,
          tradeDate: "2026-03-02",
          qty: 10,
          price: 100 + (i % 50),
        })
        .run();
    }
  });
}, 600_000);
afterAll(() => t?.cleanup());

describe("A5 · a 500-leg staged position", () => {
  it("rolls the whole rebuild back when a write fails part-way", () => {
    /**
     * A BEHAVIOURAL atomicity proof, because the obvious instrument does not
     * work: better-sqlite3 pre-prepares BEGIN/COMMIT when the Database is
     * constructed, so they never pass through `prepare()` and counting them
     * finds zero whether or not a transaction is open. Verified directly
     * before writing this.
     *
     * So: interrupt it. Establish a clean baseline, then make the 10th leg
     * UPDATE throw and let the rebuild run into it. Unwrapped, the first nine
     * writes are already committed and the ladder is left half-repriced with a
     * stale parent — invariant 5 broken, invisibly. Wrapped, SQLite discards
     * all of them and the baseline is intact.
     */
    staged.rebuildStagedTrade(tradeId); // clean, fully-consistent baseline

    /**
     * A SENTINEL, because the obvious version of this test cannot fail.
     *
     * Re-running the rebuild recomputes the same charges it just wrote, so
     * comparing legs before and against after proves nothing: rolled back or
     * committed, the values are identical either way. Stamp every leg with a
     * value the engine can never produce, and any write that survives the
     * interruption is unmistakable.
     */
    const SENTINEL = -1;
    t.db.update(t.schema.tradeLegs).set({ chargesTotal: SENTINEL }).run();
    const before = t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === tradeId);
    expect(before.every((l) => l.chargesTotal === SENTINEL), "sentinel did not take").toBe(true);
    const beforeCharges = before.map((l) => l.chargesTotal ?? 0);

    const StatementProto = Object.getPrototypeOf(t.sqlite.prepare("SELECT 1")) as { run: (...a: unknown[]) => unknown };
    const originalRun = StatementProto.run;
    let legUpdates = 0;
    StatementProto.run = function patched(this: { source?: string }, ...args: unknown[]) {
      if (/update\s+["`]?trade_legs/i.test(this.source ?? "") && ++legUpdates === 10) {
        throw new Error("simulated crash mid-rebuild");
      }
      return originalRun.apply(this, args);
    };
    let threw: Error | null = null;
    try {
      staged.rebuildStagedTrade(tradeId);
    } catch (e) {
      threw = e as Error;
    } finally {
      StatementProto.run = originalRun;
    }

    expect(threw, "the injected failure did not reach the rebuild — the test is not testing anything").not.toBeNull();

    const after = t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === tradeId);
    expect(after.map((l) => l.chargesTotal ?? 0)).toEqual(beforeCharges);
    console.log(`    interrupted at leg update #10 of ${LEGS}: all ${before.length} legs unchanged`);
    report(time("interrupted rebuild rolled back", LEGS, () => {}), { test: "a5-atomicity", legUpdatesBeforeThrow: 10 });
  });

  it("leaves the parent aggregate agreeing with its legs", () => {
    staged.rebuildStagedTrade(tradeId);

    const legs = t.db.select().from(t.schema.tradeLegs).all().filter((l) => l.tradeId === tradeId);
    const parent = t.db.select().from(t.schema.trades).all().find((x) => x.id === tradeId)!;

    // Direction defaults to long, so entry legs are the buy side.
    const entryQty = legs.filter((l) => l.kind === "entry").reduce((s, l) => s + l.qty, 0);
    const exitQty = legs.filter((l) => l.kind === "exit").reduce((s, l) => s + l.qty, 0);

    expect(parent.buyQty, "parent buy quantity does not match the ladder").toBe(entryQty);
    expect(parent.sellQty, "parent sell quantity does not match the ladder").toBe(exitQty);
    // Charges are summed FROM the legs deliberately (a position filled in five
    // tranches really does pay five lots of brokerage), so this must hold too.
    const legCharges = legs.reduce((s, l) => s + (l.chargesTotal ?? 0), 0);
    expect(Math.abs((parent.chargesTotal ?? 0) - legCharges)).toBeLessThan(0.01);
  });

  it("reports the write cost of a deep ladder", () => {
    const { statements } = countStatements(t.sqlite, () => staged.rebuildStagedTrade(tradeId));
    const t0 = performance.now();
    staged.rebuildStagedTrade(tradeId);
    const ms = performance.now() - t0;
    console.log(`    ${LEGS} legs: ${statements} statements, ${ms.toFixed(0)} ms`);
    report({ label: `${LEGS}-leg rebuild cost`, ms, n: LEGS, perItemUs: (ms * 1000) / LEGS }, {
      test: "a5-cost",
      statements,
    });

    // Report-only on time; a sanity ceiling only. Per-leg UPDATEs are inherent
    // to repricing a ladder — one transaction is what makes them safe, not few.
    expect(ms, "a 500-leg rebuild should not take minutes").toBeLessThan(30_000);
    expect(fs.existsSync(t.dbPath)).toBe(true);
  });
});
