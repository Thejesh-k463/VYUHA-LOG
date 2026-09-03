import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, trades } from "@/lib/db/schema";
import { BROKERS, type Broker } from "@/lib/domain/constants";

/**
 * What each broker has put into one account's book — the numbers the import
 * page shows BEFORE the user confirms a broker-scoped remove (v3.8 W2a).
 *
 * ── Why the account is an explicit parameter ────────────────────────────────
 *
 * Every ordinary scoped read resolves the account through
 * `getSelectedAccountId()` (invariant 8). This module deliberately does not:
 * the subject of the operation IS an account — the user is about to destroy
 * one broker's rows in one book and re-import the file — so the id travels in
 * the request and is validated here, the same shape as
 * `lib/queries/account-delete.ts`. The aggregate view (0) is refused before
 * anything is read, and `getWriteAccountId` is never consulted: its fallback
 * resolves an ambiguous 0 to SOME account, which is the one answer a
 * destructive operation must never accept.
 */

export type ImportSourceErrorCode =
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_NOT_FOUND"
  | "BROKER_REQUIRED"
  | "NO_ROWS";

/** A refusal the route can map to a status without parsing prose. */
export class ImportSourceError extends Error {
  readonly code: ImportSourceErrorCode;
  readonly status: 400 | 404;
  constructor(code: ImportSourceErrorCode, message: string) {
    super(message);
    this.name = "ImportSourceError";
    this.code = code;
    this.status = code === "ACCOUNT_NOT_FOUND" || code === "NO_ROWS" ? 404 : 400;
  }
}

/** A real account id: a positive integer. 0 is a view, never a write target
 *  (invariant 9); a missing or non-numeric value is the same refusal. */
export function assertAccountId(raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new ImportSourceError("ACCOUNT_REQUIRED", "Pick the account first — “All accounts” is a view, not a place to remove from.");
  }
  return n;
}

/** The account must still exist — an id from a stale tab is refused, not
 *  resolved to a neighbour. */
export function assertAccountExists(accountId: number): number {
  if (!db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).get()) {
    throw new ImportSourceError("ACCOUNT_NOT_FOUND", `Account ${accountId} no longer exists. Nothing was changed.`);
  }
  return accountId;
}

export function assertBroker(raw: unknown): Broker {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!(BROKERS as readonly string[]).includes(s)) {
    throw new ImportSourceError("BROKER_REQUIRED", "Pick which broker's rows to remove.");
  }
  return s as Broker;
}

export interface BrokerTradeCount {
  broker: string;
  trades: number;
  closed: number;
  open: number;
  /** Earliest / latest trade date across buy and sell dates; null when no row carries a date. */
  earliest: string | null;
  latest: string | null;
}

/**
 * Per-broker counts for one account, brokers sorted alphabetically. An
 * account with no trades returns []. Throws `ImportSourceError` on 0/missing.
 */
export function countTradesByBroker(accountIdIn: unknown): BrokerTradeCount[] {
  const accountId = assertAccountExists(assertAccountId(accountIdIn));
  const rows = db
    .select({ broker: trades.broker, isOpen: trades.isOpen, buyDate: trades.buyDate, sellDate: trades.sellDate })
    .from(trades)
    .where(eq(trades.accountId, accountId))
    .all();

  const by = new Map<string, BrokerTradeCount>();
  for (const r of rows) {
    let c = by.get(r.broker);
    if (!c) {
      c = { broker: r.broker, trades: 0, closed: 0, open: 0, earliest: null, latest: null };
      by.set(r.broker, c);
    }
    c.trades++;
    if (r.isOpen) c.open++;
    else c.closed++;
    for (const d of [r.buyDate, r.sellDate]) {
      if (!d) continue;
      if (c.earliest === null || d < c.earliest) c.earliest = d;
      if (c.latest === null || d > c.latest) c.latest = d;
    }
  }
  return [...by.values()].sort((a, b) => a.broker.localeCompare(b.broker));
}
