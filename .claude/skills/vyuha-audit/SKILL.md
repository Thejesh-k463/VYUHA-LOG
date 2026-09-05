---
name: vyuha-audit
description: Orchestrate the six-dimension adversarial audit of a VYUHA diff or area, then a skeptic pass over the confirmed findings, then an approved fix-wave plan. Use before a tag, after a wave lands, or when the user says "audit this", "what did we break", "pre-tag audit".
user-invocable: true
arguments:
  - name: target
    description: "What to audit: a git range (e.g. fb0e215..HEAD), a wave name, or an area (e.g. lib/import)."
    required: true
---

# /vyuha-audit $target

You are the ORCHESTRATOR for this audit. Do not audit anything yourself — you fan out, then
you gate. This skill does not fork; it runs in your context so you can hold the plan.

## 1. Fan out — six auditors, in parallel, one message

Launch six `vyuha-auditor` agents in a SINGLE message so they run concurrently. Each gets
exactly ONE dimension and the same `$target`:

| # | dimension |
|---|---|
| 1 | `money` |
| 2 | `schema-migrations` |
| 3 | `security-gating-consent` |
| 4 | `ui-regressions` |
| 5 | `test-integrity` |
| 6 | `docs-claims` |

Each prompt states: the dimension, the exact target, that the agent is read-only, and that
every candidate must be REFUTED by the agent itself before it is reported. Give no agent two
dimensions, and never substitute a dimension of your own.

## 2. Skeptic pass

Take the UNION of the CONFIRMED findings from all six and run the global `skeptic` agent
over them. Its job is to kill the ones that do not survive a second reading. Report the
before/after counts: confirmed by auditors -> surviving the skeptic.

Do not add findings at this stage, and do not quietly drop a finding the skeptic did not
kill.

## 3. Wave plan, then ASK — before any fix agent starts

Build a fix-wave plan from the survivors and present it via `AskUserQuestion` for the
operator's approval BEFORE a single fix agent starts. Batch the decisions, 2-4 options each,
your recommendation first and marked "(Recommended)".

The plan must state, per wave:

- Which findings that wave fixes, by id, ranked: silent wrong number > data loss > broken
  feature > cosmetic.
- **Disjoint file ownership per agent**, written out. Cross-cutting files (`commit.ts`,
  `route.ts`, `lib/audit.ts`, `accounts.ts`) get ONE agent for the whole wave; migrations get
  ONE agent, and it owns the `drizzle/meta/_journal.json` entry too.
- That every fix lands with a test proven RED by actually reverting the fix, with the failing
  assertion quoted.
- That agents never commit — the orchestrator commits and pushes at the wave gate.
- One `npm run verify` per wave, run by you, exit code echoed by your own `echo`.

## 4. After the fix wave

The fix wave gets its OWN audit before a tag. Re-run step 1 on the fix wave's diff. A fix
wave that was not audited is how v3.5.0 and v3.7.0 died.

Probes are `tests/zzprobe-*.test.ts` only and are deleted before any agent reports; the
project's `probe-guard` hook will deny the commit while one exists.
