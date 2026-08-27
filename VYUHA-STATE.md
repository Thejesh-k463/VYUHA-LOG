# VYUHA — PROJECT STATE

Flagship project. Read this file first in any new session; it is the map, not the territory.
Everything below was verified against the repo on 2026-08-27 (the live broker-API test session), not recalled.

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

## 2. Current state — verified 2026-08-25 (v2.99.101 release session)

| | |
|---|---|
| Version | **v2.99.102** — committed `c8f5da6`, tagged `v2.99.102` (annotated `05bf628`), pushed 2026-08-27. Cut for the **live F&O pull wave** (commits `f235b97`/`6c0cecf`/`74b09e2` + release chore): Dhan API F&O classification from stated `drv*` facts, broker-stated marks on open positions, OpenAlgo multi-instance (`openalgo:<broker>` rows) + suspect-symbol refusal, collision-gated commits (409 + dialog), Portfolio Risk ₹ figures, partial-safe risk saves. **1,993 tests / 134 files, verify EXIT 0 post-bump.** Contract note 14721318 reconciled the wave at **−0.081%** (STT exact ₹1,222.00; engine's 0.15% options STT CONFIRMED by the broker's levy). **GitHub release v2.99.102: DRAFT, 9 assets** (Release workflow 33007000399, all 3 platform jobs success; CI run 33006628870 all 5 jobs green BEFORE tagging); `release:verify v2.99.102` → all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"; `releases/latest` still v2.99.101; `revocations` still prerelease. Installer `BUILD_ID 7GuZQoSZopVUvw7qrgfoI`, both v2.99.102 marker strings in the bundle, local `.sig`s decode to the live key. Client ZIP `Vyuha_2.99.102_Client_Package.zip` audited (10 entries, WHATS_NEW v2.99.102, Applies-to 2026-08-27, forbidden-grep clean, installer SHA-256 `02F5E9EFE34C32F463778F534EF753C67FB5E4B560DEBDD5C9977966CDCCCC51`). Two-binaries gap reproduced a FIFTH time: GitHub asset 34,862,395 B vs local/ZIP 34,876,330 B. **Owner: publish the draft; WDSI with the ZIP's installer; NO winget PR while #421585 is open; run `npm run mirror:push` from a real terminal (failed from the agent session — OAuth refresh blocked, documented).** *Previous:* **v2.99.101** — committed `cf8d3f3` (fix at `eada9fe`), tagged `v2.99.101`, pushed 2026-08-25. Cut to ship the **staged Book-exit closed-position fix** (a real user's dead end on 2026-08-24: percentage shortcuts of zero + a native `max=0` bubble blocking every quantity — DECISIONS 2026-08-25). Numbered a PATCH for the same reason as 2.99.100; the user's requested "2.99.99.101" is impossible (Cargo rejects a fourth segment, tested at the 2.99.100 release). *Previous:* **v2.99.100** — committed `f6e6324`, pushed 2026-08-21. Cut to ship the **pairing-engine quadratic fix** (C8). **Numbered a PATCH deliberately**: output is byte-identical and nothing about compatibility changed, so 3.0.0 would have signalled a breaking change that does not exist — the 3.0.0 milestone stays reserved for the public launch (§8.7). `2.99.99.1` was considered and is IMPOSSIBLE: Cargo rejects a fourth segment (`unexpected character '.' after patch version number`, tested on a scratch manifest). *Previous:* v2.99.99 — committed `e8198c2`, tagged `v2.99.99` (annotated tag `51b664d` → `e8198c2`), pushed 2026-08-20. Cut to ship the **Angel One live-pull fix**, which was broken in every build from v2.99.80 through the published v2.99.98. The OpenAlgo opt-in wave (`af228b5`…`b405ad9`) rides along **switched OFF and named in no buyer-facing document** — owner's standing decision: in-app only until a live pull is reconciled against a contract note |
| Branch | `main`, clean at `cf8d3f3` = tag `v2.99.101` (2026-08-25). One pending doc commit expected after this session: this VYUHA-STATE refresh |
| CI | **green on the release commit `cf8d3f3` — all 5 jobs — BEFORE tagging** (run 32770571928: Lint/typecheck/unit/build, Windows install + tests, Playwright e2e ubuntu, Playwright e2e macOS-14, desktop bundle macOS; no rerun needed). *Previous v2.99.100:* green on `f6e6324` — all 5 jobs — before tagging (run 32478431386, conclusion `success`; no rerun needed). *Previous v2.99.99:* run 32380322684 on `e8198c2`, also all 5 green: Lint/typecheck/unit/build, **Windows install + tests**, Playwright e2e ubuntu, Playwright e2e macOS-14, desktop bundle macOS. **No rerun needed** — the ubuntu Playwright browser-install step, which hung twice on earlier releases, completed clean this time |
| GitHub release (v2.99.101) | **PUBLISHED by the owner 2026-08-25T05:37:57Z and is `releases/latest`**; mirror pushed (main + tag verified on Codeberg). **UPDATER PROVEN LIVE: the owner's installed 2.99.100 was offered and applied 2.99.101 with no errors (2026-08-25)** — the full signature chain (CI-signed asset → installed pubkey) verified end to end on a real install. Defender static scan of the new installer clean at defs 1.457.321.0. **WDSI pre-emptive submission for v2.99.101 ATTEMPTED 2026-08-25 and BLOCKED BY THE PORTAL, not by us**: "An error has occurred" on submit in BOTH Brave and Chrome, correct account (`ktr.thejesh463@gmail.com`) verified by screenshot, and Submission history renders "0 of 0" even though the three 2026-08-22 case IDs are 3 days old (30-day retention) — a known recurring WDSI backend failure (multiple Microsoft Q&A reports with identical symptoms). The three Aug-22 cases live server-side regardless of the view; determinations arrive by email. **SUPERSEDED 2026-08-27: WDSI accepted a submission for v2.99.102** — `vyuha_2.99.102_x64-setup.exe` (the client-ZIP installer, SHA-256 `02F5E9EF…CCCC51`), **Submission ID `99e1ce8a-df30-48c3-8637-77cabbc14cde`**, 2026-08-27 09:00:39, "Incorrect detection", defs `1.457.350.0`, determination Pending. The portal's Submission history STILL renders "0 of 0" (the same backend view bug — the direct submission-details URL works, so the case is alive server-side; determinations arrive by email). The v2.99.101 pre-emptive submission was never accepted by the portal and is now moot — v2.99.102 supersedes it. *(Original pending action, kept for context:)* **retry the submission in 24–48 h** (form answers prepared and correct: file = ZIP's installer `BD605ADF…AD943C`, "Incorrectly detected", detection `N/A - no detection`, defs `1.457.321.0`); if still failing, escalate via the WDSI support form quoting the three existing IDs. Was: DRAFT with 9 assets (Release workflow 32771022050 success on all 3 platform jobs). `npm run release:verify v2.99.101` → **all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"**. `releases/latest` still v2.99.100 (a draft steals nothing); `revocations` re-checked: still `prerelease=true`. Two-binaries gap reproduced a FOURTH time: GitHub asset **34,860,644 B** vs local/ZIP **34,875,061 B** (14,417 B apart) — winget takes the GitHub hash, WDSI takes the ZIP's. **Do NOT open a winget PR for this version while #421585 (v2.99.99) is open.** Owner only: publish the draft; install on a non-build machine |
| GitHub release (v2.99.100) | **PUBLISHED 2026-08-21T16:30:25Z and was `releases/latest` (still is, until the v2.99.101 draft is published)** (verified via `gh` 2026-08-24; was a draft with 9 assets until the owner published) — Release workflow **32482047303** success on all 3 platform jobs. `npm run release:verify v2.99.100` → **all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"**. `revocations` still `prerelease=true`. Two-binaries gap reproduced a third time: the GitHub asset is **34,858,983 B** against the local/ZIP build's **34,863,579 B** — 4,596 B apart, so winget takes the GitHub hash and WDSI takes the ZIP's installer (DOC_AUDIT rows 15/16/20). **Owner only:** install on a non-build machine (partially discharged by winget's `08. Installation Validation` — installs on a bare VM; app-launch unproven) |
| GitHub release (v2.99.99) | **PUBLISHED by the owner 2026-08-20 15:46:10Z; was `releases/latest` until v2.99.100 (2026-08-21)** (9 assets; a draft until then) — Release workflow **32380767740** success on all 3 platform jobs (Windows x64, macOS Intel, macOS Apple silicon). `npm run release:verify v2.99.99` → **all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish"** (this check needs an existing tag, so it can only run after tagging; it verifies the CI-signed assets, which use the repo secret `TAURI_SIGNING_PRIVATE_KEY`, NOT the local `.secrets` key — a separate fact from the local build's signatures). `releases/latest` moved from v2.99.98 to **v2.99.99** on publication, so existing installs are now offered the update. `revocations` re-checked after publishing: still `prerelease=true`, untouched. The release asset `Vyuha_2.99.99_x64-setup.exe` is **34,861,983 B** vs the LOCAL/ZIP build's **34,860,149 B** — 1,834 B apart, confirming again that these are two different binaries (see the 2026-08-20 DECISIONS entry). **Publish DONE. Live Angel One pull DONE — see §7.** Still open, owner only: WDSI (use the ZIP's installer) · winget (uses the GitHub asset) · install on a non-build machine. **Do NOT create or re-publish the `revocations` prerelease — it exists and must stay a prerelease.** |
| GitHub release (v2.99.98) | `v2.99.98` was a **DRAFT with 9 assets** (Release workflow 32301883296 success; owner publishes); `release:verify v2.99.98` → all 3 `.sig` = `4FF85F3BBE1DA21D`, "Safe to publish". **PUBLISHED by the owner 2026-08-20 03:23Z and is now `releases/latest`.** Its assets are built from `6e2dd80` — the commits after the tag are NOT in them, so the Angel One pull fix reaches nobody until v2.99.99 ships. Never re-upload assets onto a published tag: the updater compares versions, so an existing install would never be offered the same version again, and SmartScreen reputation and the ZIP's CHECKSUMS.txt are both per file hash |
| Client ZIP | `release-packages/Vyuha_2.99.101_Client_Package.zip` — 10 entries, installer SHA-256 `BD605ADF…AD943C`. Extracted and audited 2026-08-25: `WHATS_NEW.md` first section `## New in v2.99.101`; TERMS/PRIVACY/REFUND all `Applies to: Vyuha v2.99.101 and later` dated 2026-08-25; grep for `OWNER:`, `macos` and `pine script|tradingview` all return nothing; packed `.sig` decodes to `4FF85F3BBE1DA21D`. *Previous:* `Vyuha_2.99.100_Client_Package.zip` — 10 entries, installer SHA-256 `B89A225D…F14DD4`. Extracted and read: `WHATS_NEW.md` first heading `## New in v2.99.100`; TERMS/PRIVACY/REFUND all `Applies to: Vyuha v2.99.100 and later` dated 2026-08-21; deck carries exactly one version string; grep for `OWNER:`, `macos` and `pine script|tradingview` all return nothing. *Previous:* `Vyuha_2.99.99_Client_Package.zip` — 10 entries, installer SHA-256 `27D8695E…B23004`. **Extracted and read:** `WHATS_NEW.md` first heading `## New in v2.99.99`; `TERMS`/`PRIVACY`/**`REFUND_POLICY`** all `Applies to: Vyuha v2.99.99 and later` dated 2026-08-20 (REFUND carries that line for the FIRST time); deck contains exactly one version string, `v2.99.99`; grep for `OWNER:`, `macos` and `pine script|tradingview` over the extracted ZIP all return **nothing**; the packed `.sig` decodes to `4FF85F3BBE1DA21D`. **This installer is NOT the GitHub release asset** — see the 2026-08-20 DECISIONS entry on the two binaries |
| Unit tests | **1,962 passed / 0 failed** across 134 files — run TWICE on 2026-08-25 (pre-bump `npm run verify` EXIT 0 including the production build, and `npm test` again post-bump so the version-guard tests asserted against 2.99.101). e2e: the `staged-position` spec (extended with the closed-position assertions) passed 2/2 locally, and BOTH Playwright suites passed in CI run 32770571928. *Previous:* `npm run verify` EXIT 0 **2026-08-24**, after fixing the date-frozen sell-flow suite (DECISIONS 2026-08-24). Provenance: the release-session verify of 2026-08-21 was 1,921; the count reached 1,962 at `4fd6bf5` (2026-08-23) via +11 sell-flow, +24 sim, +6 demo-video-copy. Including **both real-file reconciliations running rather than skipping**: Paytm's 414 executions against Paytm's own Realized P&L Detail, and the 1,554-fill Zerodha Console tradebook. That is the proof the pairing rewrite changed no behaviour. (Earlier: EXIT 0 twice on 2026-08-20: once on `b405ad9` as the pre-bump gate and again at `vyuha@2.99.99` after the doc edits and bump. (Earlier context: on `af228b5`; was 1,858/128 at the v2.99.98 tag — +60 from the OpenAlgo adapter, disclosure, route-gate, vault and backup tests). Earlier at the tag: 1,756 → 1,858 = +102 from the new parser, fixture-matrix, isin-symbol and reconciliation tests; the private-file tests skip on CI, so CI's count is lower by those) |
| Simulation | **`tests/sim/` — 24 cases, all green (2026-08-23).** A deterministic 10,028-fill book rendered as Zerodha Console, Dhan GTR, Paytm tradebook, Groww orders, Angel One tax P&L and a generic CSV, through the REAL `detectParser` route: every parser conserves quantity exactly and value to the paisa at 120 / 1,500 / 10k fills, and **all formats agree on the same 4,504 positions** (zero per-symbol mismatches vs Dhan across 40 symbols, same 5 opening sells). Five failures on the way were all the test being wrong — two are now invariant lessons written into the test. **No production code changed.** Upstox deliberately absent (values still INFERRED). DECISIONS 2026-08-23 |
| Load tests | **14 files, EXIT 0 — 34 passed / 1 expected fail** (`npm run test:load`, 57 s, 2026-08-21). The expected fail is B7's standing `it.fails` pin for the double workbook decode. **New: C8 `tests/load/c8-pairing-depth.load.ts`** — written because an import-graph scan found **none of the thirteen existing cases imported `lib/import/pair-legs.ts`**, the hot path for five import sources, rewritten in v2.99.98 five days after the suite was built. It found a real O(n²): three O(lots) scans per sell (full-queue same-day pass, `.some()`+`.find()` inside the oldest-first loop, and a `splice` compaction). Ratios at 4n where linear is 4 and quadratic is 16: **15.89 → 3.70** (one symbol, growing queue) and **13.32 → 4.10** (opening-sell heavy); 50,000 legs on one symbol **775 ms → 63 ms**. Multi-symbol books were never affected (4.19, per-item flat). **Lesson recorded in `tests/load/README.md`: a load suite only covers the modules it imports** |
| e2e | **NOT run locally this session.** The evidence for v2.99.99 is CI run 32380322684, where BOTH Playwright suites (ubuntu + macOS-14) passed on the release commit. Last local run was 45/45 on 2026-08-20 before the OpenAlgo wave |
| Installer | `Vyuha_2.99.101_x64-setup.exe` **34,875,061 B**, SHA-256 `BD605ADFA74D3F51E89CF00472A94D26198B6155F3D568E64BA2C6833DAD943C`. **Freshness proven two ways:** `BUILD_ID` changed `ePhn5BsghJc5jih4X42nT` → **`CofcLc4UjVVKW1EjqUX7O`** (01:13 IST 2026-08-25), and the bundle carries the fix's own literal `Nothing is open on this position` in both the SSR chunk and the client chunk. Both local `.sig` key ids decode to **`4FF85F3BBE1DA21D`** (decoded, not trusted from "✓ signed"). This was a COLD build — `.next/` and `src-tauri/target/` had been deleted in the morning's Google-Drive-backup purge, and both rebuilt from nothing cleanly. *Previous v2.99.100:* `Vyuha_2.99.100_x64-setup.exe` **34,863,579 B**, SHA-256 `B89A225D19DF8EC7DBE3D739699DF2E91696517ED77C1E775556F2852DF14DD4`. **Freshness proven two ways:** `BUILD_ID` changed `KOKnpdVgOsrtwbhlnjiEn` → **`ePhn5BsghJc5jih4X42nT`** (17:05 IST 2026-08-21), and the shipped bundle carries the fix's own code shape — the per-date index and forward-only head pointer are present as `for(;g.head<g.arr.length&&g.arr[g.head].qty<=0;)g.head++` and `for(;s<n.length&&n[s].qty<=0;)s++`, while `.splice(` and `.some(` are GONE from the pairing window. NOTE a marker must survive minification: grepping for the local name `byDate` returns 0 because minifiers rename locals — grep string literals or code shape. Both `.sig` key ids decode to **`4FF85F3BBE1DA21D`**. *Previous v2.99.99:* 34,860,149 B, SHA-256 `27D8695E…B23004`; MSI 57,963,645 B, SHA-256 `068DCA47…57FEC4`. Both `.sig` key ids decode to **`4FF85F3BBE1DA21D`**, byte-identical to `tauri.conf.json` `plugins.updater.pubkey` (decoded from the local `.sig`, NOT trusted from the build's "✓ signed" line). **Freshness proven two ways:** `BUILD_ID` changed `2wW9bxykXfHZipbZHTgP3` → **`KOKnpdVgOsrtwbhlnjiEn`** (19:50 IST 2026-08-20), and the bundle carries `openalgo` (16 files) + `Integrations (advanced)` (3 chunks incl. a client chunk). **The Angel One fix is present in the built server chunk**, minified as `h=L[l]?.needsToken??!0; if(!d.ok||h&&!p.ok)` with `angelone` at `needsToken:!1` |
| Previous | v2.99.98 published 2026-08-20 03:23Z, superseded as `releases/latest` by v2.99.99 at 15:46Z the same day. **Its binary carries the broken Angel One pull** (built from `6e2dd80`) — anyone still on it must update |
| Defender FALSE POSITIVE (2026-08-22) | An installed v2.99.100 was flagged **`Trojan:Win32/Bearfoos.B!ml`, Severity 5** on the owner's machine — the `!ml` suffix is a MACHINE-LEARNING verdict, and it named the shortcuts, uninstall key and startup entry as well as `vyuha.exe`, so it is behavioural, not a content match. **The install had SUCCEEDED first** (17:09) and the flag came at 23:11. **Nothing reproduces on a static scan** at defs `1.457.274.0`: local installer, local `vyuha.exe`, the GitHub-built v2.99.100 installer and the GitHub v2.99.99 installer all scan clean, and a second user installed the same update repeatedly without incident. Assessed as a false positive on a cold unsigned hash. **v2.99.100 stays published** (both paying customers are friends and untroubled; no public download link). **WDSI SUBMITTED 2026-08-22 — all three binaries, IDs recorded here so a lost email is not a lost case** (submitter `ktr.thejesh463@gmail.com`, each "Incorrect detection"): `1_detected_vyuha.exe` → **a34be654-532c-432f-82d4-cb3a8e086c01** (00:47), `2_github_vyuha_2.99.100_x64-setup.exe` → **c622d257-60a3-4b83-8d74-d4b3b430c1fc** (00:51), `3_buyer_zip_vyuha_2.99.100_x64-setup.exe` → **b798193e-af70-4dbb-b5b0-c954a356bec4** (01:01). Status on all three: `Submitted`. **There is no API — status is only readable by signing in to the WDSI portal**, so nothing in this repo can poll it. Each went in as "Incorrectly detected as malware/malicious", detection name `Trojan:Win32/Bearfoos.B!ml`, product Microsoft Defender Antivirus (Windows 11), with an explanation naming the node.exe-sidecar architecture as the likely ML trigger. Three separate submissions because the flagged `vyuha.exe`, the GitHub asset and the client-ZIP installer are three distinct files with independent reputation. Status Pending at submission; expect an automated determination, and note that **empty "Analyst comments" and a greyed-out Rescan button are both normal** for a pending false-positive case. This supersedes the 2026-08-21 deferral, which was correct at the time because no detection existed. **The deadline is the winget merge**, after which strangers install unattended. Full analysis and the code-signing numbers: DECISIONS 2026-08-22 |
| Mirror | ✅ **CREATED AND PUSHED 2026-08-22** — `mirror` → <https://codeberg.org/Thejesh_ktr/vyuha-trade-journal>. Verified: `main` = `5fc2214` on both sides and **61 tags local = 61 tags on the mirror**. GitHub is no longer the only copy of the history — which matters more since the pre-v2.99.98 local release artefacts were deleted on 2026-08-20. Re-run `npm run mirror:push` after every release; secrets cannot travel because git only pushes tracked history. **The repo IS private** — verified anonymously: the page returns 404 (Codeberg hides existence from anonymous users rather than 403) and the git refs endpoint 401. **Auth is OAuth, not a username/token**: Credential Manager holds `git:https://codeberg.org` and `git:https://refresh_token.codeberg.org` both as `OAUTH_USER`, so it refreshes itself. **Expect an occasional "Authentication failed" from an agent session** — agents run with `GIT_TERMINAL_PROMPT=0`, which blocks the token refresh. That is NOT a broken mirror; run `npm run mirror:push` from a real terminal. The manually created `write:repository` token is unused and can be revoked |
| winget | **`scripts/winget-manifest.mjs` was DEFECTIVE and is fixed** (`f05c8ae`). It set `InstallerUrl` to the GitHub asset but hashed the LOCAL build, on a comment claiming they were "identical, since the same build produced both" — they are not. `--sha` is now REQUIRED; without it the script exits 1 printing the `gh release download` + `sha256sum` recipe. **Nothing had been submitted to Microsoft yet, so no bad manifest ever left this machine.** **SUBMITTED 2026-08-20 19:41Z — `microsoft/winget-pkgs` PR [#421585](https://github.com/microsoft/winget-pkgs/pull/421585), "Add ThejeshK.Vyuha 2.99.99", state OPEN.** `Manifest validation succeeded: True` — the hash fix held. **CLA SIGNED by the owner 2026-08-21** (`@microsoft-github-policy-service agree`, no `company=` — sole ownership): the `Needs-CLA` label is GONE, the PR is labelled **`New-Package`**, `mergeable: MERGEABLE`, `reviewDecision: REVIEW_REQUIRED`. **ALL VALIDATION PASSED 2026-08-21** — labels now `Azure-Pipeline-Passed` + `Validation-Completed` + `New-Package`; 11 checks SUCCESS, **0 failures**: stages 01 Pull Request / 02 Manifest / 03 URLs / 04 URL Domain / 05 Manifest Policy / 06 Catalog Content / **07 Installers Scan** / **08 Installation Validation** / 09 Installer Metadata / 10 Validation Completed, plus `license/cla`. The 6 CANCELLED jobs belong to two ASSISTIVE bots (`Missing Dependency Assist`, `Wingetbot PR Triage`) that stand down when there is nothing to act on — they gate nothing. **v2.99.100 SUPERSEDES the submitted version, and that is fine — do NOT open a second PR while this one is open.** Two PRs for one package confuse a volunteer reviewer, and the v2.99.99 release and its asset URL stay live so #421585 remains valid and mergeable. Correct order: let it merge, THEN `wingetcreate update ThejeshK.Vyuha --version 2.99.100 --urls <installer-url> --submit` (no CLA re-prompt; the manifest must still carry the PUBLISHED asset hash, not the local build). **Re-checked 2026-08-22: UNCHANGED since 2026-08-20 20:29Z** — still OPEN, labels `Azure-Pipeline-Passed` + `Validation-Completed` + `New-Package`, 11 checks SUCCESS and **0 failures**, one comment (the CLA agreement). No movement is NORMAL for a first-time package; do not nudge the PR. **Only remaining gate: a community-volunteer moderator must approve** (bot: "check-in policies require a moderator to approve PRs from the community"). Nothing further for the owner to do. **Two side-effects worth keeping:** (a) `07. Installers Scan` is MICROSOFT independently finding no malware in `Vyuha_2.99.99_x64-setup.exe`, matching the local Defender scan — a data point that supported the then-active WDSI deferral (superseded 2026-08-22 — WDSI submitted, see the Defender row); (b) `08. Installation Validation` installed the release asset on a clean Windows VM with none of this machine's toolchains, which is the v2.90.0 failure mode and so PARTIALLY discharges the standing "install on a non-build machine" item — it does not prove the app launches and is usable, only that it installs. Submitted via the device flow (`wingetcreate token --store` → Credential Manager), NOT `--token` on the command line, which the tool itself warns gets logged — an earlier attempt pasted a PAT in cleartext and that token has been deleted and replaced |
| Two binaries per release | The GitHub asset and the local/ZIP installer are **different files** — v2.99.99: **34,861,983 B / `46A3842ADD7B91A65F493330B8FAAEE0A1B06A2DA76A52DBFBA4CB6C74EB4343`** (GitHub, for winget) vs **34,860,149 B / `27D8695E863D3426DE4016C86002C6A148E2F1A1E1457838A11835621BB23004`** (local, in the client ZIP, for WDSI and for buyers). SmartScreen reputation is per hash, so they accrue it separately. DOC_AUDIT rows 15/16/20 |
| Housekeeping (2026-08-20) | ~1.65 GB of stale build artefacts deleted — 28 MSIs older than v2.99.98 plus their `.sig`s, the v2.99.97 NSIS installer, the v2.99.96/.97 client ZIPs, and `release-2.98.0-corrected/` (a resolved Aug-5 incident folder). **v2.99.98 and v2.99.99 are kept in all three artefact classes.** All deleted paths were untracked AND gitignored — verified `git ls-files` returned 0 before deleting. `scripts/measure-slim.mjs` (a spent one-shot measurement) removed. **`scripts/license-revoked.mjs` looks like a typo-duplicate of `license-revoke.mjs` but is LOAD-BEARING** — it is the `REVOKED_IDS` source of truth; do not delete it |
| Housekeeping (2026-08-24) | Repo audit session. Excel-damaged `tests/fixtures/zerodha-tradebook.csv` restored from HEAD (trailing-comma/date-format signature of an Excel re-save — never hand-edit fixtures in Excel). Orphan `scripts/demo-ind7.mjs` DELETED — unreferenced, and it wrote into the LIVE journal (`data/vyuha.sqlite`); `npm run demo` supersedes it (its two `.gitignore` lines went with it). Empty stray dirs removed. **NEW: `npm run backup:drive -- <letter>`** (`scripts/backup-to-drive.mjs`) — one-command full off-device backup: verified git bundle (all branches+tags), `.secrets`, key archive, `.vkb` bundles, `tests/fixtures/private`, client ZIPs, live app data; REFUSES `C:`/`K:`/`T:` (one physical NVMe) and refuses to run while Vyuha is open. Proven: 51 files / 191.3 MB test run, bundle re-cloned with all 61 tags. `tests/readme-claims.test.ts` file-count guard made RECURSIVE (was pinned to top-level `tests/`, blind to `tests/sim/`). **Later same day (cloud-backup pass): ~10.1 GB of regenerable caches deleted** — `.next/` (4.4 GB), `src-tauri/target/` (5.7 GB), `test-results/`, `tsconfig.tsbuildinfo`, and the extracted `release-packages/Vyuha_2.99.99_Client_Package/` folder (35 MB; its ZIP is kept) — all verified untracked (`git ls-files` = 0) before deletion; `git status` clean after. Full-project backup for Google Drive created at `T:\Thejesh\CLAUDE-CODE\Vyuha_Drive_Backup_2026-08-24.zip` (142 MB, 1,608 entries, excludes only `node_modules` + `desktop-dist`; verified to contain `.git`, `.secrets`, `license-private.pem`, ledger, `data/`, private fixtures, all 3 client ZIPs). NOTE: that ZIP holds the PLAINTEXT signing + licence keys — it must live only in a private Drive folder |

**UNCOMMITTED ON `main` — the 2026-08-26/27 live broker-API test wave (release pending as ~v2.99.102).**
The owner ran the first-ever live pulls with REAL F&O fills (Dhan native + a self-hosted OpenAlgo
instance on :5051 fronting Dhan), supervised end to end against the live desktop journal via a dev
server pointed at `%APPDATA%` (`VYUHA_DB_PATH`; vault.key sits beside the DB so saved credentials
decrypt). **1,993 unit tests green, `npm run verify` EXIT 0** on the working tree. Five entries
appended to DECISIONS.md (2026-08-26/27) carry the full story. Found and fixed, each verified live:
(1) **every API puller classified F&O as equity** — Dhan now canonicalises from its stated `drv*`
fields, OpenAlgo from stated exchange + documented compact symbol; **Kite and Angel One remain
DEFECTIVE for F&O** (no real payload to verify against — do not guess-fix); (2) open Dhan positions
now import **already valued** (mark = entry ± stated unrealised/qty; reproduced Dhan's LTPs exactly);
(3) an OpenAlgo row whose identity is corrupt (real case: a PIIND call relabelled `SILVERM…` on NFO)
is **REFUSED with a warning**, and engine charge-refusals return 422 messages, not 500s;
(4) **multiple OpenAlgo instances**: connections are `openalgo:<broker>` rows (legacy id migrated on
GET), UI shows an instance list with per-instance pulls; (5) **risky cross-source collisions block
API commits behind a 409 + confirmation dialog** (found live: a 1-paisa hash near-miss double-counted
a SENSEX option), with an informational note for same-day overlap across brokers. Reconciliation
evidence so far: OpenAlgo↔native to the paisa on all 11 positions; totals match Dhan's own dashboard
to the rupee. **The contract-note reconcile is DONE (2026-08-27, note 14721318): all 9 contracts
match to the 4th decimal, STT exact to the paisa (₹1,222.00), non-brokerage levies −0.081%, and
the engine's 0.15% options STT rate was confirmed CORRECT by the broker's own levy — the OpenAlgo
claim-hold condition is DISCHARGED** (buyer-facing copy may now claim it; none does yet — owner
decides when). **The Angel One real-fills day happened 2026-08-27 (after v2.99.102 shipped):**
11 fills captured raw, the adapter's F&O defect fixed from Angel's STATED fields (its symbol lied
about a real expiry — DECISIONS 2026-08-27), MARGIN verified as Angel's MTF product, 6 trades
committed and verified to the paisa against Angel's own UI (gross −843.72 exact). **2,001 tests,
verify EXIT 0; committed `49e3180` → goes into v2.99.103. Zerodha/Kite is now the ONLY API puller
with no real F&O payload.** Angel contract-note reconcile pending when the note arrives — it GATES
the v2.99.103 release (owner's instruction 2026-08-27).

**LAUNCH PLAN (owner, 2026-08-27): public launch as v3.0.0 in ~2 days.** Collaborators/potential
buyers want to see "3.0" before buying, so 3.0.0 ships even if minor issues remain (fixes ride
later releases). Before it: a rigorous full-feature test pass. **REPORTED BUG for that pass, not
yet investigated: UI lag when switching between tabs, appearing from the ~3rd–4th navigation
onwards** (owner observed on the installed app; suspect list for the investigation: accumulating
listeners/intervals on remount, recharts re-render cost, the wallpaper/backdrop layer, dev-only vs
installed behaviour — measure first, DECISIONS records what is found). Launch also needs the
v3.0.0 claims audit and the OpenAlgo advertising decision (hold discharged; copy still silent).
**New: `docs/owner/forms/referral-form.gs`** — pre-purchase referral form (short by design): name,
email, WhatsApp, discovery channel, MANDATORY referral code ("NONE" allowed), plan intent, brokers;
per-submission email names the referrer in the subject, `vyuhaReferralSummary()` prints leads per
referrer/plan — the record that settles influencer payouts. Owner runs it in Apps Script (same
drill as the feedback form), gives each creator a code. **New: `docs/owner/CREATOR_KIT.md`** —
the per-influencer document sent WITH the client ZIP (no separate influencer package — one
installer, one hash, one truth): fill `[[NAME]]`/`[[CODE]]`/`[[FORM_LINK]]`; carries the
pre-approved claims verbatim from audited copy, the NOT-to-say list, the ASCI disclosure
requirement, machine-bound key delivery steps, and the buy flow. It is buyer-adjacent copy —
part of every release's claims audit; macOS and OpenAlgo deliberately absent.
Ops lesson that cost hours: **never run `npm run verify` while the dev server is up** — the build
poisons `.next` and browsers silently serve stale chunks (DECISIONS 2026-08-27).

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

**Owner's open to-dos (as of 2026-08-24):** *(v2.99.100 published 2026-08-21 16:30Z — closed.)* **do NOT open a winget PR for 2.99.100 while #421585 (v2.99.99) is open** — let it merge, then `wingetcreate update` (re-checked 2026-08-24: still OPEN, validation passed, awaiting a community moderator) · **WDSI: SUBMITTED 2026-08-22 for all three v2.99.100 binaries** — the 2026-08-21 deferral is superseded (see the Defender row for the three case IDs); check the portal for determinations · **install on a non-build machine** (partially discharged by winget's `08. Installation Validation`; app-launch unproven) · **An Angel One pull carrying REAL FILLS** — the empty-book path is proven, the row-parsing path is not; **and its F&O classification is a known defect until a real F&O payload arrives** (DECISIONS 2026-08-26) · **OpenAlgo live pull DONE and CONTRACT-NOTE RECONCILED (2026-08-27, −0.081%, STT exact) — the claim-hold is discharged; adding OpenAlgo to buyer-facing copy is now the owner's call** (deliberately NOT done in v2.99.102, which ships fixes only) · cut the release (v2.99.102) carrying the 2026-08-26/27 wave · fill the deck chips and submit the Rainmatter form ·
email talk@rainmatter.com + X thread (ZERODHA_PROPOSAL.md) · run the Apps Script, send the form link with each sale ·
`npm run release:archive` to a drive · **fill the four `[[placeholders]]` in `docs/owner/pitch-deck/deck.html` and REBUILD `RAINMATTER_DECK.pdf`** (the committed PDF was built 2026-08-19 and shows them) · supply the broker **API client details** (the Paytm/Zerodha/Upstox FILES were delivered and verified 2026-08-20; only the API credentials remain).

*(Closed 2026-08-21/22 — do not reopen: the mirror repo EXISTS and is pushed; `license-backup.mjs` has been run AND restore-tested with an off-device copy; the refund/terms sign-off is COMPLETE (`REFUND_TERMS_SIGNOFF.md` carries every answer, jurisdiction deliberately left as "the laws of India"); winget was submitted as PR #421585; WDSI was submitted for all three v2.99.100 binaries.)*

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
| `tests/` | 154 | 22.9 |
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
licence keys, zero of them annual.** The featured SKU had never been sold end to end.
*(Superseded 2026-08-23: BOTH SKUs have now been sold and activated — VY-2026-001 lifetime,
VY-2026-002 annual, see the sale rows below. The finding is kept because it is what set the
priority; it is no longer the state.)*

- ✅ **v2.99.100 is PUBLISHED and is `releases/latest`** (2026-08-21T16:30:25Z, verified via `gh`
  2026-08-24). The pairing-quadratic fix now reaches every buyer through the updater.
- ✅ **v2.99.98 was PUBLISHED** (2026-08-20 03:23Z; v2.99.95/.96/.97 all published before it). Publishing stays
  the owner's per-release decision. Older drafts still unpublished: v2.99.75/.55/.50/.40/.30.
- ✅ **v2.99.99 was PUBLISHED and held `releases/latest` until v2.99.100** (2026-08-20 15:46:10Z; tag `51b664d` →
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
- ✅ **Refund/terms sign-off COMPLETE — 2026-08-22.** The ⚠️ OWNER banners are gone from
  `REFUND_POLICY.md` and `TERMS.md` (verified absent from inside the shipped ZIP), and
  `docs/owner/REFUND_TERMS_SIGNOFF.md` now records an answer for every one of its ten steps.
  Two worth carrying forward: **jurisdiction is deliberately "the laws of India" with no city or
  court named**, and the contact channel is WhatsApp + `ktr.thejesh463@gmail.com`, which must stay
  identical on the invoice, the landing page and the feedback form. **A qualified legal read is
  still NOT done** — that is a live exposure, not a pending task.
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

- ✅ **FIRST REAL SALE — 2026-08-23.** Journal (Lifetime), ₹29,999 by UPI, key `A5E2-A025-D6`,
  receipt **VY-2026-001**. Done end to end by the owner at the keyboard: quote in writing (with the
  SmartScreen warning stated upfront) → UTR received → `license-issue.mjs … --lifetime` with
  `VYUHA_LICENSE_NOTE` set (**the first key in the ledger ever to carry a payment note**) → ledger
  + archive verified on disk → `license-backup.mjs` → `.vkb` copied to the external drive →
  receipt + key + ZIP in one WhatsApp message. **ACTIVATED by the buyer the same day** — the
  chain is proven end to end for the first time. Unbound, per §6, and it should stay that way: a
  bound reissue would need `--machine` + `--no-payment` AND a revocation of `A5E2-A025-D6` (a
  new key does not retire the old one), which is the §4 path and is only for a buyer who asks or a
  key caught being shared. Two traps met on the way, now in
  the sale runbook: cmd.exe's `>` redirect cannot create the archive folder (it runs before node),
  so `mkdir` it first; and `₹` is unsafe in a cmd.exe note — use `Rs`. **The 2026-08-02
  `Siddhi@client1.com` key was a TEST, not a sale** — a different person; it carries no payment
  note and still reads as lifetime in the ledger.

- ✅ **SECOND SALE, FIRST ANNUAL — 2026-08-23.** Pro (Annual), ₹9,999 by UPI, key `35CF-B8B5-8E`,
  receipt **VY-2026-002**, buyer Shivangi Kulkarni (`extra.drive1409@gmail.com` — related to the
  lifetime buyer, different household, separate key on purpose). Same flow, `--years 1`.
  **Expires 2027-08-23** — the ledger's first key with a date, status `active`. Backup
  `vyuha-keys-2026-08-23.vkb` verified to hold the 1,500-byte 4-key ledger and copied off-device.
  One trap this run: a same-day second backup is REFUSED (no overwrite), so the morning's bundle
  was renamed `-a` first. **ACTIVATED by the buyer the same day.** The featured SKU has now been
  sold AND activated. **Both SKUs are proven end to end** — two real customers, two receipts, two
  activations, zero support tickets.

**RENEWAL DIARY — nothing in the system reminds you.**
| Key | Buyer | Expires | Chase from |
|---|---|---|---|
| `35CF-B8B5-8E` | Shivangi Kulkarni | **2027-08-23** | 2027-07-23 (the app shows the buyer a 30-day countdown from then; you see nothing) |

**Recommended next move:** the sale flow is proven on both SKUs. First-run onboarding (§8.4) is now
the highest-leverage build — it is the only item that changes whether a STRANGER buys.

### 8.2 Release-day actions — BOTH now run (updated 2026-08-24)

- ✅ winget: PR [#421585](https://github.com/microsoft/winget-pkgs/pull/421585) submitted
  2026-08-20, all validation passed, awaiting a community moderator (details in the §2 winget row).
- ✅ Microsoft false-positive submission: WDSI, 2026-08-22, all three v2.99.100 binaries
  (case IDs in the §2 Defender row).

The standing fact that made these matter: **SmartScreen reputation accrues per FILE HASH**, so a
53-tag cadence guarantees every buyer meets a cold warning until winget carries the install.
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

- ✅ **Load testing is 14 of 14** (C8 added 2026-08-21). Five defects fixed (B1, B2, B5, B6, C2-adjacent),
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
- ✅ Screenshots retaken 2026-08-15 by `scripts/retake-screenshots.mjs` (23 shots): `skin-royal.png` is
  deleted; the set is dashboard, trades, lenses, pricing, staged-position, arjuns-eye, rom-report,
  kpi-drilldown, playbooks, calculator, risk, options-journal, edge-report, tax-pack, surveillance,
  settings-appearance, custom-theme and skin-{lime,rose,ember,sapphire,aurora}; README renders the
  new set (guarded by `tests/readme-claims.test.ts`).
- Intraday data: NOT required (owner 2026-08-15) — drop from the ceiling list until reopened.

### 8.5 Open questions the owner never answered

Whether to collapse "theme" and "accent skin" into one list (9 skins × light/dark × tint ×
panel style keeps multiplying axes).

*(Closed 2026-08-22: the refund/terms sign-off is COMPLETE — every step in
`REFUND_TERMS_SIGNOFF.md` is answered, the banners are gone, and jurisdiction stays "the laws of
India" with no city named, by the owner's decision. The one thing still outstanding is a
qualified legal read, which is an exposure rather than an open question.)*

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
- Public launch is planned as **3.0.0** (gated on first-run onboarding, owner 2026-08-23).

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
