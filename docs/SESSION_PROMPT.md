# Session prompt

Copy-paste openers for a new Claude Code session in this repo. Two variants; pick
with one question:

> **Does the task touch imports, charges, money, licensing, or a release?**
> Yes → use the **Full** prompt. No → use the **Short** prompt.

When unsure, use Full. The prompt costs a few hundred tokens; a wrong assumption
about paise-vs-rupees costs a release.

**Do not tell a session to "read all the files".** This repo is 164 `lib/` files,
110 components, 43 screens and a 154 KB changelog. Reading broadly is what makes
a session both expensive and *less* accurate — the window fills with material the
task does not need. `VYUHA-STATE.md` §3 is a routing table precisely so a session
opens the right three files instead of the wrong thirty.

---

## Short — small, contained tasks

```
Read CLAUDE.md (it imports AGENTS.md), then VYUHA-STATE.md. Nothing else yet —
use the routing table in VYUHA-STATE.md §3 to open only what this task needs.

TASK: <what you want done>

- Label every factual claim VERIFIED (checked just now) or INFERRED. If you
  cannot verify something, say so rather than smoothing over it.
- Respect the 10 invariants in AGENTS.md.
- Run `npm run verify` before saying anything is done, and report the numbers
  you actually saw.
- Already settled, do not re-open: Pro annual is ₹9,999; keep the v2.99.0 tag;
  the PDF parser returning trades: [] is by design; the `revocations` prerelease
  exists (do not create it); annual→lifetime is full credit within the year;
  delivery is manual mail/WhatsApp for now; intraday data is not required.
```

---

## Full — imports, charges, money, licensing, releases

```
Read CLAUDE.md first (it imports AGENTS.md), then VYUHA-STATE.md. Do not read
anything else yet — VYUHA-STATE.md §3 is a routing table; use it to open only
what this task actually needs.

TASK: <replace with what you want done>

How I want you to work:

1. Ask me questions before building. Tell me what fits this app's structure and
   what it costs, then build the one we agree on. Don't guess and implement.
2. Label every factual claim VERIFIED (you checked it just now) or INFERRED.
   If you can't verify something, say so plainly rather than smoothing over it.
3. Scope to app/, components/, lib/, e2e/, tests/. No adjacent refactors, no new
   subsystems, no new brokers, no new report screens.
4. Respect the 10 invariants in AGENTS.md. Money is integer paise in the DB and
   rupees at runtime — converting twice is a 100x bug that tests did not catch.
5. Fixtures are schema-only. Real exports live gitignored in tests/fixtures/private/;
   never commit or quote identifiers from them.
6. Before telling me anything is done: run `npm run verify` (NOT `npm test` — the
   build step is what catches unbundlable code), use the prove-it skill, and report
   the numbers you actually saw.
7. Anything you measure, or any default you deliberately deviate from, goes into
   docs/DECISIONS.md via the decision-log skill.
8. If this touches a release, follow the release skill start to finish, and update
   the client package — that is a standing rule for every release.
9. Already settled, do not re-open: Pro annual is ₹9,999; keep the v2.99.0 tag; the
   PDF parser returning trades: [] is by design; the `revocations` prerelease exists
   (do not create it); annual→lifetime is full credit within the year; delivery is
   manual mail/WhatsApp for now; intraday data is not required.
10. When the task is done, update VYUHA-STATE.md with verified numbers and tell me
    it's a good point to /clear.
```

---

## Why these lines are here

**The first line and the last line are the accuracy engine.** The first stops a
session reconstructing context it does not need; the last makes sure the *next*
session starts from verified fact rather than a transcript. Together they turn
`/clear` from a loss into a clean handoff.

**"VERIFIED or INFERRED" is the single highest-value line.** On 2026-08-14 it was
what separated one real hazard (a stale signing key that was genuinely sitting in
the repo root) from two false alarms mined out of old transcripts — a "dead" PDF
parser that is working as designed, and a "dangling" v2.99.0 tag that is real
release history.

**The "already settled" list prevents helpful damage.** All three items are
recorded somewhere as open questions. Without that line a session will find the
₹7,999 figure or the `trades: []` return and try to fix something that is not
broken.

**`npm run verify`, never `npm test`.** typecheck + lint + test all pass on code
that cannot be bundled, because client components import `lib/license.ts` and a
`node:` import anywhere in that graph fails only at `next build`.

---

## Next session — ready-to-paste (updated 2026-08-24, audit session)

```
Read CLAUDE.md first (it imports AGENTS.md), then VYUHA-STATE.md §2 and §8. Do not read
anything else yet — §3 is a routing table; open only what the task needs. Read
docs/DECISIONS.md only for the entries you actually need; the newest are dated 2026-08-24.

Start this session on Opus 5 (the VYUHA default).

STATE YOU CAN TRUST (verified 2026-08-24, repo audit session):
- Branch main, clean, pushed. No uncommitted work.
- v2.99.100 is PUBLISHED and is releases/latest (2026-08-21 16:30Z). v2.99.99 preceded it.
- npm run verify EXIT 0 — 1,962 unit tests / 134 files (incl. tests/sim/), re-run 2026-08-24
  after fixing a date-frozen sell-flow test (DECISIONS 2026-08-24: a frozen --today freezes
  only the caller; children keep real time).
- Installer v2.99.100: 34,863,579 B SHA-256 B89A225D...F14DD4 (local, = the client ZIP's).
  GitHub release asset is a DIFFERENT binary: 34,858,983 B. Not interchangeable — see
  DECISIONS 2026-08-20 "two installers per release".
- Both SKUs SOLD and ACTIVATED (VY-2026-001 lifetime, VY-2026-002 annual, 2026-08-23).
  Sale flow is automated: npm run sell / npm run renewals (docs/owner/LICENSE_OPERATIONS.md §"npm run sell").
- Off-device backup: npm run backup:drive -- <letter> (refuses C:/K:/T: — one physical disk).
- Demo-video kit ready at docs/owner/demo-video/ (npm run demo serves a throwaway seeded book);
  copy guarded by tests/demo-video-copy.test.ts. Recording not yet done.
- winget PR #421585 (v2.99.99) OPEN, validation passed, awaiting a community moderator — do NOT
  open a 2.99.100 PR until it merges, then wingetcreate update.
- Angel One live pull CONFIRMED on the empty-book path (2026-08-20); a pull with REAL FILLS
  is still unexercised.
- OpenAlgo ships switched OFF and unnamed in buyer-facing copy. No live pull has ever been run.
  The hold is on the CLAIM: no copy may say it works until reconciled against a contract note.
- Latest migration is 0049.

TASK: <state it here>. Candidates the owner has not yet picked up:
  - First-run onboarding flow (§8.4's explicit #1 pick; the owner gates the 3.0.0 release on it —
    trial->paid is the bottleneck and nothing guides a fresh install through import -> mark -> review).
  - Record the demo video (kit is complete; docs/owner/demo-video/README.md, shots then Clipchamp).
  - An Angel One API pull with real fills, to close the last unverified half of that path.
  - A live OpenAlgo pull reconciled against a contract note, which is what unblocks ever
    documenting it.

HOW I WANT YOU TO WORK (unchanged):
1. Ask before building; propose what fits this app's structure and what it costs. Multi-agent is
   fine — agents must NOT git stash/commit/checkout, must NOT npm install, and must NOT run
   npm run verify / next build while another agent edits; one verify per wave, run by you.
2. Label every claim VERIFIED (checked now) or INFERRED; say plainly what you could not verify.
3. Scope: app/, components/, lib/, e2e/, tests/ (+ scripts/ and docs/ when the task is about
   them). No adjacent refactors, no new subsystems, no new brokers, no new report screens — with
   the one recorded exception in VYUHA-STATE §8.6 (the OpenAlgo integration, already built).
4. Respect the 10 invariants in AGENTS.md.
5. Anything measured or deliberately deviated -> docs/DECISIONS.md via the decision-log skill.
6. Before saying anything is done: npm run verify, the prove-it skill, and report the numbers you
   actually saw (tests, e2e, BUILD_ID, bundle marker, sig key id, installer SHA-256).

IF THE TASK IS A RELEASE: follow the `release` skill start to finish. Traps already paid for:
1. npm run verify (not npm test) BEFORE the bump; report the count you actually saw.
2. npm run bump-version x.y.z, then BY HAND: package-lock.json root "version" in TWO places
   (lines 3 and 9), and `cd src-tauri && cargo update -p vyuha --offline` for Cargo.lock.
   NEVER npm install / --package-lock-only — it corrupts the lock and breaks all CI jobs.
3. npm run desktop:build, then prove freshness TWO ways: BUILD_ID must CHANGE (record it BEFORE
   the build), and grep the bundle for a marker only the new version has.
4. Verify signatures by DECODING the key id (2-byte alg, 8-byte little-endian key id), never by
   trusting "signed". Local .sig files can be checked before tagging; `npm run release:verify
   <tag>` needs the tag to exist and checks the CI-signed assets, which come from a different
   key source (the repo secret). Both must read 4FF85F3BBE1DA21D.
5. CI green on the release commit BEFORE tagging. If the ubuntu Playwright job hangs at
   "Install Playwright browsers", cancel and `gh run rerun <id> --failed`; do not tag around it.
6. npm run client:package AFTER the docs are updated, then OPEN the ZIP and check WHATS_NEW.md,
   TERMS/PRIVACY/REFUND "Applies to" and both deck chips.
7. Do NOT create or re-publish the revocations prerelease — it exists and must stay a prerelease.
8. Never re-upload assets onto an already published tag.
9. winget:manifest REQUIRES --sha, and it must be the PUBLISHED asset's hash, not your local
   build's. WDSI takes the ZIP's installer instead. DOC_AUDIT rows 15/16/20.

ALREADY SETTLED — do not re-open: Pro annual Rs 9,999 / lifetime Rs 29,999 (list Rs 13,000 /
Rs 35,999 from 2027-01-01); keep the v2.99.0 tag; PDF parser returns trades: [] by design;
revocations prerelease exists; annual->lifetime = full credit within the year; delivery is manual
mail/WhatsApp; intraday data not required; macOS is not sold; landing page = Pages redirect, not a
copy; OpenAlgo is opt-in, off by default, server-gated, and not in BROKERS.

MINE, NOT YOURS (do not attempt): publishing releases, running a live OpenAlgo or broker API pull,
entering any credential, winget + WDSI submissions, license-backup.mjs, the mirror repo, and
installing on a non-build machine.
```

## Maintenance

Item 9 is the part that goes stale. **When a question in `VYUHA-STATE.md` §8.5 is
answered, add it here**, and when something here stops being true, delete it. A
prompt that asserts a stale fact is worse than no prompt, because the session
will defend it.
