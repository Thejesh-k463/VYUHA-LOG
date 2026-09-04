# V3.8.0 "Trust the import" + V3.9.0 "Trust the numbers" — BUILD PLAN

**STATUS: OWNER-APPROVED 2026-09-03 (twelve decisions, all taken via pop-up, all recommended options).
TAGGED v3.8.0 on 74e8d49 (2026-09-04) after three audit passes — awaiting deep signature verify + owner publish.** Decisions and the research behind them are recorded in `docs/DECISIONS.md`
2026-09-03. Live Desk slides to **v4.0** (owner decision).

Grounded in **eight read-only investigations run 2026-09-03 against the released v3.7.1 tree** —
four on the owner's own broker exports and screenshots (a Paytm tradebook misimport, a Dhan
enrolment blocker, import/trades test coverage, search infrastructure) and four follow-ups (the
symbol universe incl. a read-only look at TRADE-SENTINAL, pre-open + same-day classification with
the file's own charge signatures, Dhan's report catalogue, licence recovery + installer + macOS).
**Every claim below was executed against code or the real file, not recalled. Re-verify before
acting — these are maps, not the territory.** The two research reports that were "referenced but
never committed" in v3.7 are what cost that release its shape; this file IS the spec.

**Standing rules (unchanged; v3.7 added the last two):** explore first with delegated read-only
agents; verify every plan claim against the code before acting; present the wave plan for
approval BEFORE writing code; every fix lands with a test **proven red by actually reverting the
change** (v3.7: six guards passed while guarding nothing — three found during the build, three by
the audit); stage-gate with full `npm run verify` (echo the exit code, never a piped tail);
migrations serialized through ONE agent; one verify per wave run by the orchestrator; the release
does not ship without the multi-agent adversarial diff-audit, the double perf sweep, the claims
audit and the `release` skill start to finish; **a FIX WAVE gets its own adversarial audit before
the tag** (v3.7.0 was superseded unpublished because its fix wave had never been audited);
**probe files go under `tests/zzprobe-*.test.ts` and are DELETED before an agent reports** (58
leftovers broke the Windows CI job in v3.7); update the client package with every release;
present features' performance enhanced, never disturbed.

---

## 0. Facts the plan builds on (VERIFIED 2026-09-03)

**The Paytm misimport (owner's book, 7,544 rows).**
- The file is `paytm-tradebook` (detected 0.75; every other parser 0). No parser is missing.
- Paytm **switches `Script` from ticker to numeric code mid-window** (Jul–Aug: all codes). The
  parser groups fills by the raw `Script` cell (`lib/import/parsers/paytm-tradebook.ts:167,257,272`)
  and never keys on ISIN → 35 ISINs split into two positions; 17 have buys under the ticker and
  sells under the code → phantom open buy + phantom "sale with no purchase". Reproduced on a temp DB:
  804 positions, 72 unpriced sales, ₹4.46 Cr proceeds. **Re-keyed on ISIN: 38 unpriced, ₹2.75 Cr** —
  and the owner confirms the 38 are genuine SME IPO allotments. ISIN+Exchange keying is WORSE
  (101) — do not.
- **Invariant 6 holds**: an unpriced sale carries `netPnl = −charges` only. But
  `components/trades/acquisition-panel.tsx:151` says the sale is "already counted in Net P&L" —
  false; only the charges are.
- **Product**: of 83 same-day round trips booked as delivery (`toHint` collapses `mixed` →
  delivery, `paytm-tradebook.ts:174`), the file's own charges say **34 are intraday** (stamp between
  the two rates; `splitMixedRow`'s algebra matches the FIFO-matched value on 34/34) and **49 are
  genuine CNC delivery** (stamp 0.015% on the buy AND STT = 0.1% of buy+sell). **Rule: follow the
  scrip-day charge signature, never the calendar.** Sub-bug: `corroborate()` divides STT by
  `buyValue` alone; the delivery denominator is buy+sell (23 of the 49 mis-scored).
- **`dedupHash` derives from `tradingsymbol`** (`buildRow`) — the ISIN fix changes it, so stored
  Paytm rows will not de-duplicate on re-import without a hash migration.
- 1,856 rows (all numeric-`Script`) have empty `Trade Time` → 542 of 804 positions have
  `entryTime = null`. `docs/BROKER_FORMATS.md` (Paytm) still says Trade Time is empty "on every
  row" — true of the old 414-row export, false now.
- The numeric labels: **162/215 are BSE scrip codes** (exact match to `SCRIP_CD` in the cached BSE
  source — Paytm emits BSE codes on NSE rows too); 53 are NSE exchange tokens (no public CSV
  carries them). All 215 already resolve via ISIN; only **names** are missing.

**Pre-open.** Pairing is date-granular and never reads the clock, so pre-open fills already pair
correctly (133 fills → 5 same-day closed, 10 carried, 1 open; nothing mis-grouped). But
`SESSIONS[0]` starts 09:15, so 09:00–09:14 → `sessionOf() = null` → "off-hours" — the owner's 15
pre-open trades read like a parse error. 13 of 21 pre-open scrip-days are a scrip's FIRST day
(the IPO listing call). Leak: `lib/analytics/session-review.ts:49` treats a null `entryTime` as
"not after cutoff" instead of reporting coverage. No broker file flags pre-open; no fixture has a
09:00–09:08 stamp.

**Dhan.** The v3.6 enrolment fix is intact. The desktop DB was never enrolled because **the
Client ID box is EMPTY while looking filled**: `1112…••••` is a masked placeholder and `apiKey`
state is reset to `""` at mount, on broker switch and after every save
(`components/import/broker-connect.tsx:210,509,399,682`); the save gate at `:831` is `!apiKey || …`
(token already optional in TOTP mode). Nothing renders this component in any test (node-only
vitest, no broker-connect e2e). `1000000009` is a hard-coded placeholder (`:133`); in All-accounts
the picker defaults to `writeAccounts[0]` and a save there **creates a second Dhan row**. Also: no
retry-on-401 (`lib/import/api/dhan.ts:424-428` — an early-revoked cached token is never re-minted);
an unparseable `auth_json` is swallowed by a bare `catch {}` (`app/api/import/broker/route.ts:545-553`);
`jwtLooksUnexpired` treats an `exp` in milliseconds as alive (~50,000 years). The only visible sign
of enrolment is a ghost "Remove PIN + TOTP enrollment" button; the checkbox is `useState(false)`.
`docs/BROKER_FORMATS.md` has **no Dhan section**. `lib/import/dhan-ledger.ts` EXISTS (CSV text,
`/api/import/ledger`) but is **not in `registry-meta.ts`**. `dhan-gtr` = Global Transactions
(equity-only); `dhan-csv` = Profit & Loss (no dates, no product).

**Testing.** The engine is well pinned; the SHAPE of a whole file is not — no test asserts
closed/open/opening-sell counts for any real export, and the only pairing guard is conservation
(a mis-shaped-but-conserved book passes). `tradeStatsOf` (every /trades tile) has **no test**.
`pairLegs` models a genuine short sell as opening-sell + orphan long; NSE-buy/BSE-sell of one
symbol silently merge; `private-reconciliation.test.ts` is `skipIf` private-only; the load suite
(paise fidelity) is excluded from `npm test` and absent from CI; futures unexercised (the owner
may have ONE Dhan futures trade — the Realised P&L / Contract Note will reveal it).
**Stale in VYUHA-STATE:** the Zerodha F&O compact grammar IS parsed now.

**Symbols.** `scripts/build-isin-symbols.mjs` already downloads NSE `EQUITY_L.csv`, NSE Emerge
`SME_EQUITY_L.csv` and BSE `ListofScripData` and DROPS company name, BSE `SCRIP_CD`, series, listing
date. Enriched snapshot measured: **5,672 ISINs, 389 KB raw / 129 KB gzip (+247 KB)**. Two bugs
in `lib/import/instruments-file.ts`: `:154` matches `NAME OF COMPANY` but the SME file ships
`NAME_OF_COMPANY`; `:158` drops every `ST` series row (all 125 SME). TECHNOCRAT = `MARC` on NSE
Emerge. `nsearchives.nseindia.com` is already allow-listed (bhavcopy); `api.bseindia.com` is not;
PRIVACY.md's "exactly four kinds… no fifth thing" ships in two client packages. Cadence: 2026 YTD
≈ 1.6 new listings per trading day — 12 h gains ~1 row over daily; per-release + Instruments upload
is honest. **TRADE-SENTINAL (read-only, nothing changed):** its
`classification-reconciliation-multisource.csv` (2,305 rows: symbol, isin, bse_code, macro_sector,
sector, industry, basic_industry, confidence) is the only artefact adding sector beyond the 1,155;
its universe is NSE-only and partly under non-redistributable licences — copy the CSV once, as data.

**Search.** Bundled SQLite 3.53.2 has **FTS5 with the trigram tokenizer** (probe-confirmed).
Command palette indexes 43 nav items + 4 actions, 4-tier substring rank, hand-written keywords
that duplicate `HELP_ENTRIES[].keywords`. `/trades` filters client-side over a ~22 MB `SlimTrade[]`
payload and reads 3 fields; any server `WHERE` reorders `(sell_date, created_at)` ties and moves
float sums. No index on `symbol`, `tradingsymbol`, `isin`, `broker`. Deep-links: `/trades` honours
`add|symbol|from|to|realised|segment` via a mount effect then `history.replaceState` wipes the
query; **two dead links shipped** (`?basis=unknown`, `?view=open` from data-quality) plus template
links from the dashboard. `NavHistory` stores pathnames only. Nine searchable tables have no
`account_id`. Names: 1,155 (index map) + user instruments. `@radix-ui/react-popover` is a dependency
with zero usages; `DataTable` has an unused `globalFilter`; `use-list-drag.ts` is 1-D only.

**Installer / licence / macOS.** `bundle.windows.nsis` omits `deleteAppDataOnUninstall` → Tauri
default → the stock "Delete the application data" checkbox renders at uninstall AND mid-upgrade,
naming neither the journal nor the licence. `docs/client/README.md:443`, `README.md:699,792` and
the deck claim uninstall never deletes data — false if ticked. A backup envelope would NOT have
saved the key (`lib/backup.ts` blanks `licenseKey`). Keys are stored in full in
`license-ledger.jsonl` (`scripts/license-list.mjs <keyId> --full`); the owner's lifetime key was
recovered that way. `clockHighWaterMark` lives in the wiped DB (a wipe = clean trial; accepted).
**macOS: `Vyuha_3.7.1_aarch64.dmg` and `_x64.dmg` exist on every release**, unnotarised, never run
by anyone; nothing macOS exists locally; the client packager is Windows-only.

---

## 1. v3.8.0 "Trust the import"

### WS1 — Paytm correctness (money; own audit rigour)
1. **Key pairing on ISIN** when present, `Script` as fallback; keep the stated-product half of
   `groupKey`; display `tradingsymbol` = the non-numeric label seen for that ISIN, else the code
   (commit still resolves). Update the executions filter (`:367-373`).
2. **Product by signature**: route `mixed` scrip-days through `splitMixedRow` (as `dhan-gtr.ts:247`
   does) so the intraday portion is booked intraday; fix `corroborate()`'s denominator to
   buy+sell for two-sided rows.
3. **`dedupHash` migration (0059)**: recompute for stored Paytm rows so re-import de-duplicates;
   the migration must be idempotent and must not touch other brokers. Owner chose migration (a).
4. **Copy fix**: `acquisition-panel.tsx:151` — proceeds are NOT in Net P&L; only charges are.
5. **Import-time shape warning** (product-side twin of the harness): when opening-sells exceed a
   stated share of positions, or a security appears under two labels, say so on the import summary
   ("71 sales without a purchase — review before trusting Net P&L") with a link to the quarantine.
Tests: extend `tests/fixtures/redacted/paytm-tradebook-v2.xlsx` with one security traded as
`SYNTICK` in month 1 and `999xxx` in month 2 under one `INE0SYN…` ISIN → 1 closed, 0 opening
sells, 0 open; the signature cases from the research report (one mixed scrip-day → intraday value
within 1%; one delivery same-day → stays delivery and `corroborate` true); the hash migration on a
pre-fix row. Fix `docs/BROKER_FORMATS.md` Paytm Trade Time claim.

### WS2 — Golden-book harness + the KPI link
`tests/golden-books.test.ts`, table-driven per broker: `{file, reference:{source, grossOrNet,
charges}, shape:{sourceRows, closed, open, openingSells}, tol}`. Four legs per row: routes to the
expected parser ≥ 0.7; **shape counts exact**; Σ gross/net within tolerance of the broker's own
figure (or `reference: null` stated, never skipped); Σ charges conserved. Then commit into a temp
DB and assert `tradeStatsOf(getJournalTrades())` equals the same numbers. **Un-`skipIf` the private
reconciliation** by committing redacted-but-populated copies (owner Q11: yes). **Load suite joins
CI** (`test:load` in the `check` job; owner Q10: yes). Fixtures the owner supplies (redacted,
three-row rule): Dhan ×2 accounts (list in §3), Paytm (equity), Groww (equity + P&L), Zerodha
(equity + F&O), Upstox and Angel One (limited equity + F&O). Name the shorts: `pairSymbolLegs`
distinguishes a covered short from an opening sell (or refuses and says so); split positions by
exchange with a stated note.

### WS3 — Dhan connect + two parsers
Client ID hydrated from the saved row (`!apiKey` → `!apiKey && !saveTargetConn`; route carries
stored `api_key` when a row exists, the `auth_json` pattern at `route.ts:391-398`); the gate
exported as a pure `saveDisabled(state)` and pinned (`tests/broker-connect-gate.test.ts`, node
env); **mode label on every connection row** — "PIN + TOTP · mints its own token" vs "pasted token
· expires <ts>" — highlighted, with a one-time pop-up when a pasted-token connection expires;
`dhanTotpMode` initialised from `hasAuth`; **retry-on-401**: with enrolment present, clear the
cache, mint once, retry; **never swallow an unreadable `auth_json`** ("enrolment stored but
unreadable — re-enrol"); `jwtLooksUnexpired` rejects ms-epoch; two-account enrolment-preservation
test; the All-accounts "Save connection" must name the account it will write to. **Parsers:**
register `dhan-ledger` in `registry-meta.ts` (CSV; MTF interest / dividends / DP charges → ledger);
build **Dhan Realised P&L** (the golden-book reference). Write the Dhan section of
`docs/BROKER_FORMATS.md`. MTF Report + Contract Note → v3.9.

### WS4 — Symbol universe (enriched bundled snapshot) + SME importer
`build-isin-symbols.mjs` keeps `name`, `bseCode`, `board`, `series` (+247 KB); the resolution
chain gains a **BSE-code lookup keyed on the code, never the ticker** (FOCUS/HSIL/KALYANI are
different companies on the two boards); NSE still wins an ISIN collision; delisted/non-equity
filters kept. Fix `instruments-file.ts:154` (`NAME_OF_COMPANY`) and `:158` (allow `ST`). Copy
Sentinel's sector CSV once as `lib/data/sector-map.json` with `asOf` + provenance; **Sentinel is
never touched**. Refresh cadence stays per-release; Instruments upload is the escape hatch.
Tests: SME file imports; TECHNOCRAT/MARC resolves by name; a BSE code resolves; a collision keeps
NSE; `isin-bundle-coverage` skips-not-reddens on absence.

### WS5 — Pre-open band + session-review leak
`SESSIONS` gains `{key:"preopen", from:"09:00", to:"09:15"}`; `exitClock` follows; the band names
the FILL (a pre-open order filling at 09:15:00 is indistinguishable from a regular fill — state
it). `session-review.ts:49` reports coverage for null-time trades instead of treating null as
"before cutoff". Tests: `sessionOf("09:07") === "preopen"`; `timeEdge().offHours` no longer counts
it; coverage sentence present.

### WS6 — Installer guard + docs truth
`src-tauri/installer-hooks.nsh`: `NSIS_HOOK_PREUNINSTALL` MessageBox naming **the journal
database and the licence key**, then `CopyFiles` of `%APPDATA%\in.vyuha.tradejournal\*.sqlite` +
`attachments\` to `%USERPROFILE%\Documents\Vyuha-backup-<date>\` before any deletion (raw copy, not
the envelope — the envelope blanks the key). Fix the three "uninstall never deletes" claims. Owner
sets `VYUHA_KEY_ARCHIVE_DIR` permanently (recorded, not code).

### WS7 — Deep-link contract + Search v1
Repair the contract first: `/trades` honours `basis=unknown` and `view=open`; the query string is
**kept** (not wiped) so results are re-enterable and browser Back works; dashboard template links
audited. **Search v1** in the command-palette shell (Ctrl+K anywhere + a search box on the main
tabs where feasible): **FTS5 external-content table over `trades`** (symbol, tradingsymbol, isin,
broker, setup_tag, notes, mistake_tags, emotion_tag, exit_trigger) synced by trigger, **returning
ids only** — the page keeps its own ORDER BY, so no tie-order change (migration 0060 + indexes on
`symbol`, `isin`, `broker`); **in-memory** search over the enriched symbol snapshot (name, ticker,
BSE code) and over playbooks, instruments/aliases, sessions, challans, help entries and screens;
category chips; **per-source account scoping** (nine tables have no `account_id` — scope is carried
per source, and a new guard test asserts it); **gated destinations shown with a lock + one line on
what unlocks them, never hidden; a user's own trade rows never locked** (owner decision); a
**search-session back stack** (previous query/results) AND a "back to where I was" control (both —
owner decision), neither using `router.back()`; palette keywords derived from `HELP_ENTRIES`
(kill the duplicate). Tests: FTS trigram mid-word hit; ids-only contract (a source guard that the
search never adds an ORDER BY to a trades query); scoping per source; gating per result; the two
backs; **`tests/load/search-N.load.ts`** — N ranked queries against the 25k book with timing and
`growthRatio()`; **`e2e/z-search.spec.ts`** — a few hundred keyboard/click cycles with
`expect.poll`, category chips, both backs, Ctrl+K parity with the existing palette spec. Audit
log and ledger search → v3.9.

### WS8 — Banked audit items (all three; owner Q20)
`recordAudit` key-set assertion (throw in dev/test, log in prod; `before: null` stays legal) + the
single-binding convention; `getWriteAccountId()` refuses 0 and the explicit-id callers are fixed;
one `todayInIst()` in `lib/analytics/week.ts` migrating the four IST copies and `rates.ts`'s UTC
`todayIso` consumers (with a source guard). Plus the registry-debt OWNERS entries.

### Verification protocol (v3.8)
Wave 0 baseline double sweep → Wave 1 migrations (ONE agent: 0059 dedup-hash, 0060 FTS +
indexes) → Wave 2 pure/queries/parsers → Wave 3 UI → Wave 4 perf (search must not move any
swept route; `/trades` stays out of scope) → Wave 5 docs/claims (client package, PRIVACY unchanged
— no new egress) → **Wave 6 adversarial audit (6 finders) → fix wave → Wave 6b adversarial audit
of the FIX WAVE** → Wave 7 release skill. Bundle markers: `preopen`, `Realised P&L`, `Search`,
the mode label string. Perf: the enriched snapshot must not move the dashboard; measure.

---

## 2. v3.9.0 "Trust the numbers"

- **Broker-truth reconciliation screen**: import the broker's Realised P&L beside the tradebook;
  show "broker ₹X · Vyuha ₹Y · Δ ₹Z" per FY and per scrip with the reasons (unpriced sales, product
  differences, charges the file omits). Paytm `Realized P&L Detail` (sheet 2 of the `.xls`) parser;
  Dhan Realised P&L (from v3.8) wired in.
- **Floating search assistant**: a Radix-Popover-anchored, pointer-draggable panel (extend
  `use-list-drag.ts` to 2-D or a small dedicated hook — no new dependency) persisted under
  `vyuha-search-panel {v:1,x,y,open}`; stays open across navigation; audit log + ledger join the
  index.
- **`/trades` server pagination** — its own change with its own before/after proof: total order
  `(sell_date, created_at, id)`; measure `taxByFy` last-paisa movement, harvest lot status flips,
  holding-clock top-15 membership BEFORE and AFTER on the real book and the perf book; the
  `created_at` batch-tie fact stated in the release note.
- **Dhan MTF Report + Contract Note parsers** (fill times, F&O instrument type — the only Dhan
  source with either); the futures path finally exercised if the owner's one trade surfaces.
- **Short-sell and cross-exchange modelling** in `pairSymbolLegs`.
- **Search v1 hardening** from v3.8 telemetry-free feedback: the owner's own use.
- Live Desk → **v4.0**. **KEEP ADAPTABLE (owner, 2026-09-03): v4.0 absorbs a sector-mapping /
  deeper-analysis feature built from the owner's TRADE-SENTINAL and Chartink Atlas files (read
  those projects only, never write), plus a position-sizing calculator and tweaks he will share
  when v4.0 planning opens. REMIND HIM at that point and ask for the files via the pop-up. The v3.8
  Sentinel sector CSV copy (WS4) is the one-time seed, not that feature.**

---

## 3. Owner inputs (owed before/at v3.8 build)
- **Dhan, both accounts**, journal.dhan.co → Statements & Reports → Equity & F&O, each for FY
  2025-26 AND 01-Apr-2026→today: Ledger Summary (**CSV only**), Realised P&L, Profit & Loss, Global
  Transactions, MTF Report (an MTF week), Dividend Payout, DP Transaction Charges, Holding Summary
  (today), and the **Contract Note** for the futures day. Redaction: three-row rule, names/UCC/PAN
  only, dates unchanged.
- Paytm (equity), Groww (equity + P&L), Zerodha (equity + F&O), Upstox + Angel One (limited).
- Test the macOS DMG when a Mac is available (first-ever data point on darwin activation).
- Set `VYUHA_KEY_ARCHIVE_DIR`.

---

## 4. Wave plan — VERIFIED against the v3.7.1 tree and OWNER-APPROVED 2026-09-04

Seven read-only recon agents checked every §0/§1 claim on 2026-09-03/04. Corrections that changed
the shape (full record in `docs/DECISIONS.md` 2026-09-04):

- **WS1.** `dedupHash` hashes broker|tradingsymbol|qty|price|value|dates and commit already resolves
  codes→tickers via ISIN before hashing, so unsplit positions keep their hash; a merged position is a
  NEW row by construction — no migration can absorb the two phantom rows. **0059 re-keys Paytm hashes
  ISIN-first** (label-independent), and WS1 adds a **broker-scoped "Remove this broker's imported
  rows"** (account-scoped, trash snapshot, audit-logged, confirmation) so the owner's book is
  re-imported clean. `dhan-gtr.ts:247` only writes a NOTE for mixed days; Paytm needs a real split of
  the scrip-day accumulator (`paytm-tradebook.ts:323-344`) via `splitMixedRow`
  (`product-signature.ts:146`). `corroborate()` (`:109-121`) is never called by Paytm today. The copy
  is at `acquisition-panel.tsx:152`. No quarantine route exists — the warning links to `/trades`.
- **WS3.** The broker GET masks `api_key` and never returns it (`route.ts:216-249`). Hydration =
  relax the gate when a saved row exists + carry the stored key server-side on re-save (owner ruling).
  Retry-on-401 belongs in `dhanGet` (`dhan.ts:392-413`) / `resolveDhanAccessToken` (`:366-390`).
  `dhan-ledger` lives at `lib/import/parsers/dhan-ledger.ts`; registering any source needs
  `PARSERS`+`DETECTORS` (`detect.ts:47-80`), a help card (`import-help-content.test.ts:48-54` joins
  both ways) and a mutual stand-down with `dhan-csv` (`dhan-csv.ts:18`). `totpAckVersion` must be
  written or enrolment silently degrades (`route.ts:540-544`).
- **WS8.** The helper is `todayIstIso` (`lib/queries/challans.ts:117`); `todayInIst` exists nowhere.
  Four inline IST copies (`app/review/page.tsx:86`, `lib/queries/session-plan.ts:57`,
  `components/behavior/session-planner.tsx:26`, `components/review/review-open-card.tsx:34`) plus
  `rates.ts:94`'s UTC `todayIso` with **11 consumers, 5 inside `commit.ts` pricing** — the owner
  ruled **migrate all eleven**, gated by a before/after charge comparison on the owner's book.
  `getWriteAccountId` refuses explicit AND implied 0 (typed error); `tests/account-isolation.test.ts:203`
  inverts; five workaround callers (`dismissals.ts:49`, `review.ts:205`, `challans.ts:227`,
  `ipos/route.ts:162`, `settings/route.ts:28`) are simplified. `recordAudit` has 73 call sites,
  3 legitimately `before: null`. No OWNERS file or registry-debt list exists — dropped.
- **WS6.** Only `docs/client/README.md:443` claims "uninstall"; `README.md:699,791-792` say
  "reinstalls"; the deck says nothing. Claims audit and bundle-marker check are prose steps in the
  release skill (no script). `licenseKey` is blanked at `lib/backup-format.ts:83`. The sidecar sets
  `VYUHA_DB_PATH` (`desktop-server.mjs:154`) so `attachments/` sits beside the DB — copy target holds.
- **WS7.** FTS5 + trigram confirmed (SQLite 3.53.2). `router.back()` IS used (`back-button.tsx:47`,
  `nav-history-tracker.tsx:52,60`) — both search backs must not double-fire. `perf-sweep.mjs` has no
  exclusion list and writes no file; `/trades` is swept and breaches (~2.0 s) — "out of scope" =
  compared, not fixed. `mistake_tags` is JSON text — flatten with `json_each` in the FTS trigger.
  Palette = 43 nav + 4 actions, 27 hand keywords; `HELP_ENTRIES` has 43 `keywords` arrays.
  Tables without `account_id`: playbooks, instruments, symbol_aliases (challans, sessions HAVE it).
- **WS4.** Snapshot is a static import, eager, loaded by `commit.ts` and `app/api/sessions/route.ts`
  only — never the dashboard. Count 5,671. `instruments-file.ts:161` is an ALLOW-list
  (`EQ/BE/BZ/SM/""`). Egress allow-list = `tests/egress-guard.test.ts:36` (`scripts/` unscanned).
  PRIVACY ships in THREE client packages. **Sector seed waits for the owner's own Sentinel files
  (ruling 2026-09-04) — see the sector/industry/indices plan when it lands.**
- **WS5.** `SESSIONS` at `cockpit.ts:107-113`; `tests/cockpit.test.ts:41-44` pins `sessionOf("08:00")
  === null` (keep); literal "09:15–15:30" at `app/arjuns-eye/page.tsx:334`; no fixture has a
  09:00–09:14 stamp.
- **WS2.** Private reconciliation runs on the owner's box today (all three private files exist) and
  pins exact counts — redacted copies need re-derived assertions. **Three-row rule (owner ruling):
  keep every row; replace names/UCC/PAN with fixed tokens; every distinct case keeps ≥3 real rows.**
  Load suite → **dedicated `load` CI job**, required green, listed in the release skill.

**Waves.** W0 baseline (verify EXIT echoed; perf sweep #1 on seeded prod build) → W1 ONE migration
agent (0059 `data_fixes` marker + TS post-migrate Paytm hash re-key; 0060 FTS5 external-content +
triggers + indexes symbol/isin/tradingsymbol) → W2 pure/server in parallel (WS1 parser + remove,
WS3 server + parsers, WS4, WS5+WS8, WS7 server, WS2 harness) → W3 UI → W4 perf sweep #2 + load +
e2e → W5 docs/claims/README counts → W6 6-finder audit → fix wave → W6b audit of the fix wave →
W7 release skill + client ZIP + WDSI. Every fix: test proven red by reverting. One verify per wave.
