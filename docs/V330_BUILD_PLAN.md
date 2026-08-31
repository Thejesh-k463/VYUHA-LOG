# v3.3.0 — BUILD PLAN

**Release shape changed 2026-08-31 (owner):** Phases 0–3 ship as **ONE v3.3.0 minor**. The
separate v3.2.1 patch is cancelled — its work is Phase 0 below and is already code-complete on
the working tree. Nothing in this plan was dropped by that change; only the number of releases.

Written 2026-08-31, from four independent research streams (competitor workspace teardown,
internal tax/KPI inventory, Indian tax-lever research against primary sources, third-party
repo teardown). Owner chose the shape; the four decisions are recorded in §6.

**This file exists so the citations below are never re-derived.** Every statutory quote here
was read from the Gazette text or the ICAI PDF, not from commentary. Web search returned the
WRONG answer on the single most contested item (§2.1) consistently across several sources.

---

## 1. THE FINDING THAT REORDERS EVERYTHING

**The Income-tax Act, 1961 is repealed. The Income-tax Act, 2025 (Act 30 of 2025) came into
force on 1 April 2026.** Verified in the Gazette text:

> "(3) Save as otherwise provided in this Act, it shall come into force on the 1st April, 2026."

The current year is **tax year 2026-27**. "Previous year" and "assessment year" no longer exist.
Every section number Vyuha displays is repealed law for the current year.

**The arithmetic survives; the citations do not.** 20% / 12.5% / ₹1,25,000 carry over. The
₹10 Cr audit and ₹3 Cr presumptive limits in `lib/analytics/itr.ts:61-62` are still correct and
the sourcing comment above them is accurate. Grandfathering survives verbatim. The 15/45/75/100
instalments are unchanged. **This is an effective-dating problem, not a rewrite** — the same
shape as v3.2.0's WS1 charge-rate epochs.

### 1.1 Section map — 1961 Act → 2025 Act

| Subject | 1961 | **2025** |
|---|---|---|
| Speculative transaction | 43(5) | **66(31)** |
| Specified derivative transaction (F&O carve-out) | 43(5) provisos (d)–(f) | **66(33)** |
| STT/CTT deductible as business expense | 36(1)(xv)/(xvi) | **32(k)** |
| General business deduction | 37(1) | **34(1)** |
| Depreciation | 32 | **33** |
| Capital gains computation; STT NOT deductible | 48 + proviso | **72(1)**, **72(3)(b)** |
| Cost of acquisition / 31-Jan-2018 FMV | 55(2)(ac) | **90** |
| Presumptive taxation | 44AD | **58** |
| Books of account | 44AA | **62** (+ Rule 46) |
| Tax audit | 44AB | **63** (+ Rule 47, Form 26) |
| Intra-head set-off | 70 | **108** |
| Inter-head set-off | 71 | **109** |
| Carry forward capital loss | 74 | **111** |
| Carry forward business loss | 72 | **112** |
| Speculation loss | 73 | **113** |
| Carry-forward forfeited if return late | 80 | **121** (via 263(1)) |
| Rebate | 87A | **156** |
| STCG on STT-paid equity | 111A | **196** |
| LTCG on STT-paid equity | 112A | **198** |
| New (default) regime | 115BAC | **202** |
| Securities stripping | 94 | **175** |
| GAAR | Ch. X-A (95–102) | **178–181** (+ Rule 128) |
| Advance tax instalments | 211 | **408** |
| Interest — late return / advance tax / deferment | 234A/B/C | **423 / 424 / 425** |

### 1.2 Corroboration of work already shipped

v3.2.0's WS1 seeded `STT_EPOCH_2026 = "2026-04-01"` from NSE Circular 02/2026. This research
reached the same three rates and the same date from the Finance Act 2026 side: futures sale
0.02→0.05%, option sale 0.10→0.15%, option exercised 0.125→0.15%. **Independent corroboration
of the epoch data.**

---

## 2. VERIFIED DEFECTS — Phase 0 / v3.2.1

### 2.1 F&O turnover omits option premium, and that number decides the audit verdict — HIGH

`lib/analytics/itr.ts:131` computes F&O turnover as `Math.abs(t.grossPnl)`. That number flows
into `auditVerdict(b.spec.turnover + b.fno.turnover, …)` at `itr.ts:148`.

**ICAI Guidance Note on Tax Audit, ELEVENTH edition (2026), para 5.11(b)** — read from the PDF:

> "(i) The total of favourable and unfavourable differences in case of squared off transactions
> shall be taken as turnover.
> (ii) **Premium received on sale of options is also to be included in turnover.** However,
> where the premium received is included for determining net profit for transactions, then such
> net profit should not be separately included.
> (iii) In respect of any **reverse trades** entered, the difference thereon, should also form
> part of the turnover.
> (iv) In case of an **open position** as at the end of the financial year … the turnover …
> should be considered in the financial year when the transaction has been actually squared off.
> (v) In case of **delivery based settlement** in a derivatives transaction, the difference
> between the trade price and the settlement price shall be considered as turnover…"

Limiter in the same para: "This is only and only for the purpose of computing 'turnover' for
tax audit."

**EDITION HISTORY — the trap.** Premium was REMOVED in the 8th edition (2022) and **REINSTATED
in the 9th (2023)**, carried unchanged through the 10th (2025) and 11th (2026). The widely
repeated "turnover = absolute profit only, premium never counts" is the 2022 position and has
been wrong since 2023. **Web search returns the superseded answer consistently.** Do not
re-derive this from search; the PDF is the only source worth trusting.

**Two caveats to record with the fix:**
- The Guidance Note is ICAI professional guidance, **not statute**. Neither the Act nor the
  Rules prescribe a derivatives turnover method.
- The 11th edition's Preface states it is the **concluding edition under the 1961 Act**. There
  is currently **no ICAI turnover guidance mapped to s.63.** Carrying 5.11(b) forward is
  practice, not authority. Label it as such in the UI.

### 2.2 Three incompatible turnover formulas, two on screen at once — HIGH

| Site | Formula |
|---|---|
| `lib/analytics/tax.ts:65` | `abs(grossPnl) + (options ? sellValue : 0)` — closest to correct |
| `lib/analytics/itr.ts:131` | `abs(grossPnl)` — superseded 2022 position, feeds the audit verdict |
| `lib/analytics/itr-schedule.ts:161` | `abs(netPnl)` — wrong on a third basis |

A user comparing `/reports/tax` with `/reports/itr` sees two different turnovers for one year.
**Fix: one module, three call sites.** Include the anti-double-count proviso, reverse trades,
and the open-position exclusion.

### 2.3 Advance tax over-charges interest, two ways — MEDIUM

The rate is FINE. `advance-tax.ts:77` computes `shortfall * 0.01 * months` with months 3/3/3/1,
yielding 3%/3%/3%/1% — **numerically identical** to the new s.425 table, verified in the Gazette
(column E reads 3, 3, 3, 1). Do NOT "fix" the rate; it is right.

Two things are missing:

**(a) s.425(2) safe harbour** — Gazette verbatim:

> "(2) The assessee shall not be liable to pay any interest under sub-section (1), if the
> advance tax paid by the assessee on the current income,—
> (a) on or before the 15th day of June is 12% or more of the tax due on the returned income;
> (b) on or before the 15th day of September is 36% or more of the tax due on the returned income."

**First two instalments only. There is no tolerance for December or March.**

**(b) s.425(4) relief** — Gazette verbatim:

> "(4) No interest shall be payable under sub-section (1) or (3) in respect of shortfall in the
> payment of tax due on returned income, where,—
> (a) the shortfall is on account of underestimation of, or failure to estimate the following
> income:— **(i) capital gains;** (ii) income as per section 2(49)(n); **(iii) income under the
> head profits and gains of business or profession accruing or arising for the first time;**
> (iv) dividend income; and
> (b) the assessee has paid in full, the tax payable on the said income had such income been
> part of total income, **in any of the remaining instalments of advance tax, if any, or by the
> 31st day of March of the tax year.**"

**Four things to get right:**
1. Capital gains is covered unqualified.
2. Conditions are **conjunctive** — relief is not automatic on the character of the income; the
   tax must actually have been paid in a later instalment or by 31 March. Build the **payment
   test**, not a defensibility test.
3. There is no statutory "could not reasonably have been estimated" test.
4. **Clause (a)(iii) covers business income only when "accruing or arising for the first time".
   An established F&O or intraday trader gets NO relief on a windfall quarter.** Vyuha already
   classifies by head, so it holds the discriminator — but "first time" needs trading history
   predating the journal, so it is a (B) input, not (A).

Relief never touches s.424 (old 234B). The only protection there is s.408(3): anything paid by
31 March counts as advance tax.

### 2.4 Harvest rates not effective-dated — LOW

`lib/analytics/harvest.ts:30` hardcodes post-2024-07-23 rates while `capital-gains.ts:47-49`
correctly resolves by sell date. For tax year 2026-27 only one rate pair is live, so this is
currently harmless — but it is an inconsistency that will bite on a historical FY.

### 2.5 `lib/analytics/tax.ts` has no test file

Every sibling tax module has one. It is the module behind the primary `/reports/tax` FY table.

---

## 3. WHAT IS SAFE TO BUILD — the (A)/(B)/(C) line

The design rule: **compute and display in (A); collect-or-blank in (B) (invariant 6); in (C)
state the rule and its source, never the recommendation.** The difference between "here are
your unrealised losses and your realised gains" and "sell these" is the whole regulatory
exposure, and it is one sentence wide.

### (A) DETERMINISTIC — computable from executed-trade data

- Head classification: delivery → capital gains; intraday equity → speculative business
  (s.66(31)); F&O → non-speculative (s.66(33)). Everything downstream depends on this.
- ST/LT bucketing at 12 months, FIFO (already done).
- Days-to-LTCG countdown per open lot.
- Gross s.196 (20%) / s.198 (12.5% above ₹1,25,000) on the capital-gains slice. **The slice is
  (A); the liability is (B).**
- Grandfathered cost under s.90 — (A) **only with a bundled 31-Jan-2018 FMV dataset**.
- Realised-gain vs unrealised-loss inventory with ₹1.25L headroom — the harvesting screen.
- Intra-head set-off (s.108): STCL absorbs BOTH STCG and LTCG; LTCL absorbs only LTCG.
- **Order-of-set-off optimisation** — STCL against 20% gains before 12.5% gains.
  *JS Capital LLC v. ACIT, ITA No. 3396/M/2021 (ITAT Mumbai)*. **ITAT-level authority under the
  1961 Act, not Supreme Court and not under s.108. Compute it; label the basis; do not present
  it as settled.**
- **44AB/s.63-basis turnover on ICAI 5.11(b) with workings shown** (§2.1).
- **STT split: deductible on F&O/intraday legs (s.32(k)), forfeited on delivery legs
  (s.72(3)(b)).** Exact, and directly monetised. Note s.72(3)(b) names only STT, not CTT.
- Same-scrip sell-and-rebuy detection surfaced **as a fact**. Reporting what happened is (A);
  saying it is fine is (C).
- Speculative vs non-speculative loss segregation, 4-year (s.113) vs 8-year (s.112) clocks.

### (B) NEEDS EXTERNAL FACTS — blank, never fabricate

- Actual tax payable (salary, other heads, regime, residency, age).
- **The ₹1,25,000 threshold is per PERSON per TAX YEAR across all s.198 gains.** Mutual funds
  held elsewhere consume the same threshold. **A per-account figure is simply wrong.**
- Inter-head set-off (s.109) — needs the other heads.
- Brought-forward loss balances and vintages; whether prior returns met the s.263(1) due date
  (s.121 forfeits carry-forward on a late return).
- Whether s.425(4)(a)(iii) applies — is the business income "first time"?
- Regime status under s.202(4) and whether the one-shot withdrawal is spent.
- s.63 audit trigger (needs TOTAL business turnover including non-market business, plus cash
  receipt/payment ratios); s.58 eligibility and the five-year lock-out.
- Surcharge banding; expense apportionment under s.33(3)(b).
- Cross-broker positions — **you could see all of them, but only if the user imports them.**

### (C) ADVICE — must not be presented as a recommendation

- **"Sell X to harvest a loss"** — naming a scrip and prompting a transaction. SEBI (Investment
  Advisers) Regulations 2013 reg. 3 requires registration; reg. 4 exempts general comments on
  **trends** "without specifying particular securities". Every competitor pairs its screen with
  "consult a CA". **Match that norm; do not out-claim it.**
- "This is safe" / "the department won't question it".
- **"Wait N days before buying back" — ACTIVELY DANGEROUS.** India has **no wash-sale rule**.
  Inventing a holding period teaches the user false law.
- "You should opt out of the new regime" / "you should elect s.58" — both are one-way doors
  (s.202(4) withdrawal is irreversible; s.58(7) locks out for five years).
- Whether an arrangement is an impermissible avoidance arrangement (ss.178–181).
- Estimating total liability and telling the user what to pay.

### 3.1 Harvesting — the honest legal position

- **No general wash-sale / bed-and-breakfasting rule exists** in the Income-tax Act, 2025.
  Nothing in ss.72, 90, 108 or 111 imposes an interval between sale and repurchase.
- Strongest positive authority: **CIT v. Walfort Share & Stock Brokers P. Ltd.**, SC, 2010,
  326 ITR 1 — a transaction cannot be ignored merely because it is tax-motivated.
- **GAAR is effectively out of reach for retail.** Rule 128 of the Income-tax Rules, 2026
  (Gazette): Chapter XI does not apply where "the aggregate tax benefit in the relevant tax
  year, to all the parties to the arrangement, does not exceed a sum of three crore rupees".
- The residual risk is the ordinary **colourable-device / sham-transaction doctrine** applied in
  scrutiny — i.e. a synchronised or reversal trade where beneficial ownership never really
  changed. A genuine on-exchange sale at market price, with counterparty risk actually borne,
  is a transfer. **Zerodha's own published caution is the right register to mirror, not
  out-claim.**

### 3.2 Stripping — s.175(8)/(9)/(10) — NOT IN SCOPE, and why

s.175 disallows dividend stripping (buy within 3 months before record date, sell within 3
months after for securities / 9 months for units, where the income is exempt) and bonus
stripping (buy within 3 months before, allotted free, sell within 9 months after), with
s.175(10) adding the ignored bonus loss to the retained units' cost — deferral, not forfeiture.

**Nobody in the surveyed market computes it, and it runs AGAINST the user, which is exactly why
it is safe to ship and why no competitor will.** It requires a bundled dividend/bonus
record-date dataset.

**Owner declined that dataset on 2026-08-31 (§6). The lever is therefore dropped from this
plan.** Recorded here so it is a visible scope decision, not a silent absence. Note also that
s.175(8) requires the income to be **exempt**, which narrows its reach for ordinary equity
dividends now that they are taxable; s.175(9) bonus stripping has no such condition and applies
squarely.

---

## 4. COMPETITIVE POSITION

### 4.1 What the market ships

Tax-loss harvesting is **table stakes, not a differentiator** — Zerodha, Groww, Dhan and Upstox
all ship a free first-party TLH screen applying ₹1.25L to realised gains vs unrealised losses.

- **Zerodha Console** — the most complete. Publishes **two disagreeing turnover sheets** and
  tells users to use the tradewise one. Explicitly NOT ITR-ready; names off-market transfers,
  post-2018 corporate actions on FMV, cancelled dividends and gifts as manual fixes.
- **Quicko** — TLH is "Coming Soon!" on every tier. No F&O turnover calculator.
- **ClearTax** — no TLH tool; its "loss harvesting" page is editorial.
- **Sensibull** — no tax reporting at all.
- **INDmoney** — free Tax Centre with quarterly advance-tax breakdowns; no harvesting screen.
- **Kuvera** — "Tax Harvesting" means **GAIN** harvesting (using ₹1.25L to reset cost basis),
  MF only. **This is why the phrase is overloaded in India — label ours distinctly.**

### 4.2 Genuinely differentiated for Vyuha

1. **Cross-broker harvesting** — every shipped screen in the market is single-broker.
2. **A correct s.63 turnover** — Zerodha publishes two conflicting figures, Quicko has no
   calculator, and the whole market is quoting the superseded 2022 premium rule.
3. **Speculative-vs-F&O loss ordering and the in-year s.109 inter-head set-off asymmetry** —
   an F&O loss can offset capital gains THIS YEAR but never salary; carried forward it can only
   meet business income. So the same rupee is often worth more used now. Untouched by every TLH
   screen, which are all equity/MF holdings only.
4. **Honest handling of what breaks the report** — Zerodha publishes its own failure list; a
   journal carrying user corrections for exactly those fills an admitted gap.

**Do not build:** ITR e-filing (INDmoney gives it away free).

### 4.3 Competitor workspace — assessed and declined

`nexusjournal.co.in/workspace` is a chromeless canvas of free-floating draggable/resizable
windows with tabs, 40 widgets, persisted to one localStorage key per portfolio
(`nexus:workspace:${portfolioId}:canvas-v2`). No templates, no presets, no sharing, no
server-side layout state. Desktop only.

**The decisive finding: the widgets are a thin adapter, not a framework.** `TaxMetricsWidget`
is **494 bytes**; `JournalNewsWidget` 527 B; `MonthlyPerformanceWidget` 1.5 KB. Each re-mounts
an existing page component with an `isWidgetMode`/`displayMode` prop. The workspace shell is
59 KB against `useBrokerApiModalState` at 302 KB and `unifiedBrokerProcessor` at 189 KB. **The
expensive, defensible work is all upstream in broker ingestion and tax modelling.** They also
do not market it at all — zero occurrences of "widgets", "canvas", "boards" or "layout" across
11 public pages.

**Declined for Vyuha.** Three reasons: it has no print story, and Vyuha's reports are
paper-bound (`@media print` re-themes SVG through CSS custom properties, which is why charts
stay recharts); it multiplies the pointer-only accessibility debt that `DECISIONS.md:1002-1010`
already records for sidebar reorder; and it is the wrong lever, since their own bundle proves
the widgets are worthless without the pages behind them.

**Build instead, in rising cost:** persist the dashboard filters (bare `useState` at
`dashboard-client.tsx:40-47` today, so every visit resets); pinned/orderable KPI cards reusing
`SHARE_METRICS`' picker plus `nav-config.ts mergeOrder`; then saved views (`{filters, columns,
sort}`), which is the one item on their list with no Vyuha equivalent.

Note: `settings.workspace` is already taken (`both|equity|fno`). Any such feature needs a
different name.

### 4.4 `MrChartist/india-s-best-option-hub` — assessed

**MIT licensed**, so reuse in a closed-source commercial product is permitted with the notice
reproduced. But 94% of commits are `lovable-dev[bot]`, and it shows: the UI is polished, the
maths layer is thin and in places wrong.

**Worth taking:** `getMaxPain` in `oiUtils.ts` (correct, ~15 lines — small enough to
reimplement from the definition and skip the notice burden); Black–Scholes Greeks as a
*reference to rewrite* (no dividend term, calendar/365 day-count unstated, no Black-76 path,
and **no IV solver exists anywhere in the repo**); and three architectural patterns —
credential-holding local proxy, disk-backed last-good cache under short per-endpoint TTLs, and
a **visible data-source provenance bar** (invariant 6's instinct applied to provenance).

**Must not take:** `LOT_SIZE_MAP` (stale by two NSE revisions, with a magic `|| 500` fallback
that fabricates quantities); IV Rank / IV Percentile / HV / VRP (**generated from a seeded
RNG** and rendered as fact); `estimateProbOfProfit` (walks 200 evenly-spaced z and returns an
unweighted fraction — the normal density is never applied); `estimateMargin` (subtracts premium
received from the requirement, which is not how SPAN works); any P&L path (gross only, no
charges engine at all).

**Hard prohibition:** the NSE access path spoofs a Chrome UA, harvests cookies and forges a
Referer. **MIT licenses the scraper; it grants nothing over the data.** Do not port it.

---

## 5. PHASES

### Phase 0 — correctness (DONE 2026-08-31, unreleased)

Sources verified: Gazette Act text, ICAI GN 11th ed. PDF, and the **enacted Finance Act, 2026**.

1. One turnover module replacing three call sites; premium included per 5.11(b) with the
   anti-double-count proviso; reverse trades in; open positions excluded until squared off.
2. s.425(2) safe harbour (12% / 36%, first two instalments only).
3. s.425(4) relief — payment test, capital gains covered, business income only if first-time
   (a (B) input, so blank rather than assume).
4. `harvest.ts` rates resolved by date, matching `capital-gains.ts`.
5. `tests/tax.test.ts`.

Do NOT change the 3/3/3/1 interest rate — it is already correct.

### Phase 1 — statute epochs (v3.3.0)

Tax year → governing statute → section labels and thresholds, reusing WS1's shape. Historical
years keep 1961 citations and stay correct; 2026-27 onward shows 2025 Act sections. Nothing
re-computes. Section numbers come from the Act itself, so this is **not** Finance-Act gated.

### Phase 2 — monthly depth, on EXISTING screens (v3.3.0)

- `/reports/monthly`: add net ₹, trade count, win rate, charges to the matrix. `MonthlyReturn.net`
  is already computed at `performance.ts:240` and discarded.
- `/reports/tax`: a monthly **realised-by-head** split.

**Label it precisely.** Tax is an annual computation — set-off, thresholds and slabs are annual.
A "monthly tax breakdown" can only honestly be (a) monthly realised gains by head, or (b)
monthly accrual toward the advance-tax instalments. It can never be "your tax for March".
Nexus ships `tax_mth`; the honest label is the differentiator.

### Phase 3 — tax-saving surface (v3.3.0, partly gated)

Built to the (A)/(B)/(C) line in §3. **Gated on the owner supplying the Finance Act 2026 text**
for the surcharge table and any amended thresholds in ss.58/63/196/198.

### Not in scope

- Floating-window canvas (§4.3).
- s.175 stripping check (§3.2 — record-date dataset declined).
- ITR e-filing.
- LIFO analysis lens (deferred in v3.2.0; reasoning in `DECISIONS.md:77-81`).

---

## 6. OWNER DECISIONS — 2026-08-31

1. **Statute:** epoch it, like WS1. Historical FYs keep 1961 citations.
2. **Release:** ~~v3.2.1 patch now, then a minor~~ — **SUPERSEDED 2026-08-31: one v3.3.0
   carrying Phases 0–3.**
3. **Datasets:** bundle the **31-Jan-2018 FMV snapshot**. Dividend/bonus record dates
   **declined** → s.175 stripping check dropped.
4. **Verification:** owner supplies the Finance Act 2026 text; nothing Finance-Act-dependent is
   encoded until then.

---

## 7. UNVERIFIED — do not encode without checking

- ~~**Finance Act 2026 amendments**~~ — **RESOLVED 2026-08-31.** The owner supplied the enacted
  **Finance Act, 2026 (No. 4 of 2026)**, assented 30 March 2026, and the Finance Bill, 2026
  (Bill No. 3 of 2026). The ACT is authoritative; the Bill differs and must not be cited.
  It amends 88 sections of the 2025 Act. Findings that gate this plan:
  - **s.425 is amended at sub-section (5)(f) ONLY** (a tax-credit cross-reference). The Table's
    3/3/3/1 rates, the s.425(2) safe harbour and the s.425(4) relief are all UNTOUCHED.
  - **s.66 is amended at clause (4) ONLY** (commodities-tax definitions). Clauses (31) and (33)
    — speculative transaction and the F&O carve-out — are UNTOUCHED.
  - **s.63, s.196, s.198, s.72, s.90 and ss.108–113 are NOT amended at all.**
  - **s.58 (presumptive), s.202 (regime) and s.263 (returns) ARE amended** — read them before
    Phase 3 touches any of those.
- **Surcharge table** — First Schedule to the Finance Act. Present in the supplied PDF; READ IT
  before encoding, rather than carrying the secondary figures.
- **CBDT Circular 7/2017** wording — PDF is an image scan. The ₹3 Cr GAAR threshold is
  independently Gazette-verified via Rule 128; the Q&A wording is secondary.
- **s.2(49)(n)** — the second qualifying income in s.425(4). Not read.
- Short-term capital asset clause number — sources give both 2(101) and 2(118).
- **s.63(1) Sl. No. 2 vs s.58(3)** — the successor to 44AB(e) appears to lack the
  basic-exemption filter, colliding with s.58(3). No CBDT clarification found.
- **No authority either way on whether s.58 applies to F&O** under the 2025 Act.

## 8. PRODUCT FACTS WORTH SURFACING IN-APP

From the notified Income-tax Rules, 2026, read from the Gazette text:

> **Rule 46(8):** "The books of account and other documents … maintained in electronic mode
> shall remain accessible in India at all times, and the backup … shall be kept on a daily
> basis in servers physically located in India."
>
> **Rule 46(9):** "… shall be kept and maintained for a period of **seven tax years** from the
> end of the relevant tax year."

Retention is **seven** years, not the six of old Rule 6F(5). And for a product whose pitch is
local-first storage, Rule 46(8) is a first-order fact: a trader relying on Vyuha as their books
of account has a daily backup obligation to India-located servers. **A local-only design does
not satisfy that by default.** Say so rather than let the user assume otherwise.
