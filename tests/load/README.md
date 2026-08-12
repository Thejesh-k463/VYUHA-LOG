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

## Written

- **`a1-cross-source.load.ts`** — import preview overlap detection.
  **Found and fixed a real defect**: `detectCrossSourceDuplicates` filtered the
  whole book per incoming row with `norm()` inside the predicate. HEAVY tier
  went **8,003 ms → ~20 ms (364×)**. Budget: 2,000 ms, ~90× headroom.

## Designed, not yet written

Ordered by likelihood of finding a real defect. Each names the code that
worries it, so none of this needs re-deriving.

| # | Test | Target | Predicted finding |
|---|---|---|---|
| A2 | `data-quality.load.ts` | `lib/queries/data-quality.ts:15-16` | O(trades × mtm_prices) with two `toUpperCase()` per comparison, and the `latestBySymbol` Map materialised **inside** the filter predicate — a fresh array per open trade. `/data-quality` is `force-dynamic`. Expect >30 s at HEAVY |
| A3 | `delete-scale.load.ts` | `lib/queries/delete.ts` (8 unchunked `inArray` sites), `lib/trash.ts:251` | `SQLITE_MAX_VARIABLE_NUMBER` (32,766) exceeded — "too many SQL variables" on an account-scope delete above that many trades. Read the real limit from the linked build, don't hard-code |
| A4 | `backup-attachments.load.ts` | `lib/backup.ts:89-94`, `:248-249` | **Confirmed data loss, not a prediction.** `attachments/route.ts:130` claims "Backup copies the directory wholesale, so sidecars ride along". It does not: `backup.ts:90` iterates `trade_attachments` **rows**, and `thumb-*` files are a naming convention with no row. Restore renames the live dir away and promotes a staging dir built only from enveloped files — **every thumbnail is destroyed by any attachment-carrying restore** |
| A5 | `staged-depth.load.ts` | `lib/queries/staged.ts:325-336` | The module has **zero** `db.transaction` calls; `rebuildStagedTrade` issues one UPDATE per leg. Perf *and* atomicity: a crash mid-rebuild leaves legs repriced and the parent aggregate stale — silently breaking invariant 5 |
| A6 | `broker-compare.load.ts` | `lib/analytics/broker-compare.ts:116-120` | O(trades × broker-plan pairs) full charge computations per render, unmemoised, `force-dynamic`. ~250k at HEAVY |
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
