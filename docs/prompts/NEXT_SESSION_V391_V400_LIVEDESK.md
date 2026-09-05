# NEXT SESSION PROMPT — v3.9.1 patch → v4.0 "Live Desk" (desktop) → Vyuha Web Platform

> **STATUS 2026-09-05:** research pack delivered at `T:/Thejesh/CLAUDE-CODE/VYUHA-LIVE-DESK-RESEARCH/`
> — see `00-INDEX.md` (map), `08-BUILD-PROMPTS/V391-BUILD-PROMPT.md`, `06-ANSWERS.md` (owner rulings),
> `09-BUILD-LEDGER.md` (done vs left). **v3.9.1 built** on `main`, uncommitted — not yet gated or tagged.

Written 2026-09-05 (Saturday) from the owner's dictated brief. Paste this whole file as the first
message of the next **VYUHA-TRADE JOURNAL** session (repo: `T:/Thejesh/CLAUDE-CODE/VYUHA-TRADE JOURNAL-V1`).
Owner's instruction to the session: **"Explore, Analyze, Orchestrate, and then code."**
Use **ULTRATHINK** for every research and analysis step. Do not miss a single point in this file.

---

## 0. Directives that CHANGE the standing rules (apply before anything else)

0.1 **CREDIT LIMITS ARE RESET — go full throttle.** Strike out and remove every credit-limit /
budget-governor rule from the working docs and from your own behaviour:
- `docs/prompts/NEXT_SESSION_V390_V400.md` § "Budget governor (non-negotiable)" — DELETE the
  section (no usage screenshots at gates, no "wave cannot start" rule, no governor trips).
- VYUHA-STATE.md and DECISIONS.md: mark the 2026-09-04 "finish v3.8 under 88–90% Fable" credit
  ruling as SUPERSEDED 2026-09-05 ("credit limits reset; full throttle").
- Model choice still follows `~/.claude/CLAUDE.md` (Opus for build/fix/docs agents, Fable for the
  orchestrator and adversarial finders) — that is an accuracy rule, not a budget rule. Nothing
  else about credits gates any wave.

0.2 **Strike "local / offline" positioning EVERYWHERE in the project.** Vyuha is no longer sold
as "100% local & offline" — it becomes **"Desktop or Web: the trader chooses"** (investor-agreed).
Do this as a tracked inventory, not ad-hoc edits:
- Grep the whole tree for `local-first`, `local & offline`, `offline-first`, `100% LOCAL`,
  `never sends a single trade`, `fully local`, `offline by design` — README.md hero (line 5),
  README § "Local-first by design" (~line 723) and its badges (lines 13–14), the brochure/landing
  copy under `docs/sales` (GitHub Pages — auto-deploys on push, see memory), the in-app sidebar /
  onboarding / settings copy, PRIVACY.md, VYUHA-STATE §1 (line 15) and §8.6 ("local-first stays
  the differentiator"), `docs/SESSION_PROMPT.md`, AGENTS.md, help-content in `lib/domain/`.
- Produce the inventory (file:line, current text, proposed text) as an artifact and get ONE
  batched owner approval, then apply. Positioning copy is removed; a line that states a
  **technical fact** (the Ed25519 licence gate verifies without a server, the 7-day trial needs
  no signup, the update check is optional) is rewritten neutrally, not deleted — the code still
  behaves that way and the copy must stay true.
- SEBI-safe wording survives (no outcome claims). The "exactly four kinds of egress" promise in
  PRIVACY.md is a desktop fact — decide with the owner whether it stays as a desktop-only
  statement (recommended) or is dropped; log the decision.
- Record the reversal in DECISIONS.md and rewrite VYUHA-STATE §8.6's last paragraph.

0.3 **Vision (from owner + investor deliberation):** VYUHA is to become **the one-stop solution
for a trader — from Trading to Journaling** — "not simply a trade journal, the platform every
trader needs". Two things are being built from here on: the **Desktop app (v3.9.1, then v4.0
Live Desk)** and the **Web platform** (a more advanced version with most Vyuha features plus AI,
option chain, candlestick pattern scanner, Trade Ideas and more). Users choose Desktop or Web.

0.4 The hooks/coord layer: a `coord:` deny is a fact; TRADE-SENTINAL and CHARTINK-PROJECT are
**read-only** for this session (ideas and data only, never write there). One `AskUserQuestion`
pop-up per task, recommended option first — everything else is decided, stated, and logged
(decision-log skill). "Ask many many questions" from the owner means a **Questions artifact**,
not pop-ups.

---

## 1. Roadmap — three steps, strictly in this order

### Step 1 — v3.9.1 patch release (analyze → plan → BUILD FIRST, this session)

The owner says the v3.9.1 plan was **updated in another session with a few added fixes**. Locate
it before planning:
- Known location: **VYUHA-STATE.md §8.0a "v3.9.1 candidates"** (commits `6abbc9a`, `83ca1ab`).
  No separate `docs/prompts/*V391*` file exists on `main` as of 2026-09-05 15:00. Check `git log
  --oneline -15`, `git status`, and the owner's Downloads / `T:/Thejesh/CLAUDE-CODE/` root for a
  newer plan. If none is found, the ONE pop-up of this task asks the owner to paste the added fixes.
- Items known so far (verify each against the code before planning):
  1. **Copy truth** — now subsumed by directive 0.2 (the whole strike-out ships in v3.9.1).
  2. **Import hardening** — `app/api/import/route.ts` has no file-size limit and no `maxDuration`;
     `lib/import/parse-guard.ts:44-52` runs `XLSX.read` on the full untrusted buffer as its
     readability check; `xlsx` resolves to 0.18.5 (CVE-2023-30533, fixed only on cdn.sheetjs.com).
     Decide SheetJS CDN build vs `exceljs`; add size limit, magic-byte check, `maxDuration`.
  3. **Licence activation** (`app/api/license/route.ts:24`) passes no machine id — binding is
     read-time only. Fix or document; a hosted entitlement design must know this.
  4. **Overlay entrance-keyframe fix** — ALREADY on `main` (`28d6655`); owner ruling: it rides in
     v3.9.1, never a release alone.
  5. **Carry-overs from the v3.9 prompt §6** — check which shipped in 3.9.0 and which are still
     open: `pair-legs.ts` spread → `for…of push`; `classification_overrides` re-key on Paytm
     re-import (0059 orphans); `dhan-pnl-fresh.csv` 0.8 score (owner ruled: pin, no rule change);
     Angel `partial` lock copy; palette "· all accounts" copy.
  6. **The owner's added fixes** (unknown to this prompt — obtain them).
- Ship through the full release skill: recon → wave plan → red-on-revert tests → `npm run verify`
  → adversarial diff-audit → desktop build + signing → CI 6/6 before tag → release run → deep
  verify → **client package ZIP rebuilt (every release, unasked)** → **WDSI details supplied
  unprompted** → owner publishes + off-build-machine install → VYUHA-STATE + DECISIONS updated →
  commit + push.

### Step 2 — v4.0 "Live Desk" for the VYUHA DESKTOP APP — **target: done by Sunday**

Owner deadline: "this should be done by Sunday". Today is Saturday 2026-09-05; confirm in the
Questions artifact whether that means **Sun 2026-09-06** or **Sun 2026-09-13**, and plan the waves
to the confirmed date. The full requirement set is §2 below; the research is §3; the deliverables
are §5. Live Desk gets its own recon, wave plan, one batched approval, red-on-revert tests, double
audit, release, client package, WDSI — same bar as every release.

### Step 3 — Vyuha Web Platform (only after v4.0 satisfies the owner)

Not built in this session, but **every Live Desk design decision must be web-portable**: no Tauri
IPC, no DPAPI-bound secrets in Live Desk paths, a feed/adapter boundary for quotes, tenancy-aware
queries. Existing research: `T:/Thejesh/CLAUDE-CODE/VYUHA-WEB-PLATFORM-RESEARCH/` (read
`00-INDEX.md` first, verify claims against `07-CROSS-CHECK.md`). **Its converged recommendation
("web = file-import only; broker pulls and Telegram desktop-only") now conflicts with the new
vision** (web is the MORE advanced product: AI features, option chain, candlestick-pattern
scanner, Trade Ideas, and more). Write the delta as an artifact (§5.8) — do not re-run that
research, extend it.

---

## 2. LIVE DESK — requirements (read meticulously; nothing here is optional)

**Bar:** Live Desk must be **the most interactive, intuitive and advanced tab yet in VYUHA.**
For each numbered requirement, deliver: feasibility (now / needs a data source / needs owner
input), the best build methods with evidence, your own added points, research behind those
points, cost and time, risks (SEBI wording, privacy copy, egress, licence of any library), and
how it fits the architecture (pure-lib layering, integer paise, the 10 invariants in AGENTS.md,
9 skins × light/dark theming, Tauri webview). Then we orchestrate and finalize the plan together.

### 2.1 Live Position Tracker — "with all important parameters" (owner: we iterate this until perfect)

Propose the parameter set and expect several iterations. Starting list to evaluate (extend it):
symbol / exchange / product (CNC, MTF, intraday, F&O), qty, avg entry, LTP + day change, unrealized
P&L ₹ and %, open R-multiple, risk ₹ at stop and % of capital at risk, distance to stop and to
target (₹, %, ATR units), portfolio heat (sum of open risk), exposure and concentration by sector /
industry / market-cap bucket (from `lib/data/sector-map.json`, `nse-index-map.json`, the v3.8
`getSectorResolution()` + confidence tiers), MTF margin / interest / break-even (from
`mtf-margins.json` and the existing Target Tracker), holding days and the holding-period clock,
ATR / volatility, RVOL, 52-week-high distance, relative strength vs Nifty and vs own sector cohort,
upcoming events (results date, corporate actions — `corporate-actions-apply.ts` exists), alerts.
Decide and document: quote source(s) and refresh cadence during market hours, behaviour outside
hours and offline (last close / opt-in EOD bhavcopy — the only cohort price source today), rate
limits, and what is stored vs streamed (PRIVACY copy must stay true). Existing seams to reuse:
`lib/risk/`, `lib/intelligence/`, `lib/jobs/`, `lib/analytics/mae-mfe.ts`, the Target Tracker
("position sizing, max-open monitor, monthly ladder, MTF break-even"), OpenAlgo (observer-only,
currently OFF and absent from buyer-facing docs), Telegram alerts.

### 2.2 Live position CHARTS with the user's trade drawn on the chart

- Overlay the user's **entry price** and **target price** on the chart of each open position.
- Show a **STOP-LOSS VALUE computed by "VYUHA intelligence"** from the **risk the user set in
  Settings**. If risk is not set, the UI must say so and route the user to the **interactive
  position-sizing calculator and the other risk metrics we will build** (§2.4).
- Show **trailing profit** and **trailing-profit suggestions** (and trailing stop-loss ideas).
- Charting engine: `lightweight-charts` is ALREADY a dependency (verify where it is used) and
  `recharts` powers ~626 charts with zero SSR HTML. Research §3.A decides whether Live Desk keeps
  lightweight-charts, upgrades, or adopts another engine — with licence terms for a paid product.

### 2.3 Market context from the owner's CHARTINK ATLAS

Use the owner's Chartink Atlas — **either by integrating it or by building our own version that
suits the VYUHA architecture** — to show **market regime, overall market environment, sector
analysis "and much more parameters"** (breadth, MA-breadth, new-high/new-low, performance,
volume expansion, sector/industry rotation are what the Atlas layer already defines). Sources:
the owner's dashboard `https://chartink.com/dashboard/480715` (research only) and the local
project `T:/Thejesh/CLAUDE-CODE/CHARTINK-PROJECT/` (read-only): `README.md`,
`docs/chartink-atlas-integration.md` (decision, universe/timing, transparent daily definitions,
widget traceability, API/UI contract, source & parity policy, promotion gates),
`docs/atlas-classification-contract.md` (dual-clock point-in-time sector/industry mapping),
`docs/live-platform-research.md`, `docs/openalgo-integration.md`. Memory notes: the widget
series has a silent 75-group cap and some widgets are the operator's IP — do not expose those
formulas in a shipped product without the owner's ruling.

### 2.4 Owed from previous sessions — fold into Live Desk (the owner asked to be REMINDED)

- **Sector-mapping / deeper-analysis feature** from the owner's TRADE-SENTINAL + Chartink Atlas
  files: `classification-reconciliation-multisource.csv` (2,305 rows, in Sentinel),
  `T:/Thejesh/CLAUDE-CODE/classifications-multisource-review.csv`,
  `T:/Thejesh/CLAUDE-CODE/Screener - Industry mapping.xlsx`, `sentinel/NIFTY INDICES/*.csv` (also
  `T:/Thejesh/CLAUDE-CODE/NIFTY INDICES.zip`), `WATCHLISTWEEK20260828.xlsx` (ideas only). v3.8
  shipped the DATA LAYER only (`sector-map.json`, 2,229 rows, all rows with provenance). v4.0 =
  the analytics: stock-vs-own-cohort attribution ("stock pick or sector ride?"), cohort-minus-
  index gap, end-market axis with rank change, entry location / base state, a self-published
  staleness ledger. Open question: cohort prices (Vyuha stores none).
- **Position-sizing calculator** — the owner's spec + images (see §3.B) + "a few tweaking
  details" he will share.
- The **5 size indices absent from `nse-index-map.json`** with no recorded reason — decide.
- Also owed to the product (not Live Desk, keep visible): macOS DMG test when a Mac exists (macOS
  is NOT sold — never advertise it), `VYUHA_KEY_ARCHIVE_DIR`, the theme/accent-skin collapse
  question (§8.5), growth-engine and monetization plans written but not executed, and the
  standing "SPECIAL CARE TO MONETIZATION" — decide which Live Desk features are Free vs Pro.

---

## 3. RESEARCH — deep, layered, tear-down level (ULTRATHINK; create a task plan and audit it)

The owner's images and links are **inputs for analysis, research and finding the best methods —
not things to rebuild exactly**. Tear each source down to every small detail. Do not restrict
yourself to the listed links: run a vast web + GitHub search for alternatives. Every claim in the
research is labelled VERIFIED (fetched/read) or INFERRED. Cite the URL/file for each.

### 3.A Charts

Listed sources (all mandatory):
1. https://github.com/marketcalls/openalgo-charts
2. https://github.com/marketcalls/openalgo
3. https://in.tradingview.com/advanced-charts/
4. https://in.tradingview.com/free-charting-libraries/
5. https://earningspulse.ai/screener/library
6. https://www.scichart.com/blog/best-tools-for-creating-trading-platform-charts/
7. A wide web + GitHub sweep beyond these six (at minimum evaluate: TradingView Lightweight
   Charts current major, TradingView Advanced Charts licence terms, KLineChart, Highcharts Stock,
   SciChart, Apache ECharts candlestick, Plotly, chartjs-chart-financial, react-financial-charts,
   dxcharts-lite, uPlot, TradingVue, any Indian-market-specific open-source terminals).
Evaluate each on: licence for a **paid, redistributed desktop + hosted product**; overlay/drawing
API (horizontal price lines, labelled entry/target/stop, trailing lines that update); intraday +
EOD series; performance with many positions; bundle size; SSR/hydration behaviour in Next.js;
Tauri webview compatibility; theming to 9 skins × light/dark; data-feed adapter shape (what
openalgo-charts does to bridge quotes); cost. Produce a scored comparison and a recommendation.

### 3.B Position sizing, stop loss, trailing profit, trailing stop-loss — calculators and an interactive "position sizing lab"

Apart from the owner's images (**the images were NOT attached to this handoff — ask the owner to
paste them into the session; index each image and what it shows**), run a deep structural web
search and analyse every source layer by layer. Cover at least: fixed-fractional and fixed-ratio
sizing, volatility/ATR sizing, Kelly and fractional Kelly, R-multiples (Van Tharp), risk of ruin,
portfolio heat and correlated-risk caps, pyramiding/scale-in rules; stop methods (ATR, structure /
swing-low, percentage, volatility bands, time stops, breakeven moves); trailing methods
(chandelier, parabolic SAR, moving-average trail, percentage trail, R-ladder partial exits,
"sell into strength" scaling); Indian specifics (F&O lot sizes, MTF leverage and interest,
brokerage/STT/charges round-trip effect on R, circuit limits, tick size, T+1). Tear down how
existing products present this (journals: Edgewonk, Tradervue, TradeZella, TraderSync; brokers:
Zerodha Varsity + Kite calculators, Dhan, Upstox; TradingView/Chartink calculators; academic /
practitioner texts: Tharp, Elder, Minervini, Kaufman, O'Neil). Output: the calculator's inputs,
formulas (integer-paise safe), interaction design for the lab, how its risk setting feeds the
chart stop (§2.2), and SEBI-safe wording (it is a calculator, never advice).

### 3.C Chartink Atlas

Tear down `https://chartink.com/dashboard/480715` (what each widget shows, its inputs, cadence)
and the CHARTINK-PROJECT Atlas layer (§2.3). Decide: integrate (how — files, API, DB attach,
scheduled export) vs build inside Vyuha (which definitions are transparent and reproducible from
EOD data Vyuha can obtain). Respect the read-only rule and the operator-IP note.

### 3.D Add your own points

As usual: add the points the owner did not list, then research those too (examples to consider:
alerting on stop/target hits via Telegram, news/results proximity on positions, options positions
in the tracker, multi-account view, keyboard-first interaction, performance budgets, accessibility,
what "intelligence" may say without becoming investment advice).

---

## 4. Method — explore, analyze, orchestrate, THEN code

1. **Explore** with read-only agents first (Explore / scout); verify every plan claim against the
   code (VYUHA-STATE §0/§3 is the map; `docs/DECISIONS.md` and memory hold the rulings — do not
   re-ask a recorded ruling).
2. **Analyze**: produce the research and feasibility artifacts (§5). Keep this session's context
   lean — delegate reads, tight greps, never `cat` a log.
3. **Orchestrate**: a wave plan with disjoint file ownership per agent, the gate that proves each
   wave, rollback, DO-NOT list, and time estimate (planner agent). Present it via ONE batched
   pop-up (recommended option first) for the owner's approval BEFORE writing code.
4. **Code**: builder agents on Opus; every fix lands with a test proven red by actually reverting;
   probes only as `tests/zzprobe-*.test.ts`, deleted before reporting; no `next dev` left running;
   `npm run verify` stage gates; adversarial diff-audit (skeptic) before any release.
5. **Track and audit**: create a task plan that enumerates EVERY numbered point of this file
   (0.1–0.4, Step 1 items 1–6, 2.1–2.4, 3.A–3.D, 5.1–5.10, 6, 7); the final audit maps each
   owner sentence to where it is answered. Nothing dropped, nothing narrowed.

---

## 5. Artifacts to produce (combined pack; choose the best-suited files — these are the minimum)

Location: `T:/Thejesh/CLAUDE-CODE/VYUHA-LIVE-DESK-RESEARCH/` (a neutral folder — other sessions
clean untracked files inside repos) plus published artifact links for anything visual.
1. `00-INDEX.md` — what each file is, the converged recommendation, decisions open (irreversible
   ones first), the deadline plan.
2. `01-ANALYSIS.md` — feasibility per requirement (2.1–2.4) with methods, costs, risks, fit.
3. `02-CHART-RESEARCH.md` — the §3.A comparison and recommendation.
4. `03-SIZING-RISK-RESEARCH.md` — the §3.B tear-down, formulas, lab design.
5. `04-ATLAS-INTEGRATION.md` — the §3.C decision and contract.
6. `05-LIVE-DESK-SPEC.md` — the Live Desk specification draft (parameters, screens, data flows,
   Free/Pro split, copy).
7. `06-QUESTIONS.md` — **many, many questions** for clarity, grouped, each with your recommended
   answer, so the owner answers in one pass.
8. `07-WEB-PLATFORM-DELTA.md` — what the new vision changes in the web research pack.
9. `08-BUILD-PROMPTS/` — `V391-BUILD-PROMPT.md` and `V400-LIVE-DESK-BUILD-PROMPT.md`, each
   self-contained.
10. `mockups/` — interactive HTML mockups of Live Desk (tracker, chart with overlays, Atlas
    context panel, sizing lab), published as artifacts.

---

## 6. Owner inputs to request at session start (hand the owner the complete list once)

- The v3.9.1 "added fixes" (if not found on disk / in git).
- The position-sizing / stop / trailing **images** (second image onward — none reached this prompt).
- Which Sunday the deadline is.
- Chartink login/dashboard access details are NOT to be typed by the session — the owner
  supplies exports or screenshots.
- The sector files listed in §2.4 if any are missing from the paths given.
- The owner's "few tweaking details" for Live Desk.
- Quote-feed preference for the tracker (broker API via OpenAlgo / Kite personal API / NSE public
  quotes / EOD only) — present the options with your recommendation.

---

## 7. Standing rules that survive (unchanged)

AGENTS.md invariants; fixtures schema-only, real exports gitignored in `tests/fixtures/private/`
and in "T:/Thejesh/CLAUDE-CODE/BROKER FILES FOR TESTING/" (read-only, never quoted); scope
searches to `app/ components/ lib/ e2e/ tests/`, no adjacent refactors; SEBI-safe copy, no outcome
claims; macOS never advertised; client package rebuilt every release; WDSI details unprompted;
commit + push finished work (`origin` = owner's private GitHub); VYUHA owns ports 3100/3011/3007;
`MEMORY.md` is Edit-only; decisions logged with the rejected alternative; the owner's standing
"tell me what fits this app's structure and what it costs, then build the one we agree on — don't
guess and implement."
