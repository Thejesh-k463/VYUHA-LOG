#!/usr/bin/env node
/**
 * session-line.mjs — SessionStart for VYUHA.
 *
 * Injects ONE line (<= 200 chars) so the session starts knowing where the repo is:
 *   [vyuha] v3.9.0 | dirty 0 | tag v3.9.0 | probes 0
 *
 * Fail LOUD, never silent: a part that cannot be read prints ERR rather than being
 * dropped, and a total failure still emits a line saying the hook failed. Silence
 * would read as "clean", which is the one thing it must never imply.
 *
 * Always exit 0; the text travels in stdout JSON.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ERR_LOG = path.join(os.homedir(), ".claude", "hooks", "errors.log");

function logError(e) {
  try {
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
    fs.appendFileSync(ERR_LOG, `${new Date().toISOString()} session-line ${e?.stack || e}\n`);
  } catch { /* ignore */ }
}

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

function emit(text) {
  const line = text.length > 200 ? text.slice(0, 197) + "..." : text;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line },
  }));
}

/** Nearest ancestor of `start` that holds a package.json. */
function repoRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return start;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
  });
}

function main() {
  const input = readStdin();
  const cwd = input?.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
  const root = repoRoot(cwd);

  let version = "ERR";
  try { version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "ERR"; }
  catch (e) { logError(e); }

  let dirty = "ERR";
  try { dirty = String(git(["status", "--short"], root).split(/\r?\n/).filter((s) => s.trim()).length); }
  catch (e) { logError(e); }

  let tag = "ERR";
  try { tag = git(["describe", "--tags", "--abbrev=0"], root).trim() || "none"; }
  catch (e) { logError(e); }

  let probes = "ERR";
  try {
    const testsDir = path.join(root, "tests");
    probes = fs.existsSync(testsDir)
      ? String(fs.readdirSync(testsDir).filter((f) => /^zzprobe-/i.test(f)).length)
      : "0";
  } catch (e) { logError(e); }

  const warn = probes !== "0" && probes !== "ERR" ? " <- DELETE BEFORE COMMIT" : "";
  emit(`[vyuha] v${version} | dirty ${dirty} | tag ${tag} | probes ${probes}${warn}`);
}

try {
  main();
} catch (e) {
  logError(e);
  try { emit(`[vyuha] session-line FAILED: ${String(e?.message || e).slice(0, 120)}`); } catch { /* ignore */ }
}
process.exit(0);
