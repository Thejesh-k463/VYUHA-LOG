# V3.6.0 BUILD PLAN — "Navigate & Connect" (+ approved v3.7–v3.9 roadmap)

Owner-approved 2026-09-02 (all 11 decisions answered; recorded in DECISIONS.md 2026-09-02).
Grounded in two multi-agent research waves (2026-09-01/02): five read-only code recon reports
(capital architecture, broker-API layer, backlog verification, sidebar/nav, discipline + risk
internals) and five deep-research reports (Dhan API, all-broker APIs, Telegram alerts, Trade
Review Desk, openalgo-charts/Live Desk). Verify each claim against the code before acting on
it — the recon reports are maps, not the territory.

**Standing rules (unchanged from v3.5):** every fix lands with a test that reddens on the
reverted code; stage-gate with a full `npm run verify` (echo the exit code, never a piped
tail); the release does not ship without the adversarial diff-audit pass; the client package
is updated with every release; label claims VERIFIED or INFERRED; fixtures schema-only.
Agents must not git-stash/commit/checkout, must not npm install, must not run verify/build
while another agent edits — one verify per wave, run by the orchestrator.

---

## Roadmap (owner-approved slicing, decision #1)

| Bump | Theme | Contents |
|---|---|---|
| **v3.6.0** | Navigate & Connect | Sidebar redesign + customizer · Expected Capital goals · Dhan PIN+TOTP auth · Zerodha session exchange · opt-in auto-pull on launch · Telegram EOD alerts · guard pack · small verified fixes (b/f-losses seed+editor, popup/caveat cleanups) |
| **v3.7.0** | Review & Discipline | Trade Review Desk (Pro/lifetime-gated after trial — decision #8) · Discipline 2.0 · first-run onboarding · dated challan ledger |
| **v3.8.0** | Money correctness | `direction` column migration + backfill (partial by construction) · MTF interest via epochSpans (opt-in recompute — decision #10) · Dhan + Upstox historical backfill (grounded-payload rule) · futures path when a real file arrives |
| **v3.9.0** | Live Desk | OpenAlgo WebSocket Live Desk + regime/sector context (double consent incl. broker data-fee links — decision #9) · mark-model refactor prerequisite · Ollama insight narration · share-card funnel + referral codes |

Groww native adapter: DEFERRED (orchestrator's pick, owner delegated decision #11) — OpenAlgo
already covers Groww; native saves the user nothing (₹499/mo is Groww's fee either way).
Revisit on user demand.

---

## v3.6.0 workstreams

### WS1 — Sidebar redesign + customizer (S–M)

Approved grouping (decision #5; new group name **"Back Office"**):

- **Overview**: Dashboard.
- **Positions**: Portfolio Risk visible; Option Strategies, Equity Tracker, Trade F&O Tracker collapsed.
- **Risk**: Targets—Equity + Trade Calculator visible; Targets—Trade F&O collapsed. (Surveillance MOVES to Back Office.)
- **Journal**: Trades, Lenses, Session Plan visible; Playbooks, Options Seller Journal, IPOs collapsed. Arjun's Eye MOVES to Analytics.
- **Import** (new group): Import visible; Import Help collapsed.
- **Tax** (new group, from Analytics): Tax Summary visible; Advance Tax, Tax Harvest, ITR Pack, AIS Reconcile collapsed.
- **Analytics**: Performance + Arjun's Eye visible; Report (PDF), Charges & MTF Leak, Broker Costs, Expiry Analytics, Return on Margin, Edge/Setups, Scaling & Replay, Discipline collapsed.
- **Back Office** (new group): Surveillance, Cash & Ledger, Corporate Actions, Symbol Aliases, Instruments (pick one visible: Cash & Ledger).
- **System**: Settings + Backup & Restore visible; Audit Log, Data Quality, Rule & Rate Packs, Help Desk collapsed.

Mechanics (from the nav recon):
- `nav-config.ts`: regroup the flat list; add `Import`, `Tax`, `Back Office` to `NAV_GROUPS`;
  add a default-visible mechanism (`NAV_DEFAULT_VISIBLE` map keyed by group, or `important`
  flag). Preserve `mergeOrder`/`moveIndex`/`moveWithinVisible` signatures (trades column
  order imports them).
- `sidebar.tsx`: per-group expand/collapse ("N more…" affordance); the third filter layer
  (full → workspace-visible → importance-visible) must feed the SAME filtered array to
  `moveWithinVisible` and to row registration — add a `tests/nav-order.test.ts` case for
  double-filtered reorder. Never hide the current screen's entry (same rule as workspace
  hiding, sidebar.tsx ~line 190). Migrate persistence to `useStoredValue` + versioned
  envelope `{v:1, groups, items, shown}`, MIGRATING the legacy un-versioned
  `vyuha-nav-order` value (do not discard a user's saved order).
- Customizer: promote/demote across the fold via the existing drag (second drop zone) PLUS a
  non-drag checkbox path (a11y: hiding items must not be pointer-only). Reset affordance kept.
- Coupled artifacts to fix in the same change (verified list): `tests/demo-video-copy.test.ts`
  (hard-coded group alternation — add Import|Tax|Back Office), `docs/owner/demo-video/02-SHOT-LIST.md`
  (group→label lines incl. Arjun's Eye move), `e2e/z-compiler-protocol.spec.ts` (assumes 4
  visible Positions items — reseed and assert under the new default + `expect.poll`),
  `scripts/demo-video/record.mjs` (`navTo` needs expanded groups or must expand first),
  `components/system/command-palette.tsx` (group rank strings follow automatically from
  NAV_ITEMS — verify "tax" ranking reads sensibly).
- `tests/workspace.test.ts` auto-enrols new groups; verify no group empties in any mode
  (pre-checked: none does).

### WS2 — Expected Capital / Goal tracking (M) [decision #4: ₹ AND % targets, per bucket, optional date]

- **Migration 0052** `capital_goals`: `account_id`, `bucket` ('equity'|'active'|'total'),
  `kind` ('absolute'|'pct_profit'), `target_paise` (moneyPaise custom type — comment the
  REAL-rupee legacy columns boundary), `pct_target` REAL nullable, `baseline_capital_paise`,
  `baseline_date`, `target_date` nullable, timestamps. Hand-written migration w/ prose
  header + `_journal.json` entry; seed NOTHING (no invented targets).
- **Pure math** `lib/analytics/goal.ts`: progress ₹/%, gap, trailing run-rate (30/90-day
  realised windows), required-per-week arithmetic when target_date set. Unit tests first.
  % goals with capital unknown → "—" + one Settings nudge (invariant 6); consuming files
  join `tests/capital-fallback-guard.test.ts` GUARDED_FILES.
- **Queries** `lib/queries/goals.ts` (server-only, `getSelectedAccountId`-scoped; aggregate
  view = sum of per-account goals, refuses writes). Register in
  `tests/account-isolation.test.ts` OWNERS; add to BACKUP_TABLES + backup schema map
  (✅ RESOLVED — BACKUP_VERSION stays 3; per-key restore makes the format compatible both
  ways, and merge DROPS source goals / trash keeps no snapshot: DECISIONS 2026-09-02),
  trash/merge/delete paths in `lib/queries/account-delete.ts` + `lib/trash-format.ts`.
- **API** `app/api/goals/route.ts` (route handler + fetch + router.refresh — never server
  actions), revalidate paths like `app/api/capital/route.ts` does.
- **UI**: Settings goal editor card (beside capital-card); Performance page goal card +
  target overlay on `CapitalGrowth` (recharts); dashboard badge; targets pages ladder tie-in.
  METRIC_HELP + HELP_ENTRIES entries (two-way drift tests).
- **Arjun's Eye**: new `lib/intelligence/rules/goal.ts` registry — descriptive facts only
  (run-rate vs required-rate arithmetic; PRESCRIPTIVE_LANGUAGE-clean; sampleFloor ≥ 10);
  register in `tests/intelligence-contract.test.ts` REGISTRIES with firing fixtures.
- **Pre-req fix (own commit):** Performance page reads GLOBAL settings capital, not the
  selected account's (`app/reports/performance/page.tsx:48` + siblings) — fix to
  account-first resolution with its own test, or the goal disagrees with the page.

### WS3 — Broker connectivity (M) [decisions #2, #3]

- **Dhan PIN+TOTP** (`lib/import/api/dhan.ts`): store `{clientId, pin, totpSecret}` in
  `auth_json` (exists, vault-encrypted; no migration); per-pull
  `POST auth.dhan.co/app/generateAccessToken?dhanClientId&pin&totp` → 24h JWT → existing
  `access-token` header calls. Reuse `lib/totp.ts`. Keep paste-token fallback
  (`needsToken` stays honest); legacy-connection detection → "reconnect Dhan" prompt.
  Consent screen: storing PIN+TOTP makes Vyuha a second factor — explicit copy, off by
  default. Broker-dispatch the `extraFields` branch in `app/api/import/broker/route.ts`
  (currently hard-coded to Angel One's shape). Fix the stale "valid for 24 hours" hint.
  Add export-list pin test (read-only-by-surface, like Angel One's). VERIFY EMPIRICALLY on
  the owner's account before claiming: whether generateAccessToken needs API-key mode
  toggled (flagged unverified in research).
- **Zerodha session exchange** (`lib/import/api/kite.ts`): implement
  `request_token + api_secret → SHA-256 checksum → /session/token` (user logs in via
  browser once daily, pastes request_token; Vyuha does the exchange). NO enctoken
  (decision #3). The F&O classification defect stays untouched (no real payload — recorded
  rule). Credentials: `api_key` + `api_secret` in vault (`auth_json`), access token cached
  for the day.
- **Auto-pull on launch (opt-in)**: settings toggle + once-per-day guard in the
  `auto_mtm_enabled`/`lastAutoMtmDate` render-guard pattern (no scheduler subsystem). Pulls
  only connections whose auth is unattended (Angel One, Dhan post-WS3, Upstox). Surfaces
  results through the existing preview/commit flow semantics (silent when nothing new;
  409s never auto-forced).

### WS4 — Telegram EOD alerts (M) [decision #6: per-user bot, own-risk consent, setup popup card, test alert]

- `lib/telegram/` (pure format module + server send): HTML parse mode; message = user's own
  numbers only (open positions/risk, capital deployed, day/week/month net, plan-adherence
  facts, journal-pending count) + "Your own recorded data. Not investment advice." footer.
  4,096-char cap respected; escape `< > &`.
- Settings → new "Alerts" card: opt-in flow = discretion/consent screen (plain copy: content
  transits Telegram's servers; at-your-own-risk; India blocking happens) → setup popup card
  (BotFather steps, token paste → vault; chat_id auto-discovery via one `getUpdates` after
  user /starts the bot) → test alert button ("✅ Vyuha connected").
- Trigger: in-app at/after configurable 15:35 IST while app open + catch-up-on-next-launch
  (`last_sent_date` guard, market days only). 5s timeout, ≤3 retries, degrade to a quiet
  in-app note. Never auto-retry into the night. No proxy support.
  *(As built: the degrade path is the in-app/dashboard note ONLY — the "local OS
  notification" half of the original line was NOT built and is deferred; no shipped copy
  may claim it.)*
- Token + chat_id in the AES vault; excluded from backups like other credentials.
- Settings columns via migration (0053): `telegram_enabled` (default false),
  `telegram_ack_version`, `telegram_send_time`, `last_telegram_sent_date` —
  machine-state columns (SETTINGS_MACHINE_COLUMNS, excluded from settings baseline so a
  restore never inherits consent — the OpenAlgo precedent, pinned by a forged-envelope test).

### WS5 — Guard pack + small verified fixes (S)

- **Egress guard test**: source-scan for outbound `fetch`/`https` hosts against an allowlist
  (api.dhan.co, api.kite.trade, api.upstox.com, angel endpoints, user-configured OpenAlgo
  host, api.telegram.org, NSE bhavcopy, update endpoint) — the "one outbound call" claim
  finally gets teeth; Telegram host allowed only behind its consent gate.
- **Advice-lint widening**: metric-help regex gains contractions ("you'd/you've/you'll
  need|want|have to"), PRESCRIPTIVE_LANGUAGE reviewed for the same; fix any copy the wider
  net catches.
- **B/f losses**: `computeTaxTimeline(byFy, seed: CarryForwardLot[] = [])` (verified
  one-line engine change) + migration 0054 `bf_loss_lots` table + small editor on
  `/reports/tax` + expiry-interaction test (seeded vintages hit `pruneExpired` on entry);
  capture `originalAmount` so the loss ledger renders real figures, not "—".
- **TradeReplay duplicated caveat**: delete the hardcoded second sentence in
  `components/reports/trade-replay.tsx:35` (metricCaveatLine already renders it).
- ~~Duplicate `Tile` in risk-cockpit-client.tsx~~ — STRUCK 2026-09-02, verified stale: the
  duplicated popup half was already deleted in v3.5.0 (it renders the shared
  `KpiDetailDialog`); the remaining local shell is the deliberate "density is the point"
  exception, recorded in the component's own comment (~lines 423-426).
- Popup rollout: migrate the reconstructed 10-tile list where a breakdown exists; leave
  static where density is the point (record which in DECISIONS).

### Verification protocol (every stage)

1. Unit tests for the pure module FIRST; then wiring. Red-on-revert proven for each fix.
2. One full `npm run verify` per wave, run by the orchestrator, exit code echoed. Never
   while a dev server runs.
3. e2e adds: sidebar collapse/customize spec; goals editor spec; (Telegram/broker flows are
   unit + contract-tested — no live creds in CI).
4. Before tag: adversarial diff-audit (multi-agent, refuters, live probes on migrated temp
   DBs — the v3.5.0 ritual that caught 10 bugs) + claims audit (release skill §10) — new
   claims: Telegram, goals, auto-pull; per-broker auth copy.
5. Release ritual per the `release` skill start to finish; client ZIP updated; mirror push
   from a real terminal.

### Performance guard (owner: "present features' performance enhanced, not disturbed)"

- No route regresses: re-run `perf:sweep` before/after on the six budgeted routes (two
  sweeps — variance lesson recorded 2026-08-31). Sidebar changes are client-light (no new
  deps); goals add one small query per page that shows them; auto-pull and Telegram are
  behind toggles and off the render path (fire-and-forget after paint).
- New tables carry indexes on (account_id, bucket) lookups; goal math runs on already-loaded
  trade projections wherever possible.
