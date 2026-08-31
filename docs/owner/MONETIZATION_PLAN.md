# Vyuha — Monetization Plan (Trader's Toolkit)

**Model chosen:** one-time **Trader's Toolkit bundle** — the Vyuha desktop app (lifetime
license) + both TradingView indicators (invite-only). Indicators also sold standalone.
**Checkout:** Razorpay (UPI/cards) + your own landing page. **Delivery:** automated email
with license key + download link; indicator access granted via TradingView invite-only.

This document is the strategic spine. The other files in `docs/owner/` and
`docs/prompts/` are the concrete deliverables it refers to.

---

## 0. What you are actually selling, as of v2.99.100

> Since v2.99.75 the pitch gained an appearance layer (nine skins incl. Custom, tint intensity,
> panel styles, wallpaper — v2.99.96/97), the Qty/Invested/Entry/Exit trades table, and an
> in-app WhatsApp buy dialog (+91 73936 73714, copy buttons) because the shell opens no external
> links. The v2.99.75 note below still describes the core selling story.
>
> - **v2.99.99 — the unattended broker connection actually works.** Angel One's live API
>   pull had been refusing for every user since v2.99.80 while six of our own surfaces sold it as
>   working; it is fixed and confirmed against the live broker. Worth knowing how to use in the
>   pitch: the honest version ("we found it, we said so in the changelog, we shipped the fix")
>   is a trust asset, and it is the difference between this product and the ones it competes with.
>   Do not lead with it cold — it lands as a reply when someone asks why they should trust an
>   independent developer.
>
> - **v2.99.98 — a tradebook now imports as the trades you actually made.** Zerodha and Paytm
>   Money tradebooks are paired per scrip and day and reconciled against the broker's own
>   realised-P&L statement (47 of 52 scrips within ₹25). This is the strongest single claim in
>   the pitch today: not "we read your file", but "we rebuild your round trips and check them
>   against your broker's own number."

> ### v2.99.75 marketing note — trust features are conversion features
>
> Four things shipped that map straight onto the objections that kill sales:
>
> **"Does it work with MY broker?" now answers six, and the Paytm story got
> BETTER, not weaker.** v2.99.30 sold the refusal — "Paytm publishes no
> format, so we ask instead of guessing." A real Paytm export has since pinned
> the layout, and the parser shipped. The line to sell is the full arc:
> *"we refused to guess at your broker's file for a year — then we got a real
> export, verified every column, and built it properly. That is how every
> format here earned its place."* Same for Angel One's tax P&L (the only
> export that states MTF directly) and Groww's order history. Kotak Neo and
> Sahi remain ask-first, which keeps the refusal story true.
>
> **"What if I delete something?" is now a feature, not a fear.** Every delete
> snapshots first and restores from Backup & Restore → Deleted items. Demo
> line that lands: *delete an entire import file, then put it back, in under
> ten seconds.* No rival journal shows deletion this reversible.
>
> **The price is finally IN the product.** The trial-expired panel, the
> licence card and a new /pricing page all quote real numbers with an "as of"
> date, and the WhatsApp message embeds the quoted price — so a stale build
> can never silently misquote you. The funnel's biggest leak (prospects who
> would not DM just to learn a price) is closed.
>
> **Lenses is the new demo opener.** "Here is the same book by month… by
> broker… by the exact file you imported" is a 15-second wow that also shows
> the free/Pro line honestly on screen: grouping free, edge locked with a
> visible Pro chip — the paywall itself becomes a product tour.
>
> Screenshots to retake: the Lenses tab strip (both licensed and with lock
> chips visible), the Deleted-items panel mid-restore, and the pricing page.

## 0.1 Earlier release notes (v2.99.70 and before)

> ### v2.99.70 marketing note — seven skins is a personalisation pitch, not a colour pitch
>
> Three new accent skins (Royal, Sapphire, Aurora) take the picker from four
> swatches to seven, in dark and light each. Sell it as **"make it yours"**:
> traders sit in this app for hours a day, and the luxe-personalisation angle
> ("seven coordinated palettes, each contrast-measured, P&L colours never
> touched") differentiates against the SaaS journals' single theme. The
> Settings → Appearance picker with all seven swatches is a NEW screenshot
> worth adding to the gallery; a 3-up of the same dashboard in Royal /
> Sapphire / Aurora makes a strong social/listing tile. The tooltip + palette
> + count-up polish is felt in demos (the app responds like a native tool) but
> needs no separate marketing line.
>
> **Code-signing decision (2026-08-11):** paid signing is deferred — the
> branded wizard closed the installer-fear objection well enough. The ₹0
> playbook is in docs/owner/CODE_SIGNING.md: list the app on winget (bypasses
> the SmartScreen browser flow entirely and reads as legitimacy), submit each
> release's installer to Microsoft's reputation portal on release day, and
> keep the "More info → Run anyway" copy in the client guide. The Azure
> wiring stays dormant; the earlier "budget ~$10/month before paid traffic"
> note below is superseded by this decision.

> ### v2.99.60 marketing note — the screenshots are the release
>
> Three releases (.50/.55/.60) shipped no new feature and every one of them
> sells: the app now handles a 10,000-trade book (a real objection from F&O
> intraday prospects — "will it choke on my history?" now has a measured
> no), and every report screen finally looks like the trades screen. The
> LISTING SCREENSHOTS ARE STALE: retake the tax pack, discipline, edge and
> surveillance shots — the header-band tables are the single biggest visual
> upgrade since the Dark Luxe foundation. The first-run screen is also new
> and worth showing in the onboarding section of the deck: "Nothing
> journalled yet — Import a broker file" is the product teaching itself.



> ### v2.99.40 marketing note — the trial's first five minutes got safer
>
> Three of this release's features exist to survive the evaluation window,
> where every sale is actually decided:
>
> **The installer no longer looks like malware.** The #1 pre-purchase
> objection for a solo-shipped Windows app is fear at the Setup screen. The
> wizard now carries the mark end to end — icon, banner, sidebar — instead of
> the stock NSIS globe. This is not cosmetics; it is conversion. (The
> remaining half of that fear is SmartScreen's "Unknown publisher" — budget
> for code signing, ~$10/month via Azure Trusted Signing, before any paid
> traffic is sent at the download link.)
>
> **Surveillance imports NSE's own files.** Demo line that lands: *"download
> the exchange's ban list and the app reads the trade date out of the file."*
> One REG_IND upload covers ASM, GSM and ESM for every listed scrip — a
> daily-habit feature, and daily habits renew licences.
>
> **The calculator remembers both books separately.** Small on paper, felt
> every session by exactly the two-book traders the F&O packaging targets —
> and the index picker quietly proves the data is CURRENT (January-2026 lots,
> sourced and labelled), which is the trust the whole tax pack trades on.
>
> Screenshot note: the Settings skin picker (four swatches) and the installer
> wizard are NEW surfaces worth adding to the listing gallery; existing
> screenshots remain valid.


> ### v2.99.30 marketing note — the objection that used to end the call
>
> **"Does it work with MY broker?"** kills more Indian journal sales than price
> does, and until this release the honest answer was "five of them". It is now
> "yours, whichever it is" — five auto-detect, and any other broker's CSV/XLSX
> imports by matching its columns once, remembered thereafter.
>
> Sell the REFUSAL, not just the coverage. Kotak Neo, Paytm Money and Sahi
> publish no column specification anywhere — not on their own help pages, and
> not in the third-party journals that support them, which ask users to email a
> sample file. A rival therefore either guesses at the headers (and imports
> quantity into the price column without telling anyone) or rejects the file.
> Vyuha asks, once. That is the same honesty argument the whole product rests
> on, applied to the first five minutes of the trial.
>
> Sales-page bullet, ready to paste: *"Works with your broker. Not five
> brokers — yours."*
>
> **The face changed too.** Three arcs carrying the interface's own three
> meanings, around the व, with a ₹ coin. Retake every listing screenshot and the
> landing-page hero after this release; the old squircle is now wrong everywhere
> it appears. And tables finally read like tables — company names in a text
> face, numbers still monospaced and aligned — which matters for screenshots
> more than any feature bullet.

> ### v2.99.20 marketing note — the paid line finally matches the pitch
>
> **The commercial change of this release is the packaging, not a feature.**
> Pro went from 6 gated screens to 17, and the boundary now reads the way the
> sales copy always described it: *the record of what you did is free; the
> intelligence about it is paid.* See "Packaging as shipped (v2.99.20)" below —
> quote that table, not the v2.97 one.
>
> **Demo 3 — "it shows the rate it is actually using."** Add an MTF trade and
> the split names the resolved percentage, the stock, and which broker's list
> it came from — and says so out loud when the stock is missing from that list.
> Until this release the form showed a flat 25% on every equity trade, which
> made testers think the engine assumed 25%. It never did. Worth demoing
> precisely because the fix is *legibility*: a number you cannot source is a
> number a serious trader will not trust.
>
> **Demo 4 — "this app is only the half you trade."** Settings → Workspace:
> pick Equity or F&O and the other book's screens leave the sidebar and the
> command palette. Sales value is objection-handling — the "too complex for me,
> I only do delivery" objection dies in five seconds, live. Say the honest part
> too: nothing is deleted, hidden screens still open from a link, and totals
> keep counting both books.
>
> Softer beats worth a line each: chart screenshots are now visible on the
> trade row (a paperclip with a count) instead of hidden behind a save; the P&L
> calendar drills into any single day and shows green/red streaks counted in
> *traded* days.

> ### v2.99.9 marketing note — two demos no competitor can copy quickly
>
> **Demo 1 — "your broker's real MTF list, inside your journal."** Add an MTF
> trade: the capital/funded split fills at that stock's ACTUAL margin from
> the broker's own list (10,501 per-stock margins, all seven brokers, as-of
> dated). No other Indian journal has this data in-product.
>
> **Demo 2 — "which broker funds YOUR stocks cheapest."** Broker Costs prices
> the trader's own symbols across all seven MTF lists and highlights the
> cheapest — plus the honesty hooks that make screenshots shareable: Kotak
> "approves 1,680, funds 1,178"; Sahi "no MTF delivery". The refresh toolkit
> keeps the data current monthly, which turns into a retention story: the
> journal that stays correct.
>
> Sales-page bullet, ready to paste: *"The only journal that knows every
> broker's MTF list — and tells you which one funds your stocks cheapest."*

> ### v2.99.5 marketing note — the product finally has a face
>
> The व mark (Devanagari va under an edge-to-edge shirorekha, the headline
> stroke doubling as a price level) replaces the placeholder icon everywhere:
> installer, taskbar/dock, favicon, share card. The share card matters most
> commercially — it is the one asset users post publicly, and it now carries a
> real mark instead of a letter that rendered as a missing-font box on some
> machines. Screenshots in listings and the landing page should be retaken
> after this release. Also honest-craft copy fodder: every table separator,
> header band and the light theme's teal were re-measured against WCAG and
> fixed; "Compact/Comfortable" density is a Settings choice.

Keep this list current — it is the one place that answers "what does the buyer
get today", and it is where landing-page copy should be drawn from.

**The wedge, in one line:** every other journal tells an Indian trader their
P&L. Vyuha tells them what it *cost*, whether it was *repeatable*, and refuses
to flatter them.

> ### v2.99 launch story
>
> **"Now on your Mac. And it tells you the truth about itself."**
> Lead with the platform: macOS availability is the only announcement here that
> reaches people who could not buy before, so it goes first everywhere. The
> in-product story is trust-as-craft — a Help Desk that documents what each
> screen *refuses* to do, deletion that shows its work, an import that warns
> before double-counting, and settings that come back with one click. Demo
> beat: import a transaction report, then try to import the matching P&L export
> and let the room watch Vyuha catch the double-count that every spreadsheet
> and most journals silently absorb. Seasonal second beat: the ITR schedule
> export, sold hardest in the run-up to the filing deadline.
>
> ### v2.98 launch story
>
> **The record is safe, and it reaches your CA in the form they ask for.**
> Two beats. First, trust: restore no longer removes chart attachments and cannot leave a
> half-applied journal, backup encryption is materially stronger, and multi-account writes stop
> guessing which book they belong to. Second, the close: the ITR pack now emits **Schedule CG, BP
> and CFL in the return's own item codes**, and gets the STT treatment right per head — excluded
> from capital-gains deductions under S.48, allowed as a business expense against intraday and
> F&O. That last point is the demo: the Schedule CG balance is deliberately *higher* than the net
> P&L shown elsewhere in the app, and being able to explain why is what separates this from a
> spreadsheet. It is also **seasonal** — worth most in the run-up to the filing deadline.
>
> ### v2.97 launch story
>
> **Trust the data → plan the session → review the decision → improve the process.**
> The seven-upgrade release is one coherent outcome, not seven menu items: the backup protects
> the record, Data Quality tells the buyer whether it is analysis-ready, Sessions and Rule Packs
> structure the operating day, Scaling/Replay and the Options Journal deepen review, and Accounts
> let a serious trader keep every broker or entity separate without losing the consolidated view.

### Sellable capabilities

| Capability | Why a trader pays for it |
|---|---|
| **Exact Indian cost engine** | STT, exchange, SEBI, stamp, IPFT, GST, DP, pledge — per broker × segment × exchange, integer paise, statutory rounding. Reconciles to **0.69% of the broker's own statutory charges** on a real 92-row report, brokerage excluded because it is not derivable. |
| **MTF done properly** | Interest on the funded portion only, correct T+1 day count, broker-specific own-margin %. The **ledger import reads the interest actually charged**, and shows it against Vyuha's estimate. |
| **Arjun's Eye** (Pro) | Session and weekday edge, winners-vs-losers hold time, post-loss tilt, expectancy by size quartile — with a 15-trade honesty gate. Nothing else in the Indian market does this. |
| **Return on Margin** (Pro) | P&L against **capital actually blocked**, instrument-aware. Turnover-based returns are close to meaningless for F&O. |
| **Product inference from charges** | Delivery vs intraday read from stamp duty (0.015% vs 0.003%) corroborated by STT — from a file with no product column. |
| **Dhan API** | `productType: MTF` stated by the broker. The one fact no Dhan file carries. |
| **IPO-allotment handling** | A sale with no purchase is quarantined from win rate rather than scored as a 100% winner, and its cost is recovered from the file's own footer. |
| **Staged positions** | Tranches with a stop each, FIFO exits, per-leg R — and the panel **never blocks an edit**. |
| **Status & outcome views** | Open / Closed / Staged, and in-gain / in-loss / profit / loss, each with a live count that reconciles. |
| **SEBI compliance radar** (Pro) | Post-2024 F&O rules, expiry-day ELM, intraday index limits. |
| **Tax tooling** (Pro) | Grandfathering, dividend TDS, set-off, ITR pack with 44AB/44AD read. |
| **Complete encrypted recovery** | A full database + screenshot backup, optional AES-256-GCM password protection, and a restore preview turn “local-only” from a risk into a trust feature. |
| **Runs on a Mac** | Native builds for Apple silicon and Intel, alongside Windows. This is not a feature, it is a **market**: every Mac-owning trader who bounced off "Windows only" is now reachable. Same one-file data, same licence. |
| **Seller depth** (Pro) | Expectancy by DTE band, hedged-vs-unhedged as an honest gap, roll chains judged against the first leg alone, IV rank within the user's own history, premium per day of risk. India's dominant retail cohort, spoken to directly. |
| **ITR schedule export** (Pro) | Schedule CG/BP/CFL in the return's own item codes, with the S.48 STT asymmetry applied per head. The demo line: "the CG balance is HIGHER than our own net P&L — and here is why that is correct." |
| **A journal that cleans up honestly** | Bulk delete with an exact preview, import removal with the cascade question asked, cross-source overlap warnings, dismissible advisories that return when the facts change, and one-click restore of default settings. Deletion is where journals silently corrupt; Vyuha audits every removal with the full before-snapshot. |
| **Help Desk** | Every screen self-described in-app — including what it refuses to do. Cuts the "what does this button mean" support load to near zero, which is what makes a one-person vendor sustainable. |
| **Data Quality Center** | Makes analytical confidence visible before the user acts on a report; every issue links to the screen that fixes it. |
| **Session planner/review** | Converts Vyuha from an after-the-fact journal into a daily pre-market → execution → review loop. |
| **Sourced rule packs** | Dates every SEBI/broker assumption, shows the source, and schedules review—material proof that “India-specific” is maintained, not marketing copy. |
| **Scaling Quality + Replay** | Answers whether adding actually helped, while labelling the counterfactual honestly and showing fills over local EOD history. |
| **Options Seller Journal** | IV, DTE, hedge, expiry outcome, and adjustment-family evidence create a seller-specific review product instead of a generic notes field. |
| **Multi-account books** | Separate brokers/entities and consolidated analysis make the app credible for advanced retail traders, families, and small desks. |
| **Imports from ANY broker** | Five auto-detect; every other broker imports by matching its columns once, remembered thereafter. The honest framing IS the selling point: Kotak Neo, Paytm Money and Sahi publish no column spec anywhere, so a rival either guesses (and mis-imports silently) or refuses the file. Vyuha asks, once. |
| **Workspace mode** | Equity-only and F&O-only traders each see one app instead of two half-relevant ones. Kills the "too complex, I only trade delivery" objection without shipping a cut-down build — and reverses in one click, so it is never a trap. |
| **Chart screenshots on the row** | The setup you saw is attached to the trade you took, and the trade list shows which trades have one. Review without this is recall, not evidence. |
| **Live open-position tracking** (Pro) | SL/TSL/target and running risk on positions still on. This is the daily-use hook: closed-trade journaling is a weekly habit, watching an open book is a *daily* one. |

### The honesty positioning — this IS the differentiator

Say it out loud in the sales copy, because it is what a serious trader tests
you on within ten minutes:

- Expectancy warns when the sample is too small to trust.
- An unmarked open position appears in neither gain nor loss, and says why.
- An unpriced IPO sale is excluded from win rate, and says why.
- Undated trades are named on the Performance page rather than quietly dropped.
- Findings are descriptive, never "you should".

### Trust signals worth quoting

- **1,242 unit/integration tests across 91 files, 20 end-to-end flows**, including
  real broker-report paths. (Keep this figure honest — run `npm run verify` before
  quoting it; a stale number is the easiest thing for a sceptic to catch.)
- **Signed auto-update** (since v2.91.0) with a build that refuses to ship
  unsigned or machine-dependent.
- **Zero telemetry, zero cloud** — verifiable, since the app runs offline.

---

## 1. Why this is sellable (the wedge)

Vyuha is not "a journal" — it's a **local-first, India-specific trading back-office**. Two
things competitors can't easily copy:

1. **Privacy / local-first** — trades never leave the user's machine (offline SQLite, no
   server). In India, where retail is wary of broker/data leaks, this is a headline, not a
   footnote. Lead every asset with it.
2. **Tax depth** — dual-regime capital gains + F&O business income + set-off/carry-forward +
   dividend TDS + advance-tax + harvesting. This is the recurring annual pain nothing on the
   retail market does well. Peaks **Jan–Jul** each year (advance-tax + filing season).

3. **Daily operating loop (v2.97)** — plan before the open, review against explicit limits after
   the close, and fix data-quality gaps before believing a report. This increases weekly habit
   frequency, which matters more to retention than adding another static report.

4. **Staged positions (v2.85)** — scale in across tranches with a stop on each, scale out in
   parts, per-leg R. Every competitor models a trade as one entry and one exit; professionals
   do not trade that way. This is the clearest "they actually trade" signal in the product and
   the easiest thing to demo in 30 seconds.

Supporting depth: F&O + Greeks, India VIX IV fallback, corporate actions, physical-settlement
traps, peak-margin leak, broker-cost comparison, SEBI reality-check, SEBI compliance radar,
six-broker import (incl. Angel One ≈15% of India's active accounts), clickable KPI drill-downs,
25-setup preset playbook library.

## 2. The offer & pricing (₹, India retail)

> **⚠ These ranges are HISTORICAL STRATEGY, superseded 2026-08-12 by an owner
> reprice and again 2026-08-15 by the launch offer.** Shipped prices live in
> **`lib/domain/pricing.ts`** (single source of truth).
>
> **Current (2026-08-15, owner decision):** list prices are **₹13,000/yr**
> (Pro — Annual) and **₹35,999** (Journal — Lifetime) — the owner has committed
> to charging these from **2027-01-01**, which is what makes the strike-through
> honest. Until then the launch offer sells at **₹7,999/yr (38% off)** and
> **₹29,999 (16% off, featured/best-value — the owner sells lifetime first)**.
> The offer end date is deliberately NOT shown in-app (owner's call); it lives
> here and in `docs/DECISIONS.md`. The percentages are DERIVED via `offerPct()`
> and FLOORED (16.67% shows as 16, never 17 — a discount claim never
> overstates) — the requested "30%/20%" labels did not survive division and
> were corrected.
> Two SKUs only — the Toolkit/indicators bundle came off every pricing surface;
> indicators remain a WhatsApp conversation. `tests/pricing.test.ts` pins the
> module to the landing page, so changing a price means editing BOTH in one
> commit — which is the point. "Fixing" the code to match the ranges below
> will fail CI.

| SKU | What | Price (launch) | Price (list) | Tooling |
|---|---|---|---|---|
| ~~**Trader's Toolkit** (hero)~~ RETIRED v2.99.76 | App lifetime + both indicators (invite-only) | ~~₹4,999–7,999~~ | ~~₹9,999~~ | *legacy — do not issue; sku `toolkit` still verifies for keys already sold* |
| App only | Lifetime license | ₹1,499–2,999 | — | `license-issue.mjs <email> app` |
| Indicators only | Both, invite-only lifetime | ₹6,000–12,000 | — | TradingView invite-only |
| App annual — **✅ BUILT (v2.80)** | Recurring option; expiry is inside the signed key | ₹499–799/yr | — | `license-issue.mjs <email> app --years 1` |

Launch tactic: cap the launch price to the **first 100 buyers** ("founding traders"), collect
testimonials + Google reviews, then step to list price. Anchor the bundle against the sum of
standalone prices so it visibly saves money. Annual keys expire gracefully in-app (renewal
notice + grace trial → free) — safe to sell without support overhead.

### Packaging as shipped (v2.99.20) — quote THIS table

Pro went from 6 gated screens to 17. The boundary is now a single sentence you
can say on a call: **your record is free, the intelligence about it is paid.**

| Free forever | Pro |
|---|---|
| Recording **closed** trades, editing, deleting, tagging | **Live open-position tracking** — SL/TSL/target, running risk |
| All six broker importers, cross-source overlap warnings | Arjun's Eye, Edge/Setups, Discipline, Scaling & Replay |
| Dashboard, P&L calendar with day drill-down and streaks | Portfolio Risk cockpit (VaR, Greeks, margin, breach alerts) |
| Staged positions, playbooks, sessions, trade calculator | Options Seller Journal, Expiry Analytics, Return on Margin |
| Chart screenshots, attachments, symbol aliases | Tax Summary, ITR Pack, Advance Tax, Harvest, AIS Reconcile |
| Backup & restore, full CSV/JSON export, audit log | Broker-cost + cross-broker MTF comparison, Charges & MTF Leak |
| Workspace mode, sidebar layout, themes, accounts | PDF reports — monthly, and any selection of trades |

**The one line that must survive every rewrite:** *every trade you have already
recorded stays readable, editable and exportable without a key, forever.* This
is the answer to "what happens to my data if I don't buy", and it is the reason
the gate is defensible rather than hostile. Do not soften it into "your data is
safe" — buyers hear that from everyone.

**Why open-trade tracking is the right thing to move behind the gate:** it is
the only feature whose value is *daily*. Closed-trade journaling is a weekly
chore; watching a live book with stops and risk is a reason to open the app
every morning, which is exactly what a trial needs to demonstrate in 7 days.

### Packaging decision for v2.97 (superseded — kept for rationale)

| Keep free forever | Put in Pro | Why |
|---|---|---|
| Journal, imports, account switcher, basic backup/restore | Encrypted attachment-complete recovery | The buyer always owns and can export their record; paid recovery protects it professionally. |
| Data-quality issue list | Confidence history and advanced remediation trends (future) | Do not hide whether data is wrong; monetize longitudinal intelligence. |
| One active session plan | Session history, adherence trends, rule-pack history | The daily habit starts free; process analytics carry recurring value. |
| Basic option fields | Seller cohort analytics and adjustment-family comparisons | Capture is portable; comparative insight is the product. |
| Aggregate account totals | Cross-account allocation, exposure, and tax/entity reports | Serious multi-book analysis is a clear advanced-user boundary. |

**Recommended commercial test (NOT shipped — shipped prices are in
`lib/domain/pricing.ts`; adopt this by changing that file + the landing page
together):** keep the lifetime app SKU during the founding-trader phase, but
make **₹799/year** the visually recommended app-only offer and lifetime the **₹2,999 anchor**.
Measure activation→paid conversion, 30-day session-plan retention, and annual-plan share before
changing list prices. Do not claim conversion uplift until the funnel records it.

## 3. Funnel

```
Free lead magnet ──▶ WhatsApp + email list ──▶ Content (X / YouTube) ──▶ Toolkit bundle
   │                                                                         │
   └─ "Tax-summary-only" free build, OR a free web capital-gains calculator  └─ Razorpay checkout
```

- **Lead magnet #1 — the installer itself (✅ BUILT, v2.80):** every fresh install starts a
  **7-day full-Pro trial** — offline, no signup, no card. The download link IS the funnel now:
  "try everything free for a week, journal stays free forever" converts better than any gated
  PDF. The in-app trial strip and post-trial upsell panel carry the buy link (`BUY_URL` in
  `lib/license.ts` — point it at the Razorpay page at launch).
- **Lead magnet #2:** a **free web capital-gains / F&O-tax calculator** (a stripped page of the
  tax engine) — ranks for search, shareable, demonstrates the exact depth people pay for. Gate
  the full report behind an email/WhatsApp opt-in.
- **Show, don't tell:** `docs/client/GETTING_STARTED_DECK.html` is a 13-slide visual walkthrough
  (install → import → journal → playbook loop → activate). Print it to PDF for WhatsApp
  broadcasts; the same slides double as a YouTube-short storyboard.
- **List:** WhatsApp (via a Business number / broadcast) converts far better than email in India.
- **Content:** see `GROWTH_ENGINE_PLAN.md` (compliant — no mass-mention spam).
- **Checkout:** Razorpay Payment Page or Payment Link → webhook → auto-deliver license + download.

## 4. Licensing layer — ✅ BUILT (v1.16+, tiering v2.80, vendor control v2.86)

The offline license gate exists, including the full tier machinery. Status:

### 4.0 Where the keys live

| What | Where | Ships to buyers? | If you lose it |
|---|---|---|---|
| **Vendor PRIVATE key** — mints every key | `license-private.pem` at the repo root, gitignored via `*.pem` | **Never** | You can't issue any more keys. **Back this up privately today.** |
| **Vendor PUBLIC key** — verifies keys | Baked into `lib/license.ts` (`LICENSE_PUBLIC_KEY_PEM`) | Yes, in every installer | Nothing — it's public by design |
| **The buyer's key** | The buyer's own machine, `settings.license_key` in their local SQLite | n/a | They re-paste it from your email |
| **Your sales ledger** | `license-ledger.jsonl` at the repo root, gitignored | **Never** | You lose the record of who bought what |

**Leaking the private key is the only catastrophic failure** — anyone holding it can mint
unlimited valid keys and you cannot tell their keys from yours. Rotating it (re-running
`license-keygen.mjs`) invalidates every key you have already sold, so treat it as permanent.
Back up `license-private.pem` **and** `license-ledger.jsonl` together, encrypted, off this machine.

### 4.1 Every key is already per-buyer

A key is not a shared unlock code. Each one is an Ed25519 signature over
`{ email, sku, issued, expires? }` — so the buyer's email is *inside* the key, cannot be edited
without breaking the signature, and is displayed in-app as "Licensed to <email>". Two buyers of
the same SKU on the same day get completely different keys.

1. **Key issuance (vendor side)** — one command per sale:
   `node scripts/license-issue.mjs <buyer-email> app [--years 1 | --expires YYYY-MM-DD]` — sku `app` for both plans on sale; the EXPIRY is what separates Annual from Lifetime.
   → prints the `VYUHA-…` key to stdout (pipe it straight into the delivery email) and appends a
   row to **`license-ledger.jsonl`**. No expiry flag = lifetime; `--years 1` mints the **annual
   SKU** (expiry is inside the signed payload). *(Future: a Razorpay `payment.captured` webhook
   that runs this script.)*
2. **Your sales ledger — ✅ BUILT (v2.86)**: `node scripts/license-list.mjs` shows every key you
   have issued — buyer, SKU, issue date, expiry, status. Filter by email, or run
   `--expiring 30` to find annual keys due for renewal (that list *is* your renewal campaign).
   Without this you have no record at all that a key exists: keys are **signed, not registered**,
   so nothing else in the system can answer "did this person actually buy?".
3. **Key IDs — ✅ BUILT (v2.86)**: every key has a short derived ID (`A1B2-C3D4-E5`,
   `sha256(key)` truncated). It shows in the buyer's **Settings → License** and in your ledger,
   so support threads quote the ID instead of pasting the key — which is a credential.
4. **Machine-bound keys — ✅ BUILT (v2.86), opt-in per sale**: `--machine ABCD-EF12-3456` locks a
   key to one computer. Off by default. Binding needs the buyer's Machine ID first (they copy it
   from Settings → License), so it is a two-step delivery — which fits the email-a-ZIP model
   well. Full guidance on when it is worth the friction in `LICENSE_OPERATIONS.md` §6.
5. **Revocation — ✅ BUILT (v2.86), reaches live installs since v2.99.91**: two halves, and a
   refund or a leak deserves both.
   `node scripts/license-revoke.mjs <KEY-ID> "refunded"` adds the ID to `REVOKED_KEY_IDS` in
   `lib/license.ts` — permanent, but *build-time*, so it only bites once the user installs a build
   released after the revocation.
   `node scripts/revocation-publish.mjs --add <KEY-ID> --message "…"` signs and publishes a list
   the desktop shell downloads during its existing launch update check. That reaches an install
   within a launch or two: the user sees a countdown banner for the grace window (14 days by
   default), then the key stops. It is pull-only — the list comes down, nothing about the user goes
   up — and publishing a newer list without the ID un-revokes.
   **Read the limits honestly:** it fails open on a machine kept offline, and it does not survive
   someone patching the binary. It raises the cost of copying; it is not DRM.
2. **Offline validation in-app** — done. Signature verified against the public key baked into
   `lib/license.ts`; the stored key is re-verified on every read. Activation UI at
   **Settings → License**; shows "Licensed to <email>", expiry state, and trial countdown.
3. **Trial — ✅ BUILT (v2.80)**: every fresh install gets a **7-day full-Pro trial**, stamped
   offline on first open (`settings.trial_started_at`; the bundled template DB ships with it
   NULL so the clock starts at the user's first run, not the installer build). Expired annual
   keys fall back to any remaining trial days, then to free.
4. **Enforcement — ✅ BUILT (v2.80)**: every Pro screen sits behind `<ProGate>`
   (`components/system/pro-gate.tsx`), driven by the `PRO_FEATURES` registry in `lib/license.ts`
   (Portfolio Risk, Tax Summary, ITR Pack, Broker Costs). Currently **"banner" mode**: trial
   users see a countdown strip; unlicensed copies see an informational banner; nothing blocked.
   **✅ DONE (2026-07-22): `LICENSE_ENFORCEMENT` is `"block"` and `BUY_URL` points at the live
   WhatsApp channel** — the upsell panel replaces Pro content after the trial, and since
   v2.99.75 it also shows the real prices with an as-of date. Product principle enforced in code: the core journal (trades, imports,
   dashboard, playbooks, backups) is NEVER gated — analytics are the product, the user's data
   is not. Anti-casual-sharing only, by design — the buyer email shown in-app is the real
   deterrent.
5. **Indicator access** — no build needed; TradingView invite-only handles access. See
   `PINE_SCRIPT_INVITE_ONLY.md`.

## 5. Legal / SEBI posture (read `PINE_SCRIPT_INVITE_ONLY.md` §Disclaimers too)

- Selling a **journal** (record-keeping tool) is clean.
- Selling **indicators that emit buy/sell signals** sits in SEBI's grey zone post the June-2024
  finfluencer crackdown / Research Analyst regulations. Stay on the safe side:
  - Position indicators as **educational/analytical tools, not advice.**
  - **No accuracy %, win-rate, or guaranteed-return claims** anywhere in marketing.
  - Prominent **"not investment advice / for educational purposes"** disclaimer on every asset
    (already embedded in the landing page and brochure).
  - If signals are the core pitch, get a **one-time opinion from a SEBI-aware professional.** This
    doc is not legal advice.

## 6. Deliverables index

| Ask | File |
|---|---|
| 1. Installation guide | `docs/client/INSTALLATION_GUIDE.md` |
| 2. Zerodha tradebook import prompt-doc | `docs/prompts/ZERODHA_TRADEBOOK_IMPORT.md` |
| 3. Hide Pine Script source (invite-only) | `docs/owner/PINE_SCRIPT_INVITE_ONLY.md` |
| 4a. Sales landing page | `docs/sales/landing-page.html` |
| 4b. One-page PDF brochure | `docs/sales/brochure.html` (Print → Save as PDF) |
| 5. Compliant growth / content-bot plan | `docs/owner/GROWTH_ENGINE_PLAN.md` |
| 6. **Getting-started slide deck (v2.80)** — install → import → journal → playbook loop → activate; visual-first, printable to PDF, doubles as demo-video storyboard | `docs/client/GETTING_STARTED_DECK.html` |
| 7. Public repo landing page with current screenshots | `README.md` |
| 8. **Vendor licence tooling (v2.86; sale flow automated 2026-08-23)** — one-command sale (`npm run sell`), renewals report (`npm run renewals`), issue / list / revoke / upgrade / encrypted key backup | `scripts/sell.mjs`, `scripts/renewals.mjs`, `scripts/license-{issue,list,revoke,upgrade,backup}.mjs` |
| 9. **Licence operations runbook (v2.86)** — sale → delivery → refund → renewal | `docs/owner/LICENSE_OPERATIONS.md` |
| 10. **Indicators launch kit** — analysis of both Pine scripts, sales copy, paste-ready TradingView descriptions, invite-only publishing steps | `docs/owner/INDICATORS_LAUNCH_KIT.md` |

## 7. Suggested launch sequence (2–4 weeks)

Everything technical is now BUILT — the sequence is pure go-to-market:

1. **Week 1** — publish the 2 indicators invite-only; stand up the Razorpay Payment Page;
   put up the landing page. **✅ The two launch-day code flips are DONE** (`BUY_URL` live,
   `LICENSE_ENFORCEMENT` = `"block"`, both shipped; v2.99.75 added in-app prices on top). The
   Razorpay Payment Page remains the open item — until it exists, the WhatsApp funnel is the
   checkout, and `lib/domain/pricing.ts` embeds the quoted price in each pre-filled message.
2. **Week 2** — publish a GitHub release so the auto-updater ships the gated build; announce
   the 7-day-trial framing everywhere ("try everything free, journal free forever").
3. **Week 3–4** — content engine on your own X/YouTube (record the getting-started deck as a
   2-minute walkthrough); founding-trader launch (first 100 @ launch price); collect
   testimonials; iterate copy from checkout drop-off. Consider the annual SKU
   (`--years 1`) as the downsell on exit-intent.
4. **Ongoing** — run `npm run renewals` monthly (exit 2 on a lapsed key, so a scheduled run can alert); that output is your
   renewal outreach list. Back up `license-private.pem` + `license-ledger.jsonl` after every
   batch of sales. Full procedures in `LICENSE_OPERATIONS.md`.

### What changed since this plan was last revised (v2.82 → v2.99.20)

Demo-able additions worth putting in the sales assets, newest first:

- **v2.99.20 — the app fits the trader.** Two demos, 20 seconds each. Settings →
  Workspace → "Equity only", and half the sidebar politely leaves. Then add an
  MTF trade and watch the split name the real percentage, the stock, and the
  broker list it came from. The first kills the complexity objection; the second
  is the credibility moment.

- **v2.97 — the trust-to-review loop.** Demo a red Data Quality issue becoming green, plan one
  session, show the post-market adherence review, then switch accounts. Close by exporting an
  encrypted full backup. This is the strongest 90-second product story in the current build.

- **v2.85 — Staged positions.** Scale in / scale out with a stop per tranche and per-leg R.
  The single best 30-second demo in the product; nothing else on the market does it.
- **v2.84 — Clickable KPI drill-downs** (16 cards) and a **browsable 25-setup playbook library**.
  Both are "wow" moments in a screen-share and cost nothing to show.
- **v2.82 — Angel One + Upstox import** (Angel One alone is ≈15% of India's active accounts —
  this widened the addressable market more than any other single change), **SEBI Compliance
  Radar**, and **shareable stat cards** (privacy-first: % of capital by default, watermarked
  "self-reported, not broker-verified").

**That decision is now made (v2.99.20).** The open question this section used to
carry — whether staged positions belong in free or Pro — resolved as **free**,
and the line was drawn elsewhere: staged positions, playbooks, sessions and the
KPI drill-downs are all part of *recording and reading your own book*, so they
stay free. What moved into Pro is **live open-position tracking**, because it is
the only one of these whose value recurs daily rather than per-trade.

The remaining launch-day code change is unchanged: `BUY_URL` and
`LICENSE_ENFORCEMENT` in `lib/license.ts`. Do not flip enforcement before the
payment page is live.
