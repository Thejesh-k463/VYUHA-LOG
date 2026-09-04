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
  /**
   * v3.9 "Trust the numbers": figures the BROKER states that Vyuha does not
   * derive — realised P&L per FY / per scrip, demat holdings, statement-level
   * charge totals. Persisted to `broker_reference` at commit and shown beside
   * Vyuha's own numbers on the reconciliation screen. A reference source
   * (Dhan Realised P&L, Paytm Realized P&L Detail, Angel P&L statement, Dhan
   * holdings) fills this and usually emits NO trades; the book stays the
   * tradebook (GTR / tradebook exports).
   */
  reference?: ReferenceRow[];
  /**
   * Facts a secondary source knows about trades the book already holds —
   * fill times and the instrument type from a Dhan contract note. Applied at
   * commit to EXISTING rows matched on (symbol, date, side, qty); never
   * creates a trade. Unmatched enrichments are reported, not stored.
   */
  enrich?: EnrichmentRow[];
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

/** What a reference figure describes. */
export type ReferenceScope = "fy" | "scrip" | "segment" | "holding" | "charge";

/**
 * One broker-stated figure set. `key` is the FY label ("2025-26"), the ISIN
 * (scrip/holding), the segment name ("equity" | "fno" | "commodity" |
 * "currency") or the charge type. `figures` keys are the canonical names used
 * by `reported` (buyValue, sellValue, grossPnl, netPnl, totalCharges, qty,
 * closingPrice, valuation, …) so every source lands in one table.
 */
export interface ReferenceRow {
  scope: ReferenceScope;
  key: string;
  isin?: string | null;
  symbol?: string | null;
  /** FY label the figure belongs to, when the file states or implies one. */
  fy?: string | null;
  /** ISO yyyy-mm-dd the figure is stated for (holdings: statement date; lots: sell date). */
  asOf?: string | null;
  figures: Record<string, number>;
  note?: string | null;
}

/** A fact about an existing trade from a secondary source (contract note). */
export interface EnrichmentRow {
  symbol: string;
  /** ISO yyyy-mm-dd */
  date: string;
  side: "buy" | "sell";
  qty: number;
  /** "HH:MM:SS" IST as printed by the broker. */
  time?: string | null;
  instrumentType?: "equity" | "option" | "future" | null;
  exchange?: string | null;
  note?: string | null;
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
  return (memo.full ??= trimSheetRanges(XLSX.read(ctx.buffer, { type: "buffer" })));
}

/**
 * A BIFF8 export can declare its used range as the whole sheet (`A1:Q65536`
 * on Dhan's DP-charges file, 1,400 real cells). `sheet_to_json({ defval })`
 * then materialises 65,536 rows per detector — 3.7 s of ranking on a 91 KB
 * file, a hook timeout under load. Trim each sheet's `!ref` to the bounding
 * box of its populated cells once, on the memoised workbook. Merges are left
 * alone; a merge past the last cell is a merge of empties.
 */
export function trimSheetRanges(wb: XLSX.WorkBook): XLSX.WorkBook {
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    let maxR = -1;
    let maxC = -1;
    for (const key of Object.keys(ws)) {
      if (key[0] === "!") continue;
      const { r, c } = XLSX.utils.decode_cell(key);
      if (r > maxR) maxR = r;
      if (c > maxC) maxC = c;
    }
    if (maxR < 0) continue;
    const declared = XLSX.utils.decode_range(ws["!ref"]);
    if (declared.e.r <= maxR && declared.e.c <= maxC) continue;
    ws["!ref"] = XLSX.utils.encode_range({ s: declared.s, e: { r: Math.max(maxR, declared.s.r), c: Math.max(maxC, declared.s.c) } });
  }
  return wb;
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
  /**
   * v3.9: what the commit did BEYOND writing trades — how many broker-stated
   * figures landed in `broker_reference`, and how many of a secondary source's
   * enrichment lines found an existing trade. Additive and optional: a commit
   * of a plain tradebook reports none of it.
   */
  referenceStored?: number;
  enrichApplied?: number;
  enrichTotal?: number;
  /**
   * Sentences the COMMIT produced (not the parse). The parse's own warnings
   * still travel on `ParsedFile.warnings`; these are facts only the write knew
   * — "Fill times applied to 41 of 52 contract-note lines", "N reference
   * figures stored".
   */
  warnings?: string[];
}
