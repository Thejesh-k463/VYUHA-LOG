import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The STRUCTURAL half of the end-of-session drift check, in CI.
 *
 * `scripts/state-drift-check.mjs` re-derives what the hand-off documents claim
 * from the tree itself — version sync, the migration journal, every backticked
 * path and every `npm run <name>` cited in AGENTS.md / README.md / STATE §0.
 * Those must hold at ANY commit, so a broken citation reddens on the day it
 * breaks rather than at the next close-out. The count/sha/freshness checks that
 * legitimately lag mid-wave live behind `--close-out` and are NOT run here.
 *
 * When this goes red, FIX THE DOC — never the check. The failing line names
 * both sides and where the claim lives.
 */

const root = path.resolve(__dirname, "..");

describe("end-of-session drift check (structural mode)", () => {
  it("every fact AGENTS.md / README.md / STATE §0 claims about the tree is true", () => {
    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(root, "scripts", "state-drift-check.mjs")], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    expect(code, `npm run drift reported drift — fix the DOC, never the check:\n${out}`).toBe(0);
  });
});
