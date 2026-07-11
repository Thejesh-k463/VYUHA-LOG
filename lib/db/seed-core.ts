import { db } from "./index";
import { capitalSnapshots, chargeConfig, marginConfig, riskConfig, settings } from "./schema";
import { buildChargeConfigSeed } from "./seed-data";

const GO_LIVE = "2026-06-19";
const EQUITY_CAPITAL = 1_300_000;
const ACTIVE_CAPITAL = 400_000;

export interface SeedReport {
  settings: "seeded" | "kept";
  capitalSnapshots: "seeded" | "kept";
  chargeAdded: number;
  riskAdded: number;
}

/** Idempotent, non-destructive seed of config tables. Returns what changed. */
export function seedDatabase(log = false): SeedReport {
  const report: SeedReport = {
    settings: "kept",
    capitalSnapshots: "kept",
    chargeAdded: 0,
    riskAdded: 0,
  };
  const say = (m: string) => log && console.log(m);

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

  for (const row of buildChargeConfigSeed()) {
    report.chargeAdded += db.insert(chargeConfig).values(row).onConflictDoNothing().run().changes;
  }
  say(`✓ charge_config: ${report.chargeAdded} added`);

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

  // Margin-rate approximations (% of notional) for the /risk margin gauge —
  // editable there; these are typical SPAN+exposure ballparks, not statutory.
  const marginRows = [
    { segment: "eq_delivery", marginPct: 100, note: "full value deployed" },
    { segment: "eq_mtf", marginPct: 25, note: "own-funds portion" },
    { segment: "eq_intraday", marginPct: 20, note: "5x intraday leverage" },
    { segment: "index_option", marginPct: 12, note: "short-option SPAN approx" },
    { segment: "stock_option", marginPct: 20, note: "short-option SPAN approx" },
    { segment: "future", marginPct: 15, note: "SPAN+exposure approx" },
    { segment: "commodity_future", marginPct: 10, note: "SPAN+exposure approx" },
    { segment: "commodity_option", marginPct: 12, note: "short-option SPAN approx" },
  ] as const;
  for (const row of marginRows) {
    db.insert(marginConfig).values(row).onConflictDoNothing().run();
  }
  say("✓ margin_config seeded");

  return report;
}
