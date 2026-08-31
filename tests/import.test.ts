import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// IMPORTANT: point the DB at a throwaway file BEFORE any module imports @/lib/db.
const TMP = path.join(os.tmpdir(), `vyuha-test-${process.pid}-${Date.now()}.sqlite`);
process.env.VYUHA_DB_PATH = TMP;

type CommitMod = typeof import("@/lib/import/commit");
type DetectMod = typeof import("@/lib/import/detect");

let commit: CommitMod;
let detect: DetectMod;
let dbMod: typeof import("@/lib/db");

beforeAll(async () => {
  dbMod = await import("@/lib/db");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(dbMod.db, { migrationsFolder: "./drizzle" });
  const { seedDatabase } = await import("@/lib/db/seed-core");
  seedDatabase();
  commit = await import("@/lib/import/commit");
  detect = await import("@/lib/import/detect");
});

function ctxFor(file: string) {
  const bytes = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", file));
  return detect.buildContext(file, bytes);
}

describe("Import pipeline — auto-detect", () => {
  it("detects Dhan CSV and Groww XLSX", () => {
    expect(detect.detectParser(ctxFor("dhan-pnl.csv"))?.sourceId).toBe("dhan-csv");
    expect(detect.detectParser(ctxFor("groww-pnl.xlsx"))?.sourceId).toBe("groww-xlsx");
  });
});

describe("Import pipeline — Dhan", () => {
  it("imports correct trades, buckets/segments and net P&L; re-import is idempotent", async () => {
    const ctx = ctxFor("dhan-pnl.csv");
    const parsed = await detect.detectParser(ctx)!.parse(ctx);

    const preview = commit.previewParsedFile(parsed);
    expect(preview.summary.total).toBe(122);
    expect(preview.summary.dupCount).toBe(0);
    // gross P&L ties out to the footer
    expect(Math.abs(preview.summary.grossPnl - (parsed.reported!.grossPnl))).toBeLessThanOrEqual(1);

    const res = commit.commitParsedFile(parsed, "dhan-pnl.csv");
    expect(res.added).toBe(122);
    expect(res.skipped).toBe(0);

    // verify rows in DB by segment
    const { db } = dbMod;
    const { trades } = await import("@/lib/db/schema");
    const all = db.select().from(trades).all();
    const dhan = all.filter((t) => t.broker === "dhan");
    const seg = (s: string) => dhan.filter((t) => t.segment === s).length;
    expect(seg("index_option")).toBe(79);
    expect(seg("stock_option")).toBe(36);
    expect(seg("commodity_option")).toBe(1);
    expect(seg("eq_delivery")).toBe(6);
    // buckets
    expect(dhan.filter((t) => t.bucket === "active").length).toBe(116);
    expect(dhan.filter((t) => t.bucket === "equity").length).toBe(6);
    // open positions (5 fully open + 1 partial)
    expect(dhan.filter((t) => t.isOpen).length).toBe(6);
    // net = gross - charges per row
    for (const t of dhan) {
      expect(Math.abs(t.netPnl - (t.grossPnl - t.chargesTotal))).toBeLessThan(0.02);
    }

    // RE-IMPORT same file → 0 added
    const reparsed = await detect.detectParser(ctx)!.parse(ctx);
    const res2 = commit.commitParsedFile(reparsed, "dhan-pnl.csv");
    expect(res2.added).toBe(0);
    expect(res2.skipped).toBe(122);
    expect(db.select().from(trades).all().filter((t) => t.broker === "dhan").length).toBe(122);
  });
});

describe("Import pipeline — Groww", () => {
  it("imports 85 intraday + 45 delivery; idempotent re-import", async () => {
    const ctx = ctxFor("groww-pnl.xlsx");
    const parsed = await detect.detectParser(ctx)!.parse(ctx);

    const res = commit.commitParsedFile(parsed, "groww-pnl.xlsx");
    expect(res.added).toBe(130);

    const { db } = dbMod;
    const { trades } = await import("@/lib/db/schema");
    const groww = db.select().from(trades).all().filter((t) => t.broker === "groww");
    expect(groww.filter((t) => t.segment === "eq_intraday").length).toBe(85);
    expect(groww.filter((t) => t.segment === "eq_delivery").length).toBe(45);
    expect(groww.filter((t) => t.isOpen).length).toBe(3); // open positions
    // dates normalized to ISO
    const withDate = groww.find((t) => t.buyDate);
    expect(withDate?.buyDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // re-import idempotent
    const reparsed = await detect.detectParser(ctx)!.parse(ctx);
    const res2 = commit.commitParsedFile(reparsed, "groww-pnl.xlsx");
    expect(res2.added).toBe(0);
    expect(res2.skipped).toBe(130);
  });
});

describe("Manual entry", () => {
  it("adds a manual option trade with computed charges; rejects duplicates", async () => {
    const { db } = dbMod;
    const { trades } = await import("@/lib/db/schema");
    const t = {
      broker: "zerodha" as const,
      tradingsymbol: "OPT NIFTY 26 Jun 2026 24000 CE",
      isin: null,
      buyQty: 50, avgBuyPrice: 200, buyValue: 10000,
      sellQty: 50, avgSellPrice: 240, sellValue: 12000,
      closingPrice: null, grossPnl: 2000, unrealisedPnl: 0,
      buyDate: null, sellDate: null, productHint: null, exchangeHint: null, sourceFile: "manual",
    };
    const res = commit.commitManualTrade(t, { setupTag: "breakout" });
    expect(res.id).toBeTruthy();
    const row = db.select().from(trades).where(eq(trades.id, res.id!)).get()!;
    expect(row.segment).toBe("index_option");
    expect(row.bucket).toBe("active");
    expect(row.optionType).toBe("CE");
    expect(row.chargesTotal).toBeCloseTo(74.32, 2);
    expect(row.setupTag).toBe("breakout");
    // duplicate guard
    expect(commit.commitManualTrade(t, {}).duplicate).toBe(true);
  });
});

describe("Override persistence", () => {
  it("re-tags a trade, recomputes, and re-applies on re-import (keyed by dedup_hash)", async () => {
    const { db } = dbMod;
    const { trades, classificationOverrides } = await import("@/lib/db/schema");
    const target = db.select().from(trades).all().find(
      (t) => t.broker === "groww" && t.segment === "eq_delivery" && !t.isOpen,
    )!;
    const beforeCharges = target.chargesTotal;

    commit.applyOverride(target.id, { isMtf: true, setupTag: "swing" });
    const after = db.select().from(trades).where(eq(trades.id, target.id)).get()!;
    expect(after.segment).toBe("eq_mtf");
    expect(after.bucket).toBe("equity");
    expect(after.setupTag).toBe("swing");
    // MTF delivery adds DP charge on sell → charges differ from plain delivery
    expect(after.chargesTotal).not.toBe(beforeCharges);

    const ov = db
      .select()
      .from(classificationOverrides)
      .where(eq(classificationOverrides.dedupHash, target.dedupHash))
      .get();
    expect(ov?.segment).toBe("eq_mtf");

    // Delete the trade, re-import the file → the override must re-apply.
    db.delete(trades).where(eq(trades.id, target.id)).run();
    const ctx = ctxFor("groww-pnl.xlsx");
    const parsed = await detect.detectParser(ctx)!.parse(ctx);
    commit.commitParsedFile(parsed, "groww-pnl.xlsx");
    const reimported = db.select().from(trades).all().find((t) => t.dedupHash === target.dedupHash)!;
    expect(reimported.segment).toBe("eq_mtf");
    expect(reimported.bucket).toBe("equity");

    // B5 — a derived fact must not wear a reported fact's clothes: the Groww
    // file states no per-trade MTF interest, so the row that just became
    // eq_mtf must say its interest figure is an engine estimate.
    expect(reimported.importNotes).toContain("estimated from your configured rates");
  });
});

describe("applyOverride — MTF accrual follows the segment (B4)", () => {
  const sum = (t: { brokerage: number; sttCtt: number; exchangeTxn: number; sebi: number; stampDuty: number; ipft: number; gst: number; dpCharges: number; mtfInterest: number; pledgeCharges: number }) =>
    t.brokerage + t.sttCtt + t.exchangeTxn + t.sebi + t.stampDuty + t.ipft + t.gst + t.dpCharges + t.mtfInterest + t.pledgeCharges;

  it("eq_delivery → eq_mtf recomputes interest, funded amount, total and net coherently", async () => {
    const { db } = dbMod;
    const { trades } = await import("@/lib/db/schema");
    const res = commit.commitManualTrade(
      {
        broker: "zerodha", tradingsymbol: "RELIANCE", isin: null,
        buyQty: 100, avgBuyPrice: 2500, buyValue: 250000,
        sellQty: 100, avgSellPrice: 2600, sellValue: 260000,
        closingPrice: null, grossPnl: 10000, unrealisedPnl: 0,
        buyDate: "2026-01-05", sellDate: "2026-02-04", // 30 held days
        productHint: null, exchangeHint: null, sourceFile: "manual",
      },
      { forcedSegment: "eq_delivery" },
    );
    expect(res.id).toBeTruthy();

    expect(commit.applyOverride(res.id!, { segment: "eq_mtf" })).toBe(true);
    const mtf = db.select().from(trades).where(eq(trades.id, res.id!)).get()!;
    expect(mtf.segment).toBe("eq_mtf");
    // Interest accrued for the 30 closed days on an estimated funded principal.
    expect(mtf.mtfFundedAmount).toBeGreaterThan(0);
    expect(mtf.mtfInterest).toBeGreaterThan(0);
    // The stored breakdown sums to the stored total, and net follows.
    expect(sum(mtf)).toBeCloseTo(mtf.chargesTotal, 1);
    expect(mtf.netPnl).toBeCloseTo(mtf.grossPnl - mtf.chargesTotal, 2);
  });

  it("eq_mtf → eq_delivery zeroes interest and pledge so the breakdown still sums", async () => {
    const { db } = dbMod;
    const { trades } = await import("@/lib/db/schema");
    const row = db.select().from(trades).all().find((t) => t.tradingsymbol === "RELIANCE" && t.segment === "eq_mtf")!;
    expect(commit.applyOverride(row.id, { segment: "eq_delivery" })).toBe(true);
    const back = db.select().from(trades).where(eq(trades.id, row.id)).get()!;
    expect(back.segment).toBe("eq_delivery");
    expect(back.mtfInterest).toBe(0);
    expect(back.pledgeCharges).toBe(0);
    expect(back.mtfFundedAmount).toBeNull();
    expect(sum(back)).toBeCloseTo(back.chargesTotal, 1);
    expect(back.netPnl).toBeCloseTo(back.grossPnl - back.chargesTotal, 2);
  });
});
