import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, settings } from "@/lib/db/schema";
export function getAccounts() { return db.select().from(accounts).orderBy(asc(accounts.archived), asc(accounts.name)).all(); }
export function getSelectedAccountId(): number { return db.select({ id: settings.selectedAccountId }).from(settings).limit(1).get()?.id ?? 0; }
/** Mutations cannot target the synthetic "All accounts" view; use Primary. */
export function getWriteAccountId(): number { const id=getSelectedAccountId(); return id > 0 ? id : 1; }
export function getSelectedAccount() { const id=getSelectedAccountId(); return id > 0 ? db.select().from(accounts).where(eq(accounts.id,id)).get() ?? null : null; }
