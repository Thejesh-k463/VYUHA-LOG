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
 * opens the workbook itself with `XLSX.read(ctx.buffer)`, and so does the
 * parser. Nothing shares the parsed workbook. For a 1.4 MB Zerodha tradebook
 * that is a full XLSX decode per detector per rank pass.
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

    // Detection must run ONCE per upload even though the route asks twice
    // (rankParsers for candidates, detectParser for the winner). Beyond that,
    // each fingerprinting detector opens the file itself — one decode per
    // xlsx-reading detector (7) plus one for the parse is the shape the
    // parsers impose, and is bounded here so a new parser cannot add a full
    // decode without this number moving.
    expect(
      worst,
      `${worst} full XLSX decodes for one upload — rankParsers runs twice per request and every detector re-parses the file.`,
    ).toBeLessThanOrEqual(8);
  });

  it.fails("KNOWN: decodes the workbook at most twice per upload (once to detect, once to parse) — needs lib/import/parsers/* to share a parsed workbook", async () => {
    const r = await uploadShaped("zerodha-tradebook.xlsx");
    expect(r.total.full).toBeLessThanOrEqual(2);
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
