# Doc audit — the per-release checklist for every buyer-facing surface

**Why this file exists.** Before v2.99.96 this list lived only in a chat as a
"17-item list", and it was lost when that chat was cleared. Two releases then
shipped TERMS/PRIVACY saying "Applies to v2.99.93" and a deck chip two versions
behind. This file replaces that list, is versioned with the code, and points at
the test that guards each row where one exists. Where the column says
"eyes only", nothing fails CI — that row is the one to actually read.

Run through the table top to bottom on release day, before `npm run
client:package`, and again after (the ZIP packs `docs/client/*` at build time,
so a doc fixed after packaging is a doc the buyer does not get).

## The table

| # | Surface | File(s) | What to check | How verified / which test guards it |
|---|---|---|---|---|
| 1 | Client "What's new" | `docs/client/README.md` (packed as `WHATS_NEW.md`) | A `## New in v<this release>` section at the top of the log, in the same table style; every row describes something that actually shipped in this build (grep the bundle for a marker if unsure). | `tests/client-docs-version.test.ts` — newest `New in vX.Y.Z` heading must be ≥ `package.json`. Content accuracy: eyes only. |
| 2 | Installation guide | `docs/client/INSTALLATION_GUIDE.md` | Installer filename pattern, size (~35 MB), SmartScreen "More info → Run anyway", the v2.99.96+ "no terminal window; log at `%APPDATA%\in.vyuha.tradejournal\logs\sidecar.log`" line, trial length, licence activation steps. Nothing about macOS. | Eyes only. macOS absence: grep `-i macos` over `docs/client/` must return nothing (owner decision 2026-08-15, VYUHA-STATE §7.5). |
| 3 | Getting-started deck — version chips | `docs/client/GETTING_STARTED_DECK.html` | Both `vX.Y.Z` chips (hero + footer) equal the release; nothing else in the deck names an older version. | `tests/client-docs-version.test.ts` — every `vX.Y.Z` in the deck must be ≥ `package.json`. |
| 4 | Getting-started deck — broker + feature lists | same file | Six auto-detected brokers (Zerodha, Dhan, Groww, Angel One, Upstox, Paytm Money) + column mapper + three API pulls (Zerodha Kite, Dhan, Angel One SmartAPI — `lib/import/api/`); Pro screen list matches `PRO_FEATURES`; skin roster matches `lib/domain/skin.ts` (eight skins from v2.99.96). Do not restructure the deck to do this — edit text in place. | Eyes only. Source of truth for brokers: `lib/import/registry-meta.ts` (`tests/import-registry.test.ts` guards the in-app hint, not the deck). |
| 5 | Terms — "Applies to" | `docs/client/TERMS.md` line 9 | `**Last updated:** <release date> · **Applies to:** Vyuha v<release> and later`. Also: the two plan names and their grant wording still match `lib/domain/pricing.ts` SKUs. | `tests/client-docs-version.test.ts` — version ≥ `package.json`. Date: eyes only. |
| 6 | Privacy — "Applies to" | `docs/client/PRIVACY.md` line 3 | Same line format as Terms. Re-read "the one network call" paragraph if anything about update/revocation fetches changed. | `tests/client-docs-version.test.ts` — version ≥ `package.json`. |
| 7 | Refund policy | `docs/client/REFUND_POLICY.md` | `Last updated` date; the 7-day window and "final after that" match the landing-page FAQ word for word in substance; the owner-discretion/tampering footnote is still wanted (see `REFUND_TERMS_SIGNOFF.md`); the OWNER banner at the top is deleted before the first paid sale. | Eyes only. Consistency with the landing page: `REFUND_TERMS_SIGNOFF.md` step 8. |
| 8 | No indicator wording in client docs | `docs/client/**`, `docs/sales/landing-page.html` | Nothing that ships to a buyer mentions TradingView / Pine Script / indicators (invite-only, not sold). | `tests/no-indicators-in-client-docs.test.ts` (HTML comments excluded). |
| 9 | Landing page — version, prices, FAQ | `docs/sales/landing-page.html` | Hero pill `vX.Y.Z`; every price cell equals `lib/domain/pricing.ts` (₹9,999 / ₹13,000 · ₹29,999 / ₹35,999 today); the upgrade-credit sentence verbatim; refund FAQ (~lines 439–446) matches `REFUND_POLICY.md`; no macOS. Then **`npm run landing:build`** to regenerate `landing-page.standalone.html`. | Prices + upgrade sentence: `tests/pricing.test.ts` anti-drift block. Version pill: eyes only (grep `2\.99\.9`). Standalone freshness: `git status` shows both files changed together. |
| 10 | Brochure — version, prices | `docs/sales/brochure.html` | Pill `vX.Y.Z`; prices; upgrade-credit sentence; no macOS. | Upgrade sentence: `tests/pricing.test.ts`. Version + prices: eyes only. |
| 11 | Root README "New in" | `README.md` | A `> **vX.Y.Z — …**` blockquote for the release at the top of the "New in" chain; the version badge is dynamic (GitHub tag) so needs nothing. Do not duplicate a note another pass already added — grep the version first. | Eyes only. |
| 12 | VYUHA-STATE §2 | `VYUHA-STATE.md` "## 2. Current state — verified <date>" | Verified date is today; numbers (test count, e2e count, release) are the ones you just measured, not recalled. | Eyes only — by construction (it is the handoff contract). |
| 13 | CHANGELOG | `CHANGELOG.md` | `## vX.Y.Z — <one-line claim>` at the top; each item is something the bundle actually contains. | Eyes only. |
| 14 | Client ZIP rebuild | `npm run client:package` → `release-packages/` | Run AFTER rows 1–8 are done. Open the ZIP: `WHATS_NEW.md` first heading is this release; `TERMS.md`/`PRIVACY.md` "Applies to" is this release; deck chip is this release. | Eyes on the ZIP contents. The build script copies `docs/client/*` at build time (`scripts/build-client-package.mjs` ~L109–123), so a stale doc is a stale ZIP. |
| 15 | Release-day action — winget | `npm run winget:manifest` then `wingetcreate submit …` | Release is public, `.exe` asset live, SHA-256 matches, then submit (first release) or `wingetcreate update` (later releases). | Procedure: `WINGET_AND_SMARTSCREEN.md`. Nothing in CI. |
| 16 | Release-day action — WDSI submission | <https://www.microsoft.com/en-us/wdsi/filesubmission> | Upload this release's `Vyuha_<v>_x64-setup.exe` as a software developer, false-positive path. Reputation is per FILE HASH — every release, no exceptions. | Procedure: `WINGET_AND_SMARTSCREEN.md`. Nothing in CI. |

## Order that avoids re-doing work

1. Rows 1–8, 11–13 (text edits) → `npx vitest run tests/client-docs-version.test.ts tests/no-indicators-in-client-docs.test.ts tests/pricing.test.ts`.
2. Row 9–10 → `npm run landing:build`.
3. Version bump (`npm run bump-version x.y.z`, then the two hand-edits the release skill lists).
4. Row 14 (`npm run client:package`), open the ZIP.
5. Tag, CI, `npm run release:verify`.
6. Rows 15–16 once the GitHub release is public.

## What this file is not

It does not replace `docs/owner/README.md` (what each owner doc is for),
`CODE_SIGNING.md` (why the installer is unsigned) or the `release` skill (the
build/sign/tag procedure). It is only the list of *words a buyer reads* that go
stale silently, and the proof for each.
