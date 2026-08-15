import { describe, expect, it } from "vitest";
import { buildContext } from "@/lib/import/detect";
import { parseGenericTable } from "@/lib/import/parsers/generic-table";
import { report, rng, time } from "./helpers/measure";

/**
 * C2 — a pathological generic import: a big file where a large share of the
 * rows cannot be read.
 *
 * Correctness, not speed. `applyMapping` counts every row it drops (a blank
 * subtotal, a text quantity, an unreadable date) and the parser forwards only
 * `warnings` — so what the user learns depends entirely on whether the count
 * made it INTO a warning. And the executions shape pairs legs into positions,
 * so "10,000 lines → 3,500 trades" must read as pairing (`sourceRows`, the
 * same field the Dhan GTR and Groww order parsers set), never as rows going
 * missing — DECISIONS.md 2026-08-12 records the report that came from exactly
 * that ambiguity.
 *
 * Generated with rng(seed) so a failing count is reproducible.
 */

const ROWS = 10_000;

function makeCsv(seed: number): { csv: string; bad: number; badDates: number } {
  const rand = rng(seed);
  const lines = ["Date,Symbol,Side,Qty,Price,Charges"];
  let bad = 0;
  let badDates = 0;
  for (let i = 0; i < ROWS; i++) {
    const sym = `SYM${i % 200}`;
    // Each symbol alternates BUY / SELL across the file so legs actually pair.
    // (i % 2 would give every symbol one side only — nothing pairs, and the
    // "positions < lines" assertion cannot be exercised.)
    const side = Math.floor(i / 200) % 2 === 0 ? "BUY" : "SELL";
    const qty = 10 + Math.floor(rand() * 90);
    const price = (100 + rand() * 900).toFixed(2);
    const r = rand();
    if (r < 0.1) { lines.push(`2026-07-0${1 + (i % 9)},${sym},${side},N/A,${price},1.5`); bad++; continue; }         // text quantity
    if (r < 0.2) { lines.push(`,,,,,`); bad++; continue; }                                                              // blank-ish row (dropped by readTable — not counted by applyMapping)
    if (r < 0.3) { lines.push(`31/31/2026,${sym},${side},${qty},${price},1.5`); bad++; badDates++; continue; }         // unreadable date
    if (r < 0.35) { lines.push(`Subtotal,,,,${price},`); bad++; continue; }                                             // subtotal line
    lines.push(`2026-07-0${1 + (i % 9)},${sym},${side},${qty},${price},1.5`);
  }
  return { csv: lines.join("\n"), bad, badDates };
}

describe("C2 · pathological generic import — the user is told what was skipped", () => {
  it("names the skipped-row count in a warning and reports source lines vs positions", () => {
    const { csv, badDates } = makeCsv(0xc2);
    const ctx = buildContext("mystery-broker.csv", Buffer.from(csv, "utf8"));
    ctx.generic = { broker: "kotakneo", mapping: { date: 0, tradingsymbol: 1, side: 2, qty: 3, price: 4, charges: 5 } };

    let parsed!: ReturnType<typeof parseGenericTable>;
    const timing = time(`generic parse, ${ROWS.toLocaleString()} rows (35% unreadable)`, ROWS, () => { parsed = parseGenericTable(ctx); });
    report(timing, { test: "c2", trades: parsed.trades.length, warnings: parsed.warnings.length });

    // The all-blank rows are dropped by readTable before mapping — the table
    // the user mapped never contained them. Every other bad row reached
    // applyMapping and must be counted.
    const tableRows = parsed.table!.totalRows;
    const readable = tableRows - parsed.warnings.reduce((n, w) => n + (Number(/^(\d+) rows? skipped/.exec(w)?.[1]) || 0), 0);
    console.log(`    ${tableRows.toLocaleString()} table rows → ${parsed.trades.length.toLocaleString()} positions; warnings: ${JSON.stringify(parsed.warnings)}`);

    const skippedWarning = parsed.warnings.find((w) => /^\d+ rows? skipped/.test(w));
    expect(skippedWarning, "no warning names how many rows were skipped").toBeDefined();
    const skipped = Number(/^(\d+)/.exec(skippedWarning!)![1]);
    // Bad quantity + bad date + subtotal rows: everything that reached the
    // mapping and could not be read. Blank rows never reached it.
    expect(skipped).toBeGreaterThan(0);
    expect(readable).toBeGreaterThan(0);
    // The unreadable-date sub-count is called out separately, and matches.
    const dateWarning = parsed.warnings.find((w) => /unreadable date/.test(w));
    expect(dateWarning).toBeDefined();
    expect(Number(/^(\d+)/.exec(dateWarning!)![1])).toBe(badDates);

    // Pairing: legs in, positions out. The parser must say how many lines it
    // read so the batch row shows "N lines → M trades" instead of a bare M
    // that looks like a loss.
    expect(parsed.trades.length).toBeLessThan(readable);
    expect(
      parsed.sourceRows,
      `sourceRows is unset: ${readable} readable lines became ${parsed.trades.length} positions and the import table will show only ${parsed.trades.length}`,
    ).toBe(readable);
  });

  it("an incomplete mapping skips everything and says so, importing nothing", () => {
    const { csv } = makeCsv(0xc2 + 1);
    const ctx = buildContext("mystery-broker.csv", Buffer.from(csv, "utf8"));
    ctx.generic = { broker: "kotakneo", mapping: { date: 0, tradingsymbol: 1 } };
    const parsed = parseGenericTable(ctx);
    expect(parsed.trades).toEqual([]);
    expect(parsed.warnings.some((w) => /Mapping incomplete/.test(w))).toBe(true);
  });
});
