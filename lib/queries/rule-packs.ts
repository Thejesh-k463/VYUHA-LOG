import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { regulatoryRulePacks } from "@/lib/db/schema";
import { DEFAULT_RADAR_RULES, type RadarRules } from "@/lib/risk/sebi-radar";

export function getRulePacks() {
  const cutoff = Date.now() - 120 * 86400000;
  return db.select().from(regulatoryRulePacks).orderBy(desc(regulatoryRulePacks.effectiveFrom)).all()
    .map((p) => ({ ...p, reviewDue: !p.reviewedAt || new Date(p.reviewedAt).getTime() < cutoff }));
}
export function getActiveRadarRules(): RadarRules {
  const row = db.select().from(regulatoryRulePacks).where(eq(regulatoryRulePacks.code, "sebi-equity-derivatives")).orderBy(desc(regulatoryRulePacks.effectiveFrom)).all().find((x) => x.active);
  if (!row) return DEFAULT_RADAR_RULES;
  const p = row.payload;
  return { ...DEFAULT_RADAR_RULES, ...(p as Partial<RadarRules>) };
}
