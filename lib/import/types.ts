import type { Broker } from "@/lib/domain/constants";
import type { NormalizedTrade, ProductHint } from "@/lib/engine/types";
import type { ColumnMapping } from "./generic-map";

/** Result of parsing one broker file into normalized rows + reported totals. */
export interface ParsedFile {
  sourceId: string; // e.g. "dhan-csv"
  broker: Broker;
  format: string; // "pnl" | "tradebook" | "console" | "pdf" | ...
  trades: NormalizedTrade[];
  /** Broker-reported aggregate totals (footer/summary), for reconciliation. */
  reported?: Record<string, number>;
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
}
