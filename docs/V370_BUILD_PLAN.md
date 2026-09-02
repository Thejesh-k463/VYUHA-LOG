# V3.7.0 BUILD PLAN — "Review & Discipline"

**STATUS: OWNER-APPROVED 2026-09-02 — all nine §8 questions answered YES. IN BUILD.**
(Approval and the four recon findings that shaped it are recorded in `docs/DECISIONS.md` 2026-09-02.)
Roadmap slot: `docs/V360_BUILD_PLAN.md` row 3 (owner decision #1, 2026-09-02). Binding prior
decisions: **#7** (Discipline/Review keep the expectancy-gap framing — no "profit if avoided"
counterfactuals; "avoid" is lint-banned) and **#8** (Trade Review Desk is Pro/lifetime-gated
once the trial ends), both `docs/DECISIONS.md` 2026-09-02.

Grounded in five read-only recon reports run 2026-09-02 against the v3.6.0 tree (clean `main`,
HEAD `6e39128`, package 3.6.0, migrations through `0054`, suite 2,899 tests / 188 files, e2e
54/54). Every claim below was verified against the code, not the backlog. Three findings changed
the plan's shape and are stated up front rather than buried:

1. **The Trade Review Desk "researched design" was never written to disk.** The 2026-09-01/02
   deep-research report is referenced at `docs/V360_BUILD_PLAN.md:4-8` but no file, transcript or
   research folder carries it; "Process Score", "review queue" and "weekly ritual" occur nowhere in
   the repo. **§1 below re-derives the design from the code and is itself the spec to approve.**
2. **The "7 sibling global-capital reads" list was also never committed.** Reconstructed from
   `tests/capital-fallback-guard.test.ts` `GUARDED_FILES` — and the code has **eight**, not seven:
   the dashboard capital tile (`app/page.tsx:28`) is a global read sitting three lines from an
   account-scoped goal badge.
3. **Zero OS-notification capability exists** (no Tauri plugin, no `@tauri-apps/api`, no
   `Notification(` call site anywhere). An opt-in per-device desktop-notification claim for SL/TSL
   breaches exists in `README.md:565` / `CHANGELOG.md:2751` and must be re-verified against code
   during the claims audit.

**Standing rules (unchanged from v3.5/v3.6):** every fix lands with a test that reddens on the
reverted code; stage-gate with a full `npm run verify` (echo the exit code, never a piped tail);
migrations serialized through ONE agent; one verify per wave, run by the orchestrator; the release
does not ship without the multi-agent adversarial diff-audit, the double perf sweep, the claims
audit, and the `release` skill start to finish; the client package updates with every release;
label claims VERIFIED or INFERRED. Agents must not git-stash/commit/checkout, must not npm
install, must not run verify/build while another agent edits. **Present features' performance
enhanced, never disturbed — before/after sweeps on the same seeded DB, twice each.**

---

## 0. Baseline facts the plan builds on (VERIFIED 2026-09-02)

| Fact | Where |
|---|---|
| No `reviewed_at` / grade / lessons column on `trades`; only proxy for "unreviewed" is empty `notes` (`lib/jobs/telegram-digest.ts:102`, trailing-7-day) | `lib/db/schema.ts:42-200` |
| Per-trade review form already exists and is FREE: `components/behavior/journal-dialog.tsx` (playbook, emotion, exit trigger, mistakes, rule checklist, attachments, notes) → `app/api/trades/journal/route.ts` | invariant 7; `tests/pro-gating.test.ts:155-178` pins `/trades`, `/playbooks` never gated |
| Weekly discipline score exists but has **no sample floor, no coverage, no refusal**: 3 sub-scores plainly averaged, `cap = perTradeCap \|\| 9500` | `lib/analytics/discipline.ts:90-130` |
| A second adherence number exists: session-plan `adherencePct` (5 boolean checks) | `lib/analytics/session-review.ts:53` |
| Insight contract: descriptive only (`PRESCRIPTIVE_LANGUAGE`, `lib/intelligence/insight.ts:102`), `sampleFloor >= 10`, coverage on every subset, every rule must fire from fixtures, `REGISTRIES` list pinned at `tests/intelligence-contract.test.ts:99-101` | must be obeyed by any Process Score exposed as an Insight |
| `disciplineByWeek`'s `isoWeek()` is private — the only ISO-week bucketer in the repo | `lib/analytics/discipline.ts:25-37` |
| Once-a-period claim pattern: conditional UPDATE before dialling out, revert on failure | `lib/jobs/telegram-digest.ts:135-159` |
| Telegram failure note is ephemeral React state, dashboard-only; nothing durable records a failed send | `components/system/telegram-runner.tsx:26-57` |
| `ProGate` takes no feature arg; `PRO_FEATURES` is display-only; `ENTITLEMENT_PATHS` derived | `lib/license.ts:234-304`, `components/system/pro-gate.tsx` |
| Lifetime = absence of `expires` in the signed payload | `lib/license.ts:432-435` |
| Adding a nav screen requires a `HELP_ENTRIES` twin (both directions) | `tests/help-content.test.ts` |
| `metric-help` drift test parses a hard-coded two-page `PAGES` list | `tests/metric-help.test.ts:22-25` |
| Onboarding: nothing exists; no `middleware.ts`; layout is a server component with client islands (`Sidebar`, `CommandPalette`, `NavHistoryTracker`, `Toaster`); only modal primitive is `components/ui/dialog.tsx` | `app/layout.tsx:114-122` |
| Fresh desktop install = account 1 "Primary" seeded, capital 0, zero trades, trial stamped lazily on first `getEntitlement()` | `lib/db/seed-core.ts:41`, `lib/queries/license.ts:82-91` |
| e2e shares ONE DB seeded with zero trades; **no spec dismisses anything at start; a blocking first-run modal would break every early spec** | `e2e/prepare-db.ts`, `e2e/helpers.ts` |
| Machine-state settings columns are excluded from `BASELINE_SETTINGS_FIELDS` and redacted via `SETTINGS_MACHINE_COLUMNS` | `lib/domain/settings-baseline.ts:31-44`, `lib/backup-format.ts` |
| Advance tax: single scalar `taxPaidToDate` applied at every rung (`advance-tax.ts:167-168`); the v3.5 "persisted inputs" are **localStorage** (`vyuha-advance-tax-calc`), no table, no route; no `challan`/`BSR` identifier anywhere in code | `lib/analytics/advance-tax.ts:49-52`, `components/reports/advance-tax-calc.tsx:16-48` |
| Exact pattern to mirror for a dated table: b/f-loss lots — migration `0054`, `lib/db/schema.ts:318-357`, `lib/queries/bf-losses.ts`, `app/api/bf-losses/route.ts`, `components/reports/bf-loss-editor.tsx`, `tests/bf-losses.test.ts`, plus backup-format / backup / audit / account-delete / account-isolation / backup-roundtrip registrations | b/f lots are MOVE-on-merge, delete-un-snapshotted-on-purge (`DECISIONS.md:2076-2081`) |
| Statute keys for advance-tax labels: `advanceTaxInstalments` (S.211→s.408), `interestAdvanceTax` (234B→s.424), `interestDeferment` (234C→s.425), `presumptive` (44AD→s.58) | `lib/analytics/statute.ts` |
| /lenses: server computes KPIs + charge heads + (Pro) rules for **all six lenses on every request**; ships the whole 19-column book (25,001 rows on the perf DB) to the client; `GroupList` renders every group unbounded; only the drill-down `DataTable` is `virtual` with `DRILL_LIMIT = 2000`; render-windowing test pins only `LENS_FIELDS`/`getLensTrades` for /lenses | `app/lenses/page.tsx:18-56`, `components/lenses/lenses-client.tsx:230,326,523` |
| Perf: v3.6.0 double sweep /lenses 1675/1719 ms, /trades 2031/2079 ms vs 1500 budget; v3.5.1 worktree /lenses 1817 | `DECISIONS.md:2083-2089` |
| `perf:sweep` writes nothing to disk, is not in CI, needs a running `next start` on the perf DB | `scripts/perf-sweep.mjs` |
| Global-capital readers (8): `app/equity/page.tsx:75`, `app/active/page.tsx:31`, `app/risk/page.tsx:99-100`, `app/reports/monthly/page.tsx:41`, `app/targets/equity/page.tsx:34`, `lib/queries/ledger.ts:114-115,127-128`, `lib/queries/limits.ts:47-52`, `app/page.tsx:28`. Drop-in: `getBucketCapital()` (`lib/queries/capital.ts:43-49`), rupees, `0 = not configured` preserved, aggregate view falls back to settings | pinned today only for the performance page (`tests/capital-account-first.test.ts:85-95`) |
| README `Now:` line is stale at v3.2.0; test badges at 2896 (release cut was 2,899); `REFUND_POLICY.md` at v3.4.0 and ungated by `client-docs-version` | `README.md:31,10,695`; `docs/client/REFUND_POLICY.md:3` |

---

## 1. Trade Review Desk (WS1) — re-derived design, Pro/lifetime-gated (decision #8)

**Boundary that invariant 7 forces:** the *recording* half (journal dialog, notes, mistake tags,
exit trigger, rule checklist) stays free on `/trades`. The *desk* — queue, weekly ritual, Process
Score — is a new page `/review`, `<ProGate>`-wrapped, entry in `PRO_FEATURES` (`ENTITLEMENT_PATHS`
derives). Trial users get all of it for 7 days (full-Pro trial); after that, lifetime or annual.

### 1.1 Data — one column, one table (migration agent, §7)

- **`trades.reviewed_at TEXT NULL`** (migration `0055_trade-reviewed-at`). Set by the journal
  route whenever a review is saved (`app/api/trades/journal/route.ts`), and by an explicit
  "Mark reviewed" action on the queue (same route, `action: "mark-reviewed"` — a record fact, so
  it stays free). Cleared by nothing automatic; a "Reopen" action nulls it. Added to
  `SLIM_TRADE_FIELDS` (`lib/domain/slim-trade.ts`) so `/trades` can show a reviewed check without
  a fetch. **Backfill in the migration:** `reviewed_at = updated_at` where `notes` is non-blank OR
  `mistake_tags` is a non-empty array OR `exit_trigger` is non-blank — so an existing journalled
  book does not wake up with a 500-deep queue. Stated in CHANGELOG. *(Owner decision Q3.)*
- **`weekly_reviews`** (migration `0056_weekly-reviews`): `id`, `account_id NOT NULL`,
  `week_start TEXT NOT NULL` (ISO Monday, `YYYY-MM-DD`), `note TEXT`, `completed_at TEXT`,
  `score_at_completion INTEGER NULL` (what the user saw; the live figure is always recomputed and
  labelled as such), `created_at`, `updated_at`; unique `(account_id, week_start)`. Account-scoped
  → registered in `tests/account-isolation.test.ts`, backup format (BACKUP_VERSION stays 3, table
  added to the dump), trash snapshot (kept — it is the user's own prose), merge = MOVE where no
  `(account, week)` row exists on the target, else the target's row wins and the source's note is
  appended (a note is never silently dropped), purge deletes with the account.

### 1.2 Pure maths — `lib/analytics/process-score.ts` (new, PURE)

`processScore(trades: ProcessTrade[], cfg: {perTradeCap: number|null, dailyStop: number|null,
floor?: number}): ProcessScore | null`

Five components, each `{id, label, numerator, denominator, pct|null, coverage}`:

| id | What it measures | Denominator | Notes |
|---|---|---|---|
| `planned` | SL **or** target recorded before/at entry | closed trades in window | existing `planningPct` |
| `risk-cap` | losing trade's loss ≤ its own `riskAmount` (else the configured cap) | losing closed trades | `null` when no losers **or** when neither `riskAmount` nor a cap exists — never `9500` |
| `daily-stop` | day net ≥ −dailyStop | traded days | `null` when no `dailyStop` configured |
| `rules-followed` | trade has a playbook AND zero `Playbook: …` entries in `rule_violations` | closed trades with a playbook | coverage says "12 of 40 had a playbook" |
| `reviewed` | `reviewed_at` set | closed trades in window | the queue's complement |

`score` = mean of the components whose `pct` is not `null`, rounded to an integer; `components`
always returned so the UI can show the arithmetic; `refused: {reason}` (module returns `null` plus
a stated reason via a sibling `processScoreOrReason`) when closed trades in the window `< floor`
(default **10**, matching the contract's minimum). **No counterfactual anywhere** (decision #7):
the desk reports the expectancy *gap* from `mistakeReport()` unchanged. Copy on every surface is
run through `PRESCRIPTIVE_LANGUAGE` by a new source-guard test over the desk components.

`isoWeek`/`weekStart` move to an exported `lib/analytics/week.ts` (used by `discipline.ts`, the
desk and the ritual gate) — one bucketer, pinned by a test that `disciplineByWeek` and
`processScoreByWeek` bucket identical trades into identical weeks.

**Reconciliation with the two existing numbers (Discipline 2.0, §2):** the weekly discipline
`score` is re-implemented as `processScore(...).score` so there is ONE weekly number in the
product; session-plan `adherencePct` stays what it is (plan-vs-day) and is labelled "Session plan
adherence" wherever it appears beside the Process Score.

### 1.3 Queries + routes (server-only)

- `lib/queries/review.ts`: `getReviewQueue({limit})` — closed, `reviewed_at IS NULL`, selected
  account (invariant 8), newest `sellDate` first, projected on `SLIM_TRADE_FIELDS` (the journal
  dialog needs them), **windowed**: returns `{rows, total}` with `limit` default 150 and the UI
  states "showing N of M"; `getReviewStats(weekStart)`; `getWeeklyReview(weekStart)`,
  `upsertWeeklyReview` (write account via `getWriteAccountId()`, aggregate view refuses → 403).
- `app/api/review/route.ts`: zod `discriminatedUnion("action", [mark-reviewed, reopen,
  weekly-upsert, weekly-complete])`; parse → call → `revalidatePath` for `/review`, `/trades`,
  `/reports/discipline`, `/`. Never a server action.
- Journal route gains: on save, `reviewed_at = reviewed_at ?? now`.

### 1.4 UI — `app/review/page.tsx` (`force-dynamic`, `<ProGate>`)

Three panels, top to bottom:

1. **This week** — Process Score card with the five components laid out as "n of m · pct"
   rows (the *transparent* part: nothing is a bare number), the refusal text when under floor
   ("4 closed trades this week; the score needs 10"), and the comparison to last week rendered
   blank across a gap (the `monthly.ts` rule). Metric-help entries for `process-score` and each
   component (adds `app/review/page.tsx` to `tests/metric-help.test.ts` `PAGES`).
2. **Review queue** — the unreviewed closed trades, `useRowWindow`/`ShowMore` (WINDOW_STEP 150),
   each row opening the existing `JournalDialog` (reused, not forked) plus "Mark reviewed" for a
   trade the user has nothing to add to. Filters (this week / all / by mistake tag) are per-device
   chrome under `vyuha-review-prefs` `{v:1,…}` via `useStoredValue` with a `parseReviewPrefs()`
   twin and garbage/future-version tests.
3. **Sunday ritual** — a guided weekly review for the ISO week that most recently ended:
   trades closed, net, charges, the Process Score, the three largest expectancy-gap tags
   (`mistakeReport`), best and worst trade by R, exit-trigger mix (`exitTriggers`, excluded count
   stated), the session-plan adherence rows for the week, then a free-text weekly note and
   "Complete this week's review" → stores `completed_at` + `score_at_completion`. A history strip
   lists the last 12 completed weeks (note excerpt, score then, score now). **In-app only**; no
   Telegram, no notification. A dashboard card ("Week 36 review open · 7 trades unreviewed") shows
   only when entitlement is `licensed | trial` — a free user is not nudged toward a paywall from
   the dashboard.

Nav: `/review` into the **Journal** group after `/sessions`, default-visible; help entry;
command-palette keywords; `PRO_FEATURES` entry `{href:"/review", label:"Trade Review Desk"}`.

### 1.5 Tests (all red on revert)

`tests/process-score.test.ts` (pure: each component's denominator, `null` propagation, floor
refusal, no invented cap, week agreement with `disciplineByWeek`); `tests/review-queue.test.ts`
(temp-db: account scoping, aggregate refuses writes, journal save stamps `reviewed_at`, reopen,
weekly upsert unique per week, backfill migration marks journalled rows only);
`tests/review-copy-guard.test.ts` (source guard: every string literal in `components/review/**`
passes `PRESCRIPTIVE_LANGUAGE`; `/review` is `<ProGate>`-wrapped and in `PRO_FEATURES`);
`e2e/z-review-desk.spec.ts` (seed via `ensureTrades`, mark one reviewed, complete a week).

---

## 2. Discipline 2.0 (WS2)

- `/reports/discipline` weekly table renders `processScoreByWeek` (score + a per-week popup with
  the five component rows and coverage; weeks under floor say so instead of scoring). The
  breach report, playbook stats, mistake economics, emotion rollup and SEBI-reality card are
  untouched.
- `lib/analytics/discipline.ts` keeps its exports; `disciplineByWeek` delegates to the new
  module (`score` = Process Score, the three legacy pct fields still populated for callers) —
  the monthly report (`app/reports/monthly/page.tsx:65`) therefore moves to the same number
  with no code change there; its print layout is unchanged (recharts only, per AGENTS.md).
- The `|| 9500` / `25000` defaults at `app/reports/discipline/page.tsx:35-36` and
  `app/reports/monthly/page.tsx:63-64` become `null` → the component refuses rather than scoring
  against a number the user never set (invariant 6). Their `riskConfig` reads are unchanged.
- **Visible consequence, stated in CHANGELOG:** weekly discipline numbers change on upgrade
  (five components instead of three; weeks with < 10 closed trades no longer score). *(Q2.)*
- Tests: `tests/reports.test.ts` discipline cases updated + new cases pinning the delegation and
  the refusal; `tests/discipline-page-guard.test.ts` (source guard: no numeric cap fallback).

---

## 3. First-run onboarding (WS3)

- **Flag:** `settings.onboarding_completed_at TEXT NULL` (migration `0057_onboarding-flag`) —
  machine state: excluded from `BASELINE_SETTINGS_FIELDS`, added to `SETTINGS_MACHINE_COLUMNS`
  (a restored backup neither re-shows nor hides the wizard). **Backfill:** set to `datetime('now')`
  where `EXISTS (SELECT 1 FROM trades)` — upgrading users with a book never see it; a zero-trade
  install (fresh or not) does. `seed-core.ts` stamps it in the dev/e2e profile and leaves it
  NULL under `VYUHA_SEED_CLEAN=1`, so **every existing e2e spec is unaffected**; a new
  `e2e/z-onboarding.spec.ts` resets the flag through the route, walks the wizard, and completes it.
- **Mount:** a new client island `components/system/onboarding-wizard.tsx` beside
  `CommandPalette` in `app/layout.tsx`, fed `{show, accountName, hasCapital, brokers}` from the
  server. Radix `Dialog`, non-dismissable-by-backdrop but with an explicit "Skip for now" (sets the
  flag — a skipped wizard does not return every launch). Not in `NAV_ITEMS` (the `/pricing`
  precedent, `app/pricing/page.tsx:11-18`) → no help-entry coupling.
- **Steps (4):** (1) Welcome + name this account + optional equity / F&O capital ("leave blank and
  reports show — until you set it" — capital stays OPTIONAL so invariant-6 paths stay live; *Q4*)
  → `app/api/accounts` upsert; (2) Get trades in — three buttons: import a file (`/import`),
  connect a broker (`/import-help`), add one by hand (`/trades?add=1`); (3) Optional: Telegram
  EOD digest — one sentence + link to Settings (consent UI is NOT duplicated; the disclosure stays
  where the server enforces it); (4) Done — "Your first review lives at Review Desk; the 7-day
  trial includes it". Progress is a `useStoredValue` `vyuha-onboarding-step` envelope so a mid-wizard
  navigation to `/import` resumes at step 2.
- **Route:** `app/api/onboarding/route.ts` `{action: "complete" | "reset"}`; a "Run setup again"
  button in `SettingsForm`.
- Tests: `tests/onboarding.test.ts` (temp-db: backfill marks only books with trades; CLEAN seed
  leaves NULL; dev seed stamps; route sets/clears; baseline excludes; backup redacts);
  `tests/onboarding-copy-guard.test.ts` (no prescriptive language, no superlatives); e2e above.

---

## 4. Dated advance-tax challan ledger (WS4) — money-adjacent, own audit rigour

Mirrors the b/f-loss-lot pattern file for file.

- **Table `advance_tax_challans`** (migration `0058_advance-tax-challans`): `id`, `account_id
  NOT NULL`, `fy TEXT NOT NULL` (`YYYY-YY`), `paid_on TEXT NOT NULL` (ISO date), `amount_paise
  INTEGER NOT NULL` (moneyPaise), `bsr_code TEXT`, `challan_serial TEXT`, `note TEXT`,
  `created_at`, `updated_at`. No natural key (a serial is unique only per BSR and both are
  optional) → no unique index; the editor warns on an exact `(fy, paid_on, amount)` duplicate but
  allows it. Semantics = statements of fact (`DECISIONS.md:2076-2081`): MOVE on merge, delete
  with the account on purge, not snapshotted to trash (consistency with lots; *Q5*). Registered in
  backup dump, `account-isolation`, `backup-roundtrip`, audit.
- **Engine (pure):** `AdvanceTaxInput` gains optional `payments?: {date: string; amount:
  number}[]`. When present, each instalment's `paid` becomes `paidAsOf(dueDate)` (payments dated
  on/before the due date, within the FY — s.408(3): anything by 31 March counts; a payment dated
  after 31 March is excluded and named in `notes` as self-assessment, not advance tax); the safe
  harbour tests 12 %/36 % against `paidAsOf(15 Jun)`/`paidAsOf(15 Sep)`; `taxPaidToDate` becomes
  the FY total of payments; the scalar path is unchanged when `payments` is absent — pinned by a
  test that the two paths agree when every payment is dated before 15 June. **The rate arithmetic
  (`1% × months`, months 3/3/3/1) is not touched.**
- **Query/route/editor:** `lib/queries/challans.ts` (reads honour `getSelectedAccountId()`,
  aggregate reads all, aggregate refuses writes), `app/api/challans/route.ts` (zod upsert/delete;
  revalidates `/reports/advance-tax`, `/reports/itr`), `components/reports/challan-editor.tsx`
  mounted on `/reports/advance-tax` under the calculator. When challans exist for the FY the
  calculator's "paid so far" input is replaced by "From your challan ledger: ₹X across N
  payments" and the localStorage `paid` value is ignored for that FY (stated on screen); when
  none exist the v3.5 behaviour is untouched.
- **ITR:** `/reports/itr` gains a "Taxes paid (advance tax)" table per FY from the ledger; the
  export emits challan rows (BSR, serial, date, amount) only when rows exist — blank otherwise
  (invariant 6). Labels resolve through `section(fy, "advanceTaxInstalments")` etc., never a
  literal "234C".
- Tests: `tests/advance-tax.test.ts` gains a "dated payments" describe (per-rung paid-as-of, late
  payment interest, safe harbour by date, post-March exclusion, scalar/dated agreement);
  `tests/challans.test.ts` (temp-db, mirrors `tests/bf-losses.test.ts` groups incl. route zod +
  status mapping and the page-level wiring drift guard); `tests/itr-schedule.test.ts` blank-vs-rows
  case; `e2e/z-challan-ledger.spec.ts`.

---

## 5. v3.6 carry-overs

### 5.1 /lenses windowing pass (render-only; no SQL predicate, no ORDER BY, no figure moves)

- **Before — MEASURED 2026-09-02 (Wave 0), production build, `data/perf.sqlite`, 42 routes × 3
  rounds = 126 visits, budget 1500 ms on the median:**

  | Route | Sweep 1 | Sweep 2 | v3.6.0 release-cut sweeps |
  |---|---|---|---|
  | `/trades` | 2204 | 1949 | 2031 / 2079 |
  | `/lenses` | **1718** | **1557** | 1675 / 1719 |
  | `/` (dashboard) | 1327 | 1235 | — (under budget) |
  | overall median | 988 | 912 | — |

  Only those two routes breach, in both sweeps. The spread between the two runs (/trades moves
  255 ms untouched) is the variance the 2026-08-31 lesson records — the AFTER comparison is
  sweep-pair vs sweep-pair, never single numbers.
- **Stage A:** window `GroupList` with `useRowWindow` (states what is held back); ship `batches`
  as an `{id → label}` map instead of whole rows; memoise the six-lens grouping so tab switches
  do not regroup; stop computing `runRules` for lenses other than the active one **only if** the
  active lens can be known server-side without a URL change — otherwise keep. Pin in
  `tests/render-windowing.test.ts`: `virtual`, `DRILL_LIMIT`, `useRowWindow` in `GroupList`.
- **Stage B (only if A does not bring the median under 1500 ms):** drill-down members fetched
  on demand from `app/api/lenses/members` (same projection, same order) so the RSC payload
  carries group rows, not 25,001 trades. Aggregates still computed over the full set server-side.
  *(Q7 — approve B in principle so the wave does not stall on it.)*
- **After — MEASURED 2026-09-02 (Wave 4), same harness, same perf DB (now carrying migrations
  0055-0058), 43 routes × 3 rounds = 129 visits (the new `/review` joined the sweep automatically
  by being a sidebar entry):**

  | Route | Before (W0) | After (W4) | Verdict |
  |---|---|---|---|
  | `/lenses` | 1718 / 1557 | **920 / 901** | **fixed** — roughly halved, comfortably under budget |
  | `/trades` | 2204 / 1949 | 2069 / 2104 | unchanged, still the one breach; deliberately out of scope |
  | `/review` (new) | — | 1176 / 1122 | under budget on its first appearance |
  | `/` | 1327 / 1235 | 1393 / 1336 | under budget; moved untouched = variance |
  | overall median | 988 / 912 | 956 / 917 | flat |

  **Budget breaches: 2 → 1.** `/trades` is the survivor and stays deferred — it needs server
  pagination, which needs a total order on trades, which is NOT output-neutral (it moves
  `taxByFy` per-FY sums in the last paisa and can flip a harvest lot's status). That is its own
  change with its own before/after proof, never folded into a perf pass.

### 5.2 Eight global-capital reads → `getBucketCapital()`

All eight sites in §0 switch to the helper (rupees, `0 = unconfigured` preserved, aggregate
falls back to settings — no branch changes). `getBucketCapital` is split into
`lib/queries/bucket-capital.ts` (imports only `settings` + `accounts`) so `limits.ts` and
`ledger.ts` do not inherit `capital.ts`'s `trades`/`ipos` graph. `tests/capital-account-first.test.ts`
extends its source-and-DB proof to all eight files (red on revert of any one). The dashboard tile
and its goal badge now agree.

### 5.3 Telegram OS-notification fallback — the decision (Q6)

Facts: no plugin, no `@tauri-apps/api`, no notification permission, no call site; the plugin
route means **two new npm packages + Cargo.toml + Cargo.lock + a capability file**, i.e. the
package-lock hand-splice procedure and a permission surface no guard reviews. The browser
`Notification` API inside the WebView2 window costs nothing to try but is unverified on Windows.

**Proposed:** (a) make the failure note **durable and route-independent** now — a
`settings.last_telegram_failure` machine column `{date, reason}` written by the digest job,
rendered by a small strip in the sidebar footer area on every route until dismissed or the next
success; (b) probe the WebView `Notification` API in the desktop build, opt-in per device behind
the existing breach-notify preference pattern, fire it only for the digest-failed case; (c) ship
(b) **only if the probe passes on the built installer**, otherwise record the result in DECISIONS
and defer the plugin to v3.8 with no copy claiming it. Egress guard is unaffected (local only —
verified it scans network constructs only).

---

## 6. Docs / claims pass (before the bump, with the guards)

CHANGELOG `## v3.7.0 — review & discipline`; README `Now:` line → **v3.7.0** (fixing the stale
v3.2.0), all six unit figures + four e2e figures + badges synced; client README `## New in
v3.7.0`; TERMS/PRIVACY/**REFUND_POLICY** "Applies to: Vyuha v3.7.0" (*Q8*); deck chips;
INSTALLATION_GUIDE installer example; `docs/sales/landing-page.html` + `landing:build`; help
entry for `/review`; metric-help entries; the SL/TSL desktop-notification claim re-verified
against code or retired. DECISIONS entries: Process Score definition + floor; reviewed-at
backfill; onboarding flag as machine state; challan semantics; capital-read count (8, not 7);
/lenses before/after; Telegram fallback probe result; `perf:sweep` joins the release ritual (*Q9*).

---

## 7. Waves, agents, gates

Each wave: agents on **disjoint file sets**, read-only until their brief says otherwise, every
change with its red-on-revert test; the orchestrator runs the single `npm run verify` and echoes
the exit code. Baseline test count 2,899 / 188 — a lower number after any wave means a test was
deleted; stop and find out why.

| Wave | Agents | Files | Gate |
|---|---|---|---|
| **0 — baseline** | orchestrator | `perf:seed` → `next build` → `next start` on perf DB → two sweeps, numbers recorded | none |
| **1 — schema** | ONE migrations agent | `drizzle/0055–0058`, `_journal.json`, `lib/db/schema.ts`, `lib/domain/slim-trade.ts`, `lib/backup-format.ts`, `lib/backup.ts`, `lib/audit.ts`, `lib/queries/account-delete.ts`, `lib/domain/settings-baseline.ts`, `lib/db/seed-core.ts`, `tests/account-isolation`, `backup-roundtrip`, `settings-baseline` tests | verify #1 |
| **2 — pure + queries** (4 parallel) | (a) process-score + week + discipline delegation + advance-tax dated payments + tests · (b) review + weekly + onboarding queries/routes + tests · (c) challans query/route + tests · (d) capital 8-site fix + bucket-capital split + test extension | disjoint by directory | verify #2 |
| **3 — UI** (4 parallel) | (a) `/review` page + components + nav/help/PRO_FEATURES/metric-help · (b) Discipline 2.0 page + monthly · (c) challan editor + ITR taxes-paid + advance-tax calc wiring · (d) onboarding wizard + settings + Telegram durable note + Notification probe | disjoint | verify #3 + e2e (54 + 3 new) |
| **4 — perf** | (a) /lenses Stage A (+B if needed) | `app/lenses`, `components/lenses`, `tests/render-windowing` | verify #4 + double sweep |
| **5 — docs/claims** | 1 agent | §6 files | verify #5 (doc guards) |
| **6 — adversarial diff audit** | 6 finders (money · schema/migrations · security/gating/consent · UI/regressions · test-integrity · docs/claims), each refuting its own findings on live temp DBs; then fix agents on disjoint sets, every fix red-on-revert | whole diff | verify #6 + e2e + double sweep (final) |
| **7 — release** | orchestrator, `release` skill top to bottom | bump, lock roots by hand, Cargo.lock via cargo, desktop build + marker grep, `.sig` key id `4FF85F3BBE1DA21D`, CI 5/5 green **before** tag, Release workflow, `release:verify --deep`, client ZIP 12 entries, WDSI form details handed over unprompted, state file refreshed with verified numbers | — |

**Bundle markers for the freshness grep:** `Trade Review Desk`, `Process Score`, `Sunday`,
`challan`, `Run setup again`.

---

## 8. Owner decisions requested before Wave 1

| # | Question | Recommendation |
|---|---|---|
| Q1 | Approve the re-derived Review Desk design (§1) as the spec, given the researched design was never written to disk? | Yes — it is built entirely from surfaces that exist |
| Q2 | Process Score = 5 equal-weight components, floor 10 closed trades/week, and it **replaces** the 3-component weekly discipline score (numbers on `/reports/discipline` and the monthly PDF change on upgrade)? | Yes; two weekly numbers that disagree is the failure mode the repo keeps recording |
| Q3 | Backfill `reviewed_at` for trades that already carry notes / mistake tags / exit trigger? | Yes |
| Q4 | Onboarding keeps capital OPTIONAL (invariant-6 "—" paths stay live) rather than required? | Optional |
| Q5 | Challan ledger follows b/f-lot semantics (MOVE on merge, delete on purge, no trash snapshot)? | Yes, for consistency; flag if you want challans snapshotted |
| Q6 | Telegram fallback: durable note now + WebView `Notification` probe, plugin deferred to v3.8 unless the probe fails? | Yes — no new dependencies this release |
| Q7 | /lenses Stage B (on-demand member fetch) pre-approved if Stage A does not clear 1500 ms? | Yes |
| Q8 | Bump `REFUND_POLICY.md` to v3.7.0 and add it to the `client-docs-version` guard? | Yes |
| Q9 | `perf:sweep` double run becomes a written step of the `release` skill (not CI)? | Yes |
