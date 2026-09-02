import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "./index";
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
  riskAdded: number;
}

/** Idempotent, non-destructive seed of config tables. Returns what changed. */
export function seedDatabase(log = false): SeedReport {
  const report: SeedReport = {
    settings: "kept",
    capitalSnapshots: "kept",
    chargeAdded: 0,
    chargeRefreshed: 0,
    riskAdded: 0,
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

  /*
   * Rate rows are both ADDED and REFRESHED here.
   *
   * Adding alone was the bug: the seed ran once, on a fresh database, so every
   * broker and every corrected rate published after that never reached an
   * install — the app kept quoting figures it shipped with a year earlier.
   *
   * Refreshing skips any row the user edited (`userEdited`). Their number is
   * the one they verified against their own contract note, and overwriting it
   * on an app update would be the app silently disagreeing with the broker.
   */
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
    const editedCover = db
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

    const inserted = db.insert(chargeConfig).values(row).onConflictDoNothing().run().changes;
    report.chargeAdded += inserted;
    if (inserted > 0) continue;

    /**
     * `effectiveFrom` is part of the identity (migration 0050) and MUST be in
     * this lookup. Without it, a key that now holds two dated epochs returns an
     * arbitrary one, and the update below would overwrite one epoch with the
     * other's rate — either colliding on the unique index or silently swapping
     * the pre- and post-2026 STT rows. Found by reading the seeder while adding
     * the second epoch, not by a test: no test seeds twice over a migrated DB.
     */
    const existing = db
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

    db.update(chargeConfig).set(row).where(eq(chargeConfig.id, existing.id)).run();
    report.chargeRefreshed += 1;
  }
  say(
    `✓ charge_config: ${report.chargeAdded} added, ${report.chargeRefreshed} refreshed` +
      ` (user-edited rows left untouched)`,
  );

  const riskRows = [
    { scope: "global", key: "", perTradeMaxLoss: 9500, monthlyTargetBase: 425000, monthlyTargetStretch: 510000 },
    { scope: "bucket", key: "equity", perTradeMaxLoss: 9500, maxOpen: 6, maxTradesDay: 12, concentrationPct: 20 },
    { scope: "bucket", key: "active", perTradeMaxLoss: 9500, maxOpen: 8, maxTradesDay: 15, dailyLossStop: 25000 },
    { scope: "segment", key: "index_option", perTradeMaxLoss: 9500, maxTradesDay: 15 },
    { scope: "segment", key: "stock_option", perTradeMaxLoss: 9500, maxTradesDay: 15 },
    { scope: "segment", key: "eq_intraday", perTradeMaxLoss: 9500, maxTradesDay: 12 },
    { scope: "segment", key: "commodity_future", perTradeMaxLoss: 9500, maxTradesDay: 10 },
    { scope: "segment", key: "commodity_option", perTradeMaxLoss: 9500, maxTradesDay: 10 },
  ] as const;
  for (const row of riskRows) {
    report.riskAdded += db.insert(riskConfig).values(row).onConflictDoNothing().run().changes;
  }
  say(`✓ risk_config: ${report.riskAdded} added`);

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
  const marginRows: { broker: string; segment: string; marginPct: number; note: string }[] = [];
  for (const broker of Object.keys(EQ_MTF_OWN_MARGIN_BY_BROKER)) {
    marginRows.push({ broker, segment: "eq_mtf", marginPct: EQ_MTF_OWN_MARGIN_BY_BROKER[broker], note: `${broker}'s advertised MTF leverage` });
    for (const row of SEGMENT_MARGIN_DEFAULTS) marginRows.push({ broker, ...row });
  }
  for (const row of marginRows) {
    db.insert(marginConfig).values(row).onConflictDoNothing().run();
  }
  say("✓ margin_config seeded (broker-specific)");

  const rulePacks = [
    { code: "sebi-equity-derivatives", category: "regulatory", version: "2025.09", effectiveFrom: "2025-09-01", title: "SEBI equity-index derivatives monitoring", sourceTitle: "SEBI — Framework for Intraday Position Limits Monitoring", sourceUrl: "https://www.sebi.gov.in/legal/circulars/sep-2025/framework-for-intraday-position-limits-monitoring-for-equity-index-derivatives_97031.html", payload: { weeklyExpiryIndex: { NSE: "NIFTY", BSE: "SENSEX" }, monthlyOnlyIndexes: ["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"], netIndexLimit: 15000000000, grossIndexLimit: 100000000000, expiryDayElmPct: 2, limitMetric: "future_equivalent" } },
    { code: "broker-rate-cards", category: "pricing", version: "2026.08", effectiveFrom: "2026-08-01", title: "Broker pricing and MTF assumptions", sourceTitle: "Broker-published rate cards; individually editable in Settings", sourceUrl: "https://github.com/Thejesh-k463/VYUHA-LOG/blob/main/lib/db/seed-data.ts", payload: { key: "broker × plan × segment × exchange", userEditedRowsPinned: true, statutoryRounding: "STT/CTT and stamp to nearest rupee", mtfBasis: "broker-funded principal only" } },
  ];
  for (const row of rulePacks) db.insert(regulatoryRulePacks).values(row).onConflictDoNothing().run();
  say("✓ regulatory_rule_packs seeded");

  return report;
}
