import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { settings, riskConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { Settings } from "@/lib/db/schema";
import { riskFreeOf, type RiskFree } from "@/lib/domain/risk-free";

export const getSettings = cache((): Settings | null => {
  const rows = db.select().from(settings).limit(1).all();
  return rows[0] ?? null;
});

/**
 * THE risk-free rate (v4.4.0 D5) — the one dated setting Sharpe, Sortino,
 * alpha and the option Greeks all read. No settings row → Vyuha's 7% default,
 * labelled as such ("7% · Vyuha default"), never presented as a market quote.
 */
export function getRiskFree(): RiskFree {
  const s = getSettings();
  return riskFreeOf(s?.riskFreeRatePpm, s?.riskFreeAsOf);
}

export function getGlobalRisk() {
  return (
    db
      .select()
      .from(riskConfig)
      .where(eq(riskConfig.scope, "global"))
      .limit(1)
      .all()[0] ?? null
  );
}
