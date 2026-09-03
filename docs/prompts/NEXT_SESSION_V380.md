# Opener for the v3.8.0 build session — copy-paste after `/clear`

Read VYUHA-STATE.md (repo root) first — verified 2026-09-03: v3.7.1 is PUBLISHED, mirrored,
WDSI-submitted, installed clean on a non-build machine; no open release actions. Live Desk
slid to v4.0.

Task: build **v3.8.0 "Trust the import"** exactly per the owner-approved spec in
`docs/V380_BUILD_PLAN.md` (twelve decisions taken 2026-09-03, all via pop-up; research in
`docs/DECISIONS.md` 2026-09-03, eight entries). Eight workstreams: WS1 Paytm ISIN-keyed pairing
+ charge-signature product + `dedupHash` migration + the false banner sentence; WS2 golden-book
harness with EXACT shape counts + `tradeStatsOf` test + un-skipped reconciliation + load suite
in CI; WS3 Dhan connect full set (Client ID hydration, pure gate test, mode label + expiry
pop-up, retry-on-401, unreadable enrolment surfaced, ms-epoch guard, two-account test) +
`dhan-ledger` registered + Dhan Realised P&L parser + a Dhan section in BROKER_FORMATS; WS4
enriched symbol snapshot (name, BSE code, board) + the two SME-importer bugs + Sentinel's
sector CSV copied ONCE as data (never touch TRADE-SENTINAL); WS5 `preopen` session band +
session-review null-time leak; WS6 installer pre-uninstall warning + raw DB copy to Documents +
the three false "uninstall never deletes" claims; WS7 deep-link contract repair (keep the query
string; fix `?basis=unknown` / `?view=open`) + Search v1 (FTS5 trigram over trades returning
ids only, in-memory over symbols/small tables, per-source scoping guard, gated results shown
with a lock never hidden, both backs, load test + stress spec); WS8 all three banked audit
items (`recordAudit` key-set guard, `getWriteAccountId` refuses 0, one `todayInIst`).

Two of these are LIVE on my own book today (VYUHA-STATE §7): the Paytm split and the Dhan
Client-ID box. Owner inputs are listed in the plan's §3 — ask me for the Dhan exports (both
accounts) before WS2/WS3 need them; I will supply Paytm, Groww, Zerodha, Upstox, Angel One
files too.

Same gates as v3.5–v3.7, non-negotiable: explore first with delegated read-only agents (keep
main context lean; probes ONLY as `tests/zzprobe-*.test.ts`, deleted before an agent reports,
and no stray `next dev` servers); verify every plan claim against the code before acting — the
plan's §0 is a map, not the territory; present the full wave plan for my approval BEFORE writing
any code; every fix lands with a test PROVEN red by actually reverting the change; stage-gate
with full `npm run verify` (echo the exit code, never a piped tail); migrations serialized
through ONE agent (0059 dedup-hash, 0060 FTS + indexes); one verify per wave run by the
orchestrator; keep the README test counts in sync at every gate (six unit figures, four e2e
figures, comma-formatted ones included); the release does not ship without the multi-agent
adversarial diff-audit, then a SECOND audit over the fix wave (v3.7.0 was superseded unpublished
because its fix wave was never audited), the double perf sweep (search must not move any swept
route; `/trades` stays out of scope), the claims audit (PRIVACY's "exactly four kinds" must stay
true — no new egress), and the `release` skill start to finish; update the client package with
every release and hand me the WDSI details unprompted. Present features' performance enhanced,
never disturbed — this all feeds the GLOBAL LAUNCH.

Standing reminder (raise it once, early): v4.0 Live Desk will absorb a sector-mapping feature
from my TRADE-SENTINAL / Chartink Atlas files plus a position-sizing calculator and tweaks I will
share — keep the plan adaptable; do not fold it into v3.8.

Ask me decisions in batches through the pop-up, options offered, your recommendation first
and marked. Model: Opus 5 for the build; nudge me to Fable only if a specific problem defeats
Opus across two distinct approaches or a money finding is contested.
