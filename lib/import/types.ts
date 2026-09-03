import type { Broker } from "@/lib/domain/constants";
import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ColumnMapping } from "./generic-map";
import type { ImportShape } from "@/lib/domain/import-shape";
import * as XLSX from "xlsx";

/** Result of parsing one broker file into normalized rows + reported totals. */
export interface ParsedFile {
  sourceId: string; // e.g. "dhan-csv"
  broker: Broker;
  format: string; // "pnl" | "tradebook" | "console" | "pdf" | ...
  trades: NormalizedTrade[];
  /** Broker-reported aggregate totals (footer/summary), for reconciliation. */
  reported?: Record<string, number>;
  /**
   * Statement lines actually read from the file, when that differs from
   * `trades.length` because the parser PAIRS lines into positions (the Dhan
   * GTR turns 92 bill lines into 73 positions). Shown as "92 lines → 73
   * trades" so the difference reads as pairing, not as rows going missing —
   * which is exactly how it read the first time (2026-08-12).
   */
  sourceRows?: number;
  warnings: string[];
  /** Raw text (PDF) when a guided manual mapping is needed. */
  rawText?: string;
  /**
   * The file's own header row and a few sample rows, sent to the UI when a
   * file needs COLUMN MAPPING before it can be read (see generic-map.ts). Only
   * the generic table source populates this.
   */
  table?: {
    headers: string[];
    sampleRows: string[][];
    totalRows: number;
    /** Best-guess mapping, pre-filled in the UI for the user to correct. */
    suggested: ColumnMapping;
  };
}

export interface ParseContext {
  filename: string;
  text?: string;
  buffer?: Buffer;
  /**
   * Set only for the generic "map the columns yourself" source, once the user
   * has told us what the columns mean. Every hand-written parser ignores it.
   */
  generic?: {
    broker: Broker;
    mapping: ColumnMapping;
    defaultProduct?: ProductHint;
  };
  /**
   * Memo for `workbookOf(ctx)` — the decoded workbook(s) for `buffer`, keyed
   * by read shape. Attached lazily on first use, never read directly: go
   * through `workbookOf`, which invalidates it if `buffer` is reassigned.
   */
  workbooks?: { buffer: Buffer; full?: XLSX.WorkBook; sheetsOnly?: XLSX.WorkBook };
}

/**
 * Decode the context's bytes as a workbook ONCE per context, however many
 * detectors and parsers ask.
 *
 * Every fingerprinting detector opens the workbook itself (AGENTS.md: a
 * broker-named parser must SEE the broker's name), and the route ranks twice
 * before parsing once. Before this memo that was one full XLSX decode per
 * xlsx-reading detector plus one for the parse — 11 decodes of a 1.4 MB
 * tradebook per upload (tests/load/b7-import-parse-count.load.ts). The memo
 * lives on the context object so a fresh request — a fresh context — can never
 * be served another file's workbook, and it re-decodes if `buffer` is
 * reassigned, the same identity rule `rankParsers`' cache uses.
 *
 * Two read shapes exist in the parsers: the full decode, and
 * `bookSheets: true` (sheet NAMES only, no cells — groww-xlsx's detector). A
 * full workbook answers a sheet-list ask for free, so the cheap read is only
 * ever performed when nothing has decoded the cells yet. Every caller keeps
 * its own options; nothing about what a parser SEES changes.
 *
 * Throws exactly what `XLSX.read` throws (no buffer, junk bytes, an encrypted
 * workbook) — callers keep their own try/catch and their own fallbacks.
 */
export function workbookOf(ctx: ParseContext, opts: { bookSheets?: boolean } = {}): XLSX.WorkBook {
  if (!ctx.buffer) throw new Error("workbookOf: the context carries no bytes");
  if (!ctx.workbooks || ctx.workbooks.buffer !== ctx.buffer) ctx.workbooks = { buffer: ctx.buffer };
  const memo = ctx.workbooks;
  if (opts.bookSheets) {
    if (memo.full) return memo.full;
    return (memo.sheetsOnly ??= XLSX.read(ctx.buffer, { type: "buffer", bookSheets: true }));
  }
  return (memo.full ??= XLSX.read(ctx.buffer, { type: "buffer" }));
}

/**
 * Seam for adding new import sources. File parsers implement `kind: "file"`.
 * Future broker-API pullers implement `kind: "api"` and provide `fetch()` —
 * the rest of the pipeline (classify → charges → dedup → DB) is unchanged.
 */
export interface ImportSourceBase {
  id: string;
  label: string;
  broker: Broker;
  kind: "file" | "api";
}

export interface FileImportSource extends ImportSourceBase {
  kind: "file";
  /** Confidence in [0,1] that this source can parse the given file. */
  detect(ctx: ParseContext): number;
  parse(ctx: ParseContext): Promise<ParsedFile> | ParsedFile;
}

export interface ApiImportSource extends ImportSourceBase {
  kind: "api";
  fetchTrades(opts: { from?: string; to?: string }): Promise<NormalizedTrade[]>;
}

export type ImportSource = FileImportSource | ApiImportSource;

/** Outcome of committing a parsed file to the DB. */
export interface CommitResult {
  batchId: number;
  broker: Broker;
  fileName: string;
  added: number;
  skipped: number;
  total: number;
  netPnl: number;
  /**
   * The FILE's shape — executions read, positions produced, and the two
   * sub-counts whose P&L is legitimately blank. Describes the whole file, not
   * just the rows that were new, because that is what the user is comparing
   * against their broker's own statement.
   */
  shape: ImportShape;
}
