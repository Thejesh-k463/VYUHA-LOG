# VYUHA — PROJECT STATE

Flagship project. Read this file first in any new session; it is the map, not the territory.
Everything below was verified against the repo on 2026-08-20 (the broker-integration release and the OpenAlgo opt-in wave), not recalled.

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

## 2. Current state — verified 2026-08-21 (v2.99.100 release session)

| | |
|---|---|
| Version | **v2.99.100** — committed `f6e6324`, pushed 2026-08-21. Cut to ship the **pairing-engine quadratic fix** (C8). **Numbered a PATCH deliberately**: output is byte-identical and nothing about compatibility changed, so 3.0.0 would have signalled a breaking change that does not exist — the 3.0.0 milestone stays reserved for the public launch (§8.7). `2.99.99.1` was considered and is IMPOSSIBLE: Cargo rejects a fourth segment (`unexpected character '.' after patch version number`, tested on a scratch manifest). *Previous:* v2.99.99 — committed `e8198c2`, tagged `v2.99.99` (annotated tag `51b664d` → `e8198c2`), pushed 2026-08-20. Cut to ship the **Angel One live-pull fix**, which was broken in every build from v2.99.80 through the published v2.99.98. The OpenAlgo opt-in wave (`af228b5`…`b405ad9`) rides along **switched OFF and named in no buyer-facing document** — owner's standing decision: in-app only until a live pull is reconciled against a contract note |
| Branch | `main`, clean apart from this file |
| CI | **green on the release commit `f6e6324` — all 5 jobs — BEFORE tagging** (run 32478431386, conclusion `success`; no rerun needed). *Previous v2.99.99:* run 32380322684 on `e8198c2`, also all 5 green: Lint/typecheck/unit/build, **Windows install + tests**, Playwright e2e ubuntu, Playwright e2e macOS-14, desktop bundle macOS. **No rerun needed** — the ubuntu Playwright browser-install step, which hung twice on earlier releases, completed clean this time |
| GitHub release (v2.99.100) | **DRAFT with 9 assets, `isDraft=true`, `isPrerelease=false`** — Release workflow **32482047303** success on all 3 platform jobs. `npm run release:verify v2.99.100` → **all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"**. **`releases/latest` is STILL v2.99.99** and stays there until the owner publishes; `revocations` re-checked afterwards, still `prerelease=true`. Two-binaries gap reproduced a third time: the GitHub asset is **34,858,983 B** against the local/ZIP build's **34,863,579 B** — 4,596 B apart, so winget takes the GitHub hash and WDSI takes the ZIP's installer (DOC_AUDIT rows 15/16/20). **Owner only:** publish the draft · install on a non-build machine |
| GitHub release (v2.99.99) | **PUBLISHED by the owner 2026-08-20 15:46:10Z and is now `releases/latest`** (9 assets; a draft until then) — Release workflow **32380767740** success on all 3 platform jobs (Windows x64, macOS Intel, macOS Apple silicon). `npm run release:verify v2.99.99` → **all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"** (this check needs an existing tag, so it can only run after tagging; it verifies the CI-signed assets, which use the repo secret `TAURI_SIGNING_PRIVATE_KEY`, NOT the local `.secrets` key — a separate fact from the local build's signatures). `releases/latest` moved from v2.99.98 to **v2.99.99** on publication, so existing installs are now offered the update. `revocations` re-checked after publishing: still `prerelease=true`, untouched. The release asset `Vyuha_2.99.99_x64-setup.exe` is **34,861,983 B** vs the LOCAL/ZIP build's **34,860,149 B** — 1,834 B apart, confirming again that these are two different binaries (see the 2026-08-20 DECISIONS entry). **Publish DONE. Live Angel One pull DONE — see §7.** Still open, owner only: WDSI (use the ZIP's installer) · winget (uses the GitHub asset) · install on a non-build machine. **Do NOT create or re-publish the `revocations` prerelease — it exists and must stay a prerelease.** |
| GitHub release (v2.99.98) | `v2.99.98` was a **DRAFT with 9 assets** (Release workflow 32301883296 success; owner publishes); `release:verify v2.99.98` → all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish". **PUBLISHED by the owner 2026-08-20 03:23Z and is now `releases/latest`.** Its assets are built from `6e2dd80` — the commits after the tag are NOT in them, so the Angel One pull fix reaches nobody until v2.99.99 ships. Never re-upload assets onto a published tag: the updater compares versions, so an existing install would never be offered the same version again, and SmartScreen reputation and the ZIP's CHECKSUMS.txt are both per file hash |
| Client ZIP | `release-packages/Vyuha_2.99.100_Client_Package.zip` — 10 entries, installer SHA-256 `B89A225D…F14DD4`. Extracted and read: `WHATS_NEW.md` first heading `## New in v2.99.100`; TERMS/PRIVACY/REFUND all `Applies to: Vyuha v2.99.100 and later` dated 2026-08-21; deck carries exactly one version string; grep for `OWNER:`, `macos` and `pine script|tradingview` all return nothing. *Previous:* `Vyuha_2.99.99_Client_Package.zip` — 10 entries, installer SHA-256 `27D8695E…B23004`. **Extracted and read:** `WHATS_NEW.md` first heading `## New in v2.99.99`; `TERMS`/`PRIVACY`/**`REFUND_POLICY`** all `Applies to: Vyuha v2.99.99 and later` dated 2026-08-20 (REFUND carries that line for the FIRST time); deck contains exactly one version string, `v2.99.99`; grep for `OWNER:`, `macos` and `pine script|tradingview` over the extracted ZIP all return **nothing**; the packed `.sig` decodes to `4FF85F3BBE1DA21D`. **This installer is NOT the GitHub release asset** — see the 2026-08-20 DECISIONS entry on the two binaries |
| Unit tests | **1,920 passed / 0 failed** across 131 files — `npm run verify` EXIT 0 at `vyuha@2.99.100` (2026-08-21), including **both real-file reconciliations running rather than skipping**: Paytm's 414 executions against Paytm's own Realized P&L Detail, and the 1,554-fill Zerodha Console tradebook. That is the proof the pairing rewrite changed no behaviour. (Earlier: EXIT 0 twice on 2026-08-20: once on `b405ad9` as the pre-bump gate and again at `vyuha@2.99.99` after the doc edits and bump. (Earlier context: on `af228b5`; was 1,858/128 at the v2.99.98 tag — +60 from the OpenAlgo adapter, disclosure, route-gate, vault and backup tests). Earlier at the tag: 1,756 → 1,858 = +102 from the new parser, fixture-matrix, isin-symbol and reconciliation tests; the private-file tests skip on CI, so CI's count is lower by those) |
| Load tests | **14 files, EXIT 0 — 34 passed / 1 expected fail** (`npm run test:load`, 57 s, 2026-08-21). The expected fail is B7's standing `it.fails` pin for the double workbook decode. **New: C8 `tests/load/c8-pairing-depth.load.ts`** — written because an import-graph scan found **none of the thirteen existing cases imported `lib/import/pair-legs.ts`**, the hot path for five import sources, rewritten in v2.99.98 five days after the suite was built. It found a real O(n²): three O(lots) scans per sell (full-queue same-day pass, `.some()`+`.find()` inside the oldest-first loop, and a `splice` compaction). Ratios at 4n where linear is 4 and quadratic is 16: **15.89 → 3.70** (one symbol, growing queue) and **13.32 → 4.10** (opening-sell heavy); 50,000 legs on one symbol **775 ms → 63 ms**. Multi-symbol books were never affected (4.19, per-item flat). **Lesson recorded in `tests/load/README.md`: a load suite only covers the modules it imports** |
| e2e | **NOT run locally this session.** The evidence for v2.99.99 is CI run 32380322684, where BOTH Playwright suites (ubuntu + macOS-14) passed on the release commit. Last local run was 45/45 on 2026-08-20 before the OpenAlgo wave |
| Installer | `Vyuha_2.99.100_x64-setup.exe` **34,863,579 B**, SHA-256 `B89A225D19DF8EC7DBE3D739699DF2E91696517ED77C1E775556F2852DF14DD4`. **Freshness proven two ways:** `BUILD_ID` changed `KOKnpdVgOsrtwbhlnjiEn` → **`ePhn5BsghJc5jih4X42nT`** (17:05 IST 2026-08-21), and the shipped bundle carries the fix's own code shape — the per-date index and forward-only head pointer are present as `for(;g.head<g.arr.length&&g.arr[g.head].qty<=0;)g.head++` and `for(;s<n.length&&n[s].qty<=0;)s++`, while `.splice(` and `.some(` are GONE from the pairing window. NOTE a marker must survive minification: grepping for the local name `byDate` returns 0 because minifiers rename locals — grep string literals or code shape. Both `.sig` key ids decode to **`4FF85F3BBE1DA21D`**. *Previous v2.99.99:* 34,860,149 B, SHA-256 `27D8695E…B23004`; MSI 57,963,645 B, SHA-256 `068DCA47…57FEC4`. Both `.sig` key ids decode to **`4FF85F3BBE1DA21D`**, byte-identical to `tauri.conf.json` `plugins.updater.pubkey` (decoded from the local `.sig`, NOT trusted from the build's "✓ signed" line). **Freshness proven two ways:** `BUILD_ID` changed `2wW9bxykXfHZipbZHTgP3` → **`KOKnpdVgOsrtwbhlnjiEn`** (19:50 IST 2026-08-20), and the bundle carries `openalgo` (16 files) + `Integrations (advanced)` (3 chunks incl. a client chunk). **The Angel One fix is present in the built server chunk**, minified as `h=L[l]?.needsToken??!0; if(!d.ok||h&&!p.ok)` with `angelone` at `needsToken:!1` |
| Previous | v2.99.98 published 2026-08-20 03:23Z, superseded as `releases/latest` by v2.99.99 at 15:46Z the same day. **Its binary carries the broken Angel One pull** (built from `6e2dd80`) — anyone still on it must update |
| Defender FALSE POSITIVE (2026-08-22) | An installed v2.99.100 was flagged **`Trojan:Win32/Bearfoos.B!ml`, Severity 5** on the owner's machine — the `!ml` suffix is a MACHINE-LEARNING verdict, and it named the shortcuts, uninstall key and startup entry as well as `vyuha.exe`, so it is behavioural, not a content match. **The install had SUCCEEDED first** (17:09) and the flag came at 23:11. **Nothing reproduces on a static scan** at defs `1.457.274.0`: local installer, local `vyuha.exe`, the GitHub-built v2.99.100 installer and the GitHub v2.99.99 installer all scan clean, and a second user installed the same update repeatedly without incident. Assessed as a false positive on a cold unsigned hash. **v2.99.100 stays published** (both paying customers are friends and untroubled; no public download link). **WDSI SUBMITTED 2026-08-22 — all three binaries, owner holds the submission IDs** (one seen: `c622d257-60a3-4b83-8d74-d4b3b430c1fc` for the GitHub asset). Each went in as "Incorrectly detected as malware/malicious", detection name `Trojan:Win32/Bearfoos.B!ml`, product Microsoft Defender Antivirus (Windows 11), with an explanation naming the node.exe-sidecar architecture as the likely ML trigger. Three separate submissions because the flagged `vyuha.exe`, the GitHub asset and the client-ZIP installer are three distinct files with independent reputation. Status Pending at submission; expect an automated determination, and note that **empty "Analyst comments" and a greyed-out Rescan button are both normal** for a pending false-positive case. This supersedes the 2026-08-21 deferral, which was correct at the time because no detection existed. **The deadline is the winget merge**, after which strangers install unattended. Full analysis and the code-signing numbers: DECISIONS 2026-08-22 |
| Mirror | ✅ **CREATED AND PUSHED 2026-08-22** — `mirror` → <https://codeberg.org/Thejesh_ktr/vyuha-trade-journal>. Verified: `main` = `5fc2214` on both sides and **61 tags local = 61 tags on the mirror**. GitHub is no longer the only copy of the history — which matters more since the pre-v2.99.98 local release artefacts were deleted on 2026-08-20. Re-run `npm run mirror:push` after every release; secrets cannot travel because git only pushes tracked history. **The repo IS private** — verified anonymously: the page returns 404 (Codeberg hides existence from anonymous users rather than 403) and the git refs endpoint 401. **Auth is OAuth, not a username/token**: Credential Manager holds `git:https://codeberg.org` and `git:https://refresh_token.codeberg.org` both as `OAUTH_USER`, so it refreshes itself. **Expect an occasional "Authentication failed" from an agent session** — agents run with `GIT_TERMINAL_PROMPT=0`, which blocks the token refresh. That is NOT a broken mirror; run `npm run mirror:push` from a real terminal. The manually created `write:repository` token is unused and can be revoked |
| winget | **`scripts/winget-manifest.mjs` was DEFECTIVE and is fixed** (`f05c8ae`). It set `InstallerUrl` to the GitHub asset but hashed the LOCAL build, on a comment claiming they were "identical, since the same build produced both" — they are not. `--sha` is now REQUIRED; without it the script exits 1 printing the `gh release download` + `sha256sum` recipe. **Nothing had been submitted to Microsoft yet, so no bad manifest ever left this machine.** **SUBMITTED 2026-08-20 19:41Z — `microsoft/winget-pkgs` PR [#421585](https://github.com/microsoft/winget-pkgs/pull/421585), "Add ThejeshK.Vyuha 2.99.99", state OPEN.** `Manifest validation succeeded: True` — the hash fix held. **CLA SIGNED by the owner 2026-08-21** (`@microsoft-github-policy-service agree`, no `company=` — sole ownership): the `Needs-CLA` label is GONE, the PR is labelled **`New-Package`**, `mergeable: MERGEABLE`, `reviewDecision: REVIEW_REQUIRED`. **ALL VALIDATION PASSED 2026-08-21** — labels now `Azure-Pipeline-Passed` + `Validation-Completed` + `New-Package`; 11 checks SUCCESS, **0 failures**: stages 01 Pull Request / 02 Manifest / 03 URLs / 04 URL Domain / 05 Manifest Policy / 06 Catalog Content / **07 Installers Scan** / **08 Installation Validation** / 09 Installer Metadata / 10 Validation Completed, plus `license/cla`. The 6 CANCELLED jobs belong to two ASSISTIVE bots (`Missing Dependency Assist`, `Wingetbot PR Triage`) that stand down when there is nothing to act on — they gate nothing. **v2.99.100 SUPERSEDES the submitted version, and that is fine — do NOT open a second PR while this one is open.** Two PRs for one package confuse a volunteer reviewer, and the v2.99.99 release and its asset URL stay live so #421585 remains valid and mergeable. Correct order: let it merge, THEN `wingetcreate update ThejeshK.Vyuha --version 2.99.100 --urls <installer-url> --submit` (no CLA re-prompt; the manifest must still carry the PUBLISHED asset hash, not the local build). **Only remaining gate: a community-volunteer moderator must approve** (bot: "check-in policies require a moderator to approve PRs from the community"). Nothing further for the owner to do. **Two side-effects worth keeping:** (a) `07. Installers Scan` is MICROSOFT independently finding no malware in `Vyuha_2.99.99_x64-setup.exe`, matching the local Defender scan — further reason the WDSI deferral was right; (b) `08. Installation Validation` installed the release asset on a clean Windows VM with none of this machine's toolchains, which is the v2.90.0 failure mode and so PARTIALLY discharges the standing "install on a non-build machine" item — it does not prove the app launches and is usable, only that it installs. Submitted via the device flow (`wingetcreate token --store` → Credential Manager), NOT `--token` on the command line, which the tool itself warns gets logged — an earlier attempt pasted a PAT in cleartext and that token has been deleted and replaced |
| Two binaries per release | The GitHub asset and the local/ZIP installer are **different files** — v2.99.99: **34,861,983 B / `46A3842ADD7B91A65F493330B8FAAEE0A1B06A2DA76A52DBFBA4CB6C74EB4343`** (GitHub, for winget) vs **34,860,149 B / `27D8695E863D3426DE4016C86002C6A148E2F1A1E1457838A11835621BB23004`** (local, in the client ZIP, for WDSI and for buyers). SmartScreen reputation is per hash, so they accrue it separately. DOC_AUDIT rows 15/16/20 |
| Housekeeping (2026-08-20) | ~1.65 GB of stale build artefacts deleted — 28 MSIs older than v2.99.98 plus their `.sig`s, the v2.99.97 NSIS installer, the v2.99.96/.97 client ZIPs, and `release-2.98.0-corrected/` (a resolved Aug-5 incident folder). **v2.99.98 and v2.99.99 are kept in all three artefact classes.** All deleted paths were untracked AND gitignored — verified `git ls-files` returned 0 before deleting. `scripts/measure-slim.mjs` (a spent one-shot measurement) removed. **`scripts/license-revoked.mjs` looks like a typo-duplicate of `license-revoke.mjs` but is LOAD-BEARING** — it is the `REVOKED_IDS` source of truth; do not delete it |

**SHIPPED IN v2.99.99, SWITCHED OFF — OpenAlgo opt-in integration** (was "unreleased on `main`"
until 2026-08-20; the code is unchanged from `af228b5`, only its release status moved). It rode
along with the Angel One fix because holding it back would have meant holding the fix too. It is
**off on every install**, invisible until enabled, and **named in NO buyer-facing document** —
landing page, brochure, deck, client docs, CHANGELOG and README are all deliberately silent
(owner's call, 2026-08-20). The hold that remains is on the CLAIM, not the code: no copy may say
OpenAlgo works until a live pull is reconciled against a contract note.

*What it is:* a fourth broker-API import path through **OpenAlgo** — third-party, self-hosted,
AGPL-3.0, fronting 35 Indian brokers, of which **7 of Vyuha's 8** (all but Sahi). It gives Groww,
Upstox, Paytm Money and Kotak a same-day pull they have no native path for. Adapter
(`lib/import/api/openalgo.ts`, 20 tests) came from `T:\Thejesh\CLAUDE-CODE\OPENALGO-HANDOFF\VYUHA`
and is **byte-identical to that handoff** so rollback is a clean delete. Its endpoint shape,
today-only behaviour, the documented `quantity: 0.0` sample and the broker list were **re-verified
against OpenAlgo's own docs on 2026-08-20**.

*How it is gated (this is the owner's requirement, not a nicety):* **off on every install**;
`lib/domain/openalgo-disclosure.ts` (pure, 14 tests) holds the versioned what-it-is / what-it-does /
six-risks copy, the gate rule and a loopback check, and is the ONLY source of that copy; the Settings
→ **Integrations (advanced)** switch opens a disclosure dialog and only an explicit accept enables it,
stamping `OPENALGO_DISCLOSURE_VERSION`; **the acceptance is written to the Audit Log**; the **server**
applies the same gate on save and pull (**403**), so a hidden tab is never the only defence; the
Import tab does not exist until enabled; a **non-loopback host warns before saving**. Migration
**0049** adds `openalgo_enabled` (NOT NULL false) + `openalgo_ack_version`; both are
`SETTINGS_MACHINE_COLUMNS` and excluded from the settings baseline, so **a restore never enables an
integration or inherits someone's consent** (pinned by a forged-envelope test).

*Two defects found and fixed on the way, both worth knowing:*
1. **Angel One's live API pull has been broken for every user since v2.99.80** — `encryptSecret("")`
   produces `venc:1:<iv>::<tag>`, whose empty ciphertext segment `parseVaultString` rejects, and the
   pull refused on `!tokenRead.ok` before dispatching. Angel One is the only shipped
   `needsToken:false` broker. The guard now checks a token only where one is collected;
   `tests/vault.test.ts` pins the trap. **The fix SHIPS IN v2.99.99** (tagged 2026-08-20) — verified
   in the source at `app/api/import/broker/route.ts:260` and in the built bundle, where the minified
   guard reads `h=L[l]?.needsToken??!0; if(!d.ok||h&&!p.ok)` with `angelone` at `needsToken:!1`.
   **CONFIRMED AGAINST THE LIVE BROKER 2026-08-20 16:32 IST by the owner, on the published
   v2.99.99 build** — the connection reports "connected" and a Pull & commit returned
   *"Committed — 0 added, 0 duplicates skipped. Angel One returned no fills"*. That message is the
   SUCCESS path: it means the vault read, the `needsToken` guard, the TOTP-minted unattended login
   and the trade-book request all ran, and the book was simply empty on a day with no trades. The
   broken build could never reach that point — it refused with "the saved credentials cannot be
   read" before any network call. **DOC_AUDIT row 18 is satisfied for this release.** Still NOT
   exercised: an Angel One API pull carrying ACTUAL FILLS — row parsing, charge computation,
   product derivation and de-duplication on that path remain unverified until a trading day.
2. **My own regression, caught by the suite:** `openalgo_enabled` is the first NOT NULL column in the
   backup redaction list, and redaction wrote `null` → the restore INSERT violated the constraint and
   `restoreDatabase` returned `{ok:false}` (9 backup round-trip tests). Fixed with
   `settingsMachineBlank()`; both properties now pinned in one test.

*Not verified:* no live OpenAlgo instance was run — the pull path, the repair count on real rows,
whether OpenAlgo's "Kotak Securities" is Neo or legacy, and the dialog's rendered appearance are all
INFERRED. DECISIONS.md carries three entries dated 2026-08-20 for the above.

*CI on this wave:* **green on `f2c375a` — all 5 jobs, incl. Windows and BOTH Playwright e2e jobs
(ubuntu + macOS)** — run 32366386859, no rerun needed. Locally e2e was last run 45/45 before the
wave; CI's two suites are the post-wave evidence.

**v2.99.98 content (all verified 2026-08-20 — broker-integration wave, real files):** the owner
supplied real exports (gitignored in `tests/fixtures/private/`): Paytm Money tradebook (414 executions)
+ Equity P&L (`.xls`, 3 sheets, 124 realised lots), Zerodha Console tradebook (1,554 fills) + Console
P&L (53 rows), and three Upstox reports with ZERO data rows (schema-only). **No API client details were
supplied** (the Kite path is unchanged; Upstox API was offered and deferred — not built). Findings and
fixes: (1) both tradebook parsers aggregated a whole file per symbol and booked `sell − buy` — ₹2.17 Cr
(Paytm) / ₹31 L (Zerodha) of fabricated gain on sells of pre-window holdings → both now pair per
scrip-day through `pairLegs`; (2) `pair-legs.ts` learned **same-day first, then FIFO, opening inventory
as the oldest lot** from Paytm's own lot statement (which is charge-inclusive) — 47 of 52 in-window
scrips now agree within ₹25, closed net ₹12,34,049 vs Paytm ₹12,51,954 (−1.4%), residual = 3,200
shares of opening inventory the tradebook cannot see; (3) Paytm: product from the scrip-day STT/stamp
signature, six charge components apportioned (conserved to ₹0.16), numeric `Script` codes resolved by
ISIN at commit (instruments table → bundled NSE map → keep code + note; 20 of 66 resolve from the
bundled map), `sourceRows`; (4) Zerodha: Console preamble, serial dates, `Order Execution Time` for fill
times, 1,554 fills → 28 positions (15 closed / 2 open / 11 opening-sell), fingerprint weights 0.5/0.55
so neutral filenames route (0.75 / 0.70), Console P&L zero rows skipped — the Console P&L on disk is a
different period, so it could not reconcile the tradebook; (5) Upstox: A1 legal-name fingerprint,
header rows 11/22, `Trade Time`, `Buy/Sell Date`, `Buy/Sell Amt`, `Total PL`, `Speculation`→intraday —
layouts VERIFIED, values INFERRED; ledger has no header, not claimed; (6) seven schema-only redacted
fixtures (scratch transform + leak scan) in the matrix test under neutral filenames, a private replay
block, `tests/private-reconciliation.test.ts`; docs: `BROKER_FORMATS.md`, four DECISIONS entries
(2026-08-20), CHANGELOG, README, client docs, deck, landing/brochure pills, standalone rebuilt.
**Not done / not verifiable here:** a contract note (none supplied — Paytm's lot statement was the
reference); Upstox values; install on a non-build machine; winget + WDSI; publishing the drafts.
An early DRAFT of `lib/import/api/openalgo.ts` appeared untracked in the tree during that session
and was parked outside the repo so the v2.99.98 tree was exactly what shipped. **Superseded:** the
refined version from `T:\Thejesh\CLAUDE-CODE\OPENALGO-HANDOFF\VYUHA` (20 tests) was committed on
2026-08-20 in `af228b5`; the parked draft is obsolete and can be discarded.

**v2.99.97 content (all verified 2026-08-15):** installer node.exe lock fixed (`stop_sidecar()` on
Destroyed / ExitRequested / Exit / before update; NSIS pre-install/pre-uninstall hooks stop only
processes under `$INSTDIR`); every buy CTA opens `components/system/buy-dialog.tsx` (WhatsApp
+91 73936 73714, copy buttons) because the webview blocks external `_blank`; Settings → License
pills open the plan card; **Appearance**: `lib/domain/appearance.ts` → inline literal tokens on
`<html>` (`app/layout.tsx`), tint intensity 0–100, panel style flat/soft/luxe/glow, 9th skin
`custom` (7 fields × dark/light, WCAG badges), wallpaper upload (`app/api/appearance/wallpaper`,
`<data>/wallpaper/`, outside backups) with scrim slider; migration **0048**.

**Sales-assets pass (2026-08-15, after v2.99.97, docs-only — no release):** 22 screenshots
regenerated from synthetic fixtures by `scripts/retake-screenshots.mjs` (skin-royal.png deleted;
new: trades, options-journal, risk, settings-appearance, custom-theme, skin-lime/rose/ember);
`docs/sales/landing-page.html` gained a hero "why it wins" strip, a 10-shot gallery with
lightbox, a "Make it yours" skins section, a Features-vs-cost 3-column summary above the
comparison table, and a creators line — all copy derived from `lib/domain/pricing-comparison.ts`;
standalone rebuilt (5.7 MB, gitignored — the fallback attachment). **Landing page is LIVE:
https://thejesh-k463.github.io/VYUHA-LOG/** (GitHub Pages, `main:/docs`, `docs/index.html`
redirect → `sales/landing-page.html`; verified 200 on root/page/images; redeploys on every push
to `main`). `docs/owner/ZERODHA_PROPOSAL.md` — email to Kite Connect/partnerships + X thread/DM
to the Kamaths proposing a consent-based read-only feed. Next-session prompt:
`docs/SESSION_PROMPT.md` § "Next session — ready-to-paste".
`docs/owner/CREATOR_OUTREACH.md` — WhatsApp/email/X proposals, creator FAQ, review-key runbook
(offer = free lifetime key only). README brought current (badges 1,756 tests / 45 e2e flows in
17 specs, nine skins, Trades columns, Appearance, buy dialog, sidecar log, load-tested line,
PDF not an importer) and guarded by `tests/readme-claims.test.ts` (10 tests). Load tests **13 of
13 built**. Not done: install-on-non-build-machine; winget + MS submission
(`docs/owner/WINGET_AND_SMARTSCREEN.md`); key backup (`license-backup.mjs`); publishing the v2.99.97 draft.

**Monetisation pass (2026-08-19, docs-only):** README "Why Vyuha?" block reordered newest-first with a
`Now: v2.99.97` line and v2.99.93/94/95 notes added (guarded by `tests/readme-claims.test.ts` ordering
assertions); repo-wide staleness audit done. New owner kits: `docs/owner/RAINMATTER_APPLICATION.md`
(draft answers for Rainmatter's startup Google Form — pitch deck still to be built),
`docs/owner/CLIENT_FEEDBACK_FORM.md` (24-question client form spec), Zerodha contact map in
`ZERODHA_PROPOSAL.md` §0 (talk@rainmatter.com is the Kite Connect business address). GitHub
capacity incidents (Aug 2026) assessed: no code risk; mitigations = local repo + release copies +
key backup; a mirror remote is optional. Follow-up 2026-08-19: `docs/owner/RAINMATTER_DECK.pdf` built (14 slides,
1.15 MB, `docs/owner/pitch-deck/deck.html` + `build-deck.mjs`; owner placeholders [[N licences]], [[₹ amount]],
[[YOUR NAME]]/[[EMAIL]] remain); `docs/owner/forms/client-feedback-form.gs` creates the client Google Form;
`npm run mirror:push` / `npm run release:archive -- <dir>` + `docs/owner/RELEASE_RESILIENCE.md` (owner must still
create the mirror repo, run the archive, and run `license-backup.mjs`). Form script now also links a responses Sheet,
emails the owner per submission with running plan totals, and has `vyuhaSummary()` (not executed here — one test
submission by the owner will prove it).

**Owner's open to-dos (as of 2026-08-21):** **publish the v2.99.100 draft** — built, tagged, CI-green and signature-verified; until then buyers do not have the pairing fix · **do NOT open a winget PR for 2.99.100 while #421585 (v2.99.99) is open** — let it merge, then `wingetcreate update` · *(from 2026-08-20, still open)* *(v2.99.99 published 15:46Z and its Angel One pull confirmed live at 16:32 IST — both closed.)* **WDSI** — DEFERRED with reason: a Defender scan of the v2.99.99 installer on 2026-08-21 reported "found no threats", there is no detection history and Smart App Control is Off, so the form's REQUIRED `Detection name` field has no honest value. WDSI disputes detections; it does not grant SmartScreen reputation. Revisit when a buyer reports a real block, capturing the name from `Get-MpThreatDetection` and the version from `Get-MpComputerStatus`. Use the ZIP's installer with the installer extracted from the client ZIP (NOT the GitHub asset) · **install on a non-build machine** · **An Angel One pull carrying REAL FILLS** — the empty-book path is proven, the row-parsing path is not · run a live OpenAlgo pull and reconcile it against a contract note before any copy claims it works · fill the deck chips and submit the Rainmatter form ·
email talk@rainmatter.com + X thread (ZERODHA_PROPOSAL.md) · run the Apps Script, send the form link with each sale ·
create the mirror repo + `npm run mirror:push` · `npm run release:archive` to a drive · `license-backup.mjs` ·
refund/terms sign-off · winget + WDSI submissions · supply the broker **API client details** (the Paytm/Zerodha/Upstox FILES were delivered and verified 2026-08-20; only the API credentials remain).

**v2.99.96 content (all verified 2026-08-15, commits `99581e6`…`e889645`):** Trades table Qty /
Invested (MTF own-% from `buyValue − mtfFundedAmount`, never invented) / Entry / Exit replacing
Buy/Sell values (`lib/domain/trade-columns.ts`, 15 tests); Options Seller Journal KPI drill-downs
via `KpiCard detail` + outcome-mix recharts bar; **8 skins** (`luxe, mono, tape, sapphire,
aurora, lime, rose, ember` — ice/royal retired → sapphire via `asSkin`; surface tints;
hex-distinctness test); sidecar console hidden (`CREATE_NO_WINDOW`, log at
`<data_dir>/logs/sidecar.log`); load-test batch 2 with five fixes (numbers in DECISIONS.md
2026-08-15); `scripts/license-upgrade.mjs` (annual→lifetime full credit), `license-issue.mjs
--save-dir`, `license-backup.mjs` (AES-256-GCM); SKU labels + landing FAQ no longer mention
indicators; TERMS/PRIVACY apply-to guarded by `tests/client-docs-version.test.ts`;
`docs/owner/{REFUND_TERMS_SIGNOFF,WINGET_AND_SMARTSCREEN,DOC_AUDIT}.md`.

**v2.99.95 content (all verified 2026-08-15):** launch-offer anchors ₹13,000/yr and ₹35,999 are
COMMITTED 2027-01-01 list prices (end date deliberately not in-app; DECISIONS.md 2026-08-15 ×2,
MONETIZATION_PLAN §2). Savings derived AND FLOORED via `offerPct()`: **23% / 16%** — the
requested 30%/20% did not survive division, and a review pass caught 17% as a round-UP of
16.67%. `featured` = lifetime. New `lib/domain/pricing-comparison.ts` +
`components/system/pricing-comparison.tsx` (7 competitors, sourced 2026-08-15, † =
third-party-sourced). Roadmap copy: "every future upgrade at no extra cost — exciting, useful
features on the roadmap" (owner chose to drop the "planned, not yet shipped" label; "roadmap"
itself carries the future tense). v3 mark + favicon replaced the retired flat tile on
landing/brochure/deck; the deck's long-standing stray `</div>` was removed (tag-balance
verified). REFUND_POLICY gained the owner-discretion/tampering note (small text, literal \*…\*).
macOS selling removed everywhere — see §7.5 for the re-add map.

Code volume (excluding `src-tauri` vendored Rust deps):

| Area | Files | KLOC |
|---|---|---|
| `lib/` | 164 | 25.1 |
| `components/` | 110 | 16.4 |
| `app/` | 91 | 8.5 |
| `tests/` | 131 | 16.9 |
| `e2e/` | 18 | 1.6 |

Product surface: **43 screens**, 7 brokers' MTF lists (10,501 per-stock margins bundled),
6 auto-detected broker importers + PDF + generic column mapper, and **3 live broker APIs advertised
to buyers** (Kite, Dhan, Angel One) — plus a 4th, OpenAlgo, which ships in the v2.99.99 binary
**off by default and undocumented outside the app**. Angel One's pull was BROKEN in every shipped
build from v2.99.80 to v2.99.98; **fixed in v2.99.99 and CONFIRMED against the live broker**
(2026-08-20 16:32 IST — connected, authenticated unattended via TOTP, trade book returned empty on a
non-trading day). Source: `app/api/import/broker/route.ts:260`.

---

## 3. Where the answer lives — read this before opening files

Routing table. Going straight to the right file is the single biggest accuracy *and*
cost win in this repo.

| Question | File |
|---|---|
| Can I change this? What will it break? | **`AGENTS.md`** — 10 invariants + conventions. Read before ANY code change. |
| Why is this constant/threshold what it is? | **`docs/DECISIONS.md`** (100 KB, dated entries, newest at top) |
| What shipped, when, and what broke | **`CHANGELOG.md`** (152 KB, 61 release sections) |
| What does the product actually do / feature copy | `README.md` (64 KB) |
| A broker file's exact columns + fingerprint | `docs/BROKER_FORMATS.md` |
| What can be imported at all | `lib/import/registry-meta.ts` — **the only source of truth** |
| Licensing, keys, revocation, refunds | `docs/owner/LICENSE_OPERATIONS.md` |
| Pricing, packaging, launch plan | `docs/owner/MONETIZATION_PLAN.md` |
| Signing, notarization, SmartScreen | `docs/owner/CODE_SIGNING.md` + `AGENTS.md` § Desktop build |
| What a buyer receives | `docs/client/` |
| How do I open a new session here? | `docs/SESSION_PROMPT.md` — short + full copy-paste openers |

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

✅ **Paytm Money's parser is now VERIFIED on a real 414-execution export and reconciled against
Paytm's own Realized P&L Detail (2026-08-20, DECISIONS.md):** 47 of 52 in-window scrips within ₹25,
closed net within 1.4% of the broker, charges conserved to ₹0.16. No contract note was supplied — the
lot statement was the reference; a contract note for one day would still be a useful spot check of the
per-execution charge rows.

⚠ **Never let npm rewrite `package-lock.json`** — see §6 Lockfile.

✅ Secrets hygiene is clean: `license-private.pem`, `updater-private.key`, `.secrets/` and
`license-ledger.jsonl` are all gitignored **and untracked** (verified).

---

## 7.5 macOS is not sold — where the copy was removed (owner decision 2026-08-15)

macOS selling copy was removed from every buyer-facing surface; the Mac builds themselves,
CI matrix, and technical platform code are untouched. **To sell macOS later, restore copy at:**
`docs/sales/landing-page.html` (hero pill, pricing footnote, move-machines FAQ, footer);
`docs/sales/brochure.html` (hero pill, contact block); `docs/client/GETTING_STARTED_DECK.html`
(title chip, install step 1, data-path line); `docs/client/README.md` (feature rows);
`docs/client/INSTALLATION_GUIDE.md` (Platform bullet, download step);
`scripts/build-client-package.mjs` (START_HERE "Honest security boundary" fingerprint list);
root `README.md` (platform badge, install table, Gatekeeper note, universal-binary note).
Kept as-is: historical changelog facts, `lib/machine-id*`/vault darwin code, `.github/workflows`
release matrix, `docs/owner/*`. Before re-adding, check notarisation in
`docs/owner/CODE_SIGNING.md` — the unnotarised "developer cannot be verified" prompt was part of
why selling stopped.

## 8. Open work and future upgrades

Sections 8.1–8.5 were **recovered from the two build-session transcripts** (2026-08-05 → 08-13)
and exist nowhere else in the repo. Claims marked *(verified)* were re-checked against the code
on 2026-08-14; the rest are as recorded in conversation.

### 8.1 Blocking the sale — the owner's stated top priority

The owner's chosen priority at the last session's close was **"make it sellable first"**, over
further engineering. The reframing finding: **131 commits and 53 tags in six days produced 2
licence keys, zero of them annual.** The featured SKU has never been sold end to end.

- ✅ **v2.99.98 is PUBLISHED and is `releases/latest`** (2026-08-20 03:23Z; v2.99.95/.96/.97 all published before it). Publishing stays
  the owner's per-release decision. Older drafts still unpublished: v2.99.75/.55/.50/.40/.30.
- ✅ **v2.99.99 is PUBLISHED and is `releases/latest`** (2026-08-20 15:46:10Z; tag `51b664d` →
  commit `e8198c2`; CI run 32380322684 green on all 5 jobs before the tag; Release workflow
  32380767740 success, 9 assets; `release:verify v2.99.99` → all 3 `.sig` = `4FF85F3BBE1DA21D`).
  **The Angel One pull was then confirmed working against the live broker** (§7). This is the first
  release in this repo's history whose headline fix was verified end to end against the real
  third-party service before the session closed.
- ✅ **The `revocations` prerelease EXISTS** (created 2026-08-12, `prerelease: true`, one
  asset `revocations.json`) — verified 2026-08-15; do not create it again.
- **Owner answers 2026-08-15:** delivery link = mail/WhatsApp, owner sends the package after
  verifying payment; payment = owner shares details, buyer pays via any medium; both to be
  automated later. Two purchases (1 Pro, 1 Lifetime) expected within days.
- **Pricing — RESOLVED 2026-08-14: ₹9,999 is correct.** The repo already ships it
  (`lib/domain/pricing.ts:72`, *verified*), recorded as an "Owner reprice" at v2.99.76. An
  earlier session captured "₹7,999" from conversation; the owner has confirmed that figure is
  superseded. **No code change needed — do not "correct" the price back down.**
- **`REFUND_POLICY.md` and `TERMS.md` still ship inside the client ZIP carrying the ⚠️ OWNER
  banner.** The sign-off walkthrough is now `docs/owner/REFUND_TERMS_SIGNOFF.md` — the owner
  works through it, deletes the two banners, rebuilds the ZIP.
- ✅ **Annual→Lifetime upgrade — BUILT 2026-08-15** as full credit within the year:
  `scripts/license-upgrade.mjs` + `LICENSE_OPERATIONS.md` §1.5; copy aligned across
  `pricing.ts`, landing page and brochure (pinned by `tests/pricing.test.ts`).
- ✅ **KEY BACKUP TAKEN AND RESTORE-TESTED 2026-08-21.** `vyuha-keys-2026-08-20.vkb` (1.4 KB) at
  `T:Thejeshyuha-key-backups`, holding `license-private.pem` + `license-ledger.jsonl` as of the
  2 existing sales; the owner ran the `--restore` drill and it produced both files. Verified no
  `.vkb` sits inside the repo. **Also copied to an EXTERNAL DRIVE 2026-08-21**, which is what actually
  protects it: `C:`, `T:` and `K:` are all partitions of ONE physical NVMe (Disk 0, SK hynix 1TB —
  measured via `Get-Partition`/`Get-Disk`), so the on-machine copy and `license-private.pem` would
  have been lost in the same disk failure. Any "backup" to another drive LETTER on this box is
  theatre; only off-device copies count. **Re-run after every key issued**, or the backup predates
  that customer.
  Earlier note (owner, 2026-08-15 — testing with friends/colleagues): tooling
  now exists: `license-issue.mjs --save-dir` / `VYUHA_KEY_ARCHIVE_DIR` and
  `license-backup.mjs` — run the backup before the first real sale.

**Recommended first move:** sell one annual licence end to end — payment, receipt, mint,
deliver, activate.

### 8.2 Release-day actions never run

- `npm run winget:manifest` → `wingetcreate` submit PR to `microsoft/winget-pkgs`.
- Microsoft false-positive file submission.

The release IS public now (v2.99.98). This matters more than it looks: **SmartScreen reputation
accrues per FILE HASH**, so a 53-tag cadence guarantees every buyer meets a cold warning.
winget is the intended fix. Step-by-step: `docs/owner/WINGET_AND_SMARTSCREEN.md` (2026-08-15).

- **macOS notarisation not purchased** (Apple Developer ID ~₹8,300/yr). Mac users still hit
  "developer cannot be verified"; `notarytool` wiring waits on it.

### 8.3 Documentation staleness — worst offender FIXED 2026-08-15

✅ **`docs/client/GETTING_STARTED_DECK.html` was fixed on 2026-08-15** (in the uncommitted
launch-pricing changeset): version chips now v2.99.94, all 6 brokers named, import slide lists
the 6 parsers + column mapper + 3 API pulls (PDF no longer sold as an import path), Pro list
carries Lenses/Expiry/RoM/Scaling/selected-trades PDF, and macOS install + SmartScreen notes
added. The pre-existing stray `</div>` was REMOVED on 2026-08-15 (v2.99.95), verified by a
div tag-balance check (no negatives, final depth 0). The remaining staleness items from the
17-item list (recorded 2026-08-13) were never written down and are unrecoverable; on 2026-08-15
TERMS/PRIVACY apply-to lines, deck chips, client README, INSTALLATION_GUIDE were brought to
v2.99.96 and `docs/owner/DOC_AUDIT.md` now holds the per-release checklist, guarded by
`tests/client-docs-version.test.ts` and `tests/no-indicators-in-client-docs.test.ts`.

### 8.4 Engineering backlog

- ✅ **Load testing is 13 of 13** (2026-08-15). Five defects fixed (B1, B2, B5, B6, C2-adjacent),
  B7 half-fixed (15→8 decodes; ≤2 needs parsers to share a parsed workbook — `it.fails` pin),
  C7 no defect. Numbers in `tests/load/README.md` and DECISIONS.md 2026-08-15.
- **PDF parser is dead but registered** — see §7 *(verified)*.
- ✅ **Broker files (Paytm, Zerodha, Upstox) — DELIVERED and verified 2026-08-20 (v2.99.98).**
  API client details were NOT supplied; the Kite pull is unchanged and an Upstox API pull was
  offered and deferred (would add a 4th `lib/import/api/*` client + the "3 API pulls" claim
  cascade). Upstox file parsing is schema-verified only — the first populated export must be
  re-verified. **Intraday data integration is NOT required** (owner, 2026-08-15).
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
- ✅ **"Dead preview pane" — CLOSED 2026-08-15.** It was the dev-tool browser pane on a `/trades`
  dev build, unhydrated seconds after load; root cause and guard are DECISIONS.md 2026-08-10
  ("networkidle is not hydration") + `e2e/helpers.ts gotoHydrated`. No app defect.
- Option-seller depth round 3 — scoped, never started.
- B1 share-card funnel and B2 referral codes wired into the licence scripts — planned as the
  "highest-leverage builds", never built.
- ✅ Screenshots retaken 2026-08-15 by `scripts/retake-screenshots.mjs` (22 shots): `skin-royal.png` is
  deleted; the set is dashboard, trades, lenses, pricing, staged-position, arjuns-eye, rom-report,
  kpi-drilldown, playbooks, calculator, risk, options-journal, edge-report, tax-pack, surveillance,
  settings-appearance, custom-theme and skin-{lime,rose,ember,sapphire,aurora}; README renders the
  new set (guarded by `tests/readme-claims.test.ts`).
- Intraday data: NOT required (owner 2026-08-15) — drop from the ceiling list until reopened.

### 8.5 Open questions the owner never answered

Refund-policy and terms sign-off — **partially closed 2026-08-20**: the owner had the ⚠️ OWNER
banners deleted from `TERMS.md` and `REFUND_POLICY.md` and both now ship to buyers without them,
and REFUND gained an "Applies to" line and a current date. A qualified legal read is still not
done · whether to collapse "theme" and "accent skin" into one list (9 skins × light/dark × tint ×
panel style keeps multiplying axes).

*(Closed 2026-08-20: ship v2.99.99 now for the Angel One fix, or wait on a live OpenAlgo pull? —
**shipped now**, with OpenAlgo switched off and absent from every buyer-facing document.)*

*(Left this list 2026-08-14: Pro annual pricing — ₹9,999; the `v2.99.0` tag — keep; the PDF
parser — by design. Left 2026-08-15: delivery link — mail/WhatsApp manual; v2.99.95 published;
revocations prerelease exists; annual→lifetime — full credit within the year; intraday — not needed.)*

### 8.6 Explicit non-goals — do not propose these

**No more brokers, no more report screens, no cloud AI, no backtesting, no new subsystems** —
**One recorded exception (2026-08-20, owner-approved):** the opt-in OpenAlgo integration added a
fourth broker-API source, a Settings → Integrations section and migration 0049. It is not a new
broker (OpenAlgo is a router; trades are stamped with the underlying broker and `BROKERS` was NOT
extended) and it is off by default. Rationale in DECISIONS.md 2026-08-20. This exception does not
reopen the list. Otherwise —
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
- ✅ Paytm Money reconciliation DONE 2026-08-20 (§7). The equivalent still-open one: Upstox file
  values are unverified — its exports carried no rows — so re-verify on the first populated export.
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
