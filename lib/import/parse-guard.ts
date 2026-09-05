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

/** Container signatures, as byte arrays — never string escapes. */
const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" — xlsx, xlsm, ods
const SIG_CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // legacy .xls
const SIG_PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

function startsWith(bytes: Buffer, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

/**
 * Text-like = no NUL in the first 512 bytes. That is the one property every
 * text format the pipeline reads shares and no binary container has: CSV, TSV,
 * and the HTML several brokers hand out under a `.xls` name.
 */
function looksTextLike(bytes: Buffer): boolean {
  const n = Math.min(512, bytes.length);
  for (let i = 0; i < n; i++) if (bytes[i] === 0x00) return false;
  return true;
}

/**
 * Can the pipeline read these bytes at all?
 *
 * CSV and PDF names skip the workbook probe: CSVs are decoded as text (Papa
 * never throws) and PDFs go through pdf-parse, so probing either with XLSX
 * would refuse files the pipeline handles fine. `bookSheets` reads only the
 * container and sheet names — the signature and password checks both happen
 * there, and the full cell parse stays where it was, inside the parsers.
 *
 * A file NAMED .xlsx/.xls must additionally LOOK like one before its bytes
 * reach `XLSX.read`: a zip, a CFB, a PDF, or text. Anything else is refused on
 * the signature alone, so an image, an executable or a truncated download never
 * becomes parser input. This is the only place a name/byte disagreement is
 * judged — the module's design rule is unchanged for every other name: junk
 * bytes SheetJS can open at all still pass through to the generic
 * column-mapper's "no table found" question.
 */
export function guardReadable(filename: string, bytes: Buffer): ParseGuardResult {
  if (/\.(csv|pdf)$/i.test(filename)) return { ok: true };
  if (/\.(xlsx|xls)$/i.test(filename)) {
    const plausible =
      startsWith(bytes, SIG_ZIP) ||
      startsWith(bytes, SIG_CFB) ||
      startsWith(bytes, SIG_PDF) ||
      looksTextLike(bytes);
    if (!plausible) return { ok: false, error: ERROR_UNREADABLE };
  }
  try {
    XLSX.read(bytes, { type: "buffer", bookSheets: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: unreadableError(e) };
  }
}
