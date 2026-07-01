import type { Broker } from "@/lib/domain/constants";
import type { NormalizedTrade } from "@/lib/engine/types";

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
}

export interface ParseContext {
  filename: string;
  text?: string;
  buffer?: Buffer;
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
