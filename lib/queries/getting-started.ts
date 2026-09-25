import "server-only";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, trades } from "@/lib/db/schema";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import type { GettingStartedServerFacts } from "@/lib/domain/getting-started";

/**
 * The server half of the dashboard's getting-started strip (v4.6.0 W4, row 9.5).
 *
 * SCOPE (invariant 8): trades and "a stop recorded" read the SELECTED account
 * through `getSelectedAccountId()` and apply `accountId > 0 ? filter : all`, so
 * the All-accounts view (0) reads every account and a single account reads only
 * its own rows. The accounts COUNT is global — an account is not inside a book.
 * "Charges plan set" reads the selected account's `broker_plan`; in the
 * All-accounts view any account stating a plan counts.
 *
 * Read-only: nothing here writes, so invariant 9 does not arise.
 */
export function getGettingStartedFacts(): GettingStartedServerFacts {
  const accountId = getSelectedAccountId();
  const tradeScope = accountId > 0 ? eq(trades.accountId, accountId) : undefined;
  const accountScope = accountId > 0 ? eq(accounts.id, accountId) : undefined;

  const accountCount = db.select({ n: count() }).from(accounts).get()?.n ?? 0;
  const tradeCount = db.select({ n: count() }).from(trades).where(tradeScope).get()?.n ?? 0;
  const stop = db
    .select({ id: trades.id })
    .from(trades)
    .where(and(tradeScope, isNotNull(trades.slPlanned)))
    .limit(1)
    .get();
  const plan = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(accountScope, isNotNull(accounts.brokerPlan)))
    .limit(1)
    .get();

  return { accounts: accountCount, trades: tradeCount, planSet: plan != null, stopRecorded: stop != null };
}
