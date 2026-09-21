# VYUHA-STATE — archived §0 blocks

Superseded §0 START HERE blocks, byte-for-byte, newest first. Nothing here is state; `VYUHA-STATE.md` §0 is.

---

## §0 as it stood until 2026-09-18 (replaced by the thirteenth session)

## §0 START HERE — reconciled 2026-09-17 IST at code `b2af3d8` (fix wave 2O, CI run 35125379974 SUCCESS 6/6; its scoped re-check RAN — 42 / 0 / 0, 16 findings; fix wave 2P DESIGNED and design-reviewed, NOT built; **the owner's instruction 2026-09-17: build 2P, then the release ritual — no more re-check loops**) by the eleventh session; the commit that landed this block is the next one in `git log`

**Read order, every session, in this order and no other:**

1. **This §0.** It outranks every other document. *If any document disagrees with §0, §0 wins and the other document is the bug — fix it in the same turn.* **Memory is not authoritative; it forks by cwd** (hub copy vs the project copy) and rots; it now carries pointers and durable traps only.
2. `VYUHA/LIVE-DESK-RESEARCH/NEXT-SESSION-CONTINUATION.md` §0 — research-pack specifics for the item you are picking up (audit known-inputs, ruling tables, ledger pointers). It points back here.
3. Re-derive before asserting: `git log --oneline -3` · `git tag --sort=-creatordate | head -1` · `package.json` `"version"` · `gh run list --limit 3` · the RAW vitest line (§0.3).
4. `AGENTS.md` before any code change (on conflict AGENTS.md wins over this file; the code wins over both). Owner rulings: `06-ANSWERS.md` newest table LAST; `docs/DECISIONS.md` newest entries at the END (its header still says newest-first, but every entry since 2026-09-10 is appended — grep `^## 2026-`, never read it whole) — binding, never re-ask one.
5. §3 of this file for where any other answer lives.

**The one-line state (verified 2026-09-17 at code `b2af3d8`; HEAD = the eleventh-session docs commit on it):** published release = **v4.2.0** (tag `9da7bc8` → `b488dde`).

- **⛔ OWNER INSTRUCTION 2026-09-17 (06-ANSWERS "Owner instruction 2026-09-17"), binding for the rest of 4.3.0:** build fix wave 2P,
  then go STRAIGHT to the release ritual (row 2). NO scoped re-check of 2P, NO wave 2Q, NO wave 3 inside 4.3.0 (deferred to the
  release after it), minimal agents (one builder at a time, one seam pass, one gate), orchestrate on Opus. The audit → fix wave →
  re-check → next wave loop ran from 2L to 2O, each re-check finding a new introduced silent wrong number; the owner ended it on cost.

- **In progress: the v4.3.0 fix work from the release-level audit.** The earlier commits, each CI 6/6:
  - switch-off `9e0e16f`, wave 1 `e0e6d90`, wave 2 `a7e9288`, 2R + 2F `ec89bbd` (fifth session); 2G `3feb22f`, 2H `b6c1029` (sixth);
  - waves 2I + 2J + 2K `cd1ab70` (CI 34976760609), wave 2L + M1 `8ff4288` (CI 34988232943), the guards `2bb0fa0` + `4312672` (CI 35007445603), seventh session;
  - **fix wave 2M `e23b96c`** (CI 35022758611 SUCCESS 6/6), eighth session: the three guard findings (G-G2-1, G-G3-1, G-G3-2),
    design-reviewed FIRST (`vyuha-design-reviewer` graded all three REVISE; adopted with three narrowing decisions), two builders
    on disjoint sets, then TWO seam rounds that found five more defects (D1–D5 — D1/D2 the candidate-set disagreement the reviewer
    had named, D4 a 2M regression caught before the gate, D5 a legacy-date reader) and fixed them in-session; every `it.fails` pin
    flipped — **expected fail 0**. DECISIONS "2026-09-16 — v4.3.0 fix wave 2M built". Reports `18-FIX-WORK-4.3.0/wave2h-reports/wave2m-*.md`.
  - **fix wave 2N `f9a1a6b`** (CI 35086623142 SUCCESS 6/6), ninth session: the 2L re-check's 19 product + 2 medium
    test findings as designs D1–D8 (`18-FIX-WORK-4.3.0/wave2n-designs.md`), `vyuha-design-reviewer` FIRST (7 REVISE, all adopted —
    `wave2n-design-review.md`), two owner rulings before code (06-ANSWERS "v4.3.0 fix-wave 2N rulings": an unpriced MTF row accrues
    nothing until recorded; a partly sold row keeps accruing on the whole leg, labelled), FOUR sequential Opus builders (B-IDENTITY,
    B-DATES-CHARGES, B-MTF, B-ASK — reports `wave2h-reports/wave2n-B-*.md`, each red-first), ONE seam round to convergence
    (`wave2n-seams.md`: fixF 47 → 60, seven pins flipped, no seam defect), e2e z-live-desk 9/9 locally. DECISIONS "2026-09-16 —
    v4.3.0 fix wave 2N built". Its scoped re-check RAN in the tenth session (next bullet).
  - **fix wave 2O `b2af3d8`** (CI run 35125379974 **SUCCESS 6/6** — conclusion success, six jobs success, read after `gh run watch`;
    the pages-build-deployment run 35125378826 on the same sha is the docs site, not CI), tenth
    session: the 2N re-check (42 / 0 / 0, 18 findings — 16 product, 2 test-low) folded into ONE wave with the backlog audit's three
    live defects — 20 designs (D1–D3 `18-FIX-WORK-4.3.0/wave2o-designs.md`, D4–D19 `wave2o-designs-recheck-draft.md`, D20 found by
    the MTF builder), `vyuha-design-reviewer` FIRST twice (`wave2o-design-review.md` D2 REVISE; `wave2o-design-review-recheck.md`
    D4, D6, D7, D10 REVISE — all adopted), two owner rulings before the MTF builder (06-ANSWERS "v4.3.0 fix-wave 2O rulings":
    closed staged MTF rows keep their earlier estimate; a stated funded amount is apportioned by tranche value), FOUR sequential
    Opus builders (`wave2h-reports/wave2o-B-{METRICS-PALETTE,IDENTITY,MTF,DATES}.md`, each red-first; B-MTF and B-DATES resumed once
    at the 150-turn limit), ONE seam round (`wave2o-seams.md`: `tests/seams-v43-fixH.test.ts` NEW, 18 cases; fixF F1(a) flipped for
    D11) that found TWO seam defects — one pre-existing (`DASH_FIELDS` / `LENS_FIELDS` omitted the three columns `edgeMeasurable`
    reads, so the dashboard and /lenses counted an unpriced sale as a priced WIN) and one D20-introduced (every staged notes-only
    save refused) — fixed in-session by two seam-fix builders (`wave2o-S-FIX.md`, `wave2o-S-FIX2.md`: the staged preview ≡ save gap
    too). DECISIONS "2026-09-16 — v4.3.0 fix wave 2N: the scoped re-check" and "… fix wave 2O built". **Its scoped re-check RAN in the eleventh session (next bullet).**
  - **The 2O scoped re-check (eleventh session, 2026-09-17; NOT a code commit):** `18-FIX-WORK-4.3.0/recheck-wave2o.js` (pre-wave
    `5e537b3` = code `f9a1a6b`, wave `b2af3d8`, prefix `zzprobe-rc9-`), FIVE probe-capable Fable reviewers — metrics-palette,
    identity, mtf-staged, dates-charges-ask, seams — `wave2o-recheck.json`: **42 CONFIRMED / 0 / 0, 17 raw → 16 unique findings
    (12 product, 4 test-low)**, every probe deleted, tree untouched. **2O introduced ONE silent wrong number** (mtf-staged#0: D20's
    hand-back to `rebuildStagedTrade` has no `isOpen` guard, so a notes-only save or a leg-note edit on a CLOSED legacy staged MTF
    row RELEASES the margin-config estimate — +₹80.20 net on a closed trade — breaching the owner's 2O row-1 ruling; D20 was designed
    mid-wave inside a builder report and never reviewed) + 1 medium (the job's new staged branch has no per-row try/catch: one broker
    with no eq_mtf epoch silently stops accrual for every later row) + 3 low + 2 cosmetic; 5 pre-existing (a tiered-slab silent
    wrong number in `priceLegs` — Dhan ₹416.43 apart on 8 L over 19 days; a ghost IPO link invisible to Data Quality; three date
    lows/cosmetics). DECISIONS "2026-09-17 — v4.3.0 fix wave 2O: the scoped re-check" (two new rules: a mid-wave design is a design
    and gets the review; a quoted seam red that cannot occur is a test finding). **Fix wave 2P DESIGNED: `wave2p-designs.md`
    D1–D12** (a Fable drafter, consumer + writer sets grep-verified; two sequential builders B2P-MTF-DATES D1–D9 and B2P-IDENTITY
    D10–D12; no owner question) **and design-reviewed: `wave2p-design-review.md`** (7 BUILD, 5 REVISE — D3, D4, D7, D8, D11 — every
    REVISE adopted; D7 kept narrow, D11 gains `ipo_record_ghost`). **NOT built.** No jsdom / @testing-library exists on this tree
    (the render probes used `renderToStaticMarkup` + stubs). Entry gate re-run first: 433 / 9,544 / 35 (the +22 = owner-file cases).
  - `lib/import/commit.ts` still carries no auto-close wiring against v4.2.0 (re-checked at `b2af3d8`: the D20 staged guard and the
    `lib/queries/staged.ts` import are not auto-close; 0 hits for planLotCloses / withLotCloseNote / splitByRemainder).
- **Scoped re-checks:** wave 1 43 / 3 partial → wave 2 47 / 1 → 2R + 2F 34 / 0 / 0 → 2G all CONFIRMED → 2H 49 / 1 / 0 → 19 findings →
  wave 2I → 2I/2J/2K 58 / 0 / 0 → 26 findings (15 product, 11 test) → wave 2L → 2L (over `e23b96c`, post-2M): 41 / 0 / 0 → 28
  findings (19 product, 9 test) → fix wave 2N `f9a1a6b` → **2N (over `f9a1a6b`): 42 / 0 / 0 → 18 findings (16 product, 2 test-low)
  → fix wave 2O BUILT `b2af3d8` → **2O (over `b2af3d8`, 2026-09-17): 42 / 0 / 0 → 16 unique findings (12 product, 4 test-low)
  → fix wave 2P DESIGNED + reviewed, NOT built; the loop ENDS here by the owner's instruction** (`wave2o-recheck.json`; DECISIONS
  "2026-09-17 — v4.3.0 fix wave 2O: the scoped re-check"). Graded by INTRODUCED regressions: 2L one silent wrong number (identity#0) + 1 medium + 4 low +
  2 cosmetic; 2M one silent wrong number (counted-once#0) + 1 medium + 1 cosmetic; **2N one silent wrong number (mtf#0: the staged
  ladder is a FIFTH writer of `mtf_interest` that Q-A never reached — the writer sweep stopped at commit.ts and the job because the
  ladder writes under a helper's name) + 4 medium + 3 low + 4 cosmetic + 2 test-low; 4 pre-existing (one a silent wrong number,
  mtf#1: `priceLegs` ignored the STATED funded amount).** Three consecutive waves each introduced a silent wrong number → the
  sequential rule stands for the rest of the release, and DECISIONS records the new writer-sweep rule (grep the column, the field AND
  every helper that produces it, across lib/queries/*, lib/jobs/*, lib/import/*, lib/trash.ts, app/api/**, app/**/actions.ts).
  2O's seam round found ONE introduced product defect + one introduced preview gap (both D20's), fixed before the gate — 2O's own
  scoped re-check is the measurement that counts.
- **Wave 3 is DEFERRED past 4.3.0 by the owner's instruction of 2026-09-17** (ruled into 4.3.0 on 2026-09-15, planned and researched;
  the 4.3.0 release notes and install guide claim NONE of it — no ETF tax heads, no calendar months, no tax-defect fixes). The plan
  stays for the release after 4.3.0: `18-FIX-WORK-4.3.0/plan-wave3.json`
  (3a W3-ETF 26 files, 3b W3-TAX 42 files, disjoint; 13 seam contracts; every pin that moves; the AGENTS.md "Bundled ETF list"
  text; `open_questions: []`). Its preconditions (a fix wave committed with CI 6/6; no probe file in the tree) hold at `b2af3d8` once
  its CI reads 6/6 and the 2O scoped re-check is clean; 2N and 2O moved commit.ts (+1,116 / −90 against v4.2.0), the preview route,
  data-quality.ts, trash.ts, staged.ts, mtf-accrual.ts, positions.ts, ipo.ts, ipo-link.ts, the /ipos route, cross-source.ts,
  metrics.ts, lib/queries/trades.ts, edge/page.tsx and tax-itr.ts's neighbours, so RE-MEASURE every line number the plan cites.
- **Gate on `b2af3d8`:** `npm run verify` — **433 files / 9,522 passed / 35 skipped** (the raw line; expected fail 0; typecheck 0
  errors; lint 0 errors / 3 pre-existing warnings; `next build` compiled); **re-run 2026-09-17 on the SAME code: EXIT 0, 433 /
  9,544 / 35** — the +22 are owner-broker-file cases (`tests/helpers/owner-broker-files.ts` enumerates
  `VYUHA/BROKER-FILES-FOR-TESTING/` by filename pattern; six real exports filed 2026-09-16/17), so CI stays at 9,522; `e2e/z-live-desk.spec.ts` 9 / 9 (45.6 s) locally over 2O's
  `components/live/*` changes — after clearing `.next` (§0.3 V2 FAIL-I).
- **Backlog research (ninth session):** `LIVE-DESK-RESEARCH/19-BACKLOG-RESEARCH-2026-09-16/` — 12 read-only packs + a probe-capable audit (`00-INDEX.md` first): 18 backlog lines in §8 described SHIPPED code, 6 duplicate proposals, 13 stale lines, 3 live product defects — **the three defects are FIXED in 2O (`b2af3d8`)**, and the audit's §5 CORRECTED backlog is now the text of §0.1 rows 8 and 9 below (folded in the tenth session after the owner saw the stale lists recited; §8's own bullets still carry the banner and are NOT yet struck line by line — a docs task). Four NEW owner features are recorded verbatim there (resizable sidebar width, default section order per page + user-movable sections, India-tuned metrics with simpler explanations). ~150 owner questions across the packs — asked in groups of ≤10 only when an item is scheduled.
- **NOT bumped, NOT tagged.**
- **Guards + the design-review mechanism `2bb0fa0`** (after the owner asked for "zero repeated errors"): four invariant tests
  (AGENTS.md "Invariant guards for identity, IPO-link, Trash, merge and MTF work"), `.claude/agents/vyuha-design-reviewer.md`,
  the consumer sweep in `vyuha-builder`, red-harness-first in `vyuha-seam-tester`, design review + introduced-regression grading in
  the `vyuha-audit` skill, the global `planner` (DECISIONS "why the v4.3.0 fix waves regressed"). The three defects they found on
  `8ff4288` are **fixed in 2M**; the scanner's pre-fix texts are committed fixtures since `4312672` (a test never reads git history).
  First use of the mechanism, measured: the design review turned all three decided designs into buildable ones before a line was
  written; the seam pass still found five defects after the builders, one of them a regression of the wave itself — the mechanism
  caught it before the gate instead of a re-check one wave later.
- **Recorded, not built (tenth session; each with its home):** the editor's four risk fields (`slPlanned` / `trailingSl` /
  `targetPlanned` / `riskAmount`) are re-derived by `rebuildStagedTrade` after an editor save on a STAGED parent — the ladder is the
  source of truth (invariant 4); the editor should show them read-only for a staged row (a UI follow-up); `lib/queries/ipos.ts:71,86`
  treat a WHITESPACE-only exit date as unpriced (`' '` pinned as the gap); D20's refusal sentence has a second copy in the preview
  route (`LADDER_REFUSAL`, pinned equal — one export owed); a staged parent whose stored heads are ZERO previews those zeros; the
  accrual job re-prices every open staged eq_mtf row per /equity render (N+1, idempotent, pinned); the two 2N test-low findings
  (mtf#6 the Live Desk's D7 half pinned by source only; seams#2 F18/F40 restore `charge_config` outside a `finally`); the ten seam
  boundaries with no render case (`wave2o-seams.md` §1, incl. the Add form's preview door — 2N's #6 — still estimating); no e2e
  press of Control+Shift+K (D3's rejected alternative). DECISIONS "… fix wave 2O built" has the full list.
- **Side task, twelfth session (2026-09-17, no product code):** the owner's options-strategy log (`Trade-log-book.xlsx`, 42
  closed same-day long stock-option trades) seeded into the LIVE desktop journal as account #3 "OPTIONS STRATEGY" (Dhan,
  active capital ₹1,00,000) via `scripts/seed-options-account.ts` → `commitManualTrade`; gross ₹78,084.38 · charges ₹2,951.63 ·
  net ₹75,132.75; migration 0071 applied to the live file by ruling (pre-write copy in `data/smoke-0071/`); a 3840 × 2748
  full-dashboard capture delivered for advertising. DECISIONS "2026-09-17 — The owner's options-strategy trade log seeded".
  The 5L capture was then RE-RENDERED (not retouched) from a staging copy sized at 4 lots per trade on ₹5,00,000: net
  ₹3,06,434.27 · 33 W / 9 L · charges 1.89% (`seed-options-account.ts --lots 4`; 5 lots would flip the ₹17.50 PHOENIXLTD trade
  to a win → 81.0%). The journal still holds one lot and ₹1L.
- **Product fix, twelfth session (the owner saw "8 wins · best 11W" on that dashboard; the entry order says 7 · 10):**
  `closedSorted` (`lib/analytics/metrics.ts`) sorted on `sellDate` alone over NEWEST-FIRST input, so streaks and drawdown ran
  every day backwards — wrong on every same-day book since the KPI card existed, `/lenses` too. Fixed with a `sellDate` →
  `exitTime` → `id` tiebreak (`DASH_FIELDS` gains `id`, `exitTime`; `LENS_FIELDS` keeps its /trades-wire-shape pin, id only);
  `tests/closed-sorted-tiebreak.test.ts` (4 cases) pins it. DECISIONS "2026-09-17 — Streaks and drawdown walked every trading
  day BACKWARDS". Goes into the 4.3.0 release notes (one line, "streak and drawdown order inside a day"). Commits `0bf15bf`
  (the fix) + `662b568` (README counts) — CI run 35252324892 SUCCESS 6/6; **gate re-run on this code: `npm run verify` — 434 files / 9,547 passed / 35 skipped
  on the owner's machine (its one red was the README count, fixed in the follow-up; CI expects 9,526)**; README says 9526 / 434.
- **⛔ OWNER INSTRUCTION 2026-09-17, twelfth session (06-ANSWERS "Owner instruction 2026-09-17 IST (chat, twelfth session…)"),
  BINDING — adds to the eleventh-session instruction below:** (1) **the Option Strategies plan is ARCHIVED** — every open line of
  `13-OPTION-STRATEGY-CATALOGUE.md`, row 5 (live feed pricing option underlyings) and row 9's "option-seller depth r3" are CLOSED;
  what shipped in wave 2 stays; **v4.3.0 gains ONE single strategy: the owner's own signal system** (the seeded 42-trade log —
  CE breakout at resistance / PE breakdown at support, watchlist tiers, ΔOI unwind, T1 +50% / T2 +100% / SL −35%, closed by end
  of day), expanded later on DEMAND only; **its full details arrive from the owner before any design.** (2) **ONE session** does,
  in order: fix wave 2P → the single strategy (design → `vyuha-design-reviewer` → one builder → seam pass → gate) → the release
  ritual (bump, build, push, CI 6/6, `release` skill, steward) → STOP for the owner's "tag".
- **Next (the owner's two instructions, binding; the paste block is `NEXT-SESSION-CONTINUATION.md` §0, rewritten in the twelfth
  session — old block archived as §0-prev11):** 2P → the single strategy (details pasted by the owner; ONE question group; design →
  `vyuha-design-reviewer` → one builder → seam pass → gate) → the release ritual, all in ONE session on Opus. The capture tool is
  `scripts/shoot-dashboard.mjs`; the seed tool `scripts/seed-options-account.ts` (never re-run against the live journal without
  `--dry`). CI on `c97fd4c` run 35217890785 SUCCESS 6/6 (after one macOS e2e re-run: a `waitForLoadState` timeout on a docs-only
  sha). The eleventh-session wording of this bullet follows for the 2P and release-ritual detail: **build fix wave 2P** (`NEXT-SESSION-CONTINUATION.md` §0 NEXT item 1:
  `wave2p-designs.md` D1–D12 as revised by `wave2p-design-review.md`; B2P-MTF-DATES then B2P-IDENTITY, one `vyuha-builder` at a
  time on Opus, red-first with the four guards; ONE seam pass; gate; README counts; commit; push; CI 6/6) → **row 2, the bump and
  the release ritual** (the release notes state the 2N + 2O + 2P lines — DECISIONS "… fix wave 2O built", the four `wave2o-B-*.md`
  "Release-notes" sections, `wave2p-designs.md` "Release-notes sentences" — with every auto-close AND every wave-3 / ETF / tax claim
  dropped) → STOP for the owner's "tag". NO 2P re-check, NO wave 2Q, NO wave 3. Decisions: the eleventh-session entry dated
  2026-09-17 at the END of `docs/DECISIONS.md`.

*Superseded one-line state of 2026-09-16 at `b2af3d8` (tenth session), kept for the record:* fix wave 2O `b2af3d8` (CI 35125379974
6/6); its re-check NOT run; wave 3 planned; gate 433 / 9,522 / 35; e2e 9/9; NOT bumped, NOT tagged.

*Superseded one-line state of 2026-09-16 at `f9a1a6b` (ninth session), kept for the record:* fix wave 2N `f9a1a6b` (CI 35086623142
6/6); its re-check NOT run; wave 3 planned; gate 430 / 9,410 / 35; e2e 9/9; NOT bumped, NOT tagged.

*Superseded one-line state of 2026-09-16 at `e23b96c` (eighth session), kept for the record:* fix wave 2M `e23b96c` (CI 35022758611
6/6); the 2L re-check 41 / 0 / 0 → 28 findings → wave 2N NOT designed; gate 427 / 9,323 / 35; NOT bumped, NOT tagged.

*Superseded one-line state of 2026-09-15 at `2bb0fa0` (seventh session), kept for the record:* waves 2I + 2J + 2K `cd1ab70` and 2L + M1
`8ff4288` (CI 6/6 each); the invariant guards + the design-review mechanism `2bb0fa0` / `4312672`; the guards found three defects
pinned `it.fails` → fix wave 2M before the 2L re-check; gate 426 / 9,218 | 5 expected fail | 35; NOT bumped, NOT tagged.

*Superseded one-line state of 2026-09-15 at `b6c1029` (sixth session), kept for the record:* waves 2G `3feb22f` and 2H `b6c1029`
(CI 6/6 each); 2G's re-check all confirmed, 2H's not run; the wave-3 rulings (ETF tax heads fully fixed, calendar months,
straddling rows per row + DQ, four pre-existing tax defects, MTF interest out, the STT deduction fixed, buy-side charges a note);
gate 408 / 8,644 / 35; NOT bumped, NOT tagged.

*Superseded one-line state of 2026-09-15 at `ec89bbd` (fifth session), kept for the record:* the fix work through waves 2R + 2F (`ec89bbd`, CI 34895595282 6/6); the 2R + 2F re-check 34 / 0 / 0 with 17 new findings → wave 2G; owner rulings R90 = the bundled NSE ETF list, all four out-of-list defects into 4.3.0, R13 = the inline official-close notice; gate 397 / 8,416 / 35; NOT bumped, NOT tagged.



---

# ARCHIVED 2026-09-21 — the §0 block written by the thirteenth session (v4.3.0 PUBLISHED), replaced by the fourteenth session's v4.4.0 block; byte-for-byte below

## §0 START HERE — reconciled 2026-09-18 IST by the thirteenth session: **v4.3.0 is PUBLISHED** (tag `v4.3.0` = `c5c7c5b`; CI 6/6; release run 3/3; deep verify 3/3; `releases/latest` → v4.3.0; the updater feed serves 4.3.0 for six platforms) — **NOT yet installed off the build machine, WDSI not yet submitted: both are the owner's**; the commit that landed this block is the next one in `git log`

**Read order, every session, in this order and no other:**

1. **This §0.** It outranks every other document. *If any document disagrees with §0, §0 wins and the other document is the bug — fix it in the same turn.* **Memory is not authoritative; it forks by cwd** (hub copy vs the project copy) and rots; it now carries pointers and durable traps only.
2. `VYUHA/LIVE-DESK-RESEARCH/NEXT-SESSION-CONTINUATION.md` §0 — research-pack specifics for the item you are picking up (audit known-inputs, ruling tables, ledger pointers). It points back here.
3. Re-derive before asserting: `git log --oneline -3` · `git tag --sort=-creatordate | head -1` · `package.json` `"version"` · `gh run list --limit 3` · the RAW vitest line (§0.3).
4. `AGENTS.md` before any code change (on conflict AGENTS.md wins over this file; the code wins over both). Owner rulings: `06-ANSWERS.md` newest table LAST; `docs/DECISIONS.md` newest entries at the END (its header still says newest-first, but every entry since 2026-09-10 is appended — grep `^## 2026-`, never read it whole) — binding, never re-ask one.
5. §3 of this file for where any other answer lives.

**The one-line state (verified 2026-09-18):** published release = **v4.3.0** (tag `v4.3.0` → `c5c7c5b`, published 2026-09-18 12:22 UTC; before it v4.2.0 `9da7bc8`). The chain: `c5c7c5b` (Windows-CI test timeout) on `55f1fd3` (the monthly plan) on `160753f` (docs) on `7537ae2` (bump + release copy) on `20c08ff` (the Signal book) on `3abcb2c` (fix wave 2P). The block this one replaced is in `VYUHA-STATE-ARCHIVE.md` (byte-for-byte, dated).

- **What the thirteenth session did, in order (each commit CI 6/6):**
  - **fix wave 2P `3abcb2c`** — D1–D12 of `18-FIX-WORK-4.3.0/wave2p-designs.md` as revised by its review; two builders in sequence, one seam pass (4 cases,
    no product defect), one gate. CI run 35322863777 SUCCESS 6/6 on its second attempt: the Windows job hit two 5 s TIMEOUTS
    (`backup-roundtrip` "a pre-lots v3 envelope…" and one preview-matrix G3 cell) and passed on `gh run rerun --failed`. No re-check followed, by the owner's instruction.
  - **the Signal book `20c08ff`** — the ONE single strategy (06-ANSWERS last two tables + the owner's `AI_MODEL_STRATEGY_BLUEPRINTS.docx`): journal side only;
    migration **0072** `trades.signal_json` (versioned envelope, tombstone on a clear); a Signal section on the Add and Edit trade forms (prefill +30 / +60 / −25 %);
    the data fix `signal-notes-backfill-v1` (the four regexes matched 42 of 42 rows of the live journal, read-only); three pure analytics; the first tab on `/strategies`
    (table free, analytics Pro, withheld server-side). Design → `vyuha-design-reviewer` (3 BUILD, 4 REVISE, all adopted) → one builder → one seam pass, which found
    ONE product defect, **SIG-1** (a decimal-comma "14,48" stored as 1448), fixed before the gate. CI run 35328890550 SUCCESS 6/6.
  - **the bump `7537ae2`** — 4.3.0 in package.json / tauri.conf.json / Cargo.toml / the footer (`v4.3`); `Cargo.lock` 1 line, `package-lock.json` 2 lines by hand;
    the release copy (every auto-close, wave-3, ETF, tax, Greeks claim dropped; TWO database upgrades 0071 + 0072). CI run 35330899427 SUCCESS 6/6.
- **Gate (2026-09-18, on `7537ae2`):** `npm run verify` EXIT 0 — **439 files / 9,711 passed / 35 skipped** on the owner's machine; **9,689 expected on CI**
  (22 owner-broker-file cases run only locally — the earlier "21" was an off-by-one); README says 9689 / 439; typecheck 0; lint 3 pre-existing warnings.
- **Desktop build (2026-09-18):** `npm run desktop:build` EXIT 0 after `cargo clean --release` — the Rust cache still named the repo's PRE-MOVE folder
  (`VYUHA-TRADE JOURNAL-V1`) in every build-script output, so the first build after a folder move needs the release cache cleared (3 m 24 s to rebuild).
  `desktop-dist/.next/BUILD_ID` written 71 s after the build started; the bundle holds `signal-notes-backfill-v1`, "R on signal SL", `rate-card-refresh.mjs` and
  migration 0072. Both `.sig` files decode to key id **`4FF85F3BBE1DA21D`** = the `tauri.conf.json` pubkey. Client ZIP `release-packages/Vyuha_4.3.0_Client_Package.zip`;
  installer SHA-256 `3695B8090300518C85AD88B7BB1623CEB3E672F0970944D7D97F1794C40B1D2A` (35,652,661 bytes).
- **Release steward (2026-09-18):** READY TO TAG, no blocking items - 11 steps walked read-only: version sync, lockfile numstat, installer freshness, key ids, CI 6/6, revocations a prerelease with releases/latest at v4.2.0, the client ZIP (13 entries, no licence key, no macOS artefact, CHECKSUMS = the independent hash), and the claims audit over 8 surfaces with 0 unsubstantiated claims; one ADVISORY: the standing blurb 'Greeks across the book' (true of the Risk cockpit) sits three lines above the /strategies table that says it has no Greeks (docs/client/README.md:25, docs/sales/landing-page.html:460); release:verify --deep NOT run (nothing published yet); winget manifest for 4.3.0 comes after publish.
- **Owner rulings of this session (06-ANSWERS, the LAST two tables — binding):** journal side only (the scanner / zone engine / alerts are NOT VYUHA's);
  one JSON column; form section + notes backfill; three analytics; T2 = scale-out; first tab on `/strategies`, analytics Pro; **model S1 / S2 only — the tier is DROPPED**;
  prefill +30 / +60 / −25 with adherence judged on each trade's OWN levels; S1 = 5 CE + 5 PE, S2 = 4 CE + 4 PE (recorded, a scanner matter); tool-bound agents on Opus.
- **Recorded, not built (DECISIONS 2026-09-18, three entries):** 2P — the unreadable-lot throw in `closeStaleLot`, the D8 route cases that cannot separate their two
  halves, no seam case for D10 / D3-tiered; Signal book — a seeded row in Trash at upgrade time restores without a signal (Edit fills it), `num()` in
  `app/trades/actions.ts` still strips every comma for qty / price, no e2e spec and no Help Desk entry for the tab, the 2 % adherence tolerance is a decision.
- **FIX LIST for the next wave (owner, 2026-09-18 — "add this to fixes list"):** the `/lenses` **Outcome** tab's **Win rate** column is a tautology — the lens groups BY
  outcome (`lib/domain/lenses.ts:167`, `outcomeGroups`), so Winners always reads 100% and Losers 0% (the owner read the 0% as "no loss shown"; the loss IS the row's
  net, −₹12,173 on account #3). Correct arithmetic, useless column. Fix: on the Outcome lens only, replace Win rate with each group's SHARE of closed trades
  (33 of 42 = 79% / 9 of 42 = 21%, header "Share of trades"), or "—" if a share is ruled out; every other lens keeps Win rate. Pin it in the lens tests.
- **After the bump, same session (each CI 6/6 unless said):** **the monthly plan `55f1fd3`** — ₹599 first month (launch offer), ₹999 from the second, given on request;
  Yearly ₹7,999 and Lifetime ₹29,999 unchanged; `license-issue.mjs --months N` (month ends roll forward), `sell.mjs --months 1 [--renewal]`; the sale script's ANNUAL receipt
  amount was still 9,999 with a test pinning it — now 7,999. Its CI run 35339488381 lost the Windows job to FOUR 5 s timeouts → **`c5c7c5b`**: `testTimeout` 20 s on the
  Windows CI runner only (DECISIONS 2026-09-18, a class not a flake) → CI 6/6 → **tag `v4.3.0`** (the owner: "proceed to do that") → release run 3/3 →
  `release:verify v4.3.0 -- --deep` 3/3 over the published bytes, key id `4FF85F3BBE1DA21D` → published, `releases/latest` → v4.3.0, `revocations` still a prerelease;
  the GitHub Pages landing page shows 4.3.0, the monthly plan and the Signal book (fetched live). Gate on the release tree: 439 files / 9,720 passed / 35 skipped locally,
  9,698 on CI; README 9698 / 439. **The installer was REBUILT after the pricing change**: client ZIP installer SHA-256
  `DB71DD7936907EFC4719FBBAC4F6035884211CCFC80F373D4E80D3DDD9C0E19B` (the earlier `3695B809…` ZIP is set aside as `…SUPERSEDED-pre-monthly-plan.zip`); the GitHub asset's
  SHA-256 is `b768c903…680e507b` (winget manifest `release-packages/winget/4.3.0/` generated from it; submission still HELD by #421585).
- **Next — the owner's, by hand:** install the client ZIP's installer on a NON-build machine → the six-item smoke test (row 3; item (e) = the Signal book on account #3:
  42 rows, net ₹75,132.75 unchanged) → the WDSI submission with the CLIENT ZIP hash above. Then the next build: v4.4.0 (rows 14, 15 + the fix list) and v4.3.1 /
  wave 3 (row 1b) — the two-session plan is in DECISIONS 2026-09-18 "the plan for the next 100 credits".
- **What WRONG looks like:** the Signal book showing fewer than 42 rows on account #3 after the upgrade (the fix logs refused ids to the console — read them, never edit
  notes by SQL); any net for account #3 other than ₹75,132.75 (migration 0072 and the fix move no money — find the writer); a release note claiming auto-close, ETF
  heads, Greeks or a scanner; a CI red that is a 5 s Windows timeout in `backup-roundtrip` or the preview matrix (re-run the job, never re-tag); a `.sig` whose key id
  is not `4FF85F3BBE1DA21D`.
- **Owed outside the release:** `/fleet-tune` (due 9 days; skipped on the owner's credit cap) and one hook proposal awaiting the owner in `~/.claude/coord/learnings/HOOK-PROPOSALS.md`.

