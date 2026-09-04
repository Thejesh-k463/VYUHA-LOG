import fs from "node:fs";
import path from "node:path";

/**
 * The owner's REAL broker exports, read in place when this machine has them.
 * Never copied into the repo; never named by client code — callers look a
 * file up by a pattern on the broker's own filename shape. Absent on CI and
 * on any other machine, so every consumer wraps itself in `describe.skipIf`.
 */
export const OWNER_DIR = "T:/Thejesh/CLAUDE-CODE/BROKER FILES FOR TESTING";

export function ownerFiles(pattern: RegExp): string[] {
  if (!fs.existsSync(OWNER_DIR)) return [];
  return fs
    .readdirSync(OWNER_DIR)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => path.join(OWNER_DIR, f));
}

export const ownerFile = (pattern: RegExp): string | null => ownerFiles(pattern)[0] ?? null;

/** Read bytes; the returned filename is NEUTRAL (extension only) so a claim
 *  can only come from the file's content, as in the detection matrix. */
export function ownerContext(file: string): { filename: string; bytes: Buffer } {
  return { filename: "export" + path.extname(file), bytes: fs.readFileSync(file) };
}

/**
 * Filename shapes for the v3.9 reference sources, so a test names a broker's
 * own file shape rather than a literal path. Patterns only — nothing here
 * reads or copies a file.
 */
export const OWNER_DP_CHARGES = /^dp-charges.*\.xls$/i;
export const OWNER_DHAN_HOLDINGS = /^Dhan_Demat_Holding.*\.xlsx$/i;
export const OWNER_DHAN_CONTRACT_NOTE = /_Contract_Note_.*\.pdf$/i;

/**
 * The owner's futures contract note lives in the Downloads folder, not in
 * OWNER_DIR — it is the ONE futures day on either account and was never filed
 * with the rest. Read in place like every other owner file; absent everywhere
 * else, so callers guard on it.
 */
export const OWNER_FUT_CONTRACT_NOTE =
  "C:/Users/theje/Downloads/IBCE61646A_Contract_Note_Eqfo_signed-FUT.pdf";
