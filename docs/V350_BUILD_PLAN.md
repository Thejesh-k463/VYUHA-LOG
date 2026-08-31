# Vyuha v3.5.0 Build Plan — the Second Brain release

Status: **AWAITING OWNER APPROVAL** — no code lands until the owner signs off.
Inputs: the 2026-08-31 ultracode audit (33→22 verified findings, 7 root causes),
three real Zerodha workbooks (two FYs reconciled against Zerodha's own totals),
and a 7-agent read-only recon of every surface the feature list touches (2026-09-01).
Decisions already taken by the owner: **(1) show BOTH turnover bases**, **(2) A6
ships the 3-line heuristic now, full direction migration in v3.6**.

Scope in one line: demo hardening + Zerodha real-data import + Vyuha Intelligence
(a deterministic second brain) + nine feature expansions, all under the house rule
that honesty beats impressiveness.

---

## Part 1 · VYUHA INTELLIGENCE — the second brain

### 1.1 The research: four ways to build it

| | Option A — Deterministic Insight Engine | Option B — BYO-key cloud LLM | Option C — Local LLM | Option D — the Fact Contract |
|---|---|---|---|---|
| What | Pure-TS rule + statistics engine over the journal | User pastes an Anthropic API key; Claude narrates & answers questions | Ollama-if-present adapter, or bundled quantized 3B model | Architecture: the engine computes ALL numbers; any LLM only narrates fact objects |
| Offline | **100%** | No (defeats the differentiator) | Yes (Ollama: if installed; bundled: +2GB installer) | n/a (contract) |
| Deterministic | **Yes — unit-testable** | No | No | Numbers yes, prose no |
| Cost to user | ₹0 | API spend | ₹0 / disk+RAM | ₹0 |
| Demo-safe | **Yes** | Risky (network, latency) | Risky (non-determinism on stage) | — |
| Effort | ~1.5 days (much already exists) | ~1 day later | adapter ~1 day later | designed into A |

**Recommendation: A + D in v3.5.0.** The recon shows the second brain is already
half-born in the codebase and just needs a spine:

- `lib/analytics/cockpit.ts findings()` — 6 hardcoded insight rules with the
  honesty contract already tested (`MIN_SAMPLE=15`, no-prescriptive-language regex
  in `tests/cockpit.test.ts:256`).
- `lib/analytics/behavior.ts` — mistake-cost-as-expectancy-gap framing.
- `lib/analytics/inference.ts` — Wilson intervals + Benjamini-Hochberg, built for
  WS2, wired only into /reports/edge.
- `lib/analytics/tax-levers.ts` — the (A) deterministic / (B) needs-external-facts /
  (C) advice classification with SEBI IA caveats.
- `FindingCard` (arjuns-eye/page.tsx:65) — the only insight UI, trapped in one page.

**The build:** `lib/intelligence/` (pure, invariant 2):

```ts
type Insight = {
  id: string;                    // stable rule id, e.g. "sl-slippage"
  scope: "book"|"group"|"symbol"|"session"|"tax";
  tone: "good"|"warn"|"info";
  headline: string;              // descriptive, never prescriptive
  evidence: { label: string; value: string; tone?: Tone }[];
  suggestion?: string;           // framed as observation ("historically, …")
  sampleSize: number;            // refuses to exist below the rule's floor
  coverage?: { have: number; of: number; noun: string }; // "SL recorded on 12 of 40 losers"
}
```

- **Table-driven rule registry** `{id, appliesTo, sampleFloor, compute, phrase}` —
  absorbs the six `findings()` if-blocks unchanged as the first six rules, then new
  rules slot in as rows. The cockpit language-regex test extends to EVERY rule's output.
- **Wilson CIs via `inference.ts`** on every win-rate-class claim (pays down the
  V320 WS2 debt on Arjun's Eye at the same time).
- **Shared `InsightList` component** generalising `FindingCard` out of arjuns-eye.
- **The SEBI line, in code:** insights describe the user's own record; the engine
  has no rule type that can emit a scrip recommendation or a forward-looking
  buy/sell. This is both the honest product stance and the regulatorily safe one —
  documented in the module header like `tax-levers.ts`.
- **Consumers in 3.5.0:** lens popup cards, the three new Arjun's Eye tabs,
  session-plan watchlist enrichment, performance explainer dialogs.
- **D means B and C are adapters later:** any future LLM receives Insight/fact
  JSON and may rephrase it; it never computes a rupee. Prose can't hallucinate a
  number that isn't in the fact object. Ollama adapter targeted at v3.6, BYO-key
  after that, both opt-in.

**Why not B/C now:** the demo must be deterministic and offline; "offline second
brain that never invents a number" is a stronger line on stage than a chatbot.

---

## Part 2 · The nine features, grounded in the recon

### 2.1 Lenses pop-up cards (feature 1A)

`KpiCard` already has the exact mechanism: a `detail: KpiDetail` prop that turns
the card into a click-to-open Dialog (shipped on dashboard/trackers/risk/options-
journal — 18 call sites). The lens drill-down's five cards are `KpiCard`s passing
no `detail`. Work:

- **Trades card** → composition (open/closed, per-month span, symbols) — in client
  memory already.
- **Net P&L card** → top-5 winners/losers, gross-vs-charges bridge, distribution —
  fully computable client-side from the in-memory group members (free-tier data).
- **Charges card** → per-head split. The 10 charge-head columns are NOT on the wire;
  per the 2026-08-29 perf decision we do NOT widen `LENS_FIELDS` — instead compute
  per-group head sums server-side (reusing `lib/analytics/charges-report.ts`) and
  ship ~10 numbers per group inside `LensRow.totals`.
- **Win rate / Expectancy cards** → streaks, avgWin, avgLoss, W/L ratio are ALREADY
  computed per group by `computeKpis` and thrown away by the `toLensRow` allow-list.
  Add them to `LensEdge` (**Pro side** — they are edge-class figures, matching the
  existing split) and update `tests/lens-gating.test.ts`'s exact-key assertions
  deliberately.
- **Insight lines** in each popup from the intelligence engine (`scope:"group"`),
  e.g. "80% of this month's loss sits in one setup" — descriptive, sample-floored.
- Breakdowns compute over the FULL member array, not the `DRILL_LIMIT` slice.

**Bug found by recon, fixed here:** `/lenses` (and the dashboard) never project
`acquisition`/`buyValue`, so `edgeMeasurable` sees every trade as priced and
`unpricedCount` is always 0 — the unpriced-basis warning card is unreachable.
Add the two columns to those projections so the exclusion story is real.

### 2.2 A new "Trade Craft" tab set on Arjun's Eye (features 1B, 2, 3)

Owner asked where points 2–3 belong: **recommendation — Arjun's Eye**, as three
tabs beside the existing cockpit. It is already the behavioural surface, already
Pro-gated, already carries the honesty contract, and — decisive — the pure modules
these tabs need (`exit-behaviour.ts`, `stop-migration.ts`) already live there
unsurfaced. Lenses stays a partition-of-the-book surface; these are cross-cutting.

**Tab 1 — Stop-losses (1B).** Data reality first: `slPlanned` is null on 100% of
imported trades (only manual/staged/edited trades carry it), so every figure states
its coverage ("SL recorded on N of M losing trades") per invariant 6.
- New pure classifier beside `exit-behaviour.ts`: for SL-carrying closed trades,
  compare exit price vs `slPlanned` with tolerance → held-to-stop / slipped-past
  (₹ and R of slippage) / exited-early. Average loss with vs without SL recorded.
- Reuse `stopTuningReport` (MAE > 1.1R from EOD bars, equity-only — caveat stated).
- **Group by setup/playbook when tagged** (`bySetup`, `playbookStats`) — this is the
  "Vyuha can analyze better if you tag" mechanism: the tab visibly grows richer as
  the user tags, and shows a coverage nudge when untagged.
- **Unlock `exitTrigger`:** the column exists (migration 0051), the analytics exist
  (`exitTriggers()`), but NO writer exists — 100% null today. Add the field to the
  edit dialog + journal drawer. This one small write path is the single highest-
  leverage data unlock in the release.

**Tab 2 — Trailing stops (2).** `trailingSl` subset → `computeKpis` win rate vs
the non-TSL baseline, with `MIN_SAMPLE=20` refusal below sample ("7 trades carry a
TSL — not enough to say anything honest yet"). Plus the richer story from
`stop-migration.ts` (audit-log-mined widened vs tightened stops and their
expectancy gap) — built, tested, rendered nowhere until now.

**Tab 3 — Winners vs Losers (3) — the flagship.** Fully computable today on every
closed trade (netPnl-based, no plan fields needed):
- Headline verdict: avg win vs avg loss (payoff ratio) × win rate → one of four
  quadrants, plotted against the breakeven curve `winRate = 1/(1+payoff)` so the
  user SEES how far from breakeven their combination sits.
- R-multiple distribution histogram — **split into SL-derived R vs default-cap R**,
  because imported trades' `rMultiple` is denominated in the ₹9,500 default risk,
  not a real stop; presenting that unlabelled as "R" would fabricate a denominator.
- Tail analysis: largest-loss share of gross losses; "losses beyond −2R cost ₹X of
  expectancy" using the expectancy-gap method (never counterfactual P&L).
- Intelligence verdict copy, descriptive: "You currently win small and lose big:
  average winner ₹A, average loser ₹B. Historically, books at your win rate need a
  payoff above P to stay ahead of charges." Wilson CI on the win rate.
- Recharts (it may reach paper), literal colours.

### 2.3 Every card a pop-up (feature 4)

Machinery exists; coverage is the work. Phased honestly:
- Extract `KpiCard`'s dialog half into `<KpiDetailDialog>` (~30 lines) so
  non-KpiCard surfaces can join.
- Delete `risk-cockpit-client.tsx`'s duplicate `Tile` (lines 338–408) → `KpiCard`.
- **3.5.0 rollout:** lenses (2.1), performance + scaling (2.6), Arjun's Eye,
  harvest/advance-tax KPI cards, equity trackers' remaining cards — each popup's
  rows are per-page server-side analytics work.
- Remaining ~10 ad-hoc stat tiles: migrate where a breakdown exists; leave static
  where density is the point (calculator readouts, dialog summaries). Anything not
  reached in 3.5.0 is listed in the release notes as continuing in 3.5.x — not
  silently skipped.

### 2.4 Arjun's Eye expansion (feature 5)

Beyond the three tabs: surface `exitClock`/`holdingClock`/`fragmentation` (exit-time
edge, minutes-held for same-day trades, fills-per-position as hesitation); add
revenge-trade **minutes** (entryTime/exitTime are HH:MM where the broker file
carried times — metric reports its timed-coverage denominator like `timeEdge` does);
sizing-after-loss (afterLoss bucket's median buyValue vs baseline — tilt
escalation); Wilson CIs on all findings via `inference.ts`; migrate `findings()`
into the intelligence rule registry; new thresholds get DECISIONS.md entries
(recon found the current ones are conventions, not measured decisions); move the
page off full 74-column `getTrades()` onto a projection.

### 2.5 Session Plan automation (feature 6)

- **Watchlist file import:** txt (comma/space/newline), csv/xlsx via the existing
  `generic-table.ts` plumbing, pdf via the `parsers/pdf.ts` pattern — flat text
  extraction, candidate tokens shown for user confirmation, never claimed as a
  parsed table. `.txt` needs its own decode branch in `buildContext` (currently
  only `.csv` decodes to text). **Zero new dependencies** — xlsx, papaparse,
  pdf-parse are all installed; the lockfile is not touched.
- **Symbol canonicalisation** through `resolveTicker`/aliases + ISIN/scrip-code
  resolution — this also fixes a latent correctness bug recon found: today the
  plan stores raw typed strings, so an alias mismatch silently scores as "traded
  outside the watchlist" in the session review.
- **Per-symbol enrichment at render** (never persisted): prior trades on the symbol
  (count, net P&L, win rate, avg R, last traded — new pure per-symbol aggregator),
  sector/lot-size where `instruments` has them ("—" otherwise), and expiry
  proximity from the user's own book (`expiry-stats` pattern) — never from the
  always-empty `instruments.expiry`. No live quotes; offline app.
- **Close the review loop:** `status`/`reviewNotes` columns and API support exist
  with no UI — add "mark reviewed + note" so a plan has an afterlife.
- Per-symbol plan fields (bias/levels/notes): versioned-envelope JSON shape,
  hand-written migration only if the envelope route proves insufficient.

### 2.6 Performance & Scaling education (feature 7)

- New pure registry `lib/domain/metric-help.ts`: per-metric `{meaning, formula,
  healthyRange (stated as heuristic, with caveat), whatToDo}` — rendered through
  the existing `KpiCard detail` dialog; drift test in the `help-content.ts` style
  so a rendered metric without an explainer fails CI.
- The explainers must state, and where cheap we fix, the label-honesty issues recon
  surfaced: **two different "Max drawdown" definitions coexist** (equity-% vs
  realised-₹) — name the convention on each; "Expectancy" is ₹/trade, not R;
  Sharpe/Sortino use only traded days (says so); benchmark alpha is arithmetic;
  profit factor ∞ case; RISK_FREE 7% hard-coded → becomes a labelled assumption.
- A1 (capital fallback `|| 1700000` at performance/page.tsx:52) is fixed in Part 3 —
  the explainer for return metrics then honestly says "no capital set → —".
- Scaling: same treatment for its four KPIs + surface `avgImpact` and the neutral
  count (computed, unrendered); replay explainer states the EOD honesty caveat.

### 2.7 Back button visibility (feature 8)

One component (`back-button.tsx`), one call site. Restyle: primary-accent glow via
`--shadow-primary-glow` + a soft `pulse-dot`-style attention keyframe (registered
in the `prefers-reduced-motion` block, `print:hidden` preserved). Tooltip already
teaches `Alt+←`. **Recommend keeping** the deliberate depth≤1 hiding (a
permanently-dead control is clutter; first-screen back would exit the flow) — the
glow makes it unmissable whenever it CAN act. Flagged as an owner decision below.

### 2.8 Tax Harvest & Advance Tax (feature 9)

Correctness first (from the audit, folded here): harvest gross→**net** basis (A4);
FY-end literal → `fyStartMonth`-aware; `taxByFy` goLiveFy literal (A5); harvest
LTCG now applies the `fmv31Jan2018` grandfathering path that `classifyGain`
already implements.

Enhancements, all pure-engine composition, no new inputs unless stated:
- **What-if harvest simulator:** `computeHarvest` is pure — client component
  (advance-tax-calc pattern) with lot checkboxes/qty; user-initiated selection
  only, never a ranked "sell these" list (the tax-levers (C) line).
- **Harvest × advance-tax link:** "harvesting ₹X now lowers the 15 Mar instalment
  by ₹Y" — composition of two existing pure engines.
- **Expose s.425(4) relief** — implemented, tested, unreachable: two form fields.
- **Carry-forward loss ledger view:** `computeTaxTimeline` already produces
  vintage-dated lots with expiry years, rendered today only as sums — a
  vintage → absorbed → expires table on /reports/tax; seed-lots param already
  exists for future pre-journal balances.
- **LTCG exemption headroom KPI** (with the per-person caveat verbatim).
- Advance-tax inputs persisted via `useStoredValue` envelope (survives a visit);
  presumptive toggle (single 15 Mar instalment) as a user assertion.
- **Deferred to v3.6, deliberately:** the dated challan ledger table (real
  payment tracking). It needs a new table + migration + write path, and the
  engine header itself documents the current simplification — honest scope cut,
  recorded in DECISIONS.

---

## Part 3 · Demo hardening (carried from the approved 2026-08-31 plan)

Unchanged in substance; decisions applied. Summary of record:

- **P0 — Test fixture** `tests/fixtures/zerodha-fno-recon.xlsx` from the three real
  files, PII stripped: tradewise-2425 (634 rows, spans 23-Jul-2024 CG cutover AND
  1-Oct-2024 STT hike, implied blended STT 0.0806%), tradewise-2526 (59 rows, clean
  0.1000%), expected-totals sheet. FY25-26 charges reconcile to the paisa on all
  nine heads. Honest gap: all options, zero futures rows.
- **P1 — Zerodha import:** `toMatrix` scans ALL sheets for the fingerprint (both
  taxpnl workbooks currently fall to the column mapper — the demo-killer); new
  tradewise-sheet source (entry+exit timestamps, per-trade charges → per-trade
  charge reconciliation; also feeds entryTime/exitTime for Trade Craft analytics).
  Detection refusal matrix stays green.
- **P2 — Turnover both ways (owner Decision 1):** primary ICAI 11th ed., secondary
  broker basis, §63/44AB verdict on both; itr banner derives from TURNOVER_BASIS;
  `"44AB"` literal → `section(fy,"audit")`.
- **P3 — Bucket A:** A1 capital fallback → "—" + Settings nudge; A3 `Math.max(0,…)`
  exposure floor; A4 harvest netPnl; A5 taxByFy FY literals; **A6 short-direction
  heuristic `sellQty > buyQty ? "short" : "long"` (owner Decision 2)**, migration
  + backfill + data-quality flag in v3.6; A7 generic-map day-leg aggregation before
  pairing (~10× count inflation — demo-1's killer shape); A8 import error guards
  (png / password-protected xlsx → clear 422, client reads text first).
- **P4 — Bucket B:** B1 b/f non-spec loss vs speculative income (one line; provable
  on this two-FY book); seller population after A6; scaling charge symmetry;
  `applyOverride` MTF; imported MTF interest (derived + marked); PDF-export id cap;
  IPO exit pricing date; cosmetic batch.
- **P5 — Copy honesty:** Console-P&L no-dates warning (never invent a date);
  "Recent closed (60)" → CappedNote; "Extra STT if held" delta relabel.
- **Demo guard rails:** set capital before the demo; import Zerodha/Paytm files;
  no blank-date IPO exits on stage.

---

## Part 4 · Points the owner didn't list (added)

1. **Update-flow rehearsal:** install v3.4.0 on a second machine and take the
   in-app update to v3.5.0 (prompt → download → relaunch) — the one path
   `release:verify --deep` cannot prove. Before the demo, not after.
2. **Demo runbook** `docs/owner/DEMO_RUNBOOK.md`: machine prep (capital set,
   accounts named, Pro licence), the file-import order, which surfaces to walk in
   which order, and the "if X goes wrong say Y honestly" lines. Demo-1 failed on
   surprises; the fix is a script.
3. **Data-coverage nudges as a feature:** the new analytics are only as good as
   tagging — SL/TSL/setup/exitTrigger coverage lines double as gentle onboarding
   ("insights sharpen as you tag") instead of empty-looking tabs.
4. **Futures path remains unexercised** — no provided file has a futures row.
   Stated in release notes; not claimed.
5. **Client package + landing page refresh** (standing rule) — features list gains
   Vyuha Intelligence with the honest framing: offline, deterministic, describes
   your own record, never advises. Pricing untouched (₹7,999 / ₹29,999).
6. **Claims audit** (release skill §10) — every new surface's copy checked against
   what actually ships.

---

## Part 5 · Build order, workstreams, verification

Multi-agent build; each stage lands with `npm run verify` green before the next.

| Stage | Contents | Est. |
|---|---|---|
| S1 Foundation | P0 fixture · P1 Zerodha detect+tradewise · A-bucket fixes · A8 guards | 1.5 d |
| S2 Engine | `lib/intelligence/` registry + Insight type + InsightList · cockpit findings migrated · Wilson wiring · exitTrigger writer | 1 d |
| S3 Surfaces | Trade Craft 3 tabs · lens popups + LensEdge additions · Arjun's Eye expansion | 1.5 d |
| S4 Money & tax | P2 dual turnover · 2.8 tax work · B-bucket | 1 d |
| S5 Experience | metric-help registry + drift test · popup rollout · back-button glow · session-plan import + enrichment · P5 copy | 1.5 d |
| S6 Release | bump 3.5.0 · lockfiles by hand · desktop build + BUILD_ID + marker grep · `release:verify --deep` · CI 5/5 BEFORE tag · client ZIP + landing refresh · DECISIONS + VYUHA-STATE · update rehearsal + runbook | 0.5 d |

**~7 focused days.** Tests added per stage: fixture reconciliation, intelligence
rule contract (language regex over all rules, sample floors), lens-gating key
updates, SL-classifier, metric-help drift, watchlist canonicalisation, detection
matrix additions. Every new page force-dynamic, every read scoped (invariant 8),
new maths pure-first (invariant 2), no lockfile rewrites, no new dependencies.

If the demo date arrives before S5 completes, the cut line is: S1–S4 + back-button
glow ship as v3.5.0; the rest becomes v3.5.1 within days. Nothing half-built ships.

---

## Part 6 · Open decisions for the owner

1. **Vyuha Intelligence = Option A + D now** (deterministic engine + fact
   contract), Ollama adapter v3.6, BYO-key later — confirm, or pull an LLM
   adapter into 3.5.0 (recommended against for demo determinism).
2. **Back button stays hidden on the first screen** (glows whenever it can act) —
   confirm, or make it always-visible with a disabled state.
3. **Demo date** — sets whether the S5 cut line is likely to matter.
4. **New lens popup figures (streaks, avg win/loss) land Pro-side** of the
   allow-list, matching the existing edge split — flagged for the record;
   will proceed unless overruled.
