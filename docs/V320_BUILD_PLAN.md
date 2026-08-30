# v3.2.0 BUILD PLAN — decided 2026-08-30

Synthesised from two independent research batches (Batch 1: deep-analytics market
research, 16 agents; Batch 2: Nexus Journal teardown, 14 agents), each with an
adversarial critic, plus ten owner decisions taken 2026-08-30.

**Every recommendation here survived a critic that verified it against this repo.**
Four Batch-2 recommendations were DELETED because the machinery already ships
(`lossIfAllStopsHit`, the staged warning system, `DTE_BANDS`, the lifetime-SKU copy),
and one Batch-1 evidence claim was deleted as fabricated. Do not resurrect them.

---

## OWNER DECISIONS (binding)

| # | Decision |
|---|---|
| 1 | **Onboarding = a BUYER was onboarded**, not the app feature. First-run onboarding remains UNBUILT; §8.4's entry stays honest. Record the buyer fact only. |
| 2 | **Correctness leads.** Effective-dated charge rates first. |
| 3 | **One v3.2.0 minor**, not a patch series. |
| 4 | **Full charge-rate fix** — migration + historical restatement. |
| 5 | **LIFO = analysis-only lens.** Hard-locked out of tax, ITR and stored P&L; labelled non-statutory. Indian tax PRESCRIBES FIFO for demat listed shares. |
| 6 | **Statistics: show, never hide.** Intervals everywhere; failing items marked "not yet distinguishable from chance" but never removed — it is the user's own record (invariant 7). |
| 7 | **All four dead-column features** + per-segment analysis. |
| 8 | **Segments: five** — Equity Intraday · Equity Delivery · Equity MTF · Options (Index) · Options (Stock). |
| 9 | **Security finding: record internally only.** No naming, no outreach. Add truthful Vyuha-effectiveness copy to Settings/Help. |
| 10 | **Max harness** — adversarial review, unit tests alongside, `npm run verify` per stream, e2e + full release ritual. |

---

## FACTS ESTABLISHED BEFORE PLANNING (verified in source, not recalled)

1. **`SEGMENTS` ALREADY distinguishes `index_option` from `stock_option`**
   (`lib/domain/constants.ts:9`). The owner's five segments map exactly onto existing
   vocabulary. **This is a presentation-and-depth problem, not a data-model change** —
   the single biggest de-risk in this plan.
2. `bySegment` (`metrics.ts:236`) and `segmentScorecard` (`cockpit.ts:327`) already
   exist. WS3 EXTENDS them; it does not invent grouping.
3. **`charge_config_uq` is `(broker, plan, segment, exchange)` — no date column**
   (`schema.ts:362`). One rate row per key; every trade prices at today's rate.
4. **`findRates()` has 12 call sites across 8 files** — `rates.ts`, `commit.ts`,
   `mtf-accrual.ts`, `queries/ipos.ts`, `queries/staged.ts`,
   `api/charges/preview/route.ts`, `app/equity/page.tsx`, `app/targets/equity/page.tsx`.
   That is the exact blast radius of effective dating.
5. **Latest migration is `0049_openalgo-optin.sql`** → next is **0050**. Migrations
   0027+ are hand-written and need a `drizzle/meta/_journal.json` entry.
6. **Zero statistical inference exists** in 48 analytics + 8 risk modules. No Wilson,
   no p-value, no multiplicity control.
7. **The vault is real**: AES-256-GCM with a KEK/DEK scheme, plus
   `sweepPlaintextSecrets()` (`lib/vault.ts`). The Settings/Help security copy has a
   truthful basis.
8. **First-run onboarding is genuinely absent** — the only two greps are unrelated
   comments (an empty-dashboard branch; trial-day arithmetic).

---

## WORKSTREAMS

### WS1 — Effective-dated charge rates *(correctness spine; everything else waits)*

- Migration **0050**: add `effective_from` (NOT NULL, default `'1970-01-01'`) and
  `effective_to` (nullable) to `charge_config`; unique index becomes
  `(broker, plan, segment, exchange, effective_from)`.
- `findRates(rates, broker, segment, exchange, onDate)` resolves the row whose window
  contains `onDate`. **When no epoch covers the date it REFUSES** (returns a stated
  "no rate on file for <date>") rather than silently using today's — invariant 6.
- Update all 12 call sites to pass the trade's own date.
- **Restatement is a REPORT plus an explicit, audited user action — never a silent
  rewrite of stored `chargesTotal`.** Showing a user a different P&L than yesterday
  without their consent is exactly the failure this product exists to avoid.
- Tests: window resolution, boundary dates (inclusive-from / exclusive-to), overlapping
  rows rejected, missing epoch refuses, all 12 call sites pass a date.

### WS2 — Statistical inference layer

- New pure module `lib/analytics/inference.ts`: Wilson score interval for proportions,
  interval for mean expectancy, **Benjamini–Hochberg** with a documented note on
  Benjamini–Yekutieli under the dependence that overlapping slices create, and
  small-sample shrinkage.
- Applied to `/reports/edge`, `/lenses`, Arjun's Eye findings, `playbookStats`.
- **Show, never hide.** Every rate carries an interval; items failing correction are
  marked, not removed.
- Cites its methods in the module header — the Batch-1 critic's fair complaint was that
  a rigour proposal cited no methods literature.

### WS3 — Per-segment analytics (five segments)

Depth per segment: expectancy + CI, win rate + CI, charges drag %, ROM, holding
behaviour, exit-time profile, order fragmentation. Reuses WS2's intervals. Built
SQL-side/paginated from the start — six routes already breach the perf budget and this
must not become the seventh.

### WS4 — The four dead-column features

- **Exit clock** — `exitTime` (today only a sort tiebreak at `cockpit.ts:284`).
- **Stop migration** — mine `audit_log` before/after for stops moved after entry.
- **Exit triggers** — migration **0051**, new column + taxonomy + UI; crossed with the
  `capturedPct` already in `mae-mfe.ts`.
- **Order fragmentation** — `buyOrderCount`/`sellOrderCount` as behaviour, not just as
  charge inputs.

### WS5 — LIFO analysis lens
Analysis-only. Hard-locked out of tax, ITR and stored P&L; labelled non-statutory.

### WS6 — Verified small fixes
- `effectiveStop()` returns `trailingSl` unconditionally (`staged.ts:171`), so a TSL
  typed *below* an SL silently governs `alerts.ts:38` and `exposure.ts:160` → **fifth
  warning code** in the existing enum.
- `openRiskPct` doc/code contradiction (`exposure.ts:63` says "only stopped positions";
  `:235` sums every position).
- Promote `lossIfAllStopsHit` to a book-level tile on `/risk` and `/equity`.
- Dashboard secondary tiles get the basis line the reports pages already carry.

### WS7 — Docs + security copy
- VYUHA-STATE: buyer onboarded; onboarding FEATURE still unbuilt.
- Settings/Help: truthful credential-protection copy (AES-256-GCM vault, plaintext
  sweep, no telemetry, no account, no cloud). **Names nobody.**
- DECISIONS entries; CHANGELOG; README; client docs.

---

## SEQUENCING

WS1 is foundational and **serialised** — WS3 and WS6 read the charge engine.
WS2 must land before WS3 (WS3 consumes its intervals).
Migrations 0050 (WS1) and 0051 (WS4) must not be authored concurrently: numbering and
`_journal.json` would collide.

**On worktree isolation:** the owner chose maximum isolation. Applied with judgement —
parallel worktrees are used only where workstreams touch disjoint files. Anything
touching the schema, the migration journal, or shared analytics indexes is built
sequentially in the main tree, because a three-way merge across `lib/analytics/` would
cost more than it saves. Adversarial review runs on every workstream regardless.

## DEFINITION OF DONE (per workstream)
Unit tests alongside · `npm run verify` EXIT 0 (never with a dev server up) ·
adversarial review with a fix loop until clean · account scoping honoured (invariant 8) ·
nothing fabricated (invariant 6) · the core journal still ungated (invariant 7).

## RELEASE
Full ritual: verify → e2e → docs pass → six README figures by pattern → `bump-version
3.2.0` (footer moves to `v3.2` — **4 files synced is correct for a MINOR**) → hand-edit
the two package-lock roots → `desktop:build` → BUILD_ID + feature-marker grep →
decode `.sig` = `4FF85F3BBE1DA21D` → `client:package` → commit → push → CI 5/5 green
BEFORE tag → tag → Release workflow → `release:verify`.

---

## WS1 — SHIPPED AND ADVERSARIALLY REVIEWED (2026-08-30)

`npm run verify` EXIT 0 with the production build; **2,104 tests / 142 files**.

**Statutory source, now primary.** Finance Act 2026 (Presidential assent 30 March 2026),
effective 1 April 2026 — **NSE Circular Ref. No. 02/2026, Download Ref. No.
NSE/FATAX/73524, dated 31 March 2026**. Only THREE rates moved, all derivatives:
option sale 0.10%→0.15% (row 4a, seller), option exercised 0.125%→0.15% on intrinsic
(row 4b, purchaser), futures sale 0.02%→0.05% (row 4c, seller). Equity delivery (0.1%)
and intraday (0.025%) are explicitly "No Change"; commodity CTT is a different levy the
circular does not touch. Encoded in `lib/db/seed-data.ts` with the citation.

**Review outcome — 1 blocker, 8 should-fix, 6 nits.** Fixed this session:

| # | Finding | Resolution |
|---|---|---|
| 1 | **BLOCKER** — `seed-core` refresh looked rows up by the PRE-0050 identity, so a second epoch let it write today's rate over the historical window. Reproduced against real SQLite. | Lookup now includes `effectiveFrom`. Pinned by `tests/charge-epoch-seed.test.ts`, which seeds twice and asserts the historical rate survives. |
| 2 | `/reports/charges` never re-prices — it accumulates stored `chargesTotal`. The claim was overstated in 4 places. | Corrected in the migration, `rates.ts`, the test header and DECISIONS. |
| 3 | `closePosition` priced the exit at the BUY date's epoch (`t.sellDate` is null for an open long). | Passes the computed `{buyDate, sellDate}`. |
| 4 | `updateManualTrade` resolved rates before the edited dates were derived. | `findRates` moved below the date derivation. |
| 5 | `todayIso()` called inside the pairs×trades loop — measured ~44% of broker-compare's compute at 400k calls. | Hoisted. |
| 7 | `accrueMtfInterest` unguarded on `/equity`; `findRates` unguarded on `/targets/equity`. The change had guarded the cosmetic call and left the load-bearing one exposed. | Both guarded; one position's interest is lost, never the page. |
| 9 | `pricingDate` turned an American `12-25-2026` into `"2026-25-12"` — lexically larger than any real date, so it silently resolved to the NEWEST epoch. | Month/day validated; an impossible date refuses to the caller's fallback. |
| 12 | broker-compare sampled the newest epoch for `subscriptionMonthly`, which could be a future-dated plan. | Samples the epoch in force today. |
| 14 | The header claimed the staged engine resolves rates per leg. It does not — one `findRates` for the whole ladder. | Corrected in both doc blocks and DECISIONS. |

**Open follow-ups, recorded rather than silently dropped:**
- **#6 — the charge editor cannot tell two epochs apart.** Its row picker shows
  broker · segment · exchange, so two epochs render identically and a save targets
  whichever was selected. WS1 ships the capacity to hold rate history without the UI to
  read or edit it. Do this before advertising the feature.
- **#8 — `lib/jobs/mtf-accrual.ts` restates stored P&L.** It prices at today's epoch and
  applies that rate across the whole holding period, then writes back. So an open MTF
  position DOES silently restate when an MTF-interest epoch changes, contradicting
  decision 6. Carved out explicitly in DECISIONS until the accrual is epoch-segmented.
- **#13 — `todayIso()` is UTC.** For an Indian user between 00:00 and 05:30 IST it
  returns yesterday; harmless except on an epoch boundary day.
- **#10/#11** — calculator drops a key and the risk page falls back to a constant when no
  epoch covers today, rather than saying so.
