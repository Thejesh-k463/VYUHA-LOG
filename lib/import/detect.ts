import type { Broker } from "@/lib/domain/constants";
import { IMPORT_SOURCES } from "./registry-meta";
export { dropzoneHint, brokersWithNativeParser } from "./registry-meta";
import type { ParseContext, ParsedFile } from "./types";
import { detectDhanCsv, parseDhanCsv } from "./parsers/dhan-csv";
import { detectDhanGtr, parseDhanGtr } from "./parsers/dhan-gtr";
import { detectGrowwXlsx, parseGrowwXlsx } from "./parsers/groww-xlsx";
import { detectGrowwOrders, parseGrowwOrders } from "./parsers/groww-orders";
import { detectZerodha, parseZerodha } from "./parsers/zerodha";
import { detectPdf, parsePdf } from "./parsers/pdf";
import { detectAngelOne, parseAngelOne, detectUpstox, parseUpstox } from "./parsers/angelone-upstox";
import { detectAngelOneTaxPnl, parseAngelOneTaxPnl } from "./parsers/angelone-taxpnl";
import { detectPaytmTradebook, parsePaytmTradebook } from "./parsers/paytm-tradebook";
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
// Built FROM the client-safe metadata leaf (registry-meta.ts), zipping each
// entry with its parse function — so the copy the dropzone shows and the
// parsers the server runs cannot drift apart. A meta entry without a parser
// (or vice versa) throws at module init, which fails every test run loudly.
const PARSERS: Record<string, (ctx: ParseContext) => Promise<ParsedFile> | ParsedFile> = {
  "dhan-gtr": parseDhanGtr,
  "dhan-csv": parseDhanCsv,
  "groww-xlsx": parseGrowwXlsx,
  "groww-orders": parseGrowwOrders,
  zerodha: parseZerodha,
  angelone: parseAngelOne,
  "angelone-taxpnl": parseAngelOneTaxPnl,
  upstox: parseUpstox,
  "paytm-tradebook": parsePaytmTradebook,
  pdf: parsePdf,
  "generic-table": parseGenericTable,
};
const REGISTRY: DetectedParser[] = IMPORT_SOURCES.map((m) => {
  const parse = PARSERS[m.sourceId];
  if (!parse) throw new Error(`registry-meta lists "${m.sourceId}" but detect.ts has no parser for it`);
  return { ...m, confidence: 0, parse };
});
if (Object.keys(PARSERS).length !== IMPORT_SOURCES.length) {
  throw new Error("detect.ts has a parser registry-meta.ts does not list — add the metadata entry");
}

const DETECTORS: Record<string, (ctx: ParseContext) => number> = {
  "dhan-gtr": detectDhanGtr,
  "dhan-csv": detectDhanCsv,
  "groww-xlsx": detectGrowwXlsx,
  "groww-orders": detectGrowwOrders,
  zerodha: detectZerodha,
  angelone: detectAngelOne,
  "angelone-taxpnl": detectAngelOneTaxPnl,
  upstox: detectUpstox,
  "paytm-tradebook": detectPaytmTradebook,
  pdf: detectPdf,
  "generic-table": detectGenericTable,
};

/** Every registered source, for UI copy and coverage tests. */
export function importSources(): readonly DetectedParser[] {
  return REGISTRY;
}

/**
 * Detection is memoised per ParseContext OBJECT.
 *
 * The upload route asks twice — `rankParsers(ctx)` for the candidate list and
 * `detectParser(ctx)` for the winner — and every fingerprinting detector opens
 * the workbook itself, so the second ask re-decoded a 1.4 MB tradebook seven
 * more times (tests/load/b7-import-parse-count.load.ts: 14 full XLSX.read
 * calls before a single trade was parsed, ~1.3 s). The cache is keyed on the
 * context's identity AND on the fields a detector reads, so a context whose
 * bytes, name or mapping changed is scored afresh, and a fresh context — a
 * new request — is never served another file's ranking. Scores themselves
 * are untouched: this returns exactly what the detectors returned.
 */
const rankCache = new WeakMap<ParseContext, { filename: string; text?: string; buffer?: Buffer; generic?: unknown; ranked: DetectedParser[] }>();

/** Rank all parsers by confidence for the given file. Highest first. */
export function rankParsers(ctx: ParseContext): DetectedParser[] {
  const hit = rankCache.get(ctx);
  if (hit && hit.filename === ctx.filename && hit.text === ctx.text && hit.buffer === ctx.buffer && hit.generic === ctx.generic) {
    return hit.ranked.map((p) => ({ ...p }));
  }
  const ranked = REGISTRY.map((p) => ({ ...p, confidence: DETECTORS[p.sourceId]!(ctx) }))
    .sort((a, b) => b.confidence - a.confidence);
  rankCache.set(ctx, { filename: ctx.filename, text: ctx.text, buffer: ctx.buffer, generic: ctx.generic, ranked });
  return ranked.map((p) => ({ ...p }));
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
