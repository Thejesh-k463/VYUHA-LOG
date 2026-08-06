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

- **Never silence `react-hooks/set-state-in-effect` — derive instead.** A synchronous
  `setState` inside a `useEffect` keyed on other state broke the Trades view filter outright under
  the React Compiler: the select stopped receiving changes, with no error anywhere. The fix was to
  delete the state-sync entirely and derive (`visibleSelected = selected ∩ visibleRows` at render
  time). If you find yourself resetting state in an effect, the state is probably derivable.
- **Settings/editor writes use route handlers + client `fetch` + `router.refresh()`, NOT server
  actions.** Server actions auto-refresh the current route, which remounts sibling client
  components and silently resets their state. This broke the charge-editor row selection and made
  the settings theme appear to revert.
- **Tailwind v4 theme overrides must live inside `@layer base`.** Unlayered custom-property
  overrides are dropped by Lightning CSS. The light theme and colorblind palette in
  `app/globals.css` are layered for this reason.
- **Every DB-reading page/layout is `force-dynamic`.**
- **Native/heavy modules are `serverExternalPackages`** in `next.config.ts`: `better-sqlite3`,
  `pdf-parse`.
- **Capital compounding** uses `settings.pnlRolledIn` to avoid double-counting realised P&L already
  added to capital.
- After any schema change: `npm run db:generate` then `npm run db:migrate`. Migrations 0027+ are
  hand-written (no drizzle-kit snapshots) — follow that pattern and add a `drizzle/meta/_journal.json`
  entry.


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


# Brand

The mark (व under an edge-to-edge shirorekha) is generated by `scripts/make-logo.mjs` from glyph
outlines committed in `scripts/glyph-*.{path,json}` — extracted once from Noto Sans Devanagari
(SIL OFL; deliberately NOT a system font, whose licences cover setting type, not owning a mark).
It emits the SVG masters, `src-tauri/icon-source.png`, AND `components/brand/mark.tsx` — never
edit that component by hand, and never render व as a text node anywhere user-visible: on a machine
without a Devanagari font it's a tofu box (the share card once *exported* that box into PNGs).
`npm run desktop:icons` regenerates everything; the old placeholder generator `make-icon.mjs` is
deleted — do not resurrect it.


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
  `TAURI_SIGNING_PRIVATE_KEY` by hand to route around it.** The repo previously carried a stale
  `updater-private.key` at its root from a key rotation at v2.91.0 (old id `8FFAF1B491EAD2F0`);
  signing with it produces a `.sig` the build reports as valid while every installed copy rejects
  the update. The CI secret `TAURI_SIGNING_PRIVATE_KEY` must hold the `.secrets` key for the same
  reason. Verify a release by decoding the signature's key id, not by trusting "✓ signed".
- Version bumps: `npm run bump-version x.y.z` syncs package.json, tauri.conf.json, Cargo.toml and
  the sidebar footer — but **not `src-tauri/Cargo.lock`**, which needs a `cargo` invocation.
