# The two indicators — analysis, sales copy, and TradingView publishing

Companion to `PINE_SCRIPT_INVITE_ONLY.md` (mechanics) and `MONETIZATION_PLAN.md` (strategy).
This file is about **these two specific scripts**: what they actually do, what to fix before you
publish, what to write to sell them, and what to write on TradingView.

Scripts covered:
- **Stage Analysis Indicator-KTR** (`SA-PRO`) — overlay
- **RS Multi-TF PRO** (`RS-PRO`) — separate pane

---

## 0. Fix these before you publish

*Status 2026-07-22 — §0.1 resolved by the owner. **§0.2 and §0.3 are still open.** §0.2 is visible
to anyone who loads the indicator on an NSE chart, so fix that one first.* anything

### 0.1 ✅ RESOLVED — the copyright header on SA-PRO

The Stage script previously carried a **Mozilla Public License 2.0** header and a `© TheWrap` line,
both inserted automatically by TradingView's Pine Editor and easy to inherit when starting from
someone else's code. MPL-2.0 is a **source-disclosure** licence, which would have conflicted
directly with publishing the script invite-only with hidden source.

**Removed by the owner on 2026-07-22.** The file now opens with a plain
`// Stage Analysis TradingView Indicator` comment.

**One thing still worth doing:** the script now has *no* copyright line at all, and RS-PRO never had
one. Add your own to both, so authorship is positively stated rather than merely unclaimed:

```pine
// © Thejesh K — Vyuha Stage Analysis PRO
// All rights reserved. Redistribution or resale prohibited.
```

### 0.2 ⚠ STILL OPEN — the benchmark default is wrong for Indian stocks

`SA-PRO` line 47:

```pine
i_benchmarkSym = input.symbol("SPY", "Benchmark", ...)
```

Your own screenshot shows this live: **KSH International (NSE) being measured against `BATS:SPY`**
— an Indian smallcap's relative strength computed against the S&P 500. The RS number, the RS rating,
the Cheat-Entry `rsHolding` test **and Beta** are all downstream of that symbol, so all four are
currently meaningless for an NSE chart.

**Change the default to `NSE:NIFTY`** before you publish. It is a one-word change and it is the
single most visible credibility problem in the product:

```pine
i_benchmarkSym = input.symbol("NSE:NIFTY", "Benchmark", group=G_RS,
     tooltip="NSE:NIFTY or NSE:CNXSMALLCAP for India; SPY/QQQ for US")
```

Consider also defaulting `NSE:CNXSMALLCAP` guidance in the tooltip — comparing a smallcap to NIFTY
overstates RS during smallcap-led rallies.

### 0.3 The stage MA period needs a timeframe warning

Weinstein's method is built on the **30-week** MA. `SA-PRO` defaults to `30` periods on whatever
timeframe the chart is on — so on a **daily** chart it is a 30-*day* MA, which is a completely
different indicator and will flip stages far too often.

The tooltip says "30 for weekly" but nothing enforces or warns. Two options:

- **Simplest:** say it loudly in the description — *"Use on weekly charts with MA 30, or on daily
  charts set MA to 150."*
- **Better:** auto-scale the default. Detect `timeframe.isdaily` and use `150`, weekly `30`.

Buyers who put it on a daily chart with the default and see stages flipping every week will assume
the indicator is broken. It isn't — it's being used at the wrong scale.

---

## 1. What you actually have (the honest technical read)

### SA-PRO — "should I be in this name at all?"

A **top-down qualification screen** in one table. Five independent reads:

| Metric | What it computes | Why a trader cares |
|---|---|---|
| **Stage** | Price vs MA + MA slope, bucketed into Weinstein's S1–S4, with a Conservative/Moderate/Aggressive slope threshold and a "periods in stage" counter | Stops you buying Stage 4 falling knives and Stage 3 tops |
| **RS** | Stock ÷ benchmark, vs its own MA, with slope confirmation | Weak-vs-index names underperform on the way up and lead on the way down |
| **Momentum** | ROC, smoothed, **plus acceleration** (is the rate of change itself rising?) | Distinguishes "rising" from "rising faster" — the Stage-2 sweet spot |
| **Cheat Entry** | Near the MA **and** volume dried up **and** RS still holding **and** in Stage 1/2 | A Qullamaggie-style low-risk pullback entry, all four conditions required |
| **Beta** | Covariance/variance vs the benchmark over 50 periods | Position sizing — a 1.8-beta name needs a smaller position for the same risk |

**The genuinely differentiated part:** lines 565–571 export every metric to the data window:

```pine
plot(currentStage, title="Stage", display=display.data_window)
plot(rsRating, ...), plot(isCheatEntry ? 1 : 0, ...), plot(beta, ...)
```

That makes all of it usable in **TradingView's Pine Screener** — you can scan the entire NSE universe
for *"Stage 2, RS positive, Cheat Entry = 1"* instead of flipping charts one by one. Most indicators
are decoration; this one is a screening engine. **Lead with this.**

Three display densities (Minimal / Normal / Expanded) and eight alert conditions.

### RS-PRO — "is the move aligned, and where's the trigger?"

Two engines sharing one pane:

**Multi-horizon RSI.** RSI at 14, 22, 55, 122 and 254. That is not five settings of the same thing —
it is a **single-chart proxy for multi-timeframe RSI**. On a daily chart, RSI 14 is the swing read,
55 is roughly the weekly, 254 is roughly the yearly. When all five sit above 50 you have genuine
multi-horizon alignment, and there is an alert for exactly that (`allBullish` / `allBearish`).
The table shows value, zone (OB / BULL / NEUT / OS) and a per-bar trend arrow for each.

**EMA crossover engine.** 20/50 (Golden/Death), 50/100 and 50/200, each showing state, a "✦ NEW"
flag, and how many bars ago it fired — with markers drawn **on the RSI pane** so you read momentum
and trend structure in one glance instead of two.

**The India-specific bit worth selling** (lines 191–192):

```pine
tradingMinsPerDay = 375.0  // Indian market: 9:15 AM to 3:30 PM
lookbackBars = math.round(emaLookbackDays * tradingMinsPerDay / tfMinutes)
```

The "was there a crossover in the last 21 days?" lookback is expressed in **calendar days and
converted to bars using the real NSE session length**. So "21 days" means 21 days on the 15-minute
chart and on the daily chart alike. Almost every competing script counts raw bars, which silently
means something different on every timeframe. *(Caveat: this hard-codes the Indian session, so the
lookback is wrong for US/crypto charts. Say so, or make it an input.)*

Plus regular bullish/bearish divergence on RSI 14, and 12 alert conditions.

### How they fit together — this is your pitch

They are not two indicators, they are **two halves of one workflow**:

> **SA-PRO decides *whether*. RS-PRO decides *when*.**
>
> Stage 2 + positive RS + accelerating momentum tells you the name deserves your capital.
> Multi-horizon RSI alignment + a fresh EMA cross tells you the entry is live now.

Sell them as a pair. Never as "two indicators".

---

## 2. Sales copy (landing page / WhatsApp / brochure)

### The one-liner

> **Two indicators that answer the only two questions that matter: is this name worth my capital,
> and is now the moment.**

### The bundle block (drop into the landing page)

**🎁 Included free with the Trader's Toolkit — two invite-only TradingView indicators**

**📊 Stage Analysis PRO** — *Should I even be in this name?*
Weinstein stage (S1–S4) with a duration counter, relative strength vs NIFTY, momentum **and its
acceleration**, a four-condition pullback-entry check, and beta for position sizing — one compact
table, three density modes. **Every metric exports to TradingView's Pine Screener**, so you can scan
the whole market for "Stage 2 + strong RS + in the pullback zone" instead of flipping charts.

**📈 RS Multi-TF PRO** — *Is the move aligned, and where's the trigger?*
Five RSI horizons (14/22/55/122/254) on one chart — a single-pane read on swing, weekly and yearly
momentum at once, with an alert when all five align. Golden/Death and 50/100, 50/200 crossovers
show state, freshness and bars-since, with markers drawn straight onto the RSI pane. The lookback
is calibrated to the **real 375-minute NSE session**, so "last 21 days" means the same thing on
every timeframe.

*Both delivered as invite-only TradingView scripts — access granted to your TradingView username
after purchase. Educational and analytical tools; not investment advice.*

### Three angles that actually convert

1. **"Stop flipping 200 charts."** The Pine Screener export is the concrete, demonstrable benefit.
   Record a 30-second clip: open the Screener, filter Stage = 2 and Cheat Entry = 1, watch a
   500-name universe collapse to eight. That clip sells the bundle on its own.
2. **"Built for NSE, not ported to it."** NIFTY benchmark, 375-minute session maths, Indian market
   hours. Every US indicator quietly assumes a 390-minute session and an S&P benchmark.
3. **"It tells you when NOT to trade."** Stage 4, RS negative, Cheat Entry = No. Positioning a tool
   around *avoided* losses is both more honest and more credible than promising winners — and it
   keeps you well clear of SEBI's performance-claim line.

### Words to never use

No win rates. No accuracy percentages. No "guaranteed", "assured", "profit", "multibagger",
"sureshot". No backtested return figures. Nothing that reads as a recommendation to buy or sell.
See `MONETIZATION_PLAN.md` §5.

---

## 3. TradingView script descriptions (paste-ready)

TradingView requires invite-only descriptions to genuinely explain what the script does and how to
use it. Thin or promotional descriptions get moderated. **Do not** put prices, payment links or
"DM me to buy" in the description — put contact details in your **profile signature** instead, and
check the current House Rules before publishing, as they change.

### SA-PRO description

```
STAGE ANALYSIS PRO — a top-down qualification dashboard

Answers one question before you commit capital: does this name deserve a position right now?
Five independent reads in one compact table.

── WHAT IT SHOWS ──

STAGE (S1–S4) — Classifies the chart using price position relative to a moving average combined
with that average's slope:
  S1 Accumulation — basing, flat MA
  S2 Advancing    — above a rising MA
  S3 Distribution — topping, flat MA
  S4 Declining    — below a falling MA
Displays the transition (e.g. "S1 → S2"), flags it as (New) for a configurable number of bars, and
counts how long the current stage has lasted. A Conservative / Moderate / Aggressive setting adjusts
how much slope is required before a stage changes, so you can tune sensitivity to your holding period.

RELATIVE STRENGTH — Compares the instrument to a benchmark you choose (NSE:NIFTY, SPY, QQQ…),
measured against its own moving average with slope confirmation, so a stock that is merely falling
more slowly than the index is not reported as strong.

MOMENTUM — Rate of change, smoothed, plus its ACCELERATION. Distinguishes "price is rising" from
"price is rising faster", which are different things for a trend follower.

PULLBACK ENTRY CHECK — Reports Yes only when four conditions hold together: price is within a
configurable distance of the moving average, volume has contracted below its average, relative
strength is still holding above its own MA, and the chart is in Stage 1 or 2. Any one alone is
noise; together they describe a low-volatility pullback inside an established trend.

BETA — Rolling covariance against the benchmark, for position sizing. A high-beta name needs a
smaller position for the same rupee risk.

── HOW TO USE IT ──

TIMEFRAME MATTERS. Stage analysis is built on the 30-week moving average. Use a WEEKLY chart with
MA Period 30, or on a DAILY chart set MA Period to 150 (30 weeks × 5 sessions). Leaving it at 30 on
a daily chart produces a 30-day MA and stages will change far too often.

SET YOUR BENCHMARK. Indian equities: NSE:NIFTY. US: SPY or QQQ. Relative strength and beta are both
meaningless if the benchmark does not match the instrument's market.

WORKFLOW. Qualify with Stage and RS first — Stage 2 with positive RS is where most trend continuation
lives. Then use the pullback check for timing and beta to size. Stage 4 with negative RS is the
signal to do nothing.

SCREENING. Stage, RS rating, RS %, momentum rating, pullback flag, beta and stage-change are all
exported to the Data Window, which makes them available in the Pine Screener. You can scan a whole
universe for a stage/RS/pullback combination rather than reviewing charts individually.

── DISPLAY & ALERTS ──

Three density modes (Minimal / Normal / Expanded), four table positions, and full colour, text-size
and threshold control for every metric. Alerts for stage change, RS crossing its MA in either
direction, momentum strengthening or weakening, pullback-entry appearing, and beta threshold crosses.

── NOTES & LIMITATIONS ──

Values update on the live bar and settle at bar close; assess signals on closed bars. Stage
classification is a trend-state description, not a forecast. Beta and RS depend entirely on the
benchmark you select. This tool describes what price has already done — it does not predict what
it will do next.

For educational and informational purposes only. Not investment advice and not a recommendation to
buy or sell any security. Past performance does not guarantee future results. Trading carries risk
of loss.
```

### RS-PRO description

```
RS MULTI-TF PRO — multi-horizon RSI with an EMA crossover engine

Two tools in one pane: momentum alignment across five horizons, and the trend-structure crossovers
that usually trigger entries.

── MULTI-HORIZON RSI ──

Plots RSI at 14, 22, 55, 122 and 254 simultaneously. These are not five variations of one setting —
each length approximates a different horizon on a single chart. On a daily chart, 14 reads the swing
move, 55 approximates the weekly picture and 254 approximates the yearly. Reading them together
shows whether a move is a short-term bounce or is supported across horizons, without switching
timeframes.

A dashboard reports each length's value, its zone (Overbought / Bullish / Neutral / Oversold) and a
per-bar direction arrow. Each RSI can carry its own optional smoothing MA (SMA / EMA / SMMA / WMA)
with an independent length.

── EMA CROSSOVER ENGINE ──

Tracks three crossover pairs — 20/50 (Golden / Death Cross), 50/100 and 50/200 — and for each one
reports the current state (bullish or bearish), whether the cross is recent, and how many bars ago
it occurred. Markers are drawn on the RSI pane itself, so momentum and trend structure are read in
one place.

The "is this cross recent?" lookback is specified in CALENDAR DAYS and converted to bars using the
actual session length, so a 21-day lookback covers the same real period on a 15-minute chart as on
a daily chart. Note that the session length is calibrated to the Indian market (375 minutes); on
markets with a different session the day-to-bar conversion will be approximate.

── DIVERGENCE ──

Optional regular bullish and bearish divergence detection on RSI 14, using pivot highs and lows.
Divergence is confirmed several bars after the pivot forms — that is inherent to pivot detection,
not a defect — so treat it as confirmation rather than a real-time trigger.

── HOW TO USE IT ──

ALIGNMENT FIRST. All five RSI lengths above 50 describes broad momentum support; all five below 50
describes broad weakness. There are alerts for both. Mixed readings — short-term RSI high while the
longer lengths sit below 50 — typically describe a counter-trend bounce.

THEN THE TRIGGER. Use the crossover table for structure. A fresh 50/200 cross is a slower, more
significant event than a 20/50 cross; the bars-since column tells you how mature the move already is.

CUSTOMISE THE CLUTTER. Each RSI line toggles independently and both tables have Full and Compact
layouts, so the pane can be as dense or as spare as you want.

── ALERTS ──

Twelve conditions: all-bullish and all-bearish RSI alignment, RSI 14 overbought and oversold, all
six EMA crossover directions, and bullish/bearish divergence.

── NOTES & LIMITATIONS ──

RSI and EMA crossovers are lagging, descriptive measures — they characterise momentum and trend that
has already occurred. Crossover markers appear on the live bar and can change until that bar closes;
judge them on closed bars. No single reading here constitutes an entry or exit decision.

For educational and informational purposes only. Not investment advice and not a recommendation to
buy or sell any security. Past performance does not guarantee future results. Trading carries risk
of loss.
```

### Description checklist

- [ ] Explains **what it computes** and **how to use it** — not just a feature list
- [ ] States **limitations** honestly (lag, bar-close settling, divergence confirmation delay)
- [ ] **No** prices, payment links, "DM to buy", or external URLs
- [ ] **No** win rates, accuracy claims, or return figures
- [ ] Disclaimer present
- [ ] Does not reveal the exact formulas or thresholds you consider proprietary
- [ ] A clean chart snapshot attached — one instrument, indicator clearly visible, no clutter,
      no other vendors' scripts on the chart

---

## 4. Hiding the source code — step by step

TradingView gives you exactly one mechanism for hidden source with controlled access:
**invite-only publication**.

| Mode | Source visible | Who can use it | Right for you? |
|---|---|---|---|
| Open-source | Full code | Everyone | No |
| Protected | Hidden | Everyone, free | No — no access control |
| **Invite-only** | **Hidden** | **Only usernames you approve** | **Yes** |
| Unpublished (saved in Pine Editor) | Only you | Only you | Fine for drafts |

### Before you publish

1. Resolve **§0.1** (the copyright header). Do not publish borrowed MPL code with hidden source.
2. Fix the benchmark default (**§0.2**) and add the timeframe guidance (**§0.3**).
3. Confirm your TradingView plan supports invite-only publishing — it requires a **paid plan**, and
   TradingView applies additional author requirements that change over time. Check the current
   House Rules and the Invite-Only Scripts help page before you start.
4. Rename both scripts to a consistent family, e.g. **"Vyuha Stage Analysis PRO"** and
   **"Vyuha RS Multi-TF PRO"**, so the bundle feels like one product. Edit the `indicator()` title
   on line 1 — that title is what buyers see.
5. Set up a clean snapshot chart: one liquid NSE name, the indicator visible, nothing else on the
   chart.

### Publishing (repeat for each script)

1. Open the script in the **Pine Editor**.
2. Confirm it compiles with no errors or warnings.
3. Click **Publish script** (top-right of the editor).
4. In the dialog:
   - **Title** — the buyer-facing name.
   - **Description** — paste from §3 above.
   - **Category / tags** — e.g. Trend Analysis, Momentum.
   - **Visibility → Invite-only.**
5. Publish. The source is now compiled and hidden; nobody can view the code or add the script to a
   chart until you grant access.

### Granting and revoking access

1. Go to the published script's page → **Manage access**.
2. Enter the buyer's **TradingView username** → Add. Access lands within a minute.
3. Refund or lapse → return and **Remove** the username.

**Access is granted by TradingView username, not email.** Your order flow must collect it — add
"Your TradingView username" to the WhatsApp order template alongside the email address, or you will
spend every sale chasing it in a second message.

### What invite-only does and does not protect

**Does:** hides your Pine source completely. Nobody — including people with access — can read the
code. Controls exactly who can put it on a chart.

**Does not:** stop someone inferring the logic from behaviour. Stage analysis, RSI and EMA crossovers
are all publicly documented techniques; a determined person can approximate your thresholds by
watching outputs. Your moat is the **integration and the workflow**, not the formulas.

To make inference harder without hurting usability: keep genuinely proprietary constants hard-coded
rather than exposed as inputs, expose only cosmetic and sensitivity settings, and don't publish exact
thresholds in the description.

### Complimentary-with-purchase: the fulfilment SOP

Since these ship free with the Toolkit rather than being sold separately on TradingView:

1. Buyer messages on WhatsApp → you send payment details **and ask for their TradingView username**.
2. Payment confirmed → email the ZIP + licence key (`license-issue.mjs`).
3. Add their TradingView username to **both** scripts' Manage-access pages.
4. Record the username in your ledger note so a refund is a clean reversal:
   ```bash
   VYUHA_LICENSE_NOTE="tv:their_username" node scripts/license-issue.mjs buyer@email.com toolkit
   ```
5. Refund → revoke the licence key **and** remove the TradingView access. Both, or you have given
   away half the bundle.

Step 4 matters: without the username in the ledger you cannot reverse step 3 later.
