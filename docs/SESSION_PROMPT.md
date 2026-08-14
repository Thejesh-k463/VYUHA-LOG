# Session prompt

Copy-paste openers for a new Claude Code session in this repo. Two variants; pick
with one question:

> **Does the task touch imports, charges, money, licensing, or a release?**
> Yes → use the **Full** prompt. No → use the **Short** prompt.

When unsure, use Full. The prompt costs a few hundred tokens; a wrong assumption
about paise-vs-rupees costs a release.

**Do not tell a session to "read all the files".** This repo is 164 `lib/` files,
110 components, 43 screens and a 137 KB changelog. Reading broadly is what makes
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
  the PDF parser returning trades: [] is by design.
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
   PDF parser returning trades: [] is by design.
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

## Maintenance

Item 9 is the part that goes stale. **When a question in `VYUHA-STATE.md` §8.5 is
answered, add it here**, and when something here stops being true, delete it. A
prompt that asserts a stale fact is worse than no prompt, because the session
will defend it.
