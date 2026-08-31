/**
 * Byte-level guard for uploaded import files.
 *
 * Detection runs every registered detector, and several open the workbook
 * themselves — `XLSX.read` throws on bytes that are not a spreadsheet (a
 * dropped screenshot) and on encrypted workbooks, and that throw used to
 * escape `rankParsers` as a raw 500 the client then failed to JSON-parse
 * ("Unexpected token"). This runs the same read ONCE, up front, and turns
 * the two failure classes into copy a user can act on.
 *
 * Deliberately NOT a format whitelist: junk bytes that XLSX can open at all
 * (arbitrary binary parses as a garbage single sheet) must pass through, so
 * the generic column-mapper keeps its "no table found" question. Only bytes
 * the pipeline would THROW on are refused here.
 */

import * as XLSX from "xlsx";

export type ParseGuardResult = { ok: true } | { ok: false; error: string };

/** SheetJS throws exactly "File is password-protected" for encrypted CFB. */
const ENCRYPTED = /password[- ]?protected|encrypted/i;

export const ERROR_ENCRYPTED =
  "This workbook is password-protected. Vyuha cannot open it — export an unprotected copy from your broker and import that.";
export const ERROR_UNREADABLE =
  "This file is not a spreadsheet or CSV Vyuha can read. Drop the broker's CSV or XLSX export — not a screenshot, image or archive.";

/** Classify a byte-level parse throw into honest user copy. */
export function unreadableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return ENCRYPTED.test(msg) ? ERROR_ENCRYPTED : ERROR_UNREADABLE;
}

/**
 * Can the pipeline read these bytes at all?
 *
 * CSV and PDF names skip the workbook probe: CSVs are decoded as text (Papa
 * never throws) and PDFs go through pdf-parse, so probing either with XLSX
 * would refuse files the pipeline handles fine. `bookSheets` reads only the
 * container and sheet names — the signature and password checks both happen
 * there, and the full cell parse stays where it was, inside the parsers.
 */
export function guardReadable(filename: string, bytes: Buffer): ParseGuardResult {
  if (/\.(csv|pdf)$/i.test(filename)) return { ok: true };
  try {
    XLSX.read(bytes, { type: "buffer", bookSheets: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: unreadableError(e) };
  }
}
