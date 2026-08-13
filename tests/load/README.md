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

## Designed, not yet written

Each names the code that worries it, so none of this needs re-deriving.

| # | Test | Target | Predicted finding |
|---|---|---|---|
| B1 | `lenses-grouping.load.ts` | `lib/domain/lenses.ts:231-235` | Re-filters the book per group; import-batch groups are unbounded. Gating does not save the work — `lens-edge.ts:66` masks at output |
| B2 | `entitlement-cost.load.ts` | `lib/queries/license.ts:95-97` | A SQLite **UPDATE on essentially every Pro page render** (guard is `now > mark`, true after 1 ms) — the app's most frequent writer. Plus a duplicated SHA-256 at `:127` and a PEM re-parsed per verify |
| B5 | `backup-restore.load.ts` | `lib/backup.ts:271-274` | `dbCounts()` selects every row of all 29 tables purely for `.length`, on **every `/backup` render** |
| B6 | `encrypted-backup.load.ts` | `backup-format.ts:98-103`, `api/backup/route.ts:47` | `scryptSync` at N=2^17 (~134 MB, synchronous) run **twice per restore** |
| B7 | `import-parse-count.load.ts` | `lib/import/detect.ts:89` | All 11 detectors run per upload, most re-parsing the file — ~7-8 full `XLSX.read` per import. Assert ≤2 |
| C2 | `pathological-import.load.ts` | `generic-table.ts:113-131` | Skipped-row counts are computed then **dropped** — only `warnings` is forwarded, so a user is never told how many rows vanished |
| C7 | `money-boundary.load.ts` | `schema.ts:21`, `trades.ts:52-54` | `fromDriver` hands back floats; summing 250k of them drifts. Compare against `SELECT SUM(net_pnl_paise)` in integer paise |

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
