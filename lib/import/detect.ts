import type { Broker } from "@/lib/domain/constants";
import type { ParseContext, ParsedFile } from "./types";
import { detectDhanCsv, parseDhanCsv } from "./parsers/dhan-csv";
import { detectDhanGtr, parseDhanGtr } from "./parsers/dhan-gtr";
import { detectGrowwXlsx, parseGrowwXlsx } from "./parsers/groww-xlsx";
import { detectZerodha, parseZerodha } from "./parsers/zerodha";
import { detectPdf, parsePdf } from "./parsers/pdf";
import { detectAngelOne, parseAngelOne, detectUpstox, parseUpstox } from "./parsers/angelone-upstox";
import { detectGenericTable, parseGenericTable } from "./parsers/generic-table";

export interface DetectedParser {
  sourceId: string;
  label: string;
  confidence: number;
  parse: (ctx: ParseContext) => Promise<ParsedFile> | ParsedFile;
  /** Broker this source reads, or null when it serves any broker. */
  broker: Broker | null;
  /** Which dropzone tab advertises it. "both" appears under either. */
  tab: "transactions" | "pnl" | "both";
  /** Short name for the dropzone hint, e.g. "Zerodha tradebook". */
  hint: string;
}

/**
 * THE REGISTRY IS THE SINGLE SOURCE OF TRUTH FOR WHAT VYUHA CAN IMPORT.
 *
 * The dropzone's hint text is generated from `hint`/`tab` below rather than
 * hand-written in the component. Two hand-written strings had already drifted
 * from reality — the app read five brokers' files while the tradebook hint
 * named three — and a user reasonably concluded the feature was broken.
 * `tests/import-registry.test.ts` asserts the UI copy still derives from here.
 *
 * `generic-table` is deliberately last and deliberately weak (0.05): it must
 * never outrank a real parser, but it must always be available, so an
 * unrecognised file becomes a column-mapping question instead of a refusal.
 */
const REGISTRY: DetectedParser[] = [
  { sourceId: "dhan-gtr", label: "Dhan Global Transaction Report (CSV)", confidence: 0, parse: parseDhanGtr, broker: "dhan", tab: "transactions", hint: "Dhan transaction report" },
  { sourceId: "dhan-csv", label: "Dhan P&L (CSV)", confidence: 0, parse: parseDhanCsv, broker: "dhan", tab: "pnl", hint: "Dhan CSV" },
  { sourceId: "groww-xlsx", label: "Groww Stocks P&L (XLSX)", confidence: 0, parse: parseGrowwXlsx, broker: "groww", tab: "pnl", hint: "Groww XLSX" },
  { sourceId: "zerodha", label: "Zerodha Tradebook / Console (CSV/XLSX)", confidence: 0, parse: parseZerodha, broker: "zerodha", tab: "both", hint: "Zerodha tradebook / Console" },
  { sourceId: "angelone", label: "Angel One Tradebook / P&L (CSV/XLSX)", confidence: 0, parse: parseAngelOne, broker: "angelone", tab: "both", hint: "Angel One" },
  { sourceId: "upstox", label: "Upstox Tradebook / P&L (CSV/XLSX)", confidence: 0, parse: parseUpstox, broker: "upstox", tab: "both", hint: "Upstox" },
  { sourceId: "pdf", label: "Broker P&L (PDF)", confidence: 0, parse: parsePdf, broker: null, tab: "pnl", hint: "PDF statement" },
  { sourceId: "generic-table", label: "Any other broker — map the columns (CSV/XLSX)", confidence: 0, parse: parseGenericTable, broker: null, tab: "both", hint: "any other broker (map columns)" },
];

const DETECTORS: Record<string, (ctx: ParseContext) => number> = {
  "dhan-gtr": detectDhanGtr,
  "dhan-csv": detectDhanCsv,
  "groww-xlsx": detectGrowwXlsx,
  zerodha: detectZerodha,
  angelone: detectAngelOne,
  upstox: detectUpstox,
  pdf: detectPdf,
  "generic-table": detectGenericTable,
};

/** Every registered source, for UI copy and coverage tests. */
export function importSources(): readonly DetectedParser[] {
  return REGISTRY;
}

/** Brokers with a dedicated, auto-detecting parser. */
export function brokersWithNativeParser(): Broker[] {
  return [...new Set(REGISTRY.map((p) => p.broker).filter((b): b is Broker => b != null))];
}

/**
 * The dropzone hint for a tab, generated from the registry so it cannot drift.
 * The generic source is always last — it is the fallback, not a headline.
 */
export function dropzoneHint(tab: "transactions" | "pnl"): string {
  const parts = REGISTRY.filter((p) => p.tab === tab || p.tab === "both")
    .sort((a, b) => Number(a.sourceId === "generic-table") - Number(b.sourceId === "generic-table"))
    .map((p) => p.hint);
  return [...new Set(parts)].join(" · ");
}

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
