import fs from "node:fs";
import path from "node:path";

/**
 * The owner's REAL broker exports, read in place when this machine has them.
 * Never copied into the repo; never named by client code — callers look a
 * file up by a pattern on the broker's own filename shape. Absent on CI and
 * on any other machine, so every consumer wraps itself in `describe.skipIf`.
 */
export const OWNER_DIR = process.env.VYUHA_OWNER_FILES ?? "T:/Thejesh/CLAUDE-CODE/BROKER FILES FOR TESTING";

/**
 * Where an owner file may live. The filed exports sit in OWNER_DIR; anything
 * downloaded and never filed is still in the browser's download folder, so
 * that is searched as a fallback. Both are DIRECTORIES searched by pattern —
 * no file is ever named literally, because a literal name in this repo is a
 * client's document reference in a public codebase.
 */
export function ownerDirs(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return [OWNER_DIR, ...(home ? [path.join(home, "Downloads")] : [])];
}

/**
 * Files matching `pattern`, in the FILED directory by default. The download
 * folder is opt-in (`dirs: ownerDirs()`): it is a folder of whatever the
 * machine happens to have, including half-finished and unrelated copies, so a
 * test that widens its search there must mean to.
 */
export function ownerFiles(pattern: RegExp, dirs: string[] = [OWNER_DIR]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (pattern.test(f)) out.push(path.join(dir, f));
  }
  return out.sort();
}

export const ownerFile = (pattern: RegExp, dirs?: string[]): string | null =>
  ownerFiles(pattern, dirs)[0] ?? null;

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
 * The one contract note that carries a FUTURES leg. It was never filed with
 * the rest and still sits in the download folder, which is why `ownerFiles`
 * searches there too — this is a PATTERN over the configured directories, not
 * a path. It used to be an absolute path naming a real client document; that
 * is a reference to someone's private paperwork living in a source repo, and
 * it is gone.
 */
export const OWNER_FUT_CONTRACT_NOTE_PATTERN = /_Contract_Note_.*-FUT\.pdf$/i;
export const ownerFutContractNote = (): string | null =>
  ownerFile(OWNER_FUT_CONTRACT_NOTE_PATTERN, ownerDirs());
