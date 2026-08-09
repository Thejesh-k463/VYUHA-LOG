<div align="center">

# व Vyuha — The Trade Journal That Tells You the Truth

**A fully local, offline-first trade journal + analytics cockpit for Indian retail traders.**
Exact charges. Honest analytics. Zero cloud. Your data never leaves your machine.

[![CI](https://github.com/Thejesh-k463/VYUHA-LOG/actions/workflows/ci.yml/badge.svg)](https://github.com/Thejesh-k463/VYUHA-LOG/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/Thejesh-k463/VYUHA-LOG?label=version&color=2dd4bf)](https://github.com/Thejesh-k463/VYUHA-LOG/tags)
[![Tests](https://img.shields.io/badge/tests-1242%20passing-2ea44f)](tests)
[![E2E](https://img.shields.io/badge/e2e-20%20flows-2ea44f)](e2e)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#-get-it)
[![Telemetry](https://img.shields.io/badge/telemetry-none-black)](#-local-first-by-design)
[![Cloud](https://img.shields.io/badge/cloud-none-black)](#-local-first-by-design)
[![Built for](https://img.shields.io/badge/built%20for-Indian%20retail%20traders-ff9933)](#why-vyuha)

### ₹ Exact charges · 🧠 Honest analytics · 🔒 Zero cloud · 🇮🇳 Built for NSE/BSE/MCX

<img src="docs/screenshots/dashboard.png" alt="Vyuha dashboard — equity curve, daily P&L calendar, win rate, profit factor" width="900" />

*Dhan · Zerodha · Groww · Angel One · Upstox · Kotak Neo · Paytm Money · Sahi — Index/Stock Options, Intraday, Delivery, Equity MTF, MCX Commodities*

</div>

---

## Why Vyuha?

Most journals tell you your P&L. **Vyuha tells you why.**

> **v2.99.20 — the app fits the trader, not the other way round.** Tell Settings you trade
> **only equity or only F&O** and the other book's screens leave the sidebar and the ⌘K palette —
> without deleting anything, without hiding a route you can still link to, and without a single
> total quietly dropping rows. MTF now **shows the rate it is using**: the capital-vs-funded split
> appears only on MTF trades and leads with *your* stock's percentage from *your* broker's list,
> saying so plainly when the stock isn't on it. Chart screenshots became findable — a paperclip
> and a count on every trade that has one. The P&L calendar **opens**: click a day for that day's
> trades, with green/red runs counted in days you actually traded. And the sidebar reorders by
> **drag** now, with a glow and a drop line, instead of clicking arrows.
>
> *v2.99.9 — every broker's MTF list, compared.* 10,501 per-stock own-margin percentages across
> all seven brokers, each from the broker's own feed — and a Broker Costs section that prices
> **your** delivery/MTF symbols on every list, cheapest broker highlighted (Sahi listed honestly:
> no MTF delivery). Approved-but-unfunded scrips are declared, never disguised as funded.
>
> *v2.99.8 — MTF that knows your broker's list.* 3,083 per-stock own-margin percentages from
> the brokers' own published MTF lists (Zerodha and Paytm Money complete; partial/rule-based
> coverage declared honestly for the rest). The Trades form auto-splits your capital vs
> broker-funded the moment you enter price and quantity — both sides editable, each deriving the
> other — and Portfolio Risk flags open MTF positions whose current requirement has drifted since
> entry. Plus: chart screenshots attach at trade entry, and selected trades export as a PDF report.
>
> *v2.99.7 — sectors in one click, and edge by theme.* A bundled snapshot of NSE's 54 index
> constituent lists (~1,150 symbols with official industry, ISIN and thematic memberships) fills
> your instruments master in one click — sector concentration works with zero typing, and your
> hand-typed tags are never overwritten. The Edge report gains a **theme lens**: expectancy per
> thematic index (Defence, Railways PSU, EV, Digital…), honestly labelled — themes overlap, thin
> samples are flagged, and the untagged remainder is reported.
>
> *v2.99.6 — files in, typing out.* Instruments fill from NSE's own files (bhavcopy /
> EQUITY_L / F&O market lots — with in-app guidance on where each lives), corporate actions
> import from the CF-CA CSV with every reading shown for verification before applying, symbol
> aliases take a CSV, and AIS reconciliation parses the income-tax portal's JSON download
> directly. The audit log now groups by what happened — your edits are no longer buried under
> auto-MTM maintenance rows. And the first-run database is finally anonymous: zero capital,
> go-live stamped on first launch.
>
> *v2.99.5 — Vyuha gets its mark, and tables you can actually read.* The Devanagari **व**
> hanging from an edge-to-edge shirorekha — the letter's headline stroke doubling as a price
> level — now ships as the installer icon, favicon, sidebar and share-card mark, generated from
> one committed glyph outline (Noto Sans Devanagari, SIL OFL) so no surface depends on the
> user's fonts. Every table gained visible row rules (the old separators measured 1.08:1 —
> below what the eye registers), a proper uppercase header band, a pinned Instrument column,
> truncated option names, and a **Compact/Comfortable display density** setting. Light-mode
> primary now passes WCAG AA.
>
> *v2.99 — Vyuha runs on a Mac, and the journal cleans up after itself.* Native builds for
> Windows, macOS Apple silicon and macOS Intel. A **Help Desk** describing every screen — including
> what each deliberately won't do. **Honest deletion**: select rows, delete an imported file (with
> the its-trades question asked, never assumed), batch scopes by date/broker/segment — every delete
> previews the exact set first and audits the full before-snapshot. **Cross-source duplicate
> detection** stops a P&L export silently double-recording trades a transaction report already
> supplied. **My Default Settings** restores your baseline in one click — preferences and rate
> tables, never licence or accounting state. Seller depth: expectancy by DTE band, hedged-vs-unhedged
> as an honest gap, roll chains against the first leg, IV rank, premium per day of risk. And the
> licence clock is now a ratchet — winding the system clock back no longer renews a trial.
>
> *v2.98 proved the safety net (atomic restore, stronger backup crypto, aggregate-view write
> guards) and added the ITR schedule-format export with the S.48 STT rule applied per head.*

- 🇮🇳 **To-the-rupee Indian cost engine.** STT, exchange txn, SEBI, stamp, IPFT, GST, DP, pledge — computed per **broker × segment × exchange** from an editable rate table, reconciled against real broker files. Money is stored as **integer paise** (no float drift), with statutory rounding.
- 💸 **MTF done right — the only journal that gets it.** Interest accrues on the *broker-funded portion only* (own-margin % is broker-specific: Dhan/Groww ≈25%, Zerodha ≈20%), with the **correct T+1 day-count** verified against Dhan's own docs. See ROI on your own capital, leverage, breakeven price, and a ⚠ flag when interest has eaten your entire paper gain.
- 📚 **Playbooks that enforce discipline, not just describe it.** 25 preset setups from trading ecosystems worldwide (ORB → Wyckoff → Minervini VCP → India's expiry-day theta), fully editable, plus your own. Tag a trade and its rules become a **followed/broken checklist** — the Discipline page then shows *which broken rule costs you the most ₹*.
- 🇮🇳 **Knows today's SEBI regime.** A compliance radar reads your open book against the post-2024 F&O rules — the **+2% expiry-day ELM** on short options expiring today, the **loss of calendar-spread margin benefit** on expiry, which indices still have weeklies, and how close your index exposure sits to the ₹1,500 cr limit that's now snapshotted *intraday*. No other journal tracks this.
- 🔍 **Honest analytics.** Expectancy cards warn you when the sample is too small to trust. The stop-tuning report says "descriptive, not prescriptive." Mistake economics report the expectancy *gap*, never fake counterfactuals. A SEBI reality-check card compares your F&O book to the published loss statistics.
- 🔒 **You stay in control — always.** Auto-MTM is opt-in. Update dialogs ask, never install. Breach alerts say *"check a live quote and review your plan"* — the app never places, closes, or changes anything on its own.
- 🪜 **Positions built the way you actually trade them.** Scale in across tranches with a stop on each, scale out in parts, and see per-leg R — with exits priced at the blended average, quantity retired FIFO so the surviving tranche keeps its own stop, and R frozen at your first entry so it stays comparable. Broker tradebooks rebuild the ladder automatically.
- 🔬 **Every KPI explains itself.** Click any headline number — Net P&L, Open Risk @ SL, MTF funded, Unrealised P&L — and it opens a breakdown of what it's actually made of: gross minus every charge with your best and worst day, open risk sitting next to initial risk with the unstopped-position count, effective leverage and how much of your paper gain financing has already eaten. Sixteen cards, keyboard-accessible.
- 🖥 **Looks like a terminal, feels alive.** JetBrains Mono on every number, sparkline KPIs with week-over-week deltas, animated equity curve with crosshair, a magnitude-scaled P&L calendar, live IST market clock, `Ctrl+K` command palette — dark or light, with a colorblind-safe mode.

---

## 📊 At a glance

<div align="center">

| | | |
|:--:|:--:|:--:|
| **10,501** | **7** | **0.69%** |
| per-stock MTF margins bundled | brokers' MTF lists compared<br/>(Sahi has none — it offers no MTF delivery) | charge-engine error vs a real broker report |
| **1,242** | **40** | **0** |
| tests, 20 end-to-end flows | screens, all offline | bytes of *your data* ever uploaded |

</div>

> **Read that third number again.** On a real 92-row broker report, Vyuha's computed statutory
> charges land within **0.69%** of the broker's own — STT, exchange, SEBI, stamp, IPFT, GST, DP and
> pledge, per broker × segment × exchange, in integer paise with statutory rounding. Brokerage is
> excluded from that claim because it isn't derivable from the file. We say so rather than pad the
> number.

---

## 💸 What's free, what's paid

**Your record is free. The intelligence about it is paid.**

| ♾ Free forever | 🔑 Pro |
|---|---|
| Recording **closed** trades — add, edit, delete, tag | **Live open-position tracking** — SL/TSL/target, running risk |
| All five broker importers + duplicate detection | Portfolio Risk cockpit — VaR, Greeks, margin, breach alerts |
| Dashboard, P&L calendar with day drill-down & streaks | Arjun's Eye, Edge/Setups, Discipline, Scaling & Replay |
| Staged positions, playbooks, sessions, calculator | Options Seller Journal, Expiry Analytics, Return on Margin |
| Chart screenshots, symbol aliases, corporate actions | Tax Summary, ITR Pack, Advance Tax, Harvest, AIS Reconcile |
| Backup & restore, full CSV/JSON export, audit log | Broker-cost + cross-broker MTF comparison, Charges & MTF Leak |
| Workspace mode, sidebar layout, themes, multi-account | PDF reports — monthly, and any selection of trades |

Every fresh install starts a **7-day full-Pro trial** — offline, no signup, no card. When it ends,
**every trade you have already recorded stays readable, editable and exportable without a key,
forever.** Your own record of your trading is never held hostage.

---

## ✨ Feature tour

### 📒 Journal every leg, effortlessly
- **Import from ANY broker.** Five are auto-detected — Dhan CSV, Groww XLSX, Zerodha CSV/XLSX, **Angel One** and **Upstox** (tradebook *or* aggregated P&L export), plus PDF. For every other broker — **Kotak Neo, Paytm Money, Sahi**, or one that launches next year — drop the CSV/XLSX and Vyuha asks you to **match the columns once**, then remembers the mapping for that broker. Nothing is ever guessed: a file whose layout is unknown produces a question, never a trade with quantity in the price field. Mapped tradebooks go through the same FIFO pairing, de-duplication and charge engine as native ones, with the **charge reconciliation panel** (computed vs broker-reported) before commit. Zerodha **Kite** and **Dhan** API pulls too.
- **Add / open / close / edit any trade, any time** — with a live charge preview from the same engine that books it, so what you see is exactly what gets saved.
- **Risk auto-computes from your SL** (|entry − SL| × qty), with manual override. **Current R** (live) and **Target R:R** (planned) side by side on every view.
- Chart **screenshot attachments**, emotion tags, mistake tags, notes — the full behavioral journal.

### 🪜 Staged positions — build in tranches, scale out in parts
<img src="docs/screenshots/staged-position.png" alt="Staged position — entry ladder with a stop per tranche, partial exits and per-leg R" width="900" />

- **Add entries as the trade proves itself**, each tranche with its own stop and target — or set one stop across every open tranche in a click. **Book partial exits** on any trade (25/50/100% or any quantity) and let the rest run.
- **Three rules, chosen deliberately:** exits price against the **blended average** (so your journal never disagrees with your broker's average price); quantity is consumed **FIFO** (money is fungible, stops are not — the surviving tranche keeps *its* stop); and **R is frozen at your first entry**, so a 3R stays a 3R whether or not you pyramided.
- **Charges are booked per fill** — brokerage per order, STT per execution, DP once per exit *day*, MTF interest per tranche from its own entry date. Scaling into options really does cost ₹20 an order, and Vyuha says so instead of hiding it in an average.
- **Imports rebuild the ladder for you.** Zerodha, Angel One and Upstox tradebooks list every execution — those fills are preserved, so a scaled position arrives with its real shape. An ordinary buy-then-sell stays an ordinary trade.
- **Two warnings worth having:** *averaging down* (adding below your average — inverted correctly for shorts), and *open risk now exceeds your initial risk* — which fires on any add you didn't fund by trailing the earlier stops up.

### 👁 Arjun's Eye — the trader's cockpit
<img src="docs/screenshots/arjuns-eye.png" alt="Arjun's Eye — session edge, segment scorecard, holding behaviour and tilt" width="900" />

- Every other report answers *how did my money do*. This one answers **what kind of trader am I, and where does my edge actually come from**.
- **When you actually make money** — expectancy by Indian session (opening drive · morning trend · midday chop · afternoon push · closing hour) and by weekday.
- **Do you cut winners and hold losers?** The single most common structural leak in retail trading, invisible in a P&L total.
- **Does a loss change how you trade?** Expectancy after a win vs after a loss, plus same-day re-entries — revenge trading, measured.
- **Is your conviction rewarded?** Expectancy by position-size quartile. If your biggest positions are not your best, that is a *sizing* question, not a selection one.
- **Three honesty rules enforced in code:** no finding below 15 trades in a group; no invented sessions for trades whose time is unknown; and every finding phrased as an observation, never an instruction — there is a test asserting no finding says "you should".

### 🔎 See exactly the trades you mean

- One dropdown on **Trades** covers both questions: **status** (Open · Closed · Staged) and **outcome** (In gain — open · In loss — open · Profit — closed · Loss — closed).
- **Every option carries its own live count**, computed after your other filters — so you can see a view is empty before you choose it, and the numbers always add up: open + closed = all.
- **An open position with no mark price appears in neither "in gain" nor "in loss"** — because it has no unrealised result. Vyuha stores 0 for an unmarked holding, and reading that 0 as breakeven would file it under a result it never had. The count of unmarked positions is stated on screen instead of leaving a silent shortfall.

### 🧾 Reads the product type out of the charges themselves

- Dhan's **Global Transaction Report** has no product column — but India levies statutory charges at *different rates per product*, so the rate is a fingerprint. Stamp duty **0.015%** on a delivery buy vs **0.003%** intraday, corroborated independently by STT (**0.1%** both legs vs **0.025%** sell-only). Two witnesses agreeing on **89 of 92 rows** of a real report.
- **A bill that mixes both is split algebraically.** Stamp duty is linear in value, so "bought 3,600, squared 1,800 same day" has exactly one solution. Labelled *derived* — it is arithmetic on a total, not a stated fact.
- **MTF is still never claimed**, and that was verified rather than assumed: `Oth. Charges` totalled **₹0.03** across 92 rows and GST was 18% of (brokerage + txn + SEBI) to within **₹0.01**. No unexplained rupee, nowhere for financing to hide. So Vyuha asks about the *delivery* rows only — intraday and F&O can never be MTF.
- **Legs pair FIFO across dates into real positions**, matching how the Income Tax Act treats equity delivery, so holding periods agree with the ones that decide STCG vs LTCG. A conservation check asserts not one share or rupee is created or lost.
- **The broker's own charges are stored as truth.** Vyuha cannot be more accurate about a charge than the charge itself; its computed figures stay alongside as a cross-check.

### 🏦 MTF, answered by the broker rather than guessed

- Every Dhan **file** is silent about margin funding — MTF and delivery carry identical STT and stamp duty, and financing interest is booked to the ledger, not the contract note. So Vyuha stopped guessing and went to the two places that actually know.
- **Dhan API** (`Import → Connect broker`): `productType` returns **MTF** outright. Stated, not inferred — those rows need no confirmation at all.
- **Dhan ledger** (`Cash & Ledger`): MTF interest is calculated daily and posted **weekly**, so the ledger holds the real number. Vyuha imports it and shows **actual vs its own estimate side by side** — a comparison, never a correction, because splitting a weekly account-level posting across positions would invent an allocation the broker never made.
- The ledger parser finds columns by **header keyword, not position**; matches MTF **first** so a generic "charges" rule cannot swallow it; treats opening-balance rows as **assertions, not entries**; and **lists anything it cannot classify** rather than filing a guess.

### 🎟 IPO allotments become real holdings

- IPO shares are **credited, never bought**, so the holding arrives with no cost basis *and* no mark price — unable to be valued, unable to be scored. Vyuha surfaces those holdings instead of letting them sit dead.
- **"This came from an IPO"** creates a linked record seeded from the holding. The **issue price is left blank on purpose** — it is the one fact only you know, and guessing it would defeat the point.
- Fill it in and the IPO record becomes the **source of truth**: issue price (minus category discount) supplies the basis, listing price supplies the mark, an exit price closes the position and books the P&L, and the allotment date starts the tax holding period. One place, so the numbers can never drift.
- With no listing price it stays **honestly unmarked** — basis supplied so it rejoins the statistics, but no mark invented.

### 🎟 Sold something you never bought? It says so instead of scoring a win

- Sell an IPO allotment and the tradebook holds the sale and nothing else — shares are credited on allotment and never appear as a buy. With a buy value of zero the arithmetic reads it as a **100% winner, every time**.
- Those trades are **counted in cash but quarantined from every edge statistic** — win rate, expectancy, profit factor, ROM — until you set a cost.
- **Vyuha recovers that cost from the file's own footer.** The rows omit the purchase, but the broker's gross P&L includes it, so subtracting everything matchable leaves what it must have cost. On a real report: −₹8,268.27 matched against a −₹8,489.60 footer left −₹221.33 for one holding — 37 shares sold for ₹21,904, implying **₹597.98 a share**. Pre-filled for confirmation, never applied silently.
- IPO P&L is reported **apart from trading edge** — a listing-day pop is not a repeatable skill.

### 📥 Import that tells you what kind of file you brought

- Two clearly-labelled kinds, because they are **not equivalent**. A **tradebook** states the product and the time; a **P&L statement** states neither.
- So the P&L path **asks once, before commit** — grouped by symbol, with a guess pre-selected. Changing a product **re-prices immediately**, because charges, MTF interest and ROM all derive from it.
- Same-day round trips are *inferred* as intraday. **MTF is never inferred** — it is indistinguishable from delivery in a P&L file — so the default is delivery, the safest wrong answer, and guessed rows are labelled *assumed*.

### 📐 Return on Margin — what your capital actually earned
<img src="docs/screenshots/rom-report.png" alt="Return on Margin — capital blocked per segment, ROM per day, capital-efficient trades" width="900" />

- Every Indian F&O journal reports P&L against **turnover** or **notional**. Both are close to meaningless: a long option and a short strangle can carry identical notional while tying up wildly different capital. **ROM measures against what was actually blocked.**
- The denominator is **instrument-aware**, because the market is — **long options** cost the premium and block no SPAN margin; **short options** block against the *underlying* (a ₹10,000 credit can tie up ₹1.5 lakh); **futures/intraday** block a percentage of contract value; **MTF** blocks only your own capital; **delivery** blocks the lot.
- **ROM/day is weighted by capital-days**, so ₹1L held ten days counts as ten times the commitment of ₹1L held one — and a scalper and a swing trader finally become comparable.
- Grouped by segment and playbook, so you can see that your F&O book returns *x*%/day on margin while delivery returns *y*% on capital. **No other Indian journal does this.**
- Annualised figures are **clamped and marked** — a book losing 10%/day extrapolates to −3,887%, which is arithmetically true and impossible. Honest beats impressive.

### 🔬 Numbers that explain themselves
<img src="docs/screenshots/kpi-drilldown.png" alt="Net P&L KPI drill-down — gross, charges, best and worst day" width="900" />

- **Every headline KPI is clickable** — 16 cards across Dashboard, Portfolio Risk, Equity Tracker and Trade F&O Tracker. Hover lifts and glows; click (or `Enter`) opens the breakdown.
- **And the breakdown goes somewhere.** Best/worst-day rows deep-link to `/trades` filtered to that date, and the rows shown **add up exactly** to the figure you clicked — an e2e test asserts the reconciliation, because a link showing roughly-related trades is worse than no link.
- Not a tooltip — a **derivation**: Net P&L splits into gross minus every charge with your best and worst day *and their dates*; Open Risk @ SL sits next to initial risk with the unstopped-position count, so you can see trailing a stop move the number; MTF funded shows effective leverage and how much of your paper gain interest has already eaten.

### 📚 Playbooks & discipline
<img src="docs/screenshots/playbooks.png" alt="Playbooks with rule checklists and expectancy" width="900" />

- **Browsable preset library — 25 playbooks across 7 global ecosystems** — Intraday & Momentum, Breakout & Trend (Turtle, Darvas, 52-week-high), Positional/Growth (CANSLIM, Minervini SEPA, Wyckoff, Weinstein), Mean Reversion (Connors RSI-2), Price Action/SMC (ICT liquidity sweeps), Options & Events (iron condor, **India weekly expiry theta**), Swing & Overnight (**BTST**). Filter by ecosystem, read every rule on the card, **one-click Add**, then tune every metric to your own risk. Nothing is auto-seeded — 25 untraded setups would bury your real playbooks and turn per-playbook expectancy into noise, so a playbook only becomes yours when you click.
- **Rule-checklist enforcement**: journaling a trade shows its playbook's rules — tick what you actually followed. Broken rules land on the Discipline page with their real cost.
- **Per-playbook expectancy cards**: win rate, net, expectancy, profit factor, avg R — with a small-sample caution until 20 closed trades.
- **Discipline scorecard**: weekly adherence scores, cost-of-mistakes rollup, trading-by-emotion, entry-time limit breaches, and the per-rule cost table.

### 🛡 Portfolio risk cockpit
- Live exposure: initial risk, open P&L, **open risk @ SL**, allocation, sector concentration (HHI), one-click trail-to-breakeven.
- **VaR / CVaR / parametric VaR**, beta-weighted exposure, NIFTY stress scenarios (±3%, ±5%, crash+IV spike).
- **Option Greeks** (Black-Scholes) with a three-tier IV fallback ending at the real **India VIX**.
- **Margin estimate** (SPAN approximation) per broker × segment, fully editable rate table.
- **Physical-settlement radar**: ITM stock options and futures near expiry get delivery-obligation and extra-STT warnings.
- **Pre-trade limits check** (per-trade cap, daily stop, max-open, concentration) — advisory with override, and overrides are *recorded* so you see what ignoring the guardrails cost.
- **SL/TSL/target breach alerts** on Dashboard & Risk with opt-in desktop notifications — every alert reminds you the marks are EOD/manual and to verify live.
- **SEBI compliance radar** — date- and position-aware reminders for expiry-day margin rules, the weekly-expiry regime and index position limits. Informational only; your broker's RMS stays the source of truth.

### 🧮 Know your costs before you trade
<img src="docs/screenshots/calculator.png" alt="Trade calculator — exact charges, breakeven, reward:risk" width="900" />

- **Trade calculator**: exact round-trip charges, net-at-target, net-at-SL, charge-adjusted reward:risk and breakeven — equity, F&O, or MTF, projected across N trades.
- **Charges & MTF leak report**: where your gross P&L actually goes.
- **Broker cost comparison**: your entire history re-priced on every broker's rate card — see who'd have been cheapest. **Free and paid plans are listed separately** (Kotak Neo's ₹249/month Trade Free Pro sits beside its free tier), with the subscription amortised over the months your trades span and counted in the total — a paid plan judged on brokerage alone always looks cheaper than it is.

### 📈 Edge analytics that don't flatter you
- Expectancy, win rate, avg R by **setup tag** and **segment**.
- **MAE/MFE excursions** from your own EOD price history, plus a **stop-tuning report** in R: how much heat your winners took, how many losers ran past 1R (late/moved stops — flagged as behavioral, not placement).
- Equity curve with max drawdown, daily P&L calendar, streaks, monthly target ladder, benchmark ingestion, Monte-Carlo utilities, XIRR.
- **Shareable stat cards** — post your numbers without posting your account size: defaults to *% of capital*, can hide ₹ entirely, and the PNG is rendered **on your machine** with a permanent *"self-reported · not broker-verified"* watermark.

### 🧾 India-grade tax tooling
- **Tax Summary**: STCG/LTCG with **31-Jan-2018 grandfathering** (per-share FMV), rate-cutover handling, dividend TDS tracking.
- **Advance tax** (234B/234C instalments), **tax-loss harvesting** scanner, **AIS/Form 26AS reconciliation**.
- **ITR Pack**: speculative vs non-speculative vs capital-gains segregation per FY, **ICAI Guidance Note turnover**, and a **44AB/44AD audit-applicability read** with layered cautions — export CSV/XLSX for your CA.
- **Schedule-format export** — the same figures emitted in the return's own item codes: **Schedule CG** (A3 for STCG u/s 111A, B4 for LTCG u/s 112A with the ₹1.25L deduction), **Schedule BP** for both business heads, and **Schedule CFL** with each loss vintage and the year it lapses. It also says which form your book implies — ITR-2, or ITR-3 the moment any intraday or F&O appears.
- **It gets the STT rule right, which a re-label would not.** STT is excluded from capital-gains deductions (proviso to S.48) but allowed in full as a business expense against intraday and F&O. Every other figure in Vyuha is net of STT, so the Schedule CG balance is deliberately *higher* than the net P&L shown elsewhere — the charge breakdown is stored per trade, so this is a fact here rather than an estimate.

### 🔄 Automation — with your consent, never without it
- **Opt-in EOD auto-MTM**: once per trading day, fetch NSE's bhavcopy and mark open positions to close. OFF by default; warns that it overwrites matched marks; skips silently offline; every run is audit-logged.
- **MTF interest accrual** runs idempotently on app open.
- **Signed auto-updates**: the desktop app checks once at launch and shows *Update now / Later* — nothing ever installs itself, and your DB is **backed up automatically before any migration**.

### 🗃 Operational depth
IPO tracker with allotment P&L · capital compounding (double-count-safe) · cash & ledger · corporate actions · symbol aliases · instrument/sector master · surveillance-list warnings · immutable **audit log** · one-file **backup/restore** · command palette (`Ctrl+K`) · collapsible sidebar with live IST market clock · light/dark + colorblind-safe themes · toast notifications · animated, skeleton-loaded UI.

---

## 🔑 Licensing (for the maintainer)

Vyuha ships with an **offline licence gate** — an Ed25519 signature verified on the user's own
machine, with no server call, ever. Every fresh install begins a **7-day full-Pro trial**; the core
journal is free forever.

Vendor tooling lives in `scripts/`:

```bash
node scripts/license-issue.mjs buyer@email.com toolkit          # mint a key (also records it)
node scripts/license-issue.mjs buyer@email.com app --years 1    # annual SKU
node scripts/license-issue.mjs buyer@email.com toolkit --machine ABCD-EF12-3456   # lock to one PC
node scripts/license-list.mjs --expiring 30                     # renewals due
node scripts/license-revoke.mjs A1B2-C3D4-E5 "refunded"         # stop a leaked/refunded key
```

Each key embeds the buyer's email in its signed payload, so no two are alike, and the app shows
"Licensed to &lt;email&gt;". Keys can optionally be **bound to one computer** via a hardware-derived
fingerprint — Windows `MachineGuid`, macOS `IOPlatformUUID`, or Linux
`/etc/machine-id`, each namespaced so the same value on two platforms cannot
collide. Revocation is a build-time list — honest about being a slow tool
rather than a kill switch, because a kill switch would mean phoning home. Full procedures:
[`docs/owner/LICENSE_OPERATIONS.md`](docs/owner/LICENSE_OPERATIONS.md).

---

## 🔒 Local-first by design

No login. No cloud. No telemetry. No analytics SDKs.
Everything lives in **one SQLite file on your disk** — copy it and you've backed up your entire trading life. The desktop app talks to `127.0.0.1` and nothing else (except the two things you explicitly allow: update checks and opt-in bhavcopy fetches).

---

## 🚀 Get it

**Desktop:** grab your platform's build from [**Releases**](https://github.com/Thejesh-k463/VYUHA-LOG/releases) — zero dependencies, Node.js is bundled, and your data persists in app-data across updates and reinstalls.

| Platform | File | Data lives in |
|---|---|---|
| **Windows** | `Vyuha_x.y.z_x64-setup.exe` | `%APPDATA%\in.vyuha.tradejournal` |
| **macOS** (Apple silicon) | `Vyuha_x.y.z_aarch64.dmg` | `~/Library/Application Support/in.vyuha.tradejournal` |
| **macOS** (Intel) | `Vyuha_x.y.z_x64.dmg` | `~/Library/Application Support/in.vyuha.tradejournal` |

macOS ships **two separate builds rather than one universal binary on purpose** — the app bundles a Node runtime, and a universal app would carry a single-architecture Node that fails on the other machine. Take the one matching your Mac.

> **macOS Gatekeeper:** the builds are not yet notarised with an Apple Developer ID, so the first launch shows *"Vyuha cannot be opened because the developer cannot be verified."* Right-click the app → **Open** → **Open**, once. Nothing about the app changes; macOS simply asks before running software it cannot attribute.

**What's free and what isn't:** every fresh install starts a **7-day full-Pro trial** — fully offline, no signup, no card. After that the **core journal is free forever**: recording closed trades, all five broker importers, the dashboard, staged positions, playbooks, the trade calculator and backups. A licence unlocks the analytics layer — the Portfolio Risk cockpit, Arjun's Eye, Edge/Setups, Discipline, the Options Seller Journal and expiry analytics, the tax pack (Tax Summary, ITR, Advance Tax, Harvest, AIS reconcile), broker-cost and MTF comparison, PDF reports, and live open-position tracking with SL/target. Your own record of your trading is never held hostage — every trade you have already taken stays readable, editable and exportable without a key — and nothing leaves your machine either way.

**New here?** Flip through the 📽 [**Getting-Started deck**](docs/client/GETTING_STARTED_DECK.html) — 13 visual slides covering install → import → journal → the playbook loop → Pro activation. (Download and open locally, or print to PDF; arrow keys navigate.)

**Run from source:**

```bash
git clone https://github.com/Thejesh-k463/VYUHA-LOG.git && cd VYUHA-LOG
npm install
npm run setup     # migrate + seed → ./data/vyuha.sqlite
npm run dev       # http://localhost:3000
```

---

## 🗂 Where things live

```
app/         Next routes — one folder per page, plus /api
components/  UI, grouped by feature (trades, import, cash, dashboard…)
lib/
  engine/    charges, classification, rate tables — pure, no DB
  analytics/ every report's maths — pure, no DB, no React
  import/    parsers (one per broker file), pairing, product inference
  risk/      position sizing, limits, margin
  queries/   the ONLY layer that touches the database (server-only)
  domain/    shared constants and vocabulary
drizzle/     migrations, applied in order at startup
tests/       1147 unit + integration tests, one file per module
e2e/         19 Playwright flows through the real app
docs/
  client/    what a BUYER gets — install guide, getting-started deck
  owner/     VENDOR ONLY — licensing, release, monetization, indicators
  sales/     public marketing assets (landing page, brochure)
  screenshots/
scripts/     build, release, and the vendor licence tooling
```

The rule that keeps the maths honest: **`lib/analytics/*` and `lib/engine/*`
import neither the database nor React.** They take plain data and return plain
data, which is why every number in the app can be unit-tested without a browser
or a fixture database — and why a reporting bug can be reproduced in three
lines.

## 🧪 Built like an engine, not a spreadsheet

- **1147 tests.** Most run over pure, DB-free modules — charge engine, classification, MTF interest, capital gains, VaR, Greeks, settlement, discipline, ITR turnover, breach detection, MAE/MFE… A handful deliberately do not: backup/restore and multi-account isolation are exercised against a real migrated SQLite file, because the failures worth catching there (a wiped attachment directory, a half-applied restore, one account's rows leaking into another's tax pack) cannot occur in a mock.
- Charges reconciled against **real broker files**; MTF math verified against **Dhan/Zerodha/Groww's own documentation**.
- Next.js (App Router) + TypeScript · Tailwind v4 · Drizzle ORM / better-sqlite3 · Recharts · TanStack Table · Tauri 2 desktop shell with a bundled-Node sidecar.
- Full changelog in [`CHANGELOG.md`](CHANGELOG.md).

<details>
<summary><b>📜 All npm scripts</b></summary>

| Script | What it does |
| --- | --- |
| `npm run dev` | Start the app on localhost:3000 |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run setup` | `db:migrate` + `seed` in one go |
| `npm run db:generate` / `db:migrate` | Generate / apply Drizzle migrations |
| `npm run db:studio` | Inspect the DB in Drizzle Studio |
| `npm test` | Vitest unit + integration suite (1147 tests) |
| `npm run test:e2e` | Playwright e2e — 19 flows incl. the Dhan transaction report, unpriced-sale quarantine, status/outcome views, the backup export→restore round trip and account switching |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| **`npm run verify`** | **typecheck + lint + tests + production build — run this before pushing.** The first three pass on code that cannot be bundled; only the build catches a client-boundary violation |
| `npm run bump-version x.y.z` | Sync the version across package/tauri/cargo/sidebar |
| `npm run desktop:build` | Build the native desktop app for the CURRENT platform (needs Rust; see below) |

</details>

<details>
<summary><b>🖥 How the desktop app works</b></summary>

Vyuha is a full-stack Next.js server (server actions + better-sqlite3), so it can't be a static
export. The Tauri shell spawns the Next **standalone** server as a **bundled-Node sidecar** bound to
`127.0.0.1`, waits for the port, then points the native webview at it — WebView2 on Windows, WKWebView
on macOS. On first run the launcher copies a seeded template DB (empty journal) into the OS app-data
dir (`%APPDATA%\in.vyuha.tradejournal`, or `~/Library/Application Support/in.vyuha.tradejournal`);
your data persists there across updates and reinstalls.

```bash
# one-time prerequisites
#   Windows : Rust + WebView2 + MSVC C++ build tools
#   macOS   : Rust + Xcode Command Line Tools (xcode-select --install)
npm run desktop:build
# → Windows: src-tauri/target/release/bundle/nsis/
# → macOS:   src-tauri/target/release/bundle/dmg/
```

`desktop:build` builds for **whichever platform you run it on** — there is no cross-compilation, so a
macOS build needs a Mac. That is what the release matrix is for.

Releases are built by CI on tag push (`v*`) across a matrix — Windows x64, macOS Apple silicon and
macOS Intel — signed with the updater keypair and published as **drafts**, so updates only reach
users when a draft is explicitly published. macOS ships per-architecture rather than as one universal
binary because the app carries a bundled Node runtime, and a universal bundle would embed a
single-architecture Node that fails on the other kind of Mac.

</details>

<details>
<summary><b>⚙️ Configuration & data</b></summary>

- **Database:** `data/vyuha.sqlite` (git-ignored). Reset: delete `data/`, run `npm run setup`.
- **Capital model:** two buckets (Equity / Trade F&O), editable in Settings; every risk %, allocation and target computes against bucket capital, with opening snapshots kept in sync.
- **Nothing statutory is hard-coded:** all charge rates live in `charge_config` (broker × segment × exchange) and margin rates in `margin_config` (broker × segment) — both editable in-app, in Drizzle Studio, or via the seed files.
- **Known limits:** broker P&L files lack segment/MTF flags and per-trade dates — re-tag those rows once (overrides persist across re-imports). Brokerage/MTF interest can't be derived from scrip-aggregated files; the reconciliation panel surfaces the deltas.

</details>

<details>
<summary><b>🗂 Project layout</b></summary>

```
VYUHA-LOG/
  app/            # App Router pages (dashboard, risk, trackers, reports…)
  components/     # UI primitives, layout, feature components
  lib/
    engine/       # PURE classification + charges engines
    analytics/    # PURE metrics, tax, ITR, MAE/MFE, greeks, VaR…
    risk/         # PURE calculators, margin, alerts
    import/       # parsers, detect, dedup, commit pipeline
    jobs/         # MTF accrual, auto-MTM
    db/           # Drizzle schema, migrations, seed
  src-tauri/      # Rust desktop shell
  tests/          # 1147 Vitest unit + integration tests
```
Convention: business logic lives in pure modules with zero DB/React imports, unit-tested first,
then wrapped by thin server-only query layers.

</details>

---

## ⭐ If Vyuha saves you one bad trade…

…that's worth more than a star — but the star helps others find it. **[Star the repo](https://github.com/Thejesh-k463/VYUHA-LOG/stargazers)** and share it with a trader who still journals in Excel.

> **Disclaimer:** Vyuha is a journaling and analytics tool. Nothing in it is investment, tax, or
> legal advice. Charge/tax figures are computed from editable, documented rates and reconciled
> where possible, but your broker's contract notes and your CA remain the source of record.
