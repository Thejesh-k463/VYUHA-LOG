# Load and stress suite

```bash
npm run test:load              # everything
npm run test:load -- a1        # one file, by substring
```

Results append to `load-results.json` (gitignored) — a trend to read, not a
pass/fail line.

## Why this is a separate suite

`vitest.config.ts` includes `tests/**/*.test.ts`. These files end in
`.load.ts`, so **`npm test`, `npm run verify` and CI cannot pick them up by
construction** — no skip flag to rot, no way for a five-minute seed to creep
into a unit suite that has to stay measured in seconds.

## What to assert on, in order of preference

1. **`countStatements()`** — how many SQL statements a call prepares. An N+1
   *is* a statement count, so count it. Discrete, deterministic, identical on
   every machine.
2. **`countCalls()`** — invocations of a hot function. Same argument.
3. **`growthRatio()`** — `t(4n)/t(n)` in one process after a warm-up. Linear
   ≈ 4, quadratic ≈ 16. A ratio cancels machine speed.
4. **A generous absolute ceiling** — only when 1-3 don't fit, and only with
   enough headroom that no runner trips it.

Absolute milliseconds are otherwise **reported, never asserted**.

### Two traps this suite has already fallen into

**Scaling one axis of a product proves nothing.** The first A1 draft held the
incoming file fixed and grew only the book. Cost is `incoming × existing`, so
that is linear by construction — it passed against genuinely quadratic code.
Grow both axes.

**The generator can be the thing that's quadratic.** The second A1 draft used
ten symbols. Candidates group by `broker|tradingsymbol`, so ten symbols keeps
every bucket proportional to the book and the ratio reported 36× against code
that was already 364× faster. Symbol cardinality is now 500, with the
genuinely pathological single-symbol case tested separately and honestly.

**Ratios need a measurable baseline.** `growthRatio()` throws below 25 ms
rather than return jitter wearing a number.

## Tiers

Derived in the design pass from the owner's real book (252 trades), the e2e
fixture (122) and a decade of ~2,470 trading sessions.

| Table | TYPICAL | HEAVY | ABUSIVE |
|---|---|---|---|
| trades | 2,500 | 25,000 | 250,000 |
| trade_legs | 2,000 | 60,000 | 2,000,000 |
| ledger_entries | 5,000 | 60,000 | 500,000 |
| price_history | 50,000 | 1,250,000 | 5,000,000 |
| mtm_prices | 5,000 | 250,000 | 1,000,000 |
| audit_log | 5,000 | 100,000 | 1,000,000 |
| attachments | 300 / 150 MB | 3,000 / 2.5 GB | 10,000 / 80 GB |
| import_batches | 120 | 600 | 3,000 |
| staged legs (depth) | 4 | 10 | 500 |

## Written, and what each one found

| # | Test | Outcome |
|---|---|---|
| **A1** | `a1-cross-source.load.ts` | **Real defect, fixed.** `detectCrossSourceDuplicates` filtered the whole book per incoming row with `norm()` inside the predicate. HEAVY tier **8,003 ms → ~20 ms (364×)**. Budget 2,000 ms, ~90× headroom |
| **A2** | `a2-data-quality.load.ts` | **Real defect, fixed** — but not the one predicted. With symbols that match, `.some()` short-circuits and it ran in 555 ms; with symbols that were never marked (an F&O book against equity-only bhavcopy) nothing short-circuits and it took **10.3 s** on a `force-dynamic` page. Indexing the marks once: **10,276 ms → 329 ms (31×)**. Also fixed a case-sensitivity bug that reported fresh marks stale |
| **A3** | `a3-delete-scale.load.ts` | **Two real defects, fixed.** Deleting 32,816 trades threw `too many SQL variables` — reachable from "delete everything in this account". All eight `inArray` sites now chunk. Same test caught **4,010 statements for a 2,000-trade delete**; now 29, via a chunked bulk audit insert and by replacing a per-id IPO loop with the single statement the line below it already used |
| **A4** | `a4-backup-attachments.load.ts` | **Silent data loss, fixed.** Screenshot thumbnails (`thumb-<storedName>`, sidecars with no row) were never enveloped, and restore rebuilds the attachment directory from the envelope — so **every thumbnail was destroyed by any attachment-carrying restore**, including the automatic pre-migration one. The comment at the write site claimed the opposite |
| **A5** | `a5-staged-depth.load.ts` | **Atomicity defect, fixed.** `lib/queries/staged.ts` had **zero** transactions; a 500-leg rebuild was 501 separate commits, so an interruption left legs repriced against a stale parent — invariant 5 broken invisibly. Now one transaction. The test injects a failure at leg 10 and asserts rollback, and was **verified to fail** with the transaction removed |
| **A6** | `a6-broker-compare.load.ts` | **No defect.** 25,000 trades × 16 broker-plan pairs = 400,000 charge computations in **187 ms**, scaling linearly in brokers (1.9× for 2×). The O(trades × pairs) shape is inherent to the question; the test pins it so adding a broker cannot quietly go quadratic |

Two of the six predictions were wrong in an instructive way. A2's cost was
real but came from a different input shape than expected, and A6 was fine.
Measuring is what separated them.

### Second batch (2026-08-15) — B1, B2, B5, B6, B7, C2, C7

| # | Test | Outcome |
|---|---|---|
| **B1** | `b1-lenses-grouping.load.ts` | **Real defect, fixed.** `groupIds()` re-filtered the whole book once per import-batch group; batches grow with the book, so the page loop was quadratic: **t(4n)/t(n) = 14.3** (55 ms at 10k trades → 794 ms at 40k). Now indexed once per candidate array (WeakMap on the array's identity, re-indexed if it grows in place): **69 ms at 80k → 347 ms at 320k, ratio 5.1–5.3** (n log n from two sorting lenses + GC at 320k objects). Assertion is `< 8`, between the two |
| **B2** | `b2-entitlement-cost.load.ts` | **Real defect, fixed.** The clock high-water mark's guard was `now > mark`, so **200 entitlement reads spaced 1 ms apart = 200 UPDATEs, 400 statements**. (Back-to-back calls understate it 10× — 16 UPDATEs for 200 calls in 15 ms — so the test spaces them.) Now written at day granularity: **200 reads → 0 UPDATEs, 200 statements**; pure read 65 → 56 µs/call. The mark still advances when the day changes (asserted). The duplicated SHA-256 and per-verify PEM parse are in `lib/license.ts` (pure, out of this batch's file scope) — reported, not fixed |
| **B5** | `b5-backup-restore.load.ts` | **Real defect, fixed.** `dbCounts()` materialised **125,195 rows in 421 ms** (25k trades + 100k audit) to print 29 numbers, on every `/backup` render. Now `COUNT(*)`: **29 rows, 1 ms**. Instrument is rows returned by `Statement#all/get` — statement count is 29 either way and cannot see this. Restore of the same book: **9.6 s, 125,227 statements** (one INSERT per row inside one transaction) — reported, not asserted: linear, correct, and paid once deliberately |
| **B6** | `b6-encrypted-backup.load.ts` | **Real defect, fixed.** The panel's restore is two requests (`preview`, then `restore`) and each derived the scrypt key: **2 derivations, 498 + 527 ms of blocked event loop** for one restore. `decryptBackup` now keeps the last 4 derived keys for 5 min by (salt, params, password) — the salt is per-file, so only the same file with the same password is served: **1 derivation, 495 + 30 ms**. A wrong password still derives and is refused; two files with one password still derive twice (both asserted) |
| **B7** | `b7-import-parse-count.load.ts` | **Real defect, half fixed.** The route calls `rankParsers` and then `detectParser` (which ranks again), and seven detectors each `XLSX.read` the file: **15 full decodes per upload, 1,331 ms** to detect a 1.4 MB Zerodha tradebook (parse itself: 97 ms). `rankParsers` is now memoised per ParseContext object (keyed on identity + the fields detectors read; scores unchanged, detection matrix green): **8 decodes, 802 ms**. Getting to the designed ≤2 needs the parsers to share one parsed workbook — `lib/import/parsers/*` is outside this batch's file scope, so that target is pinned as an `it.fails` in the file and will flip red-to-green when someone does it |
| **C2** | `c2-pathological-import.load.ts` | **Prediction wrong; adjacent defect found and fixed.** The skipped count is NOT dropped — `applyMapping` already puts "2434 rows skipped … 962 of those had an unreadable date" into `warnings`, and the parser forwards them (asserted, 10k-row file, 35 % unreadable). What WAS missing: the executions shape pairs legs into positions and set no `sourceRows`, so the imports table showed a bare **4,226** for **6,491 readable lines** — exactly the "rows went missing" reading DECISIONS 2026-08-12 records. `generic-table.ts` now sets `sourceRows = rows − skipped` |
| **C7** | `c7-money-boundary.load.ts` | **No defect.** 250,000 trades summed as `paise/100` doubles: naive fold drift **5.0 × 10⁻⁴ paise** before rounding, **0 paise** after, against `SUM(net_pnl_paise)` (net ₹1,26,22,92,870.17); 20 random 25k slices: worst 0 paise. Two-decimal rounding absorbs it by five orders of magnitude at ABUSIVE tier; kept as a guard. `getTradeStats` over 250k rows: 3.1 s, all of it `getTrades()` materialising the book — reported |

Two of these seven predictions were wrong (C2's mechanism, C7 entirely), one
was right but bigger than predicted (B7: 15, not 7–8, because the route ranks
twice), and B2 needed the calls spaced a millisecond apart before it would
show at all.

### Third batch (2026-08-21) — C8

| # | Test | Outcome |
|---|---|---|
| **C8** | `c8-pairing-depth.load.ts` | **Real defect, fixed — and it was invisible to every other case.** `lib/import/pair-legs.ts` was rewritten on 2026-08-20 (v2.99.98) from one pass to two, five days AFTER this suite was written; an import-graph scan showed **none of the thirteen existing cases import that module**, though it is the hot path for five sources (Zerodha, Paytm Money, Dhan GTR, Groww orders, generic mapper). Each sell ran **three O(lots) scans** — a full-queue walk for same-day lots, `.some()` **and** `.find()` re-scanning inside the oldest-first `while`, and a reverse `splice` compaction — so a queue that grows (buys outnumbering sells) made the walk O(n²): **one symbol 8,000 → 79 ms, 32,000 → 1,249 ms, ratio 15.89**; opening-sell heavy **13.32**. Many symbols was always fine at **4.19** with per-item flat at 1.10 → 1.14 µs — work partitions per symbol, so no realistic book was affected. Fixed with a forward-only `head` pointer (replacing the splice) plus a per-date index: **ratios 3.70 and 4.10**, and 50,000 legs on one symbol **775 → 63 ms** with byte-identical output (28,269 positions, qty delta 0, value drift ₹3.29 on ₹1.5 bn = 2.19 ppb, unchanged). 1,920 unit tests and both real-file reconciliations pass unchanged |

Two lessons worth keeping. **A load suite only covers the modules it imports** —
thirteen cases and 13-of-13 green said nothing about the engine none of them
touched, and "we have load tests" read as coverage it did not have. And **fixing
a quadratic breaks its own ratio test**: the baselines fell under `growthRatio`'s
25 ms floor and had to be raised, which is exactly the failure its docstring
predicts.

## Designed, not yet written

Each names the code that worries it, so none of this needs re-deriving.

| # | Test | Target | Predicted finding |
|---|---|---|---|
| B7b | (extend `b7-import-parse-count.load.ts`) | `lib/import/parsers/*.ts` (`XLSX.read` at 7 sites + `groww-xlsx.ts:25`) | Share one parsed workbook across detectors and the parser (a lazy `workbookOf(ctx)` beside `buildContext`); flip the `it.fails` pin to a plain assertion of ≤2 |

## Writing a new one

- **Seed in one transaction with a reused prepared statement.** Per-row inserts
  spend the whole budget on setup.
- **Use `rng(seed)`, never `Math.random()`** — an unreproducible threshold
  failure is unfixable.
- **Money: pick a side and say so.** Writing via Drizzle means **rupees**
  (`moneyPaise.toDriver` ×100). Writing via raw SQL means **paise**. Mixing
  them yields a book that is 100× wrong and looks entirely plausible. Per-unit
  prices (avg price, SL, target, strike, FMV) are REAL and must not be scaled —
  see invariant 1.
- **`openTempDb` is one DB per file** (`lib/db` caches on `globalThis`).
- **Check `pragma synchronous` first** if you are measuring writes — it is
  never set in `lib/db/index.ts`, so it inherits the build default, and a run
  on a NORMAL machine understates fsync cost by an order of magnitude.
