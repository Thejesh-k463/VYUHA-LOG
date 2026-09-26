import "server-only";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, trades } from "@/lib/db/schema";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { getAccountsWithoutPlan } from "@/lib/queries/data-quality";
import type { GettingStartedServerFacts } from "@/lib/domain/getting-started";

/**
 * The server half of the dashboard's getting-started strip (v4.6.0 W4, row 9.5).
 *
 * SCOPE (invariant 8): trades and "a stop recorded" read the SELECTED account
 * through `getSelectedAccountId()` and apply `accountId > 0 ? filter : all`, so
 * the All-accounts view (0) reads every account and a single account reads only
 * its own rows. The accounts COUNT is global — an account is not inside a book.
 * "Charges plan set" is done when NO account in scope is flagged by
 * `getAccountsWithoutPlan()` — Data Quality's own list, so the strip and the
 * DQ issue can never disagree (v4.6.0 audit DA-1). It used to require
 * `broker_plan IS NOT NULL`, which never ticked on the common path: choosing
 * the default plan saves null, and a one-plan broker has no plan editor at all.
 * The selected account alone in a single-account view; every account in the
 * All-accounts view. With no account in scope there is nothing to price, so the
 * step is not done.
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
  const inScope = db.select({ id: accounts.id }).from(accounts).where(accountScope).limit(1).get();
  const flagged = getAccountsWithoutPlan().some((a) => accountId <= 0 || a.id === accountId);

  return { accounts: accountCount, trades: tradeCount, planSet: inScope != null && !flagged, stopRecorded: stop != null };
}
