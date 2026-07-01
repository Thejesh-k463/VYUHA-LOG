import "server-only";
import { db } from "@/lib/db";
import { benchmarkPrices } from "@/lib/db/schema";
import { asc, eq } from "drizzle-orm";
import type { BenchClose } from "@/lib/analytics/benchmark";

export const DEFAULT_BENCHMARK = "NIFTY";

/** Date-sorted close series for a benchmark symbol (default NIFTY). */
export function getBenchmarkCloses(symbol = DEFAULT_BENCHMARK): BenchClose[] {
  return db
    .select({ date: benchmarkPrices.date, close: benchmarkPrices.close })
    .from(benchmarkPrices)
    .where(eq(benchmarkPrices.symbol, symbol.toUpperCase()))
    .orderBy(asc(benchmarkPrices.date))
    .all();
}

/** Coverage summary for the loaded benchmark (for the UI status line). */
export function getBenchmarkMeta(symbol = DEFAULT_BENCHMARK): { count: number; first: string | null; last: string | null } {
  const rows = getBenchmarkCloses(symbol);
  return {
    count: rows.length,
    first: rows[0]?.date ?? null,
    last: rows[rows.length - 1]?.date ?? null,
  };
}
