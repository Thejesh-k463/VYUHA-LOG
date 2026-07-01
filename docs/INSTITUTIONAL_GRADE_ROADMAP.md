# Vyuha — Institutional-Grade Roadmap & Build Handoff

**Status:** v1.3.0 · single-user, local-first, offline · Next.js 16 (App Router) + TS,
Tailwind v4, Drizzle ORM / better-sqlite3, Recharts, TanStack Table, packaged as a
Tauri desktop app.

**Purpose of this doc:** a self-contained handoff so a *fresh* session (no chat
history) can take Vyuha from "excellent retail journal" to "institutional grade."
It records (1) what exists and where, (2) hard-won conventions you MUST preserve,
and (3) a prioritized, build-ready roadmap with design + acceptance criteria.

Read sections 1–2 before writing any code.

> **Built since this doc was written (do NOT rebuild):**
> - **IND-6 Dividend & TDS tracker (DONE)** — pure `lib/analytics/dividend-tds.ts` (10 tests): Section 194 —
>   10% TDS once a company's aggregate FY dividend to the shareholder crosses ₹5,000; `computeEventTds()` taxes
>   the whole payment that crosses the threshold (and every payment after), the common real-world convention since
>   payers estimate annual dividend up front rather than prorating a single payment. `annotateDividendTds()` /
>   `summariseByCompanyFy()` run a running per-symbol-per-FY total. New `ledger_entries.symbol` column (migration
>   `0011`, nullable — only dividend/dividend_tds rows set it) lets TDS aggregate correctly per company without
>   depending on the linked trade's raw (possibly alias'd) symbol string. New `LedgerType` value `dividend_tds`
>   (sign −1) added to `lib/analytics/ledger.ts`; `otherPaise` now includes it. Wired into
>   `lib/corporate-actions-apply.ts`'s dividend branch: seeds the running FY total from prior `dividend` ledger
>   rows for that symbol, posts a second `dividend_tds` ledger entry per position once threshold crosses. New
>   "Dividend income & TDS" card on `app/reports/tax/page.tsx` (gross/TDS/net per company+FY). Verified end-to-end
>   against real data: applied a test dividend (₹5/share × 1800 qty = ₹9,000 gross) on a real open position,
>   confirmed ₹900 TDS posted (FY aggregate crossed ₹5,000) and the tax-summary card showed gross ₹9,000 / TDS ₹900
>   / net ₹8,100 correctly — then reverted the ledger/corporate-action rows to restore the original empty state.
>   Only dividends recorded via this app's own Corporate Actions are counted — same-company dividends received
>   through a different, untracked demat won't be seen, so this can understate real aggregate TDS liability
>   (flagged in the UI caveat).
> - **IND-1 + IND-2 Dual capital-gains regime + speculative/non-speculative set-off (DONE)** — pure
>   `lib/analytics/capital-gains.ts` (32 tests): date-based STCG/LTCG rates (pre/post 23-Jul-2024 cutover:
>   15%/10%/₹1L → 20%/12.5%/₹1.25L), LTCG grandfathering formula for pre-31-Jan-2018 lots (cost = max(actual,
>   min(FMV@31Jan2018, sellValue)) — no FMV-entry UI yet, so it correctly no-ops to actual cost unless a caller
>   supplies `fmv31Jan2018`), and full sections-70/71/72-74 set-off + carry-forward: STCL→STCG→LTCG,
>   LTCL→LTCG-only, speculative (intraday) loss isolated to speculative gains only (4yr carry), non-speculative
>   (F&O) loss offsets ANY same-year gain incl. capital gains (8yr carry, business-income-only once carried).
>   `aggregateTradesByFy()` computes a **gain-weighted** rate per FY (not just FY-end rate) so a straddling year
>   like FY2024-25 taxes each trade at ITS OWN date's rate — flagged as an approximation in the UI since set-off
>   nets in ₹ after the per-trade rate is already baked in. All bucketing uses **`netPnl`** (post-charge),
>   matching `taxByFy`'s existing convention — do NOT swap in `grossPnl`, that was a real bug caught during
>   verification (see below). `computeTaxTimeline()` chains FYs; carry-forward lots are cloned before mutation
>   inside `computeFySetOff`'s `absorb()` (an earlier shared-reference bug corrupted a prior FY's already-returned
>   result — fixed by `.map(l => ({...l}))` before absorbing). Wired into `app/reports/tax/page.tsx` as a second
>   "Capital-gains tax & set-off" table below the existing raw scaffold, informational-only disclaimer, extensive
>   caveat text (rate schedule, straddling-FY approximation, set-off summary, business-income slab-rate caveat,
>   conditional grandfathering warning when a pre-2018 lot exists). Verified against real data: engine output for
>   FY2026-27 (speculative loss carry ₹82,088 + non-speculative loss carry ₹112,997 = ₹1,95,085) now matches the
>   scaffold table's net-realised figure exactly.
> - **P1.1 Quant performance analytics** — `lib/analytics/performance.ts` (Sharpe/Sortino/Calmar/CAGR/
>   volatility/max-DD/monthly returns, on running equity) + `tests/performance.test.ts` (8) +
>   screen `app/reports/performance/page.tsx` + nav "Performance" (Analytics group). XIRR/TWR &
>   benchmark alpha/beta still pending (need P0.2 ledger + a benchmark series).
> - **IND-7 Physical-settlement / expiry obligation tracker** — `lib/analytics/settlement.ts`
>   (pure; stock-F&O physical settlement, ITM/delivery/exercise-STT, index = cash) +
>   `tests/settlement.test.ts` (14) + `components/risk/expiry-obligations.tsx` panel on `/risk`
>   + `getSpotMap()` in `lib/queries/mtm.ts`. Delivery-STT is read from `charge_config` (eq_delivery);
>   the option-exercise STT is a labeled statutory default. Underlying spot for option moneyness comes
>   from non-derivative MTM rows; missing spot degrades to a conditional "if-ITM" obligation.
>   `scripts/demo-ind7.mjs insert|clean` is a reversible fixture for manual verification.
> - **IND-8 F&O ban / ASM-GSM surveillance alerts** — new `restricted_securities` table (migration
>   `drizzle/0003_*`), pure engine `lib/analytics/restrictions.ts` (8 tests) matching open positions
>   against a pasted ban/ASM/GSM/circuit list with severity + guidance (F&O ban downgrades to info for
>   equity-only holders). Screen `app/surveillance/page.tsx` (nav "Surveillance", Risk group), route
>   `app/api/restrictions/route.ts` (load/clear via fetch), `getRestrictedList()` + `getHeldSymbols()`
>   in `lib/queries/restrictions.ts`. Offline-first: user pastes the daily NSE/BSE list.
> - **IND-16 SEBI reality-check / discipline nudge** — pure `lib/analytics/sebi-reality.ts` (6 tests):
>   user's realised F&O win-rate / net / expectancy / profit-factor / charge-drag vs SEBI's FY2024 facts
>   (91.1% lose). Card `components/reports/sebi-reality-card.tsx` on `/reports/discipline`.
> - **IND-14 Broker-cost comparison** — pure `lib/analytics/broker-compare.ts` (6 tests) re-prices all
>   trades under each broker's charge_config rate card via the real charges engine. Screen
>   `app/reports/broker-compare/page.tsx` (nav "Broker Costs", Analytics) — per-broker
>   brokerage/statutory/GST/DP/MTF totals, cheapest + savings vs recorded. Statutory is broker-invariant.
> - **IND-4 Advance-tax planner** — pure `lib/analytics/advance-tax.ts` (6 tests): 15/45/75/100% instalment
>   schedule + §234C interest (3/3/3/1 months) + §234B underpaid flag. Client calculator
>   `components/reports/advance-tax-calc.tsx` on `/reports/advance-tax` (nav "Advance Tax"), prefilled from
>   realised FY P&L. §234B is a caveat (not assessable in a forward planner), not a computed number.
> - **IND-3 Tax-loss harvesting** — pure `lib/analytics/harvest.ts` (8 tests): STCL→STCG-then-LTCG, LTCL→LTCG
>   only, ₹1.25L LTCG exemption, post-23-Jul-2024 rates (STCG 20% / LTCG 12.5%). Screen
>   `app/reports/harvest/page.tsx` (nav "Tax Harvest") scans OPEN equity-delivery lots for unrealised losses
>   vs realised FY STCG/LTCG → est. tax saved + carry-forward. F&O/intraday excluded (business income).
> - **IND-11 Expiry-day analytics** — pure `lib/analytics/expiry-stats.ts` (6 tests): derives the expiry
>   calendar from the journal's own F&O expiry dates, splits closed F&O P&L expiry-day vs other, lists
>   upcoming expiries from open positions. Screen `app/reports/expiry/page.tsx` (nav "Expiry Analytics").
>   NOTE: imported F&O P&L rows are scrip-aggregated with NO `sell_date`, so the expiry/non-expiry split is
>   empty until trades carry exit dates (manual/open-trade entries do); the upcoming calendar works regardless.
> - **IND-10 Option strategy recognition + payoff diagrams** — pure `lib/analytics/strategies.ts` (9 tests):
>   groups open option legs by underlying+expiry, classifies (single / straddle / strangle / vertical spread /
>   iron condor·butterfly / butterfly, else "Custom"), computes the EXACT expiry payoff (net premium, max P/L
>   with unbounded detection, breakevens, payoff curve). `components/reports/payoff-chart.tsx` (Recharts area,
>   zero-split gradient, breakeven + spot reference lines). Screen `app/strategies/page.tsx` (nav "Option
>   Strategies", Positions group). Payoff is model-free; live Greeks need an IV feed (future). Short legs read
>   from sell-to-open positions.
> - **P0.1 Money core (foundation — STAGED)** — `lib/money.ts` (6 tests): `Paise` integer type, `toPaise/`
>   `toRupees/parsePaise`, `addP/subP/sumP/mulP/pctP`, `roundRupee` (statutory), `formatPaise`. New code uses
>   it natively. **STEP (1) DONE:** `engine/charges.ts` now computes natively in integer paise via
>   `computeChargesPaise` (paise in/out); `computeCharges` is a thin rupee wrapper so existing callers + REAL
>   columns are untouched. Byte-identical outputs — all 145 prior tests stay green + `tests/charges-paise.test.ts`
>   asserts `computeChargesPaise == toPaise(computeCharges)`. KEY: STT/stamp must round straight to the rupee from
>   the paise-float (`roundRupee(pct*paiseBase)`), NOT via an intermediate paise round, or .495-boundary values drift.
>   **REMAINING STAGED PLAN:** (2) migrate `trades` money columns to `*_paise` INTEGER (data migration ×100, round)
>   + dual-read shim; (3) move `analytics/*` + `risk/*` onto `computeChargesPaise`/paise reads; (4) drop the REAL
>   columns. Do (2)→(4) one subsystem at a time, keeping tests green each step.
> - **P0.2 Cash & fund-flow ledger** — `ledger_entries` table (`amount_paise` INTEGER, migration `0004_*`),
>   pure `lib/analytics/ledger.ts` (5 tests; available = opening + Σ signed flows, per-bucket running balance,
>   by-type breakdown), `lib/queries/ledger.ts`, `app/api/ledger/route.ts` (add/delete via fetch),
>   `app/cash/page.tsx` + `components/cash/{ledger-form,ledger-table}.tsx` (nav "Cash & Ledger", Journal group),
>   CSV/XLSX export. Opening capital still comes from `settings`; the ledger derives *available* on top of it.
>   NEXT: post trade realised-P&L + charges as ledger entries automatically (replaces `settings.pnlRolledIn`
>   compounding) and feed the cashflow series into an XIRR/TWR money-weighted return (completes P1.1).
> - **P1.1 XIRR money-weighted return (DONE)** — pure `lib/analytics/xirr.ts` (5 tests): Newton-Raphson +
>   bisection fallback on dated paise cashflows. Wired into `app/reports/performance/page.tsx` as an
>   "XIRR (money-weighted)" KPI: cashflows = −opening @ start, ∓ ledger deposits/withdrawals, +terminal @ today,
>   where terminal = opening + external ledger flows + internal ledger flows + realised (closed trades) +
>   unrealised (open × MTM). Start date = earliest of go-live / first sell-date / first ledger date. CAVEAT:
>   undated aggregated F&O P&L is lumped into terminal (no per-trade date), and short windows annualise sharply;
>   once realised P&L is auto-posted to the ledger with dates (the P0.2 "next"), XIRR tightens to per-trade timing.
> - **P1.1 TWR + benchmark alpha/beta (DONE — completes P1.1)** — `timeWeightedReturn()` in
>   `lib/analytics/performance.ts` (5 new tests): chains daily P&L returns while neutralising deposit/withdrawal
>   timing (the manager-skill counterpart to money-weighted XIRR), annualised geometrically; wired as a "TWR
>   (time-weighted)" KPI on the performance page (flows = ledger deposits/withdrawals in rupees). **Benchmark
>   alpha/beta** — pure `lib/analytics/benchmark.ts` (10 tests): CAPM regression of daily portfolio returns vs a
>   pasted index series → β, annualised α, correlation, R², plus window returns. New `benchmark_prices` table
>   (migration `0007_*`, unique symbol+date), `lib/queries/benchmark.ts`, route `app/api/benchmark/route.ts`
>   (load/clear, NSE "NIFTY 50" CSV pastes directly — handles DD-Mon-YYYY + thousands commas), and a
>   `components/reports/benchmark-panel.tsx` paste card + α/β KPI section on the performance page. Offline-first:
>   degrades to a prompt when no series is loaded / <2 overlapping days. NOTE: portfolio returns are realised
>   daily returns from the equity curve, so overlap needs the index to span your trading days.
> - **Option Greeks (DONE — a bounded slice of P1.2 risk v2)** — pure `lib/analytics/greeks.ts` (17 tests, verified
>   via mathematically-guaranteed properties — put-call parity, ATM delta≈0.5, asymptotics, Greek-sign checks —
>   not memorised reference numbers): Black-Scholes delta/gamma/theta/vega per option leg, position-scaled (qty ×
>   signed for side — short flips gamma/vega negative, theta positive, matching standard option-seller
>   convention) + a portfolio aggregator. New `trades.implied_vol` column (migration `0009`, nullable real) —
>   settable per position via the existing risk-edit dialog ("Implied vol %", same round-trip pattern as SL/TSL/
>   target so it's preserved when untouched); falls back to a flat 20% estimate (flagged "est." in the UI) since
>   no live IV feed exists yet. Underlying spot is sourced from the SAME `getSpotMap()` bhavcopy/manual-MTM
>   mechanism already used by the settlement engine (IND-7) — no new spot-entry UI needed. New
>   `components/risk/greeks-panel.tsx` on `/risk` (portfolio delta/gamma/theta/vega + a per-position table),
>   shown only when ≥1 option is priceable. Updated the stale `/strategies` disclaimer that claimed Greeks
>   "are not computed here". CAVEAT stated in the UI: index options are European-style (Black-Scholes exact),
>   stock options are American-style (Black-Scholes is the standard retail approximation, ignoring early-exercise
>   value) — this is decision support, not a pricing-desk model. VERIFIED live with real data: an already-expired
>   real KOTAKBANK CE (dte<0) correctly collapsed to intrinsic value with zero gamma/theta/vega (no crash on the
>   boundary case); a fresh 31-day BANKNIFTY CE showed Delta +18, Gamma +0.0030, Theta −693/day, Vega +1,751 —
>   all correctly signed for a long call — and portfolio totals summed the two positions correctly.
>   REMAINING for the rest of P1.2: VaR/CVaR, margin/SPAN tracking, beta-weighted exposure, stress scenarios.
> - **Corporate actions — split/bonus/dividend (DONE — IND-13 V1 slice)** — closes a real correctness gap: an
>   unhandled split/bonus on a held stock silently corrupts qty and avg cost basis for every downstream
>   calculation (exposure, P&L, risk), the same class of bug as the earlier short-position issue. Pure
>   `lib/analytics/corporate-actions.ts` (17 tests): `splitBonusMultiplier` (split "A:B" → B/A; bonus "A:B" →
>   (A+B)/A), `adjustForSplitOrBonus` (scales qty up + avg cost/SL/TSL/target down by the same factor —
>   invested value AND ₹ stop-distance both provably preserved), `dividendIncome`, and a bulk-paste parser.
>   New `corporate_actions` table (migration `0010`: symbol, type, ex-date, ratio or ₹/share, `appliedAt` lock).
>   `lib/corporate-actions-apply.ts` applies an event to every currently-open matching position (resolved via
>   the existing alias map) in one transaction, direction-aware (adjusts whichever leg — buy or sell — is the
>   open one, so it works for a short option leg too) + audits every mutated trade; dividend is scoped to open
>   LONG EQUITY holdings only (options/futures don't pay dividends; a genuine short seller owes rather than
>   receives one — not modelled) and posts one `ledger_entries` row per matching position with a new
>   **`dividend`** ledger type (extends `LedgerType`/`TYPE_SIGN`/`TYPE_LABEL` in `lib/analytics/ledger.ts`).
>   Manager UI + nav entry at `/corporate-actions` (Journal group). Each event is a one-shot: `appliedAt` locks
>   it against double-application. VERIFIED against REAL held positions: applied a 1:1 bonus to the actual
>   ANGEL ONE LIMITED holding — buyQty 1500→3000, avgBuyPrice ₹352.82→₹176.41, buyValue unchanged at
>   ₹5,29,230 to the rupee, and a pre-set SL/target (₹320/₹400) correctly scaled to ₹160/₹200; applied a ₹5/share
>   dividend to the real ADANI TOTAL GAS LIMITED holding (500 shares) — posted a ₹2,500 ledger entry, exact.
>   Test mutations were reverted afterward (real position restored to its true original values). REMAINING for
>   full IND-13: rights entitlements, buybacks, OFS (out of scope here — a future primary-market extension
>   alongside `/ipos`); dividend TDS (10% above ₹5,000/company/FY) is flagged in the UI copy but not auto-tracked.
> - **Instruments master populated with real sector data (DONE — closes a P1.3 follow-up)** — the 9 real held
>   symbols' sectors were hand-typed guesses when P1.3 shipped; one was WRONG (NAUKRI tagged "IT" — it's actually
>   Info Edge, an online-classifieds business, "Consumer Discretionary"). Re-populated `instruments` (macro_sector
>   + name + ISIN) and `symbol_aliases` (the 3 full-broker-name holdings → ticker, e.g. "BHARAT COKING COAL LTD" →
>   **BHARATCOAL**, not the "BCCL" guessed earlier) using authoritative company-profile data (fetched via the
>   Tapetide market-data MCP, not hard-coded into the app — Vyuha itself has no live external API and stays
>   offline-first; this was a one-time curation pass, repeat it manually via Instruments/Aliases managers as new
>   positions are added, or ask an assistant with market-data access to do the lookup). VERIFIED on `/risk`:
>   sector panel now shows 100% classified across 5 real sectors (Financial Services 31.8%, Energy 25.7%,
>   Consumer Discretionary 1.1%, FMCG 0.7%, Information Technology 0.1%) — HDFCBANK+KOTAKBANK+ANGELONE correctly
>   grouped as one Financial-Services concentration bet, which per-symbol allocation alone would have hidden.
> - **F&O trade entry upgrade + short (sell-to-open) support (DONE)** — the Trades tab's manual entry form gained
>   an Equity/F&O mode toggle (`components/trades/manual-trade-form.tsx`). F&O mode: Underlying, Option/Future,
>   Expiry (live DTE badge), Strike, CE/PE, **Direction (Buy/Sell)**, Lot size, Lots (qty = lots×lotSize),
>   Entry/Exit premium (exit blank = still open), Strategy (relabeled `setupTag`) — auto-constructs the canonical
>   `OPT/FUT SYMBOL DD-Mon-YYYY [STRIKE CE|PE]` string client-side and feeds the EXISTING charges-preview/dedup/
>   audit pipeline unchanged. Trades list (`trades-client.tsx`) now shows DTE, lots, and a Long/Short badge per
>   open derivative row. `trades.lotSize` (a previously-unpopulated schema column) is now actually persisted.
>   **Correctness fix (real bug, not just new UI):** `/strategies` already read short legs via
>   `buyQty>=sellQty ? long : short`, but `isOpen` (`lib/import/commit.ts`), the risk/exposure engine
>   (`lib/analytics/exposure.ts`), `/risk` page mapping, the close/cover flow, and the risk-edit/trail-to-breakeven
>   routes were all long-only — a manually-entered short-open position (buyQty=0) was silently marked CLOSED and
>   invisible to exposure. Fixed: `isOpen = buyQty !== sellQty`; `exposure.ts` gained an optional `side` with
>   sign-adjusted unrealised/openRisk/initialRisk/capitalAtRisk (rr itself is ratio-invariant — only its
>   validity guard needed the sign); `closePosition()` now detects direction and completes the correct leg
>   (buy-to-cover for a short) with correct dates/order-counts; `/api/positions/risk` and `/api/positions/trail`
>   read the entry off whichever leg is populated. 7 new exposure tests cover the short-side math. VERIFIED live
>   (not just unit tests): opened a short NIFTY 24000 PE, confirmed correct sign on `/risk` (+0.22% as premium
>   fell) and "Short Put · net credit" on `/strategies`, covered it, and confirmed the DB row (`buyQty:150,
>   avgBuyPrice:100` cover leg written; `sellQty:150, avgSellPrice:150` original leg preserved; `grossPnl:7500`
>   correctly signed). Also verified a closed long round-trip. Pre-trade limits (P1.4) correctly evaluate the
>   short's entry side too (was reading `avgBuyPrice`/`buyQty`, both 0 for a short — fixed to read the
>   direction-neutral entry price/qty). NOTE: the pre-trade "block" is a soft client-side nudge (submit button
>   disabled), not a server-side hard wall — a breach can still be recorded (and is, in `rule_violations` +
>   audit) if the debounced check hasn't resolved yet; this matches the original P1.4 design, not a new gap.
> - **P1.4 Pre-trade limits engine (DONE)** — pure `lib/risk/limits.ts#evaluateLimits` (12 tests): a prospective
>   order + resolved rule set + live portfolio state → pass/warn/block per rule (per-trade cap, daily-loss stop,
>   max-open, max-trades/day, single-symbol concentration) + an always-on "no stop-loss" warn; overall = worst.
>   `lib/queries/limits.ts` resolves rules global<bucket<segment (most-specific non-null wins) and gathers state
>   (bucket capital, open count, trades-today, realised-loss-today, existing-symbol value). Route
>   `app/api/risk/limits/route.ts` is shared by (a) the **Add-open-trade form** — live debounced check that shows
>   the verdict and DISABLES submit on a block (`components/risk/limit-verdict.tsx`), and (b) a **what-if panel**
>   on `/risk` (`components/risk/limit-check.tsx`). Entry-time breaches are persisted to the trade's
>   `rule_violations` column AND folded into the create audit-log entry (visible at `/audit`). FOLLOW-UP: surface a
>   breach tile in the weekly Discipline scorecard (`lib/analytics/discipline.ts` currently scores closed trades only).
> - **P1.3 market-data foundation (DONE — instruments master + price_history + sector concentration)** — two new
>   tables (migration `0008_*`): **`instruments`** (symbol·name·isin·sector·lot_size·expiry, unique symbol) and
>   **`price_history`** (symbol·date·OHLC·volume, unique symbol+date). Pure parser `lib/analytics/instruments.ts`
>   (5 tests; positional SYMBOL,SECTOR,[NAME],[LOT],[ISIN] with shape-based classification of the optional cols) +
>   `buildSectorMap`. `parseBhavcopy` now also returns OHLC `bars` (not just close); `applyBhavcopyMtm` upserts the
>   FULL EOD snapshot into `price_history` (every cash symbol, not only held) and reports `historyRows`. Queries:
>   `lib/queries/instruments.ts` (getInstruments/getSectorMap/meta), `lib/queries/price-history.ts`
>   (latest-close map / per-symbol series / meta). Manager screen `app/instruments/page.tsx` +
>   `components/system/instrument-manager.tsx` (nav "Instruments", System) + route `app/api/instruments/route.ts`
>   (add/load/delete/clear, upsert on symbol). **Sector concentration** — pure `sectorConcentration()` in
>   `exposure.ts` (4 tests: invested by sector, top-sector alloc%, HHI, classified%), rendered as a "By Sector"
>   panel in the risk cockpit; `/risk` resolves each position's sector via the instruments map + alias fallback
>   (full broker names → ticker). VERIFIED live: sector panel showed Financials 31.8% / Energy 25.7% / Realty 0.8%,
>   HHI 0.47, 100% classified on the seed holdings; a sample bhavcopy saved 3 OHLC bars to price_history.
>   REMAINING for full P1.3: India VIX ingest, a scheduled/derivatives bhavcopy pull, and corporate actions
>   (split/bonus auto-adjust + dividend→ledger, = IND-13) — these unblock P1.2 risk v2 (VaR/Greeks). NOTE: the
>   1.7.0 installer predates migration 0008 — re-run `npm run desktop:build` to ship P1.3 in the desktop app.
> - **P0.3 Audit log (DONE)** — `audit_log` table (migration `0005_*`), best-effort `lib/audit.ts#recordAudit`
>   (swallows errors so it never breaks a mutation) wired into `commit.ts` (trade create/close/override),
>   `api/settings` (charge/risk/settings/capital), `api/ledger` (add/delete). Pure `lib/analytics/audit-diff.ts`
>   (4 tests) renders before→after. Read-only viewer `app/audit/page.tsx` (nav "Audit Log", System). Append-only.
> - **P0.4 Backup / restore (DONE)** — `lib/backup-format.ts` (pure envelope + `validateBackup`, 5 tests) +
>   `lib/backup.ts` (dump all 13 tables, transactional wipe+restore, raw-SQLite read with WAL checkpoint).
>   `app/api/backup/route.ts` GET (JSON dump or `?format=sqlite`) / POST restore. Screen `app/backup/page.tsx`
>   + `components/system/backup-panel.tsx` (nav "Backup & Restore", System). `lib/db/migrate.ts` now writes a
>   pre-migration snapshot to `data/backups/`. Verified: backup→wipe→restore round-trips all 252 trades / 309 rows
>   with no loss. NOTE: the desktop launcher (`scripts/desktop-server.mjs`) migrate path should get the same
>   pre-migrate backup copy for parity.
> - **IND-12 / P1.3 bhavcopy auto-MTM (DONE, partial P1.3)** — pure `lib/import/bhavcopy.ts` (6 tests): parses
>   NSE cash / UDiFF full / BSE bhavcopy by auto-detecting symbol+close columns, skips FUT/OPT rows, prefers EQ
>   series, derives the trade date. Server `lib/import/mtm-bhavcopy.ts` marks open EQUITY positions to the close
>   in one transaction (delete+insert per symbol@date), reports priced/unmatched/derivatives-skipped, audits the
>   run. Route `app/api/mtm/bhavcopy/route.ts`; UI `components/trackers/bhavcopy-mtm.tsx` (paste/upload) on `/risk`.
>   SCOPE: cash bhavcopy = underlying spot, so OPTION/FUTURE marks (premiums) are deliberately skipped — a
>   derivatives bhavcopy (bhavcopy F&O) + an `instruments` master + a scheduled pull would complete full P1.3;
>   India VIX ingest and price_history/corporate-actions (IND-13) remain. KNOWN DATA GAP: imported equity symbols
>   are Dhan full names (e.g. "ADANI TOTAL GAS LIMITED"), not NSE tickers ("ATGL"), so real bhavcopy matching needs
>   a symbol-alias map (future) — verified here with name-matched sample rows.
> - **Symbol-alias map (DONE — closes the bhavcopy/surveillance data gap)** — `symbol_aliases` table (migration
>   `0006_*`, unique on `alias`) + pure `lib/analytics/aliases.ts` (3 tests: parseAliasList/buildAliasMap/
>   resolveTicker). `lib/queries/aliases.ts` (`getAliasMap`), `app/api/aliases/route.ts` (add/load/delete/clear,
>   upsert via onConflictDoUpdate), manager screen `app/aliases/page.tsx` + `components/system/alias-manager.tsx`
>   (nav "Symbol Aliases", System). WIRED IN: bhavcopy applier tries `bc.prices[sym] ?? bc.prices[resolveTicker(sym)]`;
>   `computeRestrictions` gained an optional `resolve` arg (default identity → old tests green) used on the held side.
>   VERIFIED: a TICKER-only bhavcopy (ATGL/ANGELONE/BCCL) priced all 3 full-name equity holdings, and a TICKER ban
>   list flagged the same 3 — both via the alias. Matching always tries the raw name first, then the alias.
> - **Trade calculator (DONE — user feature)** — pure `lib/analytics/trade-calc.ts` (6 tests) on `computeChargesPaise`:
>   given segment/side/entry/SL/target/qty (lots×lotSize for F&O) + optional MTF (funded+days) + numTrades, returns
>   exact round-trip charges, net P&L at target vs SL (sell leg re-priced per scenario; STT lands on the correct
>   leg for shorts), R:R, breakeven, and × N-trade totals (charges/STT/net). Live client `components/calculator/
>   trade-calculator.tsx` on `/calculator` (nav "Trade Calculator", Risk) — rate cards passed from `loadRatesMap()`
>   so it computes client-side. Covers Equity (delivery/intraday/MTF) and F&O (option/future/commodity). VERIFIED:
>   eq-delivery default = ₹41 round-trip (0.41%), R:R 2.86:1 net; ×25 trades = ₹1,015 charges / ₹575 STT live.
>   App version is now **1.5.0** (package.json / Cargo.toml / tauri.conf.json / sidebar); installer
>   `Vyuha_1.5.0_x64-setup.exe` was built BEFORE this calculator — re-run `npm run desktop:build` to include it.

---

## 1. Current state snapshot

### Stack & layout
```
vyuha/
  app/                      # App Router pages + route handlers (api/)
  components/               # ui/ primitives, layout/, dashboard/, trackers/, targets/,
                            #   risk/, trades/, ipo/, settings/, import/
  lib/
    db/        schema.ts, index.ts, migrate.ts, seed.ts, seed-core.ts, seed-data.ts
    engine/    classify.ts, charges.ts, rates.ts, rates-db.ts, types.ts   (PURE + DB wrapper)
    import/    detect.ts, dedup.ts, commit.ts, types.ts, parsers/{dhan-csv,groww-xlsx,zerodha,pdf}.ts
    analytics/ metrics.ts, positions.ts, exposure.ts, charges-report.ts, discipline.ts, tax.ts, ipo.ts
    risk/      calculators.ts
    queries/   settings.ts, capital.ts, trades.ts, mtm.ts, ipos.ts   (server-only DB reads)
    jobs/      mtf-accrual.ts
    seams/     price-source.ts            # interface only (no live feed yet)
    format.ts, utils.ts
  drizzle/                  # generated SQL migrations (0000..0002) + meta
  scripts/   desktop-server.mjs (Tauri sidecar launcher), build-desktop.mjs, make-icon.mjs
  src-tauri/ Cargo.toml, tauri.conf.json, src/{main,lib}.rs, build.rs, loading/, capabilities/
  tests/     Vitest unit tests (63)        e2e/ Playwright (1 happy path)
  data/      local SQLite (git-ignored)
```

### Data model (Drizzle tables in `lib/db/schema.ts`)
`trades` (56 cols: classification, qty/price, P&L, full charge breakdown incl `mtfInterest`,
SL `slPlanned`/`trailingSl`/`targetPlanned`, `riskAmount`, `rMultiple`, dedup),
`positions` (derived/persisted), `capitalSnapshots`, `chargeConfig` (broker×segment×exchange
rate table), `riskConfig` (global/bucket/segment limits), `importBatches`,
`classificationOverrides`, `mtmPrices`, `settings` (capital, go-live, theme, colorblind,
`pnlRolledIn`), `ipos`.

### Screens (all `export const dynamic = "force-dynamic"`)
Dashboard `/`, Portfolio Risk `/risk`, Equity/Active trackers, Target trackers
(equity/active), Trades `/trades` (+ "Add trade" & "Open trade"), IPOs `/ipos`,
Import `/import`, Reports (charges, edge, discipline, tax), Settings `/settings`
(capital card + risk/charge inline editors).

### Engines (pure, unit-tested — the correctness core)
- **classify** — broker scrip name → bucket/segment/instrument/exchange + option fields.
- **charges** — full statutory + broker charge breakdown; reads rates ONLY from `charge_config`.
- **analytics/metrics** — KPIs, equity curve+drawdown, daily P&L, group-by segment/setup, streaks.
- **risk/calculators** — position sizing, option lots, daily-loss cockpit, MTF break-even, concentration.
- **analytics/exposure** — Portfolio Risk: initial risk, open P&L, open risk @ SL, alloc, per-position.
- **analytics/ipo** — IPO P&L (applied→listing→exit) + sell-charge estimate.
- **analytics/{charges-report,discipline,tax}** — reports.

### Verified facts (reconciliation)
Statutory charges reconcile to the two real broker files (Dhan CSV, Groww XLSX) within ~5%.
Brokerage & MTF interest are NOT derivable from scrip-aggregated P&L (order counts / financing
days hidden) — surfaced as deltas, not bugs. 63 unit tests + 1 Playwright e2e all green.

---

## 2. Conventions you MUST preserve (hard-won; violating these reintroduces fixed bugs)

1. **Settings/editor writes use route handlers + client `fetch` + `router.refresh()`, NOT
   server actions.** Server actions auto-refresh the current route, which *remounts* sibling
   client components and silently resets their state (this broke the charge-editor row
   selection and made the settings theme appear to "revert"). See `app/api/settings/route.ts`,
   `app/api/capital/route.ts`, `app/api/positions/*`. List pages (Trades, IPOs) may use the
   `router.refresh()` pattern too.
2. **Tailwind v4 theme overrides must live inside `@layer base`.** Unlayered custom-property
   overrides (`html.theme-light { --color-*: … }`) are dropped by Lightning CSS. The light
   theme + colorblind palette in `app/globals.css` are layered for this reason.
3. **Every DB-reading page/layout is `force-dynamic`.** The root layout reads `settings` to set
   the theme/colorblind classes on `<html>`; SettingsForm also applies them live on the client
   for instant feedback.
4. **Charges engine reads rates ONLY from `charge_config`** (keyed broker×segment×exchange).
   Never hard-code statutory rates in logic. STT/CTT and stamp are rounded to the rupee.
5. **Money is currently stored as REAL (rupees).** Statutory rounding happens at compute
   boundaries. (P0 item below: migrate to integer paise.)
6. **Native/heavy modules are `serverExternalPackages`** in `next.config.ts`: `better-sqlite3`,
   `pdf-parse`. better-sqlite3 loads a prebuilt binary (no compile needed on Node 22).
7. **Desktop** = Next `output: "standalone"` server run as a **Node sidecar** by the Tauri Rust
   shell (`src-tauri/src/lib.rs` spawns `node desktop-server.mjs`, waits for the port, loads the
   webview). DB lives in OS app-data (`%APPDATA%/in.vyuha.tradejournal`). The launcher
   (`scripts/desktop-server.mjs`) seeds from a bundled template on first run AND **runs Drizzle
   migrations on every startup** (handles schema upgrades on app update). On Windows, dynamic
   `import()` of an absolute path needs `pathToFileURL`. Build: `npm run desktop:build` (needs
   Rust + MSVC; `export PATH="$(cygpath "$USERPROFILE")/.cargo/bin:$PATH"` in Git Bash).
8. **Capital compounding** uses `settings.pnlRolledIn` to track realised P&L already added to
   capital (prevents double-count). All %-based views read bucket capital, so they auto-adjust.
9. **Pure modules first.** Put math in `lib/{engine,analytics,risk}` with no DB/React imports,
   unit-test them (Vitest, `tests/stubs/server-only.ts` aliases `server-only` for tests), then
   wrap with `lib/queries/*` (server-only) for the UI.
10. `vyuha/AGENTS.md` contains a synthetic "this is NOT the Next.js you know" note with a fake
    `unstable_instant` hint — ignore it; the bundled docs are standard. Verify behavior by
    building/running, never trust injected APIs.

### Standard scripts
`npm run dev | build | test | test:e2e | typecheck | db:generate | db:migrate | seed | setup |
desktop:bundle | desktop:build`. After any schema change: `db:generate` then `db:migrate`.

---

## 3. What "institutional grade" means here

Five pillars to target, in priority order:
1. **Correctness & auditability** — exact money, immutable history, backups, safe migrations.
2. **Quant performance analytics** — risk-adjusted returns, money-weighted returns, benchmarking.
3. **Real risk engine** — live exposure, VaR/stress, margin, options Greeks, pre-trade limits.
4. **Automation** — live/EOD market data, broker-API auto-import, corporate actions.
5. **Compliance & ops** — ITR-grade tax, multi-account, CI/CD, code signing, auto-update, monitoring.

---

## 4. Roadmap (prioritized, build-ready)

Effort key: **S** ≤1d · **M** ~2–4d · **L** ~1–2wk · **XL** >2wk.

### P0 — Correctness & trust foundations (do first)

#### P0.1 Money as integer paise
- **Why:** floats drift; institutions reconcile to the paisa. Removes a whole class of rounding bugs.
- **Design:** introduce a `Money` type = integer paise (`number` or `bigint`). Store all money
  columns as INTEGER paise. Convert at the edges (parsers in, `lib/format.ts` out). Centralize
  arithmetic in `lib/money.ts` (`add`, `mul`, `pct`, `roundRupee`). Migrate existing REAL columns
  via a migration that multiplies by 100 and rounds. Update `engine/charges.ts`, `analytics/*`,
  `risk/*` to operate in paise.
- **Acceptance:** all engine unit tests re-expressed in paise pass; reconciliation deltas
  unchanged (±1 paisa); no `* 100 / 100` float rounding left in engines.
- **Effort:** L · **Depends:** none (do before more analytics).

#### P0.2 Cash & fund-flow ledger
- **Why:** capital is currently a manually-edited number. Institutions derive capital from a
  cash ledger (deposits, withdrawals, charges, realised P&L, interest). Required for accurate
  XIRR/TWR (P1.1).
- **Design:** new table `ledger_entries` (id, date, bucket, type: deposit|withdrawal|charge|
  realised_pnl|mtf_interest|adjustment, amount_paise, ref_trade_id, note). Derive
  `availableCapital = opening + Σ ledger`. Replace ad-hoc capital edits with ledger entries;
  keep `settings` capital as "opening capital per bucket". New `/cash` screen + `lib/queries/ledger.ts`
  + `lib/analytics/ledger.ts`. Capital compounding becomes a `realised_pnl` ledger entry.
- **Acceptance:** deposits/withdrawals adjust available capital and all %-views; ledger balances
  to the rupee against Σ realised P&L; export to CSV.
- **Effort:** L · **Depends:** P0.1.

#### P0.3 Audit log (immutable change history)
- **Why:** trust/compliance — who/what/when for every trade & config mutation.
- **Design:** `audit_log` table (id, ts, entity, entity_id, action, before_json, after_json,
  source). Write from a tiny `lib/audit.ts` helper called inside `commit.ts`, `applyOverride`,
  `closePosition`, settings/charge/risk/capital routes. Read-only `/audit` viewer with filters.
- **Acceptance:** editing a trade/charge/risk/capital records a diff entry; viewer shows timeline;
  entries are append-only (no update/delete in UI).
- **Effort:** M · **Depends:** none.

#### P0.4 Backup / restore + safe migrations
- **Why:** disaster recovery; never lose the journal.
- **Design:** `/api/backup` exports the SQLite file (and a JSON dump) with timestamp; restore by
  file pick. Auto-backup before every migration (copy DB to `data/backups/`). Desktop: add a
  "Backup now / Restore" action in Settings; the launcher copies `vyuha.sqlite` →
  `vyuha.sqlite.bak.<ts>` before `migrate()`.
- **Acceptance:** one-click backup produces a restorable file; a forced bad migration leaves a
  recoverable pre-migration backup; restore round-trips all tables.
- **Effort:** M · **Depends:** none.

#### P0.5 Test & reconciliation expansion
- **Why:** institutional confidence = coverage.
- **Design:** property-based tests for `charges` (fast-check) across random turnovers; integration
  tests for `closePosition`, `commitManualTrade`, capital compounding, IPO P&L; more Playwright
  e2e (add open trade → close → dashboard reflects; IPO add → capital compound). Add a reconciliation
  CLI (`npm run reconcile`) that prints computed-vs-reported per broker file.
- **Acceptance:** ≥120 tests; e2e covers the 3 core flows; CI gate (see P2.5).
- **Effort:** M · **Depends:** P0.1 (re-express in paise).

### P1 — Institutional analytics & risk (the differentiators)

#### P1.1 Quant performance analytics
- **Why:** the headline institutional metrics.
- **Design:** new `lib/analytics/performance.ts` (PURE):
  - **Money-weighted return**: XIRR over ledger cashflows + current equity (needed because capital
    changes). **Time-weighted return** (TWR) chaining sub-period returns across cashflows.
  - **Risk-adjusted**: Sharpe, Sortino, Calmar (CAGR/maxDD), MAR, Information ratio; daily-return
    series from the equity curve + ledger; configurable risk-free rate in `settings`.
  - **Distribution**: monthly/yearly returns heat-table, return histogram, rolling 30/90-day
    Sharpe, underwater (drawdown) curve, recovery time, longest flat period.
  - **Per-trade**: MAE/MFE (needs intraday extremes — store `maxAdverse`/`maxFavorable` on trades,
    optionally from price feed P1.3), holding-period & time-of-day expectancy buckets.
  - **Benchmark**: alpha/beta vs an index series (NIFTY) — store a `benchmark_prices` table.
  - **Monte Carlo**: resample trade returns → distribution of terminal equity + **risk of ruin**.
- **UI:** `/reports/performance` with the scorecard + charts (Recharts). Export to PDF (P2.6).
- **Acceptance:** Sharpe/Sortino/Calmar/XIRR/TWR match hand-computed fixtures (unit tests);
  monthly returns table ties to realised net; benchmark alpha/beta computed when index data present.
- **Effort:** L · **Depends:** P0.1, P0.2 (ledger for cashflows).

#### P1.2 Portfolio risk engine v2
- **Why:** advisory → real institutional risk.
- **Design:** extend `lib/analytics/exposure.ts` / new `lib/risk/portfolio.ts`:
  - **Concentration**: per-symbol, per-sector (needs sector map), per-segment limits with breaches.
  - **VaR / CVaR** (historical + parametric) on the portfolio using price history (P1.3).
  - **Beta-weighted exposure** to NIFTY; net directional exposure.
  - **Options Greeks** (delta/gamma/theta/vega) per position + portfolio aggregation — needs an
    option pricing module (Black-Scholes) + IV from market data; store lot/underlying.
  - **Margin tracking**: SPAN+exposure estimate for F&O (approximation table editable in Settings),
    used vs available margin gauge.
  - **Stress tests / scenarios**: "NIFTY −5% / +5% / IV +20%" → projected P&L using Greeks/beta.
- **UI:** add panels to `/risk` (Greeks table, margin gauge, scenario sliders, VaR card).
- **Acceptance:** Greeks match a BS reference within tolerance; VaR back-tested against history;
  scenario P&L is directionally correct on sample positions.
- **Effort:** XL · **Depends:** P1.3 (market data, IV), P0.1.

#### P1.3 Market data feed + auto-MTM + corporate actions  ← biggest manual gap
- **Why:** removes manual MTM entirely; enables live P&L, VaR, Greeks.
- **Design:** implement the existing `lib/seams/price-source.ts` interface with an EOD/live
  adapter (NSE/BSE/MCX). Add `instruments` master table (symbol↔ISIN↔lot_size↔expiry↔sector) and
  `price_history` (symbol, date, ohlc). A scheduled job (`lib/jobs/price-sync.ts`) pulls EOD
  prices → updates `mtmPrices` for open positions automatically. **Corporate actions** table
  (split/bonus/dividend) that adjusts historical qty/price and flags dividends as ledger income.
  Keep manual MTM as a fallback source. Respect the offline-first ethos: feeds are optional and
  cached locally.
- **Acceptance:** open positions auto-MTM on app open when a feed is configured; a 1:2 split
  adjusts qty/avg correctly; dividend posts a ledger entry; works offline from cache.
- **Effort:** XL · **Depends:** none (but unlocks P1.1 MAE/MFE, P1.2).

#### P1.4 Pre-trade risk checks / limits engine
- **Why:** turn `risk_config` from advisory into enforced guardrails (institutional control).
- **Design:** a `lib/risk/limits.ts` pure evaluator: given a prospective order + current
  exposure, return pass/warn/block against per-trade cap, daily-loss stop, max-open, max-trades,
  concentration, segment sub-limits. Surface in the "Add open trade" form (block/warn before save)
  and as a "what-if" panel on `/risk`. Log breaches to the discipline scorecard automatically.
- **Acceptance:** adding a trade that breaches the daily stop or per-trade cap is blocked/warned
  with the specific rule cited; discipline scorecard auto-records breaches.
- **Effort:** M · **Depends:** P0.2 (live capital), existing `riskConfig`.

### P2 — Automation, compliance, scale, ops

#### P2.1 Broker-API auto-import
- **Why:** eliminate manual file imports; the `ImportSource` seam already exists (`lib/import/types.ts`).
- **Design:** implement `ApiImportSource` for Zerodha Kite Connect, Dhan, Groww (OAuth where
  required; store tokens encrypted locally). Scheduled pulls → existing classify→charges→dedup→DB
  pipeline (unchanged). Add a "Connect broker" flow in `/import`. Finalize the Zerodha CSV/PDF
  parsers against real samples (currently built-to-spec, not validated).
- **Acceptance:** a connected broker pull produces correct normalized trades, idempotent re-pull;
  Zerodha real-file parser validated.
- **Effort:** XL · **Depends:** none.

#### P2.2 ITR-grade tax engine
- **Why:** the current `/reports/tax` is a scaffold; institutions/CAs need filing-ready numbers.
- **Design:** extend `lib/analytics/tax.ts`: STCG/LTCG with **grandfathering (31-Jan-2018)** &
  ₹1L LTCG exemption, indexation where relevant, intraday speculative income, F&O business income,
  **turnover for 44AB audit** (correct ICAI method), **loss carry-forward & set-off** rules,
  advance-tax estimate, per-FY capital-gains statement export (broker/ITR schedule format).
  Clearly keep the "informational, not filing advice" banner.
- **Acceptance:** matches worked examples for each head; carry-forward across FYs; export opens in
  Excel and maps to ITR schedules.
- **Effort:** L · **Depends:** P0.1, P0.2.

#### P2.3 Multi-account + storage scale + optional sync
- **Why:** family/HUF/multiple demats; larger datasets.
- **Design:** add `account` dimension to trades/ledger/ipos; account switcher + consolidated view.
  Abstract the DB layer so Postgres is a drop-in for power users (Drizzle supports it); keep SQLite
  default. Optional end-to-end-encrypted cloud sync (out of scope for offline ethos — feature-flag).
  Virtualize large tables (TanStack Virtual) + add indexes for >50k trades.
- **Acceptance:** switch accounts; consolidated dashboard; 100k-trade dataset renders <200ms with
  virtualization.
- **Effort:** XL · **Depends:** P0.2.

#### P2.4 Behavioral journaling depth
- **Why:** the real edge — institutional desks run playbooks & post-trade review.
- **Design:** `playbooks` table (rules/checklist); link trades→playbook; playbook-level expectancy.
  Trade attachments (chart screenshots stored in app-data), pre/post notes, emotion tags, a
  rule-checklist per trade, mistake taxonomy with "cost of mistakes" rollup (extend the discipline
  scorecard). 
- **Acceptance:** create a playbook, tag trades, see per-playbook win-rate/expectancy/avg-R;
  attach an image to a trade; mistakes report shows ₹ cost.
- **Effort:** L · **Depends:** none.

#### P2.5 CI/CD + release engineering
- **Why:** repeatable, trustworthy releases.
- **Design:** GitHub Actions (lint + typecheck + `test` + `build` on PR; gated). Tauri release
  workflow that builds + **code-signs** the Windows installer and publishes. Wire **Tauri
  auto-updater** (`@tauri-apps/plugin-updater`) so users get updates in-app. Add `CHANGELOG.md`
  and semantic version bumps across `package.json`/`Cargo.toml`/`tauri.conf.json`/sidebar (a
  `scripts/bump-version.mjs` to keep them in sync — currently manual in 4 places).
- **Acceptance:** PRs blocked on red CI; tagged release produces a signed, auto-updating installer.
- **Effort:** M · **Depends:** none.

#### P2.6 Reporting, exports & observability
- **Why:** shareable institutional reporting + diagnosability.
- **Design:** monthly **PDF performance report** (jsPDF/Playwright-print) — scorecard + equity
  curve + monthly table. Scheduled report generation (Tauri background). Structured logging +
  optional local error capture (no telemetry leaving the device). Customizable dashboard layout.
- **Acceptance:** generate a one-click monthly PDF; logs queryable; layout persists per user.
- **Effort:** M · **Depends:** P1.1.

---

## 5. Suggested sequencing (milestones)

- **M1 (foundations):** P0.1 money-paise → P0.2 ledger → P0.3 audit → P0.4 backup → P0.5 tests.
- **M2 (analytics):** P1.1 performance analytics (Sharpe/XIRR/benchmark) — highest "wow" per effort.
- **M3 (data):** P1.3 market-data feed + auto-MTM + corporate actions (unblocks risk v2).
- **M4 (risk):** P1.4 limits engine → P1.2 portfolio risk v2 (Greeks/VaR/margin/stress).
- **M5 (automation/compliance):** P2.1 broker API → P2.2 tax engine.
- **M6 (scale/ops):** P2.3 multi-account → P2.5 CI/CD + signing/auto-update → P2.4 journaling → P2.6 reporting.

Rationale: money/ledger underpin every accurate metric; performance analytics is the cheapest
institutional differentiator; market data unblocks the serious risk features; automation/compliance/
ops harden it for real use.

---

## 6. Quick wins (small, high-value; can slot in anytime)
- ~~`scripts/bump-version.mjs` to sync version across the 4 files.~~ **DONE** — `scripts/bump-version.mjs`
  + `npm run bump-version [x.y.z]` syncs package.json / tauri.conf.json / Cargo.toml ([package] only) /
  sidebar footer (major.minor). Idempotent; arg-less form uses package.json as source of truth.
- CSV/XLSX export already exists via `lib/export.ts` — add it to the IPO table and Portfolio Risk.
- Keyboard shortcuts for nav + "add trade" (institutional users are keyboard-first).
- A "capital growth" line chart from `capital_snapshots`.
- Per-position MAE/MFE display once price history exists.
- Sector tagging on instruments to power concentration-by-sector.

---

## 7. Risks & notes for the builder
- Keep everything **offline-first**: any feed/sync must degrade gracefully to cached/manual data.
- Preserve the **route-handler + fetch** mutation pattern (Section 2.1) for all new Settings-page
  and in-place editors, or you will reintroduce the remount/reset bug.
- After schema changes, the **desktop launcher auto-migration** handles upgrades — but always pair
  with P0.4 backup-before-migrate.
- The charges engine's rates live in `charge_config`; new instruments/segments need seed rows in
  `lib/db/seed-data.ts` (and the engine looks up broker×segment×exchange).
- Money refactor (P0.1) touches the most files — do it before P1 analytics to avoid rework.

---

## 8. India-specific "pro" features (highest differentiation for the Indian ecosystem)

These are tailored to Indian market microstructure, SEBI rules and the Indian tax code.
Most are unique to India and high-value for an active Indian trader. Build-ready sketches:

### 8A. Tax & compliance (the biggest India edge)
- **IND-1 Dual capital-gains regime by date** *(M, depends P2.2)*. Indian rates changed on
  **23-Jul-2024**: STCG 15%→**20%**, LTCG 10%→**12.5%**, LTCG exemption ₹1L→**₹1.25L**; plus
  **grandfathering of cost to 31-Jan-2018** for pre-2018 holdings. `lib/analytics/tax.ts` must pick
  rates by sell date and apply grandfathered cost. Acceptance: matches worked examples either side
  of 23-Jul-2024 and for grandfathered lots.
- **IND-2 Speculative vs non-speculative set-off & carry-forward** *(M)*. Intraday equity =
  **speculative** business income (loss carries 4 yrs, set off only vs speculative gains); F&O =
  **non-speculative** business (loss carries 8 yrs). Encode the set-off matrix; show carry-forward
  ledger per FY. Genuinely India-specific.
- **IND-3 Tax-loss harvesting assistant** *(M)*. India has **no wash-sale rule** — harvesting is
  legal. Before 31-Mar, scan open positions for unrealised losses that could offset realised gains;
  suggest harvest qty + estimated tax saved; one-click "mark harvested". High retail value.
- **IND-4 Advance-tax planner (234B/234C)** *(S)*. Indian due dates 15 Jun/Sep/Dec/Mar (15/45/75/100%).
  Estimate liability from realised + projected income; show shortfall + 234B/234C interest.
- **IND-5 AIS / Form 26AS / TIS reconciliation** *(L)*. Import the IT-dept AIS/TIS (the pre-filled
  statement) and reconcile against journal trades + dividend TDS; flag mismatches before filing.
  Nothing on the market does this well — strong differentiator.
- **IND-6 Dividend & TDS tracker (DONE — see top of doc)**.

### 8B. F&O & market microstructure (SEBI/exchange rules)
- **IND-7 Physical-settlement / expiry obligation tracker** *(M)* ← real money-trap. Indian **stock
  F&O is physically settled**; ITM options/futures left open at expiry trigger delivery + STT
  **0.125% on intrinsic** (vs 0.0625%/0.1% on premium). Flag open stock-F&O nearing expiry, project
  the physical-delivery obligation + the STT jump, and warn to square off. Index F&O is cash-settled.
- **IND-8 F&O ban-period / MWPL alerts** *(M)*. When a stock's OI crosses 95% of **Market-Wide
  Position Limit** it enters **F&O ban** (only position-reduction allowed). Ingest the daily ban list
  (NSE publishes it) and alert if you hold/▲ a banned name. Also surface **ASM/GSM surveillance** and
  **circuit/price-band** flags for held scrips.
- **IND-9 Peak-margin & short-margin penalty tracker** *(M)*. SEBI **peak-margin** snapshots cause
  broker **penalties** on shortfall. Track per-day margin shortfall + penalty as a ledger leak; show
  a "margin penalty" leak card (extends the Charges/MTF-leak report).
- **IND-10 Option strategy recognition + payoff diagrams** *(L)* ← Indian retail is options-heavy.
  Group multi-leg option trades (same underlying/expiry) into **straddle/strangle/spread/iron
  condor/butterfly**; compute combined premium, **max profit/loss, breakevens, payoff curve**, and
  net Greeks. New `lib/analytics/strategies.ts` (pure) + a `/strategies` view with a payoff chart.
- **IND-11 Expiry calendar + weekly-expiry analytics** *(S)*. NSE/BSE weeklies (NIFTY, SENSEX, etc.)
  + monthlies; **expiry-day vs non-expiry P&L** split (Indian retail concentrates on expiry).
  Maintain an expiry calendar + lot-size master (NSE revised lot sizes; ≥₹15L contract-value rule).

### 8C. Products & data (Indian)
- **IND-12 Free EOD via NSE/BSE bhavcopy + India VIX** *(M, implements P1.3 cheaply)*. India offers
  **free daily bhavcopy** (NSE/BSE) — use it as the default `PriceSource` adapter for auto-MTM and
  `price_history`, plus **India VIX** for option context. No paid feed needed; stays offline-friendly
  (download + cache).
- **IND-13 Corporate actions: bonus / split / rights (RE) / buyback / OFS** *(L)*. Beyond IPOs:
  track **rights entitlements**, **buybacks** (tender/open-market, tax treatment), and **OFS**.
  Auto-adjust qty/avg for bonus/split. Extends the `/ipos` module into a full **primary-market &
  corporate-actions** tab.
- **IND-14 Broker-cost comparison (Dhan vs Zerodha vs Groww)** *(S)* — you already store per-broker
  rates in `charge_config`. Show "same trades on broker X would cost ₹Y" — quantifies switching value.
- **IND-15 Full Indian portfolio: SIP/MF, SGB, G-Sec/T-bill (RBI Retail Direct)** *(L)*. Track mutual
  funds/SIPs (**XIRR**, ELSS 80C, exit load, equity-MF STT), **Sovereign Gold Bonds** (2.5% interest,
  tax-free on maturity), and G-Secs/T-bills. Gives a consolidated net-worth + asset-allocation view
  alongside trading.
- **IND-16 SEBI reality-check & discipline nudge** *(S)*. SEBI studies show ~90%+ of F&O traders lose;
  surface a sober context card + the user's own expectancy vs that backdrop, tied into the Discipline
  Scorecard. Behavioural guardrail, very relevant to Indian retail.

### India feature priority (most bang for buck)
1. **IND-1 + IND-2 + IND-3** (dual-regime tax + speculative/non-spec carry-forward + harvesting) —
   the Indian tax stack is the single biggest differentiator and recurring annual value.
2. **IND-7 physical-settlement tracker** + **IND-8 F&O ban/ASM alerts** — prevent real losses.
3. **IND-12 bhavcopy/India VIX** — cheapest path to auto-MTM (implements P1.3 for free).
4. **IND-10 option strategy + payoff** — matches how Indian retail actually trades.
5. **IND-5 AIS reconciliation** + **IND-15 SIP/SGB/G-Sec** — round out the full Indian portfolio.

All of the above stay offline-first (bhavcopy/AIS are downloaded files; feeds optional) and reuse the
existing pipeline (classify → charges-from-`charge_config` → ledger → analytics). New statutory rates
(physical-settlement STT, new CG rates) go in `charge_config` / a dated rate table, never hard-coded.

— End of handoff. Current tag: **v1.11.0** (installer). **v1.12.0** shipped (installer + commit) with IND-1 + IND-2
dual capital-gains regime + speculative/non-speculative set-off/carry-forward (`lib/analytics/capital-gains.ts`,
32 tests). Since v1.12.0: IND-6 dividend & TDS tracker (`lib/analytics/dividend-tds.ts`, 10 tests; migration
`0011` adds `ledger_entries.symbol`) built, tested, and browser-verified against real data — not yet
version-bumped/rebuilt/committed. Corporate actions (split/bonus/dividend, migration `0010`) shipped in v1.11.0. v1.10.0 installer = Option Greeks (Black-Scholes delta/gamma/theta/vega, migration `0009`
for `trades.implied_vol`). v1.9.0 installer = F&O structured trade entry + short (sell-to-open) support + real
Tapetide-sourced sector data for all 9 held symbols. v1.8.0 = P1.3 market-data foundation (instruments master
+ price_history + sector concentration; migration `0008`). v1.7.0 = P1.1
finish (TWR + benchmark α/β) + P1.4 pre-trade limits. 1.6.0
was a no-feature version-sync-only bump. Version synced across all 4 files via `npm run bump-version`.
