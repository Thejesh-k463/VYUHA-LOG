# Session prompt

Copy-paste openers for a new Claude Code session in this repo. Two variants; pick
with one question:

> **Does the task touch imports, charges, money, licensing, or a release?**
> Yes → use the **Full** prompt. No → use the **Short** prompt.

When unsure, use Full. The prompt costs a few hundred tokens; a wrong assumption
about paise-vs-rupees costs a release.

**Do not tell a session to "read all the files".** This repo is 164 `lib/` files,
110 components, 43 screens and a 148 KB changelog. Reading broadly is what makes
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

## Next session — ready-to-paste (updated 2026-08-20, after v2.99.98 + the OpenAlgo opt-in wave)

```
Read CLAUDE.md first (it imports AGENTS.md), then VYUHA-STATE.md §2 and §8. Do not read
anything else yet — §3 is a routing table; open only what the task needs. Then read
docs/DECISIONS.md ONLY for the entries dated 2026-08-20 (six of them; the newest three are the
OpenAlgo opt-in, the Angel One vault bug, and the Paytm pairing reconciliation).

Start this session on Opus 5 (the VYUHA default; the work below is Bash/Edit-bound).

STATE YOU CAN TRUST (verified 2026-08-20):
- Branch main, HEAD 6c232a0 or later, clean, pushed. main is FOUR+ commits ahead of tag v2.99.98
  (af228b5 + f2c375a + d0a2f0f + 6c232a0 = the OpenAlgo opt-in wave and its state/doc updates).
- npm run verify EXIT 0 — 1,920 unit tests / 131 files, build compiled.
- CI green on that work, all 5 jobs incl. Windows and BOTH Playwright e2e suites (run 32366386859).
- v2.99.98 is PUBLISHED and is releases/latest (2026-08-20 03:23Z). Its installer was built from
  commit 6e2dd80, so NONE of the commits above are in the binary buyers have.
- The OpenAlgo integration is built, gated OFF, invisible until enabled, and deliberately absent
  from every buyer-facing document. No live OpenAlgo pull has ever been run.
- Latest migration is 0049.

TASK: cut, build and release v2.99.99, and close the open items below.

WHY THIS RELEASE IS TIME-SENSITIVE — say it plainly in the notes: every shipped build since
v2.99.80, including the currently published v2.99.98, has a BROKEN Angel One live API pull
(encryptSecret("") is unreadable and the pull refused on it before dispatching). The fix is
committed but unreleased, while README, the client docs, the deck and the landing page all
advertise that pull as working. That fix is the reason to release; OpenAlgo rides along
switched off.

Follow the `release` skill start to finish. Specifics that have bitten before:
1. npm run verify (not npm test) BEFORE the bump; report the count you actually saw.
2. npm run bump-version 2.99.99, then BY HAND: package-lock.json root "version" in TWO places
   (lines 3 and 9), and `cd src-tauri && cargo update -p vyuha --offline` for Cargo.lock.
   NEVER npm install / --package-lock-only — it corrupts the lock and breaks all CI jobs.
3. npm run desktop:build (needs Rust+MSVC; in Git Bash
   export PATH="$(cygpath "$USERPROFILE")/.cargo/bin:$PATH"). Prove freshness TWO ways:
   desktop-dist/.next/BUILD_ID is from this build, AND grep the bundle for a marker only this
   version has — use "openalgo" or "Integrations (advanced)".
4. Verify signatures by DECODING the key id, never by trusting "✓ signed": every .sig must be
   4FF85F3BBE1DA21D and match plugins.updater.pubkey in tauri.conf.json.
5. CI must be green on the release commit BEFORE tagging (the Windows job especially). The ubuntu
   Playwright job has hung twice at "Install Playwright browsers" — if it hangs, cancel the run
   and `gh run rerun <id> --failed`; do not tag around it.
6. npm run client:package AFTER the docs are updated (the ZIP packs docs/client/* at build time),
   then OPEN the ZIP and confirm WHATS_NEW.md, TERMS/PRIVACY "Applies to" and both deck chips
   say v2.99.99.
7. Do NOT create or re-publish the revocations prerelease — it exists and must stay a prerelease.
8. Never re-upload assets onto an already published tag: the updater compares version numbers, so
   an existing install would never be offered the same version again, and SmartScreen reputation
   and the client ZIP's CHECKSUMS.txt are both per file hash.

OPEN ITEMS TO CLOSE IN THIS SESSION:
a) docs/client/README.md "New in v2.99.99" MUST LEAD with the Angel One fix in the buyer's words
   ("if your Angel One API pull said the saved credentials could not be read, it now works"),
   then walk docs/owner/DOC_AUDIT.md rows 1,3,5,6,9,10,11,13,14 to bring every buyer-facing
   surface to v2.99.99. Run npm run landing:build after editing the landing page.
b) The Angel One copy is FALSE until this release ships, in at least: README.md ~110/306/321/324,
   docs/client/README.md ~90, docs/client/INSTALLATION_GUIDE.md ~82, docs/sales/landing-page.html
   ~555, docs/client/GETTING_STARTED_DECK.html ~164, CHANGELOG.md ~353/356. Once v2.99.99 is
   built, re-read each and confirm it is true again. Add a CHANGELOG note recording that the pull
   was broken from v2.99.80 to v2.99.98 — the changelog currently has no entry saying so.
c) ASK ME before writing OpenAlgo into any buyer-facing doc. Standing decision: in-app only until
   I have run a live pull and checked it against a contract note. A release note may say a new
   advanced, off-by-default integration exists; it may NOT claim broker coverage.
d) Buyer-ZIP hygiene, my call — ask me: docs/client/TERMS.md and REFUND_POLICY.md still carry the
   ⚠️ OWNER banner and ship to buyers that way; REFUND_POLICY has no "Applies to" line and is
   dated 2026-08-15 while TERMS/PRIVACY say 2026-08-20. docs/client/README.md ~46/~75 still
   forward-sells a macOS edition, and CHANGELOG ~199 offers Mac builds "on request" while ~165
   says macOS is no longer sold.
e) Also mine to decide: the public CHANGELOG still names Pine Script / TradingView indicators
   (~461, ~1978, ~2051) and README ~568 lists "indicators" in the repo tree, while
   tests/no-indicators-in-client-docs.test.ts scans only docs/client + the landing page.
f) Update VYUHA-STATE §2 with verified numbers before we finish, and tell me when it is a good
   point to /clear.

HOW I WANT YOU TO WORK (unchanged):
1. Ask before building; propose what fits this app's structure and what it costs. Multi-agent is
   fine — agents must NOT git stash/commit/checkout, must NOT npm install, and must NOT run
   npm run verify / next build while another agent edits; one verify per wave, run by you.
2. Label every claim VERIFIED (checked now) or INFERRED; say plainly what you could not verify.
3. Scope: app/, components/, lib/, e2e/, tests/ (+ scripts/ and docs/ when the task is about
   them). No adjacent refactors, no new subsystems, no new brokers, no new report screens — with
   the one recorded exception in VYUHA-STATE §8.6 (the OpenAlgo integration, already built).
4. Respect the 10 invariants in AGENTS.md.
5. Anything measured or deliberately deviated → docs/DECISIONS.md via the decision-log skill.
6. Before saying anything is done: npm run verify, the prove-it skill, and report the numbers you
   actually saw (tests, e2e, BUILD_ID, bundle marker, sig key id, installer SHA-256).

ALREADY SETTLED — do not re-open: Pro annual ₹9,999 / lifetime ₹29,999 (list ₹13,000 / ₹35,999
from 2027-01-01); keep the v2.99.0 tag; PDF parser returns trades: [] by design; revocations
prerelease exists; annual→lifetime = full credit within the year; delivery is manual mail/WhatsApp;
intraday data not required; macOS is not sold; landing page = Pages redirect, not a copy; OpenAlgo
is opt-in, off by default, server-gated, and not in BROKERS.

MINE, NOT YOURS (do not attempt): publishing releases, running a live OpenAlgo or broker API pull,
entering any credential, winget + WDSI submissions, license-backup.mjs, the mirror repo, and
installing on a non-build machine.
```

## Maintenance

Item 9 is the part that goes stale. **When a question in `VYUHA-STATE.md` §8.5 is
answered, add it here**, and when something here stops being true, delete it. A
prompt that asserts a stale fact is worse than no prompt, because the session
will defend it.
