# The two indicators — analysis, sales copy, and TradingView publishing

Companion to `PINE_SCRIPT_INVITE_ONLY.md` (mechanics) and `MONETIZATION_PLAN.md` (strategy).
This file is about **these two specific scripts**: what they actually do, what to fix before you
publish, what to write to sell them, and what to write on TradingView.

Scripts covered:
- **Stage Analysis Indicator-KTR** (`SA-PRO`) — overlay
- **RS Multi-TF PRO** (`RS-PRO`) — separate pane

---

## 0. Fix these before you publish

*Status 2026-07-22 — **all three resolved.** §0.1 and §0.2 by the owner, §0.3 in code as part of
SA-PRO v2.0.0. Two follow-ups remain, both described in §0.2: confirm the mid/smallcap index ticker
actually resolves in the symbol picker, and recalibrate the Beta thresholds now that the benchmark
is more volatile than NIFTY.* anything

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

### 0.2 ✅ RESOLVED — benchmark changed to NIFTY MIDSMALLCAP

The default was `SPY`, which meant an NSE chart was having its relative strength, RS rating,
Cheat-Entry `rsHolding` test **and Beta** all computed against the S&P 500. **Fixed by the owner on
2026-07-22**, now defaulting to the NIFTY MidSmallcap index.

**That is the better choice for this product's audience.** Indian retail momentum trading lives in
mid and smallcaps, and measuring a smallcap against NIFTY flatters it during smallcap-led rallies —
you get "strong RS" readings that are really just the segment moving. A midsmallcap benchmark asks
the sharper question: *is this name beating its own peer group?*

Two consequences worth knowing, neither a defect:

**1. Verify the symbol actually resolves.** If the ticker string does not match a real TradingView
symbol, `request.security()` returns `na`, `rsLine` falls to `0` and **RS silently reads
Neutral/Weak on every chart** — it will look like the indicator is broken rather than
misconfigured. Load it once and check the table's **"Bench:"** cell shows the index name you
expect, and that the RS % actually moves between different stocks. TradingView's NSE index tickers
are not obvious (`NIFTY_MIDSMLCAP400`, `CNXSMALLCAP` and similar all exist), so confirm the exact
string in the symbol picker rather than typing it from memory.

**2. Your Beta numbers will now read lower — recalibrate the thresholds.** Beta is
covariance ÷ benchmark variance. A midsmallcap index is considerably more volatile than NIFTY, so
the denominator grows and every beta shrinks. A stock that read ~1.2 against NIFTY may read ~0.8
against midsmallcap. The defaults are:

```pine
i_betaLowTh  = 0.8   // "Low"  below this
i_betaHighTh = 1.2   // "High" above this
```

Left unchanged, almost everything will now classify as "Low volatility", which is misleading — it
is measuring against a more volatile yardstick, not describing calmer stocks. Load a handful of
names you know well, see where the betas actually land, and move the thresholds to match. Mention
the benchmark explicitly in the description so buyers know what beta is relative to.

**Also worth adding to the tooltip:** for large-cap charts the user should switch to `NSE:NIFTY`.
The benchmark should match the instrument's peer group, whichever way round.

### 0.3 ✅ RESOLVED IN v2.0.0 — stage MA now auto-scales

Weinstein's method is built on the **30-week** MA. v1 defaulted to `30` periods on whatever timeframe
the chart happened to be, so on a **daily** chart it was a 30-*day* MA — a completely different
indicator that flips stages every few days and reads as broken.

v2.0.0 auto-scales instead:

| Chart | Stage MA |
|---|---|
| Weekly | 30 (Weinstein's original) |
| Daily | 150 (30 weeks x 5 sessions) |
| Monthly | 7 |
| Intraday | 150, **and the table prints `⚠ intraday — built for D/W`** |

Auto-scaling can be switched off (`Auto-scale MA to timeframe`) to set the period by hand. The
Expanded table shows which period is in force and whether it came from auto, so a user can always see
what is actually being measured.

## 0.5 Where the files live

| File | Path |
|---|---|
| **SA-PRO v2.0.0** (paste this into TradingView) | `K:\Thejesh\PERSONAL\IMPORTANT DOCUMENTS\STAGE-ANALYSIS-INDICATOR-KTR-v2.txt` |
| SA-PRO v1.0.0 (kept as a fallback) | `K:\Thejesh\PERSONAL\IMPORTANT DOCUMENTS\STAGE-ANALYSIS-INDICATOR-KTR.txt` |
| RS-PRO | `K:\Thejesh\PERSONAL\IMPORTANT DOCUMENTS\RS-PRO-KTR.txt` |
| This launch kit | `vyuha\docs\monetization\INDICATORS_LAUNCH_KIT.md` |

The Pine sources live **outside the repo**, in your personal documents folder — they are not tracked
by git and never leave your machine. The live script is whatever is saved in the TradingView Pine
Editor; these `.txt` files are your local copies, so keep them in step after any edit you make there.

## 1. What you actually have (the honest technical read)

### SA-PRO v2.0.0 — "should I be in this name at all?"

A **top-down qualification screen** in one table. Ten independent reads, every one toggleable.

| Metric | What it computes | Why a trader cares |
|---|---|---|
| **Stage** | Price vs MA + MA slope, bucketed into Weinstein's S1–S4, with a sensitivity setting and a "periods in stage" counter. **MA auto-scales to the timeframe** | Stops you buying Stage 4 falling knives and Stage 3 tops |
| **EMA ribbon** | 9/20/50 stack order, slope of all three, and price location relative to them | A clean stack with everything rising is a different chart from the same stack with price cutting back through it |
| **HTF EMAs** | The same ribbon one step up — intraday reads Daily, daily reads Weekly, weekly reads Monthly, chosen automatically | The timeframe above you, without switching charts |
| **RS** | Stock ÷ benchmark, vs its own MA, with slope confirmation — plus a guard that says so loudly if the benchmark fails to resolve | Weak-vs-peers names underperform on the way up and lead on the way down |
| **Momentum** | ROC, smoothed, **plus acceleration** | Distinguishes "rising" from "rising faster" — the Stage-2 sweet spot |
| **Cheat Entry** | Near the MA **and** volume dried up **and** RS holding **and** in Stage 1/2 | A Qullamaggie-style low-risk pullback, all four required |
| **ADR%** | Average daily range, always computed on **daily** bars | Realistic targets and stops — a 2% move in a 6% ADR name is noise |
| **RVOL** | This bar vs the average of the **previous** N bars | The institutional-participation proxy; pairs with the Cheat Entry volume test |
| **Liquidity sweep** | Wick beyond the last confirmed swing that closes back inside, with direction and age | Stops taken then rejected — the most actionable single SMC concept |
| **Beta** | Covariance/variance vs the benchmark | Position sizing — and it moves with the benchmark you pick |

**The genuinely differentiated part** is unchanged and now larger: every metric is exported to the
data window, which makes all of it usable in **TradingView's Pine Screener**. You can scan the whole
NSE universe for *"Stage 2, RS positive, EMA stack bullish, Cheat Entry = 1"* instead of flipping
charts one by one. Most indicators are decoration; this one is a screening engine. **Lead with this.**

Three display densities (Minimal / Normal / Expanded), eight table positions, 37 toggles, 37 colour
pickers, nine independent text-size controls, and 13 alert conditions.

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
Weinstein stage (S1–S4) with a duration counter and a moving average that **auto-scales to your
timeframe**; a 9/20/50 EMA ribbon reporting stack, slope and price location; the same ribbon one
timeframe **higher, chosen automatically**; relative strength against the peer index you choose;
momentum **and its acceleration**; a four-condition pullback-entry check; and three institutional
reads — **ADR%, RVOL and liquidity-sweep detection**. One table, three density modes, everything
toggleable. **Every metric exports to TradingView's Pine Screener**, so you can scan the whole market
for "Stage 2 + strong RS + bullish EMA stack + in the pullback zone" instead of flipping charts.

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

### SA-PRO description (v2.0.0)

```
STAGE ANALYSIS PRO — a top-down qualification dashboard

Answers one question before you commit capital: does this name deserve a position right now, and
is the trend structure behind it actually intact? Ten independent reads in one configurable table.

── TREND & STAGE ──

STAGE (S1-S4) — Classifies the chart from price position relative to a moving average combined with
that average's slope:
  S1 Accumulation - basing, flat MA
  S2 Advancing    - above a rising MA
  S3 Distribution - topping, flat MA
  S4 Declining    - below a falling MA
Shows the transition (e.g. "S1 -> S2"), flags it as (New) for a configurable number of bars, and
counts how long the current stage has lasted. Conservative / Moderate / Aggressive adjusts how much
slope is required before a stage changes, so you can tune it to your holding period.

The moving average AUTO-SCALES to your chart. Stage analysis is built on the 30-WEEK average, so the
indicator uses 30 periods on a weekly chart and 150 on a daily (30 weeks x 5 sessions). Without that,
a daily chart would be running a 30-DAY average and stages would change every few days. You can turn
auto-scaling off and set the period yourself.

EMA RIBBON (9/20/50, lengths configurable) — Reports three things that only mean something together:
  Stack    - are they ordered 9>20>50 (bullish), 9<20<50 (bearish), or tangled?
  Slope    - are all three rising, all falling, or mixed?
  Location - is price above all three, below all three, or inside the ribbon?
A clean stack with all three rising and price above them is a very different chart from the same
stack with price cutting back through it. Each line can be toggled, recoloured and re-weighted
independently, with optional shading between fast and slow that tints by stack direction.

HIGHER-TIMEFRAME EMAs — The same ribbon computed one meaningful step above your chart, chosen
automatically: intraday reads Daily, daily reads Weekly, weekly reads Monthly. You always have the
timeframe above you in view without switching charts. A manual override is available. Values use
confirmed higher-timeframe bars only, so they do not repaint. Lines are OFF by default to keep the
chart readable; the dashboard row is on.

── STRENGTH, MOMENTUM & RISK ──

RELATIVE STRENGTH — Compares the instrument to a benchmark you choose, measured against its own
moving average with slope confirmation, so a stock merely falling more slowly than the index is not
reported as strong. If the benchmark symbol does not resolve, the table says so explicitly rather
than quietly reporting neutral.

MOMENTUM — Rate of change, smoothed, plus its ACCELERATION. Distinguishes "price is rising" from
"price is rising faster", which are different things to a trend follower.

PULLBACK ENTRY CHECK — Reports Yes only when four conditions hold together: price within a
configurable distance of the moving average, volume contracted below its average, relative strength
still holding above its own MA, and the chart in Stage 1 or 2. Any one alone is noise; together they
describe a low-volatility pullback inside an established trend.

BETA — Rolling covariance against the benchmark, for position sizing.

── INSTITUTIONAL READS ──

ADR% — Average Daily Range as a percentage, computed on DAILY bars whatever timeframe you are
viewing, so it stays meaningful intraday. Sets realistic targets and stop distances: a 2% move in a
6% ADR name is noise, and the same move in a 2% ADR name is not.

RVOL — Relative Volume: this bar's volume against the average of the PREVIOUS N bars, excluding the
current one so a genuine surge is not diluted by itself. A participation proxy — see the limitations
note below on what this is and is not.

LIQUIDITY SWEEP — Detects a wick beyond the most recent confirmed swing high or low that CLOSES back
inside: stops taken, then rejected. Reports direction, how many bars ago, and whether it is still
fresh. Optional chart markers.

── HOW TO USE IT ──

SET YOUR BENCHMARK FIRST — IT CHANGES EVERYTHING DOWNSTREAM. Relative strength, the pullback check
and beta are all measured against whichever symbol you choose. The default is a mid/smallcap index,
because that is the peer group most Indian momentum trading happens in; measuring a smallcap against
a largecap index flatters it during a smallcap-led rally and reports strength that is really just the
segment moving. For largecap charts switch to a largecap index; for US instruments use SPY or QQQ.
Pick from the symbol picker rather than typing.

Note that BETA IS RELATIVE TO THAT BENCHMARK, not an absolute property of the stock. Against a more
volatile index the same stock reports a LOWER beta, so the Low/High thresholds need setting to suit
the benchmark you actually trade against.

TIMEFRAME. Stage analysis is a daily and weekly method. It works best on those; on intraday charts
the table says so plainly.

WORKFLOW. Qualify with Stage and RS — Stage 2 with positive RS is where most trend continuation
lives. Confirm the structure with the EMA ribbon and the higher-timeframe stack. Time the entry with
the pullback check or a fresh liquidity sweep. Size it with ADR% and beta. Stage 4 with negative RS
is the signal to do nothing.

SCREENING. Stage, RS rating, RS %, momentum, pullback flag, beta, EMA stack, higher-timeframe stack,
ADR%, RVOL and sweep state are all exported to the Data Window, which makes them available in the
Pine Screener. You can scan a whole universe for a combination rather than reviewing charts one at a
time.

── DISPLAY & CONTROL ──

Three density modes (Minimal / Normal / Expanded), eight table positions, and independent colour and
text-size control for every section. Table background, transparency, border width, header colours,
alternating row shading and the Details column are all configurable. Every metric, every line and
every alert can be switched off individually — the intent is that you keep what suits your style and
hide the rest.

Alerts: stage change, RS crossing its MA either way, momentum strengthening or weakening, pullback
entry appearing, EMA stack flipping bullish or bearish, liquidity sweeps in both directions, RVOL
surge, and beta threshold crosses.

── NOTES & LIMITATIONS ──

RVOL IS NOT ORDER FLOW. It is a volume-participation proxy. True footprint, bid-ask delta and
cumulative volume delta require tick or bid-ask data that is not available to Pine scripts, and any
script claiming otherwise on standard equity data is inferring, not measuring.

LIQUIDITY SWEEPS ARE CONFIRMATION, NOT A LIVE TRIGGER. A swing pivot is only known once the
configured number of bars has passed after it forms, so a sweep is necessarily reported after the
fact. That is inherent to pivot detection, not a defect.

Values update on the live bar and settle at bar close; assess signals on closed bars. Higher-timeframe
values use confirmed HTF bars only and do not repaint. Stage classification is a description of trend
state, not a forecast. RS and beta depend entirely on the benchmark you select. This tool describes
what price has already done — it does not predict what it will do next.

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
