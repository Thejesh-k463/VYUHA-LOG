# VYUHA — PROJECT STATE

Flagship project. Read this file first in any new session; it is the map, not the territory.
Everything below was verified against the repo on 2026-08-14, not recalled.

**This file deliberately does not repeat `AGENTS.md` or `docs/DECISIONS.md`.** Those are
canonical and kept current; copying them here would create two truths that drift apart.
This file tells you *where the answer lives*, *what state the project is in*, and *what is
left to do*.

---

## 1. What Vyuha is

A local-first trade journal for Indian retail traders, shipped as a **Tauri desktop app**
(Windows + macOS) with a Next.js standalone server running as a Node sidecar. Commercial
product with per-buyer licensing, a 7-day offline full-Pro trial, and a free tier that never
holds a user's own record hostage.

The product's differentiator is *honesty*: computed statutory charges land within **0.69%**
of a real broker report across 92 rows (STT, exchange, SEBI, stamp, IPFT, GST, DP, pledge),
brokerage explicitly excluded from the claim because it is not derivable from the file.
Reports return "—" rather than invent a denominator.

Positioning, pricing and the launch sequence live in `docs/owner/MONETIZATION_PLAN.md`.

---

## 2. Current state — verified 2026-08-14

| | |
|---|---|
| Version | **v2.99.94** |
| Branch | `main`, working tree **clean** |
| History | 133 commits, 55 tags, first commit 2026-07-01 |
| Latest | `198e542` — renewal notice, honest claims, two free SmartScreen fixes |
| Unit tests | **1,626 passing / 116 files, 10.7s** |
| Typecheck | **PASS** |
| e2e | 41 Playwright flows across 16 specs (not run in this pass — needs a build) |
| TODO/FIXME/HACK in app code | **zero** |

Code volume (excluding `src-tauri` vendored Rust deps):

| Area | Files | KLOC |
|---|---|---|
| `lib/` | 164 | 25.1 |
| `components/` | 110 | 16.4 |
| `app/` | 91 | 8.5 |
| `tests/` | 126 | 15.6 |
| `e2e/` | 18 | 1.6 |

Product surface: **43 screens**, 7 brokers' MTF lists (10,501 per-stock margins bundled),
6 auto-detected broker importers + PDF + generic column mapper, 3 live broker APIs.

---

## 3. Where the answer lives — read this before opening files

Routing table. Going straight to the right file is the single biggest accuracy *and*
cost win in this repo.

| Question | File |
|---|---|
| Can I change this? What will it break? | **`AGENTS.md`** — 10 invariants + conventions. Read before ANY code change. |
| Why is this constant/threshold what it is? | **`docs/DECISIONS.md`** (59 KB, dated entries, newest at top) |
| What shipped, when, and what broke | **`CHANGELOG.md`** (137 KB, 57 release sections) |
| What does the product actually do / feature copy | `README.md` (52 KB) |
| A broker file's exact columns + fingerprint | `docs/BROKER_FORMATS.md` |
| What can be imported at all | `lib/import/registry-meta.ts` — **the only source of truth** |
| Licensing, keys, revocation, refunds | `docs/owner/LICENSE_OPERATIONS.md` |
| Pricing, packaging, launch plan | `docs/owner/MONETIZATION_PLAN.md` |
| Signing, notarization, SmartScreen | `docs/owner/CODE_SIGNING.md` + `AGENTS.md` § Desktop build |
| What a buyer receives | `docs/client/` |

Two **project-scoped skills** exist in `.claude/skills/` and override the global ones for
this repo: `decision-log` (append a measured fact) and `prove-it` (verification before
claiming done). Use them.

---

## 4. Architecture — the shape that makes the maths testable

```
app/         Next routes, one folder per page, plus /api
components/  UI grouped by feature
lib/
  engine/    charges, classification, rate tables — PURE (no DB, no React)
  analytics/ every report's maths        — PURE (no DB, no React)
  import/    one parser per broker file, pairing, product inference
  risk/      position sizing, limits, margin
  queries/   the ONLY layer touching the database (server-only)
  domain/    shared constants and vocabulary
drizzle/     migrations, applied in order at startup
src-tauri/   Rust desktop shell
```

The rule that keeps it honest: **`lib/analytics/*` and `lib/engine/*` import neither the
database nor React.** Any reporting bug reproduces in three lines with no browser and no
fixture DB. Write maths there, unit-test it, then wrap it for the UI.

**Stack:** Next.js (React Compiler on), Tailwind v4, Drizzle + better-sqlite3, Tauri, vitest,
Playwright. Desktop DB lives in `%APPDATA%/in.vyuha.tradejournal`.

**Verify with `npm run verify`, never just `npm test`** — typecheck+lint+test all pass on
code that cannot be *bundled*, because client components import `lib/license.ts` and a
`node:` import in that graph only fails at `next build`.

---

## 5. What has been built — the arc

Detailed notes per release are in `CHANGELOG.md`. This is the shape of it.

**v1.x → v2.50 — the journal and the engine.** Core journal, charge engine reading rates
only from `charge_config`, pure analytics layer, staged positions, playbooks, backup/restore.
Licensing introduced from v1.16.

**v2.60 → v2.90 — product and vendor infrastructure.** Tier gating (v2.80), vendor control
(v2.86), tax stack, portfolio intelligence, free-vs-paid comparison (v2.96), safety-net
proving and the last mile of the tax stack (v2.98). `v2.90.1` was a **critical** fix: the
v2.90.0 installer ran on no machine but the build machine.

**v2.99.0 → v2.99.20 — platform and fit.** macOS support and the seller journal growing up
(v2.99.0), the व mark and readable tables (v2.99.5), file-in/typing-out (v2.99.6), sector
one-click and edge-by-theme (v2.99.7), broker-aware MTF (v2.99.8/9), the app fitting the
trader (v2.99.20), 7-day trial (v2.99.10).

**v2.99.30 → v2.99.60 — import breadth, scale, forensics.** Import from any broker + a new
skin (v2.99.30), calculator memory and self-importing exchange files (v2.99.40), the forensic
pass (v2.99.45), **built for the ten-thousand-trade book** (v2.99.50), fewer questions asked
and none twice (v2.99.55), one shared language across every screen (v2.99.60).

**v2.99.70 → v2.99.94 — trust, security, commerce.** Three skins and reflexive chrome
(v2.99.70), file self-proving + forgiving delete (v2.99.75), price as positioning (v2.99.76),
**the account boundary enforced everywhere** (v2.99.77), **secrets at rest — envelope
encryption, DPAPI-wrapped on Windows, no new dependency** (v2.99.80), **the first broker that
connects itself every morning: Angel One unattended via TOTP** (v2.99.90), **remote
revocation — the list travels down, nothing travels up** (v2.99.91), a release pipeline that
actually works (v2.99.92), five load-only defects of which two lost data (v2.99.93), and
renewal notice + retiring four claims that were not true (v2.99.94).

---

## 6. Bugs and issues fixed — by theme, with the lesson

The lesson matters more than the fix; each of these is now guarded by a test or an invariant.

**Import correctness.** A Groww order history imported as Zerodha and was priced at Zerodha's
rates — `detectZerodha` scored a filename word plus generic shape. Rule now: *a broker-named
parser must see the broker's NAME or an in-content fingerprint before claiming a file*; shape
is not evidence. `tests/import-detection-matrix.test.ts` pins a cross-broker refusal matrix
against redacted real exports. Dhan's "73 rows, 0 trades" was investigated and the import was
found **innocent**. Copy drift (screen advertised three brokers, code read five) is now
prevented by generating the dropzone hint from the registry.

**Data loss and recovery.** Delete now writes a snapshot first and *aborts if it cannot*.
Restore leaves the journal intact on any failure — attachments staged before the transaction,
table swap in one transaction, directory swapped only after commit. Backup thumbnails survive
a restore; whole-account delete stopped throwing.

**Scale.** The ten-thousand-trade book drove a slim projection + row virtualization on
`/trades`; cross-source import candidate bucketing took **8,003 ms → 20 ms** on a heavy book;
a 10-second page and an unprotected staged rebuild were fixed in v2.99.93.

**Account isolation.** Every account-scoped read goes through `getSelectedAccountId()`. A
query that forgets it merges two books into one tax pack **and nothing on screen looks
broken** — which is why `tests/account-isolation.test.ts` reads `account_id` columns out of
SQLite and fails on any table that gains one without a scoped read. "0 is a view, not a
place": the aggregate selection can never receive a write.

**Security.** Envelope encryption for credentials at rest, DPAPI-wrapped on Windows, no new
dependency. A broken vault refuses to save rather than store in the clear. Remote revocation
ships downward only. Pasting a 6-digit TOTP code where the secret belongs is caught at save.

**Release pipeline.** The desktop build ran every step twice. Installers shipped frozen at an
old version across v1.12–v1.20 — hence the rule to confirm `desktop-dist/.next/BUILD_ID` is
fresh and grep the bundle for a marker of the newest feature. Node pinned to 22.17.0; Windows
now tested BEFORE tagging; CI refuses to bless an incomplete release. The revocation list's
own release **must be a PRERELEASE** or it steals `releases/latest` and kills auto-update.

**Lockfile.** A plain `npm install` — no flags, fully installed tree — deterministically
prunes vitest's nested `esbuild@0.28.x` and 26 `@esbuild/*` entries, breaking `npm ci` on
every platform. Adding a dependency requires the hand-merge procedure in `AGENTS.md`.

**UI correctness.** A synchronous `setState` in a `useEffect` broke the Trades filter outright
under the React Compiler, with no error anywhere — derive, never state-sync. Server actions
remount sibling client components and silently reset their state, so settings/editor writes
use route handlers + `fetch` + `router.refresh()`. Tailwind v4 theme overrides must sit inside
`@layer base` or Lightning CSS drops them. A drag grip inside a `<th>` silently renamed the
column for screen readers. Contrast floors were re-measured (row separators need ~1.48:1, not
the handoff's 1.12:1; light-theme gold is `#8f6207`).

**Charts.** Anything reaching paper stays on recharts — canvas rasterises draw-time colours
and prints a dark chart on a white page. lightweight-charts renders an **invisible series with
no warning** if handed `color-mix()`, `oklch()` or an unresolved `var()`; chart tokens must be
literal colours, asserted by `tests/skin.test.ts`.

---

## 7. Live hazards — check these before a release

✅ **The stale `updater-private.key` was DELETED on 2026-08-14.** The repo root now holds no
signing key, and `.secrets/vyuha-updater.key` (348 bytes) is the only one left on disk.

Evidence gathered before deleting, worth keeping because it is the procedure to re-run if a
copy ever reappears from a backup:

- `tauri.conf.json` → `plugins.updater.pubkey` decodes to **`4FF85F3BBE1DA21D`**.
- **All 31 `.sig` files on disk** — every MSI and NSIS bundle from v2.98.0 through v2.99.94 —
  carry key id `4FF85F3BBE1DA21D`. A minisign signature stores its key id in cleartext, so
  this reads without any password.
- `scripts/tauri-build.mjs:35` resolves **only** `.secrets/vyuha-updater.key`. Since every
  artifact it produced is signed `4FF85F3BBE1DA21D`, that file *is* the live key.
- A repo-wide grep found **nothing** — no script, workflow or config — reading
  `updater-private.key`. Only prose warnings referenced it.
- The two key files differed (SHA-256 `5CDFA6BD…` vs `2AEE211C…`), so the deleted one was not
  a copy of the live key.

The deleted key was from the v2.91.0 rotation (old id `8FFAF1B491EAD2F0`) and had **negative**
value: signing with it produced a `.sig` the build reported as valid **while every installed
copy rejected the update** — which is what it did to v2.98.0. A session transcript claimed it
had already been "moved out of the repo root to `~/VyuhaKeys`"; it had not. If it reappears,
delete it again rather than keeping it "just in case".

**The rule that outlives it: verify a release by decoding the signature's key id, never by
trusting "✓ signed".**

✅ **PDF parser — checked 2026-08-14, NOT a defect, no action needed.** It returns `trades: []`
**by design**: `lib/import/registry-meta.ts:37-42` labels it *"PDF statement — reads the text,
does not import trades"*, with a comment recording that no broker PDF layout has been calibrated
and that it was previously mis-sold beside the six real parsers. It still exports
`detectBrokerFromText`, consumed by `lib/import/detect.ts`, and `tests/import-registry.test.ts`
pins the behaviour. A session transcript flagged this as a dead parser left registered — that
reading was wrong. **Do not delete it.**

⚠ **Paytm Money's parser was built from a schema-only sample.** It was a deliberate exception
to the never-invent-a-parser rule (DECISIONS.md 2026-08-12). **The first live Paytm import
must be reconciled against a contract note** before the parser is trusted.

⚠ **Never let npm rewrite `package-lock.json`** — see §6 Lockfile.

✅ Secrets hygiene is clean: `license-private.pem`, `updater-private.key`, `.secrets/` and
`license-ledger.jsonl` are all gitignored **and untracked** (verified).

---

## 8. Open work and future upgrades

Sections 8.1–8.5 were **recovered from the two build-session transcripts** (2026-08-05 → 08-13)
and exist nowhere else in the repo. Claims marked *(verified)* were re-checked against the code
on 2026-08-14; the rest are as recorded in conversation.

### 8.1 Blocking the sale — the owner's stated top priority

The owner's chosen priority at the last session's close was **"make it sellable first"**, over
further engineering. The reframing finding: **131 commits and 53 tags in six days produced 2
licence keys, zero of them annual.** The featured SKU has never been sold end to end.

- **v2.99.94 is built, tagged, pushed, CI-green on all three platforms and signed — but sits as
  an UNPUBLISHED DRAFT with 9 assets.** That is deliberate: publishing is the owner's
  per-release decision, never automatic.
- **Pricing — RESOLVED 2026-08-14: ₹9,999 is correct.** The repo already ships it
  (`lib/domain/pricing.ts:72`, *verified*), recorded as an "Owner reprice" at v2.99.76. An
  earlier session captured "₹7,999" from conversation; the owner has confirmed that figure is
  superseded. **No code change needed — do not "correct" the price back down.**
- **Delivery mechanism undecided** — GitHub release vs Drive vs WeTransfer.
  `docs/owner/CLIENT_DELIVERY.md` has **zero references repo-wide**.
- **`REFUND_POLICY.md` and `TERMS.md` ship inside the client ZIP carrying an owner-confirm
  banner that has not been read.** A buyer would receive them as drafted. The 7-day refund
  window was drafted conservatively and awaits sign-off.
- **Annual→Lifetime upgrade is advertised** (`lib/domain/pricing.ts:80`,
  `docs/sales/landing-page.html:329`) with **no proration, procedure or tooling**. Flagged as
  "build the procedure or remove the promise" — neither happened.

**Recommended first move:** sell one annual licence end to end — payment, receipt, mint,
deliver, activate.

### 8.2 Release-day actions never run

- `npm run winget:manifest` → `wingetcreate` submit PR to `microsoft/winget-pkgs`.
- Microsoft false-positive file submission.

Both need the release public first. This matters more than it looks: **SmartScreen reputation
accrues per FILE HASH**, so a 53-tag cadence guarantees every buyer meets a cold warning.
winget is the intended fix.

- **macOS notarisation not purchased** (Apple Developer ID ~₹8,300/yr). Mac users still hit
  "developer cannot be verified"; `notarytool` wiring waits on it.

### 8.3 Documentation staleness — 17 items open as of 2026-08-13

Worst offender: **`docs/client/GETTING_STARTED_DECK.html`** — says "v2.99" (lines 113, 116,
*verified*) against a shipped 2.99.94; title chips list 3 of 6 brokers (Angel One, Upstox and
Paytm appear zero times); the import slide omits three parsers and two API pulls; the Pro list
omits Lenses although `lib/license.ts:237` ships `/lenses` as Pro; and it gives Windows-only
install steps on a deck that claims Windows + macOS.

### 8.4 Engineering backlog

- **Load testing is 6 of 13.** A1–A6 built; **B1, B2, B5–B7, C2, C7** remain designed-but-unbuilt
  in `tests/load/README.md`, each naming the code it suspects.
- **PDF parser is dead but registered** — see §7 *(verified)*.
- **Zerodha F&O symbol grammar** — blocked on 3–5 real tradingsymbol rows the owner said he
  would supply; never delivered. The private tradebook on disk appears equity-only.
- **Intraday bar import** — named repeatedly as *the* analytical ceiling: MAE/MFE, trade replay
  and session edge are all EOD-bound. Blocked on a data-source decision that never came —
  Kite historical API (~₹2k/mo, **breaks the no-cloud promise**) vs user-pasted CSV.
- **First-run onboarding flow** — was the explicit #1 next-cycle pick, since trial→paid is the
  bottleneck and nothing guides a fresh install through import → mark → first review. Never built.
- **`v2.99.0` tag — checked 2026-08-14, KEEP it.** It points at `54c6a7c`, a real release commit
  on `main`, and matches a real CHANGELOG entry ("Vyuha runs on a Mac, and the seller journal
  grows up"). Only its GitHub *draft release* was deleted; the tag itself is legitimate history.
  An earlier session asked whether to delete it — the answer is no. `v2.97.0` was
  **deliberately never released**, so tags jump v2.96.0 → v2.98.0 *(verified)*.
- One commit on `main` **bypassed branch protection** (2 of 2 required checks skipped).
- A dead/unhydrated preview pane at the last session's end was disproven by real-browser e2e and
  **never root-caused**.
- Option-seller depth round 3 — scoped, never started.
- B1 share-card funnel and B2 referral codes wired into the licence scripts — planned as the
  "highest-leverage builds", never built.
- Retake the Settings skin-picker screenshot (seven swatches is a new listing surface).
- e2e suite not run in this pass; run `npm run test:e2e` before the next release.

### 8.5 Open questions the owner never answered

Which delivery link · refund-policy and terms sign-off · whether to collapse "theme" and
"accent skin" into one list (7 skins × light/dark keeps multiplying axes) · whether to publish
v2.99.94.

*(Three items left this list on 2026-08-14: Pro annual pricing — ₹9,999 confirmed, §8.1; the
`v2.99.0` tag — keep it, §8.4; the PDF parser — working as designed, §7.)*

### 8.6 Explicit non-goals — do not propose these

**No more brokers, no more report screens, no cloud AI, no backtesting, no new subsystems** —
"the codebase rewards consolidation". No paid code signing (free workarounds only). Taglines
must avoid outcome claims, SEBI-adjacent. Kotak Neo and Sahi stay on the generic column mapper
by design until a real export pins the layout.

### 8.7 Standing instructions from the owner

- *"Update the client package with all the latest features, upgrades and fixes properly
  (remember this every task has to be done)."* — treat as part of every release.
- *"SPECIAL CARE TO MONETIZATION PART"* — repeated across many turns.
- *"Tell me what fits this app's structure and what it costs, then build the one we agree on.
  Don't guess and implement."*
- **Fixtures are schema-only.** Real exports live gitignored in `tests/fixtures/private/`; never
  commit or quote identifiers. **Label every claim VERIFIED (against a real file) or INFERRED.**
- Scope searches to `app/`, `components/`, `lib/`, `e2e/`, `tests/`. No adjacent refactors.
- Reconcile the first live Paytm Money import against a contract note (§7).
- Public launch is planned as **"V.30.0"**.

---

**Growth engine** — `docs/owner/GROWTH_ENGINE_PLAN.md`, not started:
- Engine 1: content engine for X/Twitter, compliance-first, own account, automated.
- Engine 2: audience-research engine, **list-building only, no auto-outreach**.
- Guardrails and build order are specified in that file; the "Non-negotiable" section is
  binding.

**Monetization** — `docs/owner/MONETIZATION_PLAN.md`:
- Suggested 2–4 week launch sequence is written and not yet executed.
- Pine Script invite-only indicators launch kit exists (`docs/owner/INDICATORS_LAUNCH_KIT.md`,
  `PINE_SCRIPT_INVITE_ONLY.md`).

**SEBI posture** — read `PINE_SCRIPT_INVITE_ONLY.md` §Disclaimers alongside
`MONETIZATION_PLAN.md` §5 before any marketing copy ships. v2.99.94 already retired four
claims that were not true; hold that line.

---

## 9. How to work in this repo

1. **Read `AGENTS.md` first.** Its 10 invariants encode bugs that were expensive to find.
   Breaking one reintroduces the bug.
2. **Check `docs/DECISIONS.md` before re-measuring anything** or changing a constant that
   looks arbitrary. It records why the obvious alternative loses.
3. **Append to `DECISIONS.md`** whenever you measure something or deviate from a default.
   Use the project-scoped `decision-log` skill.
4. **`npm run verify` before claiming done** — not `npm test`. Use the `prove-it` skill.
5. **One task per session; `/clear` at boundaries.** Update this file before you clear.
   Measured on the sibling project: cost per call scales ~7.5× from <100k to ~1M context, and
   cache reads were 76% of spend. See `C:\Users\theje\.claude\skills\token-efficient-coding\`.
6. **Money is integer paise in the DB, rupees at runtime.** Converting twice is a 100× bug
   that unit tests did not catch — only a check against real data did.

---

*Maintained by hand. When it disagrees with `AGENTS.md`, `AGENTS.md` wins.*
