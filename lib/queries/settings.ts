import "server-only";
import { db } from "@/lib/db";
import { settings, riskConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { Settings } from "@/lib/db/schema";

export function getSettings(): Settings | null {
  const rows = db.select().from(settings).limit(1).all();
  return rows[0] ?? null;
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
