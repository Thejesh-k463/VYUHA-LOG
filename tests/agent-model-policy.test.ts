import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Agent model policy (owner ruling 2026-10-01): every `.claude/agents/*.md`
 * declares `model:` in its YAML frontmatter, and that model is `opus` — unless
 * the file carries a measured Sonnet admission, a line `model-measured: D<n>`
 * (in the frontmatter or the body) naming the DECISIONS row that measured it;
 * then `sonnet` is also allowed. Haiku is never allowed, admission or not.
 *
 * A prose rule decays: the release steward sat on `sonnet` until the
 * 2026-10-01 fleet-tune caught it by hand. This makes the rule executable.
 *
 * An empty glob must FAIL, never pass vacuously — a check that scans nothing
 * agrees with itself.
 */

const root = process.cwd();
const agentsDir = path.join(root, ".claude", "agents");
const agentFiles = existsSync(agentsDir)
  ? readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
  : [];

const MEASURED_ADMISSION = /^model-measured:\s*D\d+/m;

function frontmatter(text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  return lines.slice(1, end).join("\n");
}

function modelOf(fm: string): string | null {
  const m = /^model:[ \t]*(.*)$/m.exec(fm);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

describe("agent model policy (.claude/agents/*.md)", () => {
  it("scans at least one agent file (an empty glob is a failure, not a pass)", () => {
    expect(agentFiles.length, `no .md files found under ${agentsDir}`).toBeGreaterThan(0);
  });

  it.each(agentFiles)("%s declares an allowed model", (file) => {
    const text = readFileSync(path.join(agentsDir, file), "utf8").replace(/\r\n/g, "\n");
    const fm = frontmatter(text);
    expect(fm, `${file}: no YAML frontmatter between the first two --- lines`).not.toBeNull();

    const model = modelOf(fm ?? "");
    expect(model, `${file}: frontmatter has no model: key`).toBeTruthy();
    expect(model ?? "", `${file}: model is Haiku — never allowed`).not.toMatch(/haiku/);

    const admitted = MEASURED_ADMISSION.test(text);
    const allowed = admitted ? ["opus", "sonnet"] : ["opus"];
    expect(
      allowed,
      `${file}: model "${model}" is not allowed` +
        (admitted ? "" : " (sonnet needs a `model-measured: D<n>` line beside it)"),
    ).toContain(model);
  });
});
