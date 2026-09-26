import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db, sqlite } from "./index";
import { capitalSnapshots, chargeConfig, marginConfig, regulatoryRulePacks, riskConfig, settings, accounts } from "./schema";
import { buildChargeConfigSeed } from "./seed-data";

/**
 * Two seed profiles:
 *
 * - Default (dev + e2e): realistic capital so reports, targets and gauges have
 *   something to show without manual setup.
 * - VYUHA_SEED_CLEAN=1 (the DESKTOP TEMPLATE, set by scripts/build-desktop.mjs):
 *   zero capital and a 1970-01-01 sentinel go-live. The shipped template used
 *   to carry the developer's own capital figures — every installed copy started
 *   life showing someone else's ₹13,00,000. The sentinel date is stamped to the
 *   user's real first-launch date by scripts/desktop-server.mjs.
 */
const CLEAN = process.env.VYUHA_SEED_CLEAN === "1";
const GO_LIVE = CLEAN ? "1970-01-01" : "2026-06-19";
const EQUITY_CAPITAL = CLEAN ? 0 : 1_300_000;
const ACTIVE_CAPITAL = CLEAN ? 0 : 400_000;

export interface SeedReport {
  settings: "seeded" | "kept";
  capitalSnapshots: "seeded" | "kept";
  chargeAdded: number;
  chargeRefreshed: number;
  /** Non-edited epochs removed because a user-edited window of the same key covers their start (v4.3.0 R54). */
  chargeRemoved: number;
  riskAdded: number;
  /** margin_config rows this build ships that the table lacked (INSERT OR IGNORE). */
  marginAdded: number;
}

/**
 * Idempotent, non-destructive seed of config tables. Returns what changed.
 *
 * ONE transaction (v4.3.0): the rate card is 522 charge_config rows, and a
 * commit per row paid an fsync each — seeded test hooks hit the Windows
 * runner's 30 s hookTimeout (CI 34578562759). It also makes the seed atomic,
 * like the desktop refresh (scripts/rate-card-refresh.mjs): a failure part-way
 * leaves every table as it was, never a half-applied rate card.
 */
export function seedDatabase(log = false): SeedReport {
  return sqlite.transaction(() => seedAll(log))();
}

function seedAll(log: boolean): SeedReport {
  const report: SeedReport = {
    settings: "kept",
    capitalSnapshots: "kept",
    chargeAdded: 0,
    chargeRefreshed: 0,
    chargeRemoved: 0,
    riskAdded: 0,
    marginAdded: 0,
  };
  const say = (m: string) => log && console.log(m);

  db.insert(accounts).values({ id: 1, name: "Primary", isDefault: true }).onConflictDoNothing().run();

  if (db.select().from(settings).all().length === 0) {
    db.insert(settings)
      .values({
        goLiveDate: GO_LIVE,
        equityCapital: EQUITY_CAPITAL,
        activeCapital: ACTIVE_CAPITAL,
        theme: "dark",
        baseCurrency: "INR",
        fyStartMonth: 4,
        colorblindSafe: false,
        defaultBuyOrders: 1,
        defaultSellOrders: 1,
        // First-run onboarding (v3.7, migration 0057). The dev/e2e profile
        // stamps it: the Playwright suite shares ONE database across the run
        // and specs must not assume they run first (e2e/helpers.ts), so a
        // modal wizard over the app on first navigation would fail whichever
        // spec happened to go first. The DESKTOP TEMPLATE leaves it NULL —
        // a real fresh install is exactly who the wizard is for.
        onboardingCompletedAt: CLEAN ? null : new Date().toISOString(),
      })
      .run();
    report.settings = "seeded";
    say(`✓ settings seeded (go-live ${GO_LIVE})`);
  } else {
    say("• settings already present — left untouched");
  }

  if (db.select().from(capitalSnapshots).all().length === 0) {
    db.insert(capitalSnapshots)
      .values([
        { bucket: "equity", asOfDate: GO_LIVE, openingCapital: EQUITY_CAPITAL, deployed: 0, available: EQUITY_CAPITAL, realisedPnlToDate: 0 },
        { bucket: "active", asOfDate: GO_LIVE, openingCapital: ACTIVE_CAPITAL, deployed: 0, available: ACTIVE_CAPITAL, realisedPnlToDate: 0 },
      ])
      .run();
    report.capitalSnapshots = "seeded";
    say("✓ capital_snapshots seeded (opening snapshot per bucket)");
  } else {
    say("• capital_snapshots already present — left untouched");
  }

  const charge = refreshChargeConfig();
  report.chargeAdded = charge.added;
  report.chargeRefreshed = charge.refreshed;
  report.chargeRemoved = charge.removed;
  say(
    `✓ charge_config: ${charge.added} added, ${charge.refreshed} refreshed, ${charge.removed} removed` +
      ` (user-edited rows left untouched)`,
  );

  report.riskAdded = seedRiskConfig();
  say(`✓ risk_config: ${report.riskAdded} added`);

  report.marginAdded = refreshMarginConfig();
  say(`✓ margin_config: ${report.marginAdded} added (broker-specific; existing rows untouched)`);

  const rulePacks = [
    { code: "sebi-equity-derivatives", category: "regulatory", version: "2025.09", effectiveFrom: "2025-09-01", title: "SEBI equity-index derivatives monitoring", sourceTitle: "SEBI — Framework for Intraday Position Limits Monitoring", sourceUrl: "https://www.sebi.gov.in/legal/circulars/sep-2025/framework-for-intraday-position-limits-monitoring-for-equity-index-derivatives_97031.html", payload: { weeklyExpiryIndex: { NSE: "NIFTY", BSE: "SENSEX" }, monthlyOnlyIndexes: ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"], netIndexLimit: 15000000000, grossIndexLimit: 100000000000, expiryDayElmPct: 2, limitMetric: "future_equivalent" } },
    { code: "broker-rate-cards", category: "pricing", version: "2026.08", effectiveFrom: "2026-08-01", title: "Broker pricing and MTF assumptions", sourceTitle: "Broker-published rate cards; individually editable in Settings", sourceUrl: "https://github.com/Thejesh-k463/VYUHA-LOG/blob/main/lib/db/seed-data.ts", payload: { key: "broker × plan × segment × exchange", userEditedRowsPinned: true, statutoryRounding: "STT/CTT and stamp to nearest rupee", mtfBasis: "broker-funded principal only" } },
  ];
  for (const row of rulePacks) db.insert(regulatoryRulePacks).values(row).onConflictDoNothing().run();
  say("✓ regulatory_rule_packs seeded");

  return report;
}

/** What one pass of the shipped rate card over charge_config changed. */
export interface ChargeRefreshReport {
  added: number;
  refreshed: number;
  removed: number;
}

/**
 * The Drizzle handle a pass runs on: `db` itself, or a transaction on the same
 * connection (`db.transaction((tx) => …)`), so the pass joins that transaction.
 */
type ChargeConn = Pick<typeof db, "select" | "insert" | "update" | "run">;

// Margin-rate approximations (% of notional) for the /risk margin gauge and
// the MTF own-capital auto-estimate — editable in Settings; ballparks, not
// statutory. Broker-specific because real leverage varies: eq_mtf own-margin
// % below matches each broker's OWN advertised leverage (Dhan "4X leverage"
// — dhan.co/margin-trading-facility; Zerodha "up to 5x" —
// zerodha.com/calculators/mtf-calculator; Groww "up to 4x" —
// groww.in/blog/mtf-interest-rates). Other segments share one ballpark across
// brokers for now (no strong per-broker research yet) but the schema
// supports differentiating any of them later via the same editor.
const EQ_MTF_OWN_MARGIN_BY_BROKER: Record<string, number> = {
  dhan: 25, zerodha: 20, groww: 25, angelone: 25, upstox: 25,
  // kotakneo.com/pricing "up to 4X", paytmmoney 4x, sahi 4x — same ballpark,
  // and without a row these three fell back to the global default silently.
  kotakneo: 25, paytm: 25, sahi: 25,
  // v4.6.0 W9: Fyers and Nuvama take the same 25 the other three use —
  // neither is researched per broker yet, and a missing row falls back silently.
  fyers: 25, nuvama: 25,
};
const SEGMENT_MARGIN_DEFAULTS = [
  { segment: "eq_delivery", marginPct: 100, note: "full value deployed" },
  { segment: "eq_intraday", marginPct: 20, note: "5x intraday leverage" },
  { segment: "index_option", marginPct: 12, note: "short-option SPAN approx" },
  { segment: "stock_option", marginPct: 20, note: "short-option SPAN approx" },
  { segment: "future", marginPct: 15, note: "SPAN+exposure approx" },
  { segment: "commodity_future", marginPct: 10, note: "SPAN+exposure approx" },
  { segment: "commodity_option", marginPct: 12, note: "short-option SPAN approx" },
] as const;

export interface SeedMarginRow {
  broker: string;
  segment: string;
  marginPct: number;
  note: string;
}

/**
 * THE margin_config rows this build ships — one per broker × segment. The seed,
 * migration 0078 (hand-written; `tests/margin-config-refresh.test.ts` pins its
 * rows equal to these), both restore paths and the desktop launch refresh all
 * converge on this list.
 */
export const SEED_MARGIN_ROWS: readonly SeedMarginRow[] = Object.keys(EQ_MTF_OWN_MARGIN_BY_BROKER).flatMap((broker) => [
  { broker, segment: "eq_mtf", marginPct: EQ_MTF_OWN_MARGIN_BY_BROKER[broker], note: `${broker}'s advertised MTF leverage` },
  ...SEGMENT_MARGIN_DEFAULTS.map((row) => ({ broker, ...row })),
]);

/**
 * Add every `SEED_MARGIN_ROWS` row the table lacks — INSERT OR IGNORE on the
 * (broker, segment) unique key, so an existing row (edited or not, a user's
 * hand-added Fyers row included) is never touched. Returns the rows added.
 *
 * v4.6.0 fix wave (SM-1): the rows were seeded on a FRESH install only, so an
 * upgraded 4.5.0 database, a 4.5.0 backup restored into 4.6.0 and a default-
 * settings baseline saved on 4.5.0 (which DELETES the table and re-inserts its
 * snapshot) all lacked Fyers and Nuvama, and `capitalBlocked` priced their
 * futures and short options at an assumed 100% of notional (ROM off by up to
 * 6.7×) — the v2.96.0 kotakneo/paytm/sahi class again. Called by the seed and,
 * inside their transactions, by `restoreDatabase` (lib/backup.ts) and
 * `restoreBaseline` (lib/queries/settings-baseline.ts). Opens no transaction.
 */
export function refreshMarginConfig(conn: Pick<typeof db, "insert"> = db): number {
  let added = 0;
  for (const row of SEED_MARGIN_ROWS) added += conn.insert(marginConfig).values(row).onConflictDoNothing().run().changes;
  return added;
}

/**
 * The risk_config rows a fresh install starts with — one per scope Vyuha knows,
 * the eight segments of `lib/domain/constants.ts` included.
 *
 * v4.4.0 (D1): only the GLOBAL row seeds a per-trade cap (₹9,500, editable).
 * Bucket and segment rows seed it NULL with `capScheme` 1 — they INHERIT until
 * the user sets one (`resolvePerTradeCap`, lib/risk/limits.ts). v1–v4.3 stamped
 * the literal 9500 on every row, which made every segment look configured and
 * made the import (global only) and the breach checks (segment first) disagree
 * the moment the global cap was edited; those legacy rows keep a NULL
 * `capScheme` and the resolver reads their 9500 as unset.
 *
 * INSERT OR IGNORE on (scope, key): an existing row — edited or not — is never
 * touched. Called by `seedDatabase` and, inside its transaction, by "back to my
 * defaults" (lib/queries/settings-baseline.ts), whose snapshot may predate the
 * three rows migration 0073 added. Opens no transaction of its own.
 */
export function seedRiskConfig(conn: Pick<typeof db, "insert"> = db): number {
  const riskRows = [
    { scope: "global", key: "", perTradeMaxLoss: 9500, monthlyTargetBase: 425000, monthlyTargetStretch: 510000, capScheme: 1 },
    { scope: "bucket", key: "equity", perTradeMaxLoss: null, maxOpen: 6, maxTradesDay: 12, concentrationPct: 20, capScheme: 1 },
    { scope: "bucket", key: "active", perTradeMaxLoss: null, maxOpen: 8, maxTradesDay: 15, dailyLossStop: 25000, capScheme: 1 },
    { scope: "segment", key: "eq_delivery", perTradeMaxLoss: null, capScheme: 1 },
    { scope: "segment", key: "eq_mtf", perTradeMaxLoss: null, capScheme: 1 },
    { scope: "segment", key: "eq_intraday", perTradeMaxLoss: null, maxTradesDay: 12, capScheme: 1 },
    { scope: "segment", key: "index_option", perTradeMaxLoss: null, maxTradesDay: 15, capScheme: 1 },
    { scope: "segment", key: "stock_option", perTradeMaxLoss: null, maxTradesDay: 15, capScheme: 1 },
    { scope: "segment", key: "future", perTradeMaxLoss: null, capScheme: 1 },
    { scope: "segment", key: "commodity_future", perTradeMaxLoss: null, maxTradesDay: 10, capScheme: 1 },
    { scope: "segment", key: "commodity_option", perTradeMaxLoss: null, maxTradesDay: 10, capScheme: 1 },
  ];
  let added = 0;
  for (const row of riskRows) added += conn.insert(riskConfig).values(row).onConflictDoNothing().run().changes;
  return added;
}

/**
 * Bring charge_config up to the rate card this build ships, on `conn`.
 *
 * Rate rows are both ADDED and REFRESHED here.
 *
 * Adding alone was the bug: the seed ran once, on a fresh database, so every
 * broker and every corrected rate published after that never reached an
 * install — the app kept quoting figures it shipped with a year earlier.
 *
 * Refreshing skips any row the user edited (`userEdited`). Their number is
 * the one they verified against their own contract note, and overwriting it
 * on an app update would be the app silently disagreeing with the broker.
 *
 * Exported for the two restore paths (v4.3.0 R7). restoreDatabase and
 * restoreBaseline re-insert a rate card verbatim from a backup or a snapshot,
 * which may be older than this build, and the desktop refresh runs only at
 * sidecar start — so every import for the rest of the session priced from the
 * restored card. They call this inside their own transaction, right after the
 * re-insert. ATTACH (the desktop refresh's route) is impossible inside a
 * transaction, which is why the restores use this TypeScript pass; the parity
 * harness in tests/stt-epoch-2024.test.ts pins it equal to refreshRateCards().
 *
 * It opens no transaction of its own: seedDatabase() and the restores each
 * run it inside theirs, so a failure part-way rolls the whole pass back.
 */
export function refreshChargeConfig(conn: ChargeConn = db): ChargeRefreshReport {
  const report: ChargeRefreshReport = { added: 0, refreshed: 0, removed: 0 };

  /**
   * FIRST, a NON-edited epoch whose start falls inside a user-edited window of
   * the same broker/plan/segment/exchange is REMOVED (v4.3.0 R54; parity with
   * scripts/rate-card-refresh.mjs). The guard below stops the seed ADDING such
   * an epoch, but one already on file — the pre-v3.2.0 1970 stamp beside
   * v4.2.0's unguarded INSERT — stayed, and `findRates` picks the NEWEST
   * covering epoch, so it kept overriding the rate the user verified for every
   * trade dated on or after its start. Users edit rates, never dates
   * (app/api/settings/route.ts), so the user's window is the authority on
   * those dates, and the removed row is one the seed can always reproduce.
   * Windows are inclusive-from / exclusive-to; a NULL effective_to is open. An
   * empty user window (effective_to = effective_from) covers no date.
   */
  report.removed = conn.run(sql`DELETE FROM charge_config
    WHERE user_edited = 0
      AND EXISTS (SELECT 1 FROM charge_config u
        WHERE u.user_edited = 1
          AND u.broker = charge_config.broker AND u.plan IS charge_config.plan
          AND u.segment = charge_config.segment AND u.exchange = charge_config.exchange
          AND u.effective_from <= charge_config.effective_from
          AND (u.effective_to IS NULL OR u.effective_to > charge_config.effective_from))`).changes;

  for (const row of buildChargeConfigSeed()) {
    /**
     * A USER-EDITED row whose window covers this epoch's start owns every date
     * this row would claim, so the seed must not touch that key at all.
     *
     * `onConflictDoNothing` alone is not that guard: `effectiveFrom` is part of
     * the unique index (migration 0050), so a seed epoch (e.g. the 2026-04-01
     * F&O STT row) never CONFLICTS with a user-edited 1970-01-01→open row — it
     * inserts cleanly beside it, and `findRates` picks the NEWEST covering
     * epoch, silently shadowing the rates the user verified against their own
     * contract note for every trade dated ≥ its effectiveFrom. That is the
     * exact silent-rate-substitution the epoch work exists to prevent.
     *
     * The check sits BEFORE both the insert and the refresh below so the two
     * paths agree: a covered epoch is neither added nor refreshed. Windows are
     * inclusive-from / exclusive-to, and a null effectiveTo counts as open.
     * A user edit that covers only PART of history (a closed epoch) blocks only
     * the seed rows starting inside its window — the rest still refresh.
     */
    const from = row.effectiveFrom ?? "1970-01-01";
    const editedCover = conn
      .select({ id: chargeConfig.id })
      .from(chargeConfig)
      .where(
        and(
          eq(chargeConfig.broker, row.broker),
          eq(chargeConfig.plan, row.plan),
          eq(chargeConfig.segment, row.segment),
          eq(chargeConfig.exchange, row.exchange),
          eq(chargeConfig.userEdited, true),
          lte(chargeConfig.effectiveFrom, from),
          or(isNull(chargeConfig.effectiveTo), gt(chargeConfig.effectiveTo, from)),
        ),
      )
      .get();
    if (editedCover) continue;

    const inserted = conn.insert(chargeConfig).values(row).onConflictDoNothing().run().changes;
    report.added += inserted;
    if (inserted > 0) continue;

    /**
     * `effectiveFrom` is part of the identity (migration 0050) and MUST be in
     * this lookup. Without it, a key that now holds two dated epochs returns an
     * arbitrary one, and the update below would overwrite one epoch with the
     * other's rate — either colliding on the unique index or silently swapping
     * the pre- and post-2026 STT rows. Found by reading the seeder while adding
     * the second epoch, not by a test: no test seeds twice over a migrated DB.
     */
    const existing = conn
      .select()
      .from(chargeConfig)
      .where(
        and(
          eq(chargeConfig.broker, row.broker),
          eq(chargeConfig.plan, row.plan),
          eq(chargeConfig.segment, row.segment),
          eq(chargeConfig.exchange, row.exchange),
          eq(chargeConfig.effectiveFrom, row.effectiveFrom ?? "1970-01-01"),
        ),
      )
      .get();
    if (!existing || existing.userEdited) continue;

    const differs = (Object.keys(row) as (keyof typeof row)[]).some((k) => {
      const a = row[k];
      const b = (existing as Record<string, unknown>)[k];
      return typeof a === "object" && a !== null
        ? JSON.stringify(a) !== JSON.stringify(b)
        : a !== b;
    });
    if (!differs) continue;

    conn.update(chargeConfig).set(row).where(eq(chargeConfig.id, existing.id)).run();
    report.refreshed += 1;
  }
  return report;
}
