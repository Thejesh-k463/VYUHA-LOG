import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { openTempDb, type TempDb } from "./helpers/temp-db";
import { parseDhanGtr } from "@/lib/import/parsers/dhan-gtr";
import { parseDhanCsv } from "@/lib/import/parsers/dhan-csv";

/**
 * THE definitive cross-source test, on the user's own real files (PII
 * sanitised; every transaction row byte-identical to the originals):
 *
 *   1. a Dhan Global Transaction Report for 01–29 Jul, imported first
 *   2. the Dhan P&L export for 01–26 Jul — THE SAME TRADES, stated the way a
 *      P&L file states them: scrip-aggregated, no dates, both legs merged
 *
 * Importing both is exactly how the user's journal ended up with a costless
 * duplicate Reliance and "open" positions that were closed. The hash dedup
 * cannot catch it (different facts → different hashes); the cross-source check
 * exists precisely for this pair of files.
 */

const GTR = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "dhan-gtr-real.csv"), "utf8");
const PNL = fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "dhan-pnl-real.csv"), "utf8");

let t: TempDb;
let commit: typeof import("@/lib/import/commit");

beforeAll(async () => {
  t = await openTempDb("crosslive", { seed: true });
  commit = await import("@/lib/import/commit");
});

afterAll(() => t?.cleanup());

describe("the user's real GTR + P&L pair", () => {
  it("step 1 — the GTR commits cleanly", () => {
    const parsed = parseDhanGtr({ filename: "dhan-gtr-real.csv", text: GTR });
    expect(parsed.trades.length).toBeGreaterThan(50);
    const res = commit.commitParsedFile(parsed, "dhan-gtr-real.csv");
    expect(res.added).toBeGreaterThan(50);
    expect(res.skipped).toBe(0);
  });

  it("step 2 — previewing the P&L export warns about nearly every row", () => {
    const parsed = parseDhanCsv({ filename: "dhan-pnl-real.csv", text: PNL });
    expect(parsed.trades.length).toBeGreaterThan(50);

    const preview = commit.previewParsedFile(parsed, null, null, "dhan-pnl-real.csv");

    // The hash dedup sees almost none of them — that is the hole.
    expect(preview.summary.dupCount).toBeLessThan(5);

    // The cross-source check sees the overlap and calls it risky.
    const cs = preview.crossSource!;
    expect(cs.risky).toBe(true);
    expect(cs.collisions.length).toBeGreaterThan(30);
    expect(cs.message).toMatch(/different file/i);
    expect(cs.message).toMatch(/delete the earlier import/i);
  });

  it("step 3 — the exact symbols from the user's screenshots are flagged", () => {
    const parsed = parseDhanCsv({ filename: "dhan-pnl-real.csv", text: PNL });
    const cs = commit.previewParsedFile(parsed, null, null, "dhan-pnl-real.csv").crossSource!;
    const symbols = new Set(cs.collisions.map((c) => c.symbol.toUpperCase()));

    // Reliance: 1 share, open with cost in the GTR — the "no cost on record"
    // duplicate came from importing this P&L row on top of it.
    expect([...symbols].some((s) => s.includes("RELIANCE"))).toBe(true);
    // Sterlite and Bhansali: open in the P&L window (sold 27 Jul, after its
    // 26 Jul cutoff) — the "still open" ghosts.
    expect([...symbols].some((s) => s.includes("STERLITE"))).toBe(true);
    expect([...symbols].some((s) => s.includes("BHANSALI"))).toBe(true);
  });

  it("step 4 — every collision names the GTR as the earlier source", () => {
    const parsed = parseDhanCsv({ filename: "dhan-pnl-real.csv", text: PNL });
    const cs = commit.previewParsedFile(parsed, null, null, "dhan-pnl-real.csv").crossSource!;
    for (const c of cs.collisions) {
      expect(c.existing.sourceFile).toBe("dhan-gtr-real.csv");
    }
  });

  it("step 5 — re-previewing the GTR itself stays clean (same-file exclusion)", () => {
    // Re-importing the SAME file is the ordinary dedup's job; cross-source must
    // not shout about a file colliding with itself.
    const parsed = parseDhanGtr({ filename: "dhan-gtr-real.csv", text: GTR });
    const preview = commit.previewParsedFile(parsed, null, null, "dhan-gtr-real.csv");
    expect(preview.summary.dupCount).toBe(preview.summary.total); // all hash-dups
    expect(preview.crossSource?.collisions ?? []).toEqual([]);
  });
});
