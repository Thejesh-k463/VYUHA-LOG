# Changelog

## Unreleased (on `main` after v2.99.100)

Owner tooling and test infrastructure — nothing in the shipped app changed.

- **The sale flow is one command.** `npm run sell -- <email> --years 1|--lifetime --utr <UTR>
  --name "<Name>"` runs mint → verify → receipt → encrypted key backup → send-message, with the
  traps from the two real sales automated (duplicate-email guard BEFORE the irreversible mint,
  same-day backup renamed not clobbered, archive folder created before redirect). `npm run
  renewals` prints the annual-renewal outreach list and exits 2 on a lapsed key so a scheduled
  run can alert. 11 tests on a throwaway ed25519 keypair; the real key is never opened.
- **Simulation harness** (`tests/sim/`, 24 cases): a deterministic 10,028-fill book rendered as
  five real broker formats through the real detection route — every parser conserves quantity
  exactly and value to the paisa, and all formats agree on the same 4,504 positions.
- **Demo-video kit** (`docs/owner/demo-video/`): narration, shot list pinned to the sidebar's
  `nav-config.ts` by test, importable OBS profile, setup script, end card, publish copy —
  narration and publish copy scanned by `tests/demo-video-copy.test.ts` for outcome claims.
- **Full off-device backup**: `npm run backup:drive -- <letter>` — verified git bundle, secrets,
  key archive, `.vkb` bundles, private fixtures, client ZIPs and the live journal in one
  command; refuses same-disk targets (C:/K:/T: are one physical NVMe) and refuses to run while
  Vyuha is open.
- **Fixed:** the sell-flow suite was date-frozen to the day it was written and `sell.mjs`
  predicted the backup bundle's name from `--today` while the backup script used the real
  clock — both now derive from the artefacts actually produced (DECISIONS 2026-08-24).
  `tests/readme-claims.test.ts`'s file-count guard made recursive (it was blind to `tests/sim/`).
  Orphan `scripts/demo-ind7.mjs` deleted — it wrote into the live journal; `npm run demo`
  supersedes it.

## v2.99.100 — imports stay proportional as a book grows

One fix, and a real one: **the pairing engine was quadratic on a single symbol**,
so the longer you had traded one instrument, the slower importing it became.
Numbered as a patch deliberately — the output is byte-identical and nothing
about compatibility changed, so calling it 3.0.0 would have signalled a breaking
change that does not exist. The 3.0.0 milestone stays reserved for the public
launch.

- **The defect.** `lib/import/pair-legs.ts` walks a FIFO lot queue per symbol.
  The cost of a *sell* was proportional to the number of OPEN LOTS rather than to
  the number of legs, because each sell ran **three separate O(lots) scans**: a
  full-queue pass looking for same-day lots, `lots.some(...)` **and**
  `lots.find(...)` re-scanning from the head on every iteration of the
  oldest-first loop, and a reverse `splice` to drop exhausted lots. When buys
  outnumber sells the queue grows without bound and the walk becomes O(n²).
- **How it was found.** A new load case, `tests/load/c8-pairing-depth.load.ts`.
  It exists because an import-graph scan of the thirteen existing load cases
  found that **none of them imported the pairing engine** — it had been rewritten
  in v2.99.98, five days after the load suite was written, and "13 of 13 green"
  had been reading as coverage it never had.
- **The numbers.** One symbol, 65% buys: 8,000 legs → 79 ms, 32,000 → 1,249 ms —
  a **15.89× cost for 4× the work**, where linear is 4 and quadratic is 16.
  Opening-sell-heavy books: 13.32×. Multi-symbol books, which is what most people
  have, were **never affected** — 4.19×, with per-item cost flat at 1.10 → 1.14 µs,
  because the work partitions per symbol.
- **The fix.** A forward-only `head` pointer replaces the `splice` compaction
  (lots are only ever emptied, never refilled, so it never looks back), and a
  per-date index replaces the same-day full-queue scan. **Selection is
  unchanged** — the head walk returns exactly the lot `find` returned. Ratios are
  now **3.70×** and **4.10×**, and 50,000 legs on one symbol went **775 ms → 63 ms**.
- **Proven identical, not merely tested.** Same 28,269 positions, same
  22,559 closed / 5,710 open / 0 opening-sell split, quantity conserved exactly,
  value drift unchanged at ₹3.29 on ₹1.5 billion — 2.19 parts per billion, which is
  IEEE-754 noise and not a leak. 1,920 unit tests across 131 files pass, and so do
  both real-file reconciliations: Paytm's 414 executions against Paytm's own
  Realized P&L Detail, and the 1,554-fill Zerodha Console tradebook.
- **Also carried in from the v2.99.99 line:** `winget:manifest` now requires
  `--sha` and refuses to hash the local build — it would otherwise emit a manifest
  whose hash could not match its own URL — and a documentation sweep that corrected
  two claims that were untrue, including a "signed Windows installer" line in an
  application drafted for an outside party.

## v2.99.99 — Angel One's live pull works again; it had been broken since v2.99.80

**Angel One's live API pull was broken in every shipped build from v2.99.80 to
v2.99.98, including the published v2.99.98.** No entry in this changelog said so
until this one. Pressing **Pull** on an Angel One connection returned "The saved
credentials cannot be read: … Re-enter the API key and access token" and never
reached the network. Zerodha and Dhan pulls were unaffected, as was every file
import and every report.

- **The cause.** The vault stores each secret encrypted. Angel One is the only
  broker that collects no access token — it mints the day's login code from your
  TOTP secret — so the app stored an *encrypted empty string*. AES-GCM over an
  empty plaintext yields a zero-length ciphertext, producing `venc:1:<iv>::<tag>`,
  which `parseVaultString` correctly refuses as malformed. The pull's guard
  required a readable token **before** dispatching to any broker, so it refused
  on a token this broker never asks for.
- **The fix.** The guard now requires a token only where `API_BROKERS` says one is
  collected (`!keyRead.ok || (needsToken && !tokenRead.ok)`), and the Kite/Dhan
  branches take an empty string when there is no token to read. **The vault format
  is deliberately unchanged** — refusing to read an empty ciphertext is right; the
  caller was wrong to demand a secret it never collected. `tests/vault.test.ts`
  now pins the property, so the next caller meets this trap in a test.
- **Nothing to re-enter.** Saved Angel One credentials were never wrong and were
  never lost. Install this build and press Pull.
- **In-app text that had drifted is now true.** The Help Desk said "Eight brokers,
  auto-detected" (six have parsers) and that MTF is never read from a file — Angel
  One's tax P&L carries an explicit MTF Qty column and Vyuha believes it rather
  than asking. The Dashboard's empty state said five brokers. The import column
  mapper still promised plain FIFO after the pairing engine moved to
  same-day-netting-first.
- **The guards that let those rot are closed.** `tests/readme-claims.test.ts`
  compared its six figures only to each other, so 1,858/128 stayed green against a
  suite at 1,920/131; it now reads the `tests/` and `screenshots/` counts off disk.
  `docs/owner/DOC_AUDIT.md` gains a row that forces a check that every advertised
  broker-API pull actually works **in the build being shipped** — nothing in CI
  asserts that a broker API works, which is how this survived from v2.99.80 to
  v2.99.98.

## v2.99.98 — tradebooks become the trades you made, checked against the broker's own statement

The first live Paytm Money and Zerodha tradebooks exposed that both parsers
aggregated a whole file per symbol and booked `sell − buy` as P&L — ₹2.17 Cr
and ₹31 L of fabricated gain respectively on sells of shares bought before the
window. Both now pair fills per scrip-day through the shared FIFO engine, which
itself learned two things from Paytm's lot statement.

- **Pairing engine (`lib/import/pair-legs.ts`).** A sell consumes the same day's
  buy first (exchange intraday netting), then lots oldest-first; the quantity a
  file never shows being bought is measured in a first pass and seeded as the
  oldest lot in a second, so opening sells land on the earliest delivery sells
  — where the broker puts them. Dhan GTR, Groww orders and the column mapper
  inherit it; every existing pairing test still passes.
- **Zerodha tradebook.** Console export preamble, numeric date serials,
  `Order Execution Time` for fill times, per scrip-day legs (1,554 fills → 28
  positions on the real file, 11 opening sells with blank P&L), derived product
  when the export has no Product column, in-content fingerprint weights raised
  so a neutral filename still routes (0.75 / 0.70). Console P&L skips all-zero
  ISIN-in-Symbol rows.
- **Paytm Money tradebook.** Product from the scrip-day STT/stamp signature
  (`Product Type` is `EQ` = segment); the six stated charge components
  apportioned per position (conserved to ₹0.16 over 142 positions); numeric
  scrip codes resolved to tickers by ISIN at commit (instruments table →
  bundled NSE index map → keep the code with a note); `sourceRows` so the
  summary reads "414 fills → 142 positions". Reconciled against Paytm's
  Realized P&L Detail: 47 of 52 in-window scrips within ₹25, closed net within
  1.4% of the broker; the residual is 3,200 shares of opening inventory the
  tradebook cannot see (DECISIONS.md 2026-08-20).
- **Upstox.** Fingerprint on `UPSTOX SECURITIES PRIVATE LIMITED` in A1; trade
  report header on row 11, realised P&L on row 22; `Trade Time`, `Buy/Sell
  Date`, `Buy/Sell Amt`, `Total PL`, `Speculation`→intraday mapped. Layouts
  VERIFIED, values INFERRED (the real exports carried no rows). Ledger has no
  header and is not claimed.
- **Fixtures + tests.** Seven schema-only redacted fixtures in the cross-broker
  matrix (loaded under neutral filenames), a private block that replays the
  real files where present, `tests/private-reconciliation.test.ts`, and
  `docs/BROKER_FORMATS.md` updated with every verified quirk.

## v2.99.97 — skins you can feel, a theme you can build, and a buy button that answers

Appearance grows from "pick a skin" into a set of dials, the buy buttons stop
being dead in the desktop shell, and the installer stops tripping over the
app's own server.

- **Tint intensity.** A 0–100 slider (default 50; presets Subtle 25 / Balanced
  50 / Vivid 75; −/+ step 10) tints canvas, sidebar surface, card, card-top,
  card-hover, border, rule and header band toward the skin hue. The engine is
  the pure module `lib/domain/appearance.ts`; `app/layout.tsx` injects the
  resulting literal tokens inline on `<html>` so there is no first-paint flash
  and no class-specificity fight, and charts re-theme through an
  `appearance-tick` class toggle because lightweight-charts observes classes,
  not inline properties. The spec curves for card-top / card-hover / surface
  (0.20 / 0.22 / 0.14) were cut to 0.13 / 0.11 / 0.11 after Lime and Luxe
  measured 8.5:1 and 11.9:1 at intensity 100; every skin now holds dark
  canvas/card/surface ≥12:1, card-top/hover ≥9:1, and light ≥7:1 body-text
  contrast at 100.
- **Panel style.** Flat / Soft / Luxe (default) / Glow as `html.panel-*`
  classes, overrides in `@layer utilities` at (0,2,1) specificity. Terminal +
  Glow degrades to a flat shadow by design.
- **Custom theme.** A ninth skin, `custom`: seven fields × dark/light (accent,
  analytics, money, sidebar, cards, borders, canvas), derived shades computed in
  code, a per-row WCAG badge that warns and never blocks, "Start from <skin>"
  seeding from the computed tokens; saved only with the form and only while
  Custom is selected. Stored `ice` / `royal` still map to `sapphire`.
- **Wallpaper.** PNG/JPEG/WebP ≤12 MB, magic-byte sniffed, stored in
  `<data>/wallpaper/` outside backups (the Backup screen says so), drawn as a
  fixed cover behind `<main>` under a theme-aware scrim
  `rgb(ch / var(--wallpaper-scrim))` (not `color-mix()`), with an opacity slider;
  removed in print. Migration 0048 adds `tint_intensity`, `panel_style`,
  `custom_theme`, `wallpaper_stored_name`, `wallpaper_opacity`.
- **Buy CTAs that work in the shell.** The desktop webview blocks external
  `target=_blank` and the shell carries no opener plugin on purpose (zero runtime
  Tauri deps). Every "Get …" now opens a dialog: +91 73936 73714, the pre-filled
  message, Copy number / Copy message, an Open WhatsApp link for browsers, and
  the offline note. Settings → License pills open the plan card in a popup, no
  comparison table.
- **Installer: no more "Error opening file for writing … node.exe".** The Node
  sidecar was killed only on `WindowEvent::Destroyed`, so an in-app update, a
  crash or a Task-Manager kill orphaned it and it held the lock; Tauri's NSIS
  template stops `vyuha.exe` only. Now `stop_sidecar()` (kill + wait) runs on
  Destroyed, `RunEvent::ExitRequested` / `Exit`, and before
  `update.download_and_install`; NSIS PREINSTALL / PREUNINSTALL hooks stop
  `node.exe` / `vyuha.exe` whose `ExecutablePath` is under `$INSTDIR` only
  (`Get-CimInstance` filter — never `taskkill /IM node.exe`), with `$INSTDIR`
  passed via an environment variable to avoid quoting. Ignoring the old error
  was harmless (same Node 22.17.0 bytes); it just looked alarming.

## v2.99.96 — the table says what you paid, eight skins that differ, and the terminal that goes away

A batch of things the owner asked for after using the app: columns that answer
the question a trader actually has, skins that are distinct instead of
permutations, and a desktop shell that stops leaking a console window. Under it,
seven load tests found five real defects and fixed them.

- **Trades table: Qty, Invested, Entry price, Exit price.** The Buy/Sell rupee
  values are gone; in their place the quantity, what you put in, and the two
  prices. Every import path — six broker parsers, the column mapper and the three
  API pulls — already produced weighted-average prices, so the columns are
  universal. An open trade shows "—" for its exit, never ₹0. On MTF rows Invested
  is *your* contribution with the broker-funded amount alongside; when the
  funding is not yet resolved it says so rather than inventing a percentage.
- **Options Seller Journal opens up.** The four seller KPIs and the outcome mix
  now open the same breakdown dialog the Dashboard uses — per-underlying counts,
  realised vs open, best and worst contract, capture arithmetic in one sentence —
  each row a deep link into the trades it counts. An outcome-mix bar and section
  headers give the screen a shape.
- **Eight skins that are actually different.** Ice shared Sapphire's analytics
  colour and Royal's primary was Luxe's analytics colour; both are retired (a
  saved choice becomes Sapphire) and Lime, Rose and Ember join. Coloured skins now
  tint card, border and background subtly instead of only the accents, and a
  test asserts no two skins share a primary hex. Light-theme primaries measure
  5.16–5.58:1.
- **No more background terminal.** The desktop app spawned its Node server with
  inherited stdio from a GUI-subsystem shell, so Windows allocated it a console.
  It now runs hidden and logs to `%APPDATA%\in.vyuha.tradejournal\logs\sidecar.log`.
- **Load tests, second batch (B1, B2, B5, B6, B7, C2, C7).** Lens grouping on a
  40k book was going quadratic (14.3× per 4× — now 5.2×); the licence check wrote
  a mark to SQLite on essentially every Pro screen (200 writes per 200 reads — now
  0 unless a day has passed); the backup page materialised 125,195 rows to count
  29 tables (now 29 rows, 421 ms → 1 ms); an encrypted restore derived its scrypt
  key twice (now once); import detection decoded a workbook 15 times (now 8, with
  ≤2 pinned as a follow-up); a generic import left `sourceRows` unset. Two
  predictions were wrong — the skipped-row warning already existed, and 250k
  trades of float P&L do not drift — and both are recorded as such.
- **Licensing operations.** `license-upgrade.mjs` implements the promised
  annual→lifetime upgrade as full credit within the year (dry-run first,
  `--confirm` needs a UTR, the old key is revoked); `license-issue.mjs --save-dir`
  archives every key and a ledger snapshot; `license-backup.mjs` bundles the
  private key and ledger into an AES-256-GCM file. Legacy SKU labels no longer
  advertise indicators; the landing page's indicator FAQ is gone.
- **Paperwork that says the right version.** TERMS and PRIVACY apply-to lines are
  guarded by a test against `package.json`; a second test keeps indicator copy off
  buyer surfaces. New owner guides: refund/terms sign-off, winget + SmartScreen
  submission, and a per-release doc audit list.

## v2.99.95 — launch pricing that survives division, and a comparison that hides nothing

The price became the pitch. Everything in this release is commercial surface,
and every number on it is derived, sourced, or floored — never asserted.

- **Launch pricing, with honest anchors.** The list prices are ₹13,000/yr
  (Pro — Annual) and ₹35,999 (Journal — Lifetime) — committed prices, effective
  2027-01-01, not decorative strike-throughs. Until then the launch offer sells
  at ₹9,999/yr and ₹29,999. The savings badges are computed from the numbers
  and floored: **23% off** and **16% off**. The owner asked for "30%/20%";
  those labels did not survive division and were corrected. Lifetime's true
  16.67% is shown as 16, never rounded up to 17 — a discount claim on this
  product does not overstate.
- **Lifetime is now the featured plan.** "Best value" moved from Annual to
  Lifetime, in-app and on every sales surface, and Lifetime lists the roadmap:
  every future upgrade at no extra cost.
- **How Vyuha compares.** The pricing page and landing page now carry a
  seven-product comparison — pricing, where your data lives, Indian broker
  support, statutory charges — every cell read from public pages on 2026-08-15,
  "not stated" wherever a claim could not be verified, and a † wherever the
  official page was unreachable and third-party 2026 reviews had to stand in.
  The ₹999–₹2,499 Indian competitors are in the table; hiding them would be the
  selective honesty this product positions against.
- **The current mark, everywhere.** The landing page, brochure and
  getting-started deck were still carrying the retired flat-tile mark (and an
  old favicon); all three now embed the current design.
- **macOS is no longer sold here.** Every macOS selling claim came off the
  landing page, brochure, deck, client docs and README — the Mac edition will
  be offered separately later. The builds, CI matrix and platform code are
  unchanged; only the advertising is gone.
- **The refund policy states its edges.** A closing note: beyond the two
  named exceptions, refunds are at the owner's discretion, and verified
  tampering, replication of Vyuha, or other malpractice forfeits them.
- **The getting-started deck caught up.** All six brokers named, the column
  mapper and three broker-API pulls listed, the full Pro screen set (Lenses
  included), the SmartScreen note beside the install steps — and one stray
  `</div>` that had survived since the deck was written is gone, verified by a
  tag-balance check.

## v2.99.94 — the renewal you were never warned about, and four claims that were not true

Almost none of this is new capability. It is the product telling the truth about
itself, and one long-standing hole in the plan that is meant to renew.

- **Your annual licence now warns you before it lapses.** There was no notice of
  any kind: the key was valid, and then one morning seventeen Pro screens were
  locked. The only reminder in the whole system pointed at the seller, not at
  you. From 30 days out, every Pro screen carries a dated countdown and a renew
  link, and nothing is withheld while it counts down. Your journal is unaffected
  either way — trades, imports, backups and exports keep working after expiry
  exactly as they do on a free copy.
- **PDF is no longer described as an importer.** It never was one: opening a
  broker PDF extracts the text so you can enter trades by hand, and produces no
  trades of its own. The import screen and the guide now say that plainly
  instead of listing PDF beside the six brokers that really do auto-detect.
- **Prices no longer claim to include tax.** No GST is charged or collected on
  these sales, so the line saying otherwise was wrong and is gone.
- **The download promise matches reality.** The installer is around 35 MB — too
  large to attach to an email — so the page now says you get a private download
  link, which is what actually happens.
- **macOS is described honestly.** Mac builds are produced for every release and
  available on request; they are not code-signed or notarised yet, so macOS asks
  you to right-click → Open the first time. Previously the page implied a Mac
  download that was not being packaged.
- **A refund policy, terms of use and a privacy statement now ship with the
  app**, inside the download. The FAQ used to ask "Is there a refund policy?"
  and then answer a different question.

For the seller, licence issuing gained two guards after a near-miss reading of
the tooling: a licence term must now be stated explicitly (omitting it used to
mint a lifetime key silently), and a paid licence cannot be issued without
recording its payment reference. Release day also gained a winget manifest
generator and a documented Microsoft file submission — the two free ways to stop
Windows warning buyers about an unsigned installer.

## v2.99.93 — five things that only showed up under load, two of which lost data

A load and stress suite now exists, and the first six tests written against it
found five real defects. Two of those were quietly destroying or refusing your
data, not merely being slow — and neither would ever have produced an error
message. **The thumbnail fix only protects backups taken from this version
onward**, so take a fresh one after updating.

- **Screenshot thumbnails no longer vanish when you restore.** Thumbnails are
  saved beside each screenshot under a companion name with no database row of
  its own — so the backup, which walks the attachment records, never included
  one, and a restore rebuilds the folder from the backup and deletes what was
  there. Your screenshots survived and every preview silently went blank. This
  also fires on the automatic backup Vyuha takes before a database upgrade, so
  it could happen without you restoring anything on purpose.
- **Deleting a large account no longer fails.** "Delete everything in this
  account" hands the whole list of trades to the database in one statement, and
  SQLite refuses more than 32,766 values at once — so above roughly that many
  trades the delete threw an error instead of running. The same fix cut a
  2,000-trade delete from 4,010 database statements to 29.
- **A staged position can no longer be left half-repriced.** Rebuilding a
  ladder wrote each tranche separately and then updated the parent trade, with
  no transaction around them: an interruption at the wrong moment left the
  tranches repriced and the headline figures stale, and nothing on screen would
  have looked wrong, because every report reads the parent row. It is now one
  all-or-nothing write.
- **Import preview is 364× faster on a large book.** Checking a new file
  against trades you already have compared every incoming row with every
  existing one. On a 25,000-trade book a 5,000-row import took **8 seconds**
  before the preview appeared — during which the whole app was frozen, so it
  looked like a hang worth retrying. Now about 20 ms.
- **Data Quality is 31× faster when your symbols are not price-marked.** The
  check for unmarked positions scanned the whole price table for every trade,
  and the scan only ended early when a symbol matched. With an F&O book against
  equity-only bhavcopy marks nothing matched, and the page took **10 seconds**
  every time it was opened. The same rewrite fixes a smaller wrong answer:
  marks written with different capitalisation counted as different symbols, so
  a fresh price could still be reported stale.

Also: the emailable one-page brochure and the standalone landing page were
several releases out of date on price and on what is included, and the
installation guide pointed at the wrong folder for your database file. All
corrected, with a test that now fails if the sales copy drifts from the app's
own prices again.

## v2.99.92 — the same app as v2.99.91, shipped by a pipeline that now works

**No behaviour changed since v2.99.91.** This release exists because v2.99.91's
did not reach you: its Windows job died on the release gate, so it published
with macOS assets only and no `Vyuha_x64-setup.exe` at all. Everything described
under v2.99.91 below — the signed revocation list, the grace countdown, the
locked-screen reason line, the corrected network claims — reaches a Windows
machine for the first time here.

- **Windows CI no longer fails a test that is not broken.** The DPAPI
  round-trip is the one test in the suite that spawns a real process — two cold
  `powershell.exe` starts to reach the OS keystore. That takes well under a
  second on a developer's machine and can exceed vitest's 5-second default on a
  cold CI runner. It now gets 60 seconds, so a slow runner reports a slow test
  instead of a broken build.
- **A release-tooling script stopped leaving a file behind.** The signature
  verifier wrote a scratch `.sigcheck.tmp` beside the source and never removed
  it; one got committed. It is now cleaned up in a `finally` and ignored, so a
  crashed run cannot leave a blob for the next commit to sweep up.
- **The revocation list's own release must be a prerelease** — written down in
  the three places that would have caught it. GitHub resolves "latest release"
  across every tag by creation date, so publishing that list without the flag
  makes it the latest release, and the updater's
  `releases/latest/download/latest.json` endpoint 404s. Auto-update then stops
  for every installed copy without a single visible symptom, because the
  updater is deliberately fail-open. Found and fixed the same day; the runbook
  now carries the one-line check that makes it visible.
- **The Node version is pinned, because a floating one broke the build.**
  `node-version: 22` resolves to the newest 22.x at run time, and the runner
  moved to 22.23.2 mid-afternoon. `better-sqlite3` then reported "No prebuilt
  binaries found": its installer, `prebuild-install`, is unmaintained and
  resolves the download name from a bundled table, so a Node newer than that
  table is a 404 rather than a fallback — and the fallback cannot rescue it,
  because `node-gyp` reads the image's Visual Studio 18 as `unknown version
  "undefined"`. A routine runner-image update broke the Windows release build
  hours after the identical commit had built fine. Both workflows now pin
  22.17.0, and `npm ci` retries three times for the genuinely transient case.
- **CI now builds on Windows — it never did.** Every CI job was Ubuntu or
  macOS, and the only Windows build in the pipeline was the release workflow,
  which runs *after* a tag is pushed. So every Windows-only breakage was
  guaranteed to be discovered as a broken release, and three were in a row.
  A new job runs the install, typecheck and unit tests on `windows-latest` on
  every push, so the next one fails a commit instead of a release.
- **The release verifier can no longer bless an incomplete release.** It
  printed "✓ every signature matches… Safe to publish" for a build with no
  Windows installer at all — every signature it inspected was genuinely
  correct, and the release was still unshippable. It now checks that all five
  expected artefacts exist *before* checking signatures, names what is missing,
  and exits non-zero. A verifier that cannot see an absent platform is worse
  than none, because its ✓ reads as "complete".

## v2.99.91 — a withdrawn licence now stops working before the next release

Revocation used to be a build-time list: a refunded or leaked key kept working
until the user happened to install a newer build. It now also travels as a
signed list the app picks up during the version check it already ran at every
launch — which means the honest thing to do was also fix four places that
promised no such mechanism would ever exist, and three that described this
app's network activity inaccurately.

- **The list travels down; nothing travels up.** The request carries no key
  id, no machine id, no account — the same public file is served to everyone,
  and which key it names was decided before the download, not by it. It is a
  plain fetch of a signed file, Ed25519-verified against the same vendor key
  as the licences themselves; an unsigned, altered or older list is ignored.
- **Three warnings and a grace period, then it locks.** An entry names the
  date it takes effect. Until then every Pro screen carries a countdown — "14
  days left", with your message — and *nothing* is withheld, so a withdrawal
  is never discovered as a dead screen. Your journal is untouched either way:
  trades, imports, backups and exports keep working after that date, as they
  do for any unlicensed copy.
- **Reversible, and it fails open.** Publishing a newer list without the id
  un-revokes, with no build to ship. No list, a corrupt file, a captive-portal
  login page or an offline machine all resolve to "keep working" — the
  alternative is locking out a paying user whose internet is down.
- **An older list cannot undo a newer one.** The accepted issue date ratchets
  in the database, so keeping yesterday's copy and restoring it changes
  nothing — and a *rejected* list deliberately does not advance that ratchet,
  or a forgery could lock a machine out of the genuine list behind it.
- **A blocked screen now says why it is blocked.** The entitlement has always
  carried a specific reason — a key locked to a different computer, a licence
  that cannot be decrypted on this machine, and now a revocation message — and
  it was computed and then rendered nowhere. Every locked Pro screen said "your
  annual license has expired", which for those cases is untrue and tells the
  user nothing they can act on. It now shows the actual reason, and stops
  claiming an expiry when nothing expired.
- **The copy was corrected, not the feature softened.** The desktop app has
  always asked GitHub for a newer signed release at every launch — that was
  never optional, and three published claims said or implied it was. They now
  state plainly that one download-only check runs at launch, sends nothing
  about you, and cannot be switched off. The two real limits are written down
  in the same places: a permanently offline machine never receives the list,
  and none of this survives a patched binary.

## v2.99.90 — the first broker that connects itself every morning

Angel One joins the API pulls — and unlike Zerodha (daily browser login) or
Dhan (24-hour tokens), nothing about it expires on you: the day's login code
is minted from your TOTP secret at pull time, unattended.

- **Connect once with four credentials** — SmartAPI key, client code, PIN and
  the TOTP *secret* (the base32 behind the enrollment QR). All four live
  encrypted in the v2.99.80 vault; the extras travel as one sealed blob in a
  new column, a broken vault refuses the save outright, and backups carry
  none of it. Pasting the 6-digit code where the secret belongs is caught at
  save with an explanation, not at tomorrow's pull as a broker rejection.
- **The TOTP engine is forty lines of node:crypto, pinned to RFC 6238's own
  test vectors** — no new dependency, and this app's six digits and your
  authenticator's six digits cannot silently diverge.
- **Read-only by construction.** The Angel One module exports login and the
  trade book — no order, no funds, no modification — and the export list is
  pinned in tests, so a trading capability cannot be added without failing
  CI. A leaked pull path cannot trade.
- Pulls fetch today's fills, aggregate them per symbol + product with every
  execution preserved, and run the same preview → classify → charges → dedup
  pipeline as every file import. Re-pulls are idempotent.
- The honest one: the login contract is verified against Angel One's docs,
  but the trade-book row shape is inferred from their examples — the pull's
  own warnings say so, unreadable fills are refused and counted rather than
  guessed, and the first live pull should be previewed against a contract
  note once. The connect card also stops claiming credentials are stored
  "in plain text" — that sentence outlived the vault by one release.


## v2.99.80 — what the database file knows, it no longer tells

Secrets at rest. Until now the licence key and the broker API credentials
sat in SQLite as plaintext — defensible for daily-expiry tokens, and
exactly the thing that had to change before longer-lived credentials
(a TOTP secret is a permanent second factor) ever arrive.

- **Every stored secret is now encrypted with a key the database does not
  hold.** One AES-256-GCM vault key per install, wrapped by Windows DPAPI
  (bound to your user profile) or a machine-identity KDF on macOS/Linux,
  living beside the database — so the .sqlite file alone, copied, synced or
  shared, carries nothing usable. Built on node:crypto only; no new
  dependency.
- **Nothing changes for you until something goes wrong, and then it says
  so.** Existing plaintext upgrades itself on first read. On a new machine
  the app asks you to re-paste the licence key from your purchase email and
  to re-connect brokers — never a crash, never a silently lost journal.
  Saving a NEW credential while the vault is broken refuses loudly instead
  of quietly storing plaintext.
- **Backups stop carrying credentials entirely.** Broker connections travel
  as names only, the way the licence key has been redacted since v2.99.75;
  a restored journal prompts you to re-connect.
- The honest one: this defends the file at rest, not a compromised machine —
  no user-mode design defends secrets from other code running as you, the
  OS keychain included. The claim is narrower and true: your database alone
  tells nothing.


## v2.99.77 — the boundary holds everywhere

The integrity sweep. Eleven defects from the 2026-08-12 register, most of
them one disease: code touching an account-scoped table without resolving
which account it was in. None of them looked broken on screen — which is
exactly why they were dangerous.

- **Every write now resolves its account at the point of touch.** Sessions no
  longer accept a client-supplied account id (a stale tab could silently MOVE
  a plan across accounts); IPOs added from the All-accounts view land in the
  resolved account instead of always account 1, and IPO edit/delete refuse
  ids outside the account being viewed; every staged-position leg mutation
  now runs the same own-account check the delete engine has always had.
- **IPO exit charges come from the charges engine.** The rates were
  hard-coded — STT, exchange, SEBI, stamp, DP, GST, frozen in source where no
  budget change could reach them — and they fed real net P&L into capital
  compounding. Exits now price through charge_config like any delivery sell,
  with the allotment as a zero-brokerage buy side; the old constants survive
  only as the documented fallback for an IPO that names no broker.
- **Deleting a playbook now does what it always claimed.** "Its trades fall
  back to Untagged" was false — trades kept a dead id, session plans kept
  ghost references, and the journal dialog rendered a select with no matching
  option. The references are nulled in the same transaction and the message
  reports the real counts.
- **Archiving the selected account no longer strands you.** Selection moves
  to a live account the moment its account is archived, and one live + one
  archived account reads as a single-account book, not an aggregate.
- **The guard tests can now fail.** The account-isolation registry maps each
  scoped table to owner files and fails unless each owner actually resolves
  the account — on its first run it correctly distinguished a route that
  delegates from a route that forgets. The reconciliation diagnostics assert
  their figures exist instead of ending in expect(true). The dead `positions`
  table — 28 columns, zero readers, faithfully backed up empty for months —
  is dropped (migration 0045).
- The honest one: exercise STT (0.125% on intrinsic) stays a named constant.
  It is a different statute from the premium STT charge_config carries, feeds
  one advisory figure, and inventing a config column no computation uses
  would be worse — recorded in DECISIONS.md.


## v2.99.76 — the price becomes the positioning

Supersedes v2.99.75 within the hour — that build shipped with the launch-era
prices baked in, and an offline app quoting a price is making a promise the
seller has to keep.

- **Repriced: Pro — Annual ₹9,999/yr (recommended) and Journal — Lifetime
  ₹29,999.** Two SKUs, clean numbers. The strike-through anchor and the
  "first 100 buyers" scarcity banner are gone — at this price point the
  credibility is the pitch, and manufactured urgency undercuts it. The
  TradingView-indicators bundle came off every pricing surface; indicators
  remain a conversation, not a card.
- **Every surface moved together, held by a test.** The in-app pricing module,
  the upsell panel, the licence card, /pricing, the landing page and the
  brochure all quote the same two numbers, and CI pins the code to the
  landing page's own price cells — the two things a prospect can compare
  side by side cannot drift apart.
- The brochure's third card now shows the **free tier** (₹0, forever) instead
  of an indicators price — the free journal is the honest third offer, and it
  sells the paid ones.


## v2.99.75 — the file proves itself, the delete forgives, the price speaks

The trust wave: three different promises the app was quietly breaking — about
whose file it was reading, about what delete meant, and about what it costs —
each rebuilt to be provable.

- **Import detection was rebuilt on in-content fingerprints, after a real
  misroute.** A Groww order-history export imported as broker "Zerodha" — 111
  rows, priced at Zerodha's rates, reported as success. The probe that
  diagnosed it found a second live misroute the same day: Paytm's tradebook,
  claimed because its filename contains the English word "tradebook". Every
  broker parser now has to prove whose file it holds — Zerodha by its Auction
  column or its "- Z" charge heads, Groww by its own metadata phrasing, Paytm
  by UCC + its misspelt "Script" column — and a file that names no broker gets
  the column-mapping question, never a guess. A cross-broker refusal matrix
  runs redacted copies of real exports through the registry in CI.
- **Three new import formats, from verified real exports.** Paytm Money
  tradebook (per-execution WITH the broker's own charge breakdown — richer
  than Zerodha's), Angel One tax P&L (seven independently-headed sub-tables,
  futures and options, and the only export examined that states MTF quantity
  directly), and Groww stocks order history (no price column — price is
  derived, and the file says so). Six brokers now auto-detect.
- **Every delete writes a snapshot first.** Trades, staged legs and chart
  attachment bytes move into a per-delete snapshot beside the database,
  restorable from Backup & Restore → Deleted items — under their original ids,
  so nothing that pointed at them is orphaned, and never restored as a
  duplicate if the same trades came back by re-import. New delete scopes —
  date range, current view, one broker, one type, one file, one hand-entered
  day — all resolve through the same confirmation that shows the exact set
  before anything happens. Nothing is auto-purged.
- **Lenses.** One screen, six cuts of the same book — month, broker, trade
  type, import file, setup, outcome — each group with its own P&L, charges
  and (with Pro) win rate, profit factor, expectancy and average R. Built for
  the question "what exactly did that one import produce?", and every group
  can be deleted from where you see it.
- **The app finally answers "how much?".** Real prices on the trial-expired
  panel, the licence card and a new in-app pricing page, each carrying the
  date they were true and embedding the quoted figure in the WhatsApp message
  — an offline build cannot check for a price change, so the quote travels
  with the conversation instead of pretending to be live.
- **Money now lands where the screen reads.** Compounding realised P&L wrote a
  global row while the summary read the per-account one: "Compounded +₹X",
  no visible change, and the rolled-in marker burned every other account's
  un-compounded P&L. Capital and its marker are per-account now, and the
  aggregate view refuses to compound rather than move money between books.
- **Backups carry all thirty tables, and nothing that isn't yours.** Four
  tables had silently fallen out of the backup list — restoring lost every
  uploaded MTF margin sheet — and the guard test counted to 26 instead of
  reading the schema, so it could not notice. It reads the schema now. Licence
  key and trial state no longer travel in a backup at all: a shared file is no
  longer a shared key, and restoring an old backup no longer rewinds the
  clock ratchet.
- **The honest one.** Three e2e specs had been red since v2.99.70 — that
  release renamed the row-action tooltips and the specs kept querying the old
  attribute, one of them burning its full 90-second timeout every run. Four
  locator lines. The suite is genuinely green again, and the two "guard" tests
  that could not fail (a table count and a name list) were rebuilt to
  introspect what they claim to protect.


## v2.99.70 — three new skins, and the chrome grows reflexes

- **Three new accent skins: Royal, Sapphire, Aurora.** Violet-led and regal;
  electric indigo with orchid analytics; fuchsia-led with teal — the most
  vibrant palettes the app has shipped. Like the original four, each is a
  coordinated triple (primary / money / analytics), measured before it was
  written: every colour clears the same WCAG contrast floors as the existing
  skins on both themes, roles sit 67–109° apart on the hue wheel, and no
  primary comes near the profit/loss hues. Settings → Appearance; the P&L
  colours (and colourblind mode) are untouched, as always.
- **Real tooltips.** Hot surfaces — the sidebar rail, the trades toolbar, the
  calendar heatmap, the screenshot viewer — replace the browser's slow
  OS-styled `title` bubbles with app-chrome tooltips that appear in 300 ms,
  follow keyboard focus, and flow instantly between adjacent icons.
- **The command palette became a real dialog.** Ctrl+K now traps focus, locks
  the page scroll behind it, and dismisses like every other overlay — the
  last piece of chrome that only looked like a dialog. Keyboard behaviour
  (arrows, Enter, Ctrl+K toggle) is unchanged.
- **The money gold turned metallic.** The gold accent brightened to a more
  saturated bullion (#f0b429, same 41° hue, contrast up not down), and the
  headline money numbers — total charges, MTF interest, charges leak — now
  wear a champagne-to-bronze gradient with a soft glint. Built from tokens,
  so every skin keeps its own money colour (Tape's stays violet), light theme
  keeps its AA-safe dark golds, and print falls back to solid ink.
- **Numbers count up everywhere.** The dashboard's animated KPI treatment
  rolled out across the report and tracker screens — raw numbers animate in
  over ~700 ms with the currency sign kept quiet, and render instantly under
  reduced motion.
- Owner docs: paid code signing is formally deferred (users are happy with
  the branded wizard); the free mitigation playbook — winget listing,
  Microsoft reputation submissions — is written down in
  docs/owner/CODE_SIGNING.md, with the Azure wiring kept dormant.


## v2.99.60 — every screen speaks the same language

The cosmetic wave. Nothing about what the app computes changed; everything
about how it carries itself did:

- **Every table wears the same chrome.** Thirty-seven hand-rolled tables —
  the tax pack, discipline, edge, ITR, surveillance, sessions, the audit log,
  the ledger — now share the trades table's treatment: tracked-caps header
  bands, sticky headers, readable sans-serif prose with tabular numbers, row
  hover. The reports no longer look like a different application.
- **One feedback voice.** Thirty-one components' inline messages became
  toasts — and the six forms that used to save SILENTLY (journal, IPO, risk
  edits, position close, limit check, AIS) now confirm. Persistent results
  (parse recaps, limit verdicts) stay where they belong, on the page.
- **Empty screens tell you what to do next.** Thirty-three empty states share
  the illustrated treatment, with a real next step wherever one exists — and
  a brand-new install now greets you with "Nothing journalled yet — import a
  broker file", not five ₹0 tiles and advice to clear a filter you never set.
- **Dialogs keep their bearings.** Sticky titles and footers — Save can no
  longer scroll out of reach in the tall forms — and the close button finally
  has a focus ring.
- **Print works everywhere.** Report cards no longer split across page
  breaks, and buttons/headers stay off the paper.
- **Screenshots got light.** New chart uploads carry a browser-generated
  thumbnail, so a screenshot-heavy journal no longer decodes hundreds of MB
  to paint a film-strip. Existing attachments are untouched and keep working.
- Loading skeletons now match what they stand in for (no more 12px jump on
  every navigation), captions scale with the Comfortable density setting
  again (151 fixes), the command palette animates like every other overlay,
  the last unguarded animation respects reduced-motion, and the flagship PDF
  header can never render a tofu box again.


## v2.99.55 — fewer questions asked, none answered twice

Performance wave two — the server side:

- **Every navigation asks the database less.** The account resolver answered
  the same question up to ten times per page; now once. The mark-to-market
  table was scanned twice back-to-back on the risk screens; now once. The
  risk cockpit asked two questions per staged position and one per held
  symbol's price history; now two and one for the lot.
- **The Monte Carlo stopped re-simulating a book that hadn't changed.** The
  ruin analysis is deterministic, yet all 504,000 iterations reran on every
  performance-report view — now computed once per book state.
- **Back/forward is instant.** The browser reuses its own copy of a page for
  30 seconds on history navigations instead of refetching everything.
- **The honest one:** we attempted the React Compiler this wave, proved by
  bisection that it introduces hydration mismatches on this toolchain (an
  upstream JSX-whitespace bug — three errors flag-on, zero flag-off, same
  page, same data), and rolled it back the same day. The attempt left the
  codebase better guarded than before: the surfaces where a compiler fails
  SILENTLY — table sorting, the sidebar's order restore, the live charge
  preview — now have their own regression spec.


## v2.99.50 — built for the ten-thousand-trade book

Performance wave one, everything measured before and after:

- **The Trades table now scales.** The client receives a 43-field wire
  projection instead of all 74 columns (44% off the payload — ~8.7 MB instead
  of ~16 MB at a 10,000-trade book), and the rows are **virtualized**: the DOM
  holds only what fits your window, whatever the book's size. Selection,
  per-view counts and the "N of M" counter still speak for the whole filtered
  book — the semantics moved nowhere.
- **The hottest query got its index.** Every navigation runs the same
  account-filtered, date-sorted trades read on ~25 screens; a composite index
  turns its filesort into an index scan.
- **399 KB of spreadsheet library left every screen.** The XLSX exporter now
  loads at the moment you click Export, not on every dashboard/report visit —
  and the import screen stopped shipping the entire parser stack to the
  browser for one line of hint text.
- **Startup got honest.** The desktop app backed up your whole database on
  every single launch, protecting against migrations that weren't happening —
  and did it with a raw file copy that, under WAL, could miss just-committed
  trades. It now backs up only when a migration is actually pending, through
  SQLite's own backup API, and polls for the server five times faster.


## v2.99.45 — the forensic pass

A three-lane audit of every feature against real application data — engines and
money identities across all 252 journal rows, all 40 routes rendered live, the
full e2e suite, and an adversarial read of every changed file. Three real
defects surfaced; all fixed and pinned by tests:

- **Statutory rounding at an exact half rupee.** IEEE754 could land ₹7.50 of
  stamp duty at 749.9999999999999 paise and round it DOWN to ₹7 where half-up
  statutory rounding says ₹8. `roundRupee` now carries sub-paisa float armour;
  off by at most ₹1 and only at exact halves, but a money engine rounds the
  way the statute says, always.
- **The attachment viewer could reopen uninvited.** Deleting the last
  screenshot left a stale viewer index behind, and the next upload satisfied
  it — popping the viewer open unasked. Delete-last now clears the index.
- **A truncated REG_IND row could silently wipe the ESM category.** Detection
  read columns off the first data row instead of the header line; a re-saved
  file with a short first row could hide the trailing ESM column and clear
  that category while reporting success. Detection now reads the header.

Everything else came back clean, on the record: money identities 0 violations,
account scoping intact, licence import graph safe, all routes streaming without
error chunks, the print path canvas-free, and the empty-ban-day path working
exactly as designed.


## v2.99.40 — the calculator remembers, the exchange files import themselves, and the installer looks like us

**The Trade Calculator got a memory and learned the indices.** Equity and F&O
each keep their own last-entered trade now — flip modes and ₹2,450 of stock
entry no longer masquerades as an option premium; reload and both books come
back, including which mode you were in. A new **Underlying index** picker fills
the correct market lot for Nifty 50, Bank Nifty, FinNifty, Midcap Nifty, Sensex
and Bankex — verified against the exchanges' January-2026 lot revision (Nifty
is 65 now, not 75), routed to the right exchange automatically (Sensex means
BSE), and every lot names its source: your own fo_mktlots upload beats the
bundled snapshot, and a manual edit is respected and labelled, never silently
corrected.

**Chart screenshots open inside the app.** Click a thumbnail and a full-size
viewer appears — arrow keys, a counter, the file's name/size/date, delete, and
an "Open in tab" escape hatch. Escape closes the viewer, not the dialog you
were in.

**Surveillance imports the exchange's own files.** Drop NSE's `fo_secban.csv`
(F&O ban) or the `REG_IND` Surveillance Indicator file — one file that carries
ASM (long & short term), GSM **and ESM** stages for every listed scrip — and
the app reads the trade date out of the file itself. Each upload replaces only
the categories that file speaks for, so the ban list, the surveillance list
and your pasted BSE rows coexist. ESM is now a first-class category with its
own tile. A file it cannot fingerprint is refused with the headers it actually
saw — never imported confidently and wrongly.

**The Trades table's columns reorder by drag**, like the sidebar — the frozen
row-select and Instrument columns stay put, the order survives restarts, and a
reset control puts everything back.

**Four coordinated looks.** Luxe (the shipping gradient), Terminal (flat),
Ice and Tape — each swaps the whole primary/money/analytics triple so the
colour law holds in every skin, in dark and light both. And the trade replay
moved to a native price chart (lightweight-charts) — screen-only by design;
everything that reaches paper stays SVG so PDFs keep printing light.

**The installer finally wears the mark.** Setup's title bar, header, file icon,
wizard banner and sidebar all carry the Trinity Chakra now instead of the stock
NSIS globe users kept mistaking for malware — and updates refresh the desktop
shortcut's icon without an Explorer cache dance.


## v2.99.30 — import from any broker, and a new skin for the whole app

**Import now works with every broker, including ones we have never seen.**
The report was "why does import only show 3 brokers", and two bugs sat behind
it. The dropzone's hint was hand-written and had drifted — the app read five
brokers' files while the text named three — so it is now generated from the
parser registry and a test fails if anyone hand-writes it again.

The second was worse and invisible. The Angel One / Upstox detector scored on
tradebook *shape* alone: a symbol column, a side column. That describes every
Indian broker's export, so **any CSV with a column called "Scrip" was claimed as
Angel One** — a Kotak Neo, Paytm Money or Sahi tradebook imported silently as
Angel One trades, priced with Angel One's charge rates. A broker-named parser
now has to see the broker's name before it claims a file. The PDF sniffer had
the same flaw: it knew three brokers and defaulted everything else to Dhan.

Kotak Neo, Paytm Money and Sahi publish no column specification anywhere — not
in their own help pages, and not in the third-party journals that support them,
which ask users to email a sample file. So rather than guess at their headers,
Vyuha **asks**: drop any broker's CSV/XLSX, match the columns once, and the
mapping is remembered for that broker. Mapped tradebooks go through the same
FIFO pairing, de-duplication and charge engine as native ones — nothing
downstream can tell the difference. A row whose cells cannot be read is skipped
and counted, never coerced to zero; a trade for zero shares at zero rupees is
worse than no trade.

**A new mark.** Three arcs in the interface's own three roles — teal for what
you can act on, gold for money, violet for what the numbers say about you —
ringing व hung from a shirorekha drawn as a price level, with a ₹ coin in the
lower right. It replaces the squircle everywhere at once: taskbar and dock,
installer, favicon, sidebar, the share card you post publicly, the printable
report. The Devanagari outline is reused rather than re-traced, so the letter is
the same one already shipping and still never a font-dependent text node.

**Tables you can actually read.** Every table rendered in JetBrains Mono — a
face built for digits — so company names, brokers and segments came out ~15%
wider with their word shapes flattened. Prose is now set in Inter and only
numbers stay monospaced, which is the one thing the mono face was ever needed
for: columns still align to the digit. Table headers, the sidebar caption and
KPI labels each moved up a step in size.

**A new look — "Dark Luxe".** Near-black blue-cast canvas, panels that are
gradients rather than flat fills, and a colour law: teal is anything you can
click, gold is money leaving the account, violet is a statistic about your
trading. Space Grotesk joins Inter and JetBrains Mono for titles. The Tape and
Ice accent skins are retired — a swappable amber primary beside a fixed gold
"money" role reads as a bug, not a choice.

Light mode was measured rather than assumed: the new gold only clears WCAG AA
against pure white, not against this app's actual off-white canvas, so it ships
two steps darker at 4.95:1. The row hairline kept its old measured value for the
same reason — the proposed one computed to 1.12:1, which is where separators
went invisible on 250-row tables once before.

- The hero card's teal border had never rendered, in any release — Tailwind
  sorts custom utilities before its own, so the plain border token always won.
- The desktop build compiled the web bundle, type-checked, seeded the template
  database and copied an 81 MB Node runtime **twice** on every run. Once now.
- `margin_config` gained the broker-completeness test `charge_config` has had
  for releases; adding a broker with no margin rows used to price at defaults
  silently.
- The API panel says plainly that only Zerodha and Dhan pull over an API, and
  that everything else imports by file.

## v2.99.20 — the app fits the trader, not the other way round

Six changes, all answering the same complaint from testing: the app knew more
than it was willing to show, and showed more than any one trader needed.

**MTF now shows the rate it is actually using.** The own-capital / broker-funds
split used to render on *every* equity trade — delivery and intraday included,
where broker funding does not exist — with a static 25% in the hint text. The
engine was resolving per-stock margins correctly all along; the form was
describing a default it wasn't using. The split now appears only for MTF, and
leads with the resolved percentage, naming the stock and the broker list it
came from. A stock missing from that broker's list says so instead of quietly
falling back.

**Chart screenshots are findable.** The feature existed in three places and was
discoverable in none: add-trade only revealed it *after* saving, the edit and
journal dialogs buried it below the fold, and no trade row ever indicated an
attachment existed. Trades now carry a paperclip with a count, and the add form
says up front that a chart can be attached.

**Daily P&L calendar** — click any day to open exactly that day's trades.
Above it, current and best green/red runs counted in *traded* days (a weekend
does not break a streak, and a flat day neither extends nor breaks one), best
and worst days marked in place, and each month's net in its header. Fixes a
UTC bug that could highlight the wrong cell as "today" for users east of GMT.

**Sidebar reordering is a drag, not a click.** A grip appears on hover; the row
follows the pointer with a glow and an insertion line shows where it will land.
Replaces the arrow buttons, which testers found mechanical.

**Workspace mode (Settings → Workspace).** Say you trade only equity or only
F&O and the other book's screens leave the sidebar and command palette, with
the bucket filter on Trades and the Dashboard seeded to match. It is not a
lock: hidden routes still open from a link or bookmark, the screen you are on
always stays in the sidebar, the pre-filter is the screen's own control and
clears in one click, and a chip names the mode and links back to Settings.

**A wider Pro surface.** Deep analytics (Arjun's Eye, Edge/Setups, Discipline,
Scaling), the options-seller pack, the tax pack, data & export tools, and live
open-position tracking now sit behind a licence. Recording *closed* trades —
your own record of what you have already done — stays free, as it always has.

### Under the hood

- `PRO_FEATURES` went from 6 entries to 17, and its doc comment was corrected:
  it claimed adding an entry gated a page "everywhere at once", which was never
  true — `ProGate` takes no feature argument. `tests/pro-gating.test.ts` now
  reads the real page files and fails if the registry and the gates drift apart,
  or if a core-journal page ever gains a gate.
- Two drag bugs fixed before they shipped. `setPointerCapture` ran before any
  state was set, so a capture failure killed the drag silently; the listeners
  now live on `window`, which needs no capture — and which is what makes a 12px
  grip usable at all, since the pointer leaves it immediately. Separately, the
  insertion line counts rows as displayed while `moveIndex` splices after
  removal, so every downward drag landed one slot too far. `dropTarget`
  reconciles the two coordinate systems.
- `moveWithinVisible` keeps a saved sidebar order intact when workspace mode is
  hiding part of the list — committing the drag's visible-only indices directly
  would have written back an order with every hidden screen missing.
- Migration `0042_workspace-mode` adds `settings.workspace`, defaulting to
  `both`: existing installs behave exactly as before until the user chooses.
- Calendar "today" was computed from an ISO/UTC string, which highlights the
  wrong cell for anyone east of GMT after ~05:30 IST. Now built from local
  date parts.

## v2.99.10 — the trial is now 7 days

The full-Pro trial on a fresh install is **7 days**, down from 14. One trading
week is enough to import a real book, sit through an expiry and see a
charge-leak number; the second week mostly added drift before the decision.

Everything else is unchanged from v2.99.9. The core journal remains free
forever — the trial only ever gated the analytics layer.

Two notes on the mechanics, because they matter:

- The countdown is `TRIAL_DAYS − days-since-first-run`, so an install already
  past day 7 of the old trial shows 0 days remaining as soon as it updates.
  Existing evaluators should be issued keys before they update.
- `TRIAL_DAYS` in `lib/license.ts` is the single source: every screen, doc and
  sales page derives from it, and the entitlement tests assert against it
  rather than a baked-in number.

## v2.99.9 — every broker's MTF list, compared — and a sidebar that's yours

### The complete MTF picture (10,501 per-stock margins, all seven brokers)

The bundled margin snapshot is now built from each broker's own feed via the
owner's refresh toolkit — Dhan (1,742), Zerodha (1,493), Upstox (1,440),
Kotak Neo (1,680), Paytm Money (1,460), Angel One (1,557, per-scrip from
back-office categories + NSE VaR/ELM) and Groww (1,129). Approved-but-
unfunded scrips (Kotak funds 1,178 of its 1,680) carry 100% own margin and a
funded flag — full cash in practice, never an invented funding number. Every
MTF consumer upgraded silently: the trades-form auto-split, the margin gauge
and the drift card now answer per-scrip for brokers that previously fell back
to rules.

### Broker Costs: MTF across your brokers

A new section on the cost comparison: per-broker funding reality (approved vs
actually funded, median margin, best leverage), Sahi listed explicitly as
offering no MTF delivery, and **your own delivery/MTF symbols margin-priced
across all seven lists** with the cheapest broker highlighted per stock. The
footer says what the table can't: lowest margin is most leverage, not lowest
cost — interest, plan fees and DP are priced in the cost table above.

### A sidebar that's yours

"Customize order" — move screens within a group, move whole groups, persisted
on this machine, one-click reset. Saved order merges with each update's nav,
so new screens appear in their default slot instead of vanishing.

## v2.99.8 — MTF that knows your broker's list, and trades that carry their charts

### Per-stock MTF margins (3,083 real numbers, not one assumption)

The flat 25% own-margin assumption is gone. The app now bundles the brokers'
own approved-stock margins — Zerodha (1,493, complete), Paytm Money (1,460,
complete), Groww and Kotak Neo (partial — their sites serve no more openly),
Angel One and Dhan as their published rules (40%/50% by category; ~25%).
Coverage is declared everywhere: a partial list never pretends otherwise.
Resolution chain, most specific wins: your uploaded refresh → bundled stock
list → broker rule → your margin-config rate → 25% default. Refresh without
an update: upload a broker's JSON/CSV and it takes precedence.

- **Trades form**: pick MTF, enter price and quantity — your capital and the
  broker-funded amount fill in from the per-stock margin, both editable, each
  deriving the other. A badge names the source and its as-of date.
- **Margin gauge**: MTF positions block their own-margin share at the
  per-stock rate ("own 25.9% (stock list)"), never 100% of invested.
- **Startup checks** on Portfolio Risk: a staleness flag when the bundled
  lists age past 60 days, and an MTF drift card showing open positions whose
  current requirement moved since entry — with the top-up figure. The journal
  itself is never rewritten.
- `docs/MTF_STOCK_LISTS.xlsx`: the full capture, one sheet per broker, with
  sources and caveats.

### From the previous batch, also in this build

- **Chart screenshots at trade entry** — saving a trade flows into an attach
  step (trade commits first; screenshots never block the save); the edit
  dialog gets the same section.
- **Export selected trades as PDF** from the Trades toolbar — summary tiles
  plus a full-detail card per trade, print-to-PDF.
- **Daily P&L calendar honesty** — closed trades with no exit date (aggregated
  P&L imports) are now counted under the calendar instead of silently missing.
- MTF margin estimate fixed to block only the own-margin share (was 100% of
  invested when no rate was configured).

## v2.99.7 — sectors in one click, and edge by theme

### The bundled NSE index map

Official industry classification + thematic index memberships for ~1,150 NSE
symbols, built from 54 index constituent lists and bundled with the app
(snapshot date shown in the UI — constituents change at every semi-annual
rebalance; `scripts/build-nse-index-map.mjs` regenerates from fresh
downloads). One click on Instruments fills sectors, names and ISINs for every
symbol in your master — and the **sector-concentration panel on Portfolio
Risk starts working without any manual tagging**. Sectors fill only empty
cells: a classification you typed yourself is never overwritten. Individual
`ind_*_list.csv` uploads work too, and record that index's membership.

### Edge by NSE theme

A new lens on the Edge report: expectancy, win rate and net P&L per thematic
index — Defence, Railways PSU, EV, Digital, Internet… — answering where your
edge actually lives, which segment and setup tables cannot see. Honesty built
in: themes overlap (one stock sits in up to ten indices), so rows are labelled
as lenses, not slices; only closed trades count; thin samples are flagged; and
the untagged remainder of your book is reported, never hidden.

## v2.99.6 — files in, typing out

### Uploads everywhere data used to be typed

- **Instruments** fill from the files NSE actually publishes: the daily CM
  bhavcopy or `EQUITY_L.csv` (names + ISINs) and `fo_mktlots.csv` (lot sizes),
  with in-app guidance on where each lives on nseindia.com and to download
  after ~6 PM IST. Merge semantics: only columns a file proves are written, so
  sector tags survive — no NSE file publishes sectors, and none are invented.
- **Corporate actions** import from the NSE CF-CA CSV. Splits, bonuses and
  cash dividends are translated (bonus A:B → ×(A+B)/B, FV split X→Y → ×X/Y);
  every parsed row keeps the verbatim PURPOSE as its note so the reading can
  be checked before applying; rights and buybacks are counted, never guessed;
  re-uploading an overlapping date range never duplicates an event.
- **Symbol aliases** accept a CSV upload (header row auto-dropped).
- **AIS reconcile** accepts the income-tax portal's JSON download. A tolerant
  walker classifies headings and inherits them down to detail rows, prefers
  leaves over category aggregates (the double-count trap), normalises AY→FY,
  and reads Indian-grouped amounts. Paste still works — one reconciler, two
  front doors.

### The audit log grew categories

Auto-MTM writes a row per trading day, and after a few months the flat table
was price-maintenance noise with a journal buried in it. Entries now group by
**what happened** — Trades · Journal & playbooks · Imports & deletes · Capital
· Settings & rates · Licence · Auto-MTM — as clickable category cards with
counts, drilling into the detail table.

### The client template is finally anonymous

The bundled first-run database carried the developer's own capital figures and
go-live date into every installed copy. It now ships zero capital and a
sentinel go-live that is stamped to the *user's* actual first-launch date.
Existing installs are untouched — this affects new installs only.

## v2.99.5 — the व mark, and tables you can actually read

### Identity

Vyuha finally has its own mark: the Devanagari letter **व** hanging from a
shirorekha extended edge to edge across a teal squircle — the headline stroke
of the letter doubling as a price level cutting the frame. It ships everywhere
at once — installer icon, taskbar/dock, favicon, sidebar, share card — all
generated from one committed glyph outline by `scripts/make-logo.mjs`, so the
surfaces cannot drift. The outline comes from Noto Sans Devanagari (SIL OFL),
extracted once and committed: nothing depends on a Devanagari font being
installed on the user's machine. The share card previously drew व as canvas
*text* in a font with no Devanagari coverage — exported PNGs could carry a
tofu box; they now paint the same outline via `Path2D`. A secondary ₹ mark
(same bar, same baseline — ₹ was derived from र and hangs from the identical
stroke) ships as a brand asset.

### Readability

- **Row separators you can see.** Every table drew its row rules at
  `border-border/40` — measured at 1.08:1 against the row surface, below what
  the eye registers as a line. A dedicated `--color-rule` token (~1.5:1, both
  themes) now rules all 50 separator sites. Zebra striping was measured and
  rejected: the surface tokens are only 1.02–1.05 apart, too close to read.
- **Headers that read as headers.** Table headers were the same size and
  nearly the same weight as data rows. They are now a step smaller, uppercase,
  letter-spaced — a proper header band.
- **Light-mode primary now passes AA.** `#0d9488` on white measured 3.74:1,
  under the 4.5:1 floor for the small text primary is used for (links, active
  nav, sort state). Now `#0b7a70` at 5.21:1 — visually the same teal.

### Ease of use

- **Display density** (Settings → Preferences): Compact (the shipped terminal
  look) or Comfortable. One root font-size — everything is rem-sized, so the
  whole interface scales together, and the choice joins My Default Settings.
  Baselines captured before this release simply don't track it: no phantom
  "differs from your default" after upgrading.
- **The trades table pins select + Instrument** while scrolling horizontally —
  wide tables no longer scroll the symbol out from under you.
- **Long option names truncate** (full name on hover) instead of one
  tradingsymbol shoving every P&L column off screen.
- **Sticky headers and rows now share one surface** — scrolling no longer
  reveals a tone step between the header band and the table it belongs to.
- Table heights use `dvh`, so mobile browser chrome no longer hides the last
  visible rows.

## v2.99.1 — a help desk, honest deletion, and settings that come back

### Help Desk

A new screen (`/help`, System group) describing every part of Vyuha: the
question each screen answers, its honesty rules, and what it deliberately will
**not** do — the refusals are design, so they are documented as features.
Searchable by task words ("delete", "stop loss", "grandfathering"), grouped like
the sidebar, every card deep-linking to its screen. A build-time test joins the
help registry against the navigation in both directions, so a screen without
help — or help for a screen that no longer exists — cannot ship.

### CLEAR / DELETE

Deleting is the one destructive thing Vyuha does to a user's own record, so the
decision and the execution are separated: a pure resolver turns a scope into
exactly which trades match, and the confirmation dialog shows — and submits —
that same list of ids. Nothing is re-derived after you confirm.

- **Select rows in Trades** with checkboxes (header selects all visible;
  selection resets when filters change so a hidden row cannot be deleted
  unseen), then delete with a full preview: counts, open/staged warnings, net
  P&L, symbols and date span. Past ten trades, the count must be typed.
- **Delete an imported file** from the Import screen — with the cascade question
  asked explicitly: remove the trades it created too, or keep them and lose only
  the provenance record. The table shows how many trades each import still owns.
- **Scopes for batch cleanup**: import batch, manual-entry day (which means
  *not-imported*, so an import can never be swept up by a manual cleanup), date
  range on either leg, broker, segment, account, or exactly what the current
  filter shows.
- **Fixed on the way**: the old single-trade delete removed the trade row and
  nothing else — orphaning legs and attachment records, leaking screenshot files
  on disk forever, and writing no audit entry. Every delete now takes the
  trade's belongings with it, writes the full before-snapshot to the audit log
  first, and unlinks (never deletes) a linked IPO record.
- There is deliberately **no "delete everything"** — that is what Backup &
  Restore is for, where it is preceded by an export.

### Advisory panels can be dismissed — with memory

Panels like "open holdings with no current price" are computed from your data,
so they cannot simply be closed while the situation persists. Dismissing one now
hides it **for that exact situation**: any real change — a new unmarked holding,
one resolved — brings it back. Nothing stays hidden while the facts move.

### Import correctness

- **The reported "no cost on record" bug ran to ground.** The parser handles the
  Dhan Global Transaction Report correctly (verified against the real file —
  every position pairs and closes as it should). The real fault: the duplicate
  check keys on prices and dates, which a P&L export states differently or not
  at all — so the *same trade* arriving from two file kinds inserted twice,
  producing a costless duplicate holding, "open" positions that were closed, and
  what looked like bad merges. The import preview now detects rows that look
  like trades already recorded from a different file kind and says so before
  commit — naming the earlier file. Nothing is merged automatically, because
  merging means choosing whose numbers to keep, and getting that wrong silently
  corrupts cost basis and holding period.
- **"No mark price" reworded.** It read as "no buy price". The panel now says
  what it means: a **current price to value the holding at today** — a separate
  fact from the purchase price, which these holdings may well have.

### My Default Settings

The first configuration you run with is kept as your baseline, automatically.
Change anything freely; **Restore my defaults** brings back preferences and the
charge/margin/risk rate tables in one transaction, with a diff of what would
change shown before you confirm. **Save current as my default** replaces the
baseline explicitly. A restore returns *choices*, never state: your licence,
trial, accounting and account selection survive untouched, byte-for-byte, by
construction — those fields are not in the snapshot at all.

### Notes

Migrations `0037_panel-dismissals.sql`, `0038_settings-baseline.sql`.
**1,147 unit/integration tests** pass with typecheck, lint and the production
bundle.

## v2.99.0 — Vyuha runs on a Mac, and the seller journal grows up

Three upgrades and two real bugs, one of which was found by the macOS support
this release adds.

### Vyuha builds and runs on macOS

The project had been Windows-shaped in the places that decide whether it runs at
all, so this fixes those rather than bolting a runner onto the side.

- **Bundle targets** went from a hardcoded `nsis` to per-platform, and the macOS
  bundle metadata that was entirely absent — category, copyright, descriptions,
  minimum system version — now exists.
- **The bundled Node had no execute bit on macOS or Linux.** `copyFileSync` does
  not carry the source mode across on every platform, and a sidecar without `+x`
  fails at spawn with a bare `EACCES` — after the installer has been built,
  signed and published.
- **Two Mac builds, not one universal binary.** The app ships a Node runtime
  copied from the machine that built it, so a universal bundle would carry an
  arm64 Node that dies on startup on every Intel Mac, in a way no check would
  notice. Take the build matching your Mac.
- **Releases now build on three platforms** — Windows x64, macOS Apple silicon,
  macOS Intel — and one platform failing no longer removes the others from the
  draft.
- **CI runs the full Playwright suite on a real Mac**, plus a job that proves the
  desktop bundle assembles there and that its sidecar is present, native and
  executable.

> **macOS Gatekeeper:** these builds are not yet notarised with an Apple
> Developer ID, so the first launch reports that the developer cannot be
> verified. Right-click the app → Open → Open, once.

### Option-seller journal, round two

The existing report was the scoreboard — how much premium was kept. These are the
questions a seller actually changes behaviour over:

- **Where the edge is, by days to expiry.** Expiry zone, expiry week, fortnight,
  monthly and far are different businesses on the same underlying.
- **Does hedging pay?** Hedged vs unhedged expectancy, reported as a *gap between
  two observed populations* and never as "hedging cost you ₹X" — you chose which
  trades to hedge, so the two groups are not a controlled comparison. That caveat
  ships inside the result rather than as UI decoration.
- **Did rolling help?** Adjustment chains compared against what the first leg
  alone actually booked — a result that was genuinely available, not a model of
  what the underlying did next. It surfaces the number worth knowing: how many
  chains turned a first-leg profit into an overall loss.
- **Rich IV or cheap IV**, ranked within this journal's own recorded entry IVs
  for that underlying, because there is no IV feed. Fewer than eight observations
  and it says so instead of ranking against three numbers.
- **Premium kept per day of risk**, as a median — one expiry-day scalp distorts
  an average badly.

Every grouped finding carries its sample size and stops calling itself
trustworthy below fifteen trades. Undated trades, unrecorded DTE and open
positions are excluded rather than guessed.

### Licence: time is now monotonic

The trial and any annual key were both evaluated against the system clock, and an
offline app cannot ask anyone what day it is. Winding the clock back renewed a
14-day trial and revived a lapsed key, silently and repeatedly.

The install now remembers the latest date it has ever seen and reasons about
`max(clock, mark)`. It is a **ratchet, not a lock**: forward jumps are always
honoured, a two-day tolerance absorbs timezone changes, DST and NTP corrections,
**nothing is ever expired early**, and a corrupt mark is ignored rather than
locking anyone out. A genuinely wrong clock costs a user nothing.

### Two bugs

- **Two e2e failures that were real, not flaky.** `staged-position` had reddened
  CI for six consecutive releases: the panel fetches its ladder after mount, so
  the test's `enable.count()` ran during the loading window, returned 0, skipped
  the click silently, then waited twenty seconds for a ladder that was never
  created — surfacing as a failure that pointed at the panel instead of the
  skipped click. The backup spec compared a page count against a whole-database
  dump, which are different populations.
- **`SQLITE_BUSY` during `next build`.** Page data is collected by several worker
  processes, each opening the same SQLite file and racing to set `journal_mode`.
  Raising `busy_timeout` did **not** fix it — changing the journal mode takes a
  brief exclusive lock and returns busy immediately rather than waiting. The
  database is now created before the build, and the pragma is tolerated failing
  since WAL is a property of the file, not the connection.

### Notes

Migration `0036_clock-high-water-mark.sql`. **1,062 unit/integration tests and 19
Playwright flows** pass on Linux and macOS, with typecheck, lint and the
production bundle.

## v2.98.0 — the safety net proven, and the last mile of the tax stack

v2.97 shipped seven subsystems in one release. The two that can lose data silently — the
backup and multi-account isolation — carried almost no tests between them. This release
does not add features; it makes the existing ones provable, and fixes what writing the
proofs uncovered.

### Backup and restore

- **A latent data-loss path in restore is closed.** `dumpDatabase(false)` still emitted
  `attachments: []`, and restore guarded on the field's *presence* rather than its length —
  an empty array is truthy. Restoring an attachments-excluded backup therefore deleted every
  screenshot on disk while restoring the `trade_attachments` rows that pointed at them.
  Attachments are now replaced only when the backup actually carries some. A backup exported
  without them says nothing about which files should exist, and the asymmetry of guessing
  wrong is total: an orphaned file is invisible and reclaimable, a deleted screenshot is gone.
- **Restore is now ordered so any failure leaves the journal intact.** Incoming attachment
  bytes are decoded and staged to a sibling directory *before* the database transaction runs;
  the table swap is one transaction; the staged directory is swapped in only after that
  commits. A malformed payload or a bad row now returns "your journal is unchanged" instead
  of throwing partway through.
- **The backup KDF was strengthened.** scrypt ran at node's default cost (N=16384) — light
  for a key protecting an entire trading history in an offline file an attacker can grind at
  leisure. New backups use OWASP's baseline (N=2^17) and, more importantly, **record the
  parameters in the envelope**, so the cost can be raised again without stranding files
  already on disk. Backups written before this release still open.
- **19 round-trip tests** now cover what `backup-format` never did: dump → wipe → restore
  reproducing every table, money surviving as integer paise, attachment bytes returning,
  encrypt → decrypt → restore, wrong passwords, tampered ciphertext (GCM), and v1 envelopes.

### Multi-account

- **Single-account installs no longer sit in the aggregate view.** Migration 0034 defaulted
  `selected_account_id` to 0 ("All accounts") while trades defaulted to account 1, so every
  install landed in an aggregate view of exactly one account — which is what made writes
  ambiguous in the first place. Migration `0035` selects the sole account, and
  `getSelectedAccountId()` resolves a stored 0 the same way, covering fresh installs and
  users who delete a second account back down to one.
- **Writes from the aggregate view now ask which account.** With 2+ accounts, the add-trade
  form and the importer show an account picker instead of silently filing everything under
  Primary. The importer asks before the preview, because dedup is per (account, broker) and a
  preview run against the wrong account reports the wrong duplicate count. An explicit account
  id is validated against the accounts table, so a stale tab cannot redirect a write.
- **14 isolation tests**, including a **schema registry test** that reads `account_id` columns
  out of SQLite itself and fails the moment a new table gains one — catching the next table,
  not just today's eight.

### ITR schedule-format export

The ITR pack already computed the head-wise split, Guidance-Note turnover and the 44AB read.
What it could not do was answer the question a CA actually asks: *which box does this go in?*

- **Schedule CG** — A3 for STCG u/s 111A and B4 for LTCG u/s 112A, in the return's own item
  codes, with consideration and cost reported **separately** (a net gain loses exactly the two
  figures the schedule asks for) and the ₹1.25L / ₹1L deduction applied per the sell-date regime.
- **Schedule BP** for both business heads, **Schedule CFL** with each loss vintage and the year
  it lapses — sourced from the same set-off engine the Tax Summary uses, so the two pages cannot
  drift apart.
- **It says which form the book implies:** ITR-2 for a capital-gains-only year, ITR-3 the moment
  any intraday or F&O appears.
- **The STT rule is applied per head, which a re-label would get wrong.** STT is excluded from
  capital-gains deductions (proviso to S.48) but allowed in full as a business expense against
  intraday and F&O. Every other figure in Vyuha is net of STT, so the Schedule CG balance is
  deliberately *higher* than the net P&L shown elsewhere. The charge breakdown is stored per
  trade, so the split is a fact here rather than an estimate.
- Amounts the app cannot derive are emitted as **blank, never 0** — "not applicable" and "zero"
  are different answers on a tax return.

### The v2.97 features are now actually tested

- **The four thin modules went from 5 tests to 71.** Options-seller, scaling quality, session
  review and data quality shipped as headline features with one or two tests between them.
- **Five new Playwright flows** cover the surfaces no e2e had ever touched: the Data Quality
  Center, session plan → review, account switching and isolation, the backup export → restore
  round trip through the real UI, and an encrypted backup refusing the wrong password.

### Notes

Isolation was found to be *correctly implemented* across all eight account-scoped tables;
these tests lock that in rather than fix it. Foundation: migration
`0035_default-account-selection.sql`; **1,019 unit/integration tests and 19 Playwright flows**
pass, with typecheck, lint and the production bundle.

## v2.97.0 — trust, workflow, and portfolio intelligence

Seven coordinated upgrades turn Vyuha from a journal with deep analytics into a safer daily
operating system for traders:

- **Complete, encrypted backup and restore.** Versioned full-database exports now include every
  user table and screenshot attachment, support AES-256-GCM password protection, and show a
  restore preview before anything is replaced.
- **Data Quality Center.** One confidence score surfaces missing cost basis, marks, stops,
  MTF funding, option metadata, instrument-master coverage, IPO links, and missing attachment
  files, with direct remediation routes.
- **Session planner and review.** Pre-market watchlist, playbook, cutoff, trade-count and loss
  budgets flow into a deterministic post-market adherence review.
- **Versioned rule packs.** SEBI derivatives rules and broker-rate assumptions carry effective
  dates, source URLs, review dates, versions, and an audit trail; the compliance radar reads the
  active pack rather than hard-coded display copy.
- **Scaling Quality + Trade Replay.** Staged positions are compared with a clearly labelled
  first-entry-only counterfactual and replayed over local EOD price history.
- **Options Seller Journal.** Entry/exit IV, DTE, hedge status, expiry outcome, and adjustment
  groups sit beside premium-capture and outcome summaries.
- **Multi-account portfolios.** Trades, ledgers, imports, broker connections, capital snapshots,
  IPOs, and quality/workflow reports are account-aware, with a sidebar switcher and an honest
  aggregate “All accounts” read view.

Foundation: migration `0034_vyuha-297-foundation.sql`; **892 unit/integration tests and 14
Playwright flows** pass, together with typecheck, lint, and the production bundle.

All notable changes to Vyuha are tracked here. Versions are kept in sync across
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the sidebar
footer via `npm run bump-version <version>`.

## v2.96.0 — free plan vs paid plan, side by side (and rate cards that finally reach you)

### Kotak Neo, Paytm Money and Sahi

Rate cards sourced from each broker's own pricing page and cited in
`lib/db/seed-data.ts`, so a future reader can check them against the source.

| | Delivery | Intraday | F&O | MTF interest |
|---|---|---|---|---|
| **Kotak Neo** | 0.20%, uncapped | ₹10 or 0.05%, lower | ₹10 flat | 9.69% (Pro plan only) |
| **Paytm Money** | 2.5% or ₹20, lower | 0.05% or ₹20, lower | ₹20 | tiered 7.99 / 9.99 / 8.99% |
| **Sahi** | ₹10 or 0.05%, lower | ₹10 or 0.05%, lower | ₹10 flat | **not published** |

Four things that would have been wrong if assumed:

- **Kotak's delivery is 0.20% with NO cap.** On a large delivery book that is
  the difference between ₹94k and ₹1.73k lakh of charges — it is a percentage
  broker, not a discount one, and the comparison now says so plainly.
- **Sahi's delivery is not free**, unlike almost every other discount broker.
- **Paytm's MTF tiers are not monotonic** — the middle band (9.99%) is dearer
  than the top one (8.99%). Code that assumed sorted tiers would misprice every
  mid-size book.
- **Paytm's MTF brokerage is a FLOOR, not a cap** — "0.1% or current brokerage,
  whichever is higher" — so capping it at ₹20 would understate it badly.

### Percentage DP charges

Kotak Neo bills DP as **0.04% of the sale with a ₹20 minimum**, which the
flat-fee model could not express. `dpPct` now exists: when set, the flat
`dpCharge` becomes the FLOOR rather than the whole fee. Every other broker
leaves it at zero, so their arithmetic is byte-identical to before.

### "Unpriced" no longer reads as free

**"Unpriced" means that broker has no rate row for those trades' segment and
exchange** — it could not price them at all. Angel One and Upstox showed
`₹0` and a green `−₹94,133`, which reads as the biggest saving in the table
when it actually means *no answer*. Now:

- A broker that priced **nothing** shows "no rates configured — nothing to
  compare" instead of zeros.
- A broker with **partial** coverage shows its total marked `*` and `n/a`
  against recorded, because a partial total is the cost of a smaller book: it
  is always lower, and always flatters.
- **Only a broker that priced every trade can be called cheapest.** Ranking on
  a partial total would put a broker that priced three trades above one that
  priced three hundred, purely for doing less work.

### Sahi's unknown MTF rate

Sahi names margin funding as a revenue source but publishes no rate. Neither
obvious option was honest: seeding 0% advertises free funding in the very
report meant to compare costs, and omitting the row makes `findRates` throw the
moment such a trade is imported. So `mtfRateUnknown` states it as a fact — the
row exists with every other charge real, and an MTF trade priced against Sahi
counts as unpriced rather than as free.

### Verified

A 60-assertion forensic sweep across **every broker × every segment**: no
negative components, components summing to the stated total, brokerage
respecting each cap and floor, statutory rates identical across all eight
brokers (they are the law, not a broker's choice), and each broker's published
numbers pinned individually. Hand-checked against arithmetic: a ₹5,00,000
Kotak delivery round trip gives brokerage ₹2,000, STT ₹1,000, stamp ₹75, DP
₹200 — each matching its formula exactly.

873 unit tests total.

### Free and paid plans are now separate offers

Most traders are on no plan at all. Vyuha was pricing every broker as though
everyone subscribed — Kotak Neo's 9.69% MTF and cheaper delivery come with
**Trade Free Pro at ₹249/month**, and the free tier gets neither. Quoting the
subscriber rate to a non-subscriber recommends a discount they will not receive.

`charge_config` now carries a **plan** (`default` is the free tier every broker
has), so a paid tier is stored as its own complete rate card beside the free
one, and both appear as their own rows in Broker Costs:

| | Delivery | MTF interest | Fee |
|---|---|---|---|
| Kotak Neo — free | 0.20% | **not published** | — |
| Kotak Neo — Trade Free Pro | 0.10% | 9.69% | ₹249/month |

**The subscription is in the total, not a footnote.** It is amortised over the
months the compared trades actually span, because a paid plan judged on
brokerage alone always looks cheaper than it is — which is precisely the
mistake this report exists to prevent. On a large book Pro wins even after its
fee; on a small one the fee costs more than it saves, and the table now says so.

Angel One, Upstox, Dhan, Zerodha, Groww, Paytm Money and Sahi each run a single
flat structure and sell no tier. Inventing one for them would be a claim about
their pricing, not a gap in ours.

### Three rate cards were wrong

Checked against each broker's live pricing page:

- **Angel One delivery is FREE**, not "₹20 or 0.1%". It had been overcharged
  on every delivery trade in the comparison.
- **Angel One MTF is 18%** a year, not 14.25%.
- **Upstox MTF is 18.25%** (₹20/day per ₹40,000 slab), not 14.95%.

The two MTF figures had been unsourced estimates, and both were understated by
about a quarter — the direction that makes margin funding look cheaper.

### New rate cards never reached an installed copy — the real bug

Migrations ran on every launch, but **seeding ran once**, when the database file
was first created. So every broker added and every rate corrected after a user's
first launch stayed on the developer's machine. Kotak Neo, Paytm Money and Sahi
would have shipped and still shown as *unpriced* on your install; the Angel One
and Upstox corrections above would never have arrived.

Rate cards are now refreshed on every launch — and a row **you** edited is
pinned by `user_edited` and never overwritten, because your figure came from
your own contract note and outranks ours.

### Also fixed

- The **trade calculator's broker list was hard-coded to three brokers** —
  Angel One, Upstox, Kotak Neo, Paytm Money and Sahi were invisible there. It
  is now driven by the rate cards themselves, so it cannot go stale again. When
  the selected broker sells a paid tier, a plan picker appears beside it.
- A legacy unique index on `(broker, segment, exchange)` survived the plan
  migration and silently swallowed every paid-plan row inserted against it.
- Margin defaults existed for only five brokers; the three new ones fell through
  to a global default without saying so.

885 unit tests.


## v2.95.0
**An IPO allotment is no longer a dead holding.**

Shares from an IPO are credited on allotment — they never appear as a buy in
any tradebook. So the position lands in the journal missing **both** facts that
make a holding mean anything:

- **no cost basis** — nothing says what you paid, so it cannot join win rate,
  expectancy or Return on Margin
- **no mark price** — nothing says what it is worth, so it has no unrealised
  result and appears in neither "in gain" nor "in loss"

It just sat there, contributing to nothing.

### The route out

Trades now surfaces **open holdings with no mark price**, says plainly what
that costs you, and — when the holding has no cost either, which is the
signature of an allotment — offers **"This came from an IPO"**.

That creates a linked IPO record seeded from the holding: symbol, quantity,
exchange and date carried across. The **issue price is deliberately left
blank**, because that is precisely the fact the journal is missing and the one
thing only you know. Nothing is guessed.

### The IPO record becomes the source of truth

Once linked, saving the IPO writes back to the holding:

- the **issue price minus any category discount** becomes the cost basis
- the **listing price** becomes the mark — or the **exit price** if you have
  sold, which also closes the position and books the realised P&L
- the **allotment date** becomes the acquisition date, which starts the tax
  holding period

Verified end to end: 37 shares at ₹500 issue, listed at ₹598 → basis ₹18,500,
mark ₹598, unrealised **₹3,626**. Then an exit at ₹640 → closed, sold ₹23,680,
gross **₹5,180**, mark cleared, unrealised back to zero.

Keeping the two numbers in **one** place is the point. A second copy on the
trade would drift, and you would have no way to tell which was right.

### What it still refuses to do

- With no listing price and no exit, the holding stays **honestly unmarked**.
  The basis is supplied — so it rejoins the edge statistics — but no mark is
  invented, and it keeps appearing under **Open** rather than being sorted into
  a gain or loss it never had.
- An application that was **not allotted** produces no holding at all. A patch
  is refused rather than creating a position from shares that never arrived.
- Flagging a holding as an IPO does **not** by itself price it. Until an issue
  price is entered it stays out of win rate and expectancy, because it still
  has no basis.

19 new unit tests (813 total) and 1 new e2e flow (14 total).

## v2.94.0
**See exactly the trades you mean**, and a repo that no longer mixes the
vendor's files with the buyer's.

### Status and outcome, in one control

The Trades filter bar gains a dropdown covering both questions at once:

- **Status** — Open · Closed · Staged (scaled) positions
- **Outcome** — In gain (open) · In loss (open) · Profit (closed) · Loss (closed)

Every option carries its **own live count**, computed after the other filters,
so an empty view is visible before it is chosen. The counts are a partition:
open + closed always equals the total, and an e2e test asserts that choosing an
option returns exactly the number it advertised — a filter whose label disagrees
with its result is worse than no filter.

**An open position with no mark price appears in neither "in gain" nor "in
loss".** It has no unrealised result to judge. Vyuha stores 0 for an unmarked
holding, and reading that 0 as breakeven would file it under a result it never
had — so those positions stay under the *status* views, and the count of them is
stated on screen rather than left as a silent shortfall.

Staged is deliberately **not exclusive**: a staged position is also open or
closed, so "show me my staged trades" and "show me what is open" never fight.

### The repository now separates owner from client

```
docs/client/   what a BUYER gets — install guide, getting-started deck, welcome
docs/owner/    VENDOR ONLY — licensing, release runbook, monetization, indicators
docs/sales/    public marketing assets (landing page, brochure)
```

Two new indexes: `docs/owner/README.md` is the operating manual for cutting a
release and selling a key — including which three secrets exist, where they
live, and precisely what each one costs if lost. `docs/client/README.md` is the
buyer's first page, including which broker file to import and why Vyuha asks
about MTF at all.

Also removed: a stale `updater-private.key.pub` at the repo root, left over from
the dead pre-v2.91 signing key. It matched nothing that ships and could only
mislead. The current public key now sits in `docs/owner/` beside the runbook.

The README gained a **repo map**, and states the rule that keeps the maths
honest: `lib/analytics/*` and `lib/engine/*` import neither the database nor
React, which is why every number can be tested without a browser.

18 new unit tests (794 total) and 3 new e2e flows (13 total).

## v2.92.0
**The staged-position panel no longer blocks you.**

"Add entry" was disabled once a position went flat, on the reasoning that you
cannot add to something that no longer exists. That reasoning was wrong twice
over:

- **Re-entering the same name, or correcting a fill booked in error, are
  ordinary things a trader does.** A journal that refuses to record what
  actually happened is worse than one that records it with a caveat.
- **The engine already allowed it.** `validateLegs` only ever rejects an exit
  larger than the quantity open at that point, and `rebuildStagedTrade`
  re-derives `isOpen` from the ladder — so a new entry re-opens the trade by
  itself. The block was a UI opinion with nothing behind it.

All three actions — Add entry, Book exit, Set stop on all open — are now always
clickable. In their place:

- A line under the buttons says what each will do **from the current state**:
  that Add entry re-opens a flat position and keeps the realised P&L, and that
  Book exit has nothing to sell against until an entry exists.
- The Add-entry dialog carries an explicit **"this re-opens the position"**
  notice when the position is flat, with what happens to the P&L already booked.
- An e2e test now asserts that **no action is ever disabled by position state**,
  so this cannot quietly return.

The principle, written down so it stops being re-litigated: **Vyuha warns; the
user decides.** Guards that remain are only for work in flight (a pending
submit) or genuinely empty input — never for a state the app disapproves of.

## v2.91.0
**MTF, answered properly** — and the updater signing that has been quietly
broken since v2.84.

### Dhan API — the only source that STATES margin funding

Every Dhan *file* is silent about MTF. A P&L export has no product column; a
transaction report has one implicitly in the charge rates, but MTF and delivery
carry identical STT and stamp duty while financing interest is booked to the
ledger. From files alone, "was this MTF?" is unanswerable.

`GET /v2/positions` answers it: `productType` is an enum of CNC, INTRADAY,
MARGIN, **MTF**, CO and BO. Stated by the broker, not inferred from charges, so
those rows need no confirmation dialog at all.

- Connect under **Import → Connect broker**, now a two-broker card. Dhan wants a
  **Client ID** plus a 24-hour access token from web.dhan.co → DhanHQ Trading
  APIs; Zerodha is unchanged.
- Pulls today's positions through the same classify → charges → dedup pipeline
  as every file, so re-pulls stay idempotent.
- `MARGIN` deliberately maps to *no* hint: it is the F&O carry-forward product,
  and the classifier already reads the segment off the symbol.
- Positions carry aggregates, not fills, so execution times stay null rather
  than inventing a session.

### Dhan ledger import — real MTF interest instead of an estimate

Dhan calculates MTF interest daily and posts it **weekly to the ledger**. Until
now Vyuha estimated it from the funded amount and a day count. **Cash & Ledger**
now imports the ledger and reads the real figure.

- The card shows **actual vs estimated side by side**, with the gap in rupees
  and percent. Deliberately a *comparison, not a correction*: ledger interest is
  a weekly account-level posting, and splitting it back across positions would
  invent a per-trade allocation the broker never stated.
- Columns are found by **header keyword, not position**, so a reordered export
  still parses.
- MTF is matched **first and on its own**, because a generic "charges" rule
  would otherwise swallow "MTF charges".
- Opening/closing balance rows are recognised as **assertions, not entries**, so
  the opening capital is never counted as a deposit.
- Anything the classifier cannot read is **listed for review**, never filed
  under a guess. A ledger importer that silently mislabels a debit is worse than
  one that admits it is unsure.

### Fixed: releases have been unsigned since v2.84

`tauri.conf.json` ships a public key and `createUpdaterArtifacts: true`, so every
install trusts updates signed with the matching private key. That key was never
on this machine. Tauri does not fail without it — it prints a notice at the end
of a multi-minute build and emits no `.sig`. Seven releases went out looking
complete with auto-update silently dead; the last signature was **v2.82**.

- A signing keypair now lives in `.secrets/` (gitignored) and the build picks it
  up automatically.
- `tauri build` is launched by a wrapper so the key reaches the right process —
  the three `&&`-chained steps do not share an environment.
- The build now **refuses to start** without a key, and **fails after** if the
  installer has no `.sig`. Deliberate unsigned builds need
  `VYUHA_ALLOW_UNSIGNED=1`.
- **The public key changed**, because the original private key is unrecoverable.
  Installs at v2.82 or earlier will not accept these updates and must be
  reinstalled once from the release page. Everything since v2.84 was unsigned
  anyway, so nothing that previously worked is lost.

41 new unit tests (776 total).

## v2.90.1 — CRITICAL: v2.90.0 installer does not run on any machine but the build machine

**Do not distribute v2.90.0.** It starts, fails to load the database engine, and
shows a bare "Internal Server Error".

### What happened

Next 16 stages every `serverExternalPackages` entry as a **symlink** under
`.next/node_modules/<pkg>-<hash>`, pointing at an **absolute path inside the
developer's checkout**:

```
better-sqlite3-90e2652d1716b047 -> T:\…yuha
ode_modulesetter-sqlite3
pdf-parse-08f4573089f02674      -> T:\…yuha
ode_modules\pdf-parse
```

The compiled server requires those packages *by the hashed name*. The desktop
bundler copied the links verbatim, so the installer shipped two 69-byte
pointers to a directory that exists on exactly one computer in the world. On
any other machine the first database call fails with:

```
Cannot find module 'better-sqlite3-90e2652d1716b047'
```

and because the failure happens during render, Next then tries to draw its
global error page — which needs the same missing module — so the user sees
plain "Internal Server Error" with no clue as to the cause.

### Why it slipped through

Two reasons, both now closed:

1. **It works perfectly on the build machine.** The symlink target is real
   there, so every local check — 735 unit tests, 10 e2e flows, a full route
   sweep, a manual browse of the running app — passed against a bundle that
   could never work anywhere else.
2. **The only outward symptom was the installer getting SMALLER.** 32.25 MB at
   v2.89.0 → 28.27 MB at v2.90.0, because two real packages became two links.
   A shrinking installer reads like a successful optimisation, not a defect.

### The fix

- Symlinks are now **materialised into real directories** during bundling.
  `fs.cpSync(..., { dereference: true })` alone is not enough on Windows, where
  these are directory junctions that get copied as links regardless, so each one
  is explicitly replaced with its target's contents.
- A **portability guard** now runs before any installer is produced and **fails
  the build** if the bundle contains a symlink, an empty external package, or a
  missing `better-sqlite3` native binding. A build that would only run on the
  build machine can no longer reach a customer.

v2.90.1 is byte-for-byte v2.90.0 plus this fix. Installer is back to 32.25 MB,
exactly on the size trend from v2.80 onward.

## v2.90.0
**Dhan's Global Transaction Report** — the file that finally answers the three
questions an aggregated P&L cannot: *when* did I trade this, *what product* was
it, and *what did it actually cost*.

### A new importer, and why it matters more than "one more broker file"

Dhan's P&L export has no per-trade dates and no product column. That is why a
book built from it sat almost entirely outside the equity curve and every
risk-adjusted metric. The Global Transaction Report has one row per scrip per
settlement bill, with a real date, and the broker's own charges on every row.

- **Delivery and intraday are told apart from the charges themselves.** India
  levies statutory charges at different rates per product, so the rate is a
  fingerprint: stamp duty **0.015%** on a delivery buy against **0.003%**
  intraday, corroborated independently by STT at **0.1%** on both legs versus
  **0.025%** on the sell alone. Two witnesses, agreeing on 89 of 92 rows of a
  real report. Below ₹5,000 the per-rupee rounding swamps the signal, so those
  rows return *unknown* rather than a reading of an artefact.
- **MTF is still never claimed.** An MTF position carries exactly the same STT
  and stamp duty as delivery; the only thing separating them is financing
  interest, which is a ledger entry and appears nowhere in this file. Verified
  rather than assumed: `Oth. Charges` totalled **₹0.03** across 92 rows and GST
  was 18% of (brokerage + txn + SEBI) to within **₹0.01**, leaving no
  unexplained rupee for financing to hide in. The confirmation panel therefore
  narrows from every scrip to just the **delivery** rows — intraday and F&O can
  never be MTF, so asking about them was noise.
- **Bills that mix both products are split algebraically.** Buy 3,600, square
  1,800 the same day and carry the rest, and the stamp duty lands between the
  two rates. Since stamp is linear in value, the split has exactly one
  solution. Labelled as *derived*, because it is arithmetic on a total rather
  than a stated fact.
- **Legs are paired FIFO across dates into positions.** Bought the 6th, sold
  the 7th is one trade held one day — not a phantom open position and a phantom
  naked short. FIFO matches how the Income Tax Act treats equity delivery, so
  the holding periods agree with the ones that decide STCG versus LTCG. A
  conservation check asserts no share and no rupee is created or lost.
- **The broker's charges are stored as the truth**, with Vyuha's computed
  figures kept alongside as a cross-check. This is real money that really left
  the account; the engine cannot be more accurate about a charge than the charge
  itself, and storing an estimate that differs from the contract note would make
  the journal disagree with the broker.
- Execution times stay **null**. The date column reads `00:00:00` on every row —
  a settlement stamp, not a fill — and bucketing the whole book into a
  pre-open session would fabricate an edge.

### Sales with no purchase — the IPO allotment problem

Sell a holding acquired before the import window and the file contains the sale
and nothing else. In Indian retail this is most often an **IPO allotment**:
shares are credited on allotment and never appear as a buy anywhere.

With `buyValue = 0` the arithmetic still "works" — and every number it produces
is false and flattering. A book of IPO flips would show a 100% win rate and an
infinite Return on Margin.

- These trades are now **flagged, and counted in cash but held out of every edge
  statistic** — win rate, expectancy, profit factor, ROM — until a cost is set.
  The sale and its charges were always real and remain in Net P&L.
- **Vyuha recovers the missing cost from the file's own footer.** The rows omit
  the purchase, but the broker's stated gross P&L includes the trade, so
  subtracting everything that could be matched leaves exactly what it must have
  cost. On a real report: matched gross of −₹8,268.27 against a footer of
  −₹8,489.60 left −₹221.33 for one unmatched holding — 37 shares sold for
  ₹21,904, implying **₹597.98 a share**. Offered pre-filled for confirmation,
  never applied silently.
- Confirm the acquisition as **IPO allotment, bonus/split, transfer-in or an
  ordinary earlier purchase**, set the cost and date, and the trade rejoins the
  statistics. IPO P&L is reported in its own panel, apart from trading edge —
  a listing-day pop is not a repeatable skill and blending it into expectancy
  overstates how well you actually trade.

### Fixed

**A drill-down that did not reconcile.** The trades date filter used
`sellDate ?? buyDate` regardless of whether a position was open, while
`dailyPnl` skips open trades entirely. A holding that is open *and* carries a
sell date — a partial exit, or a sale with no recorded purchase — appeared in
the filtered rows but never in the figure that was clicked. Realised
drill-downs now restrict to closed trades, and the effective date is the exit
for a closed trade and the **entry** for an open one, which is what the code
already claimed in a comment.

64 new unit tests (735 total) and 2 new end-to-end flows (10 total), the new
ones asserted against a real 92-row broker report rather than synthetic data.

## v2.89.1 — forensic audit fixes

A full-book audit of every feature. Money identities were already exact
(gross − charges − net reconciled to 0.0000 across 252 trades, charge
components summed to the stored total to the paise, no float leak). Six
defects surfaced, all fixed.

**The equity curve disagreed with Net P&L by ₹1.47 lakh, silently.**
`dailyPnl` buckets on the exit date, so a closed trade without one belongs to
no day. An aggregated broker P&L statement (Dhan's) carries no per-trade dates
at all — the range lives in the file header only — so 116 of 243 closed trades
were invisible to the return series while the dashboard's Net P&L counted every
rupee. Performance reported **−2.84%** on a book that was down ~11.5%, with
CAGR, Sharpe, Sortino and max drawdown all computed on the dated quarter of it.
Both surfaces now state their coverage before showing a number: which trades
are included, how much P&L sits outside, and that a tradebook import closes the
gap. Nothing about the maths changed — the silence was the defect.

**F&O rows were offered an equity product choice that did nothing.** The P&L
confirmation panel listed every symbol, including options and futures. A
derivative names its own segment and `classify()` ignores the product hint
entirely, so those buttons were dead controls — and the panel keyed on the
display symbol while the server looked up the tradingsymbol, so the override
could silently miss. Only equity is listed now, keyed correctly, with the
derivative count stated rather than hidden.

**Two silent drops in Arjun's Eye**, both against the module's own documented
rule that nothing is discarded quietly. Weekday analysis built Mon–Fri only, so
a Saturday trade — NSE does run occasional Saturday live sessions — vanished
and the weekday counts stopped reconciling. And a timed trade outside
09:15–15:30 fell out of every session bucket with no trace, which is exactly
what a misread broker time column looks like. Both are now counted and
surfaced; three tests pin the reconciliation.

**The cost engine was underselling itself.** Reconciliation showed "total
charges −32.5%" in warning colour, which reads as a broken engine. Almost all
of that gap is brokerage, which genuinely cannot be derived from a
scrip-aggregated file. Excluding it, computed statutory charges match the
broker to **0.69% — ₹291 on ₹42,006**. That comparison is now shown.

Also fixed: literal control characters and a garbled sentence in
`lib/import/time-parse.ts`, and a race in a new e2e spec that read `innerText`
before the streamed page had rendered.

Verified end-to-end: a timestamped tradebook imported through the live pipeline
produced `09:20` from `2026-06-01T09:20:15` — the six-hour bug confirmed fixed
against real data, not only unit tests — with MIS/CNC classifying correctly and
the sessions bucketing as expected. 671 unit tests, 8 e2e flows, 38 routes with
no NaN, Infinity, or error boundary.

## v2.89.0
Two things traders asked for after using v2.88 in anger: **know what kind of
trade you imported**, and **know what kind of trader you are**.

### Import split — P&L vs Transactions

`/import` now presents two clearly-labelled kinds, because they are genuinely
not equivalent and the difference decides how much Vyuha can know:

- **Transactions / Tradebook** (recommended) — every execution, with product
  type and timestamps. Delivery, MTF and intraday identify themselves, scaled
  positions keep their entry ladder, and time-of-day analytics work.
- **P&L Statement** — a pre-aggregated summary with **no product column and no
  times**. "Was this delivery or MTF?" is genuinely unanswerable from the file.

So the P&L path now **asks once, before commit**. Rows are grouped by symbol
with a guess pre-selected, and choosing a different product **re-prices
immediately** — segment, charges, MTF interest and Return-on-Margin all derive
from it, so showing old numbers beside a new choice would be wrong at exactly
the moment you are deciding.

- Same-day round trips are **inferred** as intraday, which is reliable. MTF is
  never inferred — it is indistinguishable from delivery in a P&L file — so the
  default is **delivery**, the safest wrong answer: it neither invents MTF
  interest nor applies intraday leverage. Guessed rows are labelled "assumed".
- The file kind is **detected**, not taken on trust from the tab. Drop a
  tradebook on the P&L tab and it says so rather than asking for product types
  the file already knows.

### Execution times now actually reach the database

`entry_time` and `exit_time` existed since the first schema and **nothing ever
wrote them**. Tradebook parsers now extract HH:MM and commit persists it.

- Date and time are extracted **independently**, because the same broker column
  may hold a bare date, a full timestamp, or both split by `T`, a space, or
  nothing.
- Day-first is assumed for ambiguous dates, per Indian convention — reading
  `06-01-2026` as June 1st rather than 6th January would silently rewrite the
  P&L calendar by months.
- A wrong time is worse than none, so anything unparseable returns null rather
  than guessing.

### Arjun's Eye — the trader's cockpit (`/arjuns-eye`, Pro)

A new page under Journal. Performance keeps its risk-adjusted returns under
Analytics untouched — the two answer different questions: *how good are my
returns* versus *what kind of trader am I*.

- **When you actually make money** — expectancy by Indian session (opening
  drive, morning trend, midday chop, afternoon push, closing hour) and by
  weekday.
- **Which products are worth your capital** — expectancy, win rate, charge drag
  and average hold per segment.
- **Do you cut winners and hold losers?** — average hold of winners vs losers
  and the ratio between them, the most common structural leak in retail.
- **Does a loss change how you trade?** — expectancy after a win vs after a
  loss, streaks, and same-day re-entries after a loser.
- **Is your conviction rewarded?** — expectancy by position-size quartile.

Three honesty rules are enforced in code, not just intended:

1. **No finding below 15 trades** in a group. Thin groups are shown, labelled
   *thin*, and excluded from the conclusions — "Tuesdays are your best day"
   from four trades is noise dressed as insight.
2. **No invented sessions.** Trades without a time are counted as a coverage
   gap and the section says a tradebook import is needed. Bucketing them into
   09:15 would fabricate an edge that never existed.
3. **Descriptive, never prescriptive.** A test asserts no finding contains
   "you should", "must" or "stop doing".

### Fixed while building this

A regex bug that would have misattributed **every timestamped trade by six
hours**: the regex word-boundary anchor does not match between `01` and `T` in `2026-06-01T09:15:32`
(both are word characters), so the date-strip silently failed and the time
regex read `15:32` out of the middle of the date. Caught by a test written
before the code was trusted.

56 new unit tests (668 total) and 3 new end-to-end flows (7 total).

## v2.88.0
**Return on Margin** — the metric that answers what your capital actually
earned, not what your turnover did.

- **New Pro report at `/reports/rom`.** Every Indian F&O journal reports P&L
  against turnover or notional, and both are close to meaningless: a long option
  and a short strangle can carry identical notional while tying up wildly
  different capital. ROM measures against **capital actually blocked**.
- **The denominator is instrument-aware**, because the market is:
  **long options** cost the premium and block no SPAN margin; **short options**
  block margin against the *underlying* notional (which is why a ₹10,000 credit
  can tie up ₹1.5 lakh); **futures and intraday** block a percentage of contract
  value; **MTF** blocks only your own capital; **delivery** blocks the lot.
  The rule was extracted out of the live margin cockpit into a shared
  `capitalBlocked()` so the two views can never drift apart.
- **Three time framings, each for a reason.** Raw ROM is unambiguous but treats
  a one-day and a thirty-day 2% identically. ROM/day fixes that, weighted by
  **capital-days** — ₹1L held ten days is ten times the commitment of ₹1L held
  one, and a naive average would say otherwise. Annualisation appears only in
  the rollups, never per trade.
- **Annualised figures are clamped, and say so.** A book of one-day option
  trades losing 10%/day extrapolates to −3,887% — arithmetically correct and
  impossible, since you cannot lose more than your capital. The display floors
  at −100% and caps at +1,000%, marks clamped values with `*`, and keeps the
  uncapped number in the CSV/XLSX export.
- Groups by segment and by playbook, flags segments where no margin rate is
  configured (which *understates* ROM), and skips trades whose capital cannot be
  established rather than reporting an infinite return.

**KPI drill-downs now go somewhere.** The Net P&L popup's best/worst-day rows
deep-link to `/trades` filtered to that date, and a footer links to the full
journal. `/trades` gained `?symbol=`, `?from=`, `?to=` and `?segment=` support.

- The date filter matches a trade's **effective date** — exit for a closed
  trade, entry for an open one — deliberately mirroring how `dailyPnl` buckets
  realised P&L. An earlier version matched *either* leg and pulled in positions
  opened that day but closed later, so the filtered rows did not add up to the
  figure that had just been clicked. They now reconcile exactly, and an e2e test
  asserts the sum.

**End-to-end coverage went from one flow to four**: import, staged positions
(enable → add tranche → partial exit), the ROM report, and the drill-down
reconciliation. A new dated Zerodha tradebook fixture also puts a second
importer under e2e — the Dhan fixture is an aggregated P&L report with no
per-trade dates, so it can never produce a daily P&L to drill into.

- Fixed a latent race in the existing import spec while doing this: handing a
  file to a not-yet-hydrated page silently drops it, and the failure presents as
  "broker not detected", which sends you hunting in the parser.

**Indicator (SA-PRO v2.1.0)** — beta thresholds now span 0.05–3.0 on *both*
inputs. The previous build capped Low at 1.0 and floored High at 1.0, which
structurally forced "Normal" to straddle 1.0 and made the band unusable against
a peer benchmark where the whole universe can sit below it. An inverted band is
now ordered defensively rather than mislabelling every stock.

36 new unit tests (612 total), plus 3 new end-to-end flows.

## v2.87.0
**The first paid build.** No new features — this is the release that turns the
licence gate on.

- **`LICENSE_ENFORCEMENT` → `"block"`.** When a 14-day trial ends without a key,
  the four Pro screens (Portfolio Risk, Tax Summary, ITR Pack, Broker Compare)
  render the upsell panel instead of their content. The **core journal is still
  never gated** — trades, imports, dashboard, playbooks and backups keep working
  forever, and your data never leaves the machine either way.
- **`WHATSAPP_NUMBER` set**, so `BUY_URL` now opens WhatsApp with a pre-filled
  message. Every in-app upsell and all eight landing-page buy buttons derive
  from that one constant.
- Verified by simulating an expired unlicensed install against a snapshot of a
  real settings row: `/risk`, `/reports/tax` and `/reports/itr` all render the
  upsell with the correct `wa.me` link and no Pro content, while `/trades` is
  untouched. Snapshot restored and confirmed byte-identical afterwards.

Superseded **v2.86.0**, which was tagged *before* the enforcement flip and
therefore still shipped ungated with the fallback buy link. Publish this one
instead.

## v2.86.0
Vendor control over licence keys, and the sales assets to actually sell with.
No changes to the journal itself — this release is about the business around it.

- **Your sales ledger.** Keys were *signed, not registered* — nothing in the
  system knew a key existed, so there was no way to answer "did this person
  actually buy?". `license-issue.mjs` now records every key it mints to
  `license-ledger.jsonl` (gitignored, contains buyer emails).
  `license-list.mjs` reads it back: filter by buyer or key, and
  `--expiring 30` produces your renewal outreach list.
- **Key IDs.** Every key now carries a short derived ID (`A1B2-C3D4-E5`,
  `sha256(key)` truncated) shown in **Settings → License**. Support threads
  quote the ID instead of pasting the key — which is a credential that ends up
  in screenshots.
- **Revocation.** `license-revoke.mjs <KEY-ID> "reason"` stops a refunded or
  leaked key activating. Documented honestly: this is a *build-time* list in an
  offline app, so it reaches new installs only and is not a kill switch. A real
  one would mean phoning home on launch, which this product promises never to
  do. Revocation is checked *before* the signature, because a revoked key is
  still cryptographically perfect.
- **Machine-bound keys — opt-in per sale.** `--machine ABCD-EF12-3456` locks a
  key to one computer; omit it and the key runs anywhere, which is what every
  key issued before this does forever. The buyer copies their **Machine ID**
  from Settings → License. The fingerprint is Windows' own `MachineGuid` —
  stable across app reinstalls, driver updates, RAM upgrades and renames —
  falling back to hostname + platform + arch + CPU model. Deliberately *not*
  total memory, MAC address or disk serial: each of those changes for reasons
  that are not the customer's fault and would kill a paying key. The binding
  lives inside the signed payload, so it cannot be stripped; a test forges a
  stripped payload and asserts the signature check catches it.
- **BUY_URL now derives from a single `WHATSAPP_NUMBER`** with a pre-filled
  message, falling back to the releases page while unset so no button is ever
  dead. A test **fails the build** if `LICENSE_ENFORCEMENT` is `"block"` while
  the number is still empty — the one combination that would strand every
  trial-expired user behind a dead link.
- **Landing page rebuilt** (the previous one predated v2.80 and still carried
  Razorpay placeholders and no screenshots): WhatsApp-first CTA, founding-trader
  pricing, real product screenshots, staged positions as the flagship section,
  and a delivery flow matching email-a-ZIP. SEBI-safe by construction — no
  return, accuracy or win-rate claims anywhere. `build-landing.mjs` inlines the
  screenshots into one self-contained file and refuses to build while any
  `[[PLACEHOLDER]]` is unfilled.
- **Docs brought current**: `LICENSE_OPERATIONS.md` (the owner's runbook —
  issue, list, support, refund, rotate), `INDICATORS_LAUNCH_KIT.md` (analysis of
  both Pine scripts, sales copy, paste-ready TradingView descriptions,
  invite-only publishing steps), plus a current-state section appended to the
  roadmap, whose handoff notes had stopped at v1.14.0.
- 25 new tests (576 total). Enforcement deliberately still `"banner"` — flipping
  it needs the real WhatsApp number.

## v2.85.0
**Staged positions** — build a position in tranches and scale out of it, the
way positions are actually managed.

- **Entry ladder with a stop per tranche.** Turn on staged mode from the Trades
  table and a position becomes a list of fills: add another entry as the trade
  proves itself, each with its own stop and target, or write one stop across
  every open tranche in a click. Closed tranches are never rewritten — that
  would falsify the record of what you did.
- **Partial exits on any trade.** Book 25/50/100% (or any quantity) and the
  rest keeps running. No mode switch needed: a plain trade converts to a ladder
  on the fly, losslessly. Percentage shortcuts round DOWN to a whole unit,
  because you cannot sell 762.5 shares.
- **Three accounting rules, chosen deliberately and documented in the code.**
  *Pricing is weighted-average* — an exit books against the blended cost of
  everything open, so journal P&L never disagrees with your broker's average
  price. *Quantity consumption is FIFO* — money is fungible but stops are not,
  so an exit retires the oldest tranche and the survivor keeps its own stop.
  *R is frozen at the first entry* — a 3R stays a 3R whether or not you
  pyramided, so every existing expectancy and playbook report keeps working.
- **Charges booked per fill.** Brokerage is per order and STT per execution, so
  each leg is priced on its own — with DP levied once per exit DATE rather than
  once per leg, and MTF interest accrued per tranche from its own entry date.
  Scaling into options really does cost ₹20 an order and the journal now says
  so; under percentage brokerage it is correctly cost-neutral.
- **Risk cockpit sums real risk.** Open risk, initial risk and capital-at-risk
  are summed across tranches with individual stops instead of being inferred
  from one position-level stop — a wide stop on the core and tight stops on the
  adds is genuinely less exposed, and `/risk` now says so.
- **Imports rebuild the ladder automatically.** Zerodha, Angel One and Upstox
  tradebooks list every execution; those fills are now preserved instead of
  being flattened into one average. A position is staged only when a SIDE was
  filled more than once — an ordinary buy-then-sell stays an ordinary trade.
- **Two warnings that earn their place.** *Averaging down* fires when an add is
  worse than your average (and correctly inverts for shorts). *Open risk above
  initial risk* fires when an add is not funded by trailing the earlier stops up
  — which is most of them, and is precisely the thing nobody notices.
- 83 new unit tests (551 total), including proof that a one-entry ladder prices
  identically to the classic round-trip across all five brokers.
- Note on precision: STT and stamp duty round to the nearest rupee, so pricing
  a trade as two legs instead of one round trip can move its total by up to
  about ₹2. Measured across every segment on real data the drift was ≤ ₹1.11.
  The per-leg figure is the more accurate one and is not corrected back.

## v2.84.0
Two fixes aimed at discoverability: numbers that explain themselves, and the
preset playbooks that were hiding inside a dropdown.

- **Clickable KPI cards with a drill-down popup.** Sixteen cards across the
  Dashboard, Portfolio Risk, Equity Tracker and Trade F&O Tracker now lift and
  glow on hover and open a compact breakdown on click (or Enter/Space — the
  cards are keyboard-focusable `role="button"`s). The popups answer *what is
  this number made of*, not just what it is: **Net P&L** splits into gross minus
  every charge with best/worst day and dates; **Open Risk @ SL** puts open risk
  next to initial risk with the stopped/unstopped count, so trailing a stop
  visibly moves the number; **MTF funded** shows effective leverage and interest
  accrued as a share of your paper gain, flagging when financing has eaten the
  entire unrealised gain; **Unrealised P&L** names your best and worst position.
  Detail objects are plain serializable strings, so server components can build
  them without a client boundary.
- **Preset library on `/playbooks`.** The 25 world-class setups existed since
  earlier releases but lived inside a `<select>` in the New Playbook dialog —
  effectively invisible. They now render as a browsable library: filter chips
  for 7 ecosystems (Intraday & Momentum, Breakout & Trend, Positional/Growth,
  Mean Reversion, Price Action/SMC, Options & Events, Swing & Overnight), every
  rule visible on the card, one-click **Add**, `✓ Added` once it's yours, and
  fully editable afterwards. Deliberately **not** auto-seeded into the DB: 25
  untraded setups would bury your real playbooks and turn the Discipline page's
  per-playbook expectancy into 25 rows of noise. Nothing is added until you
  click. The empty state now points at the library.

## v2.82.0
Ecosystem-research batch: findings from surveying the global journal market
(TradeZella/TraderSync/Edgewonk/TradesViz) and India's 2024–2026 F&O regime,
turned into three shipped features.

- **Angel One + Upstox importers.** Angel One alone is ~15% of India's active
  trading accounts; both brokers now import end-to-end. One resilient parser
  handles each broker's *two* export shapes — tradebook (buy/sell column,
  aggregated into round-trips per tradingsymbol+product) and aggregated P&L
  report — with candidate-list column resolution plus contains-fallback, so
  header drift between report versions doesn't break parsing. `₹` symbols and
  thousands-commas are stripped. Charge cards, DP charges, MTF interest and
  eq_mtf own-margin seeded for both. Two hardcoded broker enums (charges-preview
  route, trade actions) now derive from `BROKERS`, so they can never silently
  reject a newly added broker again.
- **SEBI Compliance Radar** (`/risk`). Turns your open book + today's date into
  plain warnings for the post-2024 regime: **+2% expiry-day ELM on short options
  expiring today**, **no calendar-spread margin benefit on expiry day**, weekly
  expiry discontinuation (BANKNIFTY/FINNIFTY/MIDCPNIFTY/NIFTYNXT50 are monthly
  only; NIFTY on NSE and SENSEX on BSE kept weeklies), index position-limit
  proximity vs the ₹1,500 cr net limit with the intraday random-snapshot
  warning, and standing reminders on upfront premium collection and the
  ₹15–20 lakh contract band. Informational only — your broker's RMS remains the
  source of truth and Vyuha never blocks a trade.
- **Shareable stat cards** (`/reports/performance`). Privacy-first by
  construction: defaults to **% of capital**, offers "hide ₹ entirely", and
  shows real rupees only if explicitly chosen; you pick which of 10 metrics
  appear. The PNG is drawn on a canvas and saved **locally — nothing is
  uploaded** — and carries a permanent, non-editable *"self-reported from my own
  journal · not broker-verified"* watermark, because an offline app must never
  imply broker verification.
- Note: options payoff diagrams were already shipped (strategies engine +
  payoff chart) — verified rather than rebuilt.

468 unit tests (+28), typecheck, lint all green; every feature verified live,
including a temporarily-shorted expiring option to prove the radar fires and an
end-to-end PNG export.

## v2.80.0
Three workstreams: performance, monetization v2, and a full visual overhaul.

### Performance & code health
- **Per-request query deduplication**: the eight hottest server queries
  (trades, MTM/spot maps, settings, margin config, aliases, playbooks, charge
  rates) are wrapped in React `cache()` — pages that previously hit the DB 2–4×
  per render now hit it once, and importing a broker file no longer re-queries
  margin config per trade (the last N+1).
- **New indexes** on `trades.is_open` and `trades.playbook_id` (migration 0024).
- **Lint: 16 warnings → 0 problems** — dead imports/locals removed across 12
  files; `_`-prefixed/rest-sibling destructures now treated as intentional.

### Monetization v2 (offline, user-first)
- **14-day full-Pro trial** stamped on the true first run (installer templates
  ship unstamped; existing installs backfilled). Trial users see everything
  plus an honest countdown strip.
- **`<ProGate>`** now drives all four Pro screens (Portfolio Risk, Tax Summary,
  ITR Pack, Broker Costs) from one `PRO_FEATURES` registry. "banner" mode
  (current) informs; "block" mode replaces content with an upsell panel after
  the trial. Enforced product principle: the core journal — trades, imports,
  dashboard, playbooks, backups — is NEVER gated.
- **Annual keys**: the license payload takes a signed optional `expires` date;
  `license-issue.mjs --years 1` mints them; expired keys degrade gracefully
  (grace trial → free) with a renewal notice. Settings shows tier/trial/expiry.

### Visual overhaul (all 3 cosmetic tiers)
- **Typography**: Inter UI + JetBrains Mono on every number and table
  (self-hosted, offline-safe) — the terminal look, app-wide.
- **Depth**: elevation tokens with inner-highlight cards, hover lift, blurred
  dialog overlays with real spring keyframes, hero gradient border + glow on
  the equity curve.
- **Charts**: draw-in animation + crosshair cursor on the equity curve; the
  P&L calendar gained rounded magnitude-scaled cells, hover scale and a today
  ring.
- **Alive layer**: Net P&L sparkline + week-over-week ▲/▼ delta chip, count-up
  KPI numbers (reduced-motion aware), row-hover lift on every table, shimmer
  skeletons on the five heaviest routes, and a dependency-free **toast system**
  replacing inline "Saved." messages.
- **Sidebar**: collapsible icon rail (persisted), accent rail + glow on the
  active item, a "Jump to… Ctrl K" chip wired to the command palette, and a
  footer **IST clock with market open/closed pulse dot**.
- **Accent skins**: Terminal (teal) / Tape (amber) / Ice (blue), selectable in
  Settings with instant preview, persisted (migration 0025), composing with
  light theme + colorblind mode. P&L semantics untouched by skins.
- **Illustrated empty states** (skin-aware line art) on every data table, the
  dashboard charts and the Playbooks page.
- **Branded splash** (glowing व, ripple halo, shimmer progress, privacy
  footer) and **print-grade PDF output**: printing forces the light palette,
  strips elevation, sets page margins and keeps tables from splitting.

440 unit tests, typecheck, lint all green; features verified live in dark,
light and Tape-skin contexts, including a fresh-context toast/interactivity
probe.

## v2.75.0
User-control release: seven upgrades, every one warns and cautions instead of
acting — the trader keeps the final say on everything.

- **Playbook rule-checklist enforcement.** Journaling a trade with a playbook
  attached now shows its rules as a "tick what you actually followed"
  checklist; unticked rules persist as violations (validated server-side
  against the playbook's real rules, merged non-destructively with the
  pre-trade limits engine's entry breaches). New Discipline table: **"Playbook
  rules — what breaking each one costs"** (worst rule first, closed net ₹,
  avg/trade) with honest correlation-≠-causation framing.
- **Per-playbook expectancy cards.** Each playbook card shows Trades / Win% /
  Net / Expectancy / Profit Factor / Avg R from closed tagged trades, with a
  ⚠ small-sample warning under 20 trades and an honest empty state.
- **Auto-updater surfaced.** The launch-time update check (native Update
  now/Later dialog, signed releases, offline-silent) now has an "App updates"
  card in Settings documenting the consent contract: nothing ever installs on
  its own, and the DB is backed up before any migration.
- **MAE/MFE stop-tuning report** (Edge page). MAE/MFE now normalizes to R via
  each trade's recorded risk; the new card shows winners' heat distribution
  (≥0.5R / ≥0.8R) and losers running past 1.1R (flagged as behavioral, not
  placement). Every suggestion is hedged; small samples get an explicit
  "mostly noise" warning; footer says descriptive-not-prescriptive.
- **EOD bhavcopy auto-MTM (opt-in).** New Settings toggle — OFF by default —
  lets the app fetch NSE's EOD file once per trading day (after ~7pm IST) and
  mark open equity positions to close via the existing audited pipeline.
  Warns that matched MTM prices get overwritten; skips silently offline;
  walks back weekdays past holidays. Migration 0023 adds the settings columns.
- **SL/TSL/target breach alerts.** New pure detector (long/short aware, TSL
  supersedes SL) feeding caution banners on Dashboard and Portfolio Risk:
  "check a live quote and review your exit plan" — marks are EOD/manual, and
  the banner never places or closes anything. Desktop notifications are
  strictly opt-in per device.
- **ITR Pack (India)** — new report: per-FY head segregation (speculative
  intraday / non-speculative F&O / STCG-LTCG), ICAI Guidance Note (8th ed.)
  turnover, and a 44AB audit verdict with layered cautions (44AD's 5-year
  lock, loss carry-forward deadline, "have a CA confirm" on every verdict).
  CSV/XLSX export for the CA.

Verified live end-to-end (rule checklist → per-rule cost table, expectancy
cards, stop-tuning card, breach banner via a temporary SL, auto-MTM refusing
to run while disabled, ITR pack against the real 252-trade book) with all
test data reverted. 433 unit tests (+30), typecheck, lint all green.

## v2.70.0
- **Preset playbooks expanded to a categorized global library — 25 setups
  across 7 trading ecosystems** (was 10, flat): Intraday & Momentum (ORB, VWAP,
  Gap-and-Go, Momentum/RS), Breakout & Trend (MA Pullback, Retest,
  Donchian/Turtle, 52-Week-High, Darvas Box), Positional/Growth (CANSLIM,
  Minervini VCP, Wyckoff Spring, Weinstein Stage 2), Mean Reversion (Range
  Fade, Connors RSI-2, Bollinger Reversion), Price Action/SMC (ICT Liquidity
  Sweep + FVG, Supply & Demand, Pin Bar), Options & Events (Theta Decay, Iron
  Condor, India Expiry-Day Theta, Earnings/Event), and Swing & Overnight
  (Multi-Day Swing, India BTST). The New Playbook picker groups them by
  ecosystem; every rule's metrics (risk %, ATR multiples, deltas, stop %)
  remain fully editable before saving, and the from-scratch custom flow is
  unchanged. New `tests/preset-playbooks.test.ts` guards the library's shape
  (unique names, ≥3 single-line rules each, ≥5 categories). Verified live:
  picked CANSLIM, edited O'Neil's 7–8% stop rule to a custom 5% before saving,
  confirmed it persisted, then cleaned up.

## v2.65.0
- **Fixed: open short positions (written options, short futures) showed qty=0/
  invested=0/unrealised=0 on the Equity and Trade F&O trackers.**
  `deriveOpenPositions()` (`lib/analytics/positions.ts`) computed
  `qty = max(0, buyQty − sellQty)` and used `avgBuyPrice` unconditionally — for
  a sell-to-open position (buyQty=0, sellQty=open qty), both evaluated to 0. Now
  isShort-aware (`sellQty > buyQty`), matching the pattern already used by
  `/risk` and `closePosition`: qty/entry read off the sell leg, unrealised P&L
  mirrors direction (profits when price falls), and days-held measures from the
  sell date (the actual open leg) for a short. MTF is long-only in India, so
  its own-capital/funded-amount fields are unaffected. New `tests/positions.test.ts`
  (7 tests: long, short profit/loss, days-held, R-multiple sign, MTF untouched).
  Verified live: a disposable open short stock-option (entry 100, MTM 80, qty
  75) correctly showed invested ₹7,500 / unrealised +₹1,500 (20%) where it
  previously showed all zeros — then removed.

## v2.60.0
- **Fixed: Edit-trade dialog showed a false loss for open MTF positions.** The
  dialog never wired up the current-price field to the P&L preview, so a
  position up in price could still show "Net: -₹X" (only realized gross, always
  ₹0 pre-exit). It now shows entry cost so far and unrealized P&L (at current
  price) as separate, clearly-labeled figures for any still-open position.
- **New: Current R and Target R:R shown side by side.** Current R stays live
  (unrealised P&L ÷ risk amount, tracks the position as it moves); Target R:R is
  new — the static planned reward:risk from entry/SL/target, computed once at
  entry. Both appear on the trades table, trackers, and edit/add trade dialogs.
- **MTF own-margin % is now broker-specific, not one flat global rate.**
  `margin_config` gained a `broker` column (Dhan/Groww 25%, Zerodha 20%, per
  each broker's own MTF documentation) — threaded through position tracking,
  the accrual job, close/edit/create trade flows, the Trade Calculator, the
  broker-cost comparison report, and the /risk margin-rate editor (now one row
  per broker × segment, independently editable).
- **New: funding-type filter on the equity tracker** — All / User-funded only /
  Broker-funded (MTF) — to separate self-funded delivery positions from
  leveraged MTF ones at a glance.
- **New: Risk Amount auto-computes from the SL you set** (`|entry − SL| × qty`)
  in both the Add-trade and Edit-trade forms, while still allowing a manual
  override.
- **New: preset playbooks library** — 10 globally-recognized trading setups
  (Opening Range Breakout, VWAP reversion, trend-following, breakout-pullback,
  mean-reversion, gap-and-go, momentum, options theta-decay, earnings play,
  multi-day swing) selectable from the New Playbook dialog to pre-fill the form;
  edit anything before saving. The from-scratch custom-playbook flow is
  unchanged.
- Verified live end-to-end (broker-specific margin math, the false-loss fix,
  auto risk-amount, funding filter, preset playbooks) against a disposable test
  trade and playbook, cleaned up afterward. 393 unit tests, typecheck, lint all
  green.

## v2.50.0
- **Fixed: capital figures frozen at the original ₹13L/₹4L defaults.** Page titles,
  Cash & Ledger, and bucket-filter dropdowns had "(₹13L)"/"(₹4L)" hardcoded into
  `BUCKET_LABELS` — changing capital in Settings never touched them (now removed;
  live capital already shows correctly elsewhere on each page). A second instance of
  the same bug: the Targets → Equity position-size calculator divided by a
  hardcoded 1,300,000 instead of live `equityCapital` — now threaded through as a
  prop from the server page.
- **Fixed: R-multiple frozen at trade creation for open positions.** The tracker
  showed a value computed once when a trade was opened (net entry-cost ÷ risk),
  never updated as the position moved — a position up 1.43% could show a negative
  R. `lib/analytics/positions.ts#deriveOpenPositions` now computes R live as
  unrealised P&L ÷ risk amount.
- **Fixed: a second "MTF funded = full position value" bug**, this time in the
  position-tracker's own display logic (`positions.ts`), independent of the
  backend fix from v2.0.0 — it was silently ignoring the persisted funded amount
  and recomputing the (wrong) full-value figure for display.
- **Fixed: MTF interest day-count undercounted by one day, in three places** —
  close-trade, the daily accrual job, and broker-cost comparison all subtracted an
  extra day. Confirmed against Dhan's own MTF documentation: interest runs from
  T+1 settlement through the day before sale proceeds settle, i.e. exactly
  (sellDate − buyDate) calendar days — no "-1".
- **Corrected Zerodha's seeded pledge/unpledge fee** from ₹20 to the real ₹15+GST
  per Zerodha's own MTF calculator page. Every other rate (Dhan's interest tiers,
  Zerodha/Groww annual rates, STT/stamp/exchange/SEBI/DP) already reconciled
  exactly against a real user-supplied MTF trade log.
- **MTF input model switched to "Own capital used" as primary** (matching how a
  real MTF trade log is kept — you know what cash you put in; the broker-financed
  amount and leverage are derived), replacing the old "funded amount" field in
  both the trade form and the Trade Calculator.
- **New: close any open trade** — a "Close position" action with a live
  recomputed charges/P&L preview before confirming, for any segment (equity,
  MTF, options, futures).
- **New: edit any trade, any time** — a full editor (qty, prices, dates, SL/TSL/
  target, risk, MTF own-capital, tags, notes) for open or closed trades, reusing
  the same charges engine so edits never drift from what a fresh entry would
  compute.
- **New MTF analytics on the position tracker**: own capital deployed, ROI on
  capital % (the leveraged return your own cash actually earned), breakeven sell
  price, and a warning badge when accrued interest has eaten the entire unrealised
  gain — modeled directly on a real trader-maintained MTF log.
- Verified live end-to-end against real test positions (created, tracked, closed,
  edited, then removed) plus the existing 252-trade journal, which is untouched.
  387 unit tests, typecheck, lint and production build all green.

## v2.0.0
- **Fixed: MTF interest overcharged everywhere (real money bug).** Trade creation, the
  daily accrual job, position-close, and the Trade Calculator's default all treated an
  MTF position as 100% broker-financed — interest should only accrue on the leveraged
  portion your broker actually lends, not the full position value. New
  `defaultMtfFundedAmount()` (`lib/risk/margin.ts`, 4 tests) derives the funded amount
  from the existing configurable own-margin % (Settings → Margin, same rate the /risk
  margin gauge uses); a new `trades.mtf_funded_amount_paise` column persists it per
  trade at entry so the accrual job and close-position recompute reuse the correct
  figure instead of silently resetting to the full buy value. The live charge preview
  now applies the identical default, so what you see before saving matches what's
  saved (it previously skipped MTF interest AND the pledge charge whenever "MTF
  funded" was left blank). Verified live: a ₹1L test MTF position correctly funded at
  ₹75,000, not ₹1,00,000 — roughly 25% less interest than the old bug charged.
- **Fixed: open-trade preview showed a false loss when price was up.** The "Add open
  trade" panel only ever displayed realized P&L (always ₹0 gross pre-exit), so a
  position up in price still read as a net loss from entry charges alone. Now shows
  "Entry cost so far" (charges only) and, when a current price is entered, a separate
  "Unrealized P&L (at current price)" line — clearly not merged into the cost figure.
  Closed-trade preview is unchanged.
- Removed the "Days held (MTF)" field from the open-trade form (interest can't have
  accrued on day zero); kept for closed manual entries where an elapsed holding period
  is meaningful. Trade Calculator's "Funded ₹ (0 = full)" relabeled to "0 = auto @
  {margin}%".

## v1.50.0
- **Pre-trade limits are now advisory — the trader always has final say.** A breached
  limit no longer disables the Add-trade button: the verdict reads "Limit breached
  (you can override)" and the button flips to a red "Override & add anyway". Overridden
  breaches are still recorded in `rule_violations` and surface on the Discipline
  scorecard's breach tile — control stays with the user, accountability stays in the
  journal.
- **"Active" bucket renamed to "Trade F&O" everywhere in the UI** — nav ("Trade F&O
  Tracker", "Targets — Trade F&O"), page titles, dashboard/trades bucket filters, risk
  cockpit scope toggle, margin gauge, capital settings, cash ledger, capital-growth
  chart. Display-only: the internal bucket id stays `active` (DB rows, APIs and
  overrides are untouched). New `BUCKET_SHORT_LABELS` in `lib/domain/constants.ts`.

## v1.40.0
- **P0.1 paise migration FINISHED** — all 17 ₹-amount columns on `trades` (values, P&L,
  full charge breakdown, risk amount) now stored as INTEGER paise (migrations `0016`/`0017`,
  data converted ×100 in place and verified sum-identical on all 252 trades). A Drizzle
  `customType` exposes rupees at runtime, so no call sites changed. Per-unit price/level
  columns (avg prices, SL/TSL/target, strike, FMV) stay REAL by design.
- **Margin/SPAN tracking** (P1.2 final slice) — pure `lib/risk/margin.ts` (7 tests): long
  options = premium paid; short options = rate% × notional (spot ?? strike); futures/intraday
  = rate% × current value; MTF/delivery = rate% × invested. New editable `margin_config`
  rate table (migration `0018`, seeded approximations) + "Margin estimate" panel with
  per-bucket utilisation gauges on /risk.
- **IND-5 AIS / Form 26AS reconciliation** — pure `lib/analytics/ais.ts` (8 tests): tolerant
  paste parser (dividend / sale SFT-18 / purchase SFT-17 / interest; FY labels or dates;
  ₹-grouped amounts) + reconciliation of AIS dividends (per company+FY, alias-resolved,
  incl. TDS) and per-FY sale/purchase consideration (trades + IPO allotments/exits) with
  matched / MISMATCH / not-in-journal / not-in-AIS statuses, tolerance max(₹10, 0.5%).
  New /reports/ais screen (nav "AIS Reconcile"), stateless `/api/ais`.
- **P2.1 broker-API auto-import (Kite slice)** — first `ApiImportSource` implementation:
  `lib/import/api/kite.ts` (5 tests) pulls today's executions from Zerodha Kite Connect,
  aggregates per symbol+product (earliest-buy/latest-sell dates, MIS→intraday, CNC→delivery,
  MTF→mtf hints) and feeds the unchanged preview→commit pipeline. "Connect broker" card on
  /import; credentials in new `broker_connections` table (migration `0020`, plaintext local,
  stated in UI; Kite tokens expire daily).
- **Trade attachments** (P2.4 completion) — chart screenshots per trade: `trade_attachments`
  table (migration `0019`) + files under `<data-dir>/attachments/`, upload/gallery/delete in
  the journal dialog, streaming via `/api/trades/attachments` (images only, 8 MB cap,
  path-confined, audited). Backup screen notes attachments are outside the JSON backup.
- **MAE/MFE per trade** — pure `lib/analytics/mae-mfe.ts` (5 tests) computes max adverse /
  favorable excursion + %-of-MFE captured from `price_history` EOD bars for closed dated
  trades; card with coverage badges on /reports/edge.
- **Discipline breach tile** (P1.4 follow-up) — `breachReport()` in discipline.ts (4 tests)
  rolls up `rule_violations` saved at entry time; "Entry-time limit breaches" card on
  /reports/discipline showing per-rule counts and closed net P&L.
- **Zero-dependency installer** — `build-desktop.mjs` now bundles the building machine's
  Node runtime (+ LICENSE) into `desktop-dist/node/`; the Tauri shell prefers the bundled
  binary and falls back to system `node` for older bundles. Target machines no longer need
  Node installed (cargo check verified; rebuild the installer to ship it).

## v1.10.0
- Option Greeks: Black-Scholes delta/gamma/theta/vega per open option position + a
  portfolio aggregator (`lib/analytics/greeks.ts`), scaled by quantity and signed for
  direction (short flips gamma/vega negative, theta positive). New `trades.implied_vol`
  column, settable per position via the risk-edit dialog; falls back to a flat 20%
  estimate when unset. New "Option Greeks" panel on Portfolio Risk.

## v1.9.0
- F&O trade entry upgrade: an Equity/F&O mode toggle in the manual trade form —
  Underlying, Option/Future, Strike, CE/PE, Direction (Buy/Sell), Expiry with a live
  DTE badge, Lot size, Lots, Entry/Exit premium, Strategy.
- Short (sell-to-open) position support fixed across the app: `isOpen` detection,
  the risk/exposure engine, the close/cover flow, and the pre-trade risk-edit routes
  were long-only; a written CE/PE was previously invisible to portfolio risk.
- Real sector data (via an external market-data lookup) populated for held positions,
  correcting earlier manual-entry mistakes in the instruments master.

## v1.8.0
- P1.3 market-data foundation: `instruments` security master (symbol/sector/ISIN/lot
  size) and `price_history` (EOD OHLC, built automatically from bhavcopy imports).
- Sector concentration panel on Portfolio Risk (HHI, top-sector %, classified %).

## v1.7.0
- P1.1 finished: time-weighted return (TWR) and benchmark alpha/beta vs an index
  (NIFTY), completing the performance analytics suite alongside the existing
  Sharpe/Sortino/Calmar/XIRR.
- P1.4 pre-trade limits engine: per-trade risk cap, daily-loss stop, max-open,
  max-trades/day, and concentration checks — live pass/warn/block before saving a
  trade, plus a what-if panel on Portfolio Risk.

## v1.6.0
- Version-sync-only bump (no feature).

## v1.5.0 and earlier
- Foundational build: money-as-paise core, cash/fund-flow ledger, append-only audit
  log, backup/restore, quant performance analytics (Sharpe/Sortino/Calmar/XIRR),
  option strategy recognition + payoff diagrams, physical-settlement tracker,
  F&O ban/ASM surveillance, tax-loss harvesting, advance-tax planner, broker-cost
  comparison, bhavcopy auto-MTM, symbol-alias map, and the trade calculator.
  (Detail formerly lived in `docs/INSTITUTIONAL_GRADE_ROADMAP.md`, removed in v2.98 —
  the invariants and conventions it carried now live in `AGENTS.md`.)
