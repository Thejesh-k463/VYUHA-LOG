import "server-only";
import { cache } from "react";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, settings } from "@/lib/db/schema";
export function getAccounts() { return db.select().from(accounts).orderBy(asc(accounts.archived), asc(accounts.name)).all(); }

/**
 * The account every scoped read filters on. 0 means the synthetic "All
 * accounts" aggregate.
 *
 * A stored 0 resolves to the sole account when only one exists: aggregating a
 * single account is just that account, so treating it as an aggregate bought
 * nothing and cost clarity — it left every install in a multi-account view it
 * had never asked for, which is what made writes ambiguous (see A6 / migration
 * 0035). Resolving here covers the cases the migration cannot: fresh installs
 * seeded after it ran, and users who delete a second account back down to one.
 */
// cache(): 26 call sites resolve the account per render (9 query modules each
// ask again). One request, one answer; a settings write runs in a different
// request, so the cache can never serve a stale id.
export const getSelectedAccountId = cache((): number => {
  const raw = db.select({ id: settings.selectedAccountId }).from(settings).limit(1).get()?.id ?? 0;
  if (raw > 0) return raw;
  const all = db.select({ id: accounts.id }).from(accounts).all();
  return all.length === 1 ? all[0].id : 0;
});

/** True when the user is genuinely looking at more than one account at once. */
export function isAggregateView(): boolean { return getSelectedAccountId() === 0; }

/**
 * Where a mutation lands. Writes need a real account — 0 is a view, not a
 * place. Callers that can ask the user (the add-trade form, the importer) pass
 * an explicit id; this fallback is for the ones that cannot.
 */
export function getWriteAccountId(explicit?: number | null): number {
  if (explicit != null && Number.isInteger(explicit) && explicit > 0) {
    if (db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, explicit)).get()) return explicit;
  }
  const id = getSelectedAccountId();
  if (id > 0) return id;
  return db.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.id)).limit(1).get()?.id ?? 1;
}
export function getSelectedAccount() { const id=getSelectedAccountId(); return id > 0 ? db.select().from(accounts).where(eq(accounts.id,id)).get() ?? null : null; }
