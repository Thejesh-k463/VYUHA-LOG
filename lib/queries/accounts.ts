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
  // LIVE accounts only: one live + one archived is a single-account book, not
  // an aggregate — counting the archived one silently dropped such users into
  // the All-accounts view nobody asked for (defect D8, 2026-08-12).
  const live = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.archived, false)).all();
  return live.length === 1 ? live[0].id : 0;
});

/** True when the user is genuinely looking at more than one account at once. */
export function isAggregateView(): boolean { return getSelectedAccountId() === 0; }

/**
 * Thrown when a write has no account to land on: an explicit 0, or no
 * argument while the selection is the "All accounts" aggregate. `code` is the
 * stable wire value a route maps to HTTP 400.
 */
export class AccountRequiredError extends Error {
  readonly code = "ACCOUNT_REQUIRED" as const;
  constructor(detail: string) {
    super(`Choose the account this write belongs to — ${detail}. The All-accounts view (0) is a view, never a write target.`);
    this.name = "AccountRequiredError";
  }
}

/**
 * Where a mutation lands. Writes need a real account — 0 is a view, not a
 * place (invariant 9).
 *
 * Resolution, in order: an explicit id that names a real account (archived
 * included — a past session on a closed book stays editable) wins; otherwise
 * the selected account, when one is selected. There is NO further fallback.
 * The previous last resort — the lowest live account id, then a hard-coded 1
 * — filed writes made from the All-accounts view against whichever account
 * sorted first, and five callers grew a pre-check to route around it (owner
 * ruling 2026-09-04: refuse explicit AND implied 0).
 *
 * @throws AccountRequiredError for an explicit 0, and for no usable explicit
 *   id while the selection is 0/unset. Routes catch it and answer 400 with
 *   `code: "ACCOUNT_REQUIRED"` (or the house 403 aggregate refusal).
 */
export function getWriteAccountId(explicit?: number | null): number {
  if (explicit === 0) throw new AccountRequiredError("0 was passed explicitly");
  if (explicit != null && Number.isInteger(explicit) && explicit > 0) {
    if (db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, explicit)).get()) return explicit;
  }
  const id = getSelectedAccountId();
  if (id > 0) return id;
  throw new AccountRequiredError(
    explicit == null ? "no account is selected" : `account ${explicit} does not exist and no account is selected`,
  );
}
export function getSelectedAccount() { const id=getSelectedAccountId(); return id > 0 ? db.select().from(accounts).where(eq(accounts.id,id)).get() ?? null : null; }
