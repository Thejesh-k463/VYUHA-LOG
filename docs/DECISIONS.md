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

<!-- First entry goes here. -->
