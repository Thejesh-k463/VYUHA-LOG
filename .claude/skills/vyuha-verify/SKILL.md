---
name: vyuha-verify
description: Run the VYUHA gate (npm run verify) in a forked context and report the exit code and both vitest counts against VYUHA-STATE.md section 2. Use when about to say the suite passes, before a tag, or after a wave of edits lands.
user-invocable: true
context: fork
agent: vyuha-verifier
background: false
arguments:
  - name: extras
    description: "Optional: e2e and/or load to also run those suites (e2e needs port 3100 free)."
    required: false
---

# /vyuha-verify

Runs `npm run verify` ONCE in a forked context, so the 5-8 minute log never enters this
session. The gate is `typecheck && lint && test && build` — `npm test` alone is not the
gate, because client components import `lib/license.ts` and a `node:child_process` in that
import graph fails only at `next build`.

Task for the agent:

1. Run the gate once from `"T:/Thejesh/CLAUDE-CODE/VYUHA-TRADE JOURNAL-V1"`, capturing to
   `verify.log`, and echo the exit code yourself — the harness's "[exited with code 0]" is
   the wrapper, not the command.
2. Report `Test Files N passed` and `Tests N passed`, and compare both to the newest
   `## 2. Current state` block of `VYUHA-STATE.md`, quoting its line number. A DROP is a
   deleted test, not a smaller suite — name the deleted files.
3. Report `git diff --numstat package-lock.json` (deletions must be 0) and `npm ls esbuild`.
4. Report the count of `tests/zzprobe-*` files. Non-zero blocks a commit.
5. If `$extras` contains `e2e`: check port 3100 is free with netstat FIRST, then run it.
   If it contains `load`: run `npm run test:load`.

Return the agent's table verbatim. Never summarise an exit code into a word.
