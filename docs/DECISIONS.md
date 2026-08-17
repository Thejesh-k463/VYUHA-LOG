# Decisions

Append-only. Newest first.

Facts that cost something to learn: measured numbers, choices where the obvious
option loses, surprising bug causes, deliberate deviations from a spec or
default, and things intentionally NOT done.

**Read this before changing a constant that looks arbitrary, or before
re-measuring something.** An odd value with an entry here is a landmine with a
sign on it.

Never edit an old entry to match new reality — append a new one that supersedes
it and say which. A changed mind is itself information.

Format:

```markdown
## <date> — <short claim, stated as the fact>

**Context:** what was being done, in one sentence.
**Measured / found:** the actual numbers or observations, with the method.
**Decision:** what we chose.
**Why not the obvious thing:** the alternative and why it loses.
**Invalidated if:** the condition under which to revisit this.
```

---

## 2026-08-15 — The landing page is hosted on GitHub Pages from `main:/docs` via a redirect, not a copy

Public URL: https://thejesh-k463.github.io/VYUHA-LOG/ → `docs/index.html` (meta-refresh) →
`sales/landing-page.html`, so `../screenshots/*.png` resolve as-is. A copy at `docs/index.html`
would have drifted from the file `tests/pricing.test.ts` pins; the redirect keeps one source.
Pages was enabled with `gh api -X POST repos/…/pages -f source[branch]=main -f source[path]=/docs`;
first build ~1 min; verified 200 on root, landing page and a screenshot. `docs/.nojekyll` added so
underscored paths are served. Everything under `docs/` (incl. `docs/owner/*`) is public — it already
was, the repo is public; nothing secret lives there (verified: secrets are gitignored at root).
Superseded: HOW_TO_EDIT_SALES_ASSETS "host it anywhere / when hosting exists" (2026-08-13).

## 2026-08-15 — Screenshots come from synthetic fixtures via one script; skin-royal retired from every surface

`scripts/retake-screenshots.mjs` (22 shots, temp DB, `dhan-gtr.csv` + `dhan-pnl.csv` last for
the seller journal, settings set via `POST /api/settings`) is the only sanctioned way to refresh
`docs/screenshots/`. Reason: three hand-taken files (lenses, pricing, skins) had drifted two
releases; and screenshots must never show the owner's real book. `tests/readme-claims.test.ts`
fails if README references a screenshot that does not exist.

## 2026-08-15 — Reinstall over a running copy failed on `server\node\node.exe`: the sidecar was only killed on WindowEvent::Destroyed, and Tauri's NSIS template stops vyuha.exe alone

**Context:** buyers upgrading v2.99.96 → next saw the NSIS dialog "Error opening file for writing … server\node\node.exe".
**Measured / found:** the Node sidecar was stopped only in the `WindowEvent::Destroyed` handler. An in-app update, a crash, or a Task-Manager kill of `vyuha.exe` never reaches that handler, so `node.exe` outlived the shell and held the file lock. Tauri's stock NSIS template kills the main executable only. Clicking *Ignore* was harmless — the locked file is byte-identical (same Node 22.17.0) — but nobody reads an installer error as harmless.
**Decision:** `stop_sidecar()` (kill + wait) runs on `WindowEvent::Destroyed`, on `RunEvent::ExitRequested` and `RunEvent::Exit`, and immediately before `update.download_and_install`. The NSIS `PREINSTALL` / `PREUNINSTALL` hooks additionally stop any `node.exe` / `vyuha.exe` whose `ExecutablePath` is under `$INSTDIR` — a `Get-CimInstance` filter, with `$INSTDIR` handed to PowerShell through an environment variable so a path with spaces or quotes never needs escaping.
**Why not the obvious thing:** `taskkill /IM node.exe` kills every Node process on the machine — a developer's dev server, another Electron app's helper — for a file we could otherwise leave alone. Killing by path is the only version that touches nothing but ours.
**Invalidated if:** the sidecar stops being a separate `node.exe` (single-binary sidecar), or Tauri's NSIS template grows its own child-process cleanup.

## 2026-08-15 — Buy CTAs open a contact dialog, not a link: the desktop webview blocks external `target=_blank` and we ship zero runtime Tauri plugins on purpose

**Context:** every "Get Pro / Get Lifetime" button was an `<a target="_blank">` to WhatsApp; in the desktop app it did nothing.
**Measured / found:** the Tauri webview refuses to open external URLs in a new window unless the opener/shell plugin is present. The shell deliberately carries no runtime Tauri plugins (updater aside) — that is what keeps the Rust side small and the permission surface flat — so the click was silently swallowed. The same buttons work in a browser tab, which is why nobody noticed in dev.
**Decision:** every "Get …" opens a dialog that states the number (+91 73936 73714), the pre-filled message, **Copy number** and **Copy message** buttons, an *Open WhatsApp* link (works in browsers, inert but harmless in the desktop shell) and the offline note. Settings → License pills open the plan card in a popup rather than a comparison table.
**Why not the obvious thing:** adding `tauri-plugin-opener` for one link — a runtime dependency, a capability entry and a review surface for a button whose whole job is to get a phone number in front of the buyer. A dialog with a copyable number works identically online, offline, in-browser and in-shell.
**Invalidated if:** the shell ever gains the opener plugin for another reason — then the link can be primary again, but keep the copyable number.

## 2026-08-15 — Appearance: tint curves cut from spec 0.20/0.22/0.14 to 0.13/0.11/0.11 so every skin holds ≥9:1 (dark) / ≥7:1 (light) at intensity 100; tokens go inline on `<html>`, not as classes

**Context:** v2.99.97 adds a tint-intensity slider (0–100, default 50; presets Subtle 25 / Balanced 50 / Vivid 75; −/+ steps of 10), panel styles (Flat / Soft / Luxe / Glow) and a wallpaper, all driven by the pure engine `lib/domain/appearance.ts`.
**Measured / found:** with the spec curves (card-top 0.20, card-hover 0.22, sidebar surface 0.14) Lime dropped card-top/hover body-text contrast to 8.5:1 and Luxe's surface to 11.9:1 at intensity 100 in dark. Reduced to 0.13 / 0.11 / 0.11, the worst skin measures: dark canvas/card/surface ≥12:1, card-top/hover ≥9:1; light ≥7:1 across all eight skins at intensity 100. Chart tokens must stay literal colours (lightweight-charts renders an invisible series on `color-mix()`/`var()`), and lightweight-charts re-reads its theme only on a class change — so charts re-theme via an `appearance-tick` class toggle on `<html>` while the colours themselves are injected inline by `app/layout.tsx` (no first-paint flash; an inline style beats any class-scoped token without a specificity fight).
**Decision:** curves as above; panel styles are `html.panel-*` classes with overrides in `@layer utilities` at (0,2,1) specificity; Terminal + Glow deliberately degrades to a flat shadow (a glow on a monochrome skin is a smear). Custom theme is a ninth skin `custom`: 7 fields × dark/light (accent, analytics, money, sidebar, cards, borders, canvas), derived shades computed in code, per-row WCAG badge that warns and never blocks, "Start from <skin>" seeds from the computed tokens; saved only with the form and only while Custom is selected. Wallpaper: PNG/JPEG/WebP ≤12 MB, magic-byte sniffed, stored in `<data>/wallpaper/` outside backups (said on the Backup screen), fixed cover behind `<main>` with a theme-aware scrim `rgb(ch / var(--wallpaper-scrim))`, opacity slider, removed in print. Migration 0048 adds `tint_intensity`, `panel_style`, `custom_theme`, `wallpaper_stored_name`, `wallpaper_opacity`. `ice`/`royal` still map to `sapphire`.
**Why not the obvious thing:** keeping the spec curves — Vivid on Lime would put body text on a card-top below the 9:1 floor this project has held since the first skins. `color-mix()` for the scrim — it is exactly the value class lightweight-charts and older WebView2 builds mishandle; `rgb(ch / var())` is plain CSS Color 4. Blocking a custom colour that fails WCAG — the user typed it on purpose; a badge tells them the number and lets them decide. Putting the wallpaper in backups — a 12 MB image in every nightly backup for a decoration.
**Invalidated if:** a skin's base canvas or `--color-foreground` changes (re-measure the worst-case skin at intensity 100), or lightweight-charts starts honouring inline custom properties (then the tick class can go).

## 2026-08-15 — Trades table shows Entry/Exit PRICE, not Buy/Sell VALUE; qty 0 → "—", never ₹0; MTF own-% is derived or absent

**Context:** v2.99.96 replaces the Buy value / Sell value columns on /trades with Qty, Invested, Entry price, Exit price.
**Measured / found:** Every import path fills `avgBuyPrice`/`avgSellPrice` — `NormalizedTrade` (`lib/engine/types.ts:47–64`) declares both non-optional, so the 6 broker parsers, the generic column mapper and the 3 API pulls (Kite, Dhan, Angel One) cannot produce a row without them; nothing on this surface can be undefined. An open trade has one side with qty 0 and price 0.
**Decision:** a side whose qty is 0 renders "—", never ₹0 (a zero price is not a fact about the trade). Invested on an MTF row shows the trader's own contribution % computed as `(buyValue − mtfFundedAmount) / buyValue`, and the funded amount beside it; when `mtfFundedAmount` is null the cell says "funding not yet resolved" — no default margin is substituted (invariant 6).
**Why not the obvious thing:** keeping "Buy value" — a value is qty × price and hides the level the trader actually acted on; showing ₹0 for the missing side of an open trade reads as a fill at zero.
**Invalidated if:** `NormalizedTrade` ever makes either price optional (the "—" rule then needs a null branch too), or a parser starts writing legs without the aggregate on the parent row (invariant 5).

## 2026-08-15 — Skins v2.99.96: the hue wheel is nearly full; Lime 83° / Rose 329° / Ember chosen, Ice and Royal retired, surface tints ~1.30:1

**Context:** eight skins that tint canvas/card/border, and a test that no two skins share a primary or an analytics-vs-primary hex.
**Measured / found:** hues already taken: gold 42°, tape 45°, profit 157°, luxe 172°, cb-profit 217°, sapphire 224°, violet 255°, aurora 292°, loss 352°, cb-loss 38°. Rejected: coral (~16°, only 24° from loss), emerald (= profit), indigo (8° from Sapphire), sky (~198°, Ice reborn). Chosen: **Lime 83°** (13.29:1 dark / 5.41 light), **Rose 329°** (7.57 / 5.58), **Ember** (8.85 / 5.16 — 11° from the colour-blind-safe loss hue, accepted on Tape's precedent of 7° from gold). Ice ≈ Sapphire — identical analytics hex, distinguishable only by the primary; Royal's primary was Luxe's analytics hex. Surface tints composite the border at ~1.30:1 against the card (was 1.24) — note the 1.48:1 floor in the 2026-08-09 entry is for `--color-rule` (row separators), not `--color-border`.
**Decision:** SKINS = luxe, mono, tape, sapphire, aurora, lime, rose, ember; `asSkin` maps a stored "ice"/"royal" → "sapphire". To let the hex-distinctness test hold, Tape/Aurora analytics retuned #2dd4bf → #5eead4 and Sapphire analytics #e879f9 → #f0abfc.
**Why not the obvious thing:** keeping ten skins — two of them were the same skin twice, and a "choose your accent" list where two entries look alike is a bug the user files, not a feature. Picking coral/sky by eye lands inside the P&L or an existing skin's hue band, which is how Tape's money had to move (2026-08-11).
**Invalidated if:** the canvases or `--color-profit`/`--color-loss` hues change, or a ninth skin is proposed — measure its hue against this wheel first.

## 2026-08-15 — The desktop app's phantom console: node.exe is console-subsystem; fixed with CREATE_NO_WINDOW + a log file, readiness never depended on stdout

**Context:** buyers saw a second, blank terminal window behind the desktop app.
**Measured / found:** the Tauri shell is a GUI-subsystem process; the Node sidecar (`node.exe`) is console-subsystem. A GUI parent spawning a console child with inherited stdio makes Windows allocate a fresh console for the child. Sidecar readiness was always the TCP poll on the loopback port — stdout was never read for it.
**Decision:** spawn with `creation_flags(0x0800_0000)` (CREATE_NO_WINDOW) and point the child's stdout/stderr at `<data_dir>/logs/sidecar.log` (append; `src-tauri/src/lib.rs`). The log path is now in the client README and INSTALLATION_GUIDE.
**Why not the obvious thing:** DETACHED_PROCESS also hides the window but detaches the child from job/console lifetime; piping stdout into the parent needs a reader thread or the pipe buffer fills and blocks the sidecar. A file is the least machinery that keeps every line.
**Invalidated if:** the sidecar becomes a GUI-subsystem binary (then no console is allocated regardless), or the shell starts reading the sidecar's stdout for anything.

## 2026-08-15 — Load tests batch 2: five defects fixed with numbers, one prediction wrong, one non-defect proven

**Context:** `tests/load/` batch 2 (B1–B7, C2, C7) on synthetic books of 10k–320k trades.
**Measured / found:**
- **B1 lens grouping** — growth ratio 14.3 (55 ms @10k → 794 ms @40k). After a per-array index: 5.1–5.3 (69 ms @80k → 347 ms @320k). Test asserts ratio < 8.
- **B2 entitlement** — 200 spaced licence reads did 200 UPDATEs (the "last seen" mark rewritten every read). Now the mark is written only when ≥ 24 h past the stored mark → 0 UPDATEs across the run; a pure read 65 → 56 µs.
- **B5 `dbCounts`** — read 125,195 rows in 421 ms to count them; now `COUNT(*)`: 29 rows / 1 ms.
- **B6 encrypted restore** — two scrypt derivations (498 + 527 ms) → one (495 + 30 ms) via a derived-key cache: 5-minute TTL, 4 entries, keyed by sha256(salt | params | password).
- **B7 import detect** — 15 full XLSX decodes / 1,331 ms → 8 / 802 ms by memoising `rankParsers` per `ParseContext`. Getting to ≤ 2 needs the parsers to share one parsed workbook — pinned as an `it.fails` follow-up, not claimed.
- **C2** — prediction WRONG: the skipped-row warning was already emitted. Adjacent defect found instead: executions-shaped generic imports left `sourceRows` unset (6,491 lines → 4,226 positions reported as if 4,226 rows); now `sourceRows = rows − skipped`.
- **C7** — no defect: over 250k trades a naive float fold drifts 5.0e-4 paise pre-rounding and 0 after, against `SUM(net_pnl_paise)`. `getTradeStats` over 250k = 3.1 s, reported not fixed.
**Decision:** each fix ships with its load test asserting the new bound; C7's 3.1 s is recorded as the current cost, not a target.
**Why not the obvious thing:** "make it faster" without the ratio — B1's absolute time at 10k was fine; only the growth exponent showed the defect.
**Invalidated if:** the synthetic-book generator changes shape, or the entitlement mark's 24 h threshold is changed (B2's 0-UPDATE assertion depends on it).

## 2026-08-15 — Annual → Lifetime upgrade: full credit within the year, not pro-rata

**Context:** an annual buyer wants Lifetime part-way through the year (tooling: `scripts/license-upgrade.mjs`).
**Measured / found:** due = lifetime launch price − annual amount paid (₹29,999 − ₹9,999 = ₹20,000 at launch prices), for any upgrade inside the annual term.
**Decision:** full credit of the annual payment within its year — owner decision 2026-08-15. The same sentence appears on the pricing screen, landing page and brochure (`tests/pricing.test.ts` pins them verbatim).
**Why not the obvious thing:** pro-rata (credit × months remaining / 12) is "fairer" on paper and impossible to explain in one line on a pricing page; a buyer who cannot predict the number does not upgrade.
**Invalidated if:** the launch prices end (2027-01-01) — the credit then applies against the list price and the copy must say so.

## 2026-08-15 — Licence key archive: per-key plaintext to an owner-chosen folder, plus an AES-256-GCM bundle at scrypt N=2^15

**Context:** losing the signing PEM or the ledger means every issued key is unverifiable; the owner needs a backup that is not the working folder.
**Measured / found:** `license-issue.mjs --save-dir <folder>` writes each issued key as its own plaintext file to a folder the owner picks (an external drive, a synced folder). `scripts/license-backup.mjs` bundles the PEM + ledger with AES-256-GCM, key from scrypt N=2^15.
**Decision:** N=2^15 rather than the backup-format's 2^17 because this runs interactively on the owner's machine once per session, not per customer restore; the ~4× cheaper derivation is fine for a passphrase the owner chose.
**Why not the obvious thing:** reusing `lib/backup.ts`'s format — it is built for a customer's database and pulls the app's schema in; the key archive needs zero app imports so it still runs when the app does not.
**Invalidated if:** the PEM moves to a hardware key or a KMS, in which case the bundle carries only the ledger.

## 2026-08-15 — "Preview pane" defect closed: it was the dev-tool browser pane on the /trades dev build, not the app

**Context:** an item on the open list said the trades preview pane rendered blank.
**Measured / found:** the report came from the IDE browser pane against `next dev` on /trades — the same "networkidle is not hydration" behaviour recorded 2026-08-10. Nothing reproduces in the desktop build or a real browser.
**Decision:** closed, no app change.
**Why not the obvious thing:** chasing a rendering fix in `trades-client.tsx` for a symptom the pane manufactures.
**Invalidated if:** a user reports it from the desktop app with the sidecar log attached.

## 2026-08-15 — Launch-offer anchors are committed 2027 list prices, and the advertised percentages are derived, not the ones the owner asked for

**Context:** Owner requested strike-through launch pricing ("₹13,000 → ₹9,999, 30% off"; "₹35,999 → ₹29,999, 20% off, best value") plus a competitor table on /pricing.
**Measured / found:** 9,999/13,000 = 23.08% off and 29,999/35,999 = 16.67% off — the requested "30%/20%" labels do not survive division. A first cut used `Math.round`, and the review pass caught 16.67 → "17% off": rounded UP, overstating the discount. Anchors previously did not exist anywhere in the repo (grep for 13,000/35,999: zero hits); `wasInr` existed in the type, unused, and both `PricingTable` variants already rendered it.
**Decision:** Owner confirmed ₹13,000/yr and ₹35,999 as the REAL list prices effective **2027-01-01** (recorded here and in MONETIZATION_PLAN §2; deliberately NOT rendered in-app — owner's call). Percentages ship as the derived-and-FLOORED **23% / 16%** via `offerPct()` in `lib/domain/pricing.ts` — floor, not round, because a discount claim must never overstate; understating by <1% is fine. `featured` moved from annual to lifetime — the owner sells lifetime first. Lifetime's roadmap line (mutual funds, gold) is labelled "planned, not yet shipped".
**Why not the obvious thing:** Shipping the requested 30%/20% — a stated percentage that fails division is a false claim of exactly the kind v2.99.94 retired, and a fabricated anchor is a CCPA-2023 dark pattern. The alternative anchor (₹14,299 to make 30% true) was offered; the owner kept ₹13,000.
**Invalidated if:** The offer is still running past 2027-01-01 (the anchors then stop being true and must come off every surface), or the owner repriced again.

## 2026-08-15 — Competitor comparison cells are sourced-or-"Not stated", with † for third-party pricing

**Context:** Building the /pricing and landing-page comparison tables (owner approved the full 7-product version, cheap Indian journals included).
**Measured / found:** Official pricing pages read 2026-08-15: TradeZella $315/yr base, Edgewonk $197/yr, TradesViz ₹12,600/yr (their own ₹), OneTradeJournal ₹1,999–2,499/yr (two figures on their own page), TradeDiary ₹999/yr. TraderSync (HTTP 403) and Tradervue (404) pricing came from agreeing third-party 2026 reviews → flagged † on every surface. No competitor page states an independent Indian statutory-charges engine; none advertises local-only storage.
**Decision:** Data lives in `lib/domain/pricing-comparison.ts` (pure, zero imports) with `COMPARISON_AS_OF = "2026-08-15"`; unverifiable cells say "Not stated", never a guess; "why Vyuha" rows are architecture/arithmetic only — no outcome claims (SEBI posture).
**Why not the obvious thing:** Omitting the ₹999–2,499 Indian competitors would make the table look better and be exactly the selective honesty the product positions against; a buyer who googles finds them anyway.
**Invalidated if:** Any competitor repricing (recheck the sources before a release that touches pricing copy), or TraderSync/Tradervue pages become fetchable — replace the † cells with primary figures.

## 2026-08-11 — Royal/Sapphire/Aurora skin triples: measured before written, floors matched to the shipping four

**Context:** v2.99.70 adds three "more vibrant, luxurious" accent skins next to Luxe/Mono/Ice/Tape.
**Measured / found:** (WCAG contrast on the real canvases #05080f dark / #f4f6f9 light; circular hue separation; script — contrast + `colorsys` HLS hue.)
- royal `#a78bfa/#e5b13d/#22d3ee` dark 7.36/10.20/11.09, light `#6d28d9/#8f6207/#0e7490` 6.56/4.95/4.95; min role-sep 67°/70°; primary 89–97° from P&L.
- sapphire `#7196ff/#e5b13d/#e879f9` dark 7.16/10.20/8.14, light `#1d4ed8/#8f6207/#a21caf` 6.19/4.95/5.84; min role-sep 68°/70°; primary 67° from P&L.
- aurora `#e879f9/#e5b13d/#2dd4bf` dark 8.14/10.20/10.76, light `#a21caf/#8f6207/#0b7a70` 5.84/4.95/4.81; min role-sep 105–109° (widest of any skin shipped); primary 57–60° from P&L.
**Decision:** ship all three. Money stays GOLD in all three (no skin-tape-style money move needed — no primary lands near 41°). Worst case anywhere is aurora's light analytics at 4.81:1 — exactly equal to the recorded worst the first four skins already ship (Tape light), so the floor did not move. Sapphire's dark primary 7.16:1 is marginally under Royal's 7.36 benchmark and accepted: it is body-text-large/UI accent usage, > 7:1.
**Why not the obvious thing:** picking Tailwind palette hexes by eye — that's how skins drift under the 4.5:1 light-theme floor and land primaries 4° from gold (the measured reason Tape's money moved to violet).
**Invalidated if:** the canvas colours change, or `--color-profit`/`--color-loss` hues move (157°/352° today).

## 2026-08-11 — Metallic gold retune: #e5b13d → #f0b429 triple, gradient text from TOKENS

**Context:** owner asked for the money gold to look "metallic and vibrant" (v2.99.70).
**Measured / found:** #f0b429 base (10.75:1 on #05080f, hue 41.9° vs the old 41.4°, sat 76→87%), #ffd863 highlight (14.55:1), #cf8d12 shadow (7.13:1) — all above the old values' contrast, hue essentially unchanged so the 41° gold doctrine holds. Light theme untouched: #8f6207/#966808/#6f4b05 are already the lightest AA-clearing golds at this hue (documented at the light block).
**Decision:** retune the three dark gold tokens + `--color-warning`; resurrect the dead `text-grad-gold` utility as a vertical highlight→base→shadow gradient built from `var(--color-gold-*)` with a `drop-shadow` glint, applied to the 8 KPI-scale money values.
**Why not the obvious thing:** literal gradient stops (what the utility had) would paint GOLD money on the Tape skin, whose whole design is that money moved to violet — tokens make the metal follow each skin's money colour for free. And `box-shadow` can't glint clipped text; `drop-shadow` follows the glyph alpha.
**Invalidated if:** the canvas colours change, or a skin re-points gold tokens to something whose bright/deep don't darken monotonically (the gradient assumes bright > base > deep).

**Context:** Wave 2 of the performance program. `babel-plugin-react-compiler`
sat in devDependencies and the codebase's comments were written assuming the
compiler was on — but `next.config.ts` never enabled it. This was the
deliberate, isolated enablement attempt (a wave with no other client change,
so anything that broke would bisect to the flag).

**Measured / found:**
- `reactCompiler: true` (top-level Next 16 key) compiles and passes the full
  unit suite + build. The failure is at HYDRATION: SSR and the client bundle
  collapse JSX source whitespace differently at `</b>` + newline-indented-text
  boundaries. Server rendered `" of realised P&L sits…"` (leading space),
  client rendered `"of realised P&L sits…"` — a one-character disagreement
  that throws "Hydration failed" and REGENERATES THE ENTIRE CLIENT TREE on
  every visit to an affected page.
- **Bisect:** same route, same DB — 3 hydration errors with the flag on,
  0 with it off. Unambiguously compiler-caused.
- Fixing the first site (dashboard equity-curve note, moving the space into an
  explicit string expression) just surfaced a SECOND identical site
  (calendar-heatmap's "and cannot appear on any day…"). The pattern —
  an inline element followed by newline-indented text — is everywhere in this
  codebase; enumerating and rewriting every site to dodge an upstream bug was
  rejected as whack-a-mole that would also make the JSX worse to read.
- The three compiler-sensitive surfaces themselves (TanStack sorting under
  "use no memo", the sidebar's deferred mount-restore, the debounced charge
  preview) all PASSED under the compiler — the codebase's effect discipline
  held. The whitespace bug is the only blocker, and it is not ours.

**Decision:** `reactCompiler: false`, with the reason in next.config.ts.
KEPT: DataTable's `"use no memo"` (inert without the compiler, mandatory with
it) and `e2e/z-compiler-protocol.spec.ts` (guards the silent-failure surfaces
against any future retry or memoization refactor). Also kept: the
dashboard-client string-expression form — inert now, correct later.

**Invalidated if:** babel-plugin-react-compiler releases past 1.0.0 with a
whitespace fix, or Next/Turbopack aligns the two pipelines' JSX text
normalisation — retry by flipping the flag and running
`z-compiler-protocol.spec.ts` plus a hydration-error grep of a dashboard
visit's server log (the exact procedure above).

---

## 2026-08-10 — /trades at scale: slim projection + row virtualization, with numbers

**Context:** Wave 1 of the performance program. At 252 real trades the full
`Trade[]` RSC payload measured 1,632 B/row; extrapolated to a 10k-trade book
that is ~16 MB per navigation plus ~500k DOM nodes — unusable.

**Measured / found:**
- Slim projection (`lib/domain/slim-trade.ts`, 43 of 74 columns — the union
  the client tree actually reads): **907 B/row, a 44.4% cut** → ~8.7 MB at
  10k rows (`scripts/measure-slim.mjs`, real data). The dialogs needed NO
  fetch-on-open — `notes`/`ruleViolations` stay in the projection.
- Virtualization (`data-table.tsx` `virtual` prop, @tanstack/react-virtual,
  spacer-row technique): the DOM holds ~30 rows of 122 in e2e; selection,
  per-view counts and "N of M" all read the full filtered array, so no
  semantics moved. Sticky header/left survive because windowing is y-only.
- Composite index `(account_id, sell_date DESC, created_at DESC)`:
  EXPLAIN QUERY PLAN now reads `SEARCH trades USING INDEX
  trades_account_sell_created_idx` — no temp B-tree sort — for the query ~25
  force-dynamic pages run on every navigation.
- xlsx (401 KB chunk): statically imported by `components/ui/export-button.tsx`
  via `lib/export.ts`, it rode 13 routes' client bundles. After the dynamic
  import, **0 page manifests reference the chunk** (verified against
  `.next/server/app/**/page_client-reference-manifest.js`).
- The e2e contract change that follows from virtualization: row counts in
  specs must come from the "N of M" counter, never `tbody tr` counts —
  rendered rows < population is the FEATURE. And any spec locating a row must
  narrow (view/search) first: open rows sort below the window in the default
  DESC order (SQLite NULLs sort last in DESC).

**Why not the obvious thing:** TanStack `columnOrder`-style server pagination
was rejected — it breaks the counts-reconcile contract and moves the
derive-don't-sync filter architecture into SQL. Client virtualization alone
was rejected — it leaves the 16 MB flight payload untouched.

**Invalidated if:** a column starts reading a dropped field (tsc breaks — add
it to SLIM_TRADE_FIELDS), or DataTable's rows stop being a uniform floor
(measureElement already handles growth, but a variable-height redesign should
re-check overscan).

---

## 2026-08-10 — NSE surveillance files: two formats verified from real downloads; one file covers ASM+GSM+ESM

**Context:** replacing the Surveillance screen's paste-only workflow with file
upload. The repo had zero knowledge of these formats and AGENTS.md forbids
inventing parsers for unpublished formats.

**Measured / found (real downloads, 2026-08-10, using the anti-bot headers
from `lib/jobs/auto-mtm.ts`):**
- **F&O ban:** `https://nsearchives.nseindia.com/content/fo/fo_secban.csv`
  (dated archives at `/archives/fo/sec_ban/fo_secban_DDMMYYYY.csv`). Shape: a
  header line `Securities in Ban For Trade Date 10-AUG-2026:` then numbered
  `1,BANDHANBNK` rows. The DATE IS IN THE FILE.
- **ASM/GSM/ESM:** the consolidated Surveillance Indicator file
  `https://nsearchives.nseindia.com/content/cm/REG_IND{DDMMYY}.csv` (note the
  SIX-digit date, and `/content/cm/`, not `/content/equities/` — both probed,
  only cm answers). ~2,970 rows, one per listed security; columns include
  `Symbol`, `GSM`, `Long_Term_… (Long Term ASM)`, `Short_Term_… (Short Term
  ASM)`, `ESM`. **Value scheme: the cell holds the STAGE; the sentinel `100`
  means "not under this measure"; GSM stage `0` is a real stage** (68
  securities carried it). The date is only in the FILENAME.
- Counted in the live file: 77 GSM, 126 LT-ASM, 56 ST-ASM, 320 ESM.
- BSE publishes its lists as notices/web tables — no machine-readable file
  found, so BSE stays paste-only, stated in the UI (owner-approved scope).

**Decisions that followed:**
- One REG_IND upload replaces categories gsm+asm+esm; the ban file replaces
  fno_ban only — `replaceRestrictionCategories` deletes per-category, because
  a whole-table replace (what paste correctly does) would make the day's
  second upload erase the first.
- `esm` became a first-class RestrictionCategory rather than mislabelling 320
  securities as "asm" or hiding them in "other".
- Detection is fingerprint-gated (ban header line / the exact REG_IND column
  family); a CSV that merely has a Symbol column is refused with the headers
  it actually saw. Trimmed REAL files are committed as `tests/fixtures/
  fo_secban.csv` and `tests/fixtures/REG_IND070826.csv`.

**Invalidated if:** NSE renames the REG_IND columns or moves the files —
`tests/nse-surveillance.test.ts` fails on the fixtures' shape, and the
refusal message shows users the headers of whatever the new file looks like.

---

## 2026-08-10 — Index derivative market lots, verified for the January 2026 series

**Context:** the Trade Calculator's new "Underlying index" picker bundles a
lot-size snapshot (`lib/domain/index-contracts.ts`).

**Measured / found:** every NSE index lot CHANGED for the January 2026 series —
NIFTY 75→**65**, BANKNIFTY 35→**30**, FINNIFTY 65→**60**, MIDCPNIFTY
140→**120** (NSE circular **FAOP70616**, effective with contracts expiring
January 2026 onward; the December 2025 monthly expiry was the last on old
lots). BSE: SENSEX **20** (raised 10→20 during 2025, unchanged in the January
revision), BANKEX **30** (15→30). Cross-checked 2026-08-10 against Zerodha's
support table and Sahi's published 2026 table — three sources agree on all six.
Model memory had four of the six WRONG (it predates the January revision),
which is exactly why the plan gated this on a live search.

**Decision:** `BUNDLED_INDEX_LOTS = {NIFTY:65, BANKNIFTY:30, FINNIFTY:60,
MIDCPNIFTY:120, SENSEX:20, BANKEX:30}`, `INDEX_LOTS_AS_OF = "2026-01-01"`.
The snapshot is the FALLBACK: a row in the instruments table (the user's own
`fo_mktlots.csv` upload) beats it, and the UI names whichever source it used
plus its date. `tests/index-contracts.test.ts` pins the values so a refresh
must touch the literals and the AS_OF together.

**Invalidated if:** a later exchange circular revises any lot — re-verify all
six against the circulars (not memory, not this entry) and update
`index-contracts.ts` + the pinned test + this log in one commit.

---

## 2026-08-10 — Plain `npm install` ALSO corrupts this lockfile; adding a dep needs a hand-merge

**Supersedes the scope of** the "never `npm install --package-lock-only`" rule in
AGENTS.md, which is correct but is NOT the whole hazard.

**Context:** adding `lightweight-charts` for the trade replay chart.

**Measured / found:** `npm install lightweight-charts` — plain, no flags, with a
fully installed tree to consult — reported *"added 2 packages, removed 27
packages"* and wrote a lockfile of **16 additions against 512 deletions**. What
it deleted was `node_modules/vitest/node_modules/esbuild` (0.28.1) and all 26 of
its `@esbuild/*` platform variants. Reproduced from a pristine `npm ci` tree, so
it is deterministic npm resolver behaviour, not a damaged working tree.

It is worse than the platform-drop failure AGENTS.md records. `vitest@4.1.9`
depends on `vite@8.1.2`, which requires `esbuild "^0.27.0 || ^0.28.0"`; the
nested 0.28.1 satisfied it. With that entry pruned, vite falls back to the
top-level `esbuild@0.25.12` and `npm ls esbuild` fails outright:

    vitest@4.1.9 -> vite@8.1.2 -> esbuild@0.25.12 deduped invalid: "^0.27.0 || ^0.28.0"
    npm error code ELSPROBLEMS

So this breaks `npm ci` on **every** platform, Windows included — not only the
darwin/linux runners.

**Decision:** to add a dependency here, take HEAD's lockfile and splice in ONLY
the new package entries plus the root `dependencies` line, then prove it with
`npm ci` + `npm ls esbuild`. Splice into the existing key order — do NOT re-sort
`packages`: npm collates `_` differently from a plain `.sort()`, and a global
sort silently rewrote `node_modules/string_decoder` for an otherwise
byte-identical record (9 phantom deletions).

**Verification that this is fixed, not just quieter:** lock diff is 16 added /
0 deleted; the lock carries 26 nested and 26 top-level `@esbuild` entries with
darwin-arm64 / darwin-x64 / linux-x64 / win32-x64 present in both; `npm ci`
installs 767 packages with no error; `npm ls esbuild` resolves vite to 0.28.1;
`npm run verify` is 97 files / 1344 tests / build, exit 0.

**Invalidated if:** vitest's nested vite starts accepting the top-level esbuild
range (then the prune becomes legitimate and the nested block should go), or npm
fixes the resolver so a plain install stops pruning a still-required nested dep.

---

## 2026-08-10 — `networkidle` is not hydration: a client-restored setting is not readable right after a reload

**Context:** Verifying that the saved Trades column order survives a page
reload, in `e2e/column-order.spec.ts` and by hand in the browser pane.

**Measured / found:** After `page.reload()` + `waitForLoadState("networkidle")`
the table renders the DEFAULT column order. It is not broken — the order is
restored by client code, which cannot run before the route hydrates, and
`networkidle` reports network quiet, not hydration. In dev the Trades route is
large enough for that gap to be seconds. In the browser pane the page was still
unhydrated NINE seconds after load: clicking "Add trade" opened no dialog,
which is the cheapest hydration probe available and worth reaching for first.

**Cost of not knowing this:** it reads as "persistence is broken". It sent me
through rewriting the restore path onto `useSyncExternalStore` AND converting
the sidebar's two settings to match, on the theory that a microtask-deferred
`setState` was being dropped on the hydration path. The sidebar was never
broken; that change was reverted. The rewrite of the Trades path was kept
because it stands on its own — storage as the single source of truth, and it
answers `react-hooks/set-state-in-effect` by deriving rather than by deferring
the write out of the rule's sight.

**Decision:** assertions about client-restored state poll
(`expect.poll(..., { timeout })`), never assert once after `networkidle`. Before
concluding that any client behaviour is broken, prove the page is hydrated.

**Invalidated if:** the suite moves to a production build, where the gap
shrinks to milliseconds — the poll stays correct either way, just faster.

---

## 2026-08-10 — Column reordering permutes the `columns` ARRAY, not TanStack's `columnOrder`

**Context:** Adding drag-to-reorder to the Trades table, which renders through
the shared `components/ui/data-table.tsx`.

**Measured / found:** `DataTable` has two readers of the raw `columns` prop that
are POSITIONAL, while rendering goes through TanStack's `getHeaderGroups()`:
`budgetMinWidth(columns)` computes the table's min-width, and `stickyStyle(i)`
reads `columns[i].meta.width` to place the two pinned cells. Enabling TanStack's
`columnOrder` would reorder the DOM while leaving both of those describing the
OLD arrangement — the frozen pair would take its `left` offsets from whichever
columns happened to land at indices 0 and 1 (so they overlap or gap), and the
min-width would describe a layout that no longer exists, so the flexible column
collapses under horizontal pressure. Nothing throws; it is wrong at some
viewport widths and correct at others.

**Decision:** `lib/domain/column-order.ts` permutes the array itself, keeping
`i` and `columns[i]` in lockstep by construction. The pinned prefix is sliced
off before any reordering and re-attached after, so no stored array can move it
even if it names those columns.

**Why not the obvious thing:** `columnOrder` is the documented TanStack feature
and is one line. It is wrong here specifically because this table reads the prop
positionally — in a table that did not, it would be the right answer.

**Also measured:** `budgetMinWidth` is permutation-invariant, but NOT for the
reason it first appears. It is not that a pinned column claims the flexible
allowance first; eligibility for that allowance is a per-column property and
exactly one eligible column receives it, so the multiset of contributions — and
therefore the sum — is identical for every arrangement, pinned or not. It stops
being invariant only if the rule becomes positional. Both facts are asserted in
`tests/column-order.test.ts`.

**Invalidated if:** `DataTable` stops reading `columns` positionally, or the
flexible-width rule is rewritten in terms of column index.

---

## 2026-08-10 — A drag grip inside a `<th>` silently renames the column for screen readers

**Context:** The reorder grip is a real `<button aria-label="Reorder … column">`
placed inside each movable header cell.

**Measured / found:** A `columnheader`'s accessible name is computed from its
CONTENT, and a nested button contributes its own label. Every header therefore
announced as "Reorder netPnl column Net" instead of "Net". Found not by review
but by a Playwright locator: `getByRole("columnheader", { name: /^Net$/i })`
timed out after 90s against a table whose header visibly reads "Net".

**Decision:** the `<th>` names itself explicitly with `aria-label` equal to its
string header, so the visible text and the announced name match (WCAG 2.5.3);
the grip keeps its own label for when focus reaches it. Applied only when the
header is a plain string — for a rendered header the visible text is not known
at that point and the column id would announce worse than the pollution it
replaced. Pinned in `e2e/column-order.spec.ts`.

**Why not the obvious thing:** `aria-hidden` on the grip also cleans the name,
but it removes the only affordance from assistive tech entirely. The sidebar's
equivalent grip (`components/layout/sidebar.tsx`) has the same pointer-only
limitation and is left as-is: its rows are not `columnheader`s, so nothing
recomputes a name from them.

**Invalidated if:** the grip gains a keyboard reorder path (then it should be
exposed deliberately rather than worked around), or a Trades column is given a
non-string header.

---

## 2026-08-10 — Only the trade replay moves to lightweight-charts; every equity curve stays on recharts

**Context:** Replacing the recharts chart inside
`components/reports/trade-replay.tsx` (rendered on /reports/scaling) with
TradingView's lightweight-charts v5 (Apache-2.0), and deciding how far the swap
should go.

**Measured / found:**
- **The equity curve cannot follow.** `EquityCurve` also renders on
  /reports/monthly, the printable PDF, and `app/globals.css` carries an
  `@media print` block that forces a light palette. recharts is SVG, so its
  fills and strokes re-read those CSS custom properties during the print pass.
  A canvas cannot: lightweight-charts rasterises with the colours it was given
  at draw time, so a lightweight-charts equity curve would print a dark chart
  onto a white page. `components/dashboard/charts.tsx` is therefore out of
  scope, not merely unconverted.
- **lightweight-charts renders an INVISIBLE line, silently, if handed a colour
  it cannot parse.** It parses colour strings itself (hex, `rgb()/rgba()`,
  `hsl()/hsla()`, named) and understands neither `color-mix(...)` nor `oklch()`
  nor an unresolved `var()`. There is no throw, no console warning and no
  missing DOM node — the series just is not drawn. The browser is no help
  either: the computed value of an untyped custom property is the token stream,
  so `color-mix()` arrives as literal text. Every token the chart reads is
  literal hex today, verified live: `--color-primary #2dd4bf`,
  `--color-profit #16c784`, `--color-loss #f6465d`, `--color-gold #e5b13d`,
  `--color-border #94a3b824`, `--color-rule #94a3b83b`,
  `--color-muted-foreground #8a98a7`, `--color-foreground #e9eef5` (dark);
  `#0b7a70 / #15803d / #dc2626 / #8f6207 / #d7dee6 / #dbe2ea / #5b6675 /
  #14181f` (light).
- **`layout.attributionLogo` defaults to TRUE in v5** and paints an outbound
  tradingview.com link onto the chart pane.
- The library builds **one chart out of 7 stacked `<canvas>` layers** (pane ×2,
  right price scale ×2, time scale ×2, corner ×1). Counting canvases is
  therefore not a way to count charts: measured 7 canvases / 1 chart instance
  across three unmount→remount cycles and a client-side navigation away and
  back, which is what proves `chart.remove()` in the effect cleanup works.
- Adding the dependency with a plain `npm install` (never
  `--package-lock-only`, per AGENTS.md) also dropped 27 lock entries: the
  `vitest → vite` **optional peer** esbuild 0.28.1 and its 26 platform binaries.
  The `grep -c "darwin-\|linux-x64\|linux-arm64" package-lock.json` canary
  moved 202 → 190 for that reason alone. Every top-level platform variant
  (esbuild 0.25.12, `@next/swc-*`, `lightningcss-*`, `@rolldown/binding-*`)
  survived, and the suite is green without the nested copy — this is not the
  v2.99.5 failure mode, where a *required* dependency lost its darwin/linux
  variants.

**Decision:** lightweight-charts is used for the price replay only, loaded
through `next/dynamic(..., { ssr: false })` from a client component. A theme
bridge (`components/charts/lw/theme.ts`) reads the tokens and asserts their
parseability in dev; translucent shades come from a local `withAlpha()` helper,
never `color-mix()`. `attributionLogo` is set to `false` — this app is offline,
local-first and zero-telemetry, so an outbound link in the UI is unacceptable;
the Apache-2.0 attribution is carried in package metadata and here instead.
`layout.background` is `transparent` so the Card gradient shows through.
Re-theming rides a single `MutationObserver` on `document.documentElement`'s
`class` attribute, mutating the chart imperatively with no React state.

**Why not the obvious thing:** Converting every chart at once. It would have
looked consistent and broken the monthly PDF in a way that only shows up on
paper — the one output nobody re-checks after a chart refactor.

**Invalidated if:** The `@media print` block leaves `app/globals.css`, or
/reports/monthly stops rendering `EquityCurve`; or the theme tokens stop being
literal colours, at which point the dev assertion in
`components/charts/lw/theme.ts` fires and the chart needs a
`customColorParsers` entry rather than a token read.

## 2026-08-09 — The desktop build ran every step twice

**Context:** Investigating why `npm run desktop:build` took so long.
**Measured / found:** The log showed two "Creating an optimized production
build" and two "assembling desktop-dist". `desktop:build` ran `next build &&
build-desktop.mjs` and then invoked Tauri, whose `beforeBuildCommand` is
`npm run build && npm run desktop:bundle` — the same two steps. Cost per
duplicate pass: a Next compile, a typecheck (19.3s + 13.2s across the two), a
template-DB seed, and a copy of an 81 MB node.exe into a 168 MB tree.
**Decision:** `desktop:build` is now just `node scripts/tauri-build.mjs`.
Measured after the change: 292s wall, 1 Next pass, 1 assembly pass.
**Why not the obvious thing:** Removing `beforeBuildCommand` instead would
break CI — tauri-action reads it from the config and silently ignores one
passed as a workflow input. The AGENTS.md "always rebuilds the bundle" rule
still holds; it just happens once, where Tauri asks for it.
**Invalidated if:** `beforeBuildCommand` is removed from tauri.conf.json, or
`tauri-build.mjs` ever starts depending on desktop-dist existing beforehand.

## 2026-08-09 — Light-theme gold is #8f6207, not the handoff's #9a6b08

**Context:** Applying the v3 design tokens to light mode.
**Measured / found:** The handoff proposed ~#9a6b08. Against this app's real
light canvas #f4f6f9 that measures **4.33:1 — under the 4.5:1 AA floor**. It
only clears AA against pure white (4.69:1), and gold is small text here (charge
lines, MTF splits, warnings). #8f6207 holds the hue at 4.95:1. The ceiling at
this hue/saturation is ~#966808 (4.53:1), which is why the light ramp's bright
end is pinned there rather than at the dark theme's #f5d478.
**Decision:** Ship #8f6207; violet #6d28d9 verified at 6.56:1 and kept as-is.
**Why not the obvious thing:** Following the handoff verbatim. It gave hues
with no measured ratios, unlike the #0b7a70 precedent it was citing.
**Invalidated if:** The light canvas changes from #f4f6f9, or gold stops being
used for small text.

## 2026-08-09 — Table row separators need ~1.48:1, not the handoff's 1.12:1

**Context:** Applying the v3 token sheet, which specifies
`--color-rule: rgba(148,163,184,.08)`.
**Measured / found:** That composites to **1.12:1** over the new panel gradient.
A previously shipped value at 1.08:1 was found invisible on tables 250+ rows
deep; the fix then measured 1.48:1 and worked. Only those two data points exist,
so any value between them is a guess. Alpha .23 measured **1.471:1 live in the
browser** against the actual painted table background, on a 252-row table.
**Decision:** Keep the proven ratio in the rgba form v3 wants (alpha .23).
Documented inline at the token.
**Why not the obvious thing:** Following the spec. It never re-ran the original
measurement, and a header band plus a drop shadow give a table its OUTER
structure — they do nothing to separate row 180 from row 181.
**Invalidated if:** The panel background lightens materially, or tables stop
rendering more than ~50 rows.

## 2026-08-12 — A lens group carries its own ids, not a predicate that "should" match

**Context:** The Lenses page groups the book six ways and offers to delete any
group. Both `monthGroups` and the hand-entered group could have been expressed
as a scope the resolver re-derives (`dateRange` over the month; "everything with
no import batch").
**Measured / found:** They do not agree. A trade bought 20 Aug and sold 4 Sep is
filed under **September** by the month lens (exit date for a closed trade), but
`dateRange 2026-08-01→2026-08-31` with basis `either` **also matches it**. The
group would say 1 and the delete would remove 2. `tests/lenses.test.ts` pins
this on the real case.
**Decision:** Month and hand-entered groups carry `{kind:"filter", ids}` — the
group's own ids. Broker, segment and import-file groups keep their predicate
scopes, because there the predicate IS the grouping key and the two are the same
set by construction.
**Why not the obvious thing:** A predicate scope is smaller and reads better.
It is also how a confirmation dialog comes to show a number that is not what
gets deleted, which is the one failure `lib/domain/delete-scope.ts` exists to
prevent.
**Invalidated if:** `effectiveDateOf` stops being "exit for closed, entry for
open", or `DateBasis` gains a mode that matches the month lens exactly.

## 2026-08-12 — Delete writes a snapshot first, and aborts if it cannot

**Context:** Deletion grew from "the rows I selected" to whole import files and
date ranges. `restoreDatabase` is whole-database wipe-and-reload, so it can undo
one delete only by discarding everything since.
**Measured / found:** No undo, soft-delete or recycle concept existed anywhere
(`grep -rn "undo|soft.?delete|deletedAt|trash"` over app/ components/ lib/
returned only prose). The per-trade `audit_log.beforeJson` snapshot covers the
trade row **only** — not its legs, not its attachment rows, and the attachment
bytes were `rmSync`ed outright, which was the one genuinely irreversible step.
**Decision:** `lib/trash.ts` writes a scoped JSON snapshot before the
transaction and MOVES attachment bytes into it after the commit instead of
unlinking them. If the snapshot cannot be written, the delete does not happen.
Snapshots live beside the database (not inside it, not in backups) and are never
auto-purged.
**Why not the obvious thing:** A `deleted_trades` table is the conventional
answer. It sits inside the database the user may be about to restore, and it
travels inside backups — so restoring a backup would resurrect its own trash.
Auto-purge was rejected outright: a scheduled job destroying the last copy of
deleted work, on a schedule nobody chose, is a worse failure than a folder that
grows.
**Invalidated if:** Attachment volumes make unbounded retention impractical —
at which point the answer is a size report and a prompt, not a silent sweeper.

## 2026-08-12 — Back navigation: an in-app route stack, not `history.length`

**Context:** The app needed a back affordance. Assessed three shapes against the
actual route tree: browser-style global history, per-feature breadcrumbs, and
back-on-drill-downs.
**Measured / found:** The tree is **flat — 40 routes, zero dynamic segments**.
`reports/` and `targets/` have no index page, so a breadcrumb would render
"Reports › Monthly" where "Reports" is not a page. The only nested route,
`/trades/report`, opens via `window.open(…, "_blank")`, where back means
nothing. `grep -rn "router\.back"` over app/ and components/ returned **zero
matches**. The real gap is the Tauri shell, which has no browser chrome at all.
**Decision:** A module-level pathname stack (`components/layout/nav-history.ts`)
decides whether to offer the control and what to call it; `router.back()` still
performs the navigation. Breadcrumbs rejected. The Alt+← and mouse-button-4
handlers call `preventDefault()`.
**Why not the obvious thing:** `history.length` counts whatever preceded the app
in that tab, is browser-capped and never decreases — it cannot answer "is there
an earlier screen of THIS app". And binding the gestures without
`preventDefault` risks the worst outcome: on the web the browser goes back and
so do we, landing the user two screens away.
**Invalidated if:** The route tree gains real drill-downs with a nameable
hierarchy — breadcrumbs become the better answer at that point.

## 2026-08-12 — Import detection: a broker detector must present evidence, and shape is not evidence

**Context:** A Groww stocks order-history export imported as broker "zerodha" —
111 rows added, priced at Zerodha's rates, reported as success.
**Measured / found:** Running all seven real exports through the live registry
found not one misroute but two: `detectZerodha` claimed the Groww file at 0.30
on `symbol`+`isin` column shape, and claimed the Paytm Money tradebook at 0.35
because its filename contains the English word "tradebook". Zerodha's own
Console P&L, meanwhile, won only by a filename clamp at 0.30 — its trade table
starts past row 25 and at column B, where the header scan never looked. No
test asserted any detector REFUSES a foreign file; the kotakish regression
fixture stayed green only because it lacked an `isin` column. The generic
mapper scores a constant 0.05 and `detectParser`'s bar is `> 0`, so any
detector returning 0.06 on a foreign file steals it from the mapper.
**Decision:** Every broker detector must qualify on the broker's NAME (filename)
or a verified in-content fingerprint before shape adds anything; unqualified →
0 → the mapper asks. Fingerprints per format live in docs/BROKER_FORMATS.md,
each verified against a real export; `tests/import-detection-matrix.test.ts`
runs redacted copies of those exports through the registry and pins the full
cross-broker refusal matrix.
**Why not the obvious thing:** Raising the generic mapper's 0.05, or a global
threshold. Both treat the symptom: a detector that scores foreign files at all
will eventually outscore any constant. The rule has to live where the evidence
is read.
**Invalidated if:** A broker ships an export that genuinely carries no
distinctive content and no name — at which point that format belongs to the
generic mapper permanently, not to a weaker fingerprint.

## 2026-08-12 — Dhan GTR "73 rows, 0 trades": the import was innocent

**Context:** A GTR batch showed 73 rows / 73 added / 0 skipped while the trades
table showed none of them — rows in, nothing out, silently.
**Measured / found:** The same real GTR file replayed end-to-end (detect →
parse → commit) into a scratch DB: detected at 0.98, parsed to exactly 73
paired positions (92 bill lines pair down — `rowCount` counts positions, not
file lines), committed with added=73 and 73 trades tagged with the batch id.
`added++` sits on the line after the insert inside one transaction, so the
count and the rows cannot diverge at commit. The divergence was POST-commit:
trades removed later by a non-batch delete scope or a restore, with the batch
row left standing — the mirror of the "Import record removed" seam the Lenses
page surfaces.
**Decision:** No commit-path change. The pairing arithmetic is now visible
instead of alarming: parsers that pair set `sourceRows`, and the imports table
shows "92 → 73" with the pairing explained on hover.
**Invalidated if:** A future batch reproduces added > 0 with zero tagged trades
in a database whose audit log shows no delete and no restore between.

## 2026-08-12 — Paytm Money gets a parser: the unpublished-format rule, deliberately set aside

**Context:** AGENTS.md forbids inventing a parser for a format nobody has
published — written when Kotak Neo, Paytm Money and Sahi documented their
export columns nowhere, so any parser would have been guesswork with silent
failure modes.
**Measured / found:** A real Paytm Money tradebook export now pins the layout:
metadata rows 1–4 (`UCC`/`Name`/`PAN Number`/`Period`), header on row 5, one
row per execution WITH a full charge breakdown (Brokerage, ETT, GST, STT,
SEBI, Stamp Duty) — richer than Zerodha's tradebook, which carries no charges.
The sample held zero data rows: headers and fingerprints are VERIFIED, value
semantics are INFERRED and tested against synthetic rows only.
**Decision:** Build `paytm-tradebook.ts` — the rule's reason (unpublished ⇒
guesswork) no longer holds for this one format. The parser refuses any row it
cannot read rather than coercing, and its warnings say charges are stated, not
computed. Kotak Neo and Sahi remain unpublished and remain with the generic
mapper; the detection matrix proves no parser claims their files.
**Invalidated if:** A populated Paytm export contradicts the inferred value
semantics — reconcile the first live import against a contract note before
trusting the charge figures.

## 2026-08-12 — Broker API research: recorded so it is not re-derived, NOT built

**Context:** Researched direct broker-API sync for the journal. Nothing here is
implemented; this entry exists so the findings and the risks survive.
**Measured / found (per-broker access instruments — CORRECTED 2026-08-12 in a
second pass against live vendor docs; three items in the first recording were
wrong and are struck through here so the correction itself is on the record):**
- **Upstox** — "Analytics Token": 1-year validity, READ-ONLY (cannot place
  orders). **BUT the Portfolio and Trade-P&L endpoints — exactly what a journal
  reads — require a whitelisted STATIC IP** (one primary + one secondary per
  user, set in the developer console). Home broadband is dynamic, so the one
  broker with a year-long token is the HARDEST to reach from a desktop app.
- **Dhan** — ~~validity configurable 8 hours–30 days; TTOP secret for 1-year
  read-only data~~ → access tokens are **24 hours** (renewable via
  `POST /v2/RenewToken`); the **12-month** validity belongs to the API
  key/secret pair, not the token; no long-lived read-only token exists in the
  public docs. TOTP is an auth step, not a token class. Trading APIs free;
  only market-data APIs are paid. Re-verify against the owner's own account
  before building — recollection and public docs disagreed once already.
- **Angel One** — SmartAPI is **free**; api_key + clientId + PIN + TOTP secret;
  fully automatable; session to midnight with a refreshToken; requires
  `X-PrivateKey` / `X-ClientLocalIP` / `X-ClientPublicIP` / `X-MACAddress`
  headers on every call.
- **Groww** — API key + secret + TOTP; daily expiry; automatable;
  **₹499+tax/month** — the only broker charging for basic access.
- **Zerodha** — ~~implicitly the costly one~~ → the **Personal tier is FREE**
  and covers orders/trades/holdings/portfolio; paid Connect (₹500/mo) adds only
  market data, which a journal does not need. request_token via browser
  redirect expires at midnight and automating that login is outside ToS.
Four of five can run unattended; Zerodha needs a human daily. The first
recording concluded Upstox's year-long token was "the correct instrument" —
right on security (a leaked token cannot trade), wrong on reachability: without
a static IP it cannot serve a home desktop user at all. **Build order that
follows from the corrected facts: Angel One first** (free, unattended, and its
Tax P&L export is already parsed, so API results reconcile against a
known-good file import), then Dhan, then Zerodha as assisted-sync, with
Upstox/Groww last (blocked on static IP / on paying).
**Two prerequisites recorded as blockers, not follow-ups:**
1. AGENTS.md declares this journal single-user and OFFLINE. API sync or
   mailbox polling changes that posture and must be a deliberate recorded
   decision, not drift.
2. Credentials currently live in the local DB in plain text. Defensible for
   one daily-expiry token; NOT defensible for a 30-day token, a TOTP secret (a
   permanent second factor), or mailbox credentials. Encryption at rest comes
   FIRST.
**Decision:** Record only. `lib/import/types.ts` already carries the
`ApiImportSource` seam (`kind: "api"`, `fetchTrades()`), so none of this
requires re-architecture when it is deliberately taken up.
**Invalidated if:** A broker changes its token model or pricing — re-verify
against the broker's own docs before building anything on this table.

## 2026-08-12 — Lenses is HYBRID-gated, and the gate is field omission, not CSS

**Context:** The new Lenses page sat on the free/Pro line: its grouping is
journal hygiene, its per-group win rate/profit factor/expectancy/avg R is the
intelligence layer the licence sells.
**Measured / found:** The client computed `computeKpis` itself, so any
client-side lock would have been decoration — the numbers were already in the
browser. Verified after the fix by fetching `/lenses` unlicensed: the words
`winRate`/`expectancy` appear ZERO times anywhere in the SSR+RSC payload, and
reappear the moment the key is restored.
**Decision:** Grouping, counts, net P&L, charges and the per-group DELETE stay
free (deleting a bad import is the recovery path from an import bug — gating it
turns a product defect into a hostage situation). The edge object is computed
server-side (`lib/domain/lens-edge.ts`) through an ALLOW-LIST split and shipped
as `edge: null` when unlicensed. Three visually distinct cell states: a number;
"—" = cannot be computed (invariant 6); a Pro chip = computed, not yours yet.
**Why not the obvious thing:** Wrapping the page in ProGate — that gates the
free half and breaks invariant 7. Or blurring client-side — that ships the
numbers and pretends not to. Field omission is the only version that survives
devtools.
**Invalidated if:** `Kpis` gains a field — it lands on NEITHER side until a
human adds it to one allow-list, and `tests/lens-gating.test.ts` pins the split.

## 2026-08-12 — Per-account capital: the write path now lands where the read looks

**Context:** "Compounded +₹X" while the number on screen never changed.
**Measured / found:** `getCapitalSummary` reads `account.equityCapital ??
settings`; both writers wrote ONLY the settings row, and `pnlRolledIn` was
global — compounding in account A marked account B's realised P&L rolled in.
Pinned by a failing-first temp-DB test.
**Decision:** Migration 0044 moves `pnl_rolled_in` onto accounts, back-filling
the legacy global value into the DEFAULT account (single-account installs —
the overwhelming case — are exactly right; multi-account history is genuinely
ambiguous and the default account is the least-wrong owner). Compounding
refuses the aggregate view outright: its `available` sums every account, and
compounding a cross-account figure into one account moves money between books
(invariant 9).
**Invalidated if:** capital ever becomes bucket-per-account-per-bucket rows —
re-derive the rolled-in ownership then.

## 2026-08-12 — Backups: introspected coverage, and licence/trial state stays on the machine

**Context:** Restore silently lost MTF margin uploads and NSE index membership;
a shared backup shared the buyer's licence key; restoring an old backup lowered
the clock ratchet.
**Measured / found:** `BACKUP_TABLES` listed 26 of 30 schema tables, and the
guard test asserted a COUNT of 26 — structurally unable to notice a missing
table. The settings dump carried `license_key`, `trial_started_at`,
`clock_high_water_mark` verbatim; `settings-baseline.ts` had already excluded
all three from "restore defaults", so the asymmetry was an oversight, not a
policy.
**Decision:** v3 envelope: all 30 tables; the guard test now enumerates the
schema (`is(v, SQLiteTable)`), so table 31 cannot ship unbacked-up. Dump
REDACTS the three machine columns; restore PRESERVES this machine's values
whatever the envelope carries; and a table ABSENT from an older envelope is
left untouched rather than wiped — absent means "the backup never claimed to
know", empty means "known empty".
**Invalidated if:** a table is deliberately excluded from backups — it goes on
the test's EXCLUDED list with a written reason, which is the point.

## 2026-08-12 — Integrity sweep (v2.99.77): the account boundary is enforced where the table is touched

**Context:** The defect register (this file, above) left eleven items after the
v2.99.75/76 releases. Nine were variations of one disease: code that touches an
account-scoped table without resolving the account through
`getSelectedAccountId`/`getWriteAccountId`.
**Measured / found:** Sessions accepted a client-supplied accountId verbatim
and could MOVE a session across accounts on update; IPO inserts used
`getSelectedAccountId() || 1` (every aggregate-view IPO landed in account 1)
and IPO DELETE was entirely unscoped; every leg mutation in
`lib/queries/staged.ts` took a raw trade id unchecked; archiving the selected
account stranded the user pointing at an account the switcher no longer
showed; and the guard test that should have caught all of this asserted only a
LIST OF TABLE NAMES — including "positions", a 28-column table nothing had
ever read or written.
**Decision:** One pattern everywhere: writes resolve the account at the point
of touch (`getWriteAccountId` for inserts, an explicit own-account check for
mutations by id), reads keep the `accountId > 0 ? filter : all` shape, and the
registry test now maps each account-scoped table to OWNER FILES and fails
unless each owner invokes a resolver. The dead `positions` table is dropped
(migration 0045). IPO exit charges now come from the charges engine +
`charge_config` via an injected charger; the hard-coded rates survive only as
the documented no-broker fallback.
**Why not the obvious thing:** Trusting route-level fixes alone. The registry
test proved the point immediately: it flagged `app/api/capital/route.ts` as an
owner that never resolves the account — correctly, because D1's fix had moved
that responsibility into `compoundRealised()`. A name-list test can never make
that distinction; an owner-map test just did, on its first run.
**Invalidated if:** A future table's boundary is legitimately owned by a file
that delegates resolution (like the capital route) — declare the DELEGATE as
owner, not the route.

## 2026-08-12 — Exercise STT stays a named constant; futures STT moves to charge_config

**Context:** D18 — `lib/analytics/settlement.ts` hard-coded `exerciseSttPct`
(0.125% on intrinsic at option exercise) and `futExitSttPct` (0.02% futures
sell), with only the delivery rate read from `charge_config`.
**Measured / found:** `futExitSttPct` is exactly `charge_config`'s `sttPct`
for the `future` segment — same statute, same shape. `exerciseSttPct` is NOT:
config's option-segment `sttPct` is the premium-sell rate; exercise STT
applies to intrinsic value under a different rule, and no column carries it.
**Decision:** Futures STT now reads from config (any broker's row — statutory
rates are broker-invariant). Exercise STT remains a named default in
`DEFAULT_SETTLEMENT_RATES`, deliberately: it feeds one advisory figure on the
physical-settlement panel, and adding a `charge_config` column for it would
put a rate in the editor that no charge computation ever uses.
**Invalidated if:** exercise STT starts feeding a booked charge rather than an
advisory — then it earns the column.

## 2026-08-12 — Secrets at rest (v2.99.80): envelope encryption, DPAPI-wrapped on Windows, no new dependency

**Context:** The broker-API roadmap ends with stored TOTP secrets — permanent
second factors. Prerequisite recorded earlier today: encryption at rest comes
BEFORE the first such credential field exists. Live plaintext already existed:
`settings.license_key` and `broker_connections.api_key`/`access_token` (the
shipped Kite/Dhan pulls).
**Measured / found:** The Tauri shell and the Node sidecar are separate
processes, so an OS-keychain design needs an IPC channel that does not exist;
`tauri-plugin` routes also do nothing for `npm run dev` and CI. Windows
PowerShell's `-Command` glues trailing argv into the command string instead of
populating `$args` — the first DPAPI implementation silently fell back to the
KDF wrap on every Windows box, caught by the suite's provider assertion; blobs
now travel in environment variables.
**Decision:** One AES-256-GCM data-encryption key per install, stored WRAPPED
in `vault.key` beside the DB — DPAPI (CurrentUser) on Windows via PowerShell,
scrypt over the machine identity elsewhere. Column values wear a `venc:`
envelope; reads accept both forms and a lazy sweep upgrades pre-vault
plaintext (SQL migrations cannot run crypto — a migration file claiming to
encrypt would lie). Unreadable vault = honest degradation: licence reads
unlicensed with "re-paste the key from your purchase email", broker pulls ask
to re-enter credentials; new-secret WRITES refuse loudly rather than storing
plaintext beside a broken vault. Backups now redact broker credentials the way
they already redact the licence key; secretless connection rows are dropped on
restore.
**Why not the obvious thing:** An npm keychain/DPAPI module — this repo's
lockfile is a minefield (see "Adding a dependency") and `node:crypto` +
PowerShell covers every runtime. And no claim of defending against same-user
malware: no user-mode design does, keychain included. The claim is exactly
"the database file alone carries nothing usable off this machine."
**Invalidated if:** The Tauri shell grows a secrets IPC — then DPAPI/KDF
becomes the fallback and the OS keychain the primary, changing only `wrapDek`.

## 2026-08-12 — Angel One sync (v2.99.90): the first unattended pull, and why it is safe to be

**Context:** The broker-API roadmap said Angel One first — free, TOTP-automatable,
and reconcilable against the Tax P&L importer already shipped. The prerequisite
(v2.99.80 encryption at rest) exists; the posture precedent (Broker Connect is
explicit opt-in, pulls are user-clicked, nothing runs in the background) was set
by the Kite/Dhan connections and is unchanged here.
**Measured / found:** SmartAPI's login contract (loginByPassword with clientcode
+ PIN + TOTP, jwt to midnight) is VERIFIED against published docs; the
trade-book ROW shape is INFERRED from doc examples — mapped defensively with
candidate field names and refuse-don't-coerce, flagged in the pull's own
warnings until a live pull is reconciled once. TOTP is RFC 6238 SHA-1/30s/6 —
implemented in ~40 lines of node:crypto and pinned to the RFC's own test
vectors, because `otplib` would mean touching the lockfile minefield for an
HMAC.
**Decision:** Three security properties, each enforced structurally, not by
convention: (1) all four credentials — API key, client code, PIN, TOTP secret —
live vault-encrypted, the extras as ONE venc: JSON blob in the new
`broker_connections.auth_json` (migration 0046), and a broken vault REFUSES the
save; (2) the module surface is READ-ONLY — login + trade book and nothing
else, with the export list pinned in tests so an order method is a CI failure;
(3) the classic paste error (the 6-digit CODE where the SECRET belongs) is
rejected at save time with an explanation, because it would otherwise surface
tomorrow as an inscrutable broker rejection.
**Why not the obvious thing:** Storing the day's jwt and refreshing it — a
session to midnight is worth nothing tomorrow, so each pull logs in fresh from
the TOTP secret instead; one fewer secret class to hold. And no background
scheduler: the trade book covers only the current day, but an unattended timer
contacting a broker is a posture change the user has not asked for — the pull
stays a button.
**Invalidated if:** A live pull shows field names outside the candidate set —
extend the row mapping and move the trade-book shape from INFERRED to VERIFIED
in this entry.

---

## 2026-08-12 — Remote revocation (v2.99.91): the list travels down, nothing travels up — and four "no kill switch" promises were retired

**Context:** The owner sells annual licences and wanted a way to withdraw one
from a buyer who keeps using it past what they paid for, after three warnings
and a grace period. Four places in this repo promised in writing that no such
mechanism would ever exist, on the grounds that it "would mean phoning home".
**Measured / found:** That premise was already false. `check_for_updates` in
`src-tauri/src/lib.rs` runs a `tauri-plugin-updater` check at every launch —
unconditional, not opt-in, not surfaced. So the network posture did not change
with this feature; only the honesty of the copy did. Three published claims
were checked and were wrong as shipped: `docs/sales/landing-page.html` ("the
only network activity is optional and explicit… Both can be left off"),
`README.md` ("except the two things you explicitly allow"), and
`docs/client/INSTALLATION_GUIDE.md`, whose internet-needs list omitted the
launch check entirely. Also found: `reqwest` with the rustls backend is already
in the dependency tree via the updater plugin, so the fetch adds a direct
handle to an existing crate rather than a new TLS stack (0.13 renamed the
feature to plain `rustls`; `rustls-tls` is the 0.12 spelling and fails
resolution).
**Decision:** An Ed25519-signed list, fetched by the Rust shell inside the
existing update check and written to app-data; the web app reads the cached
file and never makes the request itself. Five properties, each pinned by a
test: (1) **pull-only** — the request carries no key id, no machine id, no
account, nothing; the same public file is served to everyone, and which key it
names is decided before the download, not by it; (2) **warn, then lock** — an
entry's `effectiveFrom` opens a grace window (14 days by default) during which
every Pro screen shows a countdown banner and *nothing* is withheld, so nobody
discovers a withdrawal as a dead screen; (3) **anti-rollback** — the accepted
`issuedAt` ratchets in `settings.revocation_list_issued_at`, so restoring an
older list cannot undo a newer one, and a REJECTED list must not advance the
ratchet (else a forgery locks the machine out of the genuine list that
follows); (4) **reversible** — publishing a newer list without the id
un-revokes, without shipping a build; (5) **fails open** — no list, a corrupt
file, a captive-portal HTML page, or any signature failure all resolve to
"active". The build-time `REVOKED_KEY_IDS` list stays as the permanent half:
publish the signed list so a key stops soon, run `license-revoke.mjs` so it
never returns in a later build.
**Why not the obvious thing:** A malformed `effectiveFrom` fails CLOSED — the
one deliberate inversion. Treating an unparseable date as "grace forever" means
a typo in a published list silently grants a permanent reprieve, and the
publisher would never learn. The signature already makes a malformed date the
vendor's own mistake, and re-publishing fixes it in a launch. Also rejected:
adding an opt-out toggle for the update check to make the old copy true again.
The check is how a signed release and a revocation both reach a user; making it
optional would make the feature optional. The copy was corrected instead — all
four "no kill switch" promises rewritten, in `lib/license.ts`,
`scripts/license-revoke.mjs`, `docs/owner/LICENSE_OPERATIONS.md` and
`README.md`, and the three false network claims restated to say plainly that
one download-only check runs at launch and cannot be turned off.
**Where it is published, and why not the obvious place:** a permanent GitHub
release tagged `revocations` holding one asset — NOT `releases/latest/download/`
beside `latest.json`, which was the first design. `latest` re-points at every
new app release, so a list uploaded to v2.99.91 would 404 the moment v2.99.92
shipped without someone remembering to re-upload it: a revocation silently
un-revoking itself, with nothing on screen and no error anywhere. A tag that
never moves makes publishing one `--clobber` upload and makes app releases
incapable of disturbing it.
**Two limits stated rather than hidden** (they are in the module header, the
owner docs and the sales copy): a machine kept permanently offline never
receives the list, and nothing here survives someone patching the binary. This
raises the cost of copying; it is not DRM. A third, smaller one is in
`lib/revocation.ts`: deleting the cached file un-revokes until the next launch
re-downloads it — the ratchet defends against an OLDER list displacing a newer
one, not against someone with write access to their own disk.
**Invalidated if:** The updater launch check is ever made optional or removed —
the fetch rides on it and would need its own posture decision; or a future list
needs to name something other than a key id, which would change the canonical
bytes and invalidate every signature already published.

---

## 2026-08-12 — The revocation list's own release must be a PRERELEASE, or it steals `releases/latest` and kills auto-update

**Context:** v2.99.91 publishes the signed revocation list to a permanent
`revocations` release rather than to the app release, because `releases/latest`
re-points at every new version and would silently 404 the list. That reasoning
was right and is unchanged. What it missed is the hazard in the other
direction.
**Measured / found:** `gh release create revocations` (no flags) was run at
18:09 UTC. Querying `/repos/…/releases/latest` immediately after returned
`tag_name: "revocations"`, `assets: [revocations.json]`, **no latest.json** —
GitHub resolves "latest release" as the most recent non-draft, non-prerelease
release **by creation date across every tag**, not by semver and not only over
version-shaped tags. `plugins.updater.endpoints` in `tauri.conf.json` is
`https://…/releases/latest/download/latest.json`, so that URL began 404ing:
auto-update was dead for every installed copy, and **silently**, because the
updater is deliberately fail-open (`Err(e) => eprintln!` and return). Nothing on
any screen would ever have said so. `gh release edit revocations --prerelease`
restored it; the direct
`releases/download/revocations/revocations.json` URL returned HTTP 200 with
byte-identical content throughout — the prerelease flag does not touch it.
**Decision:** `--prerelease` is mandatory on that release and is now in the
publisher script's header and printed instructions, `LICENSE_OPERATIONS.md` §4,
and the `REVOCATIONS_URL` doc comment in `src-tauri/src/lib.rs`. The runbook
also carries the post-hoc check, because the failure is invisible without it:
`gh api repos/…/releases/latest --jq .tag_name` must print a `v…` version.
**Why not the obvious thing:** Repointing the updater at an explicit versioned
URL would remove the coupling, but every ALREADY-INSTALLED copy has
`releases/latest/…` baked into its binary — the fix would reach nobody who
needs it. The endpoint has to keep resolving.
**The general lesson, which is the reason this entry exists:** two fail-open
mechanisms were stacked without anyone asking what their silence adds up to.
The updater fails open so an offline user is not nagged; revocation fails open
so an offline user is not locked out. Both are right individually. Together
they mean a totally broken update path produces no error, no dialog, and no log
a user would ever see — it is indistinguishable from "no update available".
Any future fail-open path needs a deliberate way to be *observed* failing.
**Invalidated if:** GitHub changes how `/releases/latest` resolves, or the
updater endpoint stops using the `latest` alias.

<!-- First entry goes here. -->
