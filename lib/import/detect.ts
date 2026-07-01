import type { ParseContext, ParsedFile } from "./types";
import { detectDhanCsv, parseDhanCsv } from "./parsers/dhan-csv";
import { detectGrowwXlsx, parseGrowwXlsx } from "./parsers/groww-xlsx";
import { detectZerodha, parseZerodha } from "./parsers/zerodha";
import { detectPdf, parsePdf } from "./parsers/pdf";

export interface DetectedParser {
  sourceId: string;
  label: string;
  confidence: number;
  parse: (ctx: ParseContext) => Promise<ParsedFile> | ParsedFile;
}

const REGISTRY: DetectedParser[] = [
  { sourceId: "dhan-csv", label: "Dhan P&L (CSV)", confidence: 0, parse: parseDhanCsv },
  { sourceId: "groww-xlsx", label: "Groww Stocks P&L (XLSX)", confidence: 0, parse: parseGrowwXlsx },
  { sourceId: "zerodha", label: "Zerodha Tradebook / Console (CSV/XLSX)", confidence: 0, parse: parseZerodha },
  { sourceId: "pdf", label: "Broker P&L (PDF)", confidence: 0, parse: parsePdf },
];

const DETECTORS: Record<string, (ctx: ParseContext) => number> = {
  "dhan-csv": detectDhanCsv,
  "groww-xlsx": detectGrowwXlsx,
  zerodha: detectZerodha,
  pdf: detectPdf,
};

/** Rank all parsers by confidence for the given file. Highest first. */
export function rankParsers(ctx: ParseContext): DetectedParser[] {
  return REGISTRY.map((p) => ({ ...p, confidence: DETECTORS[p.sourceId]!(ctx) }))
    .sort((a, b) => b.confidence - a.confidence);
}

/** Pick the best parser (or null if nothing is confident). */
export function detectParser(ctx: ParseContext): DetectedParser | null {
  const ranked = rankParsers(ctx);
  return ranked[0] && ranked[0].confidence > 0 ? ranked[0] : null;
}

/** Build a ParseContext from a filename + bytes (CSV decoded to text). */
export function buildContext(filename: string, bytes: Buffer): ParseContext {
  const isText = /\.csv$/i.test(filename);
  return {
    filename,
    text: isText ? bytes.toString("utf-8") : undefined,
    buffer: bytes,
  };
}
