# Decisions

Append-only. Newest first.

Facts that cost something to learn: measured numbers, choices where the obvious
option loses, surprising bug causes, deliberate deviations from a spec or
default, and things intentionally NOT done.

## 2026-08-31 — The governing statute changed, and turnover had been wrong for three years (v3.3.0)

**Context:** four independent research streams (a competitor workspace teardown, an internal
tax/KPI inventory, primary-source Indian tax research, a third-party repo teardown). The tax
stream turned up something that outranked the brief it was given. Full plan and citations:
`docs/V330_BUILD_PLAN.md`.

**Decisions:**

1. **The Income-tax Act, 1961 is repealed; the Income-tax Act, 2025 came into force on
   1 April 2026.** Verified in the Gazette text, not commentary: *"it shall come into force on
   the 1st April, 2026."* Every section number this app displays — 111A, 112A, 43(5), 44AB,
   44AD, 234C, 87A, 115BAC — is repealed law for the current year, mapping to s.196, s.198,
   s.66(31)/(33), s.63, s.58, s.425, s.156, s.202. **The arithmetic survives; the citations do
   not.** The ₹10 Cr / ₹3 Cr limits in `itr.ts:61-62` and the 15/45/75/100 instalments are
   unchanged, and grandfathering survives verbatim as s.90. This is therefore an
   EFFECTIVE-DATING problem of exactly the shape WS1 solved for charge rates — deferred to
   Phase 1, so historical FYs keep 1961 citations rather than being retro-labelled.

2. **F&O turnover omitted option premium, and that number decided the audit verdict.**
   `itr.ts:131` used `abs(grossPnl)` and fed `auditVerdict`. The CURRENT ICAI Guidance Note —
   **11th edition, 2026, para 5.11(b)(ii)** — says *"Premium received on sale of options is
   also to be included in turnover."* For an options seller premium can exceed |P&L| by orders
   of magnitude, so this could report "audit generally NOT required" on a book far over the
   line.
   **Why the obvious source loses:** premium was REMOVED in the 8th edition (2022) and
   **REINSTATED in the 9th (2023)**, unchanged through the 10th and 11th. The widely repeated
   "premium never counts" is the 2022 position and has been wrong since 2023 — and a web search
   returns it confidently across several otherwise reputable sources. It was caught only by
   reading the Guidance Note PDFs. The file's own header had documented the 8th-edition choice
   and called the premium method "the older 2012 method"; that comment was false.
   **Invalidated if:** ICAI issues guidance mapped to s.63. The 11th edition's Preface calls
   itself the concluding edition under the 1961 Act, so carrying 5.11(b) forward is PRACTICE,
   not authority — which is why `TURNOVER_BASIS` is shown to the user rather than buried.

3. **Three turnover formulas collapsed into one module.** `tax.ts` added premium,
   `itr.ts` did not, and `itr-schedule.ts:161` used `abs(NET P&L)` — net is after charges and
   wrong under every edition. Two of the three were on screen simultaneously on different
   pages, so the same book showed two turnovers for one year. `lib/analytics/turnover.ts` now
   owns the method and the segment sets; a test asserts `/reports/tax` and `/reports/itr` agree.

4. **s.425(2)'s safe harbour was never implemented, so the planner charged interest the statute
   does not.** Gazette text: no interest where advance tax paid by 15 June is **≥12%**, or by
   15 September **≥36%**, of tax due on the returned income. **First two instalments only —
   there is no tolerance for December or March.** The shortfall is still REPORTED (the payment
   obligation is real); only the interest is waived, and the row is badged "short · no interest"
   so it does not read as a bug.

5. **The s.425 interest RATE was already correct — do not "fix" it.** s.425's Table states flat
   3% / 3% / 3% / 1%. The old §234C reached the same figures as 1%/month × 3/3/3/1 months, which
   is what `advance-tax.ts` computes. A reviewer reading "the Act says 3%" and multiplying the
   existing month count by 3% would treble the interest. Recorded because the research stream
   itself flagged this as a defect, and it is not one.

6. **s.425(4) relief is opt-in, not inferred.** It waives interest on a shortfall from
   underestimating capital gains, dividend, casual income, or business income *"accruing or
   arising for the FIRST TIME"* — but only if the tax on it is paid in full by 31 March. The
   conditions are CONJUNCTIVE and there is no statutory "could not reasonably have estimated"
   test, so the payment test is what was built. **An established F&O or intraday trader gets no
   relief on a windfall quarter**, and "first time" needs history predating the journal, so the
   caller must assert it. Defaulting it on would understate a real liability.

7. **`harvest.ts`'s `CG_RATES` was DELETED rather than re-pointed.** It held a second hardcoded
   copy of the post-23-Jul-2024 pair while `capitalGainsRatesFor` resolved by date, so the two
   modules could disagree on a historical year. **Why not the obvious thing:** replacing the
   literal with a `new Date()` read would have made a `lib/analytics` module time-dependent at
   import and merely moved the staleness. Rates now come from `capitalGainsRatesFor(date)`.

8. **The s.175 dividend/bonus stripping check was scoped OUT, deliberately.** It is the one
   lever no surveyed competitor computes, it is statutory and computable, and it runs *against*
   the user — which is exactly why it is safe to ship and why nobody else will. It needs a
   bundled record-date dataset, which the owner declined on 2026-08-31. **Recorded as a visible
   scope decision, not a silent absence.**

9. **A competitor's floating-window workspace was assessed and declined.** Their 40 widgets are
   500-byte wrappers re-mounting existing pages (`TaxMetricsWidget` is 494 B); the windowing
   layer is ~200 lines plus a localStorage hook. The expensive work is all upstream in broker
   ingestion. It was declined for Vyuha on three grounds: it has no print story and this app's
   reports are paper-bound; it multiplies the pointer-only accessibility debt already recorded
   for sidebar reorder; and the widgets are worthless without the pages behind them. Persisted
   dashboard filters, pinned KPI cards and saved views get the value at a fraction of the cost.
   Note `settings.workspace` is already taken (`both|equity|fno`) — any such feature needs
   another name.

10. **`lib/analytics/tax.ts` had no test file** while every sibling tax module had one. It is
    the module behind the primary `/reports/tax` FY table. Now covered.

11. **Citations are resolved BY TAX YEAR, not relabelled wholesale** (`lib/analytics/statute.ts`).
    Call sites reference a CONCEPT key (`"audit"`, `"interestDeferment"`), never a number, so a
    future Act is one table away rather than a repo-wide find-and-replace. **Why not the obvious
    thing:** swapping every citation to the 2025 Act is one sed away and would make every
    historical FY report cite law that never governed it — the same class of error effective
    dating exists to prevent. An unparseable year falls back to the CURRENT Act, because a
    citation that is current-but-unqualified misleads far less than one confidently naming
    repealed law. A test asserts no key resolves to the same string under both Acts.

12. **A monthly TAX breakdown is not a thing, and saying so is the feature.** Competitors ship a
    widget called "Monthly Tax Breakdown". Set-off between heads, the long-term exemption
    threshold and the slab rates are ALL annual, so no month has a tax figure of its own. Vyuha
    ships **"Realised by head, by month"** with `MONTHLY_HEAD_CAVEAT` travelling with it wherever
    it renders. The honest label is the differentiation.

13. **`monthlyBreakdown` does not recompute retPct.** The geometric monthly return needs the
    equity series and already exists in `performance.ts`. Duplicating it over trades would create
    two monthly return figures that could disagree — precisely the defect three turnover formulas
    caused. This module aggregates TRADES (count, wins, charges, drag); the matrix keeps the
    percentage.

14. **Month-over-month is null across a gap, never carried.** `momNet` is set only when the
    preceding row is the immediately preceding CALENDAR month. A trader who did not trade in
    November has no November-to-December comparison, and quietly comparing December against
    October would invent a trend.

15. **The tax-lever module enforces (C) by ABSENCE, and a test enforces the absence.** There is
    deliberately no export that selects a scrip to sell, ranks "opportunities" or estimates a
    liability; `tests/tax-levers.test.ts` fails on any export name matching
    `/recommend|suggest|advice|shouldSell|opportunit|.../`. Naming a security and prompting a
    transaction falls outside the SEBI (Investment Advisers) Regulations 2013 reg. 4 exemption for
    general comments "without specifying particular securities". **The most dangerous thing a
    journal can say here is "wait 30 days before buying back" — India has NO wash-sale rule, and
    inventing a holding period teaches the user false law.**

16. **The set-off asymmetry is the lever worth shipping.** A current-year F&O loss can meet
    capital gains but NEVER salary; carried forward it can only ever meet business income again.
    So the same rupee is frequently worth more used now. Every shipped competitor harvesting
    screen is equity-holdings-only and misses this entirely.

17. **`HARVEST_FIELDS` gained three columns, not a second query.** `netPnl`, `chargesTotal` and
    `sttCtt` were added to the existing projection. Columns only — no new WHERE — so the stated
    contract (identical row order feeding `allocate()`'s stable sort, identical float sums) holds
    by construction.

**Measured:** `npm run verify` EXIT 0 — **2,266 tests / 151 files** (was 2,184 / 146), lint **0
problems** (the three WS1 unused imports were removed here), production build clean. Verified
rendering against the repo dev DB: the STT split reported ₹28,478 forfeited across 42 delivery
trades versus 85 business-head trades, and the holding clock aged real open lots.

**Environment finding, not a code defect:** the live desktop DB at
`%APPDATA%/in.vyuha.tradejournal` is still PRE-0050 — `no such column: effective_from` and
`no such column: exit_trigger`. Migrations 0050/0051 have never run against it, so v3.2.0 has
not been launched on the build machine. Note WHY only some screens failed: `getHarvestTrades`
uses a column projection and never selects `exit_trigger`, while pages using
`db.select().from(trades)` select every column and throw. A projection can hide a schema drift
that a full select surfaces.
**Flaky, pre-existing:** `tests/account-delete.test.ts` "the upsert schema stores a trimmed
name" timed out at the 5 s default under full-suite parallelism once, then passed in isolation
(19/19, 1.57 s) and on the next full run. Not caused by this work; noted rather than hidden.

## 2026-08-30 — Statistical inference, segment depth, and the columns nobody read (v3.2.0)

**Context:** two independent research batches (deep-analytics market research; a competitor
teardown), each with an adversarial critic, plus a schema audit that cross-referenced every
column against every read.

**Decisions:**

1. **Benjamini–YEKUTIELI is the default multiplicity control, not Benjamini–Hochberg.** BH
   controls the false-discovery rate only under independence or positive regression dependence
   (PRDS). Slices of one trade book are neither — "morning trades" and "NIFTY trades" overlap,
   share trades, and can correlate in either direction. BY (2001) is valid under ARBITRARY
   dependence at the cost of a log-factor of power. Given the alternative is telling someone
   their edge is real when it is not, that is the right trade. BH stays exported for the
   genuinely independent case and every result NAMES the method that produced it.

2. **Wilson, not Wald, for every proportion.** The textbook Wald interval returns the single
   point 0 at k = 0 — absolute certainty from no evidence — and routinely runs outside [0,1].
   Wilson never leaves the interval and has far better small-sample coverage (Brown, Cai &
   DasGupta 2001), which is the only regime a per-setup slice ever lives in.

3. **Show, never hide (owner's decision).** A slice that fails correction is MARKED "not yet
   distinguishable" and stays on screen. It is the user's own record (invariant 7); suppressing
   it would also make a new user's first week emptier, which the research critic identified as
   a live activation risk.

4. **Tests pin PUBLISHED values, not the implementation's own output.** Wilson against the
   Brown/Cai/DasGupta worked examples, BH against the original method, BY worked through by
   hand. This caught a real error: the BY assertion said one slice would survive, the code said
   two, and **the code was right**. A statistics module that only agrees with itself is worth
   nothing.

5. **Segment depth covers FIVE segments, not all eight.** `SEGMENTS` has distinguished
   `index_option` from `stock_option` since long before this, so the owner's requested split
   needed no data-model change — the single biggest de-risk in the release. Futures and
   commodities stay in `bySegment` and are COUNTED on the new surface ("N closed trades sit in
   futures or commodities, which this table does not cover") rather than padded in as empty
   rows.

6. **Charge drag refuses a percentage against a negative gross.** A "drag %" computed on a loss
   reads as a share of profit that was never earned.

7. **`exitTrigger` is free text with a curated list, and blanks are EXCLUDED, never bucketed.**
   An unanswered question is not an answer. Every analytic over the column reports how many rows
   it excluded so the screen can say so (invariant 6).

8. **Stop migration reports the expectancy GAP, never a counterfactual.** "You would have lost
   ₹4,200 less" needs the price path after the edit, which Vyuha does not have at intraday
   granularity. The same discipline `mistakeReport` has always used.

9. **`effectiveStop` behaviour is deliberately UNCHANGED.** A trailing stop typed on the wrong
   side of its original silently widens the working stop, and it governs both breach detection
   and capital-at-risk — the position looks safer than it is on two screens at once. Silently
   substituting the tighter stop would hide a data-entry error and disagree with what is
   actually working at the broker, so a fifth warning code (`tsl_less_protective`) tells the
   user and they decide.

10. **`openRiskPct`'s doc comment was the thing that was wrong.** It claimed the aggregate
    counted only stopped positions; the code has never done that, and `staged.ts` states the
    same policy deliberately ("No stop: the honest worst case is the whole position"). Counting
    an unstopped position as zero risk would be the least honest option available.

**Also verified and NOT acted on:** four Batch-2 recommendations described machinery that
already ships (`lossIfAllStopsHit`, the staged warning system, `DTE_BANDS`, the lifetime-SKU
copy) and one Batch-1 evidence claim was fabricated (a competitor's charges page was said to be
five months stale; it publishes both rate epochs with explicit dates). All deleted before they
reached this release. Recorded so nobody resurrects them.

**Deferred, deliberately:** the LIFO analysis lens. Indian tax PRESCRIBES FIFO for demat-held
listed shares, so LIFO can only ever be a what-if view, and shipping a second P&L number that
looks equally official is a support and correctness hazard for marginal gain. The owner asked
for it as an analysis-only lens; it is the lowest-value item in the plan and is held for a
later release rather than rushed into this one.

## 2026-08-30 — Charge rates become effective-dated (v3.2.0 WS1)

**Context:** `charge_config_uq` was `(broker, plan, segment, exchange)` with no time
dimension (`schema.ts:362`), so exactly one rate row existed per key and EVERY trade —
of every vintage — was priced at whatever that row holds today. A book spanning a
statutory rate change was priced wholly at the newer regime. **Scope, stated precisely
because the first draft of this entry overclaimed it:** `/reports/broker-compare` (Pro)
re-prices the whole book from the rate table and is directly affected;
`/reports/charges` accumulates the `chargesTotal` stored at commit time
(`lib/analytics/charges-report.ts:63`), so effective dating reaches it only through
what future imports write. Found by the v3.2.0 research pass and
confirmed independently by its adversarial critic.

**Decisions:**

1. **Epochs, not a rewrite.** Migration 0050 adds `effective_from` (NOT NULL, default
   `'1970-01-01'`) and `effective_to` (nullable, EXCLUSIVE), and the unique index gains
   `effective_from` so one key can hold several dated rows. **Every pre-existing row is
   stamped `1970-01-01` open-ended, so each key still covers all of history and NOTHING
   re-prices on upgrade.** The migration creates only the CAPACITY to be correct about
   time; it changes no number by itself. That property is pinned in
   `tests/rate-epochs.test.ts` ("migration 0050 safety").

2. **The date argument is REQUIRED, not optional.** `findRates` gained `onDate` as a
   required parameter specifically so the compiler would find all 12 call sites across
   8 files. An optional date would have let every existing site keep the old behaviour
   silently — which is the bug being fixed. The compiler found them; each was then given
   the date that is correct for what it prices.

3. **Inclusive-from / exclusive-to.** Adjacent epochs abut without overlapping and a
   boundary date belongs to exactly one epoch. Pinned both ways in tests.

4. **It REFUSES rather than substituting.** With no covering epoch, `findRates` throws
   and names the windows on file. A silently-substituted rate is a wrong number wearing
   the same typeface as a right one (invariant 6). `broker-compare` catches the throw and
   counts the trade as `missing` rather than pricing it at the wrong regime.

5. **One pricing-date rule, not eleven call-site opinions.** `pricingDate()` prefers the
   SELL date (STT and DP both fall there), falls back to the buy date for an open
   position, then to the caller's date. **A position that SPANS an epoch boundary is
   priced wholly at its sell date's epoch** — a stated approximation, because
   `computeCharges` takes one rate set for both sides; true per-leg resolution would need
   the staged engine's `legChargeShapes` path. Recorded here so nobody later reads it as
   an oversight.

6. **Restatement of stored charges is deliberately NOT automatic — and the one path
   that violated it has been closed.** Showing a user a different P&L than yesterday
   without their consent is precisely the failure this product exists to avoid.
   Reports price correctly by date; rewriting stored `chargesTotal` on historical
   trades stays an explicit, audited user action.

   The adversarial review found `lib/jobs/mtf-accrual.ts` breaking this: it priced at
   TODAY's epoch, applied that rate across the WHOLE holding period, and wrote
   `chargesTotal`/`netPnl` back — so an open MTF position silently restated the moment
   an interest epoch changed. Fixed with `epochSpans()`, which splits a holding period
   into the epochs that actually governed it. **Its spans always sum to the whole
   period, so a broker with one open-ended epoch — every broker today — accrues
   arithmetically identically to before.** The common case does not move at all; only a
   period that genuinely straddles a rate change now accrues at two rates. Where no
   epoch covers part of the period it accrues NOTHING rather than stretching a
   neighbouring rate over the gap. Showing a user a
   different P&L than yesterday without their consent is precisely the failure this
   product exists to avoid. Reports price correctly by date; rewriting the stored
   `chargesTotal` on historical trades stays an explicit, audited user action.

**A bug this introduced, and what caught it.** `pricingDate` first sliced the raw date
string. But `buildRow` prices a trade BEFORE `normalizeDate` runs at insert time, so a
Groww row still reads `06-05-2026` (day-first) there. Compared against an ISO window
that matched no epoch, and `findRates` refused a perfectly valid trade — the whole Groww
import test failed. **Review did not catch this; the existing import test did.** The
helper now normalises both conventions, and the regression is pinned.

**Verified:** `npm run verify` EXIT 0 with the production build, **2,103 tests / 141
files** (was 2,089/140), no dev server running.

## 2026-08-30 — The live-demo failure was three sentences, not three bugs

**Context:** A live demo of v3.1.0 importing the owner's own Paytm Money and Zerodha
tradebooks "failed": the audience read the P&L values and the trade counts as wrong.
All 173 import tests were green at the time, including the reconciliations against
those very brokers' statements. Re-measured on the exact demo files (larger than the
private fixtures the diagnosis was built on: 7,544 Paytm executions and 3,530 Zerodha
fills, against 414 and 1,554).

**What was actually wrong, and what was not:**

1. **The counts were right and the sentence was wrong.** `7,544 executions → 804 positions`
   was rendered as the second number alone — "804". To anyone who knows they placed 7,544
   orders that reads as data loss, and no correct arithmetic underneath undoes the first
   impression. The Dhan GTR had solved this in 2026-08-12 (`ParsedFile.sourceRows`,
   "92 lines → 73 trades") and the lesson never reached the aggregate count at the top of
   the screen. Fixed by making the sentence a single pure module,
   `lib/domain/import-shape.ts`, used by the preview, the commit result AND the
   Recent-imports row — three surfaces that had three different phrasings and one of them
   had none. **Never state the position count without the execution count that produced it.**

2. **A false alarm was firing on BOTH demo files, on screen, saying "please report this
   file".** `summarisePairing` treated ANY non-zero `valueDelta` as a lost lot. But each
   paired position rounds its buy and sell values to the paisa, so N positions carry up to
   2N half-paisa residues that no longer cancel — a ceiling of N × 0.01 that is REACHED,
   not approached. Measured: **₹0.04 on ₹75.8 crore of Paytm turnover (804 positions) and
   ₹0.01 on Zerodha's (79)** — 1e-9 of turnover, with `qtyDelta` exactly 0 in both. The
   tolerance is now derived from the rounding that produces it (`positions × 0.01`, floor
   0.05) rather than picked, quantity stays exactly strict, and the check is one
   `conserved` flag in `pair-legs.ts` instead of the same expression copied into four
   parsers. A genuinely lost lot moves whole rupees and almost always moves quantity too,
   so it still fails loudly. `tests/load/c8-pairing-depth.load.ts` had already encoded this
   understanding (`relDrift < 1e-6`) — the parsers just never learned it.

3. **The blank P&L cells are the product working.** 72 of 804 Paytm positions and 11 of 79
   Zerodha positions are opening sells — shares sold from holdings the file never shows
   being bought. Invariant 6 says never fabricate a denominator, so they read "—". That is
   indistinguishable on screen from "the importer failed", so the import result now SAYS it
   (`openingSellNote`), naming the count and how to fill it in.

**Measured on the demo files (for the next person who re-measures):** Paytm 7,544 → 804
positions (650 closed / 82 open / 72 opening sells), closed net ₹1,54,39,611 against
Paytm's own in-window realised ₹1,64,58,423 = **−6.19%**, the gap being pre-window cost
basis the tradebook cannot see. Zerodha 3,530 → 79 (64 / 4 / 11), gross ₹9,02,987 against
Console's stated realised ₹9,53,951; Zerodha's tradebook carries no charge columns at all,
so its charges are engine-computed by design.

**Deliberately NOT done: the F&O path was not touched.** The Zerodha demo file was checked
for it and is **equity-only** — every row's Segment is `EQ` and zero symbols match the
compact F&O grammar. The `NIFTY26JUN24500CE` defect therefore still has no real sample, and
AGENTS.md's rule stands: fix it against a real F&O export or not at all.

## 2026-08-30 — Bundled ISIN→symbol snapshot: why the index map was never going to be enough

**Context:** Paytm Money's tradebook states exchange scrip codes, not tickers, and
`lib/import/isin-symbol.ts` resolved them through the bundled NSE index-constituent map.

**Measured on the owner's demo book:** 215 distinct numeric codes, of which the index map
resolves **76**. The map covers index CONSTITUENTS — so it resolves large and mid caps and
misses precisely the SME names a trader is least able to recognise by number. Of the 139
misses, **69 appear only on BSE rows, 48 only on NSE rows, 22 on both**.

**Decisions:**

1. **A second snapshot, not a replacement.** `lib/data/isin-symbols.json` (built by
   `scripts/build-isin-symbols.mjs`, same snapshot discipline as the index map: script +
   `asOf` + never hand-edited) is consulted BEFORE the index map, and the index map stays in
   the chain. It is built from a different set of downloads, so it still answers when the
   listing snapshot is stale, partial, or was rebuilt from an incomplete folder. Two
   independent sources cost ~200 KB and remove a single point of failure.

2. **NSE wins a collision, and load order is forced rather than left to `readdir`.** One
   ISIN, two tickers; every other Vyuha surface (index map, bhavcopy, corporate actions,
   surveillance) is keyed on the NSE symbol, so preferring BSE's Security Id would print a
   ticker that is correct and matches nothing downstream.

3. **Active equities only.** BSE's `ListOfScrips` carries debt, MF units, warrants and
   delisted rows. A delisted ticker that has since been REISSUED to another company is the
   silent two-companies-in-one-position merge this module exists to prevent.

4. **NSE's own lists are not sufficient for this book.** 69 of the 139 unresolved codes sit
   on BSE-only rows, so `EQUITY_L.csv` + the Emerge SME list leave roughly a third of the
   misses unresolved. The BSE list is required, not optional — and BSE's `segment=Equity`
   query already includes the BSE SME board, so it is one download, not two.

   **Built and measured the same day: 5,671 ISINs (NSE main 2,559 + NSE Emerge 565 + BSE
   2,547 new), 142 KB, `asOf` 2026-08-30 — and ALL 215 demo scrip codes resolve, plus all
   66 in the older private fixture.** Both are pinned in
   `tests/isin-bundle-coverage.test.ts`.

   Three things about the download that will otherwise be rediscovered the hard way:
   `nseindia.com` itself answers **403** to a plain client while the `nsearchives.nseindia.com`
   archive host serves the CSVs fine, so no cookie dance is needed; the Emerge list is at
   `/emerge/corporates/content/SME_EQUITY_L.csv` and the plausible
   `/content/equities/SME_EQUITY_L.csv` returns a **224-byte error page under HTTP 200**
   (the script rejects any body under 2 KB for exactly this reason); and BSE's API returns
   an **empty array when `segment` is blank**, so the parameter must be spelled `Equity`.
   The URLs live in `SOURCES` in the build script, and `--fetch` does the whole refresh.

5. **An absent snapshot must not fail anything.** The committed placeholder is empty; the
   chain falls through to the index map, and `tests/isin-bundle-coverage.test.ts` SKIPS its
   coverage assertions rather than reddening CI. It fails only once a real snapshot exists
   and still leaves a code unresolved.

## 2026-08-29 — Account deletion: two coherent ends, capped capital carry, credentials never in trash

**Context:** The v3.1.0 headline — per-account Delete in Settings (`lib/queries/account-delete.ts`, trash envelope in `lib/trash-format.ts` / `lib/trash.ts`). Four decisions worth not re-litigating.
**Decisions:**

1. **The option set is exactly two: purge everything, or merge everything (with a separate
   broker-connections choice).** Half-merges — "merge the trades but delete the ledger",
   "keep the IPOs but drop the imports" — are deliberately NOT offered. The account-scoped
   tables reference each other (`ledger_entries.refTradeId`, `ipos.tradeId`,
   `import_batches` ↔ trades), so any partial split either leaves dangling references or
   silently rewrites a book the user thinks it preserved; and a merge moves rows by
   account-keyed UPDATEs precisely so trade ids never change and every child link survives.
   Two coherent ends the preview can state truthfully beat a matrix of options whose
   consequences nobody can predict from a dialog.
2. **The capital-compounding marker carried into a merge target is
   `carried = min(source.pnlRolledIn, max(0, net realised P&L of the trades that MOVED))`,
   and `compoundRealised` now refuses a negative available figure outright.** Carrying the
   full source marker was the original design and it was wrong: dedup collisions keep their
   realised P&L out of the target, so the target's marker could exceed its realised total and
   "available to compound" went NEGATIVE — a click on Compound would have applied a
   withdrawal. The cap fixes the arithmetic; the refusal in `compoundRealised` is the second
   line of defence against any future path that recreates the state. The uncarried share is
   not lost: the envelope records `merge.carried`, and restore recreates the source with
   `pnlRolledIn = original − carried` while subtracting `carried` back out of the target
   (floored at 0). The source's equity/active-capital figures are never added to the target —
   capital is the user's own statement, not something a merge may fabricate.
3. **Trash envelope v2 is ADDITIVE — optional `account` + `accountRows` fields — and
   `broker_connections` rows never enter a trash file.** Additive because v1 trade-deletion
   snapshots must keep restoring unchanged (old readers ignore unknown optional fields; old
   files carry no account and restore exactly as before). Credentials are excluded for the
   same reason backups redact them: a trash file is a plain file on disk, and an encrypted
   secret sitting next to the journal's vault key is not encrypted in any useful sense. The
   dialog states the consequence — deleted connections are gone for good. Panel dismissals
   are regenerable and also not snapshotted.
4. **Restore refuses the WHOLE account restore on an id or name conflict — nothing partial.**
   If the snapshot's account id is taken by a different account (or its name now belongs to
   one), restoring rows into it would merge two books — the exact corruption account
   isolation (invariant 8) exists to prevent — so the restore refuses up front and changes
   nothing. An account matching the envelope (same name and broker) counts as "already back"
   and is reused.

**Invalidated if:** trash files gain their own encryption (then revisit snapshotting
credentials), or accounts gain rename history (then the name-conflict refusal needs a
smarter identity test).

## 2026-08-29 — v3.0.0 perf pass — 42-route sweep at 25k trades

**Context:** The pre-launch performance pass for v3.0.0, measured with the new harness (`npm run perf:seed` — a deterministic 25,000-trade book — then `npm run perf:sweep` — all 42 routes timed on the production build, with a console-error gate). Every number below is a sweep median at the 25k tier.
**Measured / found:**

| Route | Before (median) | After (median) |
|---|---|---|
| /cash (Cash & Ledger) | 27,313 ms | 901 ms |
| /corporate-actions | 1,645 ms | 654 ms |
| / (dashboard) | 1,873 ms | 1,312 ms |
| **Overall route median** | **1,195 ms** | **987 ms** |
| Budget breaches (of 42) | 13 | 6 |
| Console errors | 3 | 0 |

The /cash cause was NOT SQL: the page serialized a **113 MB SSR/RSC payload** (the full ledger, into the flight stream). Fix: sums and the running balance pushed into SQL, 200-row pages, export fetched on click (`tests/load` case `a7-cash-ledger` pins the class; the load suite is now 15 cases). A measured hazard shaped the payload work everywhere else: **adding WHERE clauses to the trades queries reorders `(sell_date, created_at)` ties**, so rows shift between runs and any row-for-row equivalence proof dies — which is why the trimming was done as **column projections, not filters** (projections were proven value-identical row for row against the untrimmed query). Remaining above the internal budget at this abusive tier, all payload-bound with no algorithmic defect found: options journal and strategies (~6 s — 8,058 option rows rendered), equity and risk (~3 s), trades and lenses (~2.2 s).
**Decision:** Budget = **median < 1,500 ms per route at the 25k-trade tier**, gated by `perf:sweep` (which also fails on any console error). The six breaching routes are deferred to v3.0.x as pagination work — they render everything they are handed; the fix is to hand them less, the same shape as the /cash fix, and it deserves its own tested pass, not a launch-night patch.
**Why not the obvious thing:** Filtering rows in SQL (WHERE) instead of projecting columns — the tie-reordering above means a filter cannot be proven output-identical, and a perf pass that changes what a page shows is no longer a perf pass.
**Invalidated if:** the v3.0.x pagination pass lands (re-run the sweep and supersede the six-route list), or the trades queries gain a deterministic total ordering (then filters become provable and projections are no longer the only safe tool).

## 2026-08-29 — Upstox reconciles across THREE contract notes; "STT-SQUP" makes settle-based STT industry practice

**Context:** Closing the Upstox live-pull file: three signed contract notes for 2026-08-28 (NSE-EQ 93306382, MTF 93323360, combined F&O 8340511) against the 5 committed rows that both the native pull and the OpenAlgo pull had produced identically.
**Measured / found:** Trades 5/5 to the paisa AND the fill time — including EBGNG's blended two-fill MTF average (621.88) and all three option round trips (the F&O note lists SENSEX as "OPTSTK BSX" under a BSE-FO section; one note covers both exchanges). Charges: brokerage EXACT on the delivery note (₹2.66 = the rate card); turnover within 4p; SEBI 1p; F&O STT **9.36 = exactly 0.15% of sell premium — the FOURTH broker document confirming the rate** (Dhan note, Angel note, and now Upstox × its own arithmetic), with a broker-side "STT-Round off" −0.36 showing Upstox rounds the note total where Vyuha rounds per row (₹1 granularity, not a rate difference). Upstox's own line item is named **"STT-SQUP"** — square-up STT — on the same-day-closed DELIVERY and MTF equity trades (0.33 and 0.78 vs our product-rate ₹3 and ₹6): the second broker charging by what settled, which upgrades the 2026-08-28 settle-based-STT finding from one broker's behaviour to industry practice. GST deltas are explained, not mysterious: contract notes exclude DP charges (a depository bill item) that Vyuha includes on delivery sells, and the rest follows brokerage.
**Decision:** The Upstox reconcile is COMPLETE and the "values INFERRED" era for Upstox is over on the API path (file-parser values remain inferred until a populated file export exists). The settle-aware STT refinement stays deliberately post-launch, now with two brokers' evidence waiting for it.
**Why not the obvious thing:** Patching STT before launch — unchanged from 2026-08-28: conservative direction, small magnitude, engine change deserves its own pass.
**Invalidated if:** the settle-aware STT rule ships, or a populated Upstox FILE export finally arrives (then retire the file-side INFERRED caveat separately).

## 2026-08-28 — Angel contract note 0061896174: trades 6/6 to the fill time; STT follows what SETTLED, not the product code

**Context:** The gate on v2.99.103 — Angel One's contract note for the 2026-08-27 live pull, against the 6 committed rows.
**Measured / found:** Trades are a perfect 6/6: every quantity, WAP, per-contract net (−422 / −420 / +3.78 / −4.80 / ±MOSCHIP) AND every entry/exit fill time matches the annexure. The annexure also shows the SENSEX contract as `BSXOPT SENSEX26AUG77600CE` under a summary line saying "Aug 27 2026" — the broker's own document carrying the symbol/expiry mismatch the adapter now codes around. Charges: exchange txn ₹2.52 vs ₹2.55, SEBI 1p, stamp 0=0. F&O STT re-confirms 0.15% of premium (SENSEX ₹2.65 = 0.15% × 1,768 exactly — Angel books paise where Vyuha rounds STT to the rupee, hence our ₹3; ICICIBANK ₹1.35 vs a computed ₹1.68 is unexplained, trade-wise levies available on request, not chased). **The real finding: equity STT is charged by what actually settled.** HFCL rode the DELIVERY product and WABAG the MARGIN (MTF) product, but both were squared off the same day — no delivery occurred, and Angel levied intraday STT (sell-side 0.025%, NSE-capital total ₹1.00) where Vyuha's segment-based engine charged delivery/MTF STT at 0.1% both sides (₹3 + ₹4). Same-day-closed delivery/MTF trades therefore OVERSTATE STT.
**Decision:** Recorded, deliberately NOT fixed in v2.99.103 — the direction is conservative (overstates costs, never flatters), the magnitude is paise-to-rupees, and a settle-aware STT rule is a charges-engine change that deserves its own test pass, not a release-night patch.
**Why not the obvious thing:** Patching the engine immediately — charging by segment is load-bearing for every FILE import too (where a delivery product usually does deliver), and the same-day-square-off case needs its own rule with its own tests, per invariant 3's discipline.
**Invalidated if:** the settle-aware STT rule ships (supersede this), or a broker note shows a same-day-squared delivery trade charged at delivery STT (then the rule is broker-specific and belongs in charge_config, not logic).

## 2026-08-27 — Angel One's trade book STATES the derivative facts — and its symbol lied about the expiry on a real contract

**Context:** The first Angel One pull ever to return fills (11 real executions, all four products, NFO/BFO/NSE/BSE), captured raw before fixing the adapter's known F&O-as-equity defect the same grounded way as Dhan's.
**Measured / found:** The row shape (previously INFERRED from docs) is now VERIFIED: `instrumenttype` (OPTSTK/OPTIDX), `strikeprice` (−1 equity sentinel), `optiontype`, `expirydate` ("29SEP2026") are all stated. Two facts symbol-parsing would get wrong: (1) `SENSEX26AUG77600CE` carried a STATED expiry of **27AUG2026** — the symbol's own date token disagrees with the contract's expiry, so parsing the symbol books the wrong expiry day; (2) `producttype: "MARGIN"` arrived on a real **MTF equity trade** — the old mapping sent MARGIN→null assuming it was the F&O carry product (F&O carry is CARRYFORWARD, confirmed in the same payload). Also: equity symbols carry NSE series suffixes ("HFCL-EQ") that no other source uses, and a real cross-exchange intraday pair (bought BSE, sold NSE) arrives as two one-sided positions — represented as such, not merged. Committed and verified end to end: 6 trades, options as index/stock_option with options-rate charges, WABAG as eq_mtf, gross P&L total −843.72 matching Angel's own UI to the paisa.
**Decision:** Canonical OPT/FUT names built from the stated fields (underlying recovered by stripping the stated strike+type suffix and a trailing date token); MARGIN→mtf; series suffixes stripped; incomplete stated facts keep the raw name and say so. The "known defective for Angel One" line from 2026-08-26 is DISCHARGED. Zerodha/Kite remains the one API puller with no real F&O payload.
**Why not the obvious thing:** Parsing the compact symbol (as the OpenAlgo adapter must, having no stated fields) — Angel states everything, and its own symbols proved unreliable on the expiry.
**Invalidated if:** SmartAPI renames these fields, or a payload shows MARGIN on an F&O row (then the product mapping needs an instrumenttype guard).

## 2026-08-27 — Contract note 14721318 reconciles the live pulls to −0.081%, STT to the paisa — and the engine's 0.15% options STT was RIGHT

**Context:** The final gate on the OpenAlgo/Dhan live-pull wave: Dhan's real contract note for 2026-08-26 (Raise Securities, note 14721318, 12 pages) against the 11 committed rows.
**Measured / found:** All 9 contracts match quantity and WAP to the 4th decimal (the note aggregates across products; our MIS+NRML splits sum to its figures exactly — e.g. 77400 PE 3,400 @ 55.8159 = our 2,840 @ 54.51 + 560 @ 62.44). Levies, ours vs note: STT **₹1,222.00 vs ₹1,222.00 exact**; SEBI ₹1.91 vs ₹1.90; exchange txn ₹530.93 vs ₹531.39 (−0.087%); stamp ₹28 vs ₹29 (rupee-rounded per row vs per note); IPFT 0=0. Non-brokerage levies overall **−0.081%** — well inside the 0.69% claim. Brokerage ₹380 (flat config) vs ₹2,980 (Dhan charges per executed order — 206 fills) — excluded from the claim by design, and the GST gap is entirely brokerage-driven. **The note also settles yesterday's STILL OPEN question: F&O STT levied = 1,185.00 on 789,765.92 of pre-brokerage sell premium = exactly 0.1500%** — the engine's `charge_config` rate was correct and the "statutory 0.1%" recalled from training data was stale. Supersedes the STILL OPEN line in the 2026-08-26 entry below.
**Decision:** The OpenAlgo claim-hold condition (owner, 2026-08-20: "no copy may say OpenAlgo works until a live pull is reconciled against a contract note") is DISCHARGED. Charge rates stay exactly as configured.
**Why not the obvious thing:** "Correcting" the STT rate to the remembered statutory figure two days ago would have broken an exact-to-the-paisa match — this is why invariant 3 forbids rates from memory.
**Invalidated if:** a Budget changes STT again (update `charge_config`, never code), or a second broker's note disagrees with these rates.

## 2026-08-27 — `npm run verify` while `next dev` runs poisons `.next`: the browser silently serves stale production chunks

**Context:** A verified fix (the broker form echoing saved OpenAlgo config) "didn't work" after two reloads in the user's browser, and the same page in a fresh session showed no client hydration at all.
**Measured / found:** The production build inside `npm run verify` writes into the same `.next/` the running Turbopack dev server serves from. Pages loaded afterwards referenced `webpack-hmr` endpoints under a Turbopack server — the tell — and carried client bundles from BEFORE the fix, with no error anywhere: the page renders, hydrates old code, and reloading does not help because the stale chunk files still exist on disk. Confirmed by wiping `.next/` and restarting: same source, correct behaviour.
**Decision:** During live dev-server sessions, stop the server before `npm run verify`, then wipe `.next/` and restart it. Diagnosed twice in one night before the pattern was recognised.
**Why not the obvious thing:** Trusting a reload (or even a hard reload) to fetch fresh code — the stale chunks are real files with valid names, so the browser gets 200s for all of them.
**Invalidated if:** dev and build output are separated (`next dev` gains a distinct dist dir, or verify builds into a temp dir).

## 2026-08-27 — A risky cross-source collision now BLOCKS a broker-API commit behind an explicit confirmation

**Context:** Pulling the same Dhan trading day twice — once natively (positions) and once through OpenAlgo (fills) — put the same SENSEX 78200 CE trade into the journal twice, silently, inflating the day's P&L headline by ₹5,402.
**Measured / found:** The two sources agreed to the rupee everywhere but hashed apart on ONE paisa of buy value (₹4,36,567.00 from summing 89 fills vs ₹4,36,567.01 from qty × Dhan's 5-decimal average) — so `dedupHash` correctly saw different rows, and the existing cross-source detector (`lib/import/cross-source.ts`) flagged it exactly (same-quantity kind), but the broker-API route never consulted it. Verified live: preview and commit now surface the report, and a risky commit returns 409 + a dialog whose only "Commit anyway" button re-posts with `force:true`. Same-day-same-symbol overlap under a DIFFERENT broker is a new, separate check (`detectCrossBrokerEchoes`) that only informs — two brokers are two books. Also observed: the route's UTC-derived trade date rolls at 05:30 IST, before market open, so it always names the correct Indian trading day — accidental but correct; left as is.
**Decision:** Preview runs in both modes in the broker route; risky collisions 409 unless `force:true`; the paisa tolerance stays out of `dedupHash` itself.
**Why not the obvious thing:** Rounding or tolerancing the dedup hash — that trades a visible, confirmable near-miss for silent false-positive merges everywhere else, and same-source re-pulls already dedup exactly.
**Invalidated if:** `dedupHash` inputs change, or the broker route stops being the only API-pull commit path.

## 2026-08-27 — One OpenAlgo instance per broker: connections are `openalgo:<broker>` rows, and the form never represents saved state

**Context:** The owner runs TWO OpenAlgo instances on one machine (Upstox on :5000 for another project, Dhan on :5051 for Vyuha) — the single `openalgo` connection id could hold only one, and the connect form showed default host/broker over a saved 5051/Dhan config after reload.
**Measured / found:** The stale form was genuinely dangerous, not cosmetic: one innocent "Update connection" with the defaults would have silently repointed Dhan-stamped pulls at the Upstox instance. And host/underlying-broker are config, not credentials — there was no reason not to display them.
**Decision:** Each instance is its own `broker_connections` row, `openalgo:<underlying>` (legacy bare `openalgo` migrated on GET, same pattern as the plaintext sweep); GET echoes each instance's host + broker; the UI renders an instance LIST with per-instance pull/disconnect buttons, and the form only adds/updates an instance. One instance per underlying broker per account.
**Why not the obvious thing:** A schema migration for a new instances table — the (account, broker) unique key already provides identity and upsert; only the id vocabulary needed widening.
**Invalidated if:** someone genuinely runs two instances for the SAME broker on one account (not supported; the second save updates the first).

## 2026-08-26 — EVERY broker-API puller classified F&O as equity: the classifier reads only canonical names, and no API sends them

**Context:** First live API pull that ever returned F&O fills (Dhan positions, 11 rows, real money) — found on the day-one live test, in every shipped build since the API pullers existed.
**Measured / found:** `parseInstrumentName` reads only the file-canonical `OPT SYM DD Mon YYYY STRIKE CE` / `FUT …` shape. Dhan's API sends `SENSEX-Aug2026-78200-CE`, OpenAlgo sends `SENSEX27AUG2677400PE`, Kite/Angel send their own compact forms — all fell to the equity branch: options charged equity STT (₹207.67 vs the correct ₹1,042.40 on one 7,040-qty SENSEX round trip — wrong in BOTH directions per row), segment `eq_delivery`, invisible to options analytics, open options nagging as unmarked equity "holdings". Fixes are grounded in captured real payloads: Dhan canonicalises from its STATED `drvExpiryDate/drvStrikePrice/drvOptionType` fields (sentinels `0001-01-01`/`NA`/`0` on equity rows); OpenAlgo gates on the stated exchange (NFO/BFO/MCX) and parses its documented compact form; a derivative row whose facts are incomplete keeps its raw name AND says so. Kite and Angel One remain DEFECTIVE for F&O — no real F&O payload exists to verify against, recorded here rather than guessed.
**Decision:** Canonicalisation lives per-adapter from stated facts (the same convention as `angelone-taxpnl.ts`), never in the classifier from symbol shape.
**Why not the obvious thing:** Teaching `parseInstrumentName` the compact shapes — shape-without-exchange is exactly the "a broker-named parser must see the broker's NAME" lesson again: `PONNIERODE` ends in CE too. The exchange is the stated fact; the shape only fills in details.
**Invalidated if:** a populated Kite or Angel One F&O payload arrives (fix them the same way, then delete the "remain defective" sentence above), or classify grows exchange-aware parsing.

## 2026-08-26 — OpenAlgo live pull reconciles to the rupee, one corrupted row REFUSES itself, and Dhan states the mark for open positions

**Context:** The first live OpenAlgo pull (self-hosted instance on :5051, Dhan behind it, 206 real executions) and the first Dhan-native pull with real fills, cross-checked against each other and against Dhan's own dashboard.
**Measured / found:** All 11 aggregates matched the native pull to the paisa (qty and value), the MIS/NRML product split survived, and totals matched Dhan's dashboard exactly (unrealised −2,532.50; Dhan's "realized" −7,008.52 = Vyuha's GROSS −7,009 — Dhan's figure is pre-charges). OpenAlgo's documented zero-quantity trap did NOT occur on the Dhan plugin (206/206 real quantities), but its `timestamp` is a full datetime against the docs' time-only sample. One genuine corruption: OpenAlgo relabelled a PIIND 2600 CE buy as `SILVERM23NOV26236750PE` on NFO — right numbers, wrong identity. The charges engine itself proved why such a row cannot be imported: commodity_option/NSE has no `charge_config` row and never will (it threw, initially surfacing as a bare 500). Open positions: Dhan's payload has no LTP but states `unrealizedProfit`, and entry ± unrealised/qty reproduced Dhan's displayed LTPs exactly (1.30 / 2.90 / 38.25) — stored as `closingPrice`, so open positions import already valued.
**Decision:** An underlying/exchange conflict (commodity on NFO/BFO, index on MCX) REFUSES the row with a warning naming it; engine refusals in the broker route return 422 messages, never 500s; the mark derivation is stated-fact algebra, kept. STILL OPEN: the engine charges sell-side options STT at 0.15% of premium where the statutory rate is believed 0.1% (₹648 vs ₹432 on a ₹4.32L sell) — deliberately NOT corrected from memory; the contract-note reconcile decides it.
**Why not the obvious thing:** Importing the corrupted row loudly-but-anyway (the first implementation) — there is no honest charge profile for a wrong identity, and the engine's refusal to invent one is the invariant working as designed.
**Invalidated if:** OpenAlgo fixes its Dhan symbol mapping upstream, Dhan's positions payload gains an LTP field, or the contract note settles the STT rate (then update `charge_config` and supersede this entry's STILL OPEN line).

## 2026-08-25 — A native HTML constraint can pre-empt the engine's designed refusal: Book-exit's `max=0` dead end

**Context:** A real user hit an unexplained dead end booking an exit on a fully closed staged position (SG Finserv, buy 600/sell 600 — verified in the live desktop DB): the 25/50/100% shortcuts appeared to do nothing and every typed quantity was refused with the browser-native bubble "Value must be 0."
**Measured / found:** The engine was right (0 open is the truth) and the panel's design rule — actions are never disabled by position state; the ladder refuses with a clear message — was already in place. What broke it was `<Input min="0" max={openQty}>`: at `openQty=0` the browser's constraint validation blocks form submission BEFORE the server action runs, so the ladder's message became unreachable, and `fractionOf(0, f)` made the shortcuts write nothing visible. The dialog also lacked the closed-state banner its Add-entry sibling already had.
**Decision:** Inside `BookExitDialog` only: a closed-position banner naming the two real paths (Add entry re-opens; delete the wrongly-booked exit leg and re-book reality), shortcuts hidden at 0 open, `max` dropped at 0 open so a determined submit reaches the ladder's own refusal. Submit stays enabled — the panel warns, it does not decide. Pinned in `e2e/staged-position.spec.ts`.
**Why not the obvious thing:** Disabling the submit button would repeat the exact UI-opinion block that the "never disables an action" test exists to forbid; and keeping `max=0` "for safety" is not safety — it replaces a designed, specific message with an unactionable browser bubble.
**Invalidated if:** the staged panel gains client-side ladder replay, or the form moves off native constraint validation entirely.

## 2026-08-24 — A frozen `--today` freezes only the caller: the sell-flow suite passed for exactly one day

**Context:** `npm run verify` failed on 2026-08-24; `tests/sell-flow.test.ts` (written 2026-08-23) had 2 of 11 failing.
**Measured / found:** `sell.mjs --today 2026-08-23` pins only sell.mjs's own outputs (receipt year, ledger note, backup-name prediction) — the SPAWNED `license-issue.mjs` and `license-backup.mjs` keep real time. So the minted expiry came out `2027-08-24` against a hardcoded `2027-08-23`, and sell.mjs verified/renamed a bundle named from the frozen date while the child wrote the real-date name (`vyuha-keys-2026-08-24.vkb`), making the post-backup existence check fail and the same-day-rename guard rename nothing.
**Decision:** sell.mjs now derives the bundle path from the same real-clock expression license-backup.mjs uses (`new Date().toISOString().slice(0,10)`, its line 94); the tests derive every expected date from the ledger's actual minted values — expiry asserted as shape + 360–370-day horizon, renewals probed at expiry−100d / −22d / +9d, `.vkb` names matched by pattern.
**Why not the obvious thing:** plumbing `--today` down into `license-issue.mjs`/`license-backup.mjs` would put a clock-override into the two production scripts that mint and archive real keys — a test convenience is not worth a path that can backdate a licence.
**Invalidated if:** the mint or backup scripts ever gain a legitimate date parameter, or sell.mjs stops spawning them as child processes.

**Read this before changing a constant that looks arbitrary, or before
re-measuring something.** An odd value with an entry here is a landmine with a
sign on it.

Never edit an old entry to match new reality — append a new one that supersedes
it and say which. A changed mind is itself information.

Format:

```markdown
## <date> — <short claim, stated as the fact>

**Context:** what was being done, in one sentence.
**Measured / found:** the actual numbers or observations, with the method.
**Decision:** what we chose.
**Why not the obvious thing:** the alternative and why it loses.
**Invalidated if:** the condition under which to revisit this.
```

---

## 2026-08-20 — `winget-manifest.mjs` hashed the LOCAL installer while pointing InstallerUrl at the GitHub asset; `--sha` is now required

**Context:** Doing the release-day winget work for v2.99.99, immediately after establishing that the release asset and the locally built installer are different binaries.
**Measured / found:** `scripts/winget-manifest.mjs` set `installerUrl` to the GitHub release download URL (line 53) but defaulted `sha` to `createHash("sha256")` over `src-tauri/target/release/bundle/nsis/` — the LOCAL build (line 66) — justified by an inline comment reading "identical, since the same build produced both". **That comment is false.** Downloaded and hashed both for v2.99.99: the published asset is **34,861,983 B / `46A3842ADD7B91A65F493330B8FAAEE0A1B06A2DA76A52DBFBA4CB6C74EB4343`**, the local build (and the copy inside the client ZIP) is **34,860,149 B / `27D8695E863D3426DE4016C86002C6A148E2F1A1E1457838A11835621BB23004`**. Same mismatch on v2.99.98 by size (34,857,616 vs 34,857,374). So `npm run winget:manifest` with no flags emitted a manifest whose `InstallerSha256` could not match its own `InstallerUrl`. The winget-pkgs validation pipeline downloads that URL and verifies the hash, so the PR fails; had one ever merged, `winget install` would fail hash verification for every user. **Nothing had been submitted yet, so no bad manifest ever reached Microsoft** — the defect was found before its first use.
**Decision:** Delete the local-file fallback outright. `--sha` is REQUIRED, and running without it exits 1 printing the exact `gh release download` + `sha256sum` recipe for the current version. Verified both paths: bare invocation refuses with that message; `--sha 46A3842A…` writes a manifest whose URL and hash agree. `WINGET_AND_SMARTSCREEN.md` gains a "Which file?" table at the top, and DOC_AUDIT rows 15/16 now name which binary each release-day action targets, with a new row 20 for the distinction itself.
**Why not the obvious thing:** Making the script download the asset and hash it automatically — more convenient, but it adds a ~35 MB fetch and a `gh` dependency to a script that has neither and currently runs offline. Keeping the fallback "as a default that is usually right" — it is never right, and a wrong hash is worse than a missing one because the manifest looks finished. Following the docs-only scope of the task that surfaced this — the docs cannot be made correct while the tool they document produces a broken artefact.
**Invalidated if:** the release workflow stops rebuilding and uploads the locally built artefact instead (then the two collapse into one file and the fallback would become safe — but re-measure before trusting it), or winget-pkgs stops verifying `InstallerSha256` against the downloaded URL.

## 2026-08-23 — Simulation testing: a known 10,028-fill book rendered as five broker formats is recovered exactly by every parser, and all five agree — five test failures along the way were all the TEST being wrong

**Context:** The owner asked for "simulation testing for broker files" and rigorous load testing before a release. Fixture tests already proved every parser survives a real layout; none proved a parser gets the NUMBERS back. `tests/sim/` is a deterministic book generator (`book.ts`) plus one writer per verified layout (`writers.ts`, built byte-for-byte from `docs/BROKER_FORMATS.md` and the redacted real-export fixtures), run through the REAL `detectParser` route so a layout drift fails as "wrong parser chosen" — the failure a user would see.
**Measured / found:** At 120 / 1,500 / 10,028 fills, every parser conserved buy and sell QUANTITY exactly and VALUE to the paisa: Zerodha Console (10,028 fills → 4,504 positions, fill times read), Dhan GTR (8,717 scrip-day bills → 4,504 positions, 179 mixed days split from stamp duty, stated charges carried), Paytm tradebook (numeric codes kept with ISIN, product derived from the day's STT/stamp signature), Groww orders (price derived as Value/Quantity), Angel One tax P&L (1,183 stated rows, none dropped; MTF read from Qty Breakup), and the generic mapper. **Cross-format agreement:** the same book yielded 4,504 positions with identical `symbol|buyQty|sellQty` signatures from Zerodha, Groww and the generic mapper, and zero per-symbol quantity mismatches against Dhan across 40 symbols; all four found the same 5 opening sells. **Five failures on the way, all in the test, none in the code:** (1) asserting `avgBuyPrice × buyQty == buyValue` — that is the recomputation AGENTS.md invariant 1 forbids; prices are rounded levels, value is exact, and it was off by 22 paise on a 3-tranche lot; (2) assuming Angel One's MTF Qty applies to holdings only — the parser correctly applies the per-ISIN breakup to every row it covers; (3) asserting Groww "invents no charges" — it ESTIMATES from the rate card and says so in a warning, which invariant 6 permits; (4–5) vitest's 5 s default timing out a 10k-row XLSX round-trip. Full load suite 34 passed / 1 expected fail (B7 pin) across 14 files; `npm run verify` EXIT 0, 1,956 tests / 133 files. Upstox is deliberately absent: its value behaviour is still INFERRED from zero-row exports, so a generator would test a guess against itself.
**Decision:** `tests/sim/` is part of `npm test` (24 cases, ~30 s at the large size, timeouts scaled per book). No production code changed — and that is the finding worth keeping: the import pipeline recovers a known book exactly at 10k rows across every verified format, proven by conservation rather than by "did not crash". No release is cut from this pass on its own because there is nothing to ship; the version question is decided by the owner with these numbers.
**Why not the obvious thing:** hand-written expected outputs per broker — they drift from the layout the first time a column moves, which is how the Groww-as-Zerodha misdetection happened (2026-08-12); generating from one book makes the expectation the book itself. Loosening the failed assertions until green — each failure was a real lesson about an invariant, and two of them (1, 3) are now documented in the test where the next person will meet them.
**Invalidated if:** a populated Upstox export arrives (add its writer, the INFERRED values become testable), or `pairLegs` grows a fill-level mode (the Dhan per-symbol comparison assumes scrip-day aggregation).

## 2026-08-22 — Defender flagged an INSTALLED v2.99.100 as `Trojan:Win32/Bearfoos.B!ml` (Severity 5); nothing reproduces on a static scan, and India cannot buy the cheap signing fix

**Context:** The owner updated v2.99.99 → v2.99.100 through the in-app updater. Windows Security reported a SEVERE risk and blocked/quarantined it. The same update had installed cleanly on another user's machine, more than once.
**Measured / found:**
- Detection name **`Trojan:Win32/Bearfoos.B!ml`**, `SeverityID 5`. The **`!ml` suffix means a MACHINE-LEARNING verdict**, not a signature match.
- It named `%LOCALAPPDATA%\Vyuha\vyuha.exe` **plus** the Start Menu shortcut, the Desktop shortcut, the `Uninstall` registry key and the `startup:` entry — a **behavioural** verdict on the install action, not a file-content match.
- **The install SUCCEEDED first.** The installed `vyuha.exe` is present (14,169,088 B, FileVersion 2.99.100, written 17:09); the detection is timestamped 23:11 — hours later, from a scan or on execution, not at install time.
- **Nothing reproduces on a static scan** at definitions `1.457.274.0` / engine `1.1.26070.7`: the LOCAL installer, the LOCAL `src-tauri/target/release/vyuha.exe`, the **GitHub-built** v2.99.100 installer (downloaded fresh, SHA-256 `B84614E8…F299A`) and the GitHub-built v2.99.99 installer ALL scan "found no threats".
- A hypothesis that the CI-built binary trips the model while the local one does not was **tested and disproved** — both scan clean.
**Assessment (not certainty — Microsoft's model cannot be audited from here):** a machine-learning false positive on a brand-new unsigned binary with no reputation. Four independent supports: the `!ml` suffix, no static reproduction on current definitions, no detection on a second machine, and `Bearfoos` being a known generic ML family that fires on new unsigned installers. **The plausible trigger is the architecture itself:** the installer drops an app that bundles `node.exe` and spawns it as a sidecar, writes to AppData, and creates startup shortcuts and uninstall keys — an unsigned executable writing and launching another executable is close to a textbook dropper profile.
**Decision:** (1) **WDSI is now the right tool and yesterday's deferral is SUPERSEDED** — the 2026-08-21 entry deferred it because the required `Detection name` field had no honest value; it now has one. Submit BOTH binaries (client-ZIP installer and GitHub asset — different files, separate reputation). (2) **v2.99.100 stays published.** The owner's only two paying customers are close friends who are untroubled, there is no public download link (delivery is manual mail/WhatsApp), and the detection does not reproduce. Demoting to prerelease was considered and rejected as churn that protects nobody who currently exists. (3) **The real deadline is the winget merge** — once `winget install ThejeshK.Vyuha` is public, strangers install unattended and a Trojan warning reaches someone with no reason to extend goodwill. (4) `bundle.publisher` was unset and is now `"Thejesh K"` — free, and an unsigned binary with NO publisher name scores worse than one with consistent publisher metadata.
**Why not just buy a certificate — the numbers, researched 2026-08-22:**
- **Azure Trusted Signing (now Azure Artifact Signing), $9.99/mo Basic — NOT AVAILABLE.** Individual developers must be in the **US or Canada**; organisations are limited to US/Canada with three years of verifiable history. India is not supported and Microsoft has published no timeline. **This is the option `.github/workflows/release.yml` is already wired for** (`trusted-signing-cli`, dormant until `AZURE_*` secrets exist) — the prepared path is the one that cannot be used.
- **EV code signing** ≈ **$279–297/yr** (Sectigo via resellers) to **$419–560/yr** (DigiCert). **Critically: EV lost its special status in 2020** — signed binaries no longer get instant SmartScreen reputation and now accrue it like any other Authenticode certificate. The historical reason to pay the EV premium no longer exists.
- **IV (Individual Validation)** is the correct product category here — built for independent developers, **no business documents**, personal ID validation, 3–5 days.
- Since June 2023 all code-signing keys must live on **FIPS 140-2 hardware** (USB token or cloud HSM), so CI signing needs a cloud-signing service, not a file. From **Feb 2026** certificate validity is capped at ~459 days.
- **What signing actually buys:** reputation attaches to the **CERTIFICATE**, not to each file hash. With 61 tags there have been 61 cold hashes; signing collapses that to one accruing identity. It **reduces** ML false positives substantially but does **not** eliminate them for a new binary — the first signed release still starts with an unproven certificate.
**Invalidated if:** Azure Artifact Signing opens to India (then it is £-for-£ the obvious choice and the CI is already built for it), or Microsoft restores instant reputation for EV (then the EV premium becomes worth paying again), or a detection ever reproduces on a static scan of a released artifact — that would mean this entry's assessment is wrong and the build itself needs auditing.

## 2026-08-21 — The pairing engine was QUADRATIC on a single symbol: three O(lots) scans per sell, now a forward-only head pointer plus a per-date index

**Context:** The v2.99.98 rewrite of `lib/import/pair-legs.ts` (single pass → two) landed five days AFTER the load suite was written, and an import-graph scan of all thirteen existing cases found that **none of them import that module** — so the most algorithmically significant change in the import path had never been measured. It is the hot path for five sources: Zerodha, Paytm Money, Dhan GTR, Groww orders and the generic column mapper. Built `tests/load/c8-pairing-depth.load.ts` to close that gap.
**Measured / found:** the cost of a sell was proportional to the number of OPEN LOTS, not to the number of legs, because each sell ran **three separate O(lots) scans**: (1) `for (const lot of lots)` walking the whole queue to find same-day lots, (2) `lots.some(...)` **and** `lots.find(...)` re-scanning from the head on every iteration of the oldest-first `while`, and (3) a reverse `splice` compaction to drop exhausted lots. When buys outnumber sells the queue grows without bound, so the walk is O(n²). Growth ratios at 4n (linear ≈ 4, quadratic ≈ 16), measured with `growthRatio`:
- one symbol, 65% buys — 8,000 → **79 ms**, 32,000 → **1,249 ms**, ratio **15.89×**; per-item 9.82 → 39.03 µs, i.e. per-item cost quadrupled when n quadrupled.
- one symbol, opening-sell heavy (25% buys, forces the pass-2 seed) — 14,000 → 70 ms, 56,000 → 937 ms, ratio **13.32×**.
- many symbols (500) — 24,000 → 26 ms, 96,000 → 109 ms, ratio **4.19×**, per-item flat at 1.10 → 1.14 µs. **The realistic book was never affected**: work partitions per symbol.
**Decision:** two indexes over the SAME `Lot` objects, so mutation is seen through both. `head` is a forward-only pointer to the oldest lot that may still hold quantity — lots are only ever emptied, never refilled, and the oldest-first pass always takes the first non-empty lot, so it never looks back; this replaces the `splice` compaction entirely. `byDate` maps each date to its lots in push order with its own head, so the same-day pass visits one day's lots instead of the queue. The seeded opening lot is deliberately NOT date-indexed: it pre-dates the file and must never satisfy a same-day match. **Selection is unchanged** — the head walk returns exactly what `lots.find((l) => l.qty > 0)` returned, and exhausting the queue ends the loop exactly where `lots.some(...)` did.
**Result:** ratios **15.89 → 3.70** and **13.32 → 4.10**; 50,000 legs on one symbol **775 ms → 63 ms** (15.49 → 1.25 µs/item) producing byte-identical output — 28,269 positions, 22,559 closed / 5,710 open / 0 opening-sell, quantity delta exactly 0, value drift ₹3.29 on ₹1,503,883,618 both before and after. Behaviour proven unchanged by 1,920 unit tests across 131 files AND both real-file reconciliations running (not skipping): Paytm's 414 executions against Paytm's own Realized P&L Detail, and the 1,554-fill Zerodha Console tradebook.
**Why not the obvious thing:** leaving it as an `it.fails` pin the way B7's double-decode is — defensible for a parser inefficiency, but this one silently degrades a *correctness-critical* engine as a user's history grows, which is exactly the "still works after months of data" property the product sells. Compacting the array less often instead of not at all — still O(lots) amortised, and the head pointer is simpler. Keeping `splice` to bound memory — the queue is bounded by leg count anyway, and trading a few thousand dead objects for removing an O(n²) is obviously right.
**A second, smaller finding:** the first version of C8's conservation test asserted an ABSOLUTE ₹1 bar on value drift and failed at ₹3.29. That was the test being wrong, not the engine: a float64 sum over 50,000 legs totalling ₹1.5 billion drifts a few rupees by IEEE-754 alone. The assertion is now RELATIVE — value conserved to within one part in a million, against a measured 2.19 parts per BILLION. Quantity stays an exact `toBe(0)` because quantities are integers.
**Invalidated if:** `pairSymbolLegs` gains a path that refills a lot or consumes out of order (the head pointer's forward-only assumption breaks), or the same-day rule stops being "first, in push order".

## 2026-08-20 — The installer buyers run and the installer on GitHub are DIFFERENT binaries; SmartScreen reputation is per hash, so they earn it separately

**Context:** Deciding which file to submit to Microsoft (WDSI) and which hash winget should carry, while cutting v2.99.99.
**Measured / found:** `.github/workflows/release.yml` triggers on a tag and rebuilds through `tauri-apps/tauri-action@v0` on its own runner matrix, producing a **draft** release. `npm run client:package` instead zips the installer built LOCALLY by `npm run desktop:build`. These are not the same file: for the already-published **v2.99.98**, the GitHub asset `Vyuha_2.99.98_x64-setup.exe` is **34,857,616 bytes** and the local build in `release-packages/Vyuha_2.99.98_Client_Package.zip` is **34,857,374 bytes** — a **242-byte** difference, so necessarily different SHA-256s. Both are validly signed: every `.sig` checked carries `4FF85F3BBE1DA21D`. The delivery model is manual mail/WhatsApp of the client ZIP, so **the binary a paying buyer actually runs is the LOCAL one**, which never touches GitHub.
**Decision:** Treat the two as separate reputation subjects. The **WDSI false-positive submission must use the installer from the client ZIP** — that is the file buyers double-click — and the winget manifest necessarily references the GitHub asset and its own hash. `CHECKSUMS.txt` inside the ZIP is generated from the local file and is correct for it; do not "fix" it against the release asset. Record both hashes in VYUHA-STATE per release so the two are never confused.
**Why not the obvious thing:** Assuming one release = one binary, and submitting whichever hash is easiest to copy — that spends the submission on a file no buyer runs, and every buyer still meets a cold SmartScreen warning. Also rejected: uploading the local installer onto the tag to make them identical — never re-upload assets onto a published tag (the updater compares version numbers, so an existing install is never re-offered the same version, and the ZIP's CHECKSUMS.txt is per file hash).
**Invalidated if:** the release workflow is changed to upload the locally built artifact instead of rebuilding, or delivery moves from mailed ZIP to a GitHub download link — either collapses the two files into one and this entry stops applying.

## 2026-08-20 — Signature key ids can be decoded from the local .sig BEFORE publishing; `release:verify` only works on a tag that already exists

**Context:** The release skill's step 5 says "verify by decoding the signature's key id, never by trusting ✓ signed" — the stale v2.91.0 key produced signatures the build called valid while every installed copy rejected the update (v2.98.0). But `npm run release:verify` takes a TAG and reads assets off the GitHub release, so at the moment the local build finishes there is nothing to run it against, and `tauri-build` prints exactly the adjective the skill warns about: "✓ Vyuha_2.99.99_x64-setup.exe is signed (.sig present)".
**Measured / found:** A Tauri updater `.sig` is base64 of a minisign file. Base64-decode it once to get `untrusted comment: …
<base64 signature>`; base64-decode that second line to a 74-byte buffer laid out as **2-byte algorithm, 8-byte key id (little-endian), 64-byte signature**. Reversing bytes 2–10 and hex-upper-casing yields the key id. On the v2.99.99 artifacts both the NSIS `.exe.sig` and the MSI `.msi.sig` decode to **4FF85F3BBE1DA21D**. The public half in `.secrets/vyuha-updater.key.pub` decodes to the comment `minisign public key: 4FF85F3BBE1DA21D` and its base64 is **byte-identical** (`===`) to `plugins.updater.pubkey` in `tauri.conf.json`. The stale key is `8FFAF1B491EAD2F0`; no copy of `updater-private.key` exists in the repo root (deleted 2026-08-14, confirmed still absent).
**Decision:** Decode the key id off the LOCAL `.sig` files immediately after `desktop:build`, before committing — a ten-line Node snippet, no network, no tag. `release:verify <tag>` still runs after the Release workflow as the second, asset-level check. The two are complementary, not redundant: the local one gates the tag, the remote one gates publishing.
**Why not the obvious thing:** Trusting the build's "✓ signed" line — it asserts a `.sig` exists, not whose key made it, which is precisely the failure that shipped v2.98.0. Waiting for `release:verify` — by then the tag is pushed and the Release workflow has already built and uploaded assets, so a wrong key is discovered after the expensive half.
**Invalidated if:** the updater key is rotated (then both the expected id here and `tauri.conf.json` change together — the check is the comparison, not the literal), or Tauri changes the `.sig` envelope away from base64-wrapped minisign.

## 2026-08-20 — No runtime surface exposes Vyuha's patch version; the sidebar shows major-minor only, and the install guide claimed otherwise

**Context:** Bumping every buyer-facing version string to v2.99.99 for the release. `docs/client/INSTALLATION_GUIDE.md` § Support told buyers to quote their version "shown at the bottom of the sidebar, e.g. `Local · Offline · v2.99.98`".
**Measured / found:** `components/layout/sidebar.tsx:392` renders the literal string `Local · Offline · v2.99` — major and minor only, no patch, and not derived from `package.json`. A grep across `app/`, `components/`, `lib/`, `src-tauri/src/` and `scripts/desktop-server.mjs` for `npm_package_version`, `getVersion()` and `package_info` returns **nothing**: the running app never displays its own patch version anywhere. **CORRECTION appended 2026-08-21:** this entry originally claimed `scripts/bump-version.mjs` does not sync the sidebar footer, and that AGENTS.md was stale on the point. **That was wrong.** It does sync it (`bump-version.mjs:76`), but the footer is MAJOR.MINOR only, so a patch bump is a no-op and the script prints three files instead of four — which is what was misread. The v3.0.0 bump printed `sidebar.tsx footer -> v3.0` and "Synced 4 file(s)". What remains true, and is the actual point of this entry, is that **no runtime surface shows the PATCH version**: the footer reads `v3.0`, never `v3.0.0`, so the install guide still must not send buyers there for a full version string.
**Decision:** The install guide now points at two places that genuinely carry the full version — the installer filename (`Vyuha_2.99.99_x64-setup.exe`) and Windows **Settings → Apps → Installed apps** — and describes the sidebar honestly as showing the release line `v2.99`. The sidebar itself is NOT changed: it is a deliberate one-line footer, and wiring a build-time version into a client component to satisfy a support instruction is a bigger change than the problem.
**Why not the obvious thing:** Bumping the example string to `v2.99.99` with the rest of the release — that is what the last several releases did, and it kept a sentence false in a document that ships inside the buyer's ZIP. A support instruction that sends a buyer to a screen which cannot answer the question costs a round-trip every time it is followed.
**Invalidated if:** a version string sourced from `package.json` is surfaced in the app (Settings → About, the Help Desk footer, or the sidebar gaining the patch digit) — then point the guide at that instead.

## 2026-08-20 — OpenAlgo ships OFF behind a versioned disclosure: two settings columns, a server-enforced gate, and consent in the Audit Log

**Context:** Adding OpenAlgo (third-party, self-hosted, AGPL-3.0, fronts 35 Indian brokers) as a fourth broker-API import source — the first Vyuha feature that asks the user to run a SECOND program and give IT their broker credentials. Owner's requirement: the user activates it themselves, after an in-app explanation of what it is, what it does and what the risks are.
**Measured / found:**
- Verified against OpenAlgo's own docs (2026-08-20): `POST /api/v1/tradebook` with an `apikey` body, `{status:"success", data:[…]}` envelope, **current trading day only**, and the documented sample really does return `quantity: 0.0` on a filled trade with `average_price: 1180.1` / `trade_value: 1180.1`. Their published broker list covers 7 of Vyuha's 8 (**no Sahi**), which is what the adapter's table already states.
- The app already had the right precedent for an opt-in network feature: `auto_mtm_enabled` — off by default, a Switch in Settings, the overwrite risk named in place. This is that pattern plus an explicit acceptance, because the risk is larger.
**Decision:**
- **Two columns, not one** (`settings.openalgo_enabled`, `settings.openalgo_ack_version`, migration 0049, hand-written + journal entry): "never asked" and "asked, then turned off" are different states, and the ack stores WHICH disclosure version was accepted, so a materially changed risk statement re-prompts instead of inheriting an old consent.
- **The gate is one pure function** (`openAlgoGate` in `lib/domain/openalgo-disclosure.ts`) requiring BOTH halves, and the **server applies it** on save and on pull (403), not just the UI. Hiding a tab is a UI convenience; it must never be the only thing between an unread disclosure and a stored credential.
- **All disclosure copy lives in that one pure module**, versioned, and is rendered by the dialog, the Settings card and the Import blurb. Copy written twice drifts — the dropzone hint did exactly that (2026-08-12) and advertised three brokers while the code read five.
- **Consent is recorded in the Audit Log** with the disclosure version when the stored value changes, so there is a dated record independent of the UI.
- **Both columns are `SETTINGS_MACHINE_COLUMNS`** (redacted from every backup, re-applied from this machine on restore) and are **excluded from `BASELINE_SETTINGS_FIELDS`**: restoring a journal — or clicking "back to my defaults" — must never switch an integration on or assert a consent the user did not give.
- **Enable/disable persists immediately**, not on the form's Save button: an accepted disclosure lost to an unpressed Save would re-prompt forever. The card says so.
- **A redacted NOT NULL column carries its SAFE value, not null.** Every machine column until now was nullable, so redaction wrote null; `openalgo_enabled` is NOT NULL DEFAULT false, and blanking it to null made the restore INSERT violate the constraint — `restoreDatabase` returned `{ok:false}` and nine backup round-trip tests failed at once. `settingsMachineBlank()` now maps a machine column to its blank (null by default, `false` for the gate), and a test pins both halves: a forged envelope claiming the integration was on and accepted restores successfully AND leaves it off.
- A **non-loopback host warns before saving** (`isLocalOpenAlgoHost`, conservative — a LAN IP counts as remote): "nothing leaves your computer" is the product's promise, and this is the one feature that can make it false.
**Why not the obvious thing:**
- A plain Switch with the risks printed on the card (the auto-MTM shape) — cheaper, but it leaves no record that the user was told, and no way to re-ask when the risks change.
- Storing consent in `localStorage` via `use-stored-value` — a browser-data clear would silently revoke the record while the credential stayed.
- Storing the flag inside the `broker_connections.auth_json` blob (which is what the handoff brief's "do NOT create a migration" implied) — then "enabled but not yet configured" has no home, and the Settings switch would have to fabricate a credential-less connection row. **Deliberate deviation from the brief**, recorded here: the brief's rule was about `broker_connections`; an opt-in flag is a preference-shaped fact and belongs in `settings`.
- Adding `"openalgo"` to `BROKERS` — it is a router, not a broker. It would demand a charge profile it can never have and would poison every per-broker analytic with a bucket that is really seven brokers wearing one name. Trades are stamped with the UNDERLYING broker, which is also what selects the charge profile.
- Pro-gating it — invariant 7: imports are the core journal, and the core journal is never gated. It is free and off, not paid and on.
**Supersedes:** the 2026-08-12 build-order entry that put **Upstox and Groww last, blocked on a static IP or a monthly fee** — OpenAlgo reaches both (and Paytm Money and Kotak) with no broker-specific code and no fee. It also makes the 2026-08-15 Trades-table entry's parenthetical "the 3 API pulls (Kite, Dhan, Angel One)" a count of the SHIPPED binary only: `lib/import/api/` holds four clients from this date, and the fourth has a documented `quantity: 0.0` repair path, so "nothing on this surface can be undefined" holds only because the adapter refuses a row it cannot recover.
**Invalidated if:** OpenAlgo's `/tradebook` starts returning a trustworthy `quantity` (the repair path and its warning then become noise), or the endpoint grows a date range (it stops being a daily pull and the "not a backfill" line must come off), or the risk statement changes materially — then bump `OPENALGO_DISCLOSURE_VERSION`, which re-prompts every install by design.

## 2026-08-20 — Angel One's live API pull has been broken since v2.99.80: `encryptSecret("")` is unreadable, and the pull refused on it

**Context:** Wiring OpenAlgo, whose credential shape copies Angel One's — key encrypted, `accessToken: encryptSecret("")`, extras in `auth_json` — made the OpenAlgo pull fail before it reached the network.
**Measured / found:** AES-GCM over an empty plaintext yields a **zero-length ciphertext**, so `formatVaultString` produces `venc:1:<iv>::<tag>`. `parseVaultString` (lib/vault-format.ts:76) rejects any empty segment, so `readSecret` on that value returns `{ok:false, reason:"malformed"}` — correctly, an empty secret is not a secret. The pull branch of `app/api/import/broker/route.ts` guarded with `if (!keyRead.ok || !tokenRead.ok)` **before** dispatching to a broker, so every `needsToken: false` broker was refused with "The saved credentials cannot be read: … Re-enter the API key and access token." Angel One is the only shipped `needsToken: false` broker, so **its unattended pull — the feature README calls "the one that needs no daily attention" — has failed for every user since the vault landed in v2.99.80**, and `sweepPlaintextSecrets()` re-encrypting a legacy empty string produced the same broken shape. Verified by reading the shipped code at the v2.99.98 commit, not inferred from a stack trace.
**Decision:** the guard becomes `if (!keyRead.ok || (needsToken && !tokenRead.ok))`, with `needsToken` read from `API_BROKERS`, and the Kite/Dhan branches take `accessTokenPlain = tokenRead.ok ? tokenRead.value : ""`. The vault itself is NOT changed — refusing to read an empty ciphertext is right; the caller was wrong to demand a token it never collected. `tests/vault.test.ts` now pins the property ("an EMPTY secret encrypts to a string that cannot be read back") with the story attached, so the next caller meets this trap in a test rather than in production.
**Why not the obvious thing:** making `encryptSecret("")` round-trip (special-case the empty string, or store `null`) — that weakens a format whose whole job is to be unambiguous, to paper over one caller's bug; and `null` in the column would collide with the pre-vault plaintext path that `readSecret` deliberately still supports.
**Invalidated if:** a broker is added with `needsToken: true` that nonetheless stores an empty token (then the guard needs a third state), or the vault format grows an explicit empty-value encoding.

## 2026-08-20 — Paytm Money tradebook reconciled against Paytm's own lot statement: pairing now "same day first, then FIFO, opening inventory oldest"; 47 of 52 scrips agree within ₹25

**Context:** The owner supplied a real Paytm Money tradebook (414 executions, 3–18 Aug 2026) and the matching Equity P&L (`.xls`, 3 sheets, 124 realised lots) — the first live data for the parser built schema-only on 2026-08-12 (VYUHA-STATE §7 rule: reconcile before trusting it). No contract note was supplied; Paytm's **Realized P&L Detail** (one row per matched lot, with buy/sell dates and values) is the broker-stated reference used instead.
**Measured / found:**
- The old parser aggregated the whole file per `Script` and set `grossPnl = sellValue − buyValue`: **66 positions, ₹1,26,04,496.93 of "gross P&L"** — ₹2.17 Cr of it on rows where sells exceeded buys (a sell-only scrip booked as 100% profit). Paytm's own realised P&L for the period is **₹20,23,631.97**.
- `Script` is a numeric scrip code, not a ticker; `Product Type` is `EQ` on every row (segment, not product); `Trade Time` is empty; STT and stamp duty for a scrip-day are booked on ONE execution row (e.g. 0 / 0 / 0 / 1960.08 where 1960.08 = 0.1% of the day's total buy value).
- Paytm's lot values are **charge-inclusive**: 03-Aug buy fills averaged 52.4500 with 0.0632/share of charges, and the lot shows 52.5132; so its `P&L Value` is NET. Compare gross − apportioned charges, not gross.
- Paytm matches a sell against the **same day's buy first** (05-Aug sell 10,000 ↔ 05-Aug buy 10,000 while 10,000 of a 03-Aug lot stayed open), then FIFO, and **pre-window holdings are the oldest lot** (a 48,000-share holding was consumed by the earliest delivery sells: 32,000 on 03-Aug, 4,800 on 04-Aug, 6,400 on 10-Aug, 4,800 on 11-Aug). Pure FIFO disagreed with the broker on 52 of 60 scrips; same-day-first alone on 36; same-day-first + seeding the inferred opening inventory at the head of the queue: **47 of 52 in-window scrips within ₹25, 4 within ₹400, 1 off by exactly 3,200 shares** of opening inventory the tradebook cannot see (the file proves a minimum of 44,800 sold from holdings; Paytm had 48,000). Totals: our closed net **₹12,34,049.50 vs Paytm ₹12,51,954.19 (−1.4%)**; the ₹7,71,677.78 Paytm earns on lots bought before the window is what our 24 opening sells leave blank. Stated charges conserved: ₹1,98,914.88 apportioned vs ₹1,98,915.04 in the file.
- After the change: 414 fills → **142 positions (88 closed / 30 open / 24 opening-sell), 38 intraday / 104 delivery derived from the STT+stamp signature per scrip-day**, 0 unknown.
**Decision:** `lib/import/pair-legs.ts` now (1) consumes the same-day lot before older lots, (2) runs two passes — the first measures the orphan quantity, the second seeds it as an opening lot that FIFO retires first, so opening sells land on the EARLIEST delivery sells, where the broker puts them — and (3) dates a closed position by the oldest lot consumed. `paytm-tradebook.ts` aggregates fills per scrip-day-side, infers product from the day's charge signature, apportions the six stated charge components by each position's share, resolves the coded symbol from the ISIN at commit (instruments table → bundled NSE index map → keep the code with a note). `tests/private-reconciliation.test.ts` replays this against the real files where they exist (skipped elsewhere). The engine change applies to Dhan GTR, Groww orders and the generic mapper too — every existing pairing test still passes.
**Why not the obvious thing:** keeping pure FIFO "because the Income Tax Act says FIFO" — the exchange nets a scrip's same-day buy and sell before anything reaches delivery, and the broker's own statement (and its STT) follows that; FIFO across days is still what decides the holding period. Treating the 3,200-share gap as Paytm's error or padding the seed to close it — the tradebook has no evidence for a larger opening holding; the user supplies a basis, the importer never invents one. Using the Summary totals instead of the lot detail — totals hide exactly the per-scrip disagreement that revealed the matching rule.
**Supersedes:** the 2026-08-12 Paytm entry's *Invalidated if* — the invalidating event has now happened. Its value semantics are no longer INFERRED, and the reference used was the broker's own **Realized P&L Detail lot statement**, not a contract note (none was supplied). AGENTS.md's matching caveat was discharged the same day.
**Invalidated if:** a broker statement shows a delivery sell matched against a newer lot while an older one remained (then the rule is broker-specific and belongs on the parser, not the engine), or Paytm stops loading charges into lot values (then compare gross to gross).

## 2026-08-20 — Zerodha tradebook: the Console export has an 8-row preamble, numeric date serials and a separate execution-time column; aggregating the whole file per symbol fabricated ₹31 L

**Context:** First real Zerodha Console tradebook (1,554 fills, Apr–Jun 2026, 23 symbols, mostly SME) and a column-A Console P&L (53 rows) — the 2026-08-12 samples were header-only.
**Measured / found:** the old tradebook branch produced 23 positions; **8 were sell-only** (holdings bought before the window) and 3 unbalanced, booked as `sellValue − buyValue` = **₹31,04,586 of fabricated gross P&L** inside a ₹42,32,813 total; every position carried the first fill's date as both entry and exit (10 of 23 spanned several days); `Order Execution Time` (renders `2026-04-01 11:14:28`) was never read, so no position had a fill time. A first rewrite with one pairing leg per FILL gave 936 positions (one per sell fill on 2–11-share SME fills); per scrip-day legs give **28 positions (15 closed / 2 open / 11 opening-sell), Σ closed gross ₹5,21,782, fill times on all 28, conservation check clean**. The Console P&L on disk covers a different period (JSLL 0 there, QUESTLAB absent), so it could not serve as the tradebook's reference. Under a neutral filename the Auction fingerprint alone scored 0.65 and the `- Z` heads 0.55 — below the 0.7 routing bar — so `tradebookFp` is now 0.5 and `consoleFp` 0.55 (0.75 / 0.70 measured).
**Decision:** `zerodha.ts` pairs per symbol + product via `pairLegs` on scrip-day-side legs, keeps every fill as an execution inside the position's window, reads the clock from `Order Execution Time`, derives product from the calendar when the export has no Product column (`productDerived`), refuses undated/unsided rows, and skips the three all-zero ISIN-in-Symbol rows of the Console P&L. `sourceRows` = fills, and the warning says "N fills → M positions (FIFO per symbol + day)".
**Why not the obvious thing:** one leg per fill — `pairSymbolLegs` emits one closed position per sell leg, so fill-level legs turn an SME tradebook into hundreds of "trades" nobody made; the bill/scrip-day is the unit Dhan GTR already uses. Keeping the whole-file aggregate for "simplicity" — invariant 6 forbids the 100%-gain rows it produces.
**Invalidated if:** Zerodha adds a Product column to the Console tradebook (then the derived-product branch should yield to it — it already does when the column exists), or `pairLegs` grows a fill-level mode.

## 2026-08-20 — Upstox reports fingerprint on the A1 legal name; layouts verified, values still INFERRED (zero data rows)

**Context:** Three real Upstox exports (trade report, realised P&L, ledger) from an account with no trades — the first Upstox files ever examined; `detectUpstox` looked for the broker's name in the header row only and scored 0 on all three.
**Measured / found:** A1 of every sheet is `UPSTOX SECURITIES PRIVATE LIMITED`; the TRADE header sits on row 11 (`Date | Company | Amount | Exchange | Segment | Scrip Code | Instrument Type | Strike Price | Expiry | Trade Num | Trade Time | Side | Quantity | Price`), the REALIZED_PNL header on row 22 (`… Symbol | ISIN | … Buy Date | Buy Rate | Buy Amt | Sell Date | Sell Rate | Sell Amt | Days | Total PL | Short Term | Long Term | Speculation | Turn Over`), the LEDGER_V3 sheet has no column header at all. Filenames name no broker. After the change: trade report 0 → **0.75**, realised P&L 0 → **0.95**, ledger 0 (nothing to read), Angel One's detector 0 on all three and unchanged elsewhere.
**Decision:** the Upstox fingerprint is any pre-header cell containing "upstox"; `Trade Time` feeds the clock; `Buy/Sell Date`, `Buy/Sell Amt`, `Total PL` are mapped; product is derived from `Speculation` (intraday) / `Short Term`+`Long Term` (delivery) only when no product column exists, flagged `productDerived`; F&O rows keep `Company` as the symbol with an import note — no F&O symbol grammar was invented. Value behaviour (signs, date/time formats, Side spellings, Instrument Type vocabulary) is INFERRED and written into the synthetic test rows as assumptions, not observations. The ledger stays unparsed.
**Why not the obvious thing:** adding "company" to the shared symbol-column list — it would change Angel One's scoring, which has no new evidence. Writing an F&O tradingsymbol from Company + strike + expiry — the first real row would show whether that guess was right, and a wrong symbol silently mis-prices a trade.
**Invalidated if:** a populated Upstox export arrives — re-verify every INFERRED item above and replace the synthetic rows in `tests/angelone-upstox.test.ts` with redacted real ones.

## 2026-08-20 — Redacted fixtures are SCHEMA-ONLY copies with three synthetic rows, produced by a scratch script and leak-scanned against every value in the private files

**Context:** Seven new fixtures for the cross-broker matrix; the real files carry the owner's actual book and the repo is public.
**Measured / found:** A generic transform (keep every label/header/footer row and the blank-row structure; scrub the value cells of identity rows; keep the first three data rows of each table with symbols → `SYNTHn`, ISINs → `INE0SYNnnnnn`, long numeric codes → `99900n`, money → small deterministic numbers, dates kept; re-apply date formats so numeric serials still render as `yyyy-mm-dd`) passed a scan that flags any cell matching an identity value, ISIN, scrip name token or long code from the private files — the only residual hits were Upstox's own registered-office address and Zerodha's charge-head words. The real files replay through the same assertions in a `describe.skipIf` block, proving redaction preserved exactly the cells detection reads.
**Decision:** fixtures named for their layout (`paytm-tradebook-v2.xlsx`, `paytm-equity-pnl.xls`, `zerodha-tradebook-console.xlsx`, `zerodha-console-pnl-cola.xlsx`, `upstox-{trade-report,realized-pnl,ledger}.xlsx`), loaded under neutral filenames so only content can claim them.
**Why not the obvious thing:** committing the real files with the client id scrubbed — the trades themselves are the owner's book; hand-writing fixtures from the docs — a copy drifts from the quirks (formatted blank rows, preamble positions, BIFF `.xls`) that broke detection the first time.
**Invalidated if:** the private folder changes (re-run the scratch transform and the leak scan before committing a fixture).

## 2026-08-15 — The landing page is hosted on GitHub Pages from `main:/docs` via a redirect, not a copy

Public URL: https://thejesh-k463.github.io/VYUHA-LOG/ → `docs/index.html` (meta-refresh) →
`sales/landing-page.html`, so `../screenshots/*.png` resolve as-is. A copy at `docs/index.html`
would have drifted from the file `tests/pricing.test.ts` pins; the redirect keeps one source.
Pages was enabled with `gh api -X POST repos/…/pages -f source[branch]=main -f source[path]=/docs`;
first build ~1 min; verified 200 on root, landing page and a screenshot. `docs/.nojekyll` added so
underscored paths are served. Everything under `docs/` (incl. `docs/owner/*`) is public — it already
was, the repo is public; nothing secret lives there (verified: secrets are gitignored at root).
Superseded: HOW_TO_EDIT_SALES_ASSETS "host it anywhere / when hosting exists" (2026-08-13).

## 2026-08-15 — Screenshots come from synthetic fixtures via one script; skin-royal retired from every surface

`scripts/retake-screenshots.mjs` (22 shots, temp DB, `dhan-gtr.csv` + `dhan-pnl.csv` last for
the seller journal, settings set via `POST /api/settings`) is the only sanctioned way to refresh
`docs/screenshots/`. Reason: three hand-taken files (lenses, pricing, skins) had drifted two
releases; and screenshots must never show the owner's real book. `tests/readme-claims.test.ts`
fails if README references a screenshot that does not exist.

## 2026-08-15 — Reinstall over a running copy failed on `server\node\node.exe`: the sidecar was only killed on WindowEvent::Destroyed, and Tauri's NSIS template stops vyuha.exe alone

**Context:** buyers upgrading v2.99.96 → next saw the NSIS dialog "Error opening file for writing … server\node\node.exe".
**Measured / found:** the Node sidecar was stopped only in the `WindowEvent::Destroyed` handler. An in-app update, a crash, or a Task-Manager kill of `vyuha.exe` never reaches that handler, so `node.exe` outlived the shell and held the file lock. Tauri's stock NSIS template kills the main executable only. Clicking *Ignore* was harmless — the locked file is byte-identical (same Node 22.17.0) — but nobody reads an installer error as harmless.
**Decision:** `stop_sidecar()` (kill + wait) runs on `WindowEvent::Destroyed`, on `RunEvent::ExitRequested` and `RunEvent::Exit`, and immediately before `update.download_and_install`. The NSIS `PREINSTALL` / `PREUNINSTALL` hooks additionally stop any `node.exe` / `vyuha.exe` whose `ExecutablePath` is under `$INSTDIR` — a `Get-CimInstance` filter, with `$INSTDIR` handed to PowerShell through an environment variable so a path with spaces or quotes never needs escaping.
**Why not the obvious thing:** `taskkill /IM node.exe` kills every Node process on the machine — a developer's dev server, another Electron app's helper — for a file we could otherwise leave alone. Killing by path is the only version that touches nothing but ours.
**Invalidated if:** the sidecar stops being a separate `node.exe` (single-binary sidecar), or Tauri's NSIS template grows its own child-process cleanup.

## 2026-08-15 — Buy CTAs open a contact dialog, not a link: the desktop webview blocks external `target=_blank` and we ship zero runtime Tauri plugins on purpose

**Context:** every "Get Pro / Get Lifetime" button was an `<a target="_blank">` to WhatsApp; in the desktop app it did nothing.
**Measured / found:** the Tauri webview refuses to open external URLs in a new window unless the opener/shell plugin is present. The shell deliberately carries no runtime Tauri plugins (updater aside) — that is what keeps the Rust side small and the permission surface flat — so the click was silently swallowed. The same buttons work in a browser tab, which is why nobody noticed in dev.
**Decision:** every "Get …" opens a dialog that states the number (+91 73936 73714), the pre-filled message, **Copy number** and **Copy message** buttons, an *Open WhatsApp* link (works in browsers, inert but harmless in the desktop shell) and the offline note. Settings → License pills open the plan card in a popup rather than a comparison table.
**Why not the obvious thing:** adding `tauri-plugin-opener` for one link — a runtime dependency, a capability entry and a review surface for a button whose whole job is to get a phone number in front of the buyer. A dialog with a copyable number works identically online, offline, in-browser and in-shell.
**Invalidated if:** the shell ever gains the opener plugin for another reason — then the link can be primary again, but keep the copyable number.

## 2026-08-15 — Appearance: tint curves cut from spec 0.20/0.22/0.14 to 0.13/0.11/0.11 so every skin holds ≥9:1 (dark) / ≥7:1 (light) at intensity 100; tokens go inline on `<html>`, not as classes

**Context:** v2.99.97 adds a tint-intensity slider (0–100, default 50; presets Subtle 25 / Balanced 50 / Vivid 75; −/+ steps of 10), panel styles (Flat / Soft / Luxe / Glow) and a wallpaper, all driven by the pure engine `lib/domain/appearance.ts`.
**Measured / found:** with the spec curves (card-top 0.20, card-hover 0.22, sidebar surface 0.14) Lime dropped card-top/hover body-text contrast to 8.5:1 and Luxe's surface to 11.9:1 at intensity 100 in dark. Reduced to 0.13 / 0.11 / 0.11, the worst skin measures: dark canvas/card/surface ≥12:1, card-top/hover ≥9:1; light ≥7:1 across all eight skins at intensity 100. Chart tokens must stay literal colours (lightweight-charts renders an invisible series on `color-mix()`/`var()`), and lightweight-charts re-reads its theme only on a class change — so charts re-theme via an `appearance-tick` class toggle on `<html>` while the colours themselves are injected inline by `app/layout.tsx` (no first-paint flash; an inline style beats any class-scoped token without a specificity fight).
**Decision:** curves as above; panel styles are `html.panel-*` classes with overrides in `@layer utilities` at (0,2,1) specificity; Terminal + Glow deliberately degrades to a flat shadow (a glow on a monochrome skin is a smear). Custom theme is a ninth skin `custom`: 7 fields × dark/light (accent, analytics, money, sidebar, cards, borders, canvas), derived shades computed in code, per-row WCAG badge that warns and never blocks, "Start from <skin>" seeds from the computed tokens; saved only with the form and only while Custom is selected. Wallpaper: PNG/JPEG/WebP ≤12 MB, magic-byte sniffed, stored in `<data>/wallpaper/` outside backups (said on the Backup screen), fixed cover behind `<main>` with a theme-aware scrim `rgb(ch / var(--wallpaper-scrim))`, opacity slider, removed in print. Migration 0048 adds `tint_intensity`, `panel_style`, `custom_theme`, `wallpaper_stored_name`, `wallpaper_opacity`. `ice`/`royal` still map to `sapphire`.
**Why not the obvious thing:** keeping the spec curves — Vivid on Lime would put body text on a card-top below the 9:1 floor this project has held since the first skins. `color-mix()` for the scrim — it is exactly the value class lightweight-charts and older WebView2 builds mishandle; `rgb(ch / var())` is plain CSS Color 4. Blocking a custom colour that fails WCAG — the user typed it on purpose; a badge tells them the number and lets them decide. Putting the wallpaper in backups — a 12 MB image in every nightly backup for a decoration.
**Invalidated if:** a skin's base canvas or `--color-foreground` changes (re-measure the worst-case skin at intensity 100), or lightweight-charts starts honouring inline custom properties (then the tick class can go).

## 2026-08-15 — Trades table shows Entry/Exit PRICE, not Buy/Sell VALUE; qty 0 → "—", never ₹0; MTF own-% is derived or absent

**Context:** v2.99.96 replaces the Buy value / Sell value columns on /trades with Qty, Invested, Entry price, Exit price.
**Measured / found:** Every import path fills `avgBuyPrice`/`avgSellPrice` — `NormalizedTrade` (`lib/engine/types.ts:47–64`) declares both non-optional, so the 6 broker parsers, the generic column mapper and the 3 API pulls (Kite, Dhan, Angel One) cannot produce a row without them; nothing on this surface can be undefined. An open trade has one side with qty 0 and price 0.
**Decision:** a side whose qty is 0 renders "—", never ₹0 (a zero price is not a fact about the trade). Invested on an MTF row shows the trader's own contribution % computed as `(buyValue − mtfFundedAmount) / buyValue`, and the funded amount beside it; when `mtfFundedAmount` is null the cell says "funding not yet resolved" — no default margin is substituted (invariant 6).
**Why not the obvious thing:** keeping "Buy value" — a value is qty × price and hides the level the trader actually acted on; showing ₹0 for the missing side of an open trade reads as a fill at zero.
**Invalidated if:** `NormalizedTrade` ever makes either price optional (the "—" rule then needs a null branch too), or a parser starts writing legs without the aggregate on the parent row (invariant 5).

## 2026-08-15 — Skins v2.99.96: the hue wheel is nearly full; Lime 83° / Rose 329° / Ember chosen, Ice and Royal retired, surface tints ~1.30:1

**Context:** eight skins that tint canvas/card/border, and a test that no two skins share a primary or an analytics-vs-primary hex.
**Measured / found:** hues already taken: gold 42°, tape 45°, profit 157°, luxe 172°, cb-profit 217°, sapphire 224°, violet 255°, aurora 292°, loss 352°, cb-loss 38°. Rejected: coral (~16°, only 24° from loss), emerald (= profit), indigo (8° from Sapphire), sky (~198°, Ice reborn). Chosen: **Lime 83°** (13.29:1 dark / 5.41 light), **Rose 329°** (7.57 / 5.58), **Ember** (8.85 / 5.16 — 11° from the colour-blind-safe loss hue, accepted on Tape's precedent of 7° from gold). Ice ≈ Sapphire — identical analytics hex, distinguishable only by the primary; Royal's primary was Luxe's analytics hex. Surface tints composite the border at ~1.30:1 against the card (was 1.24) — note the 1.48:1 floor in the 2026-08-09 entry is for `--color-rule` (row separators), not `--color-border`.
**Decision:** SKINS = luxe, mono, tape, sapphire, aurora, lime, rose, ember; `asSkin` maps a stored "ice"/"royal" → "sapphire". To let the hex-distinctness test hold, Tape/Aurora analytics retuned #2dd4bf → #5eead4 and Sapphire analytics #e879f9 → #f0abfc.
**Why not the obvious thing:** keeping ten skins — two of them were the same skin twice, and a "choose your accent" list where two entries look alike is a bug the user files, not a feature. Picking coral/sky by eye lands inside the P&L or an existing skin's hue band, which is how Tape's money had to move (2026-08-11).
**Invalidated if:** the canvases or `--color-profit`/`--color-loss` hues change, or a ninth skin is proposed — measure its hue against this wheel first.

## 2026-08-15 — The desktop app's phantom console: node.exe is console-subsystem; fixed with CREATE_NO_WINDOW + a log file, readiness never depended on stdout

**Context:** buyers saw a second, blank terminal window behind the desktop app.
**Measured / found:** the Tauri shell is a GUI-subsystem process; the Node sidecar (`node.exe`) is console-subsystem. A GUI parent spawning a console child with inherited stdio makes Windows allocate a fresh console for the child. Sidecar readiness was always the TCP poll on the loopback port — stdout was never read for it.
**Decision:** spawn with `creation_flags(0x0800_0000)` (CREATE_NO_WINDOW) and point the child's stdout/stderr at `<data_dir>/logs/sidecar.log` (append; `src-tauri/src/lib.rs`). The log path is now in the client README and INSTALLATION_GUIDE.
**Why not the obvious thing:** DETACHED_PROCESS also hides the window but detaches the child from job/console lifetime; piping stdout into the parent needs a reader thread or the pipe buffer fills and blocks the sidecar. A file is the least machinery that keeps every line.
**Invalidated if:** the sidecar becomes a GUI-subsystem binary (then no console is allocated regardless), or the shell starts reading the sidecar's stdout for anything.

## 2026-08-15 — Load tests batch 2: five defects fixed with numbers, one prediction wrong, one non-defect proven

**Context:** `tests/load/` batch 2 (B1–B7, C2, C7) on synthetic books of 10k–320k trades.
**Measured / found:**
- **B1 lens grouping** — growth ratio 14.3 (55 ms @10k → 794 ms @40k). After a per-array index: 5.1–5.3 (69 ms @80k → 347 ms @320k). Test asserts ratio < 8.
- **B2 entitlement** — 200 spaced licence reads did 200 UPDATEs (the "last seen" mark rewritten every read). Now the mark is written only when ≥ 24 h past the stored mark → 0 UPDATEs across the run; a pure read 65 → 56 µs.
- **B5 `dbCounts`** — read 125,195 rows in 421 ms to count them; now `COUNT(*)`: 29 rows / 1 ms.
- **B6 encrypted restore** — two scrypt derivations (498 + 527 ms) → one (495 + 30 ms) via a derived-key cache: 5-minute TTL, 4 entries, keyed by sha256(salt | params | password).
- **B7 import detect** — 15 full XLSX decodes / 1,331 ms → 8 / 802 ms by memoising `rankParsers` per `ParseContext`. Getting to ≤ 2 needs the parsers to share one parsed workbook — pinned as an `it.fails` follow-up, not claimed.
- **C2** — prediction WRONG: the skipped-row warning was already emitted. Adjacent defect found instead: executions-shaped generic imports left `sourceRows` unset (6,491 lines → 4,226 positions reported as if 4,226 rows); now `sourceRows = rows − skipped`.
- **C7** — no defect: over 250k trades a naive float fold drifts 5.0e-4 paise pre-rounding and 0 after, against `SUM(net_pnl_paise)`. `getTradeStats` over 250k = 3.1 s, reported not fixed.
**Decision:** each fix ships with its load test asserting the new bound; C7's 3.1 s is recorded as the current cost, not a target.
**Why not the obvious thing:** "make it faster" without the ratio — B1's absolute time at 10k was fine; only the growth exponent showed the defect.
**Invalidated if:** the synthetic-book generator changes shape, or the entitlement mark's 24 h threshold is changed (B2's 0-UPDATE assertion depends on it).

## 2026-08-15 — Annual → Lifetime upgrade: full credit within the year, not pro-rata

**Context:** an annual buyer wants Lifetime part-way through the year (tooling: `scripts/license-upgrade.mjs`).
**Measured / found:** due = lifetime launch price − annual amount paid (₹29,999 − ₹9,999 = ₹20,000 at launch prices), for any upgrade inside the annual term.
**Decision:** full credit of the annual payment within its year — owner decision 2026-08-15. The same sentence appears on the pricing screen, landing page and brochure (`tests/pricing.test.ts` pins them verbatim).
**Why not the obvious thing:** pro-rata (credit × months remaining / 12) is "fairer" on paper and impossible to explain in one line on a pricing page; a buyer who cannot predict the number does not upgrade.
**Invalidated if:** the launch prices end (2027-01-01) — the credit then applies against the list price and the copy must say so.

## 2026-08-15 — Licence key archive: per-key plaintext to an owner-chosen folder, plus an AES-256-GCM bundle at scrypt N=2^15

**Context:** losing the signing PEM or the ledger means every issued key is unverifiable; the owner needs a backup that is not the working folder.
**Measured / found:** `license-issue.mjs --save-dir <folder>` writes each issued key as its own plaintext file to a folder the owner picks (an external drive, a synced folder). `scripts/license-backup.mjs` bundles the PEM + ledger with AES-256-GCM, key from scrypt N=2^15.
**Decision:** N=2^15 rather than the backup-format's 2^17 because this runs interactively on the owner's machine once per session, not per customer restore; the ~4× cheaper derivation is fine for a passphrase the owner chose.
**Why not the obvious thing:** reusing `lib/backup.ts`'s format — it is built for a customer's database and pulls the app's schema in; the key archive needs zero app imports so it still runs when the app does not.
**Invalidated if:** the PEM moves to a hardware key or a KMS, in which case the bundle carries only the ledger.

## 2026-08-15 — "Preview pane" defect closed: it was the dev-tool browser pane on the /trades dev build, not the app

**Context:** an item on the open list said the trades preview pane rendered blank.
**Measured / found:** the report came from the IDE browser pane against `next dev` on /trades — the same "networkidle is not hydration" behaviour recorded 2026-08-10. Nothing reproduces in the desktop build or a real browser.
**Decision:** closed, no app change.
**Why not the obvious thing:** chasing a rendering fix in `trades-client.tsx` for a symptom the pane manufactures.
**Invalidated if:** a user reports it from the desktop app with the sidecar log attached.

## 2026-08-15 — Launch-offer anchors are committed 2027 list prices, and the advertised percentages are derived, not the ones the owner asked for

**Context:** Owner requested strike-through launch pricing ("₹13,000 → ₹9,999, 30% off"; "₹35,999 → ₹29,999, 20% off, best value") plus a competitor table on /pricing.
**Measured / found:** 9,999/13,000 = 23.08% off and 29,999/35,999 = 16.67% off — the requested "30%/20%" labels do not survive division. A first cut used `Math.round`, and the review pass caught 16.67 → "17% off": rounded UP, overstating the discount. Anchors previously did not exist anywhere in the repo (grep for 13,000/35,999: zero hits); `wasInr` existed in the type, unused, and both `PricingTable` variants already rendered it.
**Decision:** Owner confirmed ₹13,000/yr and ₹35,999 as the REAL list prices effective **2027-01-01** (recorded here and in MONETIZATION_PLAN §2; deliberately NOT rendered in-app — owner's call). Percentages ship as the derived-and-FLOORED **23% / 16%** via `offerPct()` in `lib/domain/pricing.ts` — floor, not round, because a discount claim must never overstate; understating by <1% is fine. `featured` moved from annual to lifetime — the owner sells lifetime first. Lifetime's roadmap line (mutual funds, gold) is labelled "planned, not yet shipped".
**Why not the obvious thing:** Shipping the requested 30%/20% — a stated percentage that fails division is a false claim of exactly the kind v2.99.94 retired, and a fabricated anchor is a CCPA-2023 dark pattern. The alternative anchor (₹14,299 to make 30% true) was offered; the owner kept ₹13,000.
**Invalidated if:** The offer is still running past 2027-01-01 (the anchors then stop being true and must come off every surface), or the owner repriced again.

## 2026-08-15 — Competitor comparison cells are sourced-or-"Not stated", with † for third-party pricing

**Context:** Building the /pricing and landing-page comparison tables (owner approved the full 7-product version, cheap Indian journals included).
**Measured / found:** Official pricing pages read 2026-08-15: TradeZella $315/yr base, Edgewonk $197/yr, TradesViz ₹12,600/yr (their own ₹), OneTradeJournal ₹1,999–2,499/yr (two figures on their own page), TradeDiary ₹999/yr. TraderSync (HTTP 403) and Tradervue (404) pricing came from agreeing third-party 2026 reviews → flagged † on every surface. No competitor page states an independent Indian statutory-charges engine; none advertises local-only storage.
**Decision:** Data lives in `lib/domain/pricing-comparison.ts` (pure, zero imports) with `COMPARISON_AS_OF = "2026-08-15"`; unverifiable cells say "Not stated", never a guess; "why Vyuha" rows are architecture/arithmetic only — no outcome claims (SEBI posture).
**Why not the obvious thing:** Omitting the ₹999–2,499 Indian competitors would make the table look better and be exactly the selective honesty the product positions against; a buyer who googles finds them anyway.
**Invalidated if:** Any competitor repricing (recheck the sources before a release that touches pricing copy), or TraderSync/Tradervue pages become fetchable — replace the † cells with primary figures.

## 2026-08-11 — Royal/Sapphire/Aurora skin triples: measured before written, floors matched to the shipping four

**Context:** v2.99.70 adds three "more vibrant, luxurious" accent skins next to Luxe/Mono/Ice/Tape.
**Measured / found:** (WCAG contrast on the real canvases #05080f dark / #f4f6f9 light; circular hue separation; script — contrast + `colorsys` HLS hue.)
- royal `#a78bfa/#e5b13d/#22d3ee` dark 7.36/10.20/11.09, light `#6d28d9/#8f6207/#0e7490` 6.56/4.95/4.95; min role-sep 67°/70°; primary 89–97° from P&L.
- sapphire `#7196ff/#e5b13d/#e879f9` dark 7.16/10.20/8.14, light `#1d4ed8/#8f6207/#a21caf` 6.19/4.95/5.84; min role-sep 68°/70°; primary 67° from P&L.
- aurora `#e879f9/#e5b13d/#2dd4bf` dark 8.14/10.20/10.76, light `#a21caf/#8f6207/#0b7a70` 5.84/4.95/4.81; min role-sep 105–109° (widest of any skin shipped); primary 57–60° from P&L.
**Decision:** ship all three. Money stays GOLD in all three (no skin-tape-style money move needed — no primary lands near 41°). Worst case anywhere is aurora's light analytics at 4.81:1 — exactly equal to the recorded worst the first four skins already ship (Tape light), so the floor did not move. Sapphire's dark primary 7.16:1 is marginally under Royal's 7.36 benchmark and accepted: it is body-text-large/UI accent usage, > 7:1.
**Why not the obvious thing:** picking Tailwind palette hexes by eye — that's how skins drift under the 4.5:1 light-theme floor and land primaries 4° from gold (the measured reason Tape's money moved to violet).
**Invalidated if:** the canvas colours change, or `--color-profit`/`--color-loss` hues move (157°/352° today).

## 2026-08-11 — Metallic gold retune: #e5b13d → #f0b429 triple, gradient text from TOKENS

**Context:** owner asked for the money gold to look "metallic and vibrant" (v2.99.70).
**Measured / found:** #f0b429 base (10.75:1 on #05080f, hue 41.9° vs the old 41.4°, sat 76→87%), #ffd863 highlight (14.55:1), #cf8d12 shadow (7.13:1) — all above the old values' contrast, hue essentially unchanged so the 41° gold doctrine holds. Light theme untouched: #8f6207/#966808/#6f4b05 are already the lightest AA-clearing golds at this hue (documented at the light block).
**Decision:** retune the three dark gold tokens + `--color-warning`; resurrect the dead `text-grad-gold` utility as a vertical highlight→base→shadow gradient built from `var(--color-gold-*)` with a `drop-shadow` glint, applied to the 8 KPI-scale money values.
**Why not the obvious thing:** literal gradient stops (what the utility had) would paint GOLD money on the Tape skin, whose whole design is that money moved to violet — tokens make the metal follow each skin's money colour for free. And `box-shadow` can't glint clipped text; `drop-shadow` follows the glyph alpha.
**Invalidated if:** the canvas colours change, or a skin re-points gold tokens to something whose bright/deep don't darken monotonically (the gradient assumes bright > base > deep).

**Context:** Wave 2 of the performance program. `babel-plugin-react-compiler`
sat in devDependencies and the codebase's comments were written assuming the
compiler was on — but `next.config.ts` never enabled it. This was the
deliberate, isolated enablement attempt (a wave with no other client change,
so anything that broke would bisect to the flag).

**Measured / found:**
- `reactCompiler: true` (top-level Next 16 key) compiles and passes the full
  unit suite + build. The failure is at HYDRATION: SSR and the client bundle
  collapse JSX source whitespace differently at `</b>` + newline-indented-text
  boundaries. Server rendered `" of realised P&L sits…"` (leading space),
  client rendered `"of realised P&L sits…"` — a one-character disagreement
  that throws "Hydration failed" and REGENERATES THE ENTIRE CLIENT TREE on
  every visit to an affected page.
- **Bisect:** same route, same DB — 3 hydration errors with the flag on,
  0 with it off. Unambiguously compiler-caused.
- Fixing the first site (dashboard equity-curve note, moving the space into an
  explicit string expression) just surfaced a SECOND identical site
  (calendar-heatmap's "and cannot appear on any day…"). The pattern —
  an inline element followed by newline-indented text — is everywhere in this
  codebase; enumerating and rewriting every site to dodge an upstream bug was
  rejected as whack-a-mole that would also make the JSX worse to read.
- The three compiler-sensitive surfaces themselves (TanStack sorting under
  "use no memo", the sidebar's deferred mount-restore, the debounced charge
  preview) all PASSED under the compiler — the codebase's effect discipline
  held. The whitespace bug is the only blocker, and it is not ours.

**Decision:** `reactCompiler: false`, with the reason in next.config.ts.
KEPT: DataTable's `"use no memo"` (inert without the compiler, mandatory with
it) and `e2e/z-compiler-protocol.spec.ts` (guards the silent-failure surfaces
against any future retry or memoization refactor). Also kept: the
dashboard-client string-expression form — inert now, correct later.

**Invalidated if:** babel-plugin-react-compiler releases past 1.0.0 with a
whitespace fix, or Next/Turbopack aligns the two pipelines' JSX text
normalisation — retry by flipping the flag and running
`z-compiler-protocol.spec.ts` plus a hydration-error grep of a dashboard
visit's server log (the exact procedure above).

---

## 2026-08-10 — /trades at scale: slim projection + row virtualization, with numbers

**Context:** Wave 1 of the performance program. At 252 real trades the full
`Trade[]` RSC payload measured 1,632 B/row; extrapolated to a 10k-trade book
that is ~16 MB per navigation plus ~500k DOM nodes — unusable.

**Measured / found:**
- Slim projection (`lib/domain/slim-trade.ts`, 43 of 74 columns — the union
  the client tree actually reads): **907 B/row, a 44.4% cut** → ~8.7 MB at
  10k rows (`scripts/measure-slim.mjs`, real data). The dialogs needed NO
  fetch-on-open — `notes`/`ruleViolations` stay in the projection.
- Virtualization (`data-table.tsx` `virtual` prop, @tanstack/react-virtual,
  spacer-row technique): the DOM holds ~30 rows of 122 in e2e; selection,
  per-view counts and "N of M" all read the full filtered array, so no
  semantics moved. Sticky header/left survive because windowing is y-only.
- Composite index `(account_id, sell_date DESC, created_at DESC)`:
  EXPLAIN QUERY PLAN now reads `SEARCH trades USING INDEX
  trades_account_sell_created_idx` — no temp B-tree sort — for the query ~25
  force-dynamic pages run on every navigation.
- xlsx (401 KB chunk): statically imported by `components/ui/export-button.tsx`
  via `lib/export.ts`, it rode 13 routes' client bundles. After the dynamic
  import, **0 page manifests reference the chunk** (verified against
  `.next/server/app/**/page_client-reference-manifest.js`).
- The e2e contract change that follows from virtualization: row counts in
  specs must come from the "N of M" counter, never `tbody tr` counts —
  rendered rows < population is the FEATURE. And any spec locating a row must
  narrow (view/search) first: open rows sort below the window in the default
  DESC order (SQLite NULLs sort last in DESC).

**Why not the obvious thing:** TanStack `columnOrder`-style server pagination
was rejected — it breaks the counts-reconcile contract and moves the
derive-don't-sync filter architecture into SQL. Client virtualization alone
was rejected — it leaves the 16 MB flight payload untouched.

**Invalidated if:** a column starts reading a dropped field (tsc breaks — add
it to SLIM_TRADE_FIELDS), or DataTable's rows stop being a uniform floor
(measureElement already handles growth, but a variable-height redesign should
re-check overscan).

---

## 2026-08-10 — NSE surveillance files: two formats verified from real downloads; one file covers ASM+GSM+ESM

**Context:** replacing the Surveillance screen's paste-only workflow with file
upload. The repo had zero knowledge of these formats and AGENTS.md forbids
inventing parsers for unpublished formats.

**Measured / found (real downloads, 2026-08-10, using the anti-bot headers
from `lib/jobs/auto-mtm.ts`):**
- **F&O ban:** `https://nsearchives.nseindia.com/content/fo/fo_secban.csv`
  (dated archives at `/archives/fo/sec_ban/fo_secban_DDMMYYYY.csv`). Shape: a
  header line `Securities in Ban For Trade Date 10-AUG-2026:` then numbered
  `1,BANDHANBNK` rows. The DATE IS IN THE FILE.
- **ASM/GSM/ESM:** the consolidated Surveillance Indicator file
  `https://nsearchives.nseindia.com/content/cm/REG_IND{DDMMYY}.csv` (note the
  SIX-digit date, and `/content/cm/`, not `/content/equities/` — both probed,
  only cm answers). ~2,970 rows, one per listed security; columns include
  `Symbol`, `GSM`, `Long_Term_… (Long Term ASM)`, `Short_Term_… (Short Term
  ASM)`, `ESM`. **Value scheme: the cell holds the STAGE; the sentinel `100`
  means "not under this measure"; GSM stage `0` is a real stage** (68
  securities carried it). The date is only in the FILENAME.
- Counted in the live file: 77 GSM, 126 LT-ASM, 56 ST-ASM, 320 ESM.
- BSE publishes its lists as notices/web tables — no machine-readable file
  found, so BSE stays paste-only, stated in the UI (owner-approved scope).

**Decisions that followed:**
- One REG_IND upload replaces categories gsm+asm+esm; the ban file replaces
  fno_ban only — `replaceRestrictionCategories` deletes per-category, because
  a whole-table replace (what paste correctly does) would make the day's
  second upload erase the first.
- `esm` became a first-class RestrictionCategory rather than mislabelling 320
  securities as "asm" or hiding them in "other".
- Detection is fingerprint-gated (ban header line / the exact REG_IND column
  family); a CSV that merely has a Symbol column is refused with the headers
  it actually saw. Trimmed REAL files are committed as `tests/fixtures/
  fo_secban.csv` and `tests/fixtures/REG_IND070826.csv`.

**Invalidated if:** NSE renames the REG_IND columns or moves the files —
`tests/nse-surveillance.test.ts` fails on the fixtures' shape, and the
refusal message shows users the headers of whatever the new file looks like.

---

## 2026-08-10 — Index derivative market lots, verified for the January 2026 series

**Context:** the Trade Calculator's new "Underlying index" picker bundles a
lot-size snapshot (`lib/domain/index-contracts.ts`).

**Measured / found:** every NSE index lot CHANGED for the January 2026 series —
NIFTY 75→**65**, BANKNIFTY 35→**30**, FINNIFTY 65→**60**, MIDCPNIFTY
140→**120** (NSE circular **FAOP70616**, effective with contracts expiring
January 2026 onward; the December 2025 monthly expiry was the last on old
lots). BSE: SENSEX **20** (raised 10→20 during 2025, unchanged in the January
revision), BANKEX **30** (15→30). Cross-checked 2026-08-10 against Zerodha's
support table and Sahi's published 2026 table — three sources agree on all six.
Model memory had four of the six WRONG (it predates the January revision),
which is exactly why the plan gated this on a live search.

**Decision:** `BUNDLED_INDEX_LOTS = {NIFTY:65, BANKNIFTY:30, FINNIFTY:60,
MIDCPNIFTY:120, SENSEX:20, BANKEX:30}`, `INDEX_LOTS_AS_OF = "2026-01-01"`.
The snapshot is the FALLBACK: a row in the instruments table (the user's own
`fo_mktlots.csv` upload) beats it, and the UI names whichever source it used
plus its date. `tests/index-contracts.test.ts` pins the values so a refresh
must touch the literals and the AS_OF together.

**Invalidated if:** a later exchange circular revises any lot — re-verify all
six against the circulars (not memory, not this entry) and update
`index-contracts.ts` + the pinned test + this log in one commit.

---

## 2026-08-10 — Plain `npm install` ALSO corrupts this lockfile; adding a dep needs a hand-merge

**Supersedes the scope of** the "never `npm install --package-lock-only`" rule in
AGENTS.md, which is correct but is NOT the whole hazard.

**Context:** adding `lightweight-charts` for the trade replay chart.

**Measured / found:** `npm install lightweight-charts` — plain, no flags, with a
fully installed tree to consult — reported *"added 2 packages, removed 27
packages"* and wrote a lockfile of **16 additions against 512 deletions**. What
it deleted was `node_modules/vitest/node_modules/esbuild` (0.28.1) and all 26 of
its `@esbuild/*` platform variants. Reproduced from a pristine `npm ci` tree, so
it is deterministic npm resolver behaviour, not a damaged working tree.

It is worse than the platform-drop failure AGENTS.md records. `vitest@4.1.9`
depends on `vite@8.1.2`, which requires `esbuild "^0.27.0 || ^0.28.0"`; the
nested 0.28.1 satisfied it. With that entry pruned, vite falls back to the
top-level `esbuild@0.25.12` and `npm ls esbuild` fails outright:

    vitest@4.1.9 -> vite@8.1.2 -> esbuild@0.25.12 deduped invalid: "^0.27.0 || ^0.28.0"
    npm error code ELSPROBLEMS

So this breaks `npm ci` on **every** platform, Windows included — not only the
darwin/linux runners.

**Decision:** to add a dependency here, take HEAD's lockfile and splice in ONLY
the new package entries plus the root `dependencies` line, then prove it with
`npm ci` + `npm ls esbuild`. Splice into the existing key order — do NOT re-sort
`packages`: npm collates `_` differently from a plain `.sort()`, and a global
sort silently rewrote `node_modules/string_decoder` for an otherwise
byte-identical record (9 phantom deletions).

**Verification that this is fixed, not just quieter:** lock diff is 16 added /
0 deleted; the lock carries 26 nested and 26 top-level `@esbuild` entries with
darwin-arm64 / darwin-x64 / linux-x64 / win32-x64 present in both; `npm ci`
installs 767 packages with no error; `npm ls esbuild` resolves vite to 0.28.1;
`npm run verify` is 97 files / 1344 tests / build, exit 0.

**Invalidated if:** vitest's nested vite starts accepting the top-level esbuild
range (then the prune becomes legitimate and the nested block should go), or npm
fixes the resolver so a plain install stops pruning a still-required nested dep.

---

## 2026-08-10 — `networkidle` is not hydration: a client-restored setting is not readable right after a reload

**Context:** Verifying that the saved Trades column order survives a page
reload, in `e2e/column-order.spec.ts` and by hand in the browser pane.

**Measured / found:** After `page.reload()` + `waitForLoadState("networkidle")`
the table renders the DEFAULT column order. It is not broken — the order is
restored by client code, which cannot run before the route hydrates, and
`networkidle` reports network quiet, not hydration. In dev the Trades route is
large enough for that gap to be seconds. In the browser pane the page was still
unhydrated NINE seconds after load: clicking "Add trade" opened no dialog,
which is the cheapest hydration probe available and worth reaching for first.

**Cost of not knowing this:** it reads as "persistence is broken". It sent me
through rewriting the restore path onto `useSyncExternalStore` AND converting
the sidebar's two settings to match, on the theory that a microtask-deferred
`setState` was being dropped on the hydration path. The sidebar was never
broken; that change was reverted. The rewrite of the Trades path was kept
because it stands on its own — storage as the single source of truth, and it
answers `react-hooks/set-state-in-effect` by deriving rather than by deferring
the write out of the rule's sight.

**Decision:** assertions about client-restored state poll
(`expect.poll(..., { timeout })`), never assert once after `networkidle`. Before
concluding that any client behaviour is broken, prove the page is hydrated.

**Invalidated if:** the suite moves to a production build, where the gap
shrinks to milliseconds — the poll stays correct either way, just faster.

---

## 2026-08-10 — Column reordering permutes the `columns` ARRAY, not TanStack's `columnOrder`

**Context:** Adding drag-to-reorder to the Trades table, which renders through
the shared `components/ui/data-table.tsx`.

**Measured / found:** `DataTable` has two readers of the raw `columns` prop that
are POSITIONAL, while rendering goes through TanStack's `getHeaderGroups()`:
`budgetMinWidth(columns)` computes the table's min-width, and `stickyStyle(i)`
reads `columns[i].meta.width` to place the two pinned cells. Enabling TanStack's
`columnOrder` would reorder the DOM while leaving both of those describing the
OLD arrangement — the frozen pair would take its `left` offsets from whichever
columns happened to land at indices 0 and 1 (so they overlap or gap), and the
min-width would describe a layout that no longer exists, so the flexible column
collapses under horizontal pressure. Nothing throws; it is wrong at some
viewport widths and correct at others.

**Decision:** `lib/domain/column-order.ts` permutes the array itself, keeping
`i` and `columns[i]` in lockstep by construction. The pinned prefix is sliced
off before any reordering and re-attached after, so no stored array can move it
even if it names those columns.

**Why not the obvious thing:** `columnOrder` is the documented TanStack feature
and is one line. It is wrong here specifically because this table reads the prop
positionally — in a table that did not, it would be the right answer.

**Also measured:** `budgetMinWidth` is permutation-invariant, but NOT for the
reason it first appears. It is not that a pinned column claims the flexible
allowance first; eligibility for that allowance is a per-column property and
exactly one eligible column receives it, so the multiset of contributions — and
therefore the sum — is identical for every arrangement, pinned or not. It stops
being invariant only if the rule becomes positional. Both facts are asserted in
`tests/column-order.test.ts`.

**Invalidated if:** `DataTable` stops reading `columns` positionally, or the
flexible-width rule is rewritten in terms of column index.

---

## 2026-08-10 — A drag grip inside a `<th>` silently renames the column for screen readers

**Context:** The reorder grip is a real `<button aria-label="Reorder … column">`
placed inside each movable header cell.

**Measured / found:** A `columnheader`'s accessible name is computed from its
CONTENT, and a nested button contributes its own label. Every header therefore
announced as "Reorder netPnl column Net" instead of "Net". Found not by review
but by a Playwright locator: `getByRole("columnheader", { name: /^Net$/i })`
timed out after 90s against a table whose header visibly reads "Net".

**Decision:** the `<th>` names itself explicitly with `aria-label` equal to its
string header, so the visible text and the announced name match (WCAG 2.5.3);
the grip keeps its own label for when focus reaches it. Applied only when the
header is a plain string — for a rendered header the visible text is not known
at that point and the column id would announce worse than the pollution it
replaced. Pinned in `e2e/column-order.spec.ts`.

**Why not the obvious thing:** `aria-hidden` on the grip also cleans the name,
but it removes the only affordance from assistive tech entirely. The sidebar's
equivalent grip (`components/layout/sidebar.tsx`) has the same pointer-only
limitation and is left as-is: its rows are not `columnheader`s, so nothing
recomputes a name from them.

**Invalidated if:** the grip gains a keyboard reorder path (then it should be
exposed deliberately rather than worked around), or a Trades column is given a
non-string header.

---

## 2026-08-10 — Only the trade replay moves to lightweight-charts; every equity curve stays on recharts

**Context:** Replacing the recharts chart inside
`components/reports/trade-replay.tsx` (rendered on /reports/scaling) with
TradingView's lightweight-charts v5 (Apache-2.0), and deciding how far the swap
should go.

**Measured / found:**
- **The equity curve cannot follow.** `EquityCurve` also renders on
  /reports/monthly, the printable PDF, and `app/globals.css` carries an
  `@media print` block that forces a light palette. recharts is SVG, so its
  fills and strokes re-read those CSS custom properties during the print pass.
  A canvas cannot: lightweight-charts rasterises with the colours it was given
  at draw time, so a lightweight-charts equity curve would print a dark chart
  onto a white page. `components/dashboard/charts.tsx` is therefore out of
  scope, not merely unconverted.
- **lightweight-charts renders an INVISIBLE line, silently, if handed a colour
  it cannot parse.** It parses colour strings itself (hex, `rgb()/rgba()`,
  `hsl()/hsla()`, named) and understands neither `color-mix(...)` nor `oklch()`
  nor an unresolved `var()`. There is no throw, no console warning and no
  missing DOM node — the series just is not drawn. The browser is no help
  either: the computed value of an untyped custom property is the token stream,
  so `color-mix()` arrives as literal text. Every token the chart reads is
  literal hex today, verified live: `--color-primary #2dd4bf`,
  `--color-profit #16c784`, `--color-loss #f6465d`, `--color-gold #e5b13d`,
  `--color-border #94a3b824`, `--color-rule #94a3b83b`,
  `--color-muted-foreground #8a98a7`, `--color-foreground #e9eef5` (dark);
  `#0b7a70 / #15803d / #dc2626 / #8f6207 / #d7dee6 / #dbe2ea / #5b6675 /
  #14181f` (light).
- **`layout.attributionLogo` defaults to TRUE in v5** and paints an outbound
  tradingview.com link onto the chart pane.
- The library builds **one chart out of 7 stacked `<canvas>` layers** (pane ×2,
  right price scale ×2, time scale ×2, corner ×1). Counting canvases is
  therefore not a way to count charts: measured 7 canvases / 1 chart instance
  across three unmount→remount cycles and a client-side navigation away and
  back, which is what proves `chart.remove()` in the effect cleanup works.
- Adding the dependency with a plain `npm install` (never
  `--package-lock-only`, per AGENTS.md) also dropped 27 lock entries: the
  `vitest → vite` **optional peer** esbuild 0.28.1 and its 26 platform binaries.
  The `grep -c "darwin-\|linux-x64\|linux-arm64" package-lock.json` canary
  moved 202 → 190 for that reason alone. Every top-level platform variant
  (esbuild 0.25.12, `@next/swc-*`, `lightningcss-*`, `@rolldown/binding-*`)
  survived, and the suite is green without the nested copy — this is not the
  v2.99.5 failure mode, where a *required* dependency lost its darwin/linux
  variants.

**Decision:** lightweight-charts is used for the price replay only, loaded
through `next/dynamic(..., { ssr: false })` from a client component. A theme
bridge (`components/charts/lw/theme.ts`) reads the tokens and asserts their
parseability in dev; translucent shades come from a local `withAlpha()` helper,
never `color-mix()`. `attributionLogo` is set to `false` — this app is offline,
local-first and zero-telemetry, so an outbound link in the UI is unacceptable;
the Apache-2.0 attribution is carried in package metadata and here instead.
`layout.background` is `transparent` so the Card gradient shows through.
Re-theming rides a single `MutationObserver` on `document.documentElement`'s
`class` attribute, mutating the chart imperatively with no React state.

**Why not the obvious thing:** Converting every chart at once. It would have
looked consistent and broken the monthly PDF in a way that only shows up on
paper — the one output nobody re-checks after a chart refactor.

**Invalidated if:** The `@media print` block leaves `app/globals.css`, or
/reports/monthly stops rendering `EquityCurve`; or the theme tokens stop being
literal colours, at which point the dev assertion in
`components/charts/lw/theme.ts` fires and the chart needs a
`customColorParsers` entry rather than a token read.

## 2026-08-09 — The desktop build ran every step twice

**Context:** Investigating why `npm run desktop:build` took so long.
**Measured / found:** The log showed two "Creating an optimized production
build" and two "assembling desktop-dist". `desktop:build` ran `next build &&
build-desktop.mjs` and then invoked Tauri, whose `beforeBuildCommand` is
`npm run build && npm run desktop:bundle` — the same two steps. Cost per
duplicate pass: a Next compile, a typecheck (19.3s + 13.2s across the two), a
template-DB seed, and a copy of an 81 MB node.exe into a 168 MB tree.
**Decision:** `desktop:build` is now just `node scripts/tauri-build.mjs`.
Measured after the change: 292s wall, 1 Next pass, 1 assembly pass.
**Why not the obvious thing:** Removing `beforeBuildCommand` instead would
break CI — tauri-action reads it from the config and silently ignores one
passed as a workflow input. The AGENTS.md "always rebuilds the bundle" rule
still holds; it just happens once, where Tauri asks for it.
**Invalidated if:** `beforeBuildCommand` is removed from tauri.conf.json, or
`tauri-build.mjs` ever starts depending on desktop-dist existing beforehand.

## 2026-08-09 — Light-theme gold is #8f6207, not the handoff's #9a6b08

**Context:** Applying the v3 design tokens to light mode.
**Measured / found:** The handoff proposed ~#9a6b08. Against this app's real
light canvas #f4f6f9 that measures **4.33:1 — under the 4.5:1 AA floor**. It
only clears AA against pure white (4.69:1), and gold is small text here (charge
lines, MTF splits, warnings). #8f6207 holds the hue at 4.95:1. The ceiling at
this hue/saturation is ~#966808 (4.53:1), which is why the light ramp's bright
end is pinned there rather than at the dark theme's #f5d478.
**Decision:** Ship #8f6207; violet #6d28d9 verified at 6.56:1 and kept as-is.
**Why not the obvious thing:** Following the handoff verbatim. It gave hues
with no measured ratios, unlike the #0b7a70 precedent it was citing.
**Invalidated if:** The light canvas changes from #f4f6f9, or gold stops being
used for small text.

## 2026-08-09 — Table row separators need ~1.48:1, not the handoff's 1.12:1

**Context:** Applying the v3 token sheet, which specifies
`--color-rule: rgba(148,163,184,.08)`.
**Measured / found:** That composites to **1.12:1** over the new panel gradient.
A previously shipped value at 1.08:1 was found invisible on tables 250+ rows
deep; the fix then measured 1.48:1 and worked. Only those two data points exist,
so any value between them is a guess. Alpha .23 measured **1.471:1 live in the
browser** against the actual painted table background, on a 252-row table.
**Decision:** Keep the proven ratio in the rgba form v3 wants (alpha .23).
Documented inline at the token.
**Why not the obvious thing:** Following the spec. It never re-ran the original
measurement, and a header band plus a drop shadow give a table its OUTER
structure — they do nothing to separate row 180 from row 181.
**Invalidated if:** The panel background lightens materially, or tables stop
rendering more than ~50 rows.

## 2026-08-12 — A lens group carries its own ids, not a predicate that "should" match

**Context:** The Lenses page groups the book six ways and offers to delete any
group. Both `monthGroups` and the hand-entered group could have been expressed
as a scope the resolver re-derives (`dateRange` over the month; "everything with
no import batch").
**Measured / found:** They do not agree. A trade bought 20 Aug and sold 4 Sep is
filed under **September** by the month lens (exit date for a closed trade), but
`dateRange 2026-08-01→2026-08-31` with basis `either` **also matches it**. The
group would say 1 and the delete would remove 2. `tests/lenses.test.ts` pins
this on the real case.
**Decision:** Month and hand-entered groups carry `{kind:"filter", ids}` — the
group's own ids. Broker, segment and import-file groups keep their predicate
scopes, because there the predicate IS the grouping key and the two are the same
set by construction.
**Why not the obvious thing:** A predicate scope is smaller and reads better.
It is also how a confirmation dialog comes to show a number that is not what
gets deleted, which is the one failure `lib/domain/delete-scope.ts` exists to
prevent.
**Invalidated if:** `effectiveDateOf` stops being "exit for closed, entry for
open", or `DateBasis` gains a mode that matches the month lens exactly.

## 2026-08-12 — Delete writes a snapshot first, and aborts if it cannot

**Context:** Deletion grew from "the rows I selected" to whole import files and
date ranges. `restoreDatabase` is whole-database wipe-and-reload, so it can undo
one delete only by discarding everything since.
**Measured / found:** No undo, soft-delete or recycle concept existed anywhere
(`grep -rn "undo|soft.?delete|deletedAt|trash"` over app/ components/ lib/
returned only prose). The per-trade `audit_log.beforeJson` snapshot covers the
trade row **only** — not its legs, not its attachment rows, and the attachment
bytes were `rmSync`ed outright, which was the one genuinely irreversible step.
**Decision:** `lib/trash.ts` writes a scoped JSON snapshot before the
transaction and MOVES attachment bytes into it after the commit instead of
unlinking them. If the snapshot cannot be written, the delete does not happen.
Snapshots live beside the database (not inside it, not in backups) and are never
auto-purged.
**Why not the obvious thing:** A `deleted_trades` table is the conventional
answer. It sits inside the database the user may be about to restore, and it
travels inside backups — so restoring a backup would resurrect its own trash.
Auto-purge was rejected outright: a scheduled job destroying the last copy of
deleted work, on a schedule nobody chose, is a worse failure than a folder that
grows.
**Invalidated if:** Attachment volumes make unbounded retention impractical —
at which point the answer is a size report and a prompt, not a silent sweeper.

## 2026-08-12 — Back navigation: an in-app route stack, not `history.length`

**Context:** The app needed a back affordance. Assessed three shapes against the
actual route tree: browser-style global history, per-feature breadcrumbs, and
back-on-drill-downs.
**Measured / found:** The tree is **flat — 40 routes, zero dynamic segments**.
`reports/` and `targets/` have no index page, so a breadcrumb would render
"Reports › Monthly" where "Reports" is not a page. The only nested route,
`/trades/report`, opens via `window.open(…, "_blank")`, where back means
nothing. `grep -rn "router\.back"` over app/ and components/ returned **zero
matches**. The real gap is the Tauri shell, which has no browser chrome at all.
**Decision:** A module-level pathname stack (`components/layout/nav-history.ts`)
decides whether to offer the control and what to call it; `router.back()` still
performs the navigation. Breadcrumbs rejected. The Alt+← and mouse-button-4
handlers call `preventDefault()`.
**Why not the obvious thing:** `history.length` counts whatever preceded the app
in that tab, is browser-capped and never decreases — it cannot answer "is there
an earlier screen of THIS app". And binding the gestures without
`preventDefault` risks the worst outcome: on the web the browser goes back and
so do we, landing the user two screens away.
**Invalidated if:** The route tree gains real drill-downs with a nameable
hierarchy — breadcrumbs become the better answer at that point.

## 2026-08-12 — Import detection: a broker detector must present evidence, and shape is not evidence

**Context:** A Groww stocks order-history export imported as broker "zerodha" —
111 rows added, priced at Zerodha's rates, reported as success.
**Measured / found:** Running all seven real exports through the live registry
found not one misroute but two: `detectZerodha` claimed the Groww file at 0.30
on `symbol`+`isin` column shape, and claimed the Paytm Money tradebook at 0.35
because its filename contains the English word "tradebook". Zerodha's own
Console P&L, meanwhile, won only by a filename clamp at 0.30 — its trade table
starts past row 25 and at column B, where the header scan never looked. No
test asserted any detector REFUSES a foreign file; the kotakish regression
fixture stayed green only because it lacked an `isin` column. The generic
mapper scores a constant 0.05 and `detectParser`'s bar is `> 0`, so any
detector returning 0.06 on a foreign file steals it from the mapper.
**Decision:** Every broker detector must qualify on the broker's NAME (filename)
or a verified in-content fingerprint before shape adds anything; unqualified →
0 → the mapper asks. Fingerprints per format live in docs/BROKER_FORMATS.md,
each verified against a real export; `tests/import-detection-matrix.test.ts`
runs redacted copies of those exports through the registry and pins the full
cross-broker refusal matrix.
**Why not the obvious thing:** Raising the generic mapper's 0.05, or a global
threshold. Both treat the symptom: a detector that scores foreign files at all
will eventually outscore any constant. The rule has to live where the evidence
is read.
**Invalidated if:** A broker ships an export that genuinely carries no
distinctive content and no name — at which point that format belongs to the
generic mapper permanently, not to a weaker fingerprint.

## 2026-08-12 — Dhan GTR "73 rows, 0 trades": the import was innocent

**Context:** A GTR batch showed 73 rows / 73 added / 0 skipped while the trades
table showed none of them — rows in, nothing out, silently.
**Measured / found:** The same real GTR file replayed end-to-end (detect →
parse → commit) into a scratch DB: detected at 0.98, parsed to exactly 73
paired positions (92 bill lines pair down — `rowCount` counts positions, not
file lines), committed with added=73 and 73 trades tagged with the batch id.
`added++` sits on the line after the insert inside one transaction, so the
count and the rows cannot diverge at commit. The divergence was POST-commit:
trades removed later by a non-batch delete scope or a restore, with the batch
row left standing — the mirror of the "Import record removed" seam the Lenses
page surfaces.
**Decision:** No commit-path change. The pairing arithmetic is now visible
instead of alarming: parsers that pair set `sourceRows`, and the imports table
shows "92 → 73" with the pairing explained on hover.
**Invalidated if:** A future batch reproduces added > 0 with zero tagged trades
in a database whose audit log shows no delete and no restore between.

## 2026-08-12 — Paytm Money gets a parser: the unpublished-format rule, deliberately set aside

**Context:** AGENTS.md forbids inventing a parser for a format nobody has
published — written when Kotak Neo, Paytm Money and Sahi documented their
export columns nowhere, so any parser would have been guesswork with silent
failure modes.
**Measured / found:** A real Paytm Money tradebook export now pins the layout:
metadata rows 1–4 (`UCC`/`Name`/`PAN Number`/`Period`), header on row 5, one
row per execution WITH a full charge breakdown (Brokerage, ETT, GST, STT,
SEBI, Stamp Duty) — richer than Zerodha's tradebook, which carries no charges.
The sample held zero data rows: headers and fingerprints are VERIFIED, value
semantics are INFERRED and tested against synthetic rows only.
**Decision:** Build `paytm-tradebook.ts` — the rule's reason (unpublished ⇒
guesswork) no longer holds for this one format. The parser refuses any row it
cannot read rather than coercing, and its warnings say charges are stated, not
computed. Kotak Neo and Sahi remain unpublished and remain with the generic
mapper; the detection matrix proves no parser claims their files.
**Invalidated if:** A populated Paytm export contradicts the inferred value
semantics — reconcile the first live import against a contract note before
trusting the charge figures.

## 2026-08-12 — Broker API research: recorded so it is not re-derived, NOT built

**Context:** Researched direct broker-API sync for the journal. Nothing here is
implemented; this entry exists so the findings and the risks survive.
**Measured / found (per-broker access instruments — CORRECTED 2026-08-12 in a
second pass against live vendor docs; three items in the first recording were
wrong and are struck through here so the correction itself is on the record):**
- **Upstox** — "Analytics Token": 1-year validity, READ-ONLY (cannot place
  orders). **BUT the Portfolio and Trade-P&L endpoints — exactly what a journal
  reads — require a whitelisted STATIC IP** (one primary + one secondary per
  user, set in the developer console). Home broadband is dynamic, so the one
  broker with a year-long token is the HARDEST to reach from a desktop app.
- **Dhan** — ~~validity configurable 8 hours–30 days; TTOP secret for 1-year
  read-only data~~ → access tokens are **24 hours** (renewable via
  `POST /v2/RenewToken`); the **12-month** validity belongs to the API
  key/secret pair, not the token; no long-lived read-only token exists in the
  public docs. TOTP is an auth step, not a token class. Trading APIs free;
  only market-data APIs are paid. Re-verify against the owner's own account
  before building — recollection and public docs disagreed once already.
- **Angel One** — SmartAPI is **free**; api_key + clientId + PIN + TOTP secret;
  fully automatable; session to midnight with a refreshToken; requires
  `X-PrivateKey` / `X-ClientLocalIP` / `X-ClientPublicIP` / `X-MACAddress`
  headers on every call.
- **Groww** — API key + secret + TOTP; daily expiry; automatable;
  **₹499+tax/month** — the only broker charging for basic access.
- **Zerodha** — ~~implicitly the costly one~~ → the **Personal tier is FREE**
  and covers orders/trades/holdings/portfolio; paid Connect (₹500/mo) adds only
  market data, which a journal does not need. request_token via browser
  redirect expires at midnight and automating that login is outside ToS.
Four of five can run unattended; Zerodha needs a human daily. The first
recording concluded Upstox's year-long token was "the correct instrument" —
right on security (a leaked token cannot trade), wrong on reachability: without
a static IP it cannot serve a home desktop user at all. **Build order that
follows from the corrected facts: Angel One first** (free, unattended, and its
Tax P&L export is already parsed, so API results reconcile against a
known-good file import), then Dhan, then Zerodha as assisted-sync, with
Upstox/Groww last (blocked on static IP / on paying).
**Two prerequisites recorded as blockers, not follow-ups:**
1. AGENTS.md declares this journal single-user and OFFLINE. API sync or
   mailbox polling changes that posture and must be a deliberate recorded
   decision, not drift.
2. Credentials currently live in the local DB in plain text. Defensible for
   one daily-expiry token; NOT defensible for a 30-day token, a TOTP secret (a
   permanent second factor), or mailbox credentials. Encryption at rest comes
   FIRST.
**Decision:** Record only. `lib/import/types.ts` already carries the
`ApiImportSource` seam (`kind: "api"`, `fetchTrades()`), so none of this
requires re-architecture when it is deliberately taken up.
**Invalidated if:** A broker changes its token model or pricing — re-verify
against the broker's own docs before building anything on this table.

## 2026-08-12 — Lenses is HYBRID-gated, and the gate is field omission, not CSS

**Context:** The new Lenses page sat on the free/Pro line: its grouping is
journal hygiene, its per-group win rate/profit factor/expectancy/avg R is the
intelligence layer the licence sells.
**Measured / found:** The client computed `computeKpis` itself, so any
client-side lock would have been decoration — the numbers were already in the
browser. Verified after the fix by fetching `/lenses` unlicensed: the words
`winRate`/`expectancy` appear ZERO times anywhere in the SSR+RSC payload, and
reappear the moment the key is restored.
**Decision:** Grouping, counts, net P&L, charges and the per-group DELETE stay
free (deleting a bad import is the recovery path from an import bug — gating it
turns a product defect into a hostage situation). The edge object is computed
server-side (`lib/domain/lens-edge.ts`) through an ALLOW-LIST split and shipped
as `edge: null` when unlicensed. Three visually distinct cell states: a number;
"—" = cannot be computed (invariant 6); a Pro chip = computed, not yours yet.
**Why not the obvious thing:** Wrapping the page in ProGate — that gates the
free half and breaks invariant 7. Or blurring client-side — that ships the
numbers and pretends not to. Field omission is the only version that survives
devtools.
**Invalidated if:** `Kpis` gains a field — it lands on NEITHER side until a
human adds it to one allow-list, and `tests/lens-gating.test.ts` pins the split.

## 2026-08-12 — Per-account capital: the write path now lands where the read looks

**Context:** "Compounded +₹X" while the number on screen never changed.
**Measured / found:** `getCapitalSummary` reads `account.equityCapital ??
settings`; both writers wrote ONLY the settings row, and `pnlRolledIn` was
global — compounding in account A marked account B's realised P&L rolled in.
Pinned by a failing-first temp-DB test.
**Decision:** Migration 0044 moves `pnl_rolled_in` onto accounts, back-filling
the legacy global value into the DEFAULT account (single-account installs —
the overwhelming case — are exactly right; multi-account history is genuinely
ambiguous and the default account is the least-wrong owner). Compounding
refuses the aggregate view outright: its `available` sums every account, and
compounding a cross-account figure into one account moves money between books
(invariant 9).
**Invalidated if:** capital ever becomes bucket-per-account-per-bucket rows —
re-derive the rolled-in ownership then.

## 2026-08-12 — Backups: introspected coverage, and licence/trial state stays on the machine

**Context:** Restore silently lost MTF margin uploads and NSE index membership;
a shared backup shared the buyer's licence key; restoring an old backup lowered
the clock ratchet.
**Measured / found:** `BACKUP_TABLES` listed 26 of 30 schema tables, and the
guard test asserted a COUNT of 26 — structurally unable to notice a missing
table. The settings dump carried `license_key`, `trial_started_at`,
`clock_high_water_mark` verbatim; `settings-baseline.ts` had already excluded
all three from "restore defaults", so the asymmetry was an oversight, not a
policy.
**Decision:** v3 envelope: all 30 tables; the guard test now enumerates the
schema (`is(v, SQLiteTable)`), so table 31 cannot ship unbacked-up. Dump
REDACTS the three machine columns; restore PRESERVES this machine's values
whatever the envelope carries; and a table ABSENT from an older envelope is
left untouched rather than wiped — absent means "the backup never claimed to
know", empty means "known empty".
**Invalidated if:** a table is deliberately excluded from backups — it goes on
the test's EXCLUDED list with a written reason, which is the point.

## 2026-08-12 — Integrity sweep (v2.99.77): the account boundary is enforced where the table is touched

**Context:** The defect register (this file, above) left eleven items after the
v2.99.75/76 releases. Nine were variations of one disease: code that touches an
account-scoped table without resolving the account through
`getSelectedAccountId`/`getWriteAccountId`.
**Measured / found:** Sessions accepted a client-supplied accountId verbatim
and could MOVE a session across accounts on update; IPO inserts used
`getSelectedAccountId() || 1` (every aggregate-view IPO landed in account 1)
and IPO DELETE was entirely unscoped; every leg mutation in
`lib/queries/staged.ts` took a raw trade id unchecked; archiving the selected
account stranded the user pointing at an account the switcher no longer
showed; and the guard test that should have caught all of this asserted only a
LIST OF TABLE NAMES — including "positions", a 28-column table nothing had
ever read or written.
**Decision:** One pattern everywhere: writes resolve the account at the point
of touch (`getWriteAccountId` for inserts, an explicit own-account check for
mutations by id), reads keep the `accountId > 0 ? filter : all` shape, and the
registry test now maps each account-scoped table to OWNER FILES and fails
unless each owner invokes a resolver. The dead `positions` table is dropped
(migration 0045). IPO exit charges now come from the charges engine +
`charge_config` via an injected charger; the hard-coded rates survive only as
the documented no-broker fallback.
**Why not the obvious thing:** Trusting route-level fixes alone. The registry
test proved the point immediately: it flagged `app/api/capital/route.ts` as an
owner that never resolves the account — correctly, because D1's fix had moved
that responsibility into `compoundRealised()`. A name-list test can never make
that distinction; an owner-map test just did, on its first run.
**Invalidated if:** A future table's boundary is legitimately owned by a file
that delegates resolution (like the capital route) — declare the DELEGATE as
owner, not the route.

## 2026-08-12 — Exercise STT stays a named constant; futures STT moves to charge_config

**Context:** D18 — `lib/analytics/settlement.ts` hard-coded `exerciseSttPct`
(0.125% on intrinsic at option exercise) and `futExitSttPct` (0.02% futures
sell), with only the delivery rate read from `charge_config`.
**Measured / found:** `futExitSttPct` is exactly `charge_config`'s `sttPct`
for the `future` segment — same statute, same shape. `exerciseSttPct` is NOT:
config's option-segment `sttPct` is the premium-sell rate; exercise STT
applies to intrinsic value under a different rule, and no column carries it.
**Decision:** Futures STT now reads from config (any broker's row — statutory
rates are broker-invariant). Exercise STT remains a named default in
`DEFAULT_SETTLEMENT_RATES`, deliberately: it feeds one advisory figure on the
physical-settlement panel, and adding a `charge_config` column for it would
put a rate in the editor that no charge computation ever uses.
**Invalidated if:** exercise STT starts feeding a booked charge rather than an
advisory — then it earns the column.

## 2026-08-12 — Secrets at rest (v2.99.80): envelope encryption, DPAPI-wrapped on Windows, no new dependency

**Context:** The broker-API roadmap ends with stored TOTP secrets — permanent
second factors. Prerequisite recorded earlier today: encryption at rest comes
BEFORE the first such credential field exists. Live plaintext already existed:
`settings.license_key` and `broker_connections.api_key`/`access_token` (the
shipped Kite/Dhan pulls).
**Measured / found:** The Tauri shell and the Node sidecar are separate
processes, so an OS-keychain design needs an IPC channel that does not exist;
`tauri-plugin` routes also do nothing for `npm run dev` and CI. Windows
PowerShell's `-Command` glues trailing argv into the command string instead of
populating `$args` — the first DPAPI implementation silently fell back to the
KDF wrap on every Windows box, caught by the suite's provider assertion; blobs
now travel in environment variables.
**Decision:** One AES-256-GCM data-encryption key per install, stored WRAPPED
in `vault.key` beside the DB — DPAPI (CurrentUser) on Windows via PowerShell,
scrypt over the machine identity elsewhere. Column values wear a `venc:`
envelope; reads accept both forms and a lazy sweep upgrades pre-vault
plaintext (SQL migrations cannot run crypto — a migration file claiming to
encrypt would lie). Unreadable vault = honest degradation: licence reads
unlicensed with "re-paste the key from your purchase email", broker pulls ask
to re-enter credentials; new-secret WRITES refuse loudly rather than storing
plaintext beside a broken vault. Backups now redact broker credentials the way
they already redact the licence key; secretless connection rows are dropped on
restore.
**Why not the obvious thing:** An npm keychain/DPAPI module — this repo's
lockfile is a minefield (see "Adding a dependency") and `node:crypto` +
PowerShell covers every runtime. And no claim of defending against same-user
malware: no user-mode design does, keychain included. The claim is exactly
"the database file alone carries nothing usable off this machine."
**Invalidated if:** The Tauri shell grows a secrets IPC — then DPAPI/KDF
becomes the fallback and the OS keychain the primary, changing only `wrapDek`.

## 2026-08-12 — Angel One sync (v2.99.90): the first unattended pull, and why it is safe to be

**Context:** The broker-API roadmap said Angel One first — free, TOTP-automatable,
and reconcilable against the Tax P&L importer already shipped. The prerequisite
(v2.99.80 encryption at rest) exists; the posture precedent (Broker Connect is
explicit opt-in, pulls are user-clicked, nothing runs in the background) was set
by the Kite/Dhan connections and is unchanged here.
**Measured / found:** SmartAPI's login contract (loginByPassword with clientcode
+ PIN + TOTP, jwt to midnight) is VERIFIED against published docs; the
trade-book ROW shape is INFERRED from doc examples — mapped defensively with
candidate field names and refuse-don't-coerce, flagged in the pull's own
warnings until a live pull is reconciled once. TOTP is RFC 6238 SHA-1/30s/6 —
implemented in ~40 lines of node:crypto and pinned to the RFC's own test
vectors, because `otplib` would mean touching the lockfile minefield for an
HMAC.
**Decision:** Three security properties, each enforced structurally, not by
convention: (1) all four credentials — API key, client code, PIN, TOTP secret —
live vault-encrypted, the extras as ONE venc: JSON blob in the new
`broker_connections.auth_json` (migration 0046), and a broken vault REFUSES the
save; (2) the module surface is READ-ONLY — login + trade book and nothing
else, with the export list pinned in tests so an order method is a CI failure;
(3) the classic paste error (the 6-digit CODE where the SECRET belongs) is
rejected at save time with an explanation, because it would otherwise surface
tomorrow as an inscrutable broker rejection.
**Why not the obvious thing:** Storing the day's jwt and refreshing it — a
session to midnight is worth nothing tomorrow, so each pull logs in fresh from
the TOTP secret instead; one fewer secret class to hold. And no background
scheduler: the trade book covers only the current day, but an unattended timer
contacting a broker is a posture change the user has not asked for — the pull
stays a button.
**Invalidated if:** A live pull shows field names outside the candidate set —
extend the row mapping and move the trade-book shape from INFERRED to VERIFIED
in this entry.

---

## 2026-08-12 — Remote revocation (v2.99.91): the list travels down, nothing travels up — and four "no kill switch" promises were retired

**Context:** The owner sells annual licences and wanted a way to withdraw one
from a buyer who keeps using it past what they paid for, after three warnings
and a grace period. Four places in this repo promised in writing that no such
mechanism would ever exist, on the grounds that it "would mean phoning home".
**Measured / found:** That premise was already false. `check_for_updates` in
`src-tauri/src/lib.rs` runs a `tauri-plugin-updater` check at every launch —
unconditional, not opt-in, not surfaced. So the network posture did not change
with this feature; only the honesty of the copy did. Three published claims
were checked and were wrong as shipped: `docs/sales/landing-page.html` ("the
only network activity is optional and explicit… Both can be left off"),
`README.md` ("except the two things you explicitly allow"), and
`docs/client/INSTALLATION_GUIDE.md`, whose internet-needs list omitted the
launch check entirely. Also found: `reqwest` with the rustls backend is already
in the dependency tree via the updater plugin, so the fetch adds a direct
handle to an existing crate rather than a new TLS stack (0.13 renamed the
feature to plain `rustls`; `rustls-tls` is the 0.12 spelling and fails
resolution).
**Decision:** An Ed25519-signed list, fetched by the Rust shell inside the
existing update check and written to app-data; the web app reads the cached
file and never makes the request itself. Five properties, each pinned by a
test: (1) **pull-only** — the request carries no key id, no machine id, no
account, nothing; the same public file is served to everyone, and which key it
names is decided before the download, not by it; (2) **warn, then lock** — an
entry's `effectiveFrom` opens a grace window (14 days by default) during which
every Pro screen shows a countdown banner and *nothing* is withheld, so nobody
discovers a withdrawal as a dead screen; (3) **anti-rollback** — the accepted
`issuedAt` ratchets in `settings.revocation_list_issued_at`, so restoring an
older list cannot undo a newer one, and a REJECTED list must not advance the
ratchet (else a forgery locks the machine out of the genuine list that
follows); (4) **reversible** — publishing a newer list without the id
un-revokes, without shipping a build; (5) **fails open** — no list, a corrupt
file, a captive-portal HTML page, or any signature failure all resolve to
"active". The build-time `REVOKED_KEY_IDS` list stays as the permanent half:
publish the signed list so a key stops soon, run `license-revoke.mjs` so it
never returns in a later build.
**Why not the obvious thing:** A malformed `effectiveFrom` fails CLOSED — the
one deliberate inversion. Treating an unparseable date as "grace forever" means
a typo in a published list silently grants a permanent reprieve, and the
publisher would never learn. The signature already makes a malformed date the
vendor's own mistake, and re-publishing fixes it in a launch. Also rejected:
adding an opt-out toggle for the update check to make the old copy true again.
The check is how a signed release and a revocation both reach a user; making it
optional would make the feature optional. The copy was corrected instead — all
four "no kill switch" promises rewritten, in `lib/license.ts`,
`scripts/license-revoke.mjs`, `docs/owner/LICENSE_OPERATIONS.md` and
`README.md`, and the three false network claims restated to say plainly that
one download-only check runs at launch and cannot be turned off.
**Where it is published, and why not the obvious place:** a permanent GitHub
release tagged `revocations` holding one asset — NOT `releases/latest/download/`
beside `latest.json`, which was the first design. `latest` re-points at every
new app release, so a list uploaded to v2.99.91 would 404 the moment v2.99.92
shipped without someone remembering to re-upload it: a revocation silently
un-revoking itself, with nothing on screen and no error anywhere. A tag that
never moves makes publishing one `--clobber` upload and makes app releases
incapable of disturbing it.
**Two limits stated rather than hidden** (they are in the module header, the
owner docs and the sales copy): a machine kept permanently offline never
receives the list, and nothing here survives someone patching the binary. This
raises the cost of copying; it is not DRM. A third, smaller one is in
`lib/revocation.ts`: deleting the cached file un-revokes until the next launch
re-downloads it — the ratchet defends against an OLDER list displacing a newer
one, not against someone with write access to their own disk.
**Invalidated if:** The updater launch check is ever made optional or removed —
the fetch rides on it and would need its own posture decision; or a future list
needs to name something other than a key id, which would change the canonical
bytes and invalidate every signature already published.

---

## 2026-08-12 — The revocation list's own release must be a PRERELEASE, or it steals `releases/latest` and kills auto-update

**Context:** v2.99.91 publishes the signed revocation list to a permanent
`revocations` release rather than to the app release, because `releases/latest`
re-points at every new version and would silently 404 the list. That reasoning
was right and is unchanged. What it missed is the hazard in the other
direction.
**Measured / found:** `gh release create revocations` (no flags) was run at
18:09 UTC. Querying `/repos/…/releases/latest` immediately after returned
`tag_name: "revocations"`, `assets: [revocations.json]`, **no latest.json** —
GitHub resolves "latest release" as the most recent non-draft, non-prerelease
release **by creation date across every tag**, not by semver and not only over
version-shaped tags. `plugins.updater.endpoints` in `tauri.conf.json` is
`https://…/releases/latest/download/latest.json`, so that URL began 404ing:
auto-update was dead for every installed copy, and **silently**, because the
updater is deliberately fail-open (`Err(e) => eprintln!` and return). Nothing on
any screen would ever have said so. `gh release edit revocations --prerelease`
restored it; the direct
`releases/download/revocations/revocations.json` URL returned HTTP 200 with
byte-identical content throughout — the prerelease flag does not touch it.
**Decision:** `--prerelease` is mandatory on that release and is now in the
publisher script's header and printed instructions, `LICENSE_OPERATIONS.md` §4,
and the `REVOCATIONS_URL` doc comment in `src-tauri/src/lib.rs`. The runbook
also carries the post-hoc check, because the failure is invisible without it:
`gh api repos/…/releases/latest --jq .tag_name` must print a `v…` version.
**Why not the obvious thing:** Repointing the updater at an explicit versioned
URL would remove the coupling, but every ALREADY-INSTALLED copy has
`releases/latest/…` baked into its binary — the fix would reach nobody who
needs it. The endpoint has to keep resolving.
**The general lesson, which is the reason this entry exists:** two fail-open
mechanisms were stacked without anyone asking what their silence adds up to.
The updater fails open so an offline user is not nagged; revocation fails open
so an offline user is not locked out. Both are right individually. Together
they mean a totally broken update path produces no error, no dialog, and no log
a user would ever see — it is indistinguishable from "no update available".
Any future fail-open path needs a deliberate way to be *observed* failing.
**Invalidated if:** GitHub changes how `/releases/latest` resolves, or the
updater endpoint stops using the `latest` alias.

## 2026-08-29 — Perf quick wins: wallpaper compositing, router cache 120s, gzip off, chart mount animation off

Four same-day changes, each a deliberate deviation from a default:

- **Wallpaper moved from `background-attachment: fixed` on body to a
  `position: fixed` body::before layer** (`app/globals.css`). attachment:fixed
  + cover is Chromium's slow path — the background repaints on every scroll
  instead of compositing; a fixed pseudo-element scrolls as its own layer.
  Same visual stacking (scrim gradient over image over canvas colour, all
  under content via z-index:-1); the print block hides the layer with
  `content: none`. `tests/skin.test.ts` pins the structure and that
  background-attachment does not come back.
- **`experimental.staleTimes.dynamic` 30 → 120** (`next.config.ts`). Safe
  because every write surface audited (37 files grep'd for `router.refresh()`:
  settings, editors, imports, backup, cash, risk, behavior tools) invalidates
  the client router cache on write — a stale entry can only be one the user
  never wrote through.
- **`compress: false`** (`next.config.ts`). The server only ever serves
  loopback (desktop sidecar / localhost dev); gzip on a loopback link is pure
  CPU for zero bandwidth benefit.
- **Recharts mount animation off everywhere** (`isAnimationActive={false}`;
  dashboard equity curve + outcome mix bar were the last two holdouts). Every
  DB-reading route is force-dynamic, so charts REMOUNT on each navigation and
  the 700ms draw-in replayed every visit — main-thread work exactly when the
  page should feel settled. This also retires the prefers-reduced-motion
  guards those two charts carried (2026-08-10 audit): no animation at all
  satisfies reduced-motion trivially.

**Invalidated if:** the app ever serves non-loopback clients (compress), a
write path stops calling router.refresh() (staleTimes), or charts stop
remounting per navigation (animation could return behind a reduced-motion
guard).

## 2026-08-29 — /reports/tax + /reports/harvest: column projection, on-click ITR export; an added WHERE reorders ties

Perf sweep at 25k trades (data/perf.sqlite, readonly). What was measured:

- **/reports/tax served 4.97 MB, of which 4.79 MB was RSC flight** — 21,540
  ITR-schedule export rows passed as props to the client `ExportButtons` and
  never rendered. The rows now come from `/api/tax-itr` on click (the /cash
  ledger-export pattern, `lib/queries/tax-itr.ts` shared by page and route so
  they cannot drift). `JSON.stringify` of those rows is only ~18 ms — the cost
  was React's flight serialisation plus shipping/parsing 4.8 MB per visit.
- **Whole-book `select *` (74 cols) is ~250–290 ms in SQLite alone at 25k
  rows; the 15-col tax projection is ~81 ms and the 11-col harvest projection
  ~60 ms**, same rows in the same order (id-sequence compared).
- **Pushing the pages' row filters into SQL is NOT safe here**: adding
  `WHERE is_open=…`/segment/sell_date changes the query plan and reorders rows
  that tie on (sell_date, created_at) — measured directly: the filtered
  harvest-lot and closed-trade sequences differed from the JS-filtered ones,
  and the taxByFy per-FY float sums differed. Tie order feeds visible row
  order (harvest's stable `allocate()` sort, the ITR export order) and float
  accumulation order. So `getTaxTrades`/`getHarvestTrades` are pure
  projections with no new WHERE, and the pages keep their JS filters —
  identical output by construction.
- **The exception is `getDividendLedgerEntries`** (SQL-filtered): its ORDER BY
  ends on the unique `id`, a total order no plan can permute — filtered rows
  and per-company sums proved bit-identical against the JS filter.
- **/corporate-actions was never slow itself** (17–26 ms warm; it reads an
  empty table). Its sweep median of 1.6 s / p95 5.5 s is head-of-line
  blocking: better-sqlite3 is synchronous, so while /trades (23.5 MB) or the
  old tax/harvest renders held the event loop, a concurrent /corporate-actions
  request measured 2.39 s. Shrinking the heavy routes is the fix; the page
  needs none.

**Invalidated if:** trades gains an index that makes filtered plans preserve
the full-scan tie order (re-measure, don't assume), or the ORDER BY gains a
unique tiebreaker column (then SQL filters become safe everywhere).

<!-- First entry goes here. -->
