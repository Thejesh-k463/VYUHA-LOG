# Decisions

Append-only. Newest first.

Facts that cost something to learn: measured numbers, choices where the obvious
option loses, surprising bug causes, deliberate deviations from a spec or
default, and things intentionally NOT done.

## 2026-09-04 — v3.9 W2: `/trades` server pagination, and the order that was never total

**Context:** `/trades` was the one route over the 1,500 ms median budget — 1,968 ms on the
25k perf book at v3.8 (DECISIONS 2026-09-04), where the whole account-scoped book crossed the
RSC flight stream in the wire shape and was then filtered in the browser. Paging it needs a
keyset, and a keyset needs a TOTAL order.

**`(sell_date, created_at)` was not one, and had not been since the first import.**
`created_at` is `datetime('now')` — SECOND resolution — and `lib/import/commit.ts` never sets
it, so **every row committed in one import batch carries the same `created_at`**. Measured:

| book | rows | tie blocks | rows inside a tie | largest block |
|---|---|---|---|---|
| owner's live journal (copy) | 905 | 174 | **842 (93%)** | 36 |
| `data/perf.sqlite` (seeded) | 25,001 | 550 | 1,125 (4.5%) | 3 |

The perf book barely ties because `scripts/seed-perf-db.mjs:246` writes near-unique ISO
timestamps — so **only the real book shows what this actually was**, and the seed would never
have caught it. Inside a block SQLite may return any order, and demonstrably returned
DIFFERENT orders for different plans: the /trades first page of the owner's Primary account
came back ascending by id (814, 816, 817…) while the all-accounts view over the same rows came
back descending (822, 821, 820…). **So the order within an import batch was unspecified until
v3.9, and is now `id DESC` = insertion order, newest first.**

**Every projection in `lib/queries/trades.ts` now ends on `desc(trades.id)`** (AUTOINCREMENT,
therefore unique). Red first, `tests/trades-total-order.test.ts`: three rows inserted in one
transaction with one `sell_date` and one `created_at` —
`AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 3, 2, 1 ]`.
Migration **0063** extends the hot-path index to `(account_id, sell_date DESC, created_at DESC,
id DESC)`. It **KEEPS the 0043 name** `trades_account_sell_created_idx`, because DECISIONS
2026-08-29 cites that name as the proof the hot path is an index scan; renaming it would have
made that record unverifiable. Measured on perf.sqlite, the third key is free: same plan
(`SEARCH trades USING INDEX trades_account_sell_created_idx`), 21.0 ms → 20.3 ms median.

**Before/after, on BOTH books** (`scripts/order-invariants.mjs`, per account: `taxByFy` to the
paisa, every harvest lot's id+status+qty, the holding-clock report and its first 15 symbols,
the /trades first-page ids):

- **taxByFy IDENTICAL** on every account of both books. **harvest realised STCG/LTCG
  IDENTICAL. The holdingClock report IDENTICAL.**
- What moved, and only this: the ORDER of the harvest lot list (same multiset — every lot's
  id, LT/ST status and quantity unchanged), the order of the clock's first-15 symbol list
  (same multiset), and the /trades first page. Owner Primary: 418 of 500 in-page positions
  moved and 12 ids differ in the SET — **every in-page move is a swap of tie-mates, and every
  id in the set difference is inside the single tie block that straddles row 500.** Machine-
  checked; nothing outside a tie block moved anywhere.

**Pagination.** `lib/queries/trades-page.ts` returns 500 rows per keyset page on
`(sell_date, created_at, id)`, plus `total` and `viewCounts` as SQL aggregates **over the whole
filtered set, never the page** — a count that quietly means "of what we fetched" is a
fabricated denominator (invariant 6). Every client filter is transcribed to SQL, `matchesView`
included; the pure predicate now lives ONCE in `lib/domain/trades-filter.ts` and the client
re-runs it over the page it receives, so a future drift NARROWS the table rather than showing
a row the filter excludes. `tests/trades-page-parity.test.ts` demands the two agree id-for-id
over 30 filter shapes; proven to bite by dropping the `isMarked` guard from the `open-gain`
arm — `AssertionError: expected [ 12, 9, 8, 7, 6, 4 ] to deeply equal [ 12, 9, 4 ]`. The
"Delete by…" scope keeps its WHOLE-book candidate list and a whole-filtered-set `viewIds`;
both are fetched when that dialog opens instead of on every page load. The KPI strip,
AcquisitionPanel, UnmarkedHoldingsPanel and IPO panel remain whole-book server projections
(`tests/golden-books.test.ts` pins them to the paisa).

**The bug only e2e could find.** `initialRows` is a `useState` initialiser, and an initialiser
does not re-run when the prop changes — so after `router.refresh()` (the account switcher,
every server action on this screen) the table went on rendering the PREVIOUS server render's
rows while the KPI strip above it showed the new account. `e2e/v297-surfaces.spec.ts` caught it
(expected 0 rows in the empty second account, got the first account's 125). Fixed by adjusting
state DURING RENDER on a changed prop — not in an effect; the `loading` flag is derived
(`servedKey !== filterKey`) for the same reason.

**Perf, 25k seed, prod build, 43 routes × 3 rounds:** `/trades` **1,968 → 1,063 ms median**
(p95 2,280 → 1,115), a 46% cut and comfortably inside budget. A second sweep on the same
server read 1,093. **Caveat, stated rather than buried:** this machine was slower than the W4
baseline across the board — overall median 910 → 954 (sweep 1) and 1,067 (sweep 2), with
`/settings` +27%, `/` +26%, `/review` +16%, `/reports/edge` +14%, `/ipos` +14%,
`/reports/discipline` +13%, `/strategies` +12% — routes that share nothing with this change but
the ORDER BY, which is plan- and time-identical (above). Read those as load, not regression,
and confirm on W3's double sweep.

**Invalidated if:** a W3 sweep on an idle machine still shows `/` or `/settings` above the W4
baseline by more than the ±40 ms that run called noise; or `lib/import/commit.ts` starts
writing a sub-second `created_at`, which would shrink the tie blocks but NOT restore a total
order (two rows can still share a millisecond).

## 2026-08-31 — The render-windowing pass: 6 budget breaches → 1 (v3.4.0)

**Context:** the v3.0.0 six-route deferral, opened by three parallel read-only analyses of the
routes themselves rather than by trusting the deferral note.

**The deferral note was wrong about half of them.** `docs/DECISIONS.md` (v3.0.0 entry) says the
six were "all payload-bound with no algorithmic defect found", and describes
`/strategies` and `/options-journal` together as "~6 s — 8,058 option rows rendered". Measured
against the code:

| Route | Rows from SQL | Real cause |
|---|---|---|
| `/strategies` | **673**, not 8,058 | **626 recharts mounts.** `ResponsiveContainer` returns null until its ResizeObserver fires, so the charts emit ZERO server HTML and then all 626 build their SVGs in one post-hydration commit. |
| `/options-journal` | 8,058 | ~21 MB of SSR HTML and ~56,000 form controls; every row a stateful component. |
| `/equity` | ~2,750 open | **Every row in the DOM, unvirtualised** — payload only ~1.2 MB. Not payload-bound. |
| `/risk` | ~3,460 × **2 arrays** | Two unvirtualised renders plus three more uncapped panels (~1,250 further rows). Not payload-bound. |
| `/lenses` | 25,001 | ~22 MB payload; **23 of 43 columns never read**. |
| `/trades` | 25,001 | 23.5 MB payload, already virtualised. |

**Decisions:**

1. **The ordering change was NOT made, deliberately.** Both "Invalidated if" clauses (v3.0.0
   perf pass; the tax/harvest entry) are discharged by appending `id` to the trades ORDER BY,
   and it is safe — but it is **not output-neutral**: it moves `taxByFy` per-FY sums in the last
   paisa (REAL rupee doubles, unlike the ledger's integer paise where SQL SUM and a JS reduce are
   bit-identical), can flip a harvest lot's `offsets`/`partial`/`carry` status, and changes which
   lots fill the holding clock's top-15. **A perf pass that changes what a page shows is no
   longer a perf pass.** It stays a separate change, with its before/after proof written first.
   **Worth knowing when it happens:** `created_at` defaults to `datetime('now')` (SECOND
   resolution) and `lib/import/commit.ts:536` never sets it, so **an entire import batch shares
   one `created_at`** — real-book tie groups are whole batches, not pairs.

2. **Everything here is a RENDER fix — no SQL predicate changed, no ordering changed.** That is
   what made five of six reachable without the ordering work. `tests/render-windowing.test.ts`
   asserts every `.orderBy` on `trades` is still the one canonical pair.

3. **`/equity` just needed `virtual`.** `DataTable` has supported row windowing since v3.0.0 and
   `/trades` uses it; the tracker simply never passed the prop. The comment in `data-table.tsx`
   saying the virtualizer is "fully inert for the tracker tables" was describing the state of
   things, not prohibiting it — reworded so it cannot be read as a rule.

4. **Client windows say what they hold back (`components/ui/show-more.tsx`).** A silent
   `.slice(0, 200)` reads as "this is your whole book". `useRowWindow` + `ShowMore` render a
   window and state the count, matching the harvest holding clock ("Showing 15 of N") and the
   lenses drill-down cap. **Only the DOM is windowed — every aggregate is still computed over
   the full set**, which is why no figure on any of these pages moved.

5. **Server components get a stated cap instead (`components/ui/capped-note.tsx`).** `/risk`'s
   expiry-obligations, Greeks and MTF-drift panels are server components and cannot hold the
   client state `useRowWindow` needs. They slice at `RISK_LIST_CAP` and must render a
   `CappedNote`; a test fails on a hardcoded numeric slice. `CappedNote` deliberately lives in
   its own module with **no `"use client"`** — importing it from `show-more.tsx` would drag three
   server components across the client boundary.

6. **`LazyMount` fixed `/strategies` without touching the data.** Charts mount on approach via
   IntersectionObserver with a `minHeight` placeholder — required, not optional, because a
   collapsing placeholder makes every card below jump up, fires every observer at once, and
   restores the storm with layout shift on top. Falls back to mounting immediately where
   `IntersectionObserver` is absent: a chart that never appears is worse than a slow one. The
   state is set from an observer callback, and the fallback goes through
   `Promise.resolve().then` — the repo bans `react-hooks/set-state-in-effect` outright.

7. **`/lenses` got its OWN projection, not a narrower `SLIM_TRADE_FIELDS`.** That constant is
   shared with `/trades`, which genuinely needs the wider shape. `LensesClient` was already typed
   `LensTrade[]` rather than `SlimTrade[]`, so a 19-column projection typechecked with no other
   change.

8. **`/trades` is the one route left over budget, and it is the one that needs the ordering
   change.** 23.5 MB of RSC payload for ~30 visible rows; it is already virtualised, so the only
   remaining lever is server pagination — which needs `LIMIT/OFFSET`, which needs a total order.
   Left explicitly for the ordering pass rather than half-fixed.

**Measured** (`perf:seed` 25,001 trades → `perf:sweep`, 42 routes × 3 rounds, production build):

| Route | v3.3.0 | **v3.4.0** | |
|---|---|---|---|
| `/strategies` | 6026 ms | **1022 ms** | −83% |
| `/options-journal` | 5770 ms | **1082 ms** | −81% |
| `/equity` | 3208 ms | **931 ms** | −71% |
| `/risk` | 2503 ms | **1349 ms** | −46% |
| `/lenses` | 2114 ms | **1276 ms** | −40% |
| `/trades` | 2256 ms | 2040 ms | untouched |
| **Breaches (of 42)** | **6** | **1** | |
| Overall median | 985 ms | **939 ms** | |
| Slowest route | 6026 ms | **2040 ms** | |

Rendered `<tr>` counts on the perf tier, before → after: `/equity` ~2,810 → **62**,
`/options-journal` 8,058 → **157**, `/risk` 1,257 → windowed + capped. `/strategies` SSR now
carries **626 sized placeholders and zero recharts markup**.

**A measurement trap, recorded.** The first post-fix sweep showed `/lenses` at 2557 ms — WORSE
than its 2114 ms baseline, on a route not yet touched — while `/trades` improved without being
touched either. Both were run-to-run variance; a second sweep put `/lenses` at 2063 ms. **Two
routes moving in opposite directions with no code change is the signature of noise.** Re-run
before believing a single sweep, in either direction.

**Invalidated if:** the trades ORDER BY gains a unique tiebreaker (then `/trades` becomes
fixable by server pagination and this entry's §8 is discharged), or `perf:sweep` enters CI (it
is not there today, which is why `tests/render-windowing.test.ts` exists as a source guard —
none of these five routes has an e2e spec either).

## 2026-08-31 — v3.3.0 post-release checks: updater cryptography, and a perf re-sweep

### The updater signature was verified against the PUBLISHED BINARY, not just decoded

`release:verify` decodes each `.sig`'s key id, which proves a signature was MADE by the right
key. It does not prove the signature VERIFIES over the bytes a user downloads — and that gap is
exactly what v2.98.0 fell into, where the build reported "signed" while every installed copy
rejected the update.

Done properly this time, using only the pubkey shipped inside the app
(`tauri.conf.json` → `plugins.updater.pubkey`): downloaded the published
`Vyuha_3.3.0_x64-setup.exe` (34,935,482 B), decoded the `windows-x86_64` signature out of the
published `latest.json`, and verified it. **✓ verifies.**

**The trap, recorded because it nearly produced a false alarm:** minisign's algorithm codes are
`Ed` = PureEdDSA over the file and **`ED` = HashEdDSA over a BLAKE2b-512 prehash**. Inverting
them makes a perfectly good release report "SIGNATURE DOES NOT VERIFY". The first run did
exactly that. **Verify the verifier before believing a negative result.** Node can do the whole
check with no dependencies: `crypto.createHash("blake2b512")`, then `crypto.verify(null, hash,
key, sig)` with the 32-byte Ed25519 key wrapped as SPKI (`302a300506032b6570032100` + key).

Windows only — macOS is not a surface this product sells, so 120 MB of dmg was not downloaded
to prove something that does not ship.

Also confirmed post-publish: `releases/latest` → **v3.3.0**; `revocations` still
`prerelease=true` and did NOT steal latest; manifest carries all six platform entries, every
signature on `4FF85F3BBE1DA21D`.

### Perf re-sweep at 25k trades — v3.3.0 added no regression

`npm run perf:seed` (25,001 trades, 3,460 open, 60k ledger rows, 100k audit rows) →
`npm run perf:sweep` (42 routes × 3 rounds, 126 visits) against the production build.

| | v3.0.0 baseline | **v3.3.0** |
|---|---|---|
| Overall route median | 987 ms | **985 ms** |
| Budget breaches (of 42) | 6 | **6 — the same six** |
| Console errors | 0 | **0** |

Still breaching, unchanged and all payload-bound: `/strategies` 6026 ms, `/options-journal`
5770 ms, `/equity` 3208 ms, `/risk` 2503 ms, `/trades` 2256 ms, `/lenses` 2114 ms. **The
v3.0.0 six-route deferral therefore still stands and is not superseded.**

The three routes v3.3.0 added O(n) passes to are all comfortably inside budget:
**`/reports/tax` 911 ms** (monthly-by-head), **`/reports/monthly` 1156 ms** (month detail),
**`/reports/harvest` 1304 ms** (three tax levers + 3 extra projected columns). Harvest has the
least headroom of any report at ~200 ms under, which is where to look first if it is extended
again.

Harness note: `vyuha-perf` in `.claude/launch.json` starts a PRODUCTION server against
`data/perf.sqlite` on port 3100, which is what `perf:sweep` expects. `data/` is gitignored and
`perf:seed` rewrites the file every run, so a baseline can never accrete.

## 2026-08-31 — Empty-book sweep: what a new buyer's first launch actually renders

**Context:** the owner wiped app-data during an install, which briefly made a real
zero-trade database available — the exact state every new buyer starts in, and a state that
disappears the moment anything is imported. v3.3.0 added three surfaces that had been verified
WITH data and never rendered empty.

**Method (repeatable — `vyuha-dev-empty-db` in `.claude/launch.json`):**
`VYUHA_DB_PATH=data/empty-check.sqlite npm run db:migrate && npm run seed`, which yields the
representative first-run state — **162 charge_config rows, 1 account, seeded settings, 0
trades** — rather than a bare schema. Seeding matters: an unseeded DB is a HARSHER test than
reality (no rates at all) and would report failures a real user can never hit. The repo dev DB
was left untouched (252 trades, verified after).

**Result: 44/44 page routes HTTP 200, zero server errors, zero occurrences of
`NaN` / `Infinity` / `[object Object]` / `undefined%`.**

**What the three new surfaces do on an empty book — all correct:**
- `/reports/monthly` "Month detail" and `/reports/tax` "Realised by head, by month" **hide
  entirely** rather than render a zero-filled table.
- `/reports/harvest` keeps the **set-off rule card** (the statute is worth reading before you
  have trades) with `finding: null` and no fabricated numbers, and says "No STT recorded on
  closed trades yet" instead of ₹0 with no explanation. "Holding clock" hides — no open lots.
- Harvest KPIs read ₹0, which is **honest rather than fabricated**: nothing was realised, and
  0 is the true realised figure. Invariant 6 forbids inventing a DENOMINATOR, not reporting a
  true zero.

**Incidental confirmations:** the 7-day Pro trial arms correctly on a fresh install
("Pro trial — 7 days left"), and the sidebar footer reads `v3.3`.

**Kept:** `data/empty-check.sqlite` is gitignored, so the `vyuha-dev-empty-db` launch config
needs the two commands above re-run on a fresh clone. That is deliberate — a committed
fixture database would rot silently against future migrations.

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

## 2026-09-01 — Zerodha's richest export fell to the column mapper because detection read only sheet 0; the new tradewise parser reconciles against Zerodha's own totals exactly

**Context:** Two real Console tax P&L workbooks (taxpnl-*.xlsx, FY24-25 632 F&O exit rows / FY25-26 59) provided for the v3.5.0 live-demo build.
**Measured / found:** The trade table lives on sheet 0, the `- Z` charge-head fingerprint on sheet 1; `toMatrix` read `SheetNames[0]` only, so `detectZerodha` scored 0 and the file fell to the generic mapper — proven with the real registry, not reasoned from source. The preamble's "View Zerodha's guide…" line is an in-content broker name. Parsed output vs the workbook's own F&O summary: realized profit Δ=0 on both years; charges Δ=₹0.00 (FY25-26) and −₹187.31 (FY24-25 — the FILE's own gap, entry-side charges of positions open at FY end; pinned in tests so a change is investigated, not absorbed). Zerodha's per-trade `Turnover` ≡ |Profit| on all 693 rows. The compact NSE symbols (NIFTY2540323750CE) classified as EQUITY before the classifier learned the grammar — every row would have priced at equity rates.
**Decision:** Detection scans every sheet; the tradewise shape claims only once the workbook names the broker or shows the `- Z` heads; rows group per symbol + entry day + exit day (the tradebook's scrip-day unit, so counts match across import routes); the broker's stated charges ride `reportedCharges` as the stored truth; monthly compact symbols get `expiry: null` (the symbol states no day, and the exchange's expiry weekday rules moved twice in 2025 — a computed "last Thursday" is a guess).
**Why not the obvious thing:** one row = one trade (inflates counts ~3×: Zerodha splits one order into a row per execution — six 75-lot rows share one entry AND exit second); trusting the engine's computed charges over the file's (the broker cannot be out-argued about money it actually levied).
**Invalidated if:** Zerodha changes the taxpnl layout (re-fingerprint against a fresh export), or a populated equity/currency section shows different column semantics.

## 2026-09-01 — Turnover is shown on BOTH bases; on the same real book they differ 6.5–8.7× and can straddle the audit threshold (owner decision)

**Context:** Vyuha implements ICAI GN 11th-ed. 5.11(b) (differences + option premium); Zerodha's tax report prints differences only.
**Measured / found:** FY24-25: Zerodha tradewise ₹13.94L vs Vyuha ICAI ₹1.21Cr (8.7×); FY25-26: ₹1.64L vs ₹10.6L (6.5×). Zerodha's own two sheets also disagree with each other (26% / 8.8%). At those magnitudes the two bases can land on opposite sides of the ₹10 Cr audit line.
**Decision (owner, 2026-09-01):** both figures, labelled, with an audit read on each and a warning row when the reads differ; the stale "8th ed." banner (which accidentally described the broker method) now derives from the basis constants; the audit badge resolves its section per FY via statute.ts.
**Why not the obvious thing:** picking one basis makes either the broker's report or Vyuha look broken — the user's CA holds the broker's number, and the honest product puts both in their hand with the question to ask.
**Invalidated if:** ICAI issues turnover guidance mapped to the 2025 Act (re-read the PDF, not a blog), or brokers move to the premium-inclusive method.

## 2026-09-01 — Scaling impact was charge-asymmetric: the actual side bore no entry charges while the counterfactual bore the first entry's, crediting every ladder ~one brokerage of phantom "improvement"

**Context:** v3.5.0 audit finding B3 verified against `summarise()`: `realisedNet` nets EXIT-leg charges only (entry charges live on the parent row via the engine).
**Decision:** on a closed ladder every entry tranche is consumed, so the actual side now subtracts ALL entry-leg charges; each scenario bears its own entry + exit costs, and the extra tranches' brokerage counts against scaling — pinned by a fixture where identical economics net exactly the second tranche's contribution.
**Invalidated if:** `summarise()` starts folding entry charges into `realisedNet` (then the page-side subtraction double-counts — the test will catch the sign).

## 2026-09-01 — Nine files substituted invented capital (₹17L/₹13L/₹4L) when settings were empty; every fresh install computed returns, risk heat, utilisation and limit checks on fiction

**Context:** audit A1 generalised — the performance page's `|| 1700000` had eight siblings (trackers, risk cockpit, monthly report, targets, cash ledger openings, pre-trade limits).
**Decision:** capital-unknown is a stated state, chosen per surface: %-metrics render "—" with ONE Settings nudge; risk heat says "unrated" (a ₹1 fallback graded every book fake-dangerous); the pre-trade limits engine gained a fourth status `"skipped"` (reported as "not evaluated", rank 0 — silently dropping the check read as a pass); cash shows flows-only balances with "opening —". A comment-stripping source guard (`tests/capital-fallback-guard.test.ts`) fails the suite if a `?? 1300000`-style fallback returns to any of the nine files.
**Why not the obvious thing:** defaulting to 0 everywhere — it prints "₹0" (an invented figure), makes `available` negative, and floods limits with false breaches.
**Invalidated if:** onboarding makes capital REQUIRED before any trade lands (then unknown-state code paths become dead and can go).

## 2026-09-01 — Vyuha Intelligence thresholds adopted with the v3.5.0 build (owner-approved plan)

**Context:** the insight engine's new rules need lines somewhere; these are conventions chosen for the first release, not measurements.
**Decision:** fast re-entry after a loss = <15 min (timed trades only, coverage stated); sizing escalation after a loss = >25% jump in median buyValue; rule sample floors — cockpit rules 15 (matching `MIN_SAMPLE`), pair-wise comparisons 10, lens-group rules 10, SL/TSL/win-loss verdicts 20 (matching `behavior.ts`); stop-vs-exit tolerance 0.5% of stop price; near-breakeven margin 0.05 win-rate points; group insights capped at 3 per lens group. Every rule refuses below floor and passes the shared PRESCRIPTIVE_LANGUAGE scan (`tests/intelligence-contract.test.ts`).
**Invalidated if:** real user books show the lines mislabelling behaviour (tune with data, then update this entry — a changed mind is information).

## 2026-09-01 — The pre-publish adversarial audit of the v3.5.0 diff confirmed 10 new bugs (0 of 15 candidate findings refuted); the v3.5.0 tag was superseded by v3.5.1 before anything reached a user

**Context:** v3.5.0 was tagged and its release workflow drafting when a 15-agent audit (5 diff-dimension finders → per-finding adversarial refuters, several running live probes on migrated temp DBs) reported.
**Measured / found:** the three worst — (1) harvest/advance-tax fed PER-SHARE `fmv31Jan2018` into `classifyGain`, which takes TOTAL units (tax-itr.ts scales ×buyQty for exactly this reason): a 100-share pre-2018 lot overstated realised LTCG by ₹15,000 in the worked scenario, driving every downstream harvest figure; (2) `seedDatabase` inserted the new 2026-04-01 F&O STT epoch beside a USER-EDITED 1970→open row (the unique index includes effective_from, so onConflictDoNothing never fires) and `findRates` picks the newest covering epoch — reproduced live: a user's verified ₹0 brokerage silently became the seed's ₹20/order for every trade ≥ the epoch; (3) the taxpnl in-content name check scored ANY /zerodha/i cell in the first 10 rows, so a user's multi-broker CSV with "Zerodha" in a Broker column auto-imported as Zerodha (the 2026-08-12 misclaim class, verified by running the registry). Plus: fully-closed shorts inverting stop-migration widen/tighten, sessions PATCH 404ing outside the lowest-id account, tradewise executions silently assuming buy-first, an n=1 expectancy accusation, cap-unit R wearing the "plan-derived" label, winner exclusions counted in the losers card, and a literal "—%" cell.
**Decision:** all 10 fixed with tests that fail on the reverted code (fault-injection proven for the seeder and sessions fixes); the v3.5.0 DRAFT is never published — v3.5.1 is the release. In-content broker naming is now constrained to preamble-shaped rows (≤2 non-empty cells) and NEVER qualifies a file without a format fingerprint. Plan-derived R now means the R denominator ties to the recorded stop within 2%. The widened-stop finding needs a ≥5-trade widened wing.
**Why not the obvious thing:** publishing v3.5.0 and patching later — two of the bugs silently rewrite money (the product's one unforgivable class), and the tag was cheap to supersede while nothing had shipped. Trusting the green suite — the suite WAS green; two of its own source-guard tests pinned a buggy line as correct, which is the strongest argument this audit pass stays in the release ritual.
**Invalidated if:** never — but the audit's cost (~4.3M subagent tokens for find+verify+fix across the day) should be re-weighed if a future diff is a tenth this size.

## 2026-09-01 — The blanket non-goals list is RESCINDED: the owner's standing directive is "evolve every day"

**Context:** VYUHA-STATE §8.6 froze the product surface ("no more brokers, no more report screens, no cloud AI, no backtesting, no new subsystems") after the 2026-08 consolidation era; the owner, planning v3.6, reversed it explicitly on 2026-09-01.
**Decision:** growth is allowed everywhere — new brokers, screens, capabilities, subsystems — but each expansion is gated, not free: proposed with its cost, owner-approved BEFORE building, invariants respected, landed with a test that reddens on the reverted code, and released only through `npm run verify` gates plus the adversarial diff-audit. The bundled correctness rules survive independently (no parser without a verified real export; SEBI-safe taglines; local-first stays the differentiator — cloud-touching features are per-feature, opt-in, owner-decided). §8.6 and docs/SESSION_PROMPT.md rule 3 rewritten the same day.
**Why not the obvious thing:** deleting §8.6 outright — the old list was doing double duty as a growth ban AND a correctness fence; only the ban is rescinded, and losing the fence would reintroduce the 2026-08-12 wrong-parser class.
**Invalidated if:** the owner reinstates a freeze, or unreviewed expansion starts landing broken features — then the gate needs teeth, not the wall back.

## 2026-09-02 — v3.6→v3.9 roadmap approved: eleven owner decisions set the "Navigate & Connect / Review & Discipline / Money correctness / Live Desk" slicing

**Context:** two multi-agent research waves (5 code-recon + 5 deep-research reports) fed a master plan; the owner answered all eleven open decisions on 2026-09-02. Plan: `docs/V360_BUILD_PLAN.md`.
**Decision:** (1) 4-bump slicing approved as proposed. (2) Dhan connects via PIN+TOTP stored in the vault (consent screen — Vyuha becomes a second factor), historical backfill lands v3.8 on captured real payloads. (3) Zerodha gets the official request_token+api_secret session exchange; enctoken REJECTED (ToS-fragile, against the honesty positioning). (4) Goals: absolute ₹ AND %-profit targets, per bucket (equity/active/total), optional target date, baseline frozen at creation. (5) Sidebar regroup as proposed; new groups Import, Tax, and **Back Office** (Surveillance, Cash & Ledger, Corporate Actions, Symbol Aliases, Instruments); Arjun's Eye moves to Analytics. (6) Telegram: per-user own bot only, at-user's-own-risk consent, setup popup card, test alert; shared bot rejected (token would ship in the binary — extractable, impersonation risk). (7) Discipline/Review keep the expectancy-gap framing — no literal "profit if avoided" counterfactuals (unobservable without intraday paths, and "avoid" is lint-banned). (8) Trade Review Desk is Pro/lifetime-gated once trial ends. (9) Live Desk approved with DOUBLE consent incl. links to broker data-fee pages (Angel/Upstox free; Dhan ₹499/mo, Zerodha ₹500/mo are broker-side); openalgo-charts engine adoption deferred until it stabilises (repo is days old; its Apache-2.0 licence and OpenAlgo's WS feed are the durable facts). (10) MTF interest recompute ships opt-in with before/after proof, never a silent migration. (11) Groww native adapter deferred (owner delegated; OpenAlgo covers it and the ₹499/mo is Groww's fee either way).
**Why not the obvious thing:** shipping everything as one v3.6 — the money-adjacent changes (direction migration, MTF recompute, challan ledger) need their own audit rigour and before/after proofs; mixing them with UI/connectivity work is how silent money rewrites slip through (the v3.5.0 lesson).
**Invalidated if:** the owner re-cuts the slicing, or a broker changes an auth flow (re-verify Dhan generateAccessToken's API-key-mode question empirically before building on it).

## 2026-09-02 — Goals are per-account statements, not mergeable assets: merge DROPS the source's goals, trash keeps no snapshot, and BACKUP_VERSION stays 3

**Context:** v3.6.0 WS2 added `capital_goals` (migration 0052; per-account × per-bucket expected-capital targets, ₹ or %-with-frozen-baseline).
**Decision:** three shapes chosen at build time, each documented at its code site: (1) an account merge DROPS the source account's goals rather than summing them — capital (and a target on it) is the user's own statement, and summing two statements fabricates one nobody made (the same rule the capital merge itself follows, DECISIONS 2026-08); the merge preview and result message both say so. (2) Deleted goals are NOT snapshotted to the trash envelope — one trivially-restated row per bucket, same class as panel dismissals. (3) BACKUP_VERSION stays 3: since v3 restore is per-key (absent table = preserve, present = truth), so pre-goals backups restore cleanly into v3.6 and vice versa — bumping to 4 would only make older builds refuse newer files whole; pinned by two roundtrip tests (paise-unscaled roundtrip, absent-key preserve).
**Why not the obvious thing:** summing goals on merge "loses nothing" — it invents a target the user never set, which is invariant-6 fabrication wearing a different hat.
**Invalidated if:** goals grow history/audit semantics (then trash needs the snapshot) or the backup format moves to whole-file versioning.

## 2026-09-02 — B/f loss lots MOVE on account merge, and a shared vintage keeps the LARGER amount with a note — never the sum, never a silent drop

**Context:** v3.6.0 WS5 added `bf_loss_lots` (migration 0054; hand-entered pre-journal carry-forward losses, seeded into `computeTaxTimeline` on the tax and ITR pages). An account merge had to decide what happens to the source's lots; the build brief allowed either move-with-collision-policy or drop-with-warning.
**Decision:** lots are STATEMENTS OF FACT about a demat account's filed ITR history — the opposite of goals (aspirations), so they follow the trades: on merge they MOVE to the target wherever no (incurred_fy, head) row exists there. Where BOTH accounts recorded the same vintage, the two rows are two transcriptions of possibly the SAME filed loss: summing could double-count one return; dropping could lose a genuinely larger remainder. The LARGER amount survives (and the larger non-null originalAmount), the collision is appended to the surviving row's note and audit-logged, and the merge preview names every colliding vintage so the user verifies against the actual return. On purge the lots delete un-snapshotted (goals' rationale: trivially restated from filed ITRs). Pinned by `tests/bf-losses.test.ts` (merge keeps 90k over 40k+90k=130k; move intact; purge gone).
**Why not the obvious thing:** drop-with-warning is simpler but destroys a fact the Act still honours for up to 8 years — a user merging two journal accounts for the same PAN would silently lose set-off they are entitled to; and summing is invariant-6 fabrication (two transcriptions ≠ two losses).
**Invalidated if:** the app ever models multiple PANs per journal (then a merge across PANs must NOT move lots — set-off does not cross assessees), or lots gain absorption history that a keep-larger overwrite would corrupt.

## 2026-09-02 — The v3.6 perf sweep flagged /lenses over budget; a worktree build of v3.5.1 proved the breach SHIPPED WITH v3.5.0 and v3.6 actually improves it

**Context:** v3.6.0 pre-release double sweep (all sweeps: seeded perf DB, production build, 126 visits): /trades 2031/2079 ms and /lenses 1675/1719 ms over the 1500 ms budget; every other budgeted route at or under its v3.4.0 baseline.
**Measured:** a clean `git worktree` at tag v3.5.1 (npm ci + next build, same perf DB, same harness) sweeps /lenses **1817 ms**, /trades **2383 ms**, and the dashboard `/` **1559 ms** — all three over budget in the SHIPPED release. v3.6 measures 1675 / 2031 and `/` back under budget: faster than v3.5.1 on every flagged route.
**Decision:** no perf work blocks v3.6.0 — it is a net improvement over the shipped state. The /lenses breach is v3.5.0-vintage (its LensEdge/per-group-charge work was never swept; perf:sweep is not in CI, which is exactly how the v3.0.0-era six-route pileup happened too). A /lenses windowing pass is v3.7 backlog, not a v3.6 gate.
**Why not the obvious thing:** trusting the v3.4.0 baselines as "current" — two releases of untracked drift sat between them and today; the sweep-vs-shipped comparison is the honest one.
**Invalidated if:** perf:sweep joins the release ritual/CI (then baselines stay current and this class of archaeology ends — recommended).

## 2026-09-02 — The v3.6.0 pre-release adversarial audit: 6 finders, 22 findings, 0 refuted, all fixed the same day — including a probe-proven tax misstatement a green suite had blessed

**Context:** the release ritual's audit pass, run on the complete uncommitted v3.6.0 diff after all build gates were green (2,826 tests passing at audit start). Six dimension finders (money, schema/migrations, security/credentials, UI/regressions, test-integrity, docs/claims), each instructed to refute its own findings before reporting; probes executed live on migrated temp DBs.
**Measured / found — the worst five:** (1) b/f-loss seeding double-counted a vintage present in BOTH the editor and the journal (probe: FY 24-25 tax understated ₹10,000) and accepted future-FY typos ("2035-36" absorbed current gains — pruning only looks backward); (2) All-accounts aggregate goal progress overstated (probe: 50% shown where 16.7% honest — pre-baseline profit counted twice, goal-less accounts inflated the numerator); (3) the Dhan PIN+TOTP consent — the release's most dangerous credential — had NO server-side gate while OpenAlgo/Telegram both 403; (4) `shiftDays` mixed local midnight with UTC slicing, making the "30-day" run-rate window 31 days on IST (the machine it ships on) — green in every timezone the fixture tested; (5) "Update connection" silently wiped Dhan/Zerodha auth_json enrollment on a token-only re-save. Plus: a cross-tab Telegram double-send race, chat-id leaking into backups via audit afterJson, an undeletable-token UI state, a Kite exchange that never checked whose session it minted, an empty-settings forged-envelope hole, and a family of privacy-copy sentences v3.6 made false (PRIVACY.md's "there is no fourth thing", README's "nothing ever uploaded by any path").
**Decision:** all 22 fixed in one wave (4 fix agents, disjoint files), each with a test proven red on the reverted code; final gates `npm run verify` EXIT 0 (2,896 tests / 188 files) and e2e 54/54 EXIT 0. Also settled by worktree measurement: the /lenses perf-budget breach predates v3.6 — see the same-day perf entry.
**Why not the obvious thing:** trusting the three green verify gates that preceded the audit — the test-integrity finder confirmed the new suite is honest (no v3.5-class pinned bugs), and STILL two probe-proven money-display bugs and a live timezone bug sat under full green. The audit pass stays in the ritual.
**Invalidated if:** never — but note the one open release gate it could not discharge: Dhan's `generateAccessToken` API-key-mode question is owner-verified live before the connect-once copy ships.

## 2026-09-02 — Dhan PIN+TOTP live-verified end-to-end; two undocumented behaviors found on the owner's account forced the reuse-first token cache

**Context:** the v3.6.0 release gate: the owner ran the new connect-once flow against his real Dhan account (dev server, repo dev DB, credentials purged after).
**Measured / found:** (1) first attempt failed with `{"message":"Invalid TOTP","status":"error"}` — **in HTTP 200**: Dhan reports auth failures in an error-in-200 envelope the docs never mention (root cause was a bad first TOTP enrollment; Dhan's setup shows the secret as text only behind the "enter the code shown" alternative to the QR — easy to miss, re-enrollment fixed it); (2) after a successful mint + preview ("5 normalized trades"), commit failed with `"Token can be generated once every 2 minutes."` — **Dhan rate-limits generateAccessToken to one mint per 2 minutes**, so the stateless mint-per-pull design broke on the very first preview → commit sequence.
**Decision:** `resolveDhanAccessToken` is now REUSE-FIRST: a stored token whose own `exp` is alive is used without minting; a mint returns `minted:true` and the route persists it encrypted into `broker_connections.access_token` (same vault path as a pasted token; a vault refusal only costs the cache). Paste-only mode still returns the stored token untouched — even unreadable — so Dhan's own 401 hint stays the judge there. The error-in-200 envelope is parsed with per-cause hints (TOTP/PIN/rate-limit). Re-verified live: preview minted + cached, commit reused the cache, **5 trades committed, 0 duplicates** — the flow that failed now passes. Tests pin the new ordering red-on-revert (mint-first calls auth.dhan.co where the test requires silence). The API-key-mode question is settled for practical purposes: verified WITH the toggle active.
**Why not the obvious thing:** stamping `last minted at` and sleeping out the 2-minute window — it leaves preview → commit racing a clock; reusing the 24h token is what the limit is telling clients to do.
**Invalidated if:** Dhan changes token validity or the mint limit (the resolver reads the JWT's own exp, so validity changes self-correct; a tighter mint limit only makes the cache more valuable).

## 2026-09-02 — v3.7.0 approved: the Review Desk's "researched design" was never written to disk, so the plan re-derives it — and the carry-over lists were wrong

**Context:** v3.7.0 "Review & Discipline" was slotted by the roadmap (`docs/V360_BUILD_PLAN.md:24`, owner decision #1) with its design said to live in a 2026-09-01/02 deep-research report referenced at that file's lines 4-8. Five read-only recon agents were run against the v3.6.0 tree (clean `main`, HEAD `6e39128`, 2,899 tests / 188 files, migrations through 0054) to recover it before building.
**Measured / found:** (1) **The Trade Review Desk research report does not exist anywhere.** "Process Score", "review queue" and "weekly ritual" occur in ZERO files; "Review Desk" occurs in exactly three (`VYUHA-STATE.md`, `DECISIONS.md`, `V360_BUILD_PLAN.md`) plus two Turbopack dev-cache `.sst` binaries that merely echo them. No research folder exists under the workspace and no indexed session transcript carries it. The owner-approved spec was, in full, one roadmap table row plus decisions #7 and #8. (2) **The "7 sibling global-capital reads" list does not exist either** — and the code holds **EIGHT**: `app/equity/page.tsx:75`, `app/active/page.tsx:31`, `app/risk/page.tsx:99-100`, `app/reports/monthly/page.tsx:41`, `app/targets/equity/page.tsx:34`, `lib/queries/ledger.ts:114-115,127-128`, `lib/queries/limits.ts:47-52`, and the one the count missed, the dashboard capital tile `app/page.tsx:28` — which sits three lines from an account-scoped goal badge, so the dashboard renders a per-account goal beside a global capital figure. (3) **Zero OS-notification capability exists**: no `tauri-plugin-notification`, no `@tauri-apps/api` at all, no `notification:*` permission, no `Notification(` call site. (4) `disciplineByWeek` has **no sample floor, no coverage and no refusal** — a 1-trade week scores like a 40-trade week — and falls back to a hard-coded `cap = perTradeCap || 9500`; a second, differently-shaped adherence number already ships (`session-review.ts:53`).
**Decision:** the design is re-derived from surfaces that exist and written down as `docs/V370_BUILD_PLAN.md`, which IS the spec — approved by the owner 2026-09-02 with all nine open questions answered yes: (Q1) the re-derived Review Desk stands as spec; (Q2) the Process Score is five equal-weight components with a floor of 10 closed trades per week and REPLACES the three-component weekly discipline score, so numbers on `/reports/discipline` and the monthly PDF change on upgrade — one weekly number, because two that disagree is the failure mode this log keeps recording; (Q3) `reviewed_at` is backfilled where notes / mistake tags / exit trigger already exist, so an existing book does not wake to a 500-deep queue; (Q4) onboarding keeps capital OPTIONAL, so invariant-6 "—" paths stay live; (Q5) challans follow b/f-lot semantics (MOVE on merge, delete on purge, no trash snapshot); (Q6) the Telegram fallback ships as a durable failure note plus a WebView `Notification` probe, with the Tauri plugin deferred to v3.8 unless the probe fails — no new npm dependency this release; (Q7) the /lenses on-demand member fetch is pre-approved if render-only windowing does not clear 1500 ms; (Q8) `REFUND_POLICY.md` bumps to v3.7.0 and joins the `client-docs-version` guard; (Q9) the perf double sweep becomes a written step of the `release` skill.
**Why not the obvious thing:** building from the roadmap row and the backlog prose as though they were a spec. Every one of the four findings above contradicts something a reasonable reader would have assumed from the docs — the count of capital reads, the existence of a design, the existence of a notification path, and whether a weekly score refuses on thin data. The recon reports are maps; the code was the territory, and the map was wrong in four places.
**Invalidated if:** the missing research report resurfaces and materially disagrees with §1 of the v3.7.0 plan (then reconcile before building further), or the owner re-cuts the roadmap.

## 2026-09-02 — The weekly discipline score averaged un-scoreable weeks as ZERO on a printed report: 80 became 32, and the fix is a five-component Process Score that refuses

**Context:** v3.7.0 replaces `disciplineByWeek`'s three plainly-averaged sub-scores with the transparent Process Score (owner Q2). The old module had **no sample floor, no coverage and no refusal** — a 1-trade week scored like a 40-trade week — and fell back to a hard-coded `cap = perTradeCap || 9500` when the user had configured no per-trade limit, i.e. it scored discipline against a number the user never set.
**Measured:** on a five-ISO-week fixture (two weeks of 10 closed trades scoring 100 and 60; three weeks of 4/3/2 trades that cannot honestly score), the honest average is **80 across 2 scoring weeks of 5**. The shipped v3.6 arithmetic returned **32** — because every refused week entered the mean as a literal 0. That figure appears on `/reports/discipline` AND in the print-optimised monthly report a user shares. The legacy arithmetic is now asserted live inside `tests/discipline-page-guard.test.ts` so the defect is pinned, not merely described.
**Decision:** five equal-weight components (planned · risk-cap · daily-stop · rules-followed · reviewed), each carrying `{numerator, denominator, pct, coverage}` so the arithmetic is on screen beside the number; `pct` is `null` — never 0, never invented — when a component has no denominator or when the limit it needs was never configured; the score is the mean of the non-null components; under **10 closed trades in the window** the week returns no score and states why ("4 closed trades this week; the score needs 10"). Refused weeks are EXCLUDED from every average and colour scale, and each average prints its coverage ("across 7 scoring weeks of 12"); with no scoring week the figure is "—", never 0. The ₹9,500 / ₹25,000 fallbacks are deleted and the two pages now pass `null`, so the components refuse instead. One weekly number in the product: `disciplineByWeek` delegates to `processScoreByWeek`, so the monthly report moved with no change of its own.
**Why not the obvious thing:** keeping the three-part score and merely adding a floor. The floor alone does not fix the invented cap, and it does not fix the averaging — a refused week still has to be *excluded*, not scored as zero, and that exclusion has to be visible or the average silently changes meaning. Note the shape of the near-miss: `WeekScore.score` had to stay a bare `number` through Wave 2 because two pages did arithmetic on it, so the wrong figure was deliberately left in place for one wave and handed forward in writing. A deferral that is not written down is how this class of defect ships.
**Invalidated if:** real books show 10 closed trades per week is too high a floor for the median user (then the floor moves, but never below the insight contract's 10), or a component is shown to double-count another.

## 2026-09-02 — Eight surfaces read GLOBAL capital, and COMPOUNDING made that wrong on single-account books too — not just multi-account ones

**Context:** v3.6 fixed the performance page to resolve capital account-first via `getBucketCapital()`; the backlog said seven siblings remained. Wave 2d verified against code: there are **eight** — the missed one is the dashboard "Total ₹XL" tile (`app/page.tsx`), which sat three lines from an already-account-scoped goal badge, so the dashboard rendered a per-account goal beside a global capital base.
**Measured / found:** the blast radius is wider than "multi-account". `compoundRealised` writes **only the account row**, so the settings row goes stale the moment a single-account user compounds realised P&L — and until now /equity, /active, /risk, /cash, the monthly report, the target tracker, the pre-trade concentration limit and the dashboard tile all showed the **pre-compound** figure while Settings, /reports/performance and the goal badge already showed the compounded one. Red-on-revert on four of the eight was proven by reverting each in turn: two produced wrong-number failures (`expected 111111 to be 500000` on the pre-trade limit base; `expected {equity: 11111100…} to deeply equal {equity: 50000000…}` on /cash openings), not merely source-guard failures.
**Decision:** all eight resolve through `getBucketCapital()`, which returns rupees and preserves `0 = NOT CONFIGURED`, so every "—", nudge and skip branch is untouched. The helper is extracted to `lib/queries/bucket-capital.ts` importing only settings + accounts, so the pre-trade limit path does not inherit `capital.ts`'s trades/ipos graph. `tests/capital-account-first.test.ts` now proves all eight, positively and negatively, against a migrated DB. `app/page.tsx` and the new helper join `GUARDED_FILES` — the `?? 0` chain now lives in one file, which is the single place a fabricated literal would poison every denominator at once.
**Why not the obvious thing:** trusting the backlog's count of seven. The list had never been written down (the "goals build report" it cited does not exist in the repo), and re-deriving it from `GUARDED_FILES` found the eighth. Also: "All accounts" (id 0) still falls back to the settings row — unchanged, and correct, because the aggregate has no single account's capital.
**Invalidated if:** capital becomes required at onboarding (v3.7 keeps it OPTIONAL — owner Q4 — precisely so the unknown-state paths stay live), or accounts gain a third capital bucket.

## 2026-09-02 — Two latent traps found in passing: the week bucketer emitted SUNDAY east of UTC, and `getWriteAccountId()` does not refuse the aggregate view

**Context:** both were found by v3.7 agents working on something else, and neither was in any backlog.
**Measured / found:** (1) `isoWeek()` (the repo's only ISO-week bucketer, private inside `lib/analytics/discipline.ts`) built the Monday from **local midnight** and then serialised it with `toISOString()` (**UTC**) — so in IST every emitted `weekStart` was the **Sunday**. Bucketing itself was never wrong, only the emitted date, which is exactly why nothing caught it; it becomes load-bearing the moment a date is stored, and `weekly_reviews.week_start` now stores it. This is the same family as the v3.6 audit's `shiftDays` defect that made a 30-day window 31 days on IST. (2) `getWriteAccountId()` resolves a no-selection state by falling back to the **lowest account id** (`lib/queries/accounts.ts`) — the silent guess invariant 9 exists to forbid. **Two agents hit it independently** while wiring unrelated write paths, which is the signal that it is a repo-wide shape, not a local mistake.
**Decision:** the bucketer is extracted to `lib/analytics/week.ts` as the single source, with the Monday emitted in local terms; nine tests redden on the revert. Both new v3.7 write paths (`review.ts`, `challans.ts`) refuse the aggregate view **before** calling the resolver, so the fallback is never reached. **Every pre-existing caller of `getWriteAccountId()` is an open audit lead for the v3.7 adversarial pass** — the resolver is not being changed mid-release, because callers that legitimately pass an explicit id rely on it.
**Why not the obvious thing:** making `getWriteAccountId()` itself throw on 0. That is probably right, but it changes behaviour for every existing caller in a release that is not auditing them, and the importer and add-trade form pass explicit ids for exactly this reason. Fix the callers under audit, then consider tightening the resolver in v3.8.
**Invalidated if:** the audit finds a caller that reaches the lowest-id fallback in a real flow — then the resolver throws and the callers are fixed in the same change.

## 2026-09-02 — Three source guards passed while guarding nothing; only running the revert exposed them

**Context:** the standing rule is that every fix lands with a test that reddens on the reverted code. v3.7 agents were additionally told to PROVE it by actually reverting, observing the failure, and restoring — rather than asserting the property.
**Measured / found:** three separate guards passed against reverted code. (1) A challan-editor guard matched `router.refresh()` inside the component's **doc comment**, so deleting the real call left it green. (2) A challan ordering test passed with `orderBy` removed, because the `(account_id, fy)` lookup index happened to return rows in ascending order — the assertion was true by accident of the query plan. (3) A route-union test could not fail, because the query layer beneath refused the same bad input, so the union under test was never the thing being exercised.
**Decision:** all three were repaired and re-proven — comment-stripping before matching (the `capital-fallback-guard.test.ts` stripper is the house tool for this), a fixture whose insertion order contradicts the desired order, and a case pinning what the union ALONE prevents. The wider rule, now demonstrated three times in one release: **a green guard is evidence of nothing until the revert has been run against it.** Prefer fixtures whose natural order contradicts the assertion, and strip comments in every source guard.
**Why not the obvious thing:** trusting "the test exists and passes". Two of these three would have shipped as decorative tests that a future reader would reasonably believe was coverage — which is worse than no test, because it stops the next person looking.
**Invalidated if:** nothing; this is a permanent lesson about source guards in this repo.

## 2026-09-02 — /lenses was never a rendering problem: 99.5% of its cost was a 9.3 MB props payload, and the plan's Stage A was worth ~0 ms

**Context:** the v3.6 perf entry left "a /lenses windowing pass" as v3.7 backlog, and the v3.7 plan specified a Stage A modelled on the v3.4.0 render-windowing pass (window the group list, shrink the batches prop, memoise the grouping). The agent measured the page against the seeded 25,000-trade perf DB **before** changing anything.
**Measured (before):** the `trades` prop serialised to **9,343 KB — 99.5% of the payload** (`rows` was 47 KB); the server loop cost **381 ms**, of which `runRules` was **214 ms**, because the page computed KPIs, charge heads and Pro insights for **all six lenses on every request** rather than the visible one; the whole book crossed the RSC wire because grouping was recomputed client-side. Meanwhile the things Stage A targeted were nothing on a real book: the worst lens renders **24 groups** against a `WINDOW_STEP` of 150, `getImportBatches()` returned **0 rows**, and client re-grouping cost **8 ms**.
**Decision:** Stage A shipped (the group-list window is correct for a long book even though it is worth nothing on this one) but the fix is **Stage B**, pre-approved by the owner as Q7: the page ships the server's own grouped output, and drill-down members are fetched on click from `app/api/lenses/members` using the SAME projection and the SAME order. `getLensChargeRows()`'s second whole-book scan left the page entirely. **After: payload 9,390 → 565 KB (−94%), server loop 381 → 186 ms, and the swept median 1718/1557 → 920/901 ms against a 1500 ms budget. Breaches 2 → 1.** The residual 565 KB is deliberate — the filter-scope id arrays keep the delete scope fixed at page render, which `delete-scope.ts` requires.
**Why not the obvious thing:** doing what the plan said. Stage A was derived from a recon report, and the recon report was a map — on the actual book its three targets summed to roughly zero while the real cost sat in a prop nobody had weighed. **Measure the specific page before applying a pattern that worked on a different one.** Output-neutrality was proved group-by-group against a real migrated DB: for every group of all six lenses the route's members equal the page path's ids *in order*, with identical charge heads and the same 19-column shape.
**Invalidated if:** a book has enough groups that the group-list window starts mattering (then Stage A's value appears and this entry's "worth ~0 ms" becomes book-specific, as stated), or `/trades` gets its server pagination — which is NOT output-neutral and stays its own change with its own proof.

## 2026-09-02 — The Telegram OS-notification fallback ships as a PROBE labelled INFERRED, and the failure note moved to storage rather than a column

**Context:** v3.6 deliberately did not build the "local OS notification" half of the Telegram degrade path, and no shipped copy may claim it. v3.7 §5.3 carried it forward. Recon confirmed the app has **zero** notification capability: no `tauri-plugin-notification`, no `@tauri-apps/api` dependency at all, no `notification:*` permission, no `Notification(` call site anywhere.
**Measured / found:** a second, larger gap sat underneath it — **nothing durable recorded that a digest send had failed.** The job deliberately reverts its once-a-day claim on failure so the next launch retries, and the note lived in ephemeral React state on a component mounted **only on the dashboard**, so a refresh cleared it and a user who landed anywhere else never learned.
**Decision:** (1) the failure record is now a versioned `{v:1,…}` storage envelope written by the runner and rendered from the root layout on every route, cleared on the next confirmed send. **This is a deviation from the plan, which preferred a settings machine-state column** — migrations are serialized through one agent and that wave was closed, and reopening it for a UI nudge was not worth the schema risk. The honest cost is documented in the module header: it is per-device, not per-database. On the desktop product the app *is* the device, so per-device ≈ per-install here; promoting it to a column is a v3.8 candidate. (2) The OS notification ships as a **browser `Notification` probe only** — feature-detected, opt-in per device on the existing breach-notify pattern, firing only on a digest failure — with **no npm or Cargo dependency added** (a test asserts that). It is labelled **INFERRED, not VERIFIED**, because proving it needs a built installer; the copy says Vyuha *asks* the system and that the on-screen strip remains the record, and a test greps that copy for over-claiming phrases.
**Why not the obvious thing:** adding `tauri-plugin-notification`. It is two new npm packages plus Cargo.toml, Cargo.lock and a capability file — and on this dependency graph any npm-driven lock rewrite deterministically prunes vitest's nested esbuild and breaks `npm ci` on every platform. Paying that in a release whose audit budget is already spent, for a nudge, is the wrong trade. Note the guard gap it exposes: `tests/egress-guard.test.ts` scans network constructs only and does not read `src-tauri/capabilities/*.json`, `Cargo.toml` or `package.json` — **nothing in the suite would review a new Tauri plugin's permission surface.**
**Invalidated if:** the probe is proven working on a real installer (then the copy can be upgraded from INFERRED to VERIFIED with the evidence), or it is proven NOT to work in WebView2 (then the plugin decision returns for v3.8 with the lock procedure budgeted).

## 2026-09-02 — Four v3.7 schema decisions that cannot be retrofitted, recorded before they are load-bearing

**Context:** v3.7 added migrations 0055-0058. Each carries a semantic choice that is cheap now and expensive once users have data.
**Decision:** (1) **`trades.reviewed_at` is backfilled** to `COALESCE(updated_at, created_at)` for rows already carrying review evidence — non-blank notes, non-blank exit trigger, or a non-empty mistake-tag array — so an existing journalled book does not wake to a 500-deep review queue. Blank still means UNREVIEWED and no analytic may bucket blanks as reviewed. (2) **`settings.onboarding_completed_at` is MACHINE STATE**: excluded from `BASELINE_SETTINGS_FIELDS`, listed in `SETTINGS_MACHINE_COLUMNS`, backfilled to now wherever any trade exists, stamped by the dev/e2e seed and left NULL under `VYUHA_SEED_CLEAN=1`. A restored backup must neither re-show nor re-hide the wizard — the same reasoning `trialStartedAt` gets. The e2e seed stamp is load-bearing: the shared e2e database has zero trades, so an unstamped flag would put a blocking modal in front of specs that dismiss nothing. (3) **`weekly_reviews`** is unique on `(account_id, week_start)`; on merge it MOVES where the target has no row for that week, and where the target does have one the target's row wins and the source's note is APPENDED — a user's own prose is never silently dropped — and it IS snapshotted to trash, because it is prose the user wrote. (4) **`advance_tax_challans` has NO unique key on purpose**: a challan serial is unique only per BSR code and both are optional on a self-assessment receipt, so two genuine payments of the same amount on the same day are legal; the editor warns on an exact `(fy, paid_on, amount)` match and still allows it. Challans are STATEMENTS OF FACT about a real bank payment (the b/f-loss-lot class), so they MOVE on merge and delete on purge, and are NOT snapshotted.
**Why not the obvious thing:** giving challans a unique key "for safety". It would refuse a legal duplicate, and there is no natural key to fall back on — which is also why the editor's row actions are labelled by POSITION rather than identity.
**Invalidated if:** a real user proves the duplicate warning is noise, or onboarding is made mandatory (which would kill the capital-unknown paths — see the 2026-09-01 invented-capital entry's own invalidation clause).

## 2026-09-02 — The v3.7.0 adversarial audit: 27 findings under a fully green suite, and FOUR of them were classes rather than one-offs

**Context:** the release ritual's diff-audit, run on the complete v3.7.0 working tree (102 paths, 63 files, +2527/−338) **after** five consecutive `npm run verify` gates had passed at exit 0 with e2e 70/70. Six finders — money, schema/migrations, security/gating/consent, UI/regressions, test-integrity, docs/claims — each required to execute probes on throwaway migrated databases rather than reason, and to **refute its own findings before reporting**. Precedent: 22 findings in v3.6, 10 in v3.5 (which superseded the v3.5.0 tag).
**Measured:** **27 distinct findings** (one — the audit-log asymmetry — found independently by two finders from opposite directions, which is the strongest signal this pass produces). One finding was **downgraded by the finder that raised it** after it proved the exposure unreachable, and that is a result worth as much as a confirmed bug. Every finding was fixed the same day by five fix agents on disjoint file sets, each fix landed with a test **proven red by actually reverting the code and observing the failure**. Closing gates: verify EXIT 0 at **210 files / 3,417 tests** (from 2,899 at the v3.6.0 cut), e2e **70/70**, final double sweep with **one** budget breach (`/trades`, unchanged and deliberately out of scope).

**The four CLASSES, which matter more than the individual bugs:**

1. **`recordAudit`'s API makes absence indistinguishable from null — four call sites in one feature, wrong three different ways.** It takes `before`/`after` as two independent objects and diffs their **union**, normalising a missing key to `null`. So the log rendered `reviewedAt: <timestamp> → null` for a clearing the code explicitly prevents; rendered *nothing* for the stamp that actually landed; rendered a phantom `null → []` where the row holds NULL; and rendered an audit row with **zero diff rows** for `markReviewed`, i.e. a mutation invisible in the viewer. These falsified three shipped claims — README's "immutable audit log", `docs/client/README.md`'s "keeps the full record" (which ships in the buyer ZIP), and the in-app help's "append-only history of **every mutation**". Four sites getting it wrong in three distinct ways is an API defect, not four careless authors. **Fixed by computing each written value ONCE and using the same binding for both the write and the snapshot.** v3.8: make `recordAudit` flag or refuse a key-set disagreement (throw in dev/test, log in production — `lib/audit.ts` swallows errors by design so logging never breaks the mutation it describes, and that must not change). Typing the pair alone does NOT close it: it misses the `[]`-vs-`null` value half.

2. **`getWriteAccountId()` does not refuse the aggregate view, and SEVEN pre-existing callers reached it.** With no account selected it falls back to the **lowest account id** — the silent guess invariant 9 exists to forbid. Probed live: saving Settings from "All accounts" rewrote account #1's capital snapshot; a ₹50,000 ledger deposit and an IPO filed against account #1 **with a success toast**; importing a broker cash ledger filed the ENTIRE statement on account #1 in one transaction; a session POST did the same; and — found by a fix agent's own probe, not by the audit — a session **PATCH** accepted an `accountId` naming no real account and reviewed a different book's session (the pre-existing test covered only the case where the fallback account does *not* own the row, which 404s, and that is exactly what hid it). All ship in v3.6 today. Fixed by refusing the aggregate view **before** the resolver runs, the house shape from `bf-losses`/`challans`. **The resolver itself was deliberately NOT changed** — that alters behaviour for every caller in a release not auditing them all, and the importer and add-trade form legitimately pass explicit ids. v3.8 candidate.

3. **UTC-versus-local, three times in one release.** The week bucketer emitted the **Sunday** east of UTC; the dashboard review card and the desk it links to named **different weeks** for 5½ hours every Monday; and the advance-tax page dated payments on UTC while the ledger accepted them on local, so the card could state "45% paid" and "₹4,50,000 short now" simultaneously when the truth was ₹0. There are now four hand-rolled copies of the IST literal plus **two exported functions named `todayIso` on different clocks** (`lib/queries/challans.ts` IST, `lib/engine/rates.ts` UTC, seven consumers). The IST one was renamed `todayIstIso` to make the collision unwritable — and the proof is the sharpest artefact of the audit: an agent wrote the mistake exactly as autocomplete would produce it, and **`tsc --noEmit` reported "No errors found"**. The type system cannot see this; only the source guard can. v3.8: one `todayInIst()` in `lib/analytics/week.ts` and migrate the copies. **Deliberately NOT done now** — the three defects are fixed and proven; what remains is duplication, and refactoring five files after the audit has cleared them trades certain regression risk for a hypothetical future bug.

4. **SIX guards passed while guarding nothing — three during the build, three more found by the audit.** Build: one matched `router.refresh()` inside the component's own **doc comment**; one asserted an order supplied by accident by a lookup index; one exercised a route union a lower layer refused first. Audit: **every** week-ordering assertion in the diff was satisfied by insertion order alone (proven by deleting the `.sort()` and watching all three files still pass — while the sort is load-bearing live, because all three production callers feed a **newest-first** query, so removing it renders the Review Desk history and the weekly discipline table backwards); a paywall assertion `insights?.length ?? 0 <= 3` was true even with the key absent, and on a seeded DB the trial branch made the vacuous path the one that executed; and a backfill assertion `r === (u ?? c)` could not fail because the schema's `datetime('now')` has **second** granularity and the fixture was created in the same second, so the reverted code passed too. **Rules, now demonstrated six times: strip comments before matching; build fixtures whose natural order contradicts the assertion; back-date timestamps to a literal; and a green guard is evidence of nothing until the revert has been run against it.**

**Individually severe, beyond the classes:** the review stamp landed on **open** trades (backfill and route both), so a journalled open position was permanently invisible to the desk once closed and counted as reviewed in the score — every fixture in the diff was closed, which is why nothing caught it; and the Sunday-ritual note survived an account switch (unkeyed component + a soft `router.refresh()`), so one book's private prose could be saved against another. The latter is fixed by **deriving** with an owner-scoped draft rather than a `key` or a state-sync effect (which `AGENTS.md` forbids — it silently broke the Trades filter under the React Compiler), and stranded prose now surfaces in a strip naming the book and week it was typed for rather than being discarded.

**Why not the obvious thing:** trusting five green verify runs and 70 green e2e flows. Not one of the 27 findings was visible to them. The audit's own cost discipline also held: the finders' *clean* results carried real weight — an 840-case field-by-field sweep proving the new dated advance-tax path leaves the v3.6 scalar path **byte-identical (47,400 fields, 0 differences)**, a group-by-group proof that the /lenses payload move changed no figure, and live merge/purge runs proving no user prose is lost.
**Invalidated if:** any class-2 or class-4 item recurs after its v3.8 fix lands — that would mean the guard, not the bug, was mis-specified.

## 2026-09-02 — v3.8 candidates banked by the v3.7 audit, with the evidence that earns each one

**Context:** items the audit proved real but which were deliberately not fixed in v3.7, because each is a refactor or a behaviour change rather than a defect fix, and the release had already cleared its audit. Recorded so the next cycle inherits the evidence rather than rediscovering it.
**Decision — the list, in priority order:**
1. **`recordAudit` key-set enforcement** + the single-binding convention (class 1 above). Four instances in one feature.
2. **`getWriteAccountId()` tightening** — make it refuse 0 and fix the explicit-id callers (class 2). Seven reachable callers found; all now guarded at the call site, none at the resolver.
3. **One `todayInIst()` in `lib/analytics/week.ts`**, migrating four hand-rolled copies, and consolidating `lib/engine/rates.ts`'s UTC `todayIso` with its seven consumers (class 3).
4. **`tests/account-isolation.test.ts` OWNERS debt** — six further undeclared writers of account-scoped tables (`app/settings/actions.ts`, `lib/db/seed-core.ts` on `capital_snapshots`; `lib/corporate-actions-apply.ts`, `lib/queries/delete.ts`, `lib/trash.ts` on `ledger_entries`; `app/api/playbooks/route.ts` on `trading_sessions`), plus more on `trades` and `broker_connections`. Not declared now because some (seed-core) legitimately never resolve an account, so declaring them would redden the "every declared owner resolves the account" assertion mid-wave. **This registry gap is WHY the source scan never flagged the Settings and ledger holes** — closing it makes the next instance findable by a test instead of by an audit.
5. **`app/settings/actions.ts` — DELETE.** Dead code (proven unreferenced two independent ways: tree-wide grep and a per-symbol sweep of all five exports) that carried the same capital-misfiling bug as the live route. Guarded in place for now; the deletion needs an operator's hand — the agent's `rm` was refused by the permission system and it correctly did not route around it.
6. **The remaining invented limits** — `optionsMaxTrades ?? 15`, `intradayMaxTrades ?? 12`, `commodityMaxTrades ?? 10`, `optionsMaxOpen ?? 8` on the Target Tracker; `app/targets/equity/page.tsx` `?? 9500`; `app/page.tsx` `?? 425000` / `?? 510000` monthly targets. v3.7 fixed the two surfaces that judged discipline (the score and the Target Tracker's stop) and **the CHANGELOG claim was narrowed to say exactly that**, rather than widening the change after the audit.
7. **A `WriteAccountPicker` on `/cash` and `/ipos`**, as `/import` and `/trades` already do — the better answer than a 403 for a genuinely per-account write.
8. **`app/settings/page.tsx` shows the GLOBAL capital** while every other screen now shows `getBucketCapital()`'s per-account figure. Pre-existing, display-only, deserves its own change.
9. **`markReviewed`'s audit row has a null `entityId`** on the create path, so a new weekly review's entry cannot be traced to the row it created. Needs a `.returning()` or a re-select.
10. **`perf:sweep` is still not in CI** — the reason baselines rot (owner Q9 put the double sweep in the release ritual, which is the cheaper half of the fix).
**Why not the obvious thing:** doing them now. Every one is either a refactor across files the audit has already cleared, or a behaviour change needing its own before/after proof. The project's own rule is that expansion is proposed with its cost and approved BEFORE building; an audit fix wave is not the place to smuggle it.
**Invalidated if:** any of these produces a user-visible defect before v3.8, in which case it becomes a patch, not a candidate.

## 2026-09-03 — A Paytm tradebook misimported because Paytm SWITCHES its Script column from ticker to code mid-window, and the parser keys on the raw cell instead of ISIN

**Context:** the owner's live book showed 905 trades / 175 open and "83 sales with no purchase on record — ₹4,83,88,311 of proceeds". He asked why intraday trades were being treated as unpriced sales. The tradebook was assumed to be Dhan (his API connections are Dhan) and its `Trade Time` assumed zero everywhere — both premises were wrong and were dropped by the investigating agent.
**Measured:** `rankParsers` on the real bytes: `paytm-tradebook` 0.75, everything else 0 — no parser is missing. `Trade Time` is a real clock on 5,688 of 7,544 rows; empty only on the 1,856 rows whose `Script` is numeric. Order numbers are never read by pairing. **The mechanism:** by month, numeric-vs-ticker `Script` is Apr 270/1328, May 145/3467, Jun 558/373, **Jul 727/0, Aug 676/0**. `paytm-tradebook.ts` groups fills by the raw `Script` (`groupKey`, lines 167/257/272) and carries ISIN without keying on it → **35 ISINs split into two positions, 17 with buys under the ticker and sells under the code** → phantom open buy + phantom unpriced sale (e.g. `INE0JR301013`: open buy 4,400 @ ₹11.4 L labelled MADHAVBAUG *and* three unpriced sales of 4,400 labelled `208578`; a real ~₹2.7 L loss reported as neither). Temp-DB reproduction from the file: 804 positions, 72 unpriced (₹4.46 Cr proceeds). **Re-keyed on ISIN, identical pairing: 38 unpriced, ₹2.75 Cr** — the owner confirms the 38 are genuine SME IPO allotments. ISIN+Exchange keying is worse (101). The numeric labels themselves: 162 of 215 are **BSE scrip codes** (exact match to the cached BSE `SCRIP_CD`; Paytm emits BSE codes on NSE rows too), 53 are NSE exchange tokens; all 215 already resolve via ISIN — only the name is missing.
**Invariant 6 held:** an unpriced sale carries `netPnl = −charges`; the 72 rows contributed −₹49,942, none of the on-screen ₹1.6 Cr is costless proceeds. But `acquisition-panel.tsx:151` says the sale "is already counted in your Net P&L" — false; only the charges are.
**Decision (owner, v3.8 WS1):** key Paytm pairing on ISIN with `Script` as fallback; display the non-numeric label seen for the ISIN; recompute `dedupHash` for stored Paytm rows in a migration (the hash derives from `tradingsymbol`, so the fix would otherwise stop re-imports de-duplicating); fix the banner copy; add an import-time SHAPE warning.
**Why not the obvious thing:** trusting the screenshot. A screenshot of the July rows showed only codes and zero times, and the first hypothesis (zero timestamps break ordering) was wrong — pairing is date-granular and sorts buys before sells within a day; it never reads the clock. The agent had to execute detection and re-key the real legs to find it.
**Invalidated if:** Paytm stops mixing representations, or ISIN goes missing on a row (then fall back to `Script`, which is what the fix does).

## 2026-09-03 — Same-day equity round trips are NOT automatically intraday: the broker's charge signature decides, and on the real file it split 34 / 49

**Context:** the same parser collapses `mixed` → delivery (`toHint`, line 174) where `dhan-gtr` already uses `splitMixedRow`, so 83 fully-closed same-day round trips (₹16.23 Cr turnover) were booked as delivery — STCG instead of speculative income. The owner leaned "intraday" but asked for a way to CONFIRM.
**Measured** (rates from the `charge_config` seeds — eq_delivery STT 0.1% both sides / stamp 0.015%; eq_intraday STT 0.025% sell-only / stamp 0.003%): of the 83, **34 carry a mixed signature** (stamp between the two rates; `splitMixedRow`'s algebra recovers the squared-off value within ~0.5% of the FIFO-matched value on 34 of 34 — two independent methods agree) and **49 carry a pure delivery signature** (stamp 0.015% on the buy AND STT = 0.1000% of buy+sell). Zero ambiguous. Paytm's own `Realized P&L Detail` sheet has no product column and lists 287 same-day rows with no speculative flag — the broker's P&L is silent; only the tradebook's charge columns carry the answer. Sub-bug: `corroborate()` divides STT by `buyValue` alone, so 23 of the 49 read "uncorroborated"; the delivery denominator is buy+sell.
**Decision (owner):** **follow the scrip-day charge signature, never the calendar.** The statute's test (`section(fy, "speculative")`) is settlement otherwise than by delivery — a CNC buy and CNC sell the same day took delivery obligations and paid delivery STT on both legs, so it is STCG. Blanket reclassification would have moved 49 correct trades into the wrong head.
**Why not the obvious thing:** "same day = intraday". It is what most tools assume and it is wrong for CNC round trips; the charges are the evidentiary basis for the statutory test, not a convenience.
**Invalidated if:** a broker's tradebook stops carrying per-row STT/stamp (then the signature cannot be read and the product must be asked, never guessed).

## 2026-09-03 — The Dhan PIN+TOTP fix was never on the desktop database, and the form that would have enrolled it has an EMPTY Client ID box that looks filled

**Context:** pulls on both Dhan connections in the installed app fail with "Client ID or user generated access token is invalid or expired", three days after the owner live-verified PIN+TOTP end-to-end.
**Found:** the 09-02 verification ran on the **dev server against the repo dev DB** (credentials purged after); the desktop app has its own DB, both rows' `last_pull_at` predate 09-02, and that stamp is written only on a successful commit — so no enrolled pull ever landed there. Unenrolled → stale pasted token → Dhan 401 → the exact string, reproduced with the mint endpoint never called. **Why he could not enrol:** the save gate is `!apiKey || …` and `apiKey` is reset to `""` at mount, on broker switch and after every save; `1112…••••` is a masked PLACEHOLDER — the box is empty while looking filled. (An earlier agent claimed the gate required a token; a second agent replicated the gate line by line and refuted that — the token is already optional in TOTP mode.) The v3.6 wipe fix is intact. Nothing renders this component in any test (node-only vitest, no broker-connect e2e); the server-side test passes because the server does accept PIN+TOTP without a token. Also: no retry-on-401, a bare `catch {}` swallows an unparseable `auth_json`, `jwtLooksUnexpired` treats an ms-epoch `exp` as alive, and in All-accounts a save creates a SECOND Dhan row on the picker's default account. The only visible sign of enrolment is a ghost "Remove PIN + TOTP enrollment" button; the checkbox is `useState(false)`.
**Decision (owner, v3.8 WS3):** hydrate the Client ID from the saved row; export the gate as a pure predicate and pin it; a mode label on every connection row plus a pop-up when a pasted token expires; retry-on-401 with one mint; surface an unreadable enrolment; ms-epoch guard; two-account preservation test; the All-accounts save names its target. Workaround given today: type the full Client ID in the per-account view.
**Why not the obvious thing:** "the fix regressed". It did not; it was verified on a different database than the one the owner uses, and the UI gave no way to see that. A live verification must state WHICH database it ran on.
**Invalidated if:** a Dhan API change alters the 401 envelope (the resolver parses it with per-cause hints — re-verify against a real 401).

## 2026-09-03 — The symbol universe needs no scraper: the build script already downloads every listed equity and throws away the name and the BSE code

**Context:** the owner asked for "every symbol in the Indian market" with a 12-hourly refresh, and whether TRADE-SENTINAL's data could be reused.
**Measured:** `build-isin-symbols.mjs --fetch` already pulls NSE `EQUITY_L.csv`, NSE Emerge `SME_EQUITY_L.csv` and BSE `ListofScripData` (2,559 + 565 + 4,979 rows cached) and keeps ISIN→ticker only. Keeping name + BSE code + board + series: **5,672 ISINs, 389 KB raw / 129 KB gzip (+247 KB)**, zero new network. **Two bugs make SME names unreachable today:** `instruments-file.ts:154` matches `NAME OF COMPANY` but the SME file ships `NAME_OF_COMPANY`, and `:158` drops every `ST` series row — TECHNOCRAT (`MARC`, NSE Emerge) cannot be imported at all. Cadence: 2026 YTD ≈ 1.6 listings per trading day of 5,672; a 12 h refresh gains ~1 row over daily, and a journal records the PAST — a security cannot appear in a tradebook before it has listed and traded. An in-app fetch would add `api.bseindia.com` to the egress allow-list and falsify PRIVACY.md's "exactly four kinds… no fifth thing", which already ships in two client packages; TRADE-SENTINAL's own code shows what NSE's cookie handshake, UA rotation and BSE's silent-zero-without-Referer cost. **TRADE-SENTINAL, read-only, nothing changed:** its `classification-reconciliation-multisource.csv` (2,305 rows with sector/industry) is the only artefact anywhere extending sector beyond the 1,155 index members; its universe is NSE-only, has no rename/delisting handling, and parts are under non-redistributable licences.
**Decision (owner):** enriched bundled snapshot, refreshed per release, Instruments upload as the same-day escape hatch; fix the two SME importer bugs; copy Sentinel's sector CSV ONCE as bundled data with provenance. Not the GitHub-asset pipeline (an extra owner ritual with the `--prerelease` trap), not in-app fetching.
**Why not the obvious thing:** 12 h is a scanner's cadence, not a journal's; and the BSE-code index must be keyed on the CODE, never the ticker — FOCUS, HSIL and KALYANI are different companies on the two boards.
**Invalidated if:** the product grows a live component (v4.0 Live Desk) — then the cadence question returns with a consent gate.

## 2026-09-03 — Pre-open fills already pair correctly; they are only MISNAMED as off-hours

**Measured:** pairing carries `date` only — no time field — so a 09:07 buy sold at 11:00 nets and a carried one stays open; verified on 133 real pre-open fills (5 same-day closed, 10 carried, 1 open, nothing mis-grouped). But `SESSIONS[0]` starts 09:15, so `sessionOf("09:07") = null` and `timeEdge`/`exitClock` route pre-open to `offHours` — 15 real trades that read like a parse error. 13 of 21 pre-open scrip-days are a scrip's first day (the IPO listing call). `session-review.ts:49` treats a null `entryTime` as "not after cutoff" instead of reporting coverage. No broker file flags pre-open; no fixture carries a 09:00–09:08 stamp. `docs/BROKER_FORMATS.md` still says Paytm's Trade Time is empty on every row — true of the old 414-row export, false of the 7,544-row one.
**Decision (owner, v3.8 WS5):** a sixth `SESSIONS` band `preopen` 09:00–09:15 naming the FILL (a pre-open order that fills at 09:15:00 is indistinguishable from a regular fill — say so); fix the session-review leak; fix the doc.
**Invalidated if:** NSE changes the pre-open window.

## 2026-09-03 — Import/Trades are engine-tested, not shape-tested; the harness that would have caught this week's bug is a table of real files with exact closed/open/opening-sell counts

**Found:** same-day round trips, sells-before-buys, scale-ins, ISIN resolution, dedup and the quarantine all have unit tests; but no test asserts the SHAPE of any whole real export, the only pairing guard is conservation (a mis-shaped-but-conserved book passes), `tradeStatsOf` (every /trades tile) has no test, a genuine short sell is modelled as opening-sell + orphan long, NSE-buy/BSE-sell of one symbol silently merge, the only broker-truth reconciliation is `skipIf` private-only, the paise-fidelity load suite is outside `npm test` and CI, and futures are unexercised. The Zerodha F&O compact grammar IS parsed (VYUHA-STATE was stale).
**Decision (owner, v3.8 WS2):** `tests/golden-books.test.ts` — per broker: redacted real file + broker's own figure + exact shape counts + charges conservation, then commit and assert `tradeStatsOf` matches; un-skip the private reconciliation with redacted-populated fixtures; load suite into CI; name the shorts; split by exchange. The owner supplies Dhan ×2, Paytm, Groww, Zerodha, Upstox, Angel One exports (list in the plan).
**Why not the obvious thing:** more unit tests. The engine was already right; what shipped wrong was the shape of a file no test had ever seen whole.

## 2026-09-03 — Search v1 design decisions, and the four traps a naive build would fall into

**Found:** bundled SQLite 3.53.2 has FTS5 **with the trigram tokenizer** (mid-word matching, probe-confirmed). `/trades` filters client-side over a ~22 MB payload reading three fields; a server `WHERE` reorders `(sell_date, created_at)` ties and moves float sums; no index on `symbol`/`isin`/`broker`; nine searchable tables have no `account_id` (the isolation test cannot see them); deep-links wipe the query string on arrival and two dead ones shipped (`?basis=unknown`, `?view=open`); `NavHistory` is pathnames only; names are 1,155 deep; the palette's keyword map duplicates `HELP_ENTRIES` and has drifted; `@radix-ui/react-popover` is a dependency with zero usages.
**Decision (owner):** FTS5 external-content table over trades synced by trigger, **returning ids only** so the page keeps its own ORDER BY (no tie-order change — a source guard asserts search never adds an ORDER BY to a trades query); in-memory search over the enriched symbol snapshot and the small tables; per-source account scoping with its own guard; **gated destinations shown with a lock and one line on what unlocks them, never hidden; a user's own trade rows never locked**; both backs — a search-session stack AND "back to where I was", neither via `router.back()`; the deep-link contract repaired first and the query string kept; rapid-click rigour proven as a load test (N ranked queries against 25k trades with `growthRatio()`) plus a Playwright stress spec of a few hundred cycles, not thousands in the browser. Floating draggable assistant → v3.9 on Radix Popover with a 2-D drag hook, no new dependency.
**Why not the obvious thing:** hiding gated results. It makes search feel broken ("I know I have that report") and hides what a licence buys; a lock is honest and converts.
**Invalidated if:** the trigram tokenizer is absent from a future SQLite build (then prefix-only, stated).

## 2026-09-03 — v3.8/v3.9 shape approved; Live Desk → v4.0; twelve decisions taken via pop-up; and how the owner wants to be asked

**Decision:** v3.8 "Trust the import" (Paytm ISIN/signature/dedup + banner copy; golden-book harness + KPI link + CI load; Dhan connect full set + Ledger registered + Realised P&L parser; enriched symbol snapshot + SME importer + Sentinel sector CSV; pre-open band; installer pre-uninstall warning + raw DB copy to Documents; deep-link repair + Search v1; all three banked audit items). v3.9 "Trust the numbers" (broker-truth reconciliation screen + Paytm Realized P&L sheet-2 parser; floating assistant; `/trades` server pagination with its own before/after proof; Dhan MTF Report + Contract Note; short-sell + cross-exchange modelling). Live Desk → v4.0. macOS stays unsold (real `.dmg`s exist on every release, unnotarised, never run); the owner tests one when a Mac is available. Next session builds v3.8 from `docs/V380_BUILD_PLAN.md` directly, re-verifying each claim first.
**Process:** the owner asked to be asked in **batches via the pop-up, options offered, my recommendation FIRST and marked** — recorded as a standing preference. All twelve v3.8 decisions were taken that way; all twelve chose the recommended option.
**Licence recovery:** the owner's lifetime key vanished when the installer's "delete app data" box was ticked mid-upgrade; every issued key is stored IN FULL in `license-ledger.jsonl` (`scripts/license-list.mjs <keyId> --full`), so it was copied back, not re-minted, and nothing was revoked. `VYUHA_KEY_ARCHIVE_DIR` was unset when the keys were minted — set it. The backup envelope would not have saved it (it blanks `licenseKey`). The installer option renders at uninstall AND mid-upgrade, names neither the journal nor the key, and three docs claim uninstall never deletes data — v3.8 WS6.
**Invalidated if:** the owner re-cuts the slicing.

<!-- First entry goes here. -->

## 2026-09-04 — v3.8 recon corrections and eight owner rulings before the first line of code

**Context:** seven read-only agents verified `docs/V380_BUILD_PLAN.md` §0/§1 claim by claim against
the v3.7.1 tree before the build. Most held; the ones that did not are listed in the plan's new §4.

**Measured:** the Paytm `dedupHash` migration as specified is near-void — commit already resolves
codes→tickers via ISIN before hashing (`lib/import/commit.ts:316+`), so an unsplit position's hash
does not change, and a merged position is a new row no hash can map two phantoms onto. The plan's
`todayInIst` exists nowhere (the helper is `todayIstIso`, `lib/queries/challans.ts:117`); the UTC
`todayIso` has 11 consumers, 5 in `commit.ts` pricing. Sentinel's
`classification-reconciliation-multisource.csv`: 2,305 rows — source 1,481 SCREENER_MAPPING+NSE_TAXONOMY,
747 BSE_SHAREHOLDING+NSE_TAXONOMY, 1 NIFTY, 76 unmatched. The "three-row rule" was defined nowhere.

**Decision (owner, pop-up, 2026-09-04):** (1) three-row rule = keep every row, replace names/UCC/PAN
with fixed tokens, ≥3 real rows per distinct case; (2) 0059 re-keys Paytm hashes ISIN-first AND WS1
ships a broker-scoped "remove this broker's imported rows" (trash snapshot, audit) so the owner's book
is re-imported clean; (3) the sector seed waits for the owner's own Sentinel sector/industry/index
files rather than the one CSV; (4) migrate ALL eleven `todayIso` consumers to IST now, gated by a
before/after charge comparison on the owner's book (my recommendation was IST-copies-only — overruled);
(5) load suite = dedicated `load` CI job, required green; (6) `getWriteAccountId` refuses explicit and
implied 0 with a typed error; (7) Dhan Client-ID "hydration" = relaxed gate + server-side key carry-over,
no plaintext leaves the server; (8) wave plan approved, W0 starts.

**Why not the obvious thing:** a SQL migration cannot SHA-1, so 0059 is a marker table plus a TS
post-migrate runner — the first "data fix" mechanism in the repo; a broker-scoped remove was scoped
in because hand-deleting ~52 phantom positions is the error-prone path on a live book.

**Invalidated if:** the owner's re-import after WS1 still shows split securities (then the label rule,
not the hash, is wrong), or the todayIso comparison moves any charge on the owner's book by more than
the midnight-UTC window explains.

## 2026-09-04 — Wave 0 baseline, the owner's 29 broker files inventoried, four more rulings

**Context:** v3.8 W0. The owner supplied every broker export he has (29 files, "BROKER FILES FOR
TESTING", read-only, never copied into the repo) plus Sentinel's sector/industry/index files and his
weekly watchlist workbook. Three agents read every sheet of every file and ran the repo's own
`buildContext` + `rankParsers` on each.

**Measured:** `npm run verify` EXIT 0 (211 files / 3,434 tests; BUILD_ID `r2dBohbj59BbphovX5n1x`).
Perf sweep #1 on the 25k seed: 43 routes × 3 rounds, 129 visits, overall median 949 ms, 0 console
errors; `/trades` 2041/2391/2391 (median/p95/max) is the only breach (pre-existing, v3.7.1 read
2054/2173); `/lenses` 984, `/review` 1135. Detection: Paytm tradebook 0.95, Zerodha 1.00 ×4, Groww
0.95 ×2, Upstox 0.95/0.75, Angel Tax P&L 0.95, PDFs 0.90. **Two misclaims of the AGENTS.md class:**
`dhan-csv` claims the Dhan Ledger CSV and the dividend CSV at 0.30 on `/dhan/i` in the filename
alone (`dhan-ledger` is not registered; its own detector scores 0.9 on the real header), and
`zerodha` claims Angel One's `Trades_History` at 0.50 on `Order ID`+`Trade ID` with no Zerodha
marker in the file. Uncovered: Dhan Realised P&L `.xls` (segment summary r7 with 13 charge columns ×
4 segments; per-segment detail blocks; NO dates, NO product; 1,028 merged cells; money as text),
Dhan P&L `.xlsx` (same table as `dhan-csv`), Dhan DP charges `.xls`, dividend CSV, holdings, Upstox
ledger, Angel ledger/P&L statement/tradebook, Paytm P&L `.xls` (three stacked tables incl. `Realized
P&L Detail` 918 rows, realised 21,371,252.64, no charges). The owner has exactly ONE futures trade
(FUT WIPRO 28 Apr 2026, Dhan account 1); everything else in F&O is options. Dhan account-2 ledger
opens with a 1970-01-01 OPENING BALANCE row. The Paytm "TIMEPERIOD CHANGE" pair is the SAME window
(01-Apr→28-Aug-2026) in two report types; the Zerodha pair is FY24-25 (632 exits) + FY25-26 (59
exits) with one NIFTY option entered 2025-03-28 and exited in April.
Sector files: `classification-reconciliation-multisource.csv` = 2,305 rows, 4-level NSE taxonomy
(12 macro / 23 sector / 59 industry / 185 basic, 1:1 `taxonomy_code`), 2,302/2,305 ISINs in our
5,671 snapshot, 0 symbol disagreements; 59 index CSVs (ISIN, no date, no weight; 8 casing forks in
`Industry`; the 69 symbols absent from `nse-index-map.json` are all in the 5 size indices the build
script excludes by design); Screener sheet = flat 190 industries, 634/2,344 cells are BSE codes.
Watchlist workbook: 25 sheets, 0 formulas, Python-computed; best journal ideas in order: stock-vs-
own-cohort attribution, cohort-minus-index gap, end-market axis with rank change, location/base
state, self-published staleness ledger.

**Decision (owner, pop-up):** (9) sector work in v3.8 = DATA LAYER ONLY — bundle the 4-level
taxonomy keyed by ISIN with confidence + provenance (2,229 classified rows), sector fallback chain
(user instruments → taxonomy → index map), normalise the casing forks, expose the confidence tier
where sector concentration is shown; analytics → v4.0 Live Desk. (10) parsers in v3.8 beyond Dhan
Realised P&L: register `dhan-ledger`, `zerodha` must see a Zerodha fingerprint, Angel One tradebook
parser, Dhan P&L xlsx via the `dhan-csv` table reader, Dhan dividend CSV into the ledger; DP charges,
holdings, Upstox/Angel ledgers, Angel P&L statement → v3.9. (11) Dhan golden book: GTR is the book,
Realised P&L's four segment rows are the reference. (12) FY bucketing: EXIT date owns the FY
(matches Zerodha's own tax P&L); re-import of both Zerodha files must yield 691 exits.

**Why not the obvious thing:** shipping an attribution screen in v3.8 needs sector cohort prices
Vyuha does not store and would reopen the egress question PRIVACY.md closes.

**Invalidated if:** the owner's GTR exports (requested) do not cover the Realised P&L windows.

## 2026-09-04 — v3.8 Wave 1/2a: what the build measured that the plan did not know

**Context:** six agents on disjoint file sets (migrations, Paytm parser, Dhan connect server, Dhan/Angel
parsers, symbol+sector data layer, pre-open band); every change proven red by reverting.

**Measured:**
- **Paytm, owner's 7,544-row book, after ISIN pairing + signature split:** positions 793 (was 804),
  closed 693, open 62, opening sells **38** (= the SME allotments; was 72), proceeds ₹2,75,35,637.20,
  closed net ₹1,61,44,747.01, intraday positions 185, relabelled securities 35, Σ charges 1,249,096.80
  vs the file's 1,249,096.81 (its own 4-dp component rounding). `inferProduct`'s ±35% tolerance
  means "mixed" covers only 9–56% delivery — a 60/40 day still reads as plain delivery (left as is).
  "No ISIN in two positions with the same product on overlapping dates" is NOT an invariant: FIFO
  ladders overlap 922 times on a healthy book; the split-book symptom is an open lot beside a later
  opening sell in the same security.
- **0060 FTS:** `content='trades'` would index pre-existing rows as raw JSON on `'rebuild'` while the
  triggers deleted the flattened text → stale tokens. The content table is therefore a VIEW
  (`trades_fts_src`) holding the one flattening; `json_each` is unavailable inside a view at rebuild
  on SQLite 3.53.2 ("no such table: main.json_each") so the flatten is a `replace()` chain guarded by
  `json_valid`. Delete/update use BEFORE triggers (the view can only be read while the row exists).
  Each trigger is one `--> statement-breakpoint` chunk because better-sqlite3 `prepare()` takes one
  statement and a `BEGIN…END` body is one.
- **0059 data fix:** `lib/db/index.ts` runs `runDataFixes` on open, and `migrate.ts`/`temp-db.ts`
  call it again AFTER migrate because on those paths the connection opens before 0059 exists.
  Zerodha hash pinned `b873f574cddcd800c917a54997f3666b3c4a626f`. Pre-existing duplicate Paytm
  rows are counted, never merged.
- **Snapshot:** 5,691 ISINs (NSE 2,568 + SME 568 + BSE-only 2,555; 4,994 BSE codes), tuple rows
  `[SYMBOL, NAME, BOARD, BSE_CODE, SERIES]` = 427,372 B raw / 134,807 gz (object-per-row 552 KB,
  parallel maps 745 KB); before 142,470 / 49,853. JSON.parse 1.24 → 2.19 ms. `sector-map.json`
  162,515 B / 40,124 gz, normalised (185-key label table + `[sym,bse,code,conf,src]` rows; flat
  would be 544 KB); 2,224 of its 2,229 ISINs are in the snapshot. **Twelve** sector aliases, not
  eight. **MARC ≠ TECHNOCRAT**: MARC = Marc Technocrats (NSE Emerge, INE0TD401015), TECHNOCRAT =
  Technocrats Plasma Systems (BSE 544877, INE19QK01022) — the plan's "TECHNOCRAT = MARC" was wrong.
  Today's SME list has 118 `ST` rows, not 125. The 5 size indices' absence from `nse-index-map.json`
  has NO recorded reason and no exclusion code — the 08-06 map was built from a 54-file folder.
- **Dhan:** the Realised P&L file never says "Dhan"; the content marker is the legal name "Raise
  Securities Private Limited". Its own summary does not tie to the paisa (Gross − Total ≠ Net by
  3–14 p). The GTR files (both accounts) detect at 0.98. Angel `Trades_History` names no broker
  anywhere — its fingerprint is the `TradesAndCharges` sheet + `Scrip/Contract` + `IPFT Charges` +
  `Order ID` + `Trade ID`; `zerodha` now needs `Auction` / `Order Execution Time` / "Tradebook for" /
  a name before it awards the tradebook score. `totpAckVersion` was already stamped by `packAuth`.
  Retry-on-401 is realised as overwrite-on-mint (DB via `onMinted`, memory via `creds.accessToken`).

**Decision:** all of the above shipped as measured; the size-index question goes to the owner at the
v4.0 planning pop-up, not v3.8.

**Invalidated if:** a Paytm export ever carries a product column (then the signature is a cross-check,
not the source), or SQLite gains `json_each` inside views (then the replace chain can go).

## 2026-09-04 — v3.8 Wave 2b: the golden book found the Dhan book empty; the money gates held

**Context:** four agents — cross-cutting WS8 (audit key-set guard, account-0 refusal, one IST today,
restore re-runs data fixes), Search v1 server, broker-scoped remove, golden-book harness with the
owner's 29+2 exports redacted through a script that refuses any output whose detection or parse
differs from the original.

**Measured:**
- **Dhan GTR (the BOOK by owner ruling) parsed both real 2026 exports to ZERO rows** while detecting
  at 0.98: `parseGtrDate` expected `dd Mon yyyy`, the 2026 export writes `dd-mm-yyyy HH:MM`. A
  "confidently empty" import — the class the plan's shape harness exists to catch, and it caught it
  on the first run. Fixed in the same wave (dates accepted in both grammars; an empty result on a
  detected GTR now warns with the unparsed sample).
- Charge leaks the harness pinned: Angel `Trades_History` Σ per-trade 157.76 vs stated 157.79
  (₹0.03 in six qty-0 per-order lines); Zerodha Console `reported.charges` null vs stated 3,269.4101;
  Zerodha tax P&L Σ 3,269.50 vs columns 3,269.41 (FY24-25 ₹0.02). Fixed in the same wave.
- `b7-import-parse-count` load bound (≤ 8 XLSX decodes per import) broke at 11 once the new
  detectors landed — decode is now memoised once per `ParseContext`.
- **Money gate for the IST migration:** owner's 7,544-execution book → 793 positions, 793/793 rows
  price identically under UTC-today and IST-today; `charge_config` effective dates are only
  `1970-01-01` and `2026-04-01`; `today` reaches pricing only as the fallback for undated rows.
  Beyond the eleven ruled consumers, **44 UTC-today sites in 39 UI files remain**, frozen by a test
  (can shrink, cannot grow) — Wave 3 work, not done.
- `recordAudit` key-set guard reddened exactly ONE real asymmetry across 44 suites: `upsertChallan`
  (`before: existing` full row vs `after: values`). `getWriteAccountId` refusal: four aggregate-write
  suites stayed green; `commit.ts` split into `loadRatesContext()` (mutations of rows that already
  have an account) and `loadContext()` (creators).
- Search v1 on the 25k book: FTS p95 15.11 ms / query (max 20.67), in-memory fan-out p95 3.37 ms,
  `growthRatio` 5k→20k = 3.57. Result href for a trade uses only `symbol|from|to`.
- Broker remove: trash format v3 (additive `kind: "broker-remove"`, `broker`, `ipoRefs`); restore
  reuses the trade-delete path under original ids; ledger and IPO rows unlinked, never deleted;
  FTS needs no statement (0060's BEFORE DELETE trigger).
- Golden shapes frozen (sourceRows → closed/open/openingSells): Paytm 7,544 → 693/62/38; Zerodha
  tradebook 3,530 → 64/4/11; Zerodha tax P&L FY24-25 632 → 206/0/0, FY25-26 59 → 26/0/0; Groww
  orders 952 → 466/1/16; Dhan P&L a1 → 1011/2/0. Dhan Realised P&L gross ties to its four segment
  rows to ₹0.05; Dhan's two own files disagree by ₹0.93/₹177.99 and its segment rows do not foot
  by ₹0.14. "691 exits" holds as Σ sourceRows; the parser books 232 positions (per symbol + entry
  day + exit day) — a design fact, not a defect. Redacted fixtures: 27 files, ~4.5 MB, `.xls` kept
  as BIFF8 (one >255-char footer string truncated by the writer, not a parser cell).

**Decision:** the harness is a release gate from v3.8 on (`tests/golden-books.test.ts`, exact
shapes; a pin moves only with a written reason). Dedicated `load` CI job (ubuntu, 10 min budget,
113 s local).

**Invalidated if:** a broker changes a date grammar again — the GTR empty-result warning is the
tripwire; a golden row that goes to 0/0/0 is a stop-ship, never a re-pin.

## 2026-09-04 — v3.8 Wave 3 (UI): what the six surfaces settled

**Context:** broker-connect wiring, import-page remove flow + shape cautions, deep-link contract,
search palette, installer guard + doc claims, UTC-today sweep + sector tier. Six agents, disjoint
files, four Playwright specs serialised on port 3100 by the coord hook.

**Measured / settled:**
- **NSIS template facts** (extracted verbatim from `@tauri-apps/cli` 2.11.3, NSIS 3.11): the hooks
  file is included AFTER MUI2/FileFunc/utils, so `${GetTime}`, `${If}`, `$DOCUMENTS`, `SetContext`
  work inside `NSIS_HOOK_PREUNINSTALL`; `$DeleteAppDataCheckboxState` and `$UpdateMode` are set
  before `Section Uninstall`; the reinstall page runs the OLD uninstaller interactively with
  `ExecWait` and treats exit code 1 as "user cancelled" (returns to the page) but exit 2 as "unable
  to uninstall" — hence Cancel = `SetErrorLevel 1` + `Quit`, never `Abort`. `NSIS_HOOK_PREINSTALL`
  runs AFTER the old uninstaller has already executed, so a copy there protects nothing — not
  implemented. **The v3.7.1 → v3.8.0 upgrade still runs the unguarded v3.7.1 uninstaller once;
  the release note must say "leave the box unticked".** Nothing in the suite executes NSIS — the
  install-off-build-machine step must exercise the uninstaller by hand.
- **UTC-today**: the frozen inventory was 42 sites in 39 files (not 44); 41 migrated, allow-list
  EMPTY (every site was a user-facing day); the one left is `components/trades/trades-client.tsx:92`
  (fix wave).
- **Deep links**: `view` accepts every value the trades select offers (8), not only open/closed/all,
  because a URL that cannot mirror "Loss — closed" is a URL that lies. `SlimTrade` carries no
  acquisition fields, so `basis=unknown` filters by an ids-only prop from the AcquisitionPanel's
  own population. `broker`/`bucket` are not in the contract.
- **Palette**: keyword coverage 27/43 → 43/43 by deriving from `HELP_ENTRIES` (drift guard in
  `tests/help-content.test.ts`); help-content is loaded on first open, results component via
  `next/dynamic`, exactly one `fetch(` in the file (pinned). Both backs never call `router.back()`
  (pinned). 100-cycle Ctrl+K loop in e2e, no console errors.
- **Broker-connect**: Wave 2's `connectionModeLabel` reads three live shapes as "not connected"
  (Upstox analytics token, OpenAlgo API key, Zerodha api-secret-only) — the component wraps it
  (`modeLabelOf`) rather than widening the gate; in All-accounts mode there is NO default pick
  (the second-Dhan-row bug's root), the picker offers an explicit "Pick an account…" row.
- **Egress guard**: two new same-origin fetches tripped the static-host rule — the remove panel now
  uses a literal `/api/import/remove-broker` prefix; the palette's `fetch(searchUrl(...))` is
  allow-listed with its reason (the literal `/api/search` prefix is pinned by the palette test).
  PRIVACY's "exactly four kinds" is unchanged — both are same-origin.
- **E2E under concurrent agents**: a spec's first run failed when sibling agents saved files inside
  its 25 s window (Fast Refresh full reload wipes client state); re-run alone it passed. Run e2e
  serially, never beside editors.

**Decision:** ship as above; release note carries the one-time "leave the box unticked" line.

**Invalidated if:** Tauri changes the reinstall page's exit-code handling (re-extract
`installer.nsi` and re-verify), or `SlimTrade` gains acquisition fields (drop the ids prop).

## 2026-09-04 — v3.8 double perf sweep: search and the enriched snapshot moved no route

**Context:** owner rule — Search v1 must not move any swept route; `/trades` stays out of scope.
Sweeps on the 25k seed, prod build, idle machine, 43 routes × 3 rounds, 1500 ms median budget.

**Measured:** W0 baseline (v3.7.1 + docs, BUILD `r2dBohbj59BbphovX5n1x`) vs W4 final (`9007c2d`,
BUILD after the hydration fix): overall median 949 → 910 ms; zero console/page errors in the final
sweep (the W3 sweep had React #418 on `/import` ×3 — a `<p>` wrapping a Badge `<div>`, fixed);
worst deltas `/equity` +39, `/risk` +8 (the sector resolution now runs there; a W3 sweep read +96,
noise), `/data-quality` +6; best `/options-journal` −225, `/arjuns-eye` −168, `/reports/charges`
−147. `/trades` 2041 → 1968 ms median, still the only breach (exit 1 is that breach alone).
Logs: `docs/perf-sweep-v380-w0.log`, `docs/perf-sweep-v380-w4.log`.

**Decision:** perf gate passed for v3.8.0; `/trades` pagination stays v3.9 with its own
before/after proof (DECISIONS 2026-09-03).

**Invalidated if:** a later sweep on the same seed moves any route by more than the ±40 ms this
run showed as noise.

## 2026-09-04 — v3.8 audit fix wave (docs/installer half)

**Context:** finders 5 and 6 of the W6 adversarial audit found the uninstall guard shipped in
this release promising more than it delivered, and four buyer-facing claims that had drifted
past their code.

**The safety copy was never proven.** `installer-hooks.nsh` copied the journal with
`CopyFiles /SILENT`, which reports failure ONLY through the NSIS error flag — a full disk, a
OneDrive files-on-demand placeholder that will not hydrate, a locked `-wal` sibling. Nothing
read that flag, and the template's `RmDir /r "$APPDATA{BUNDLEID}"` then ran anyway if the box
was ticked. So "before anything can be deleted" was true only when the copy happened to work.
Every copy is now bracketed `ClearErrors` / `${If} ${Errors}`, the arrival of `vyuha.sqlite`
in the target is confirmed independently of the flag, and any failure ends the uninstall with
a MessageBox and exit code 1 before Section Uninstall runs. The sidecar's own
`backups\pre-migrate-*.sqlite` snapshots are copied too — the install guide cites them, and
they were being left behind. The hook comment cited `@tauri-apps/cli 2.11.3`; installed is
2.11.4, and `tests/installer-hooks.test.ts` now fails if that citation drifts from
`node_modules` again.

**A pin that only caught the exact old sentence.** `tests/uninstall-claims.test.ts` matched
`Documents\Vyuha-backup` anywhere in the FILE, so "Uninstalling leaves your journal in place"
in one paragraph passed on the strength of a mention six paragraphs away, and nothing required
the checkbox to be named at all. Every rule is now scoped to the PARAGRAPH that mentions
uninstalling (markdown table rows counted one by one, because a feature table tells the whole
story in one cell): it must name the "Delete the application data" checkbox, say that ticking
it erases the data folder, and either promise the `Documents\Vyuha-backup` copy or — if it is
about the v3.7.1 upgrade — say that the old uninstaller has no backup step. Five evasions that
passed the old rule were planted and proven caught.

**The in-app backup cannot save a licence key.** The install guide told buyers to export one
"belt-and-braces" before the v3.7.1 uninstaller runs, but the envelope BLANKS `licenseKey`
(`lib/backup-format.ts:83`) — the file restores the journal and not the thing the checkbox
destroys. Corrected in the guide and the client README, and the test now fails any
upgrade/uninstall paragraph that offers the in-app backup without saying the key is not in it.

**Three claims narrowed to what the code does.** (1) The changelog said the audit log "refuses"
a drifted before/after; `lib/audit.ts:116` throws only outside production and, in the shipped
app, records the entry and warns — a mutation must not lose its trail over a logging defect.
(2) "restorable from Trash" named no screen; every site now says **Backup & Restore → Deleted
items**. (3) AGENTS.md and `docs/BROKER_FORMATS.md` still called Upstox schema-only with "every
value behaviour INFERRED" a fortnight after `tests/golden-books.test.ts` began pinning two
POPULATED exports (realised P&L against Upstox's own gross −1.05 / net −4.28 / charges 3.23, met
to the paisa; trade report 11 executions → 4 positions, net −271.90 as our own arithmetic since
a trade report states no P&L). The banner is what a future agent reads before deciding whether
an Upstox number may be trusted, so it now has a pin of its own.

**Privacy told a partial truth.** PRIVACY.md said the data is one file in one folder. A
non-update uninstall writes a second, unencrypted copy to `Documents\Vyuha-backup-<date>`,
which syncs to OneDrive if Documents is redirected. One sentence added; the "Exactly four kinds"
egress sentence is untouched (grep count still 1) and `tests/egress-guard.test.ts` is green.

**"Every date is IST" was KEPT, not weakened.** It is true only once
`components/trades/trades-client.tsx` loses its last UTC site in this same wave; the zero
inventory in `tests/today-clock.test.ts` (agent D's file) is the proof, and this entry is the
record that the claim depends on it.

**Decision:** a claim about what happens before data is destroyed needs a test that reads the
mechanism, not the sentence. `CopyFiles` without `IfErrors` is the same defect class as a
file-scoped doc pin: both make the happy path look like a guarantee.

**Invalidated if:** Tauri's template stops guarding its `RmDir` with `$UpdateMode <> 1`, the
hooks file stops being `!include`d after LogicLib (`${Errors}` and `${IfNot}` would not
resolve), or the sidecar moves its pre-migration snapshots out of `backups\`.

## 2026-09-04 — v3.8 second audit (over the fix wave): what it found, and the sector-map ruling

**Context.** The v3.8.0 fix wave (commit 15d3c4b, 12 must-fixes + 20 should-fixes) was itself
audited before release. A fix wave is where a hollow pin is most likely to land: each agent
writes the fix AND the test in one sitting, so the test tends to describe the fix rather than
the decision. This second pass ("6b") found the following, all fixed in FIX PASS 2:

- **The Angel One parser replayed the GTR defects** the first wave had fixed in the GTR parser
  alone — same defect class, second file.
- **The GTR ambiguity counter** did not count what it claimed to.
- **A Dr/Cr sign conflict** in ledger rows was resolved silently instead of refused.
- **DH-902 is a permissions error, not an authentication one** — the Dhan mapping sent the user
  to re-enter a token that was fine.
- **The control-character strip glued tokens**: dropping the character instead of replacing it
  fused two cells.
- **The search route answered 500 where 400 is the contract** for a malformed query.
- **A mask shorter than 6 characters** did not mask.
- **The uninstall guard blocked uninstall on a journal-less folder**: the outer gate
  `${FileExists} "$APPDATA\${BUNDLEID}\*.*"` is TRUE for an empty folder, so with no
  `vyuha.sqlite` (a crashed first launch, a stray log) the `CopyFiles *.sqlite*` matched nothing,
  set the error flag, the arrival check failed, and `MB_ICONSTOP` + exit 1 fired on every attempt,
  `/S` included — the app could never be uninstalled. Now gated on `vyuha.sqlite` itself (nothing
  to protect → skip silently) and the `backups\` copy on `backups\*.sqlite`.
- **Three hollow claim/installer pins**: (1) `tests/installer-hooks.test.ts` pinned the SHAPE of
  the failure guard — deleting `${If} $9 != ""` (always stop) or inverting it to `== ""` passed
  15/15; it now parses the LogicLib nesting and asserts which condition each instruction sits
  under. (2) `tests/uninstall-claims.test.ts` caught one grammar of "uninstalling never deletes";
  five paraphrases and "erases nothing that matters" walked past it; the rule is now a list of
  grammars applied per sentence, exempt only when the sentence carries its condition. (3)
  `tests/today-clock.test.ts` grepped raw source, so a UTC today in a comment reddened it while
  `.toJSON().slice(0,10)` and `.split("T")[0]` evaded it; comments are stripped first and every
  spelling is named.
- **PII in `tests/fixtures/dhan-pnl.csv`** since the initial commit — a fixture that was never
  redacted.

**Decision (test discipline).** A pin on a decision must fail when the decision is inverted, not
only when the line is deleted. The mutation set for a guard is: delete the condition, invert it,
drop the assignment that feeds it, and re-plant the trap it replaced. Each of those was run
against the new installer test and each reddened it with a named assertion.

**OWNER RULING (pop-up, 2026-09-04) — sector map.** `lib/data/sector-map.json` ships ALL 2,229
rows, each with provenance. The labels are NSE's own taxonomy (industry/sector names as NSE
publishes them); Screener was used ONLY as the identity bridge (name/ISIN → symbol) and
contributes no label of its own. The owner accepts the licence question this leaves open and
ships the full map. **Revisit if a redistribution basis is ever required** — the fallback is to
ship only the rows whose provenance is an NSE constituent list and derive the rest at first run.

**Invalidated if:** NSIS `${FileExists}` stops matching an empty directory for `\*.*` (then the
original gate was never a trap), or the sidecar stops creating `vyuha.sqlite` on first launch
(then a healthy install would also be skipped by the guard).

## 2026-09-04 — v3.8 CI lessons: `describe.skipIf` still runs its callback; ripgrep is not on the runners

**Context:** CI on `15d3c4b` (the first fix wave) went red in four jobs while every local gate was
green. **Measured:** (1) `tests/today-clock.test.ts` shelled out to `rg` — absent on ubuntu/windows
runners → the guard failed with ENOENT, not a UTC finding; replaced by an in-process, comment-aware
scanner (`910aa60`). (2) `tests/paytm-isin-pairing.test.ts` failed to LOAD (0 tests): the
`describe.skipIf(!BOOK)` callback executes at collection time even when skipped, and its first
line read the owner-only 7,544-row book → ENOENT on the runner. Guard: `if (!BOOK) return;` as the
callback's first statement. (3) The e2e remove-broker spec assumed re-import restores the
pre-removal count; the shared e2e DB carries dated Dhan rows from another spec now that the GTR
parser works — assert against the re-import's own "Imported N" figure. (4) An undetectable case,
by construction: a day-first Angel/Dhan numeric-date file whose days are ALL ≤ 12 imports with
every date swapped; only a day > 12 or a month > 12 cell can reveal the grammar — the parsers refuse
when evidence conflicts and say so, and cannot do better. (5) Redacting a fixture in the tree does
not scrub git history; `tests/fixtures/dhan-pnl.csv`'s originals remain in commits ≤ `15d3c4b` of
the PRIVATE repo.

**Decision:** every owner-only fixture read lives inside a `skipIf` callback that bails first; no
test shells out to a binary the runners do not ship (`rg`, `pdftotext`); e2e specs never assume
the shared DB is empty of their broker.

**Invalidated if:** vitest changes `skipIf` to skip the callback itself.

## 2026-09-04 — the `load` CI job's first red was the 25 ms floor, not the pairing engine

**Context:** `load` became a required CI job in v3.8. Its first run on `910aa60` failed
`c8-pairing-depth` "many symbols" (bar 6 on a 4× growth) while `lib/import/pair-legs.ts` had not
changed since v3.7.1. **Measured:** locally the same tree read 3.08 / 3.51 / 3.82×; at n = 24,000
the baseline finished in 24.0 ms — ON `growthRatio`'s 25 ms floor — so the ratio was timer noise on
fast and slow machines alike (the floor guard itself fired once locally). Doubling the many-symbols
size to 48,000 clears the floor; a best-of-three wrapper takes the minimum ratio (noise only ever
inflates a growth ratio). Doubling the ONE-symbol cases to 192k–240k legs overflowed the call stack
at `pair-legs.ts:302` (`out.push(...pairSymbolLegs(arr))`) — a spread over one symbol's whole
position list; unreachable for any real book (the perf seed is 25k trades across many symbols) but
a v3.9 cleanup (`for…of push`). Those cases stay at 24k/30k, where their baselines already clear the
floor. After the change: 2.30–3.80× (many), 2.92–4.07× (one), 3.54–4.23× (opening-sell heavy).

**Decision:** load thresholds are measured against the floor before they become CI gates; a red
`load` job is investigated for the floor first, then for the engine — never re-pinned to pass.

**Invalidated if:** the many-symbols baseline drops under 25 ms again on a faster runner (raise n).

## 2026-09-04 — v3.8.0 "Trust the import" cut and tagged: the evidence

**Context:** release skill §11 — evidence, not adjectives. Tag `v3.8.0` on `74e8d49`.

**Measured (gates on the tagged tree):** `npm run verify` EXIT 0 — 254 files / 4,515 tests
(v3.7.1: 211 / 3,434; +43 files, +1,081 tests; 35 owner-file cases skip on CI by design); e2e 81
flows in 26 specs (full run green after the fix wave; 8/8 on the three specs the second pass
touched); load 16 files / 40 cases; CI on `74e8d49` 6/6 green (check, windows-gate, e2e ubuntu,
e2e macOS, desktop-bundle-macOS, `load`). Desktop build EXIT 0, `desktop-dist/.next/BUILD_ID`
`W6Zd8e7hhVreBcrgjqg6s` written 2026-09-04 11:44 IST; bundle carries the markers `preopen`,
`Realised P&L`, `Unlocks with Pro`, `mints its own token`, `Remove and re-import`, `trades_fts`;
the generated `installer.nsi` carries `NSIS_HOOK_PREUNINSTALL` + `Vyuha-backup`. Local
`Vyuha_3.8.0_x64-setup.exe` 35,293,990 bytes, SHA-256
`47A2B542B1FEF69BD449B95C5618CD5EF8506E17774BAF0A73BAF56937DF4865` (the CLIENT-ZIP copy);
signature key id `4FF85F3BBE1DA21D` = `tauri.conf.json` pubkey. Client ZIP
`release-packages/Vyuha_3.8.0_Client_Package.zip` 36,046,763 bytes. Lockfile roots hand-edited
(2 lines), Cargo.lock via `cargo update -p vyuha --offline` (1 line). Double perf sweep: no route
moved; `/trades` 2041 → 1968 ms, still the only breach. Three audit passes: 6 finders over the
diff (12 must-fix), 3 over the fix wave (10 findings), 1 over the second pass (4 should-fix) —
every fix proven red by revert.

**Still owed at tag time:** `npm run release:verify v3.8.0 -- --deep` over the published draft;
install on a non-build machine (owner); publish the draft (owner — `gh release` is denied to the
agent); WDSI submission (owner, details handed over); revocation list untouched (prerelease).

**Decision:** tagged. Not "released" until the deep verify passes and the owner publishes.

**Invalidated if:** the deep verify fails (then delete the draft and re-run the workflow — never
re-upload by hand).

## 2026-09-04 — v3.8.0 deep signature verify: safe to publish

**Measured:** `npm run release:verify v3.8.0 -- --deep` EXIT 0 — `tauri.conf.json` pubkey id
`4FF85F3BBE1DA21D`; `Vyuha_3.8.0_x64-setup.exe.sig` verifies over the published exe (33.7 MB,
prehashed), `Vyuha_aarch64.app.tar.gz.sig` and `Vyuha_x64.app.tar.gz.sig` verify over their
archives; 3/3 signatures cryptographically verified over the published bytes. Draft `v3.8.0`:
9 assets, `isDraft=true`, `isPrerelease=false`; revocation list untouched.
**Decision:** hand to the owner: publish the draft, install on a non-build machine, WDSI.
**Invalidated if:** any asset is re-uploaded after this run (re-run `--deep`).

## 2026-09-04 — v3.8.0 PUBLISHED (owner-confirmed)

**Measured:** draft published; installed and launched clean on a non-build machine; WDSI
submission filed with the client-ZIP installer SHA-256 `47A2B542…4865`. `releases/latest` is
v3.8.0; the revocation list stays a prerelease, untouched. **Decision:** v3.8.0 is the release;
v3.9.0 starts from `docs/prompts/NEXT_SESSION_V390_V400.md`.

## 2026-09-04 — v3.9 recon corrections, owner rulings, and what Wave 1 measured

**Context.** Six read-only recon agents checked every v3.9 plan claim against the tree at `30332a3`
before any code. The owner then ruled on the contradictions; four Opus build agents landed Wave 1.

**Recon contradictions (all verified with file:line, all now settled):**
- Broker `reported` figures were never persisted — `PreviewResult.reconciliation` was the only
  carrier. **Ruling:** one `broker_reference` table (migration 0062) for every reference source;
  0061 is the ledger + audit FTS. Scopes `fy | scrip | segment | holding | charge`, replace-on-conflict
  on `(account, broker, source, scope, key, coalesce(as_of,''))`.
- Paytm's `Realized P&L Detail` is ONE lot table with a `Total` row (918 lots on the owner's file);
  the "three stacked tables" are the `Summary P&L` sheet (headers at r9/r42, not the r9/r38/r44/r105
  the plan predicted — headers are found by text). The detail Σ equals its Total to the paisa
  (21,371,252.57); the Summary's own realised Total differs by 7 paisa, so the detail sheet wins.
  Dates are `dd-MMM-yyyy`, unambiguous. The workbook never contains the string "Paytm": 0.9 on
  sheet+header, 1.0 only via filename. The inbox files named `realized_pnl-report*.xls` are Dhan.
- Migration 0059 already re-keys `classification_overrides` (`data-fixes.ts:111`); what it cannot
  reach are collision-skipped rows, blank-ISIN rows, and target-key-taken rows. Not orphaned in bulk.
- `trades-client.tsx:92` was already IST (`todayIstIso`, :104); VYUHA-STATE §2 and §8.0 were stale.
- NSE-buy/BSE-sell split: measured and rejected in v3.8 (38 → 101 opening sells on the 7,544-row
  Paytm book; `tests/paytm-isin-pairing.test.ts:130` pins one trade). **Ruling: note only, no split.**
- No `generic-map` golden row exists; its coverage is `tests/generic-map.test.ts`.
- `dp-charges.xls` and Angel `ProfitLoss_Statement` name no broker anywhere. **Ruling:** format
  fingerprint (sheet + header + title) = 0.9, broker in filename +0.1 — the named exception
  `Trades_History` already uses, documented in each parser header and BROKER_FORMATS.
- Dhan MTF Report is a web screen with no export (owner screenshot 2026-09-04). **Ruling:** no MTF
  file parser; MTF figures come from GTR / Realised P&L / ledger. The owner's one futures trade
  (FUT WIPRO 28 Apr 2026) was intraday on 15-Apr-2026; its contract note carries both fills.
- `dhan-pnl-fresh.csv` scores 1.0 under its own name, 0.8 neutral (no footer, `dhan-csv.ts:93`).
  **Ruling:** pin both facts (`tests/dhan-csv-fresh.test.ts`), matrix rule "named only".
- The `/trades` order change lands in `scopedBookRows` (shared by every projection) and reds
  `tests/render-windowing.test.ts:244`, which pins the two-key form; the perf book's `created_at`
  is per-row synthetic (`seed-perf-db.mjs:246`) so only the real book proves batch ties. (W2.)
- Angel "partial lock rule": no lock exists; the artefact is the note at `angelone-taxpnl.ts:212`.

**Covered short — ruling: same-day only.** `chronological()` already sorts buys before sells within
a date, so the arithmetic of a same-day sell-then-buy was already right; what was missing was the
meaning. `shortCoverQtys()` reads FILE ORDER before the sort (the only sequence signal legs carry —
they have no time) and labels the closed position `INTRADAY_SHORT_NOTE`; a sell that an existing
holding could deliver is NOT called a short. Multi-day stays an opening sell (cash equity cannot be
short overnight). No golden pin moved (146/146).

**Cross-exchange note.** `Lot` now carries `exchange`; a closed position whose lots and sell leg span
venues gets "Bought on NSE, sold on BSE — one holding, the exchange is where the fill happened."
Position `exchange` unchanged.

**`pair-legs.ts:302` spread → `for…of` push.** Proven red first: `RangeError: Maximum call stack size
exceeded at pairLegs (pair-legs.ts:302:39)` at ~123k positions on one symbol (190,000-leg C8 case,
`time(...)` not `growthRatio` — the 25 ms floor and the 4n run would mask the RangeError).

**Wave 1 parser facts (owner files read in place, zero identity strings emitted):**
- Dhan DP charges: 173 rows / Total 2,492.50 (a2: 94 / 1,325.00), both conserve to the paisa. 352
  merges; the only merge touching the Charges column is the title row — no data cell is lost.
  Emits ledger rows (kind `charge`, negative) AND `charge` reference rows keyed by ISIN.
- Dhan holdings: statement date comes from the `For dd-mm-yyyy` CELL; the filename is fallback and
  a disagreement warns. qty = free + locked + safe-keep + pledges (formula stated in a note).
- Dhan contract note (PDF, `pdf-parse` in-process): 0.95 named / 1.00 vs `detectPdf`'s flat 0.90;
  requires BOTH "CONTRACT NOTE" and a Dhan marker in the raw bytes. Emits `enrich` rows only —
  fill times + instrument type applied to EXISTING trades matched on (symbol, date, side, qty),
  never creating one. WIPRO 15-Apr-2026: 12:26:49 buy / 12:28:33 sell, 3,000 @ 205.72 / 205.41.
- Upstox `LEDGER_V3`: 4 rows, dd-mm-yyyy proved by day > 12; Σdebit 437.29 / Σcredit 2,500.00 /
  closing 2,062.71 exact. Angel `YourStatement`: running balance chains 0 → 1,417.56 with no break;
  the Charges tables are `chargeRows` + reference, NOT ledger rows — the DP charge is already posted
  in the Broking Ledger on a different date and folding it would debit twice.
- Angel P&L statement: no ISIN and no date column → keyed by symbol, `asOf` null, FY from `To Date`;
  delivery 3.95 + intraday −2.21 = summary 1.74, F&O 149.25, both reconcile.
- Dhan Realised P&L now also emits `segment` reference rows but NO `fy` row: the report states no
  period, and filing figures under an unstated year is a fabricated denominator.
- FTS trap: an FTS5 virtual table with `account_id UNINDEXED` reports that column to
  `pragma_table_info` and enters the account-scoped-table registry (`tests/account-isolation`).
  0061 keeps `account_id` in the VIEW only, exactly as 0060 does.
- `redact-broker-export.mjs`'s parity check compared only trades/rows/gross/charges/reported — vacuous
  for a reference source; `parserView` now includes `reference` and `enrich`.

**Governor.** Owner's usage at session start: weekly all-models 76% used, Fable 85% used, reset Mon
19:30. Owner ruling: run everything (build, wiring, finders) on Opus and finish the build; rule (c)
still applies if the all-models limit trips.

**A7 `/cash` load case is machine-noise sensitive, not a W1 regression (measured 2026-09-04).**
The W1 gate's load run failed `a7-cash-ledger` at 7.3× (ceiling 6×). Suspect was 0061's trigram
index inflating the page-cache footprint. Discriminator: three runs at HEAD `30332a3` with every W1
change stashed — 2 of 3 failed (8.4×, 8.2×); three runs with W1 restored — 1 of 3 failed (7.2×).
The timed region is `assemble()` only (seeding is outside `time()`), and no W1 file touches the
`/cash` path. Verdict: pre-existing, load-dependent on this laptop while a build and a second
session run; the CI `load` job (idle runner) stays the arbiter. Nothing in the engine was changed.
Working tree restored byte-for-byte after the stash (51 entries before and after).

**BIFF8 declares the whole sheet as its used range — every detector paid for 65,536 rows.**
The W1 gate's golden row for `dhan-dp-charges-….xls` hit vitest's 10 s hook timeout under load.
Measured idle: `XLSX.read` 19 ms, but `rankParsers` 3,717 ms — each of ~13 xls-reading detectors
spent 270–440 ms in `sheet_to_json({ defval: "" })` because the sheet's `!ref` is `A1:Q65536` for
1,400 real cells. `workbookOf` now trims every sheet's `!ref` to its populated bounding box once on
the memoised workbook (`trimSheetRanges`, `lib/import/types.ts`): 440 ms → 2 ms per flatten.
Nothing a parser SEES changes except phantom trailing rows; merges untouched. Pinned by
`tests/workbook-range-trim.test.ts` (red: `expected 65535 to be less than 400`). Same trap will hit
any Dhan `.xls` (Realised P&L is BIFF too) and any detector added later — the memo is the fix, not
per-parser row caps.

## 2026-09-04 — v3.9 W3 (UI): what the two screens and the e2e run settled

- **Broker Truth (`/reports/reconcile`)** — Pro-gated, nav group Import (no Reports group exists),
  per-FY / per-scrip / per-segment / holdings tables; ISIN-first join, symbol fallback, the match
  key printed per row (the Paytm ticker→code relabel makes a silent symbol join unsafe). Five
  reference sources feed it (`RECONCILE_SOURCE_IDS`), not the four the brief said.
- **The Dhan Realised P&L was double-counting the book.** It still emitted per-scrip trades (v3.8,
  when it was the only Dhan source) beside its v3.9 reference rows; imported after the GTR into one
  account the F&O segment read exactly 2× the broker and dedup skipped 0 (hashes differ by
  construction). Rule now in `commitParsedFile`: a reference source whose account already holds
  BOOK trades from that broker stores figures and skips its trades ("your Dhan transaction report is
  the book"); into an empty account it still imports them and says they will be superseded. Keyed on
  `broker_reference.import_batch_id` vs `trades.import_batch_id` with an explicit `IS NULL` arm for
  manual trades — neither `trades` nor `import_batches` carries a source id. Golden leg 5 (one
  account per fixture) untouched. **Proof the screen works:** with the double count gone, the F&O
  segment reconciles to ₹0.01 on the a2 pair; equity's ₹665.98 gap carries "1 sale worth ₹21,904 has
  no purchase" + "439 shares across 4 positions still open".
- `reconcileFrom` had two defects before that: reasons were computed at scrip scope only (segment
  rows — the only rows the Dhan file states — showed an empty Why column), and `FAMILY_OF` used an
  invented segment vocabulary so every F&O trade fell to `null` (Vyuha ₹0). Now `Record<Segment,…>`
  so tsc enforces exhaustiveness; an out-of-tolerance line with zero facts prints the facts checked.
- **Floating search assistant** — the first e2e run showed the panel at (0,0) for everyone, not just
  the test: `PopoverTrigger` registers itself as the Popper anchor before `PopoverAnchor`'s effect
  flips `hasCustomAnchor`, and Radix never releases the detached node. The launcher is now a plain
  button; the positioned `PopoverAnchor` is the popover's only anchor. Hook + envelope were correct.
- Ledger + audit FTS: p95 15.5 ms at 25k rows each (200 queries × 2 scopes); trades unchanged.
- e2e first full run: 82 passed, the two new specs failed on real defects above (not on the harness).
- README counts drifted twice in one wave (a fix agent adds a test file after the sync) — the sync
  is the LAST thing before verify, never before fix agents run.

**W3 double perf sweep (25k seed, prod build, idle machine, 44 routes × 3, 1,500 ms median
budget): no breach.** Sweep 1: overall median 978 ms, slowest 1,472, `/trades` 1,010 (p95 1,025).
Sweep 2: overall 929, slowest 1,394, `/trades` 954 (p95 1,009). The W2 sweep's +12–27% moves on
`/`, `/settings`, `/review` were machine load, as suspected: on an idle machine they sit inside the
budget. `/trades` is no longer the one route over budget (1,968 → ~1,000).

## 2026-09-04 — v3.9 first audit (6 finders over 30332a3..c04e1ad): what they found

Two stop-ships, both on the release's own theme:
- **Covered-short label changed STT on authentic Dhan input.** `shortCoverQtys` started `held = 0`
  and ignored the engine's own pre-file seed lot, so `sell → buy` on one day with an older holding
  was labelled an intraday short and `unknown → intraday` reached `productHint` → sell-side STT
  0.025% instead of 0.1%. Conservation cannot see it (qty/value delta 0). Also mislabels on a
  newest-first export (file order desync). Fix: seed `held` with the pass's opening qty, compute in
  chronological order with file order as the within-day tiebreak, never note/override when
  `buyDate !== sellDate`.
- **Contract-note enrichment matched 0 of 1,161 real fills** against the owner's own GTRs: the note
  emits the underlying (`NIFTY`) while the GTR books `OPT NIFTY 07 Apr 2026 23000 CE`; equity notes
  print the ticker while the GTR books the company name; and a note is one line per FILL while the
  book is one paired position. The unit tests passed because their fixtures hand-aligned all three.
  Fix: build the GTR-style name, join through ISIN / the symbol snapshot, aggregate fills per
  (symbol, date, side) and match on the summed qty.
Must-fixes: `applied++` counted empty patches; DP charges advertised on five surfaces at a door that
refused it (422); `broker_reference` orphaned by broker-remove and batch-delete and not in the trash
envelope on purge; the id-tiebreak "red-first" test stayed green with every `desc(id)` reverted and
`render-windowing` never covered `trades-page.ts`; `loadMore` had no cancellation guard (a refresh
mid-load appends another account's rows); `e2e/trade-views` asserted the loaded-page count against
the whole-set dropdown and passed only because the e2e DB has 303 rows; page-local column sort
with no label; panel close dropped focus to `<body>` (no PopoverTrigger → null triggerRef); help
copy named four feeds where the code has five; format-only fingerprints hijackable by a rival's
file (filename cannot veto); Angel ledger dropped undated rows silently; Angel scrip lines never
joined the book (ISIN-keyed index vs symbol-keyed rows); `checkedNote` asserted facts FY lines never
computed.
Verified clean by the finders: zero cross-claims across 46 fixtures + 29 owner files under neutral
names; zero PII in fixtures and outputs; upgrade 0060→0063 populates FTS for pre-existing rows and
removes the temp B-tree from the plan; keyset paging correct across the NULL sell_date boundary; all
filter values bound, LIKE escaped; SQL/JS parity on 23 filter shapes × 4 account scopes on the 25k
book; PRIVACY "four kinds" holds (one same-origin fetch added); macOS absent from selling surfaces;
version strings still 3.8.0; perf `/trades` 273 ms median of 5 on the prod build.
Lesson recorded: an enrichment/join feature is proven on the OWNER'S paired files, never on a
fixture whose keys were written to match; and a "red-first" claim must be re-proven by a finder.

**Fix-wave perf sweep was NOT an idle-machine measurement (2026-09-04, after the first audit's fix
wave).** Three sweeps read every route ~37% slower than the W3 pair (overall median 929 → 1,278 ms;
`/` 1,751, `/risk` 1,675, `/review` 1,584, `/reports/harvest` 1,664 over the 1,500 budget; `/trades`
1,307 vs 954). A uniform shift across all 44 routes is the machine, not a route: `Get-CimInstance`
showed the TRADE-SENTINAL session's Playwright driver and a 318 MB Codex node process running
concurrently. The fix wave changed no server route (`git diff c04e1ad -- app lib/queries` = the
cursor 400 and the reference purge/trash paths only). Ruling: the W3 idle pair stands as the v3.9
perf record; the sweep is re-run on an idle machine at W5 BEFORE the tag, and a breach there is a
stop-ship. Other-session processes are never killed from this session.

## 2026-09-04 — v3.9 second audit (3 finders over the fix wave c04e1ad..4d9e9bd)

- **CRITICAL: a stated ISIN never disqualified an enrichment match.** `identityMatches` treated the
  ISIN as accept-only; when the note's ISIN and the book's ISIN differed it fell through to the
  ≥4-char name-prefix rule, which put the Tata Motors DVR's fill time on the ordinary share
  (`TATAMOTORSDVR` ⊃ `TATAMOTORS`; `HDFC` ⊂ `HDFCBANK`), and `free.find(qty)` took the first by id.
  Fix pass: differing ISINs refuse first; names match by equality, prefix only when exactly one
  candidate; >1 candidate after qty is reported "ambiguous", never guessed.
- The enrichment counts did not sum (per-hit increments in the prefix split; a dropped tail called
  `miss()` without `unmatched++`, so its warning never fired). Invariant now pinned:
  applied + alreadyHad + unmatched === contract-days.
- `scripKeysOf` summed two ISINs under a shared ticker for symbol-keyed Angel rows (a −200 delta
  manufactured from 100 vs 300). Ambiguous tickers now refuse with a reason.
- `scope: "charge"` rows were written by three parsers and READ BY NOTHING while three shipped
  strings said DP charges feed Broker Truth. Fix pass adds the charges table (stated DP charges per
  FY vs Σ `trades.dp_charges`; contract-note charges per note date; Angel ledger charge types shown
  as stated, no fabricated Δ).
- **The RIVALS veto scanned every cell**, so a Dhan DP-charges sheet holding ANGELONE or PAYTM as a
  SECURITY scored 0 — a real holding would have cost the owner his own import. Veto now reads the
  filename, sheet names and the banner region above the header only.
- The covered-short fix (seed lot, date sort, buyDate guard) had NO red test: all three reverts
  stayed green. Three pins added. Four other red-first claims re-proven red by the finder
  (acceptsPage, backup envelope, bookName, RIVALS veto).
- Figures-only trash snapshots reported "0 trades" everywhere (counts, restore title, purge
  dialog, recoverable badge) and a reference-only batch delete said "No trades were linked" while
  destroying the only copy — both now name the figures. Merge restore asymmetry (discarded duplicates
  only) documented in the v4 envelope comment.
- Clean: pairing on every probe (older lot, newest-first, two shorts, partial cover, seeded lot),
  DP-charges door under the write account in one transaction with a 403 on the aggregate view,
  idempotent re-import, v3 envelopes restore, cursors never persisted, `/api/trades/page` 400 JSON
  on garbage, clamped limits, no hydration warnings on 3011, `trimSheetRanges` loses no cell on any
  owner or fixture workbook, both owner DP files conserve (173 / 2,492.50; 94 / 1,325.00).

**Final finder (over the second fix pass, 2dc0071): DO-NOT-SHIP on one finding, fixed before the
tag.** The new charges table built its Vyuha-side maps (`dpByFy`, `pledgeByFy`, `tradesByDate`) with
no broker key and handed the whole book's totals to every broker's line: ₹60 Dhan + ₹40 Angel DP
charges stated, the book holding exactly those, printed Δ −40 and Δ −60 — two fabricated deltas on
a book that agrees to the paisa, in the table added to prove agreement. Two brokers' DP files for
one FY also collapsed into one summed line with `broker: null`. Fix: every charge map and line is
keyed by broker; a broker with no trades in that FY/date reads "Not compared", never ₹0. Also: the
feed list is seven files now that three sources emit `charge` rows (the docs said five); a
contract-note line on a date with no trades is "Not compared", not "Broker higher" against ₹0.
Checked clean by the same finder: enrichment identity both ways, units (paise → rupees on read),
FY assignment by levy date, veto region documented, empty states, versions still 3.8.0.

## 2026-09-05 — v3.9.0 perf gate: the "uniform regression" was the measuring session itself

Five sweeps of HEAD read ~35% slower than the W3 pair on every route. A same-session control of
the W3 commit (`c04e1ad`, rebuilt in place) read 967 ms overall — so it looked like a real shared-
path regression in `4d9e9bd..fcddb22`. The discriminators said otherwise: server TTFB ×5 on `/`,
`/settings`, `/risk`, `/trades` identical within noise at both commits; the initial-script set for
`/settings` byte-identical (20 scripts, 1,825,730 bytes both); `DeletedItemsBadge` is only called
from the backup page, never the layout. Re-measured with NOTHING else running: HEAD 947 / 932 ms
overall, slowest `/risk` 1,384 / `/` 1,380, `/trades` 998 / 950 — all 44 routes inside 1,500 ms,
within 3% of the W3 record. The earlier inflation came from this session's own concurrent work (a
repo-wide grep, a queued verify, the e2e harness) and the other session's Playwright driver.
**Rule:** a sweep is a regression signal only beside a same-session control sweep of the reference
commit, and only with this session's own background jobs finished. The v3.9.0 perf record is HEAD
947 / 932 ms, `/trades` 998 / 950 (was 1,968 at v3.8.0).

## 2026-09-05 — v3.9.0 "Trust the numbers" cut, tagged, deep-verified: the evidence

- Release commit `e5ea549`; CI run 33911278690 **6/6 green** (check, windows-gate, e2e ubuntu,
  e2e macOS, desktop-bundle-macos, load) BEFORE the tag. Tag `v3.9.0` → release run 33911990805,
  3/3 jobs; draft release with latest.json, Windows setup.exe + .sig, both macOS dmg/app.tar.gz + .sig.
- `npm run release:verify v3.9.0 -- --deep` → **3/3 signatures verify over the published bytes**,
  every key id `4FF85F3BBE1DA21D` = the pubkey shipped in the app. Local artefacts: same key id.
- Verify 276 files / 5,208 tests (was 254 / 4,515 at v3.8.0 — up, nothing deleted); load 16/16;
  e2e 84 flows / 28 specs; perf 947 / 932 ms overall idle, `/trades` 998 / 950.
- Desktop build BUILD_ID 2026-09-05 00:53 (v3.8.0's was 2026-09-04 11:44); `vyuha-search-panel`
  and `Broker Truth` markers found in the bundle.
- Client ZIP `release-packages/Vyuha_3.9.0_Client_Package.zip` (36.1 MB), installer SHA-256
  `094949764548D46010AB9E51BEB08F9F164758F21E1A3EF1C2FD38F2327443E8` (the local build — the GitHub
  asset is CI's own binary, a different hash by construction; WDSI takes the client-ZIP hash).
- Not done by this session, by design: publishing the draft (owner action, as v3.8.0), the install
  on a non-build machine (owner), the revocation-list prerelease (nothing revoked this release).
- Lockfile: root version fields edited by hand, `git diff --numstat package-lock.json` = 2/2;
  `npm ls esbuild` clean.

## 2026-09-05 — v3.9.0 PUBLISHED (owner-confirmed)

Draft published, installer from the client ZIP installed and working on a non-build machine, WDSI
submitted. Owner directive the same day: before v4.0, research and build a website + web app so
users choose local or web; v4.0's plan is rebuilt after the owner supplies investor-requested
features. Research pack: `T:/Thejesh/CLAUDE-CODE/VYUHA-WEB-PLATFORM-RESEARCH/`.
