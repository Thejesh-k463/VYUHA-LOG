import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tradingSessions } from "@/lib/db/schema";
import { reviewSession } from "@/lib/analytics/session-review";
import { getAliasMap } from "./aliases";
import { getTrades } from "./trades";
import { getSelectedAccountId } from "./accounts";

export function getSessionsWithReview() {
  const allTrades = getTrades().map((t) => ({ id: t.id, symbol: t.symbol, playbookId: t.playbookId, entryDate: t.sellQty > t.buyQty ? t.sellDate : t.buyDate, entryTime: t.entryTime, netPnl: t.netPnl }));
  const accountId = getSelectedAccountId();
  const q = db.select().from(tradingSessions);
  // Alias map on BOTH review paths — without it an aliased symbol scores as
  // "traded outside the watchlist" (the bug the v3.5.0 canonicalisation fixed;
  // lib/queries/session-plan.ts passes the same map).
  const aliasMap = getAliasMap();
  return (accountId > 0 ? q.where(eq(tradingSessions.accountId, accountId)) : q).orderBy(desc(tradingSessions.sessionDate)).all().map((s) => ({ ...s, review: reviewSession(s, allTrades, aliasMap) }));
}
