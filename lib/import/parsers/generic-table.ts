/**
 * The last-resort import source: ANY broker's CSV/XLSX, mapped by the user.
 *
 * This is what makes "import works with every broker" true rather than
 * aspirational. It detects at a deliberately tiny confidence (0.05) so it can
 * never outrank a hand-written parser — the lowest score any real detector can
 * return is 0.1 — but it is always available, so a file no parser recognises
 * produces a column-mapping step instead of a dead end.
 *
 * Two-pass by nature: the first parse has no mapping and returns the header
 * row plus sample rows for the UI to render; the second carries the user's
 * mapping on `ctx.generic` and produces real trades through `applyMapping`.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import type { ParseContext, ParsedFile } from "../types";
import { workbookOf } from "../types";
import { applyMapping, suggestMapping } from "../generic-map";

/** Rows of the first sheet / the CSV, as strings. */
function toMatrix(ctx: ParseContext): string[][] {
  if (ctx.text != null) {
    return (Papa.parse<string[]>(ctx.text, { skipEmptyLines: true }).data ?? []).map((r) =>
      r.map((c) => String(c ?? "")),
    );
  }
  if (ctx.buffer) {
    const wb = workbookOf(ctx);
    const ws = wb.Sheets[wb.SheetNames[0]!];
    if (!ws) return [];
    return (XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" }) as unknown[][]).map(
      (r) => r.map((c) => String(c ?? "")),
    );
  }
  return [];
}

/**
 * The header row is the first row with at least two non-empty cells that is
 * followed by a row of the same width. Broker exports routinely open with a
 * title, an account line and a blank — none of which satisfy that.
 */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const filled = rows[i].filter((c) => String(c).trim() !== "").length;
    if (filled < 2) continue;
    const next = rows[i + 1];
    if (!next) continue;
    if (next.filter((c) => String(c).trim() !== "").length >= Math.min(2, filled - 1)) return i;
  }
  return -1;
}

export interface GenericTable {
  headers: string[];
  rows: string[][];
}

/** Split a file into its header row and the data rows beneath it. */
export function readTable(ctx: ParseContext): GenericTable {
  const matrix = toMatrix(ctx);
  const h = findHeaderRow(matrix);
  if (h < 0) return { headers: [], rows: [] };
  const headers = matrix[h].map((c) => String(c).trim());
  const width = headers.length;
  const rows = matrix
    .slice(h + 1)
    // Keep short rows padded rather than dropped — a trailing empty cell is
    // common and losing the row would lose a trade.
    .map((r) => (r.length >= width ? r : [...r, ...Array(width - r.length).fill("")]))
    .filter((r) => r.some((c) => String(c).trim() !== ""));
  return { headers, rows };
}

/**
 * Always a whisper of confidence for a tabular file, never enough to win.
 *
 * Returning 0 would make `detectParser` give up and show "could not detect the
 * broker", which is the bug this whole source exists to remove.
 */
export function detectGenericTable(ctx: ParseContext): number {
  if (/\.pdf$/i.test(ctx.filename)) return 0;
  if (ctx.text == null && ctx.buffer == null) return 0;
  const { headers, rows } = readTable(ctx);
  return headers.length >= 2 && rows.length > 0 ? 0.05 : 0;
}

export function parseGenericTable(ctx: ParseContext): ParsedFile {
  const { headers, rows } = readTable(ctx);

  // Pass 1 — no mapping yet. Hand the UI what it needs to ask the question.
  if (!ctx.generic) {
    return {
      sourceId: "generic-table",
      // A placeholder only; the real broker is chosen by the user in the
      // mapping step and applied on pass 2. Nothing is committed from pass 1.
      broker: "dhan",
      format: "generic-unmapped",
      trades: [],
      warnings:
        headers.length >= 2
          ? ["Tell Vyuha what these columns mean and it will import the file."]
          : ["No table found in this file — the first sheet has no header row Vyuha can see."],
      table: {
        headers,
        sampleRows: rows.slice(0, 5),
        totalRows: rows.length,
        suggested: suggestMapping(headers),
      },
    };
  }

  // Pass 2 — the user has mapped the columns.
  const { broker, mapping, defaultProduct } = ctx.generic;
  const applied = applyMapping(headers, rows, mapping, {
    broker,
    filename: ctx.filename,
    defaultProduct,
  });

  return {
    sourceId: "generic-table",
    broker,
    // Execution-shaped input carries fills and times, so it earns the same
    // format tag as a native tradebook; round-trip input does not.
    format: mapping.side !== undefined ? "tradebook" : "pnl",
    trades: applied.trades,
    warnings: applied.warnings,
    // Lines actually read, so a paired execution file shows "6,491 lines →
    // 4,226 trades" in the imports table instead of a bare 4,226 that reads
    // as rows going missing (the same field the Dhan GTR and Groww order
    // parsers set; tests/load/c2-pathological-import.load.ts). Skipped rows
    // are excluded here because the warning above already counts them.
    sourceRows: rows.length - applied.skipped,
    table: {
      headers,
      sampleRows: rows.slice(0, 5),
      totalRows: rows.length,
      suggested: mapping,
    },
  };
}
