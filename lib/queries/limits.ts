import "server-only";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { getTrades } from "@/lib/queries/trades";
import { getSettings } from "@/lib/queries/settings";
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

/** Capital for a bucket scope ("" / "all" → both buckets combined). */
function bucketCapital(bucket: string): number {
  const s = getSettings();
  const eq = s?.equityCapital ?? 1300000;
  const ac = s?.activeCapital ?? 400000;
  if (bucket === "equity") return eq;
  if (bucket === "active") return ac;
  return eq + ac;
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
