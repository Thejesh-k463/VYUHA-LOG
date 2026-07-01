import "server-only";
import { db } from "@/lib/db";
import { corporateActions } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import type { CorporateAction } from "@/lib/db/schema";

export function getCorporateActions(): CorporateAction[] {
  return db.select().from(corporateActions).orderBy(desc(corporateActions.exDate)).all();
}
