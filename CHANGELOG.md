# Changelog

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
