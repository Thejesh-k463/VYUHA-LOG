# Handoff-hygiene pass — VYUHA, 2026-09-10

The record of the pass that gave this repo `VYUHA-STATE.md` §0, emptied version state out of memory,
and moved every VYUHA folder under `T:\Thejesh\CLAUDE-CODE\VYUHA\`. No feature work, no refactor.
Every claim below says how it was established. The installed app, its database and the release
pipeline were not touched; the only source lines changed are listed in §6.

## 1. Sessions live when this ran (read from `~/.claude/coord/sessions/*.json`)

| session | repo | cwd | state |
|---|---|---|---|
| 5c15901e | HUB | `T:\Thejesh\CLAUDE-CODE` | busy |
| 873d5c52 | HUB | `T:\Thejesh\CLAUDE-CODE` | busy |
| b4b665d1 | SENTINEL | `T:\Thejesh\CLAUDE-CODE\TRADE-SENTINAL` | busy — running the same pass on SENTINEL; its in-flight file `sentinel-repo-is-authoritative.md` was left uncommitted in `~/.claude` |
| c894b83b | HUB | `…\MOCK-INTERVIEW` | idle |
| 93d9d53b | HUB → adopted VYUHA | started at the hub root; the app moved its cwd into the repo mid-session | this pass |

Nobody else was on VYUHA. This session started in the hub, so it loaded the HUB memory copy — the
fork the pass exists to fix.

## 2. Memory contradiction table (before any change)

| file (hub copy) | claim | repo truth | how checked |
|---|---|---|---|
| `vyuha-v430-build-state.md` | HEAD `a00ddd0`, wave 2 not audited, NEXT = audit | true at write time, but a snapshot: HEAD was already `e0378eb` | `git log --oneline -8` |
| `vyuha-v420-build-state.md` | "NEXT: ask for the owner's fix list; then 4.2.1" | the list came 2026-09-09 and became v4.3.0 wave 1; ruled "no v4.2.1 ever" | STATE §2, 06-ANSWERS last row of "v4.2.1 rulings" |
| `vyuha-v390-build-state.md` | v3.9.0 published; next prompt `NEXT_SESSION_V391_V400_LIVEDESK.md`; owner input files at the hub root | four releases later; that prompt is history; the files are in `TESTING+RESEARCH/RESEARCH FILES/` | `git tag`, `ls` |
| `vyuha-web-platform-research.md` | pack at `T:/…/CLAUDE-CODE/VYUHA-WEB-PLATFORM-RESEARCH/` | `TESTING+RESEARCH/VYUHA-WEB-PLATFORM-RESEARCH/` | `ls` |
| `vyuha-wealth-planner-decision.md` | VYUHA v2.99.101 / 87k LOC; Atlas "phases 0, 1, 0.5, 1.5 DONE, 49/49 tests" | `VYUHA-ATLAS-STATE.md`: phase 6 done, 182/182 tests in 23 files | read of the Atlas state file |
| `vyuha-live-desk-v4-inputs.md` | "Status: still open, NOT consumed" | still true, but a status line in memory | STATE §0 pickup table row 6 now owns it |
| hub `MEMORY.md` lines | "wave 2 COMMITTED a00ddd0 … NEXT = audit"; "v4.2.0 PUBLISHED"; "VYUHA v3.8–v4.2 all PUBLISHED" | version state in the index | Edit-only fix |
| own copy `T--…-VYUHA-TRADE-JOURNAL-V1/memory` | 4 files, byte-identical to the hub copies, no pointer, no state | consistent by accident (sparse), not by design | `diff -q` on all four |

**Result:** the three build-state files were deleted (owner: "proceed with the best option"); their
durable traps moved into `vyuha-repo-is-authoritative.md`, present in BOTH memory dirs; the three
other files were rewritten without counts, versions or "next" instructions; the own dir now mirrors
the eleven durable VYUHA files and indexes them. Neither copy carries a version, an owed list, a
commit sha, a test count or a prompt filename.

## 3. Deletions (each approved by a pop-up answer before it happened)

| what | evidence it was dead | approval |
|---|---|---|
| 8 probe dirs at the hub root: `.vyuha-refute-reopen`, `.vyuha-review-probe`, `_audit_probe_skeptic`, `_audit_probe_v370`, `_skepB_probe`, `_skeptic-probe`, `_vyuha_probe_skepD`, `_vyuha_probe_tmp` | all written 2026-09-03 01:20–02:03 (v3.7.0 audit night); each a vitest config with `root` = this repo and `include` = its own folder; no `.git`; zero references in this repo (Grep); findings already in `docs/DECISIONS.md` 2026-09-02/03 entries; 153 KB total | "Delete all four" ×2 |
| `probe-fixture.ts` (tracked, repo root) | 30-line XLSX header probe; zero references (Grep) | approved |
| `vyuha-v390/v420/v430-build-state.md` (hub memory) | pure snapshots, see §2 | "proceed with the best option" |

Kept on request: `revert-done.txt` (tracked, contains "done").

## 4. The move (approved per folder) and the path sweep

| from | to |
|---|---|
| `VYUHA-TRADE JOURNAL-V1` (git repo) | `VYUHA\TRADE-JOURNAL` |
| `VYUHA-ATLAS` (git repo) | `VYUHA\ATLAS` |
| `VYUHA-LIVE-DESK-RESEARCH` | `VYUHA\LIVE-DESK-RESEARCH` |
| `TESTING+RESEARCH\BROKER FILES FOR TESTING` | `VYUHA\BROKER-FILES-FOR-TESTING` |
| `TESTING+RESEARCH\MTF FILES` | `VYUHA\MTF-FILES` |
| `TESTING+RESEARCH\Trade-Journal-V1` | `VYUHA\ARCHIVE\TRADE-JOURNAL-V1-PROTOTYPE` |
| `TESTING+RESEARCH\trade-journal` | `VYUHA\ARCHIVE\TRADE-JOURNAL-ELECTRON` |
| `TESTING+RESEARCH\Trading Journal Design Enhancement` | `VYUHA\ARCHIVE\DESIGN-ENHANCEMENT` |
| `~/.claude/projects/T--Thejesh-CLAUDE-CODE-VYUHA-TRADE-JOURNAL-V1` (23 entries, 276 MB of session history + memory) | `…-VYUHA-TRADE-JOURNAL` — in lockstep, so history follows the folder |

Left where they were, by the owner's choice: `TESTING+RESEARCH\VYUHA-WEB-PLATFORM-RESEARCH`.
Not VYUHA's to move: `OPENALGO-HANDOFF` (has a SENTINEL half), `TESTING+RESEARCH\RESEARCH FILES`
(VYUHA inputs mixed with Sentinel files), `HANDOFF-HYGIENE-PROMPT.md` (estate-level).

The Atlas projects dir needed no rename: `VYUHA\ATLAS` slugs to the same `T--Thejesh-CLAUDE-CODE-VYUHA-ATLAS`.

**Sweep:** a literal string-replacement script (23 ordered rules, longest path form first) over 1,578
text files in the repo, Atlas, both research packs, `OPENALGO-HANDOFF\VYUHA`, both memory dirs,
`~/.claude/coord/config.json` and `~/.claude/agents/scout.md`. Result: **73 replacements in 42
files; a re-run reports 0.** The repo-side files: `.claude/settings.json` (3 hook commands — the
owner approved this exact change in chat), `.claude/agents/*` (3), `.claude/skills/vyuha-verify/SKILL.md`,
`AGENTS.md` (2), `VYUHA-STATE.md` (9), `docs/DECISIONS.md` (7), `docs/prompts/*` (5),
`docs/owner/demo-video/tour/VOICE-HANDOFF.md`, `lib/analytics/strategy-catalogue.ts` (1 comment),
`lib/domain/options-help.ts` (1 comment), `tests/helpers/owner-broker-files.ts` (the `OWNER_DIR`
default; the folder was `ls`-checked at the new path), `scripts/backup-to-drive.mjs` (2).
Atlas: its `.claude/settings.json` (2 hook commands), 3 agents, `AGENTS.md`, `VYUHA-ATLAS-STATE.md`.
`coord/config.json`: the VYUHA root, the memory `mergeFrom` entry, the Atlas root.

**Not swept — operator items:** `~/.claude/settings.json` line 236 (the trust-repo description
string) — the hook-gate denies agents and the auto-mode classifier blocked `hook-gate.mjs unlock`;
one manual edit, `VYUHA-TRADE JOURNAL-V1` → `VYUHA\TRADE-JOURNAL`. `~/.claude/hooks/learn.mjs` line 220
is a comment about the old space-in-path case and `skills/token-efficient-coding/SKILL.md` line 200
is a historical measurement label — both left as history, neither is a path that resolves.

Build caches (`.next`, `src-tauri/target`, `tsconfig.tsbuildinfo`) hold absolute paths and will
rebuild once; `npm run verify` rebuilds `.next` and is the proof (§7).

## 5. Naming and organisation report

**`SENTINAL` vs `SENTINEL` in THIS repo** (Grep, 22 occurrences in 9 files): `AGENTS.md:219`
(`--src "T:/Thejesh/CLAUDE-CODE/TRADE-SENTINAL/sentinel/NIFTY INDICES"` — a real read-only build
input path), `scripts/build-sector-map.mjs:9` (comment naming the same folder), `VYUHA-STATE.md`
(2 prose mentions), `docs/V380_BUILD_PLAN.md` (3), `docs/DECISIONS.md` (5, incl.
`TRADE-SENTINAL/sentinel/holidays.yaml`), the three `docs/prompts/*` (5), and
`tests/load/a5-staged-depth.load.ts` (4 — the word "SENTINEL" as a test-value name, unrelated to
the project). Every project mention uses the misspelled folder name because that IS the folder's
name. The SENTINEL session is moving that tree (`SENTINEL/bot`); when the bot repo lands there,
`AGENTS.md:219` and the DECISIONS holiday-file path must follow. Nothing in this repo's code,
config, git remotes or hooks depends on the spelling beyond those two paths.

**Folder names with spaces this repo still references:** `TESTING+RESEARCH\RESEARCH FILES`
(the owner's sector inputs; referenced by the memory path table only) and
`TRADE-SENTINAL\sentinel\NIFTY INDICES` (`AGENTS.md`, `scripts/build-nse-index-map.mjs`). Both
are quoted at every use. Estate folders with spaces that this repo does NOT reference:
`TESTING+RESEARCH\TRADE FINDER`. The spaces in this project's own folders are gone.

**Duplicate / ambiguous folders:** the three journal prototypes are now under `VYUHA\ARCHIVE\`
with names that say what they are; this repo depended on none of them. `CHARTINK-PROJECT` vs
`CHARTINK-PROJECT-v1` (under `TESTING+RESEARCH`): not referenced by this repo; belongs to the
Atlas/Chartink line — report only.

**Probe / scratch / archive dirs:** the eight VYUHA probes are deleted (§3). Remaining at the
estate level, none referenced by this repo: `_archive` (one file, `FLEET-BUILD-STATE.md`, consumed),
`TESTING+RESEARCH\{Experiment-1, SPEC-BACKUP-2026-09-04, IHATEFILES-TEARDOWN, MTF …}`; the stale
projects slug `T--Thejesh-CLAUDE-CODE-VYUHA-TRADE-JOURNAL-V1--claude-worktrees-competent-feistel-2f5e26`
(a worktree that no longer exists — `git worktree list` shows only `main`). Proposals, each a
question for the owner, none acted on: delete the worktree slug dir; archive `Experiment-1`
(last written 2026-07-29) and `SPEC-BACKUP-2026-09-04` once its owner confirms it is consumed.

**Hub index compaction:** not needed — the hub `MEMORY.md` is ~17 KB after this pass's Edit-only
changes; it was never rewritten or reordered.

**Memory-merge is one-way.** `coord.mjs memory-merge` copies the project dir into the hub, never
back. A session opened inside `VYUHA\TRADE-JOURNAL` loads only the project dir, so the estate-wide
feedback memories (commit-and-push-always, ask-all-questions-before-build, …) are invisible to it.
This pass mirrored the VYUHA files; mirroring the feedback set is a separate decision for the owner.

### Contribution paragraph for the future estate `T:\Thejesh\CLAUDE-CODE\README.md`

> **VYUHA** — the flagship: a commercial trade journal for Indian retail traders (Tauri desktop +
> Next.js sidecar, per-buyer licensing). **Canonical folder:** `VYUHA\TRADE-JOURNAL` (git; `origin`
> = github.com/Thejesh-k463/VYUHA-LOG, public; `mirror` = codeberg). **State file:**
> `VYUHA-STATE.md` §0 START HERE (authoritative; the pickup table and the superseded-claims ledger).
> **Prompt:** `VYUHA\LIVE-DESK-RESEARCH\NEXT-SESSION-CONTINUATION.md` §0 (research-pack specifics;
> points back to STATE §0). **Status:** LIVE, released; v4.2.0 published, v4.3.0 in build on
> 2026-09-10 (read §0, never this line). **Siblings under `VYUHA\`:** `ATLAS` (separate product,
> own git repo and state file, one-way ingest from the journal), `LIVE-DESK-RESEARCH` (rulings,
> ledger, prompts, index-constituent build inputs), `BROKER-FILES-FOR-TESTING` (the owner's real
> exports, read by tests, never committed), `MTF-FILES`, `ARCHIVE\` (three retired prototypes).
> **Depends on, read-only:** `TRADE-SENTINAL\sentinel\NIFTY INDICES` (index lists) and
> `TESTING+RESEARCH\RESEARCH FILES` (sector inputs). **Confused with:** the archived prototypes and
> `TESTING+RESEARCH\VYUHA-WEB-PLATFORM-RESEARCH` (research only, left in place).

## 6. Every non-doc line this pass changed in the repo

- `lib/analytics/strategy-catalogue.ts`, `lib/domain/options-help.ts`: one comment each, a folder
  name in a research-pack citation. No code.
- `tests/privacy-feed-disclosure.test.ts`: the header string the test slices on, because the
  v4.1.0 block's header was renamed to `## 2-hist. v4.1.0 …` (five stale "## 2. Current state"
  headers were renamed; no content moved or deleted).
- `tests/helpers/owner-broker-files.ts`: the `OWNER_DIR` default path (folder moved; verified present).
- `scripts/backup-to-drive.mjs`: two source paths (folder moved).
- `.claude/settings.json`: three hook command paths (folder moved; owner-approved in chat).
- `probe-fixture.ts`: removed (approved).

## 7. Gate and index counts (re-measured at the end of the pass — see the commit message and §0)

- `rtk proxy npm run verify` after every change above, from the moved folder: **exit 0**; raw vitest
  line `Test Files 378 passed (378)` / `Tests 7598 passed | 35 skipped (7633)`; lint 0 errors,
  3 pre-existing warnings; `next build` compiled. Identical to the hand-off counts, so nothing shrank.
- Hooks at the new paths: all five (`probe-guard`, `lockfile-guard`, `session-line`; Atlas
  `secrets-guard`, `session-line`) invoked directly with an empty payload — each exits 0.
- Memory indexes: hub `links=113 files=113 broken=0 unindexed=0`; project
  `links=11 files=11 broken=0 unindexed=0`.
- `~/.claude` committed before (`9fa7f17`, empty marker) and after (`0628b65`); the hub `MEMORY.md`
  was changed by targeted Edits only.

## 8. Not touched, and why

- Another project's memory files and lines; the SENTINEL session's in-flight memory file.
- `~/.claude/settings.json`, `hooks/learn.mjs` (hook-gated; operator items above).
- `TESTING+RESEARCH\VYUHA-WEB-PLATFORM-RESEARCH`, `RESEARCH FILES`, `OPENALGO-HANDOFF` (owner's choice / shared).
- `docs/DECISIONS.md` and `CHANGELOG.md` content beyond path strings — they are history and correct as history.
- The estate `README.md` — not created; the paragraph above is the contribution.
- The v4.2.1 rulings themselves: the table title now says the premise was superseded; every ruling stands.
