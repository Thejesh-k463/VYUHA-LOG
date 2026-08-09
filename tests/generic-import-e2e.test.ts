import { describe, it, expect, beforeAll } from "vitest";

// IMPORTANT: point the DB at a throwaway file BEFORE any module imports @/lib/db.
// One temp database PER FILE — lib/db caches its connection on globalThis, so a
// second openTempDb in the same file would silently reuse the first.
import os from "node:os";
import path from "node:path";
const TMP = path.join(os.tmpdir(), `vyuha-generic-${process.pid}-${Date.now()}.sqlite`);
process.env.VYUHA_DB_PATH = TMP;

let commit: typeof import("@/lib/import/commit");
let detect: typeof import("@/lib/import/detect");
let dbMod: typeof import("@/lib/db");
let schema: typeof import("@/lib/db/schema");

beforeAll(async () => {
  dbMod = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbMod.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed-core");
  seedDatabase();
  commit = await import("@/lib/import/commit");
  detect = await import("@/lib/import/detect");
  schema = await import("@/lib/db/schema");
});

/**
 * A Kotak Neo tradebook, as far as Vyuha is concerned: a real broker whose
 * export format is published nowhere, so nothing can auto-detect it. This is
 * the exact case the owner reported — "why does import only work for a few
 * brokers" — and the generic column mapper is the answer.
 */
const KOTAK_LIKE = [
  "Trade Date,Scrip Code,Txn,Qty,Rate,Brokerage",
  "06-Jul-2026,GMBREW,B,650,100.00,25.50",
  "07-Jul-2026,GMBREW,S,650,110.00,27.00",
  "06-Jul-2026,TCS,B,10,3000.00,15.00",
].join("\n");

const ctx = () => detect.buildContext("MyTrades.csv", Buffer.from(KOTAK_LIKE, "utf8"));

describe("a broker nobody has a parser for, imported end to end", () => {
  it("no hand-written parser claims it — the generic source does", () => {
    const chosen = detect.detectParser(ctx());
    expect(chosen).not.toBeNull();
    expect(chosen!.sourceId).toBe("generic-table");
  });

  it("pass 1 returns the file's own headers and a usable suggestion", async () => {
    const chosen = detect.detectParser(ctx())!;
    const parsed = await chosen.parse(ctx());
    expect(parsed.format).toBe("generic-unmapped");
    expect(parsed.trades).toHaveLength(0); // nothing is invented before the user answers
    expect(parsed.table?.headers).toEqual(["Trade Date", "Scrip Code", "Txn", "Qty", "Rate", "Brokerage"]);
    expect(parsed.table?.totalRows).toBe(3);
    // The date/qty/rate columns are unambiguous and should be pre-filled.
    const s = parsed.table!.suggested;
    expect(s.date).toBe(0);
    expect(s.qty).toBe(3);
  });

  it("pass 2 with a user mapping produces real, correctly paired trades", async () => {
    const chosen = detect.detectParser(ctx())!;
    const c = ctx();
    c.generic = {
      broker: "kotakneo",
      mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 },
    };
    const parsed = await chosen.parse(c);

    expect(parsed.broker).toBe("kotakneo");
    expect(parsed.format).toBe("tradebook");
    // GMBREW's buy and sell pair into ONE closed trade; TCS stays open.
    expect(parsed.trades).toHaveLength(2);

    const gm = parsed.trades.find((t) => t.tradingsymbol === "GMBREW")!;
    expect(gm.buyQty).toBe(650);
    expect(gm.sellQty).toBe(650);
    expect(gm.buyDate).toBe("2026-07-06");
    expect(gm.sellDate).toBe("2026-07-07");
    expect(gm.grossPnl).toBe(6500);

    const tcs = parsed.trades.find((t) => t.tradingsymbol === "TCS")!;
    expect(tcs.sellQty).toBe(0);
    expect(tcs.sellDate).toBeNull();
  });

  it("commits to the journal, priced with the RIGHT broker's charge rates", async () => {
    const chosen = detect.detectParser(ctx())!;
    const c = ctx();
    c.generic = {
      broker: "kotakneo",
      mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 },
    };
    const parsed = await chosen.parse(c);
    const result = commit.commitParsedFile(parsed, "MyTrades.csv", null, null);

    expect(result.added).toBe(2);
    expect(result.broker).toBe("kotakneo");

    const rows = dbMod.db.select().from(schema.trades).all();
    expect(rows).toHaveLength(2);
    // The whole point: these are Kotak Neo trades, not Angel One trades.
    for (const r of rows) expect(r.broker).toBe("kotakneo");
    // Charges were computed, i.e. it went through the real engine.
    const closed = rows.find((r) => r.sellQty > 0)!;
    expect(closed.chargesTotal).toBeGreaterThan(0);
  });

  it("re-importing the same file adds nothing — dedup applies here too", async () => {
    const chosen = detect.detectParser(ctx())!;
    const c = ctx();
    c.generic = {
      broker: "kotakneo",
      mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 },
    };
    const parsed = await chosen.parse(c);
    const again = commit.commitParsedFile(parsed, "MyTrades.csv", null, null);
    expect(again.added).toBe(0);
    expect(again.skipped).toBe(2);
    expect(dbMod.db.select().from(schema.trades).all()).toHaveLength(2);
  });

  it("a wrong mapping imports NOTHING rather than garbage", async () => {
    // Symbol pointed at the quantity column: every row fails to read and the
    // file is refused. The alternative — importing rows named "650" — is how a
    // journal quietly becomes untrustworthy.
    const chosen = detect.detectParser(ctx())!;
    const c = ctx();
    c.generic = { broker: "kotakneo", mapping: { date: 0, tradingsymbol: 1, side: 3, qty: 3, price: 4 } };
    const parsed = await chosen.parse(c);
    expect(parsed.trades).toHaveLength(0);
    expect(parsed.warnings.join(" ")).toMatch(/skipped/i);
  });
});
