#!/usr/bin/env node
/**
 * lockfile-guard.mjs — PreToolUse(Bash) for VYUHA.
 *
 * DENY anything that lets npm rewrite package-lock.json:
 *   npm install|i|add|uninstall|rm|update|up|dedupe|prune   (bare `npm install` included)
 *   npx npm-check-updates | npx ncu
 *
 * ALLOW npm ci, npm run *, npm test, npm ls.
 *
 * Why: on this dependency graph a plain `npm install <pkg>` -- no flags, fully
 * installed tree -- deterministically prunes vitest's nested esbuild@0.28.x and
 * its 26 @esbuild/* platform entries. vitest's vite requires esbuild ^0.27||^0.28,
 * so the prune resolves it to the top-level 0.25.x: `npm ls esbuild` reports
 * ELSPROBLEMS and `npm ci` fails on EVERY platform, Windows included.
 * `--package-lock-only` is not a safe alternative -- it drops the darwin/linux
 * optional-dep variants and broke all four CI jobs at v2.99.5.
 *
 * Fail-open: any internal error is logged and the tool proceeds. Always exit 0.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ERR_LOG = path.join(os.homedir(), ".claude", "hooks", "errors.log");

function logError(e) {
  try {
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
    fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} lockfile-guard ${e?.stack || e}\n`);
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

function unquoted(cmd) {
  return String(cmd || "")
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ");
}

// `npm` then any run of flags, then the mutating subcommand. `npm ci`, `npm run x`,
// `npm test` and `npm ls` do not match -- their subcommand is not in the set.
const NPM_MUTATES = /\bnpm\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(install|i|add|uninstall|un|remove|rm|update|up|upgrade|dedupe|ddp|prune)\b/i;
const NCU = /\bnpx\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(npm-check-updates|ncu)\b/i;

const LAW =
  'AGENTS.md lockfile law: "Never let npm rewrite package-lock.json -- not even plain npm install." ' +
  "On this graph a plain npm install prunes vitest's nested esbuild@0.28.x and its 26 @esbuild/* " +
  "platform entries; vite then resolves esbuild to the top-level 0.25.x, npm ls esbuild reports " +
  "ELSPROBLEMS and npm ci fails on every platform. --package-lock-only is not safer: it drops the " +
  "darwin/linux optional-dep variants and broke all four CI jobs at v2.99.5.";

const SPLICE =
  "Procedure that works (AGENTS.md, section Adding a dependency): " +
  "(1) let npm generate a lock ONCE somewhere aside, to harvest the registry integrity hashes; " +
  "(2) git checkout package-lock.json, then splice ONLY the new package's packages entries plus " +
  "the root dependencies line onto HEAD's lock, PRESERVING existing key order (npm collates _ " +
  "differently from Array.sort; a global re-sort silently rewrites unrelated entries); " +
  "(3) prove it: npm ci clean, npm ls esbuild resolves, and " +
  "git diff --numstat package-lock.json shows additions only. " +
  "Allowed here: npm ci, npm run *, npm test, npm ls.";

function main() {
  const input = readStdin();
  const raw = input?.tool_input?.command;
  if (typeof raw !== "string" || !raw) return;
  const cmd = unquoted(raw);

  const m = cmd.match(NPM_MUTATES);
  if (m) {
    decide("deny", `guard: this command lets npm rewrite the lockfile ("npm ${m[1]}"). ${LAW} ${SPLICE}`);
    return;
  }
  const n = cmd.match(NCU);
  if (n) {
    decide("deny", `guard: npx ${n[1]} rewrites package.json and then the lockfile. ${LAW} ${SPLICE}`);
  }
}

try { main(); } catch (e) { logError(e); }
process.exit(0);
