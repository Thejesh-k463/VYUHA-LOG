# NEXT SESSION PROMPT — v3.9.0 "Trust the numbers" then v4.0 "Live Desk"

Paste everything below the line into a fresh session (after `/clear`). It encodes every lesson
v3.8.0 paid for. Written 2026-09-04 by the v3.8 orchestrator.

---

Explore, analyze, plan and then build with delegated multi-agents.

Read `VYUHA-STATE.md` (repo root) first. **State (owner-confirmed 2026-09-04):** v3.8.0
"Trust the import" is PUBLISHED — tag `74e8d49`, CI 6/6, 3/3 signatures deep-verified, installed
clean on a non-build machine, WDSI submitted. No open release actions. Live Desk is v4.0.

## Task

Build **v3.9.0 "Trust the numbers"** exactly per `docs/V380_BUILD_PLAN.md` §2 plus every item
`docs/DECISIONS.md` (all `## 2026-09-04` entries) and `VYUHA-STATE.md` §8.0 deferred to v3.9:
1. **Broker-truth reconciliation screen** — broker ₹X · Vyuha ₹Y · Δ ₹Z per FY and per scrip,
   with reasons (unpriced sales, product differences, charges the file omits). Dhan Realised P&L
   (already parsed, `reported` per segment) and the new **Paytm Realised P&L Detail** parser
   (sheet 2 of the `.xls`, three stacked tables, embedded `Total` rows, no charges) feed it.
2. **Parsers deferred from v3.8**: Dhan DP charges (`.xls`, 352 merges), Dhan holdings, Upstox
   ledger (`LEDGER_V3`), Angel ledger (`YourStatement`, 4 stacked charge tables), Angel P&L
   statement (`Equity P&L` + `F&O P&L` sheets), Dhan MTF Report + Contract Note (fill times, F&O
   instrument type — the only Dhan source with either). Every one must see a broker fingerprint.
3. **`/trades` server pagination** — its own change with its own before/after proof: total order
   `(sell_date, created_at, id)`; measure `taxByFy` last-paisa, harvest lot status flips,
   holding-clock top-15 membership on the real book AND the perf book before/after; state the
   `created_at` batch-tie fact in the release note. `/trades` is the one route over budget (1,968 ms).
4. **Short-sell and cross-exchange modelling** in `pairSymbolLegs` (covered short ≠ opening sell;
   NSE-buy/BSE-sell split with a stated note) — re-baseline `dhan-gtr`, `generic-map`, Paytm and
   Zerodha golden rows BEFORE touching it, with a written reason per moved pin.
5. **Floating search assistant** — Radix-Popover-anchored (the dependency exists, zero usages),
   pointer-draggable, persisted under `vyuha-search-panel {v:1,x,y,open}`, survives navigation;
   audit log + ledger join the FTS index (migration 0061). No new dependency.
6. **Carry-overs**: `pair-legs.ts:302` spread → `for…of push` (single-symbol stack overflow at
   ~190k legs); `classification_overrides` re-key on Paytm re-import (0059 orphaned label-hash
   overrides with no live row); `dhan-pnl-fresh.csv` scores 0.8 not ≥ 0.9 (no footer) — decide;
   the Angel `partial` lock rule and the palette "· all accounts" copy get a copy pass.

Then, **only if the budget governor (below) allows**, open **v4.0 "Live Desk"**: REMIND me and
ask via pop-up for the sector-mapping inputs (my TRADE-SENTINAL / Chartink Atlas files — read
only, never write there), the position-sizing calculator spec, and my tweaks. v3.8 shipped the
DATA LAYER only (`lib/data/sector-map.json`, 2,229 rows, owner ruling: all rows with provenance;
`getSectorResolution()`, confidence tiers on the risk cockpit). v4.0 = the analytics: stock-vs-
own-cohort attribution ("stock pick or sector ride?"), cohort-minus-index gap, end-market axis
with rank change, entry location/base state, a self-published staleness ledger — cohort prices
are the open question (Vyuha stores none; PRIVACY's "exactly four kinds" must stay true, so the
opt-in EOD bhavcopy is the only source). Also decide the 5 size indices absent from
`nse-index-map.json` (no recorded reason). v4.0 gets its own recon, wave plan, approval, audits.

## Budget governor (non-negotiable)

Read my usage screenshot when I give it; otherwise ask for it at every wave gate. **Fable is the
orchestrator and the adversarial finders only; every build/fix/docs agent runs on Opus
(`model: "opus"`).** v3.8.0 consumed far more than 13 Fable points; do not pretend otherwise.
Rules: (a) a wave is never started that cannot be gated AND audited inside the remaining budget;
(b) v3.9 ships complete (double audit + release skill) before one line of v4.0; (c) if the
governor trips mid-v3.9, finish the current wave's gate, commit, push, write VYUHA-STATE, and
STOP — a half-audited release is how v3.5.0 and v3.7.0 died; (d) keep this session's context lean:
delegate reads, tight greps (a wide grep once dumped a whole page source into context), never
`cat` a log — grep the two lines you need.

## Standing gates (unchanged from v3.5–v3.8; each exists because skipping it shipped a defect)

- Explore first with read-only agents; verify every plan claim against the code (`§0` is a map).
- Present the full wave plan via pop-up for my approval BEFORE writing code; decisions in batches,
  2–4 options, your recommendation first and marked "(Recommended)".
- Every fix lands with a test **proven red by actually reverting** (quote the failing assertion).
- Probes ONLY as `tests/zzprobe-*.test.ts`, deleted before an agent reports; no `next dev`
  servers from agents (diagnosis only on port 3011, killed before reporting; 3100 is the e2e
  harness's).
- **Disjoint file ownership per agent**, stated in the prompt; cross-cutting files (`commit.ts`,
  `route.ts`, `lib/audit.ts`, `accounts.ts`) get ONE agent per wave; migrations ONE agent
  (next: 0061). Agents never commit; the orchestrator commits + pushes at every wave gate.
- One `npm run verify` per wave, run by the orchestrator, exit code echoed by your own `echo`
  (the harness's "[exited with code 0]" is the wrapper, not the command). README counts synced at
  EVERY gate: unit files, tests (the `readme-claims` test checks file count, e2e spec count and
  load-case count against disk), e2e flows+specs, load cases — six unit figures incl. badges.
- Full e2e once per UI wave (never beside editing agents — Fast Refresh wipes client state);
  load suite after any pairing/import change; double perf sweep on the seeded prod build with an
  idle machine (search/analytics must move no route; `/trades` compared, not fixed until item 3).
- Audits: 6 finders over the diff → fix wave (Opus) → 3 finders over the fix wave → fix pass →
  1 finder over that. Each finder READ-ONLY, reversion experiments restore byte-identical.
- Release skill start to finish (bump; lockfile roots BY HAND; Cargo.lock via
  `cargo update -p vyuha --offline`; client docs + the getting-started deck chips to the new
  version; verify; build; BUILD_ID + marker grep; sig key id decode; CI 6/6 incl. `load` BEFORE
  the tag; tag; `release:verify --deep`; client ZIP; hand me the WDSI details UNPROMPTED with the
  client-ZIP installer SHA-256). Claims audit: PRIVACY's "exactly four kinds" stays true; macOS
  is never advertised on a selling surface; every doc sentence describes what ships.

## Traps v3.8 found (do not rediscover)

- `describe.skipIf(cond)` STILL RUNS its callback at collection — bail with `if (!X) return;`
  first, or CI fails to load the file. No test shells out to `rg`/`pdftotext`: runners lack them.
- The e2e DB is shared across specs: never assume your broker's rows are absent; assert against
  your own import's "Imported N" figure. New specs prefix `z-`; `expect.poll`, never `networkidle`.
- `growthRatio` has a 25 ms floor: size load baselines to clear it with margin, take best-of-3
  ratios (noise only inflates), and investigate a red `load` job for the floor before the engine.
- A `<p>` around a Badge (`<div>`) is React #418 on every visit (`tests/import-hydration-guard`
  now pins it); the guard's regex must cover `export default function`.
- Same-origin `fetch` with a templated URL trips `tests/egress-guard`: use a literal `/api/…`
  prefix or add the file to `DYNAMIC_URL_CALL_SITES` with the reason.
- Detection tests decide by CONTAINER: CSV-only detectors get no `text` for xlsx fixtures — assert
  refusals in the container the detector reads (`loadAsText()` helper exists).
- A parser residual fold must be capped at the pairing tolerance or a skipped line's charges land
  on a random position labelled "rounding" (GTR and Angel both had it); ambiguity refusal counts
  only month>12 with day≤12; both-tokens-out-of-range is a skip, not evidence; a day-first file
  whose days are all ≤ 12 is undetectable by construction — say so, never guess.
- Dhan: DH-901 = auth (mint once), DH-902 = permissions (never mint); auto-pull must reuse and
  persist the token (2-minute mint limit); GTR is the BOOK, Realised P&L the REFERENCE.
- The palette/search cache must be keyed per account (invariant 8 moves to the client otherwise).
- Restore of a broker-remove snapshot refuses when newer rows exist or the account is gone.
- The uninstall guard must gate on `vyuha.sqlite` existing, or a journal-less folder can never
  uninstall; the v3.7.1 → v3.8.0 upgrade ran the old unguarded uninstaller once (release-note line).
- Golden books: exact shapes are frozen; a row that goes to 0/0/0 is a stop-ship, never a re-pin;
  engine-mode charge pins carry `// DEFECT (by design until v3.9 reconciliation)` markers — item 1
  above is what retires them.
- Owner files live in "T:\Thejesh\CLAUDE-CODE\BROKER FILES FOR TESTING\" and
  `tests/fixtures/private/` (gitignored): read-only, never copied, never pasted (name/UCC/PAN/
  email/mobile); redaction = `scripts/fixtures/redact-broker-export.mjs` (keeps every row, refuses
  any output whose detection or parse differs). Redaction does not scrub git history.
- Two sessions share `MEMORY.md` and ports: VYUHA owns 3100/3011/3007; a `coord:` deny is a fact.

## Owner inputs you will need (ask precisely at the wave that needs each)

v3.9: Dhan MTF Report (a week with MTF) + both Contract Notes (already in the inbox), Paytm `.xls`
P&L (inbox), the usage screenshot at every gate. v4.0: TRADE-SENTINAL sector/industry/index files
(`classification-reconciliation-multisource.csv`, `classifications-multisource-review.csv`,
`Screener - Industry mapping.xlsx`, `sentinel/NIFTY INDICES/*.csv`) and `WATCHLISTWEEK*.xlsx`
for ideas only; the sizing-calculator spec; my tweaks. Hand me the complete list at session start.

Model: Fable for this session's orchestration and finders; Opus for every build agent. Nudge me
to switch the whole session to Opus once, at the first natural boundary, then never again.
