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

## 0. Before the fan-out — three rules learned on v4.0.0 (2026-09-06)

1. **The target commit is pushed and its CI run exists before step 1 starts.** Merge, push,
   wait for `gh run list --commit <sha>`, THEN audit. v4.0.0 batched merge + bump + fix wave into
   one push, so two test-drift reds (a local-vs-IST date, a sidebar fold that had grown to six
   screens) surfaced a day late. Any red CI job on the target counts as a finding in the union.
2. **Seam pass first for any multi-builder target.** Launch `vyuha-seam-tester` on the wave's
   file-ownership map before the six auditors; its seam DEFECTS enter the union as confirmed
   findings and its tests land with the fix wave. Seven of v4.0.0's first-pass money findings were
   values handed between files owned by different builders (`side`, frozen R, `avgEntryP`
   rounding); nobody had run the two halves together.
3. **The orchestrator edits docs with the Edit tool, never with an append script.** A `use utf8`
   string concatenated onto a raw slurp double-encoded every non-ASCII character in
   `docs/DECISIONS.md` twice on 2026-09-06 (~1,080 lines, rebuilt from `4158f6c`). That file is
   CRLF; when a script is unavoidable, append UTF-8 BYTES (`cat` a file, or `Encode::encode`)
   and verify a mojibake scan (the byte pairs for a-circumflex + euro sign, A-tilde, A-circumflex) returns 0 and there are zero LF-only lines before committing.

## 0.5 The stopping rule (owner ruling 2026-09-11, 06-ANSWERS "Audit stopping rule") — apply to EVERY finding

- **Reopens work (a fix wave):** any PRODUCT defect, at any severity, and any test-integrity finding graded MEDIUM or above.
- **Recorded, never a new wave:** LOW / cosmetic findings that live only in tests (a pin that could be stricter, a harness
  nit). Write each into the round's `docs/DECISIONS.md` entry — id, `file:line`, why it is not fixed — and move on.
- **A fix wave is verified by a SCOPED re-check, not a new full round:** the skeptic re-checks each fix against its finding,
  every fix is red-on-revert with the assertion quoted, one `npm run verify`, CI green. A new full round only when the fix
  wave changed product code in an area no lens has audited.
- Tell the owner, every time, which findings are PRODUCT and which are TEST-ONLY. Superseded: the round-8 precedent of
  fixing every low pin gap (the ladder never converged: each round found the next surviving mutant in the last fix's tests).

## 1a. The release-level audit — ONCE per release, in ONE session, every lens (owner: "no new defect comes … highest accurate build")

Run it over `<last tag>..HEAD` after the last feature/fix wave has its CI run. It exists because nine diff-scoped rounds
missed four 4.3.0 product defects that the release-notes draft found in an hour (DECISIONS 2026-09-11, C-3..C-6). One
workflow, auditors and skeptic on Fable, in this order:

1. **Release-notes claims — drafted FIRST.** One agent drafts the CHANGELOG section, the README quote, the client README
   "New in", the install-guide upgrade lines and the landing chip into the scratchpad, every claim checked against CODE with
   `file:line`. A claim the code does not back is a finding (product if the code is wrong, docs if the copy is). The drafts
   are then the bump's inputs.
2. **The six dimensions (§1),** each with TWO auditors on different lenses (e.g. refute-first vs reproduce/trace) — same
   dimension, never a seventh.
3. **Ruling conformance.** Every row of every `06-ANSWERS.md` table ruled for this release → the code that implements it →
   the test that pins it. Behaviour that diverges from the ruling, or a ruling with no pinning test, is a finding.
4. **User journeys.** Each user-visible flow the release touched, traced end to end — UI → route → lib → DB → back to the
   screen — asking what the user SEES after every action. A real write that reads as a no-op ("0 added"), a silent clamp, a
   message that is false on the common path: findings (C-4, C-5, C-6 were all this).
5. **Mutation on money and data paths.** For each changed module that computes or writes money, rates or trades: name the
   smallest mutants and prove the suite kills them; a module that guards money gets an IN-SUITE mutant table
   (`tests/rate-card-refresh.test.ts` is the pattern).
6. **Upgrade on a copy of the owner's live DB** (STATE §0.3 V3 procedure): the real sidecar startup twice, the migration +1
   then +0, the rate-card refresh counts as expected then 0/0. The only lens that found F1.
7. **Seams** (`vyuha-seam-tester`) when the release had more than one builder.
8. **Completeness critic, last.** One agent lists what no lens covered — diff files no auditor opened, rulings not traced,
   flows not walked, modules without a mutant check — and each material gap gets a targeted pass IN THE SAME RUN before the
   skeptic. The audit is done when the critic's list is empty or every item on it is recorded as out of scope with a reason.

Then §2 (the skeptic over the union), the stopping rule, and §3 (the plan, asked before any fix agent starts).

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

The fix wave gets its OWN verification before a tag — the SCOPED re-check of §0.5 (the skeptic
re-checks each fix against its finding, red-on-revert quoted, one `npm run verify`, CI green). Re-run step 1 on the fix
wave's diff ONLY when it changed product code in an area no lens of the release-level audit (§1a) covered. A fix wave
that was not verified is how v3.5.0 and v3.7.0 died; a ladder of full rounds over test nits is how 4.3.0 stalled.

Probes are `tests/zzprobe-*.test.ts` only and are deleted before any agent reports; the
project's `probe-guard` hook will deny the commit while one exists.
