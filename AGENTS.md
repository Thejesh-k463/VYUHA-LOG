<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->


# Verify with `npm run verify`, not just tests

`npm run typecheck && lint && test` all pass on code that **cannot be bundled**. Client components
import `lib/license.ts`, so anything in its import graph must stay browser-safe — a `node:child_process`
import there fails only at `next build`, which is what `npm run verify` adds. CI runs the build too, so
this is about catching it before the push, not instead of CI.


# Invariants — breaking these reintroduces bugs that were expensive to find

1. **Money is integer paise in the DB, rupees at runtime.** The `moneyPaise` custom type converts
   at the column boundary, so call sites work in rupees. Converting *again* in application code is
   a 100× bug — it has happened once and was caught only by checking against real data, not by
   unit tests. Per-unit PRICES (average prices, SL/TSL/target, strike, FMV) deliberately stay REAL:
   they are levels, and rounding them would corrupt qty × price recomputation.
2. **Pure modules stay pure.** `lib/{engine,analytics,risk,domain}` import no DB and no React, so
   they can be exhaustively unit-tested. DB access lives behind `lib/queries/*` (server-only).
   Write the maths there first, unit-test it, then wrap it for the UI.
   **The one deliberate exception is `lib/engine/rates-db.ts`** — it is `server-only` and reads
   `charge_config` so the engine can be fed real rates (invariant 3). It is named `-db.ts` for
   exactly that reason; the pure half is `lib/engine/rates.ts`. Do not add a second exception
   without renaming it the same way.
3. **The charges engine reads rates ONLY from `charge_config`** (broker × segment × exchange).
   Never hard-code a statutory rate in logic. STT/CTT and stamp duty round to the rupee.
4. **Staged positions: weighted-average pricing, FIFO quantity consumption, R frozen at the first
   entry.** All three are independent and deliberate — see the header of `lib/domain/staged.ts`.
   Remaining tranche prices will *not* sum to the remaining cost basis; that is asserted in tests
   so nobody "fixes" it later.
5. **The parent `trades` row always holds the aggregate.** Legs are additive detail; every report,
   tracker and tax pack reads the flat row and needs no knowledge that legs exist.
6. **Never fabricate a denominator.** Share cards return "—" rather than invent a capital base;
   mistake economics report the expectancy *gap*, not counterfactual P&L; the ITR schedule export
   emits blank rather than 0 for anything it cannot derive.
7. **The core journal is never gated.** `PRO_FEATURES` covers analytics only — a user's own record
   of their trades is not held hostage.
8. **Every account-scoped read goes through `getSelectedAccountId()`**, applying
   `accountId > 0 ? filter : all`. A query that forgets it merges two books into one tax pack or
   expectancy figure, and *nothing on screen looks broken*. `tests/account-isolation.test.ts` reads
   the `account_id` columns out of SQLite and fails on any table that gains one without a scoped read.
9. **0 is a view, not a place.** The aggregate "All accounts" selection can never receive a write.
   `getWriteAccountId()` resolves it and validates any explicit id against the accounts table.
10. **Restore leaves the journal intact on any failure.** Attachments are staged before the DB
    transaction, the table swap is one transaction, and the directory is swapped only after it
    commits. Attachments are replaced *only* when the backup carries some: an orphaned file is
    invisible and reclaimable, a deleted screenshot is gone.


# Conventions

- **Check `docs/DECISIONS.md` before changing a constant that looks arbitrary,
  or before re-measuring something.** It records what was measured, and why the
  obvious alternative loses. Append to it when you measure something or
  deliberately deviate from a spec or default.

- **Never silence `react-hooks/set-state-in-effect` — derive instead.** A synchronous
  `setState` inside a `useEffect` keyed on other state broke the Trades view filter outright under
  the React Compiler: the select stopped receiving changes, with no error anywhere. The fix was to
  delete the state-sync entirely and derive (`visibleSelected = selected ∩ visibleRows` at render
  time). If you find yourself resetting state in an effect, the state is probably derivable.
- **localStorage goes through `components/layout/use-stored-value.ts`** — `useStoredValue(key)` to
  read (hydration-safe: the server snapshot is null, so defaults render and the stored value lands
  after hydration), `writeStored(key, value)` to write (it notifies same-document readers; the DOM
  `storage` event fires only in OTHER documents). Keys are `vyuha-…` kebab-case, parameterised with
  a `:suffix` (`vyuha-import-mapping:${broker}`), and stored JSON wears a versioned envelope
  `{v:1, …}` so a future shape is discarded rather than mis-read. The older
  `Promise.resolve().then(setState)` mount-restore (sidebar, column-mapper) remains acceptable for
  one-shot restores.
- **Charts that reach paper stay recharts.** The `@media print` palette re-themes SVG through CSS
  custom properties; canvas (lightweight-charts) rasterises its draw-time colours and prints a dark
  chart on a white page. lightweight-charts is for screen-only surfaces (the trade replay), and it
  renders an INVISIBLE series — no throw, no warning — if handed a colour it cannot parse
  (`color-mix()`, `oklch()`, unresolved `var()`); chart tokens must be literal colours
  (`tests/skin.test.ts` asserts this).
- **Settings/editor writes use route handlers + client `fetch` + `router.refresh()`, NOT server
  actions.** Server actions auto-refresh the current route, which remounts sibling client
  components and silently resets their state. This broke the charge-editor row selection and made
  the settings theme appear to revert.
- **Tailwind v4 theme overrides must live inside `@layer base`.** Unlayered custom-property
  overrides are dropped by Lightning CSS. The light theme and colorblind palette in
  `app/globals.css` are layered for this reason.
- **`lib/import/registry-meta.ts` is the ONLY source of truth for what can be imported**, and
  `lib/import/detect.ts` re-exports it (`IMPORT_SOURCES`, `dropzoneHint`) — so import from
  whichever reads better, but change only the registry. The dropzone
  hint is generated from the registry (`dropzoneHint()`), never hand-written — two literal strings
  had drifted until the screen advertised three brokers while the code read five, and a user
  reasonably reported the feature as broken. `tests/import-registry.test.ts` fails if the copy stops
  deriving from the registry.
- **A broker-named parser must see the broker's NAME before it claims a file.** Tradebook *shape*
  (a symbol column, a side column, buy/sell values) is common to every Indian broker, so scoring on
  shape alone makes a parser claim other brokers' files: `detectFor` in `angelone-upstox.ts` used to
  return 0.2 for any CSV with a "Scrip" column, and `detectZerodha` scored the word "tradebook" in a
  filename plus `symbol`+`isin` shape — which imported a Groww order history as Zerodha, priced at
  Zerodha's rates (2026-08-12). Require the filename or an in-content fingerprint; the verified
  fingerprint per format lives in `docs/BROKER_FORMATS.md`, and
  `tests/import-detection-matrix.test.ts` pins the full cross-broker refusal matrix against
  redacted copies of real exports. A file that names no broker belongs to the generic column
  mapper, where the user says whose it is — a question is always better than a confident wrong
  answer.
- **Never invent a parser for a format nobody has published — a VERIFIED REAL EXPORT is what
  "published" means.** Kotak Neo and Sahi still document their export columns nowhere, so their
  files belong to `lib/import/generic-map.ts`, which asks; it refuses a row it cannot read rather
  than coercing a bad cell to 0, because a trade for zero shares at zero rupees is worse than no
  trade. Paytm Money moved OFF this list on 2026-08-12 when a real export pinned its layout —
  a deliberate exception recorded in docs/DECISIONS.md, with the caveat that its sample was
  schema-only: the first live import should be reconciled against a contract note.
- **Every DB-reading page/layout is `force-dynamic`.**
- **Native/heavy modules are `serverExternalPackages`** in `next.config.ts`: `better-sqlite3`,
  `pdf-parse`.
- **Capital compounding** uses `settings.pnlRolledIn` to avoid double-counting realised P&L already
  added to capital.
- After any schema change: `npm run db:generate` then `npm run db:migrate`. Migrations 0027+ are
  hand-written (no drizzle-kit snapshots) — follow that pattern and add a `drizzle/meta/_journal.json`
  entry.


# Adding a dependency

**Never let npm rewrite `package-lock.json` — not even plain `npm install`.** On this dependency
graph a plain `npm install <pkg>` (fully installed tree, no flags) deterministically prunes
vitest's nested `esbuild@0.28.x` and its 26 `@esbuild/*` platform entries from the lock. That is
not a benign dedupe: vitest's `vite` requires `esbuild ^0.27||^0.28`, so the prune leaves it
resolving to the top-level 0.25.x — `npm ls esbuild` reports ELSPROBLEMS and `npm ci` fails on
EVERY platform, Windows included. Procedure that works (used for lightweight-charts):

1. Let npm generate a lock once (to get the registry `integrity` hashes), save it aside.
2. `git checkout package-lock.json`, then splice ONLY the new package's `packages` entries plus the
   root `dependencies` line onto HEAD's lock — **preserving existing key order** (npm collates `_`
   differently from `Array.sort`; a global re-sort silently rewrites unrelated entries).
3. Prove it: `npm ci` clean, `npm ls esbuild` resolves, and
   `git diff --numstat package-lock.json` shows additions only.

Full narrative: docs/DECISIONS.md 2026-08-10.


# Testing

Almost every test runs against pure modules with no database — that is why the suite finishes in
seconds. Two things cannot be tested that way, because the behaviour under test *is* the I/O:

- **`tests/helpers/temp-db.ts`** opens a throwaway migrated SQLite file for those cases. It sets
  `VYUHA_DB_PATH` before the first dynamic `import("@/lib/db")`; a static import anywhere in the
  module graph binds the connection first, and the helper throws rather than let a test assert
  against the wrong database.
- **One temp database per FILE.** Vitest gives one module registry per file and `lib/db` caches its
  connection on `globalThis`, so a second `openTempDb()` in the same file reuses the first. If a
  test needs a second database, it needs a second file.

**e2e:** the Playwright suite shares one database across the run and imports are de-duplicated, so
specs must not assume they run first (see `e2e/helpers.ts`). Two rules learned the hard way:

- **Wait for a panel's own fetch before deciding anything.** `StagedPanel` mounts in a loading
  state, so `if (await enable.count())` evaluated too early returns 0, silently skips the click,
  and the failure then surfaces somewhere else entirely. This reddened CI for six releases.
- **Never compare a page count against a whole-database figure.** The trades table is
  account-scoped and view-filtered; a backup dump is every row in every account.
- **A spec that seeds via `ensureTrades` must sort AFTER `import-dashboard.spec.ts`.** Specs run
  alphabetically, and whichever runs first is the one that gets to see "Imported 122 trades" — a
  seeding spec that sorts earlier steals that moment and fails it on a side effect. A `z-` prefix
  is the blunt way to guarantee it, but six existing specs seed without one and are fine purely
  because their names already sort later (`import-split-cockpit`, `nse-map`, `rom-and-drilldown`,
  `staged-position`, `trade-views`, `v297-surfaces`). If you add a spec whose name sorts before
  `import-dashboard`, prefix it.
- **Assert client-restored state with `expect.poll`, never once after `networkidle`.** Saved column
  orders, calculator snapshots and the like are applied by client code after hydration, and
  `networkidle` says nothing about hydration — a single assert reads the default and looks exactly
  like broken persistence (it cost a wrong diagnosis and a revert; DECISIONS.md 2026-08-10).


# Brand

The mark (व under an edge-to-edge shirorekha) is generated by `scripts/make-logo.mjs` from glyph
outlines committed in `scripts/glyph-*.{path,json}` — extracted once from Noto Sans Devanagari
(SIL OFL; deliberately NOT a system font, whose licences cover setting type, not owning a mark).
It emits the SVG masters, `src-tauri/icon-source.png`, AND `components/brand/mark.tsx` — never
edit that component by hand, and never render व as a text node anywhere user-visible: on a machine
without a Devanagari font it's a tofu box (the share card once *exported* that box into PNGs).
`npm run desktop:icons` regenerates everything; the old placeholder generator `make-icon.mjs` is
deleted — do not resurrect it.


# Bundled NSE index map

`lib/data/nse-index-map.json` is a SNAPSHOT of NSE's index constituent lists (symbol → official
industry, ISIN, name, thematic memberships), generated by
`node scripts/build-nse-index-map.mjs --src <folder of ind_*_list.csv>` — never hand-edited. Its
`asOf` date is shown in the UI; refresh by re-downloading the lists from niftyindices.com and
re-running the script. Two rules the merge code enforces and tests assert: sector writes are
COALESCE (a user's own tag is never overwritten), and theme analytics label themselves as
overlapping lenses (one stock sits in up to ten indices — theme P&L must not be presented as a
partition of the book).


# Bundled MTF margins

`lib/data/mtf-margins.json` is a SNAPSHOT of all seven brokers' MTF approved-scrip lists (symbol →
own-margin %, funded flag, ISIN), built from the owner's refresh toolkit output. To refresh:
run `scripts/mtf-toolkit/refresh_mtf.bat` (owner's machine; pulls each broker's own feed, needs
two local inputs for Angel One and Groww — see its README), then
`python scripts/convert-mtf-workbook.py <workbook>` and `node scripts/build-mtf-margins.mjs`.
Rules the code enforces and tests assert: marginPct is always the TRADER'S OWN contribution %;
approved-but-unfunded rows carry 100% (full cash in practice), never an invented funding number;
the resolution chain is upload → bundled list → rule → margin-config → 25% default; Sahi is
declared "no-mtf", not omitted.


# Desktop build and release

- **Desktop** = Next `output: "standalone"` run as a Node sidecar by the Tauri Rust shell. The DB
  lives in OS app-data (`%APPDATA%/in.vyuha.tradejournal`). `scripts/desktop-server.mjs` seeds from
  a bundled template on first run and runs Drizzle migrations on every startup.
- **Build:** `npm run desktop:build` (needs Rust + MSVC; in Git Bash,
  `export PATH="$(cygpath "$USERPROFILE")/.cargo/bin:$PATH"`). It always rebuilds the web bundle —
  do not shortcut it. After a build, confirm `desktop-dist/.next/BUILD_ID` is fresh and grep the
  bundle for a marker of the newest feature; v1.12–v1.20 shipped installers frozen at v1.11.
- **The updater signing key is `.secrets/vyuha-updater.key`, and nothing else.** Its public half
  must equal `plugins.updater.pubkey` in `tauri.conf.json` (currently key id `4FF85F3BBE1DA21D`).
  `scripts/tauri-build.mjs` resolves it automatically — **do not set
  `TAURI_SIGNING_PRIVATE_KEY` by hand to route around it.** ⚠ A stale `updater-private.key` from
  the v2.91.0 key rotation (old id `8FFAF1B491EAD2F0`) is **still sitting in the repo root** —
  untracked and gitignored, so it never reached GitHub, but present on disk and one careless
  `--private-key` away from being used;
  signing with it produces a `.sig` the build reports as valid while every installed copy rejects
  the update. The CI secret `TAURI_SIGNING_PRIVATE_KEY` must hold the `.secrets` key for the same
  reason. Verify a release by decoding the signature's key id, not by trusting "✓ signed".
- Version bumps: `npm run bump-version x.y.z` syncs package.json, tauri.conf.json, Cargo.toml and
  the sidebar footer — but **not `src-tauri/Cargo.lock`**, which needs a `cargo` invocation, and
  **not package-lock.json's root version fields**. To sync those, edit the two version strings BY
  HAND — never by running npm. `--package-lock-only` drops the darwin/linux optional-dep variants
  (broke all four CI jobs at v2.99.5), and a plain `npm install` corrupts the lock differently but
  just as fatally — see **Adding a dependency** above. A stale root version in the lock is
  harmless; a re-resolved lock is not.
