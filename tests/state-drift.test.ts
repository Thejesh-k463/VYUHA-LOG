import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

/**
 * B7 (v4.5.0 fix list) — THE TWO NEW CHECKS CAN ACTUALLY FIRE.
 *
 * "A check must not agree with itself" has a twin: a check that CANNOT go red
 * is a green tick with nothing behind it. The case above asserts the tree is
 * clean, which is exactly what a check with a broken regex would also report.
 * So each new check is also pointed at a tree with the stale line PLANTED, and
 * must name itself in a FAIL line.
 *
 * The tree is a MINIMAL COPY in a temp directory — the script resolves its root
 * from its own location, so a copy is the only way to mutate a side of a check
 * without touching the repo. Only the files the two checks read are copied;
 * every other check then SKIPs or FAILs on the copy, which is why each case
 * asserts on ITS OWN named line and never on the exit code.
 */
describe("the new drift checks are falsifiable (B7)", () => {
  /** A throwaway tree holding only what the two checks read. */
  function plantTree(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyuha-drift-"));
    for (const rel of [
      "scripts/state-drift-check.mjs",
      "AGENTS.md",
      "README.md",
      "VYUHA-STATE.md",
      "package.json",
      "lib/db/schema.ts",
      "lib/import/commit.ts",
      "app/api/import/route.ts",
      "app/api/import/broker/route.ts",
    ]) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
    }
    return dir;
  }

  /** Run the check in that tree and return the line for one named check. */
  function lineFor(dir: string, name: string): string {
    let out = "";
    try {
      out = execFileSync(process.execPath, [path.join(dir, "scripts", "state-drift-check.mjs")], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    const line = out.split(/\r?\n/).find((l) => l.includes(` ${name}:`));
    expect(line, `the check \`${name}\` printed no line at all:\n${out}`).toBeTruthy();
    return line!;
  }

  /** Replace exactly one occurrence, asserting it was unique before the edit. */
  function editOnce(file: string, find: string, replace: string) {
    const src = fs.readFileSync(file, "utf8");
    expect(src.split(find).length - 1, `\`${find.slice(0, 48)}…\` is not unique in ${path.basename(file)}`).toBe(1);
    fs.writeFileSync(file, src.replace(find, replace));
  }

  it("rate-key-vs-schema: PASS on the tree as it stands, FAIL when invariant 3 loses a key column", () => {
    const dir = plantTree();
    try {
      expect(lineFor(dir, "rate-key-vs-schema"), "the copy itself is clean").toMatch(/^PASS /);
      // The exact drift the check exists for: the key gained `plan` in wave U,
      // and the prose is edited by hand.
      editOnce(
        path.join(dir, "AGENTS.md"),
        "(broker × plan × segment × exchange,",
        "(broker × segment × exchange,",
      );
      const failed = lineFor(dir, "rate-key-vs-schema");
      expect(failed, "a stale rate key is not caught").toMatch(/^FAIL /);
      expect(failed, "and the failure names BOTH sides").toContain("charge_config_uq");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("autoclose-comment-vs-callers: PASS on the tree as it stands, FAIL when the comment claims the W2a default again", () => {
    const dir = plantTree();
    try {
      expect(lineFor(dir, "autoclose-comment-vs-callers"), "the copy itself is clean").toMatch(/^PASS /);
      // Exactly the sentence W2b outdated and the first run of this check
      // caught: the callers pass the flag explicitly, the comment says they
      // write what v4.4.0 wrote.
      const file = path.join(dir, "lib/import/commit.ts");
      const src = fs.readFileSync(file, "utf8");
      const m = /every production caller[\s\S]{0,400}?passes it EXPLICITLY/.exec(src);
      expect(m, "the claim this check reads is no longer in commit.ts").not.toBeNull();
      fs.writeFileSync(file, src.slice(0, m!.index) + "every production caller writes exactly what v4.4.0 wrote" + src.slice(m!.index + m![0].length));
      const failed = lineFor(dir, "autoclose-comment-vs-callers");
      expect(failed, "a stale autoClose claim is not caught").toMatch(/^FAIL /);
      expect(failed, "and the failure names the call sites it read").toContain("route.ts");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
