import "server-only";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { getTrades } from "@/lib/queries/trades";
import { getBucketCapital } from "@/lib/queries/bucket-capital";
import { SEGMENT_BUCKET, type Segment } from "@/lib/domain/constants";
import type { RiskRules, PortfolioState } from "@/lib/risk/limits";

type RiskConfigRow = typeof riskConfig.$inferSelect;

/**
 * Resolve the effective rule set for a bucket+segment by overlaying, per field,
 * the most specific configured value: global < bucket < segment. A null at a more
 * specific scope does NOT clear a broader value (it just doesn't override).
 */
export function resolveRules(bucket: string, segment: string): RiskRules {
  const rows = db.select().from(riskConfig).all();
  const pick = (scope: string, key: string) => rows.find((r) => r.scope === scope && r.key === key);
  const layers: (RiskConfigRow | undefined)[] = [
    pick("global", ""),
    bucket ? pick("bucket", bucket) : undefined,
    segment ? pick("segment", segment) : undefined,
  ];

  const field = <K extends keyof RiskConfigRow>(k: K): RiskConfigRow[K] | null => {
    let v: RiskConfigRow[K] | null = null;
    for (const layer of layers) {
      if (layer && layer[k] != null) v = layer[k];
    }
    return v;
  };

  return {
    perTradeMaxLoss: field("perTradeMaxLoss") as number | null,
    dailyLossStop: field("dailyLossStop") as number | null,
    maxOpen: field("maxOpen") as number | null,
    maxTradesDay: field("maxTradesDay") as number | null,
    concentrationPct: field("concentrationPct") as number | null,
  };
}

/** Capital for a bucket scope ("" / "all" → both buckets combined).
 *  0 means NOT CONFIGURED (a clean install seeds exactly that) — never a
 *  stand-in number. The old ₹13L/₹4L fallbacks made the concentration check
 *  compute a % of fictional capital on every fresh install (invariant 6);
 *  `evaluateLimits` now reports that rule as "skipped" instead.
 *
 *  ACCOUNT-FIRST (v3.7): `getPortfolioState` counts the SELECTED account's open
 *  positions, so the concentration limit must divide by that account's capital —
 *  the global settings row let a small account inherit a large one's headroom
 *  and pass a check it should have failed. Imported from ./bucket-capital, not
 *  ./capital, so the pre-trade path does not inherit the ipos import graph. */
function bucketCapital(bucket: string): number {
  const cap = getBucketCapital();
  if (bucket === "equity") return cap.equityCapital;
  if (bucket === "active") return cap.activeCapital;
  return cap.totalCapital;
}

/**
 * Live portfolio state for the pre-trade check, scoped to the order's bucket.
 * @param bucket  equity | active | "" (all)
 * @param symbol  canonical symbol of the prospective order
 * @param today   ISO date (defaults to now)
 */
export function getPortfolioState(bucket: string, symbol: string, today = new Date().toISOString().slice(0, 10)): PortfolioState {
  const all = getTrades();
  const inBucket = bucket ? all.filter((t) => t.bucket === bucket) : all;
  const sym = symbol.trim().toUpperCase();

  const open = inBucket.filter((t) => t.isOpen);
  const openCount = open.length;

  const tradesToday = inBucket.filter((t) => t.buyDate === today || t.sellDate === today).length;

  const netToday = inBucket
    .filter((t) => !t.isOpen && t.sellDate === today)
    .reduce((s, t) => s + t.netPnl, 0);
  const realisedLossToday = netToday < 0 ? -netToday : 0;

  const existingSymbolValue = open
    .filter((t) => t.symbol.toUpperCase() === sym || t.tradingsymbol.toUpperCase() === sym)
    .reduce((s, t) => {
      const qty = Math.max(t.buyQty - t.sellQty, 0) || t.buyQty;
      return s + qty * t.avgBuyPrice;
    }, 0);

  return {
    capital: bucketCapital(bucket),
    openCount,
    tradesToday,
    realisedLossToday: Math.round(realisedLossToday * 100) / 100,
    existingSymbolValue: Math.round(existingSymbolValue * 100) / 100,
  };
}

/** Best-effort bucket for a segment when the caller didn't classify one. */
export function bucketForSegment(segment: string): string {
  return SEGMENT_BUCKET[segment as Segment] ?? "";
}
