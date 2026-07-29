# Changelog

All notable changes to Vyuha are tracked here. Versions are kept in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the sidebar
footer via `npm run bump-version <version>`.

## v2.90.1 — CRITICAL: v2.90.0 installer does not run on any machine but the build machine

**Do not distribute v2.90.0.** It starts, fails to load the database engine, and
shows a bare "Internal Server Error".

### What happened

Next 16 stages every `serverExternalPackages` entry as a **symlink** under
`.next/node_modules/<pkg>-<hash>`, pointing at an **absolute path inside the
developer's checkout**:

```
better-sqlite3-90e2652d1716b047 -> T:\…yuha
ode_modulesetter-sqlite3
pdf-parse-08f4573089f02674      -> T:\…yuha
ode_modules\pdf-parse
```

The compiled server requires those packages *by the hashed name*. The desktop
bundler copied the links verbatim, so the installer shipped two 69-byte
pointers to a directory that exists on exactly one computer in the world. On
any other machine the first database call fails with:

```
Cannot find module 'better-sqlite3-90e2652d1716b047'
```

and because the failure happens during render, Next then tries to draw its
global error page — which needs the same missing module — so the user sees
plain "Internal Server Error" with no clue as to the cause.

### Why it slipped through

Two reasons, both now closed:

1. **It works perfectly on the build machine.** The symlink target is real
   there, so every local check — 735 unit tests, 10 e2e flows, a full route
   sweep, a manual browse of the running app — passed against a bundle that
   could never work anywhere else.
2. **The only outward symptom was the installer getting SMALLER.** 32.25 MB at
   v2.89.0 → 28.27 MB at v2.90.0, because two real packages became two links.
   A shrinking installer reads like a successful optimisation, not a defect.

### The fix

- Symlinks are now **materialised into real directories** during bundling.
  `fs.cpSync(..., { dereference: true })` alone is not enough on Windows, where
  these are directory junctions that get copied as links regardless, so each one
  is explicitly replaced with its target's contents.
- A **portability guard** now runs before any installer is produced and **fails
  the build** if the bundle contains a symlink, an empty external package, or a
  missing `better-sqlite3` native binding. A build that would only run on the
  build machine can no longer reach a customer.

v2.90.1 is byte-for-byte v2.90.0 plus this fix. Installer is back to 32.25 MB,
exactly on the size trend from v2.80 onward.

## v2.90.0
**Dhan's Global Transaction Report** — the file that finally answers the three
questions an aggregated P&L cannot: *when* did I trade this, *what product* was
it, and *what did it actually cost*.

### A new importer, and why it matters more than "one more broker file"

Dhan's P&L export has no per-trade dates and no product column. That is why a
book built from it sat almost entirely outside the equity curve and every
risk-adjusted metric. The Global Transaction Report has one row per scrip per
settlement bill, with a real date, and the broker's own charges on every row.

- **Delivery and intraday are told apart from the charges themselves.** India
  levies statutory charges at different rates per product, so the rate is a
  fingerprint: stamp duty **0.015%** on a delivery buy against **0.003%**
  intraday, corroborated independently by STT at **0.1%** on both legs versus
  **0.025%** on the sell alone. Two witnesses, agreeing on 89 of 92 rows of a
  real report. Below ₹5,000 the per-rupee rounding swamps the signal, so those
  rows return *unknown* rather than a reading of an artefact.
- **MTF is still never claimed.** An MTF position carries exactly the same STT
  and stamp duty as delivery; the only thing separating them is financing
  interest, which is a ledger entry and appears nowhere in this file. Verified
  rather than assumed: `Oth. Charges` totalled **₹0.03** across 92 rows and GST
  was 18% of (brokerage + txn + SEBI) to within **₹0.01**, leaving no
  unexplained rupee for financing to hide in. The confirmation panel therefore
  narrows from every scrip to just the **delivery** rows — intraday and F&O can
  never be MTF, so asking about them was noise.
- **Bills that mix both products are split algebraically.** Buy 3,600, square
  1,800 the same day and carry the rest, and the stamp duty lands between the
  two rates. Since stamp is linear in value, the split has exactly one
  solution. Labelled as *derived*, because it is arithmetic on a total rather
  than a stated fact.
- **Legs are paired FIFO across dates into positions.** Bought the 6th, sold
  the 7th is one trade held one day — not a phantom open position and a phantom
  naked short. FIFO matches how the Income Tax Act treats equity delivery, so
  the holding periods agree with the ones that decide STCG versus LTCG. A
  conservation check asserts no share and no rupee is created or lost.
- **The broker's charges are stored as the truth**, with Vyuha's computed
  figures kept alongside as a cross-check. This is real money that really left
  the account; the engine cannot be more accurate about a charge than the charge
  itself, and storing an estimate that differs from the contract note would make
  the journal disagree with the broker.
- Execution times stay **null**. The date column reads `00:00:00` on every row —
  a settlement stamp, not a fill — and bucketing the whole book into a
  pre-open session would fabricate an edge.

### Sales with no purchase — the IPO allotment problem

Sell a holding acquired before the import window and the file contains the sale
and nothing else. In Indian retail this is most often an **IPO allotment**:
shares are credited on allotment and never appear as a buy anywhere.

With `buyValue = 0` the arithmetic still "works" — and every number it produces
is false and flattering. A book of IPO flips would show a 100% win rate and an
infinite Return on Margin.

- These trades are now **flagged, and counted in cash but held out of every edge
  statistic** — win rate, expectancy, profit factor, ROM — until a cost is set.
  The sale and its charges were always real and remain in Net P&L.
- **Vyuha recovers the missing cost from the file's own footer.** The rows omit
  the purchase, but the broker's stated gross P&L includes the trade, so
  subtracting everything that could be matched leaves exactly what it must have
  cost. On a real report: matched gross of −₹8,268.27 against a footer of
  −₹8,489.60 left −₹221.33 for one unmatched holding — 37 shares sold for
  ₹21,904, implying **₹597.98 a share**. Offered pre-filled for confirmation,
  never applied silently.
- Confirm the acquisition as **IPO allotment, bonus/split, transfer-in or an
  ordinary earlier purchase**, set the cost and date, and the trade rejoins the
  statistics. IPO P&L is reported in its own panel, apart from trading edge —
  a listing-day pop is not a repeatable skill and blending it into expectancy
  overstates how well you actually trade.

### Fixed

**A drill-down that did not reconcile.** The trades date filter used
`sellDate ?? buyDate` regardless of whether a position was open, while
`dailyPnl` skips open trades entirely. A holding that is open *and* carries a
sell date — a partial exit, or a sale with no recorded purchase — appeared in
the filtered rows but never in the figure that was clicked. Realised
drill-downs now restrict to closed trades, and the effective date is the exit
for a closed trade and the **entry** for an open one, which is what the code
already claimed in a comment.

64 new unit tests (735 total) and 2 new end-to-end flows (10 total), the new
ones asserted against a real 92-row broker report rather than synthetic data.

## v2.89.1 — forensic audit fixes

A full-book audit of every feature. Money identities were already exact
(gross − charges − net reconciled to 0.0000 across 252 trades, charge
components summed to the stored total to the paise, no float leak). Six
defects surfaced, all fixed.

**The equity curve disagreed with Net P&L by ₹1.47 lakh, silently.**
`dailyPnl` buckets on the exit date, so a closed trade without one belongs to
no day. An aggregated broker P&L statement (Dhan's) carries no per-trade dates
at all — the range lives in the file header only — so 116 of 243 closed trades
were invisible to the return series while the dashboard's Net P&L counted every
rupee. Performance reported **−2.84%** on a book that was down ~11.5%, with
CAGR, Sharpe, Sortino and max drawdown all computed on the dated quarter of it.
Both surfaces now state their coverage before showing a number: which trades
are included, how much P&L sits outside, and that a tradebook import closes the
gap. Nothing about the maths changed — the silence was the defect.

**F&O rows were offered an equity product choice that did nothing.** The P&L
confirmation panel listed every symbol, including options and futures. A
derivative names its own segment and `classify()` ignores the product hint
entirely, so those buttons were dead controls — and the panel keyed on the
display symbol while the server looked up the tradingsymbol, so the override
could silently miss. Only equity is listed now, keyed correctly, with the
derivative count stated rather than hidden.

**Two silent drops in Arjun's Eye**, both against the module's own documented
rule that nothing is discarded quietly. Weekday analysis built Mon–Fri only, so
a Saturday trade — NSE does run occasional Saturday live sessions — vanished
and the weekday counts stopped reconciling. And a timed trade outside
09:15–15:30 fell out of every session bucket with no trace, which is exactly
what a misread broker time column looks like. Both are now counted and
surfaced; three tests pin the reconciliation.

**The cost engine was underselling itself.** Reconciliation showed "total
charges −32.5%" in warning colour, which reads as a broken engine. Almost all
of that gap is brokerage, which genuinely cannot be derived from a
scrip-aggregated file. Excluding it, computed statutory charges match the
broker to **0.69% — ₹291 on ₹42,006**. That comparison is now shown.

Also fixed: literal control characters and a garbled sentence in
`lib/import/time-parse.ts`, and a race in a new e2e spec that read `innerText`
before the streamed page had rendered.

Verified end-to-end: a timestamped tradebook imported through the live pipeline
produced `09:20` from `2026-06-01T09:20:15` — the six-hour bug confirmed fixed
against real data, not only unit tests — with MIS/CNC classifying correctly and
the sessions bucketing as expected. 671 unit tests, 8 e2e flows, 38 routes with
no NaN, Infinity, or error boundary.

## v2.89.0
Two things traders asked for after using v2.88 in anger: **know what kind of
trade you imported**, and **know what kind of trader you are**.

### Import split — P&L vs Transactions

`/import` now presents two clearly-labelled kinds, because they are genuinely
not equivalent and the difference decides how much Vyuha can know:

- **Transactions / Tradebook** (recommended) — every execution, with product
  type and timestamps. Delivery, MTF and intraday identify themselves, scaled
  positions keep their entry ladder, and time-of-day analytics work.
- **P&L Statement** — a pre-aggregated summary with **no product column and no
  times**. "Was this delivery or MTF?" is genuinely unanswerable from the file.

So the P&L path now **asks once, before commit**. Rows are grouped by symbol
with a guess pre-selected, and choosing a different product **re-prices
immediately** — segment, charges, MTF interest and Return-on-Margin all derive
from it, so showing old numbers beside a new choice would be wrong at exactly
the moment you are deciding.

- Same-day round trips are **inferred** as intraday, which is reliable. MTF is
  never inferred — it is indistinguishable from delivery in a P&L file — so the
  default is **delivery**, the safest wrong answer: it neither invents MTF
  interest nor applies intraday leverage. Guessed rows are labelled "assumed".
- The file kind is **detected**, not taken on trust from the tab. Drop a
  tradebook on the P&L tab and it says so rather than asking for product types
  the file already knows.

### Execution times now actually reach the database

`entry_time` and `exit_time` existed since the first schema and **nothing ever
wrote them**. Tradebook parsers now extract HH:MM and commit persists it.

- Date and time are extracted **independently**, because the same broker column
  may hold a bare date, a full timestamp, or both split by `T`, a space, or
  nothing.
- Day-first is assumed for ambiguous dates, per Indian convention — reading
  `06-01-2026` as June 1st rather than 6th January would silently rewrite the
  P&L calendar by months.
- A wrong time is worse than none, so anything unparseable returns null rather
  than guessing.

### Arjun's Eye — the trader's cockpit (`/arjuns-eye`, Pro)

A new page under Journal. Performance keeps its risk-adjusted returns under
Analytics untouched — the two answer different questions: *how good are my
returns* versus *what kind of trader am I*.

- **When you actually make money** — expectancy by Indian session (opening
  drive, morning trend, midday chop, afternoon push, closing hour) and by
  weekday.
- **Which products are worth your capital** — expectancy, win rate, charge drag
  and average hold per segment.
- **Do you cut winners and hold losers?** — average hold of winners vs losers
  and the ratio between them, the most common structural leak in retail.
- **Does a loss change how you trade?** — expectancy after a win vs after a
  loss, streaks, and same-day re-entries after a loser.
- **Is your conviction rewarded?** — expectancy by position-size quartile.

Three honesty rules are enforced in code, not just intended:

1. **No finding below 15 trades** in a group. Thin groups are shown, labelled
   *thin*, and excluded from the conclusions — "Tuesdays are your best day"
   from four trades is noise dressed as insight.
2. **No invented sessions.** Trades without a time are counted as a coverage
   gap and the section says a tradebook import is needed. Bucketing them into
   09:15 would fabricate an edge that never existed.
3. **Descriptive, never prescriptive.** A test asserts no finding contains
   "you should", "must" or "stop doing".

### Fixed while building this

A regex bug that would have misattributed **every timestamped trade by six
hours**: the regex word-boundary anchor does not match between `01` and `T` in `2026-06-01T09:15:32`
(both are word characters), so the date-strip silently failed and the time
regex read `15:32` out of the middle of the date. Caught by a test written
before the code was trusted.

56 new unit tests (668 total) and 3 new end-to-end flows (7 total).

## v2.88.0
**Return on Margin** — the metric that answers what your capital actually
earned, not what your turnover did.

- **New Pro report at `/reports/rom`.** Every Indian F&O journal reports P&L
  against turnover or notional, and both are close to meaningless: a long option
  and a short strangle can carry identical notional while tying up wildly
  different capital. ROM measures against **capital actually blocked**.
- **The denominator is instrument-aware**, because the market is:
  **long options** cost the premium and block no SPAN margin; **short options**
  block margin against the *underlying* notional (which is why a ₹10,000 credit
  can tie up ₹1.5 lakh); **futures and intraday** block a percentage of contract
  value; **MTF** blocks only your own capital; **delivery** blocks the lot.
  The rule was extracted out of the live margin cockpit into a shared
  `capitalBlocked()` so the two views can never drift apart.
- **Three time framings, each for a reason.** Raw ROM is unambiguous but treats
  a one-day and a thirty-day 2% identically. ROM/day fixes that, weighted by
  **capital-days** — ₹1L held ten days is ten times the commitment of ₹1L held
  one, and a naive average would say otherwise. Annualisation appears only in
  the rollups, never per trade.
- **Annualised figures are clamped, and say so.** A book of one-day option
  trades losing 10%/day extrapolates to −3,887% — arithmetically correct and
  impossible, since you cannot lose more than your capital. The display floors
  at −100% and caps at +1,000%, marks clamped values with `*`, and keeps the
  uncapped number in the CSV/XLSX export.
- Groups by segment and by playbook, flags segments where no margin rate is
  configured (which *understates* ROM), and skips trades whose capital cannot be
  established rather than reporting an infinite return.

**KPI drill-downs now go somewhere.** The Net P&L popup's best/worst-day rows
deep-link to `/trades` filtered to that date, and a footer links to the full
journal. `/trades` gained `?symbol=`, `?from=`, `?to=` and `?segment=` support.

- The date filter matches a trade's **effective date** — exit for a closed
  trade, entry for an open one — deliberately mirroring how `dailyPnl` buckets
  realised P&L. An earlier version matched *either* leg and pulled in positions
  opened that day but closed later, so the filtered rows did not add up to the
  figure that had just been clicked. They now reconcile exactly, and an e2e test
  asserts the sum.

**End-to-end coverage went from one flow to four**: import, staged positions
(enable → add tranche → partial exit), the ROM report, and the drill-down
reconciliation. A new dated Zerodha tradebook fixture also puts a second
importer under e2e — the Dhan fixture is an aggregated P&L report with no
per-trade dates, so it can never produce a daily P&L to drill into.

- Fixed a latent race in the existing import spec while doing this: handing a
  file to a not-yet-hydrated page silently drops it, and the failure presents as
  "broker not detected", which sends you hunting in the parser.

**Indicator (SA-PRO v2.1.0)** — beta thresholds now span 0.05–3.0 on *both*
inputs. The previous build capped Low at 1.0 and floored High at 1.0, which
structurally forced "Normal" to straddle 1.0 and made the band unusable against
a peer benchmark where the whole universe can sit below it. An inverted band is
now ordered defensively rather than mislabelling every stock.

36 new unit tests (612 total), plus 3 new end-to-end flows.

## v2.87.0
**The first paid build.** No new features — this is the release that turns the
licence gate on.

- **`LICENSE_ENFORCEMENT` → `"block"`.** When a 14-day trial ends without a key,
  the four Pro screens (Portfolio Risk, Tax Summary, ITR Pack, Broker Compare)
  render the upsell panel instead of their content. The **core journal is still
  never gated** — trades, imports, dashboard, playbooks and backups keep working
  forever, and your data never leaves the machine either way.
- **`WHATSAPP_NUMBER` set**, so `BUY_URL` now opens WhatsApp with a pre-filled
  message. Every in-app upsell and all eight landing-page buy buttons derive
  from that one constant.
- Verified by simulating an expired unlicensed install against a snapshot of a
  real settings row: `/risk`, `/reports/tax` and `/reports/itr` all render the
  upsell with the correct `wa.me` link and no Pro content, while `/trades` is
  untouched. Snapshot restored and confirmed byte-identical afterwards.

Superseded **v2.86.0**, which was tagged *before* the enforcement flip and
therefore still shipped ungated with the fallback buy link. Publish this one
instead.

## v2.86.0
Vendor control over licence keys, and the sales assets to actually sell with.
No changes to the journal itself — this release is about the business around it.

- **Your sales ledger.** Keys were *signed, not registered* — nothing in the
  system knew a key existed, so there was no way to answer "did this person
  actually buy?". `license-issue.mjs` now records every key it mints to
  `license-ledger.jsonl` (gitignored, contains buyer emails).
  `license-list.mjs` reads it back: filter by buyer or key, and
  `--expiring 30` produces your renewal outreach list.
- **Key IDs.** Every key now carries a short derived ID (`A1B2-C3D4-E5`,
  `sha256(key)` truncated) shown in **Settings → License**. Support threads
  quote the ID instead of pasting the key — which is a credential that ends up
  in screenshots.
- **Revocation.** `license-revoke.mjs <KEY-ID> "reason"` stops a refunded or
  leaked key activating. Documented honestly: this is a *build-time* list in an
  offline app, so it reaches new installs only and is not a kill switch. A real
  one would mean phoning home on launch, which this product promises never to
  do. Revocation is checked *before* the signature, because a revoked key is
  still cryptographically perfect.
- **Machine-bound keys — opt-in per sale.** `--machine ABCD-EF12-3456` locks a
  key to one computer; omit it and the key runs anywhere, which is what every
  key issued before this does forever. The buyer copies their **Machine ID**
  from Settings → License. The fingerprint is Windows' own `MachineGuid` —
  stable across app reinstalls, driver updates, RAM upgrades and renames —
  falling back to hostname + platform + arch + CPU model. Deliberately *not*
  total memory, MAC address or disk serial: each of those changes for reasons
  that are not the customer's fault and would kill a paying key. The binding
  lives inside the signed payload, so it cannot be stripped; a test forges a
  stripped payload and asserts the signature check catches it.
- **BUY_URL now derives from a single `WHATSAPP_NUMBER`** with a pre-filled
  message, falling back to the releases page while unset so no button is ever
  dead. A test **fails the build** if `LICENSE_ENFORCEMENT` is `"block"` while
  the number is still empty — the one combination that would strand every
  trial-expired user behind a dead link.
- **Landing page rebuilt** (the previous one predated v2.80 and still carried
  Razorpay placeholders and no screenshots): WhatsApp-first CTA, founding-trader
  pricing, real product screenshots, staged positions as the flagship section,
  and a delivery flow matching email-a-ZIP. SEBI-safe by construction — no
  return, accuracy or win-rate claims anywhere. `build-landing.mjs` inlines the
  screenshots into one self-contained file and refuses to build while any
  `[[PLACEHOLDER]]` is unfilled.
- **Docs brought current**: `LICENSE_OPERATIONS.md` (the owner's runbook —
  issue, list, support, refund, rotate), `INDICATORS_LAUNCH_KIT.md` (analysis of
  both Pine scripts, sales copy, paste-ready TradingView descriptions,
  invite-only publishing steps), plus a current-state section appended to the
  roadmap, whose handoff notes had stopped at v1.14.0.
- 25 new tests (576 total). Enforcement deliberately still `"banner"` — flipping
  it needs the real WhatsApp number.

## v2.85.0
**Staged positions** — build a position in tranches and scale out of it, the
way positions are actually managed.

- **Entry ladder with a stop per tranche.** Turn on staged mode from the Trades
  table and a position becomes a list of fills: add another entry as the trade
  proves itself, each with its own stop and target, or write one stop across
  every open tranche in a click. Closed tranches are never rewritten — that
  would falsify the record of what you did.
- **Partial exits on any trade.** Book 25/50/100% (or any quantity) and the
  rest keeps running. No mode switch needed: a plain trade converts to a ladder
  on the fly, losslessly. Percentage shortcuts round DOWN to a whole unit,
  because you cannot sell 762.5 shares.
- **Three accounting rules, chosen deliberately and documented in the code.**
  *Pricing is weighted-average* — an exit books against the blended cost of
  everything open, so journal P&L never disagrees with your broker's average
  price. *Quantity consumption is FIFO* — money is fungible but stops are not,
  so an exit retires the oldest tranche and the survivor keeps its own stop.
  *R is frozen at the first entry* — a 3R stays a 3R whether or not you
  pyramided, so every existing expectancy and playbook report keeps working.
- **Charges booked per fill.** Brokerage is per order and STT per execution, so
  each leg is priced on its own — with DP levied once per exit DATE rather than
  once per leg, and MTF interest accrued per tranche from its own entry date.
  Scaling into options really does cost ₹20 an order and the journal now says
  so; under percentage brokerage it is correctly cost-neutral.
- **Risk cockpit sums real risk.** Open risk, initial risk and capital-at-risk
  are summed across tranches with individual stops instead of being inferred
  from one position-level stop — a wide stop on the core and tight stops on the
  adds is genuinely less exposed, and `/risk` now says so.
- **Imports rebuild the ladder automatically.** Zerodha, Angel One and Upstox
  tradebooks list every execution; those fills are now preserved instead of
  being flattened into one average. A position is staged only when a SIDE was
  filled more than once — an ordinary buy-then-sell stays an ordinary trade.
- **Two warnings that earn their place.** *Averaging down* fires when an add is
  worse than your average (and correctly inverts for shorts). *Open risk above
  initial risk* fires when an add is not funded by trailing the earlier stops up
  — which is most of them, and is precisely the thing nobody notices.
- 83 new unit tests (551 total), including proof that a one-entry ladder prices
  identically to the classic round-trip across all five brokers.
- Note on precision: STT and stamp duty round to the nearest rupee, so pricing
  a trade as two legs instead of one round trip can move its total by up to
  about ₹2. Measured across every segment on real data the drift was ≤ ₹1.11.
  The per-leg figure is the more accurate one and is not corrected back.

## v2.84.0
Two fixes aimed at discoverability: numbers that explain themselves, and the
preset playbooks that were hiding inside a dropdown.

- **Clickable KPI cards with a drill-down popup.** Sixteen cards across the
  Dashboard, Portfolio Risk, Equity Tracker and Trade F&O Tracker now lift and
  glow on hover and open a compact breakdown on click (or Enter/Space — the
  cards are keyboard-focusable `role="button"`s). The popups answer *what is
  this number made of*, not just what it is: **Net P&L** splits into gross minus
  every charge with best/worst day and dates; **Open Risk @ SL** puts open risk
  next to initial risk with the stopped/unstopped count, so trailing a stop
  visibly moves the number; **MTF funded** shows effective leverage and interest
  accrued as a share of your paper gain, flagging when financing has eaten the
  entire unrealised gain; **Unrealised P&L** names your best and worst position.
  Detail objects are plain serializable strings, so server components can build
  them without a client boundary.
- **Preset library on `/playbooks`.** The 25 world-class setups existed since
  earlier releases but lived inside a `<select>` in the New Playbook dialog —
  effectively invisible. They now render as a browsable library: filter chips
  for 7 ecosystems (Intraday & Momentum, Breakout & Trend, Positional/Growth,
  Mean Reversion, Price Action/SMC, Options & Events, Swing & Overnight), every
  rule visible on the card, one-click **Add**, `✓ Added` once it's yours, and
  fully editable afterwards. Deliberately **not** auto-seeded into the DB: 25
  untraded setups would bury your real playbooks and turn the Discipline page's
  per-playbook expectancy into 25 rows of noise. Nothing is added until you
  click. The empty state now points at the library.

## v2.82.0
Ecosystem-research batch: findings from surveying the global journal market
(TradeZella/TraderSync/Edgewonk/TradesViz) and India's 2024–2026 F&O regime,
turned into three shipped features.

- **Angel One + Upstox importers.** Angel One alone is ~15% of India's active
  trading accounts; both brokers now import end-to-end. One resilient parser
  handles each broker's *two* export shapes — tradebook (buy/sell column,
  aggregated into round-trips per tradingsymbol+product) and aggregated P&L
  report — with candidate-list column resolution plus contains-fallback, so
  header drift between report versions doesn't break parsing. `₹` symbols and
  thousands-commas are stripped. Charge cards, DP charges, MTF interest and
  eq_mtf own-margin seeded for both. Two hardcoded broker enums (charges-preview
  route, trade actions) now derive from `BROKERS`, so they can never silently
  reject a newly added broker again.
- **SEBI Compliance Radar** (`/risk`). Turns your open book + today's date into
  plain warnings for the post-2024 regime: **+2% expiry-day ELM on short options
  expiring today**, **no calendar-spread margin benefit on expiry day**, weekly
  expiry discontinuation (BANKNIFTY/FINNIFTY/MIDCPNIFTY/NIFTYNXT50 are monthly
  only; NIFTY on NSE and SENSEX on BSE kept weeklies), index position-limit
  proximity vs the ₹1,500 cr net limit with the intraday random-snapshot
  warning, and standing reminders on upfront premium collection and the
  ₹15–20 lakh contract band. Informational only — your broker's RMS remains the
  source of truth and Vyuha never blocks a trade.
- **Shareable stat cards** (`/reports/performance`). Privacy-first by
  construction: defaults to **% of capital**, offers "hide ₹ entirely", and
  shows real rupees only if explicitly chosen; you pick which of 10 metrics
  appear. The PNG is drawn on a canvas and saved **locally — nothing is
  uploaded** — and carries a permanent, non-editable *"self-reported from my own
  journal · not broker-verified"* watermark, because an offline app must never
  imply broker verification.
- Note: options payoff diagrams were already shipped (strategies engine +
  payoff chart) — verified rather than rebuilt.

468 unit tests (+28), typecheck, lint all green; every feature verified live,
including a temporarily-shorted expiring option to prove the radar fires and an
end-to-end PNG export.

## v2.80.0
Three workstreams: performance, monetization v2, and a full visual overhaul.

### Performance & code health
- **Per-request query deduplication**: the eight hottest server queries
  (trades, MTM/spot maps, settings, margin config, aliases, playbooks, charge
  rates) are wrapped in React `cache()` — pages that previously hit the DB 2–4×
  per render now hit it once, and importing a broker file no longer re-queries
  margin config per trade (the last N+1).
- **New indexes** on `trades.is_open` and `trades.playbook_id` (migration 0024).
- **Lint: 16 warnings → 0 problems** — dead imports/locals removed across 12
  files; `_`-prefixed/rest-sibling destructures now treated as intentional.

### Monetization v2 (offline, user-first)
- **14-day full-Pro trial** stamped on the true first run (installer templates
  ship unstamped; existing installs backfilled). Trial users see everything
  plus an honest countdown strip.
- **`<ProGate>`** now drives all four Pro screens (Portfolio Risk, Tax Summary,
  ITR Pack, Broker Costs) from one `PRO_FEATURES` registry. "banner" mode
  (current) informs; "block" mode replaces content with an upsell panel after
  the trial. Enforced product principle: the core journal — trades, imports,
  dashboard, playbooks, backups — is NEVER gated.
- **Annual keys**: the license payload takes a signed optional `expires` date;
  `license-issue.mjs --years 1` mints them; expired keys degrade gracefully
  (grace trial → free) with a renewal notice. Settings shows tier/trial/expiry.

### Visual overhaul (all 3 cosmetic tiers)
- **Typography**: Inter UI + JetBrains Mono on every number and table
  (self-hosted, offline-safe) — the terminal look, app-wide.
- **Depth**: elevation tokens with inner-highlight cards, hover lift, blurred
  dialog overlays with real spring keyframes, hero gradient border + glow on
  the equity curve.
- **Charts**: draw-in animation + crosshair cursor on the equity curve; the
  P&L calendar gained rounded magnitude-scaled cells, hover scale and a today
  ring.
- **Alive layer**: Net P&L sparkline + week-over-week ▲/▼ delta chip, count-up
  KPI numbers (reduced-motion aware), row-hover lift on every table, shimmer
  skeletons on the five heaviest routes, and a dependency-free **toast system**
  replacing inline "Saved." messages.
- **Sidebar**: collapsible icon rail (persisted), accent rail + glow on the
  active item, a "Jump to… Ctrl K" chip wired to the command palette, and a
  footer **IST clock with market open/closed pulse dot**.
- **Accent skins**: Terminal (teal) / Tape (amber) / Ice (blue), selectable in
  Settings with instant preview, persisted (migration 0025), composing with
  light theme + colorblind mode. P&L semantics untouched by skins.
- **Illustrated empty states** (skin-aware line art) on every data table, the
  dashboard charts and the Playbooks page.
- **Branded splash** (glowing व, ripple halo, shimmer progress, privacy
  footer) and **print-grade PDF output**: printing forces the light palette,
  strips elevation, sets page margins and keeps tables from splitting.

440 unit tests, typecheck, lint all green; features verified live in dark,
light and Tape-skin contexts, including a fresh-context toast/interactivity
probe.

## v2.75.0
User-control release: seven upgrades, every one warns and cautions instead of
acting — the trader keeps the final say on everything.

- **Playbook rule-checklist enforcement.** Journaling a trade with a playbook
  attached now shows its rules as a "tick what you actually followed"
  checklist; unticked rules persist as violations (validated server-side
  against the playbook's real rules, merged non-destructively with the
  pre-trade limits engine's entry breaches). New Discipline table: **"Playbook
  rules — what breaking each one costs"** (worst rule first, closed net ₹,
  avg/trade) with honest correlation-≠-causation framing.
- **Per-playbook expectancy cards.** Each playbook card shows Trades / Win% /
  Net / Expectancy / Profit Factor / Avg R from closed tagged trades, with a
  ⚠ small-sample warning under 20 trades and an honest empty state.
- **Auto-updater surfaced.** The launch-time update check (native Update
  now/Later dialog, signed releases, offline-silent) now has an "App updates"
  card in Settings documenting the consent contract: nothing ever installs on
  its own, and the DB is backed up before any migration.
- **MAE/MFE stop-tuning report** (Edge page). MAE/MFE now normalizes to R via
  each trade's recorded risk; the new card shows winners' heat distribution
  (≥0.5R / ≥0.8R) and losers running past 1.1R (flagged as behavioral, not
  placement). Every suggestion is hedged; small samples get an explicit
  "mostly noise" warning; footer says descriptive-not-prescriptive.
- **EOD bhavcopy auto-MTM (opt-in).** New Settings toggle — OFF by default —
  lets the app fetch NSE's EOD file once per trading day (after ~7pm IST) and
  mark open equity positions to close via the existing audited pipeline.
  Warns that matched MTM prices get overwritten; skips silently offline;
  walks back weekdays past holidays. Migration 0023 adds the settings columns.
- **SL/TSL/target breach alerts.** New pure detector (long/short aware, TSL
  supersedes SL) feeding caution banners on Dashboard and Portfolio Risk:
  "check a live quote and review your exit plan" — marks are EOD/manual, and
  the banner never places or closes anything. Desktop notifications are
  strictly opt-in per device.
- **ITR Pack (India)** — new report: per-FY head segregation (speculative
  intraday / non-speculative F&O / STCG-LTCG), ICAI Guidance Note (8th ed.)
  turnover, and a 44AB audit verdict with layered cautions (44AD's 5-year
  lock, loss carry-forward deadline, "have a CA confirm" on every verdict).
  CSV/XLSX export for the CA.

Verified live end-to-end (rule checklist → per-rule cost table, expectancy
cards, stop-tuning card, breach banner via a temporary SL, auto-MTM refusing
to run while disabled, ITR pack against the real 252-trade book) with all
test data reverted. 433 unit tests (+30), typecheck, lint all green.

## v2.70.0
- **Preset playbooks expanded to a categorized global library — 25 setups
  across 7 trading ecosystems** (was 10, flat): Intraday & Momentum (ORB, VWAP,
  Gap-and-Go, Momentum/RS), Breakout & Trend (MA Pullback, Retest,
  Donchian/Turtle, 52-Week-High, Darvas Box), Positional/Growth (CANSLIM,
  Minervini VCP, Wyckoff Spring, Weinstein Stage 2), Mean Reversion (Range
  Fade, Connors RSI-2, Bollinger Reversion), Price Action/SMC (ICT Liquidity
  Sweep + FVG, Supply & Demand, Pin Bar), Options & Events (Theta Decay, Iron
  Condor, India Expiry-Day Theta, Earnings/Event), and Swing & Overnight
  (Multi-Day Swing, India BTST). The New Playbook picker groups them by
  ecosystem; every rule's metrics (risk %, ATR multiples, deltas, stop %)
  remain fully editable before saving, and the from-scratch custom flow is
  unchanged. New `tests/preset-playbooks.test.ts` guards the library's shape
  (unique names, ≥3 single-line rules each, ≥5 categories). Verified live:
  picked CANSLIM, edited O'Neil's 7–8% stop rule to a custom 5% before saving,
  confirmed it persisted, then cleaned up.

## v2.65.0
- **Fixed: open short positions (written options, short futures) showed qty=0/
  invested=0/unrealised=0 on the Equity and Trade F&O trackers.**
  `deriveOpenPositions()` (`lib/analytics/positions.ts`) computed
  `qty = max(0, buyQty − sellQty)` and used `avgBuyPrice` unconditionally — for
  a sell-to-open position (buyQty=0, sellQty=open qty), both evaluated to 0. Now
  isShort-aware (`sellQty > buyQty`), matching the pattern already used by
  `/risk` and `closePosition`: qty/entry read off the sell leg, unrealised P&L
  mirrors direction (profits when price falls), and days-held measures from the
  sell date (the actual open leg) for a short. MTF is long-only in India, so
  its own-capital/funded-amount fields are unaffected. New `tests/positions.test.ts`
  (7 tests: long, short profit/loss, days-held, R-multiple sign, MTF untouched).
  Verified live: a disposable open short stock-option (entry 100, MTM 80, qty
  75) correctly showed invested ₹7,500 / unrealised +₹1,500 (20%) where it
  previously showed all zeros — then removed.

## v2.60.0
- **Fixed: Edit-trade dialog showed a false loss for open MTF positions.** The
  dialog never wired up the current-price field to the P&L preview, so a
  position up in price could still show "Net: -₹X" (only realized gross, always
  ₹0 pre-exit). It now shows entry cost so far and unrealized P&L (at current
  price) as separate, clearly-labeled figures for any still-open position.
- **New: Current R and Target R:R shown side by side.** Current R stays live
  (unrealised P&L ÷ risk amount, tracks the position as it moves); Target R:R is
  new — the static planned reward:risk from entry/SL/target, computed once at
  entry. Both appear on the trades table, trackers, and edit/add trade dialogs.
- **MTF own-margin % is now broker-specific, not one flat global rate.**
  `margin_config` gained a `broker` column (Dhan/Groww 25%, Zerodha 20%, per
  each broker's own MTF documentation) — threaded through position tracking,
  the accrual job, close/edit/create trade flows, the Trade Calculator, the
  broker-cost comparison report, and the /risk margin-rate editor (now one row
  per broker × segment, independently editable).
- **New: funding-type filter on the equity tracker** — All / User-funded only /
  Broker-funded (MTF) — to separate self-funded delivery positions from
  leveraged MTF ones at a glance.
- **New: Risk Amount auto-computes from the SL you set** (`|entry − SL| × qty`)
  in both the Add-trade and Edit-trade forms, while still allowing a manual
  override.
- **New: preset playbooks library** — 10 globally-recognized trading setups
  (Opening Range Breakout, VWAP reversion, trend-following, breakout-pullback,
  mean-reversion, gap-and-go, momentum, options theta-decay, earnings play,
  multi-day swing) selectable from the New Playbook dialog to pre-fill the form;
  edit anything before saving. The from-scratch custom-playbook flow is
  unchanged.
- Verified live end-to-end (broker-specific margin math, the false-loss fix,
  auto risk-amount, funding filter, preset playbooks) against a disposable test
  trade and playbook, cleaned up afterward. 393 unit tests, typecheck, lint all
  green.

## v2.50.0
- **Fixed: capital figures frozen at the original ₹13L/₹4L defaults.** Page titles,
  Cash & Ledger, and bucket-filter dropdowns had "(₹13L)"/"(₹4L)" hardcoded into
  `BUCKET_LABELS` — changing capital in Settings never touched them (now removed;
  live capital already shows correctly elsewhere on each page). A second instance of
  the same bug: the Targets → Equity position-size calculator divided by a
  hardcoded 1,300,000 instead of live `equityCapital` — now threaded through as a
  prop from the server page.
- **Fixed: R-multiple frozen at trade creation for open positions.** The tracker
  showed a value computed once when a trade was opened (net entry-cost ÷ risk),
  never updated as the position moved — a position up 1.43% could show a negative
  R. `lib/analytics/positions.ts#deriveOpenPositions` now computes R live as
  unrealised P&L ÷ risk amount.
- **Fixed: a second "MTF funded = full position value" bug**, this time in the
  position-tracker's own display logic (`positions.ts`), independent of the
  backend fix from v2.0.0 — it was silently ignoring the persisted funded amount
  and recomputing the (wrong) full-value figure for display.
- **Fixed: MTF interest day-count undercounted by one day, in three places** —
  close-trade, the daily accrual job, and broker-cost comparison all subtracted an
  extra day. Confirmed against Dhan's own MTF documentation: interest runs from
  T+1 settlement through the day before sale proceeds settle, i.e. exactly
  (sellDate − buyDate) calendar days — no "-1".
- **Corrected Zerodha's seeded pledge/unpledge fee** from ₹20 to the real ₹15+GST
  per Zerodha's own MTF calculator page. Every other rate (Dhan's interest tiers,
  Zerodha/Groww annual rates, STT/stamp/exchange/SEBI/DP) already reconciled
  exactly against a real user-supplied MTF trade log.
- **MTF input model switched to "Own capital used" as primary** (matching how a
  real MTF trade log is kept — you know what cash you put in; the broker-financed
  amount and leverage are derived), replacing the old "funded amount" field in
  both the trade form and the Trade Calculator.
- **New: close any open trade** — a "Close position" action with a live
  recomputed charges/P&L preview before confirming, for any segment (equity,
  MTF, options, futures).
- **New: edit any trade, any time** — a full editor (qty, prices, dates, SL/TSL/
  target, risk, MTF own-capital, tags, notes) for open or closed trades, reusing
  the same charges engine so edits never drift from what a fresh entry would
  compute.
- **New MTF analytics on the position tracker**: own capital deployed, ROI on
  capital % (the leveraged return your own cash actually earned), breakeven sell
  price, and a warning badge when accrued interest has eaten the entire unrealised
  gain — modeled directly on a real trader-maintained MTF log.
- Verified live end-to-end against real test positions (created, tracked, closed,
  edited, then removed) plus the existing 252-trade journal, which is untouched.
  387 unit tests, typecheck, lint and production build all green.

## v2.0.0
- **Fixed: MTF interest overcharged everywhere (real money bug).** Trade creation, the
  daily accrual job, position-close, and the Trade Calculator's default all treated an
  MTF position as 100% broker-financed — interest should only accrue on the leveraged
  portion your broker actually lends, not the full position value. New
  `defaultMtfFundedAmount()` (`lib/risk/margin.ts`, 4 tests) derives the funded amount
  from the existing configurable own-margin % (Settings → Margin, same rate the /risk
  margin gauge uses); a new `trades.mtf_funded_amount_paise` column persists it per
  trade at entry so the accrual job and close-position recompute reuse the correct
  figure instead of silently resetting to the full buy value. The live charge preview
  now applies the identical default, so what you see before saving matches what's
  saved (it previously skipped MTF interest AND the pledge charge whenever "MTF
  funded" was left blank). Verified live: a ₹1L test MTF position correctly funded at
  ₹75,000, not ₹1,00,000 — roughly 25% less interest than the old bug charged.
- **Fixed: open-trade preview showed a false loss when price was up.** The "Add open
  trade" panel only ever displayed realized P&L (always ₹0 gross pre-exit), so a
  position up in price still read as a net loss from entry charges alone. Now shows
  "Entry cost so far" (charges only) and, when a current price is entered, a separate
  "Unrealized P&L (at current price)" line — clearly not merged into the cost figure.
  Closed-trade preview is unchanged.
- Removed the "Days held (MTF)" field from the open-trade form (interest can't have
  accrued on day zero); kept for closed manual entries where an elapsed holding period
  is meaningful. Trade Calculator's "Funded ₹ (0 = full)" relabeled to "0 = auto @
  {margin}%".

## v1.50.0
- **Pre-trade limits are now advisory — the trader always has final say.** A breached
  limit no longer disables the Add-trade button: the verdict reads "Limit breached
  (you can override)" and the button flips to a red "Override & add anyway". Overridden
  breaches are still recorded in `rule_violations` and surface on the Discipline
  scorecard's breach tile — control stays with the user, accountability stays in the
  journal.
- **"Active" bucket renamed to "Trade F&O" everywhere in the UI** — nav ("Trade F&O
  Tracker", "Targets — Trade F&O"), page titles, dashboard/trades bucket filters, risk
  cockpit scope toggle, margin gauge, capital settings, cash ledger, capital-growth
  chart. Display-only: the internal bucket id stays `active` (DB rows, APIs and
  overrides are untouched). New `BUCKET_SHORT_LABELS` in `lib/domain/constants.ts`.

## v1.40.0
- **P0.1 paise migration FINISHED** — all 17 ₹-amount columns on `trades` (values, P&L,
  full charge breakdown, risk amount) now stored as INTEGER paise (migrations `0016`/`0017`,
  data converted ×100 in place and verified sum-identical on all 252 trades). A Drizzle
  `customType` exposes rupees at runtime, so no call sites changed. Per-unit price/level
  columns (avg prices, SL/TSL/target, strike, FMV) stay REAL by design.
- **Margin/SPAN tracking** (P1.2 final slice) — pure `lib/risk/margin.ts` (7 tests): long
  options = premium paid; short options = rate% × notional (spot ?? strike); futures/intraday
  = rate% × current value; MTF/delivery = rate% × invested. New editable `margin_config`
  rate table (migration `0018`, seeded approximations) + "Margin estimate" panel with
  per-bucket utilisation gauges on /risk.
- **IND-5 AIS / Form 26AS reconciliation** — pure `lib/analytics/ais.ts` (8 tests): tolerant
  paste parser (dividend / sale SFT-18 / purchase SFT-17 / interest; FY labels or dates;
  ₹-grouped amounts) + reconciliation of AIS dividends (per company+FY, alias-resolved,
  incl. TDS) and per-FY sale/purchase consideration (trades + IPO allotments/exits) with
  matched / MISMATCH / not-in-journal / not-in-AIS statuses, tolerance max(₹10, 0.5%).
  New /reports/ais screen (nav "AIS Reconcile"), stateless `/api/ais`.
- **P2.1 broker-API auto-import (Kite slice)** — first `ApiImportSource` implementation:
  `lib/import/api/kite.ts` (5 tests) pulls today's executions from Zerodha Kite Connect,
  aggregates per symbol+product (earliest-buy/latest-sell dates, MIS→intraday, CNC→delivery,
  MTF→mtf hints) and feeds the unchanged preview→commit pipeline. "Connect broker" card on
  /import; credentials in new `broker_connections` table (migration `0020`, plaintext local,
  stated in UI; Kite tokens expire daily).
- **Trade attachments** (P2.4 completion) — chart screenshots per trade: `trade_attachments`
  table (migration `0019`) + files under `<data-dir>/attachments/`, upload/gallery/delete in
  the journal dialog, streaming via `/api/trades/attachments` (images only, 8 MB cap,
  path-confined, audited). Backup screen notes attachments are outside the JSON backup.
- **MAE/MFE per trade** — pure `lib/analytics/mae-mfe.ts` (5 tests) computes max adverse /
  favorable excursion + %-of-MFE captured from `price_history` EOD bars for closed dated
  trades; card with coverage badges on /reports/edge.
- **Discipline breach tile** (P1.4 follow-up) — `breachReport()` in discipline.ts (4 tests)
  rolls up `rule_violations` saved at entry time; "Entry-time limit breaches" card on
  /reports/discipline showing per-rule counts and closed net P&L.
- **Zero-dependency installer** — `build-desktop.mjs` now bundles the building machine's
  Node runtime (+ LICENSE) into `desktop-dist/node/`; the Tauri shell prefers the bundled
  binary and falls back to system `node` for older bundles. Target machines no longer need
  Node installed (cargo check verified; rebuild the installer to ship it).

## v1.10.0
- Option Greeks: Black-Scholes delta/gamma/theta/vega per open option position + a
  portfolio aggregator (`lib/analytics/greeks.ts`), scaled by quantity and signed for
  direction (short flips gamma/vega negative, theta positive). New `trades.implied_vol`
  column, settable per position via the risk-edit dialog; falls back to a flat 20%
  estimate when unset. New "Option Greeks" panel on Portfolio Risk.

## v1.9.0
- F&O trade entry upgrade: an Equity/F&O mode toggle in the manual trade form —
  Underlying, Option/Future, Strike, CE/PE, Direction (Buy/Sell), Expiry with a live
  DTE badge, Lot size, Lots, Entry/Exit premium, Strategy.
- Short (sell-to-open) position support fixed across the app: `isOpen` detection,
  the risk/exposure engine, the close/cover flow, and the pre-trade risk-edit routes
  were long-only; a written CE/PE was previously invisible to portfolio risk.
- Real sector data (via an external market-data lookup) populated for held positions,
  correcting earlier manual-entry mistakes in the instruments master.

## v1.8.0
- P1.3 market-data foundation: `instruments` security master (symbol/sector/ISIN/lot
  size) and `price_history` (EOD OHLC, built automatically from bhavcopy imports).
- Sector concentration panel on Portfolio Risk (HHI, top-sector %, classified %).

## v1.7.0
- P1.1 finished: time-weighted return (TWR) and benchmark alpha/beta vs an index
  (NIFTY), completing the performance analytics suite alongside the existing
  Sharpe/Sortino/Calmar/XIRR.
- P1.4 pre-trade limits engine: per-trade risk cap, daily-loss stop, max-open,
  max-trades/day, and concentration checks — live pass/warn/block before saving a
  trade, plus a what-if panel on Portfolio Risk.

## v1.6.0
- Version-sync-only bump (no feature).

## v1.5.0 and earlier
- Foundational build: money-as-paise core, cash/fund-flow ledger, append-only audit
  log, backup/restore, quant performance analytics (Sharpe/Sortino/Calmar/XIRR),
  option strategy recognition + payoff diagrams, physical-settlement tracker,
  F&O ban/ASM surveillance, tax-loss harvesting, advance-tax planner, broker-cost
  comparison, bhavcopy auto-MTM, symbol-alias map, and the trade calculator.
  See `docs/INSTITUTIONAL_GRADE_ROADMAP.md` for full detail on each.
