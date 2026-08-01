import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tradingSessions } from "@/lib/db/schema";
import { reviewSession } from "@/lib/analytics/session-review";
import { getTrades } from "./trades";
import { getSelectedAccountId } from "./accounts";

export function getSessionsWithReview() {
  const allTrades = getTrades().map((t) => ({ id: t.id, symbol: t.symbol, playbookId: t.playbookId, entryDate: t.sellQty > t.buyQty ? t.sellDate : t.buyDate, entryTime: t.entryTime, netPnl: t.netPnl }));
  const accountId = getSelectedAccountId();
  const q = db.select().from(tradingSessions);
  return (accountId > 0 ? q.where(eq(tradingSessions.accountId, accountId)) : q).orderBy(desc(tradingSessions.sessionDate)).all().map((s) => ({ ...s, review: reviewSession(s, allTrades) }));
}
