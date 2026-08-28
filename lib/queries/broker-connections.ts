import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, brokerConnections } from "@/lib/db/schema";
import { getSelectedAccountId } from "./accounts";
import { readSecret } from "@/lib/vault";
import { openAlgoConnectionId } from "@/lib/import/api/openalgo";
import type { Broker } from "@/lib/domain/constants";

/** A broker_connections row plus the display name of the account it lives in. */
export type BrokerConnectionRow = typeof brokerConnections.$inferSelect & {
  accountName: string | null;
};

/**
 * The broker connections visible in the CURRENT view — `accountId > 0 ? filter
 * : all` (invariant 8). The All-accounts view used to collapse to account 1
 * here, which hid every other account's connections from the Import page.
 *
 * Also runs the legacy `openalgo` → `openalgo:<underlying>` rename (the same
 * GET-time-migration pattern as the plaintext sweep). The rename is keyed on
 * the ROW's id, never on the resolved account: in the aggregate view several
 * accounts can each hold a legacy row, and an account-keyed update could
 * rename a row the loop never looked at.
 */
export function listBrokerConnections(): { aggregate: boolean; rows: BrokerConnectionRow[] } {
  const selected = getSelectedAccountId();
  const load = () => {
    const q = db.select().from(brokerConnections);
    return (selected > 0 ? q.where(eq(brokerConnections.accountId, selected)) : q)
      .orderBy(asc(brokerConnections.accountId), asc(brokerConnections.broker))
      .all();
  };
  let rows = load();
  let migrated = false;
  for (const r of rows) {
    if (r.broker !== "openalgo") continue;
    const auth = readSecret(r.authJson);
    if (!auth.ok || !auth.value) continue;
    try {
      const a = JSON.parse(auth.value) as { underlyingBroker?: string };
      if (a.underlyingBroker) {
        db.update(brokerConnections)
          .set({ broker: openAlgoConnectionId(a.underlyingBroker as Broker) })
          .where(eq(brokerConnections.id, r.id))
          .run();
        migrated = true;
      }
    } catch {
      // Unreadable blob, or the renamed id already exists on this account
      // (unique on account+broker) — leave the legacy row as it is.
    }
  }
  if (migrated) rows = load();
  const names = new Map(
    db.select({ id: accounts.id, name: accounts.name }).from(accounts).all().map((a) => [a.id, a.name]),
  );
  return {
    aggregate: selected === 0,
    rows: rows.map((r) => ({ ...r, accountName: names.get(r.accountId) ?? null })),
  };
}
