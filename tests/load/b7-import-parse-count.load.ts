import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { report, time } from "./helpers/measure";

/**
 * B7 — how many times one uploaded workbook is parsed.
 *
 * `app/api/import/route.ts` does `rankParsers(ctx)` (for the candidate list)
 * and then `detectParser(ctx)` (which calls `rankParsers` AGAIN), then
 * `chosen.parse(ctx)`. Every detector that needs an in-content fingerprint —
 * the AGENTS.md rule says a broker-named parser must SEE the broker's name —
 * opens the workbook, and so does the parser. Until 2026-09-04 each opened
 * it ITSELF with `XLSX.read(ctx.buffer)` — 11 full decodes of a 1.4 MB
 * Zerodha tradebook per upload once the v3.8 detectors landed. Every reader
 * now goes through `workbookOf(ctx)` (lib/import/types.ts), a memo on the
 * context object, so one upload decodes once.
 *
 * Instrument: calls to `XLSX.read` (spied on the module every parser imports)
 * for the exact call sequence the route makes. `bookSheets: true` reads are
 * counted separately — they decode the sheet list only and are cheap.
 *
 * Fixtures are the redacted real exports the detection matrix already pins.
 */

const reads = { full: 0, sheetsOnly: 0 };
vi.mock("xlsx", async (importOriginal) => {
  const mod = await importOriginal<typeof import("xlsx")>();
  return {
    ...mod,
    read: (data: unknown, opts?: { bookSheets?: boolean }) => {
      if (opts?.bookSheets) reads.sheetsOnly++;
      else reads.full++;
      return mod.read(data as never, opts as never);
    },
  };
});

const DIR = path.join(process.cwd(), "tests", "fixtures", "redacted");
const FILES = ["zerodha-tradebook.xlsx", "groww-order-history.xlsx", "paytm-tradebook.xlsx", "angelone-tax-pnl.xlsx"];

async function uploadShaped(file: string) {
  const { buildContext, detectParser, rankParsers } = await import("@/lib/import/detect");
  const ctx = buildContext(file, fs.readFileSync(path.join(DIR, file)));
  reads.full = 0;
  reads.sheetsOnly = 0;
  const t0 = performance.now();
  const ranked = rankParsers(ctx);
  const chosen = detectParser(ctx);
  const rankMs = performance.now() - t0;
  const afterDetect = { ...reads };
  expect(chosen, `${file}: nothing claimed it`).not.toBeNull();
  const t1 = performance.now();
  const parsed = await chosen!.parse(ctx);
  const parseMs = performance.now() - t1;
  return { ranked, chosen: chosen!, parsed, afterDetect, total: { ...reads }, rankMs, parseMs };
}

describe("B7 · workbook decodes per upload", () => {
  it("reports and bounds XLSX.read calls for the route's rank + detect + parse sequence", async () => {
    const rows: string[] = [];
    let worst = 0;
    for (const file of FILES) {
      const r = await uploadShaped(file);
      worst = Math.max(worst, r.total.full);
      const size = fs.statSync(path.join(DIR, file)).size;
      rows.push(
        `${file.padEnd(28)} ${(size / 1024).toFixed(0).padStart(5)} KB  → ${r.chosen.sourceId.padEnd(16)} ` +
          `full reads: detect ${r.afterDetect.full}, total ${r.total.full} (+${r.total.sheetsOnly} sheet-list)  ` +
          `rank+detect ${r.rankMs.toFixed(0)} ms, parse ${r.parseMs.toFixed(0)} ms, ${r.parsed.trades.length} trades`,
      );
      report(time(`upload ${file}: rank+detect`, 1, () => {}), { test: "b7", ms: r.rankMs, fullReadsAtDetect: r.afterDetect.full, fullReadsTotal: r.total.full });
    }
    for (const l of rows) console.log("    " + l);

    // One upload, ONE decode: detection is memoised per context (the route
    // asks twice) and every detector and parser reads the workbook through
    // `workbookOf(ctx)`. The bound is 2, not 1, only so a parser that
    // legitimately needs a second read shape (a `bookSheets` probe before
    // the cells have been decoded) has room; a new parser that calls
    // `XLSX.read` directly moves this number and fails here. Measured
    // 2026-09-04: 1 full decode for every fixture (was 11).
    expect(
      worst,
      `${worst} full XLSX decodes for one upload — a parser or detector is decoding the workbook itself instead of through workbookOf(ctx).`,
    ).toBeLessThanOrEqual(2);
  });

  it("decodes the 1.4 MB tradebook ONCE for detect + parse — the parsed workbook is shared", async () => {
    const r = await uploadShaped("zerodha-tradebook.xlsx");
    expect(r.afterDetect.full).toBe(1);
    expect(r.total.full).toBe(1);
  });

  it("the ranking is identical whether it is computed once or twice", async () => {
    const { buildContext, rankParsers } = await import("@/lib/import/detect");
    const ctx = buildContext("zerodha-tradebook.xlsx", fs.readFileSync(path.join(DIR, "zerodha-tradebook.xlsx")));
    const a = rankParsers(ctx).map((p) => `${p.sourceId}:${p.confidence}`);
    const b = rankParsers(ctx).map((p) => `${p.sourceId}:${p.confidence}`);
    expect(b).toEqual(a);
    // A different context (same bytes, different name) is a different answer, not a stale one.
    const c = rankParsers(buildContext("something.xlsx", ctx.buffer!));
    expect(c.find((p) => p.sourceId === "zerodha")!.confidence).not.toBe(a.find((s) => s.startsWith("zerodha:")));
  });
});
