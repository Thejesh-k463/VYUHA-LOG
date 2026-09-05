#!/usr/bin/env node
/**
 * probe-guard.mjs — PreToolUse(Bash) for VYUHA.
 *
 * Two denials, both from AGENTS.md / the v3.5-v3.8 standing gates:
 *
 *  1. A `git commit` while `tests/zzprobe-*` files exist (untracked OR staged).
 *     Probes are deleted before an agent reports. 58 leftovers broke the Windows
 *     CI job in v3.7.
 *  2. Any `git commit|push|tag` issued from a subagent (agent_id / agent_type
 *     present on the hook input). Agents never commit; the orchestrator commits
 *     and pushes at every wave gate.
 *
 * Fail-open: any internal error is logged and the tool proceeds. Always exit 0;
 * the decision travels in stdout JSON, never in the exit code.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ERR_LOG = path.join(os.homedir(), ".claude", "hooks", "errors.log");

function logError(e) {
  try {
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
    fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} probe-guard ${e?.stack || e}\n`);
  } catch { /* ignore */ }
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
}

/** Strip quoted spans so a commit MESSAGE mentioning "git push" cannot trip us. */
function unquoted(cmd) {
  return String(cmd || "")
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ");
}

function gitLines(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return null; // git unavailable / not a repo -- fail open
  }
}

function main() {
  const input = readStdin();
  const raw = input?.tool_input?.command;
  if (typeof raw !== "string" || !raw) return;
  const cmd = unquoted(raw);

  const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
  const isWrite = /\bgit\b[^|;&]*\b(commit|push|tag)\b/.test(cmd);
  if (!isWrite) return;

  // -- 2. subagents never commit -------------------------------------------
  const agent = input?.agent_id || input?.agent_type || input?.agentId || input?.agentType;
  if (agent) {
    decide(
      "deny",
      "guard: build agents never commit -- this Bash call carries an agent id " +
        `(${String(agent)}) and runs "git ${isCommit ? "commit" : "push/tag"}". ` +
        "VYUHA standing gate: agents never commit; the orchestrator commits and pushes " +
        "at every wave gate. Report your diff and let the orchestrator land it.",
    );
    return;
  }

  if (!isCommit) return;

  // -- 1. leftover probes ---------------------------------------------------
  const cwd = input?.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard", "tests"], cwd);
  const staged = gitLines(["diff", "--cached", "--name-only"], cwd);
  if (untracked === null && staged === null) return; // no git -- fail open

  const probes = [...(untracked || []), ...(staged || [])].filter((f) => /zzprobe/i.test(f));
  if (probes.length === 0) return;

  const uniq = [...new Set(probes)];
  decide(
    "deny",
    "guard: build agents never commit a probe -- " +
      `${uniq.length} zzprobe file(s) are untracked or staged: ${uniq.slice(0, 5).join(", ")}` +
      (uniq.length > 5 ? ", ..." : "") + ". " +
      'AGENTS.md / standing gates: "Probes ONLY as tests/zzprobe-*.test.ts, deleted before an ' +
      'agent reports." 58 leftover probes broke the Windows CI job in v3.7. ' +
      "Delete them and re-run the commit.",
  );
}

try { main(); } catch (e) { logError(e); }
process.exit(0);
