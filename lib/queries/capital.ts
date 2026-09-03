import { todayIstIso } from "@/lib/domain/trading-day";
import "server-only";
import { db } from "@/lib/db";
import { accounts, capitalSnapshots } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { Bucket } from "@/lib/domain/constants";
import { getSettings } from "./settings";
import { getIpoRealisedNet } from "./ipos";
import { getSelectedAccount, getSelectedAccountId } from "./accounts";
import { getTrades } from "./trades";
import { getBucketCapital } from "./bucket-capital";

// Re-exported so the dozen existing `from "@/lib/queries/capital"` importers
// keep working after the helper moved to its own module (see the header of
// ./bucket-capital for why it had to move).
export { getBucketCapital };
export type { BucketCapital } from "./bucket-capital";

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CapitalSummary {
  equityCapital: number;
  activeCapital: number;
  totalCapital: number;
  equityRealised: number; // closed equity-bucket trade net
  activeRealised: number; // closed active-bucket trade net
  ipoRealised: number; // exited IPO net
  totalRealised: number;
  rolledIn: number; // already compounded
  available: number; // realised not yet compounded
}

export function getCapitalSummary(): CapitalSummary {
  const closed = getTrades().filter((t)=>!t.isOpen);
  const account = getSelectedAccount();
  const cap = getBucketCapital();
  const equityRealised = r2(closed.filter((t) => t.bucket === "equity").reduce((a, t) => a + t.netPnl, 0));
  const activeRealised = r2(closed.filter((t) => t.bucket === "active").reduce((a, t) => a + t.netPnl, 0));
  const ipoRealised = r2(getIpoRealisedNet());
  const totalRealised = r2(equityRealised + activeRealised + ipoRealised);
  // Rolled-in is PER-ACCOUNT (migration 0044): the aggregate view sums every
  // account's marker, matching how its realised figures are themselves sums.
  const rolledIn =
    account?.pnlRolledIn ??
    r2(db.select({ v: accounts.pnlRolledIn }).from(accounts).all().reduce((a, r) => a + r.v, 0));
  return {
    equityCapital: cap.equityCapital,
    activeCapital: cap.activeCapital,
    totalCapital: cap.totalCapital,
    equityRealised,
    activeRealised,
    ipoRealised,
    totalRealised,
    rolledIn,
    available: r2(totalRealised - rolledIn),
  };
}

export interface CapitalHistoryPoint {
  date: string;
  equity: number | null;
  active: number | null;
}

/** Capital checkpoints over time (one row per snapshot date, per-bucket columns). */
export function getCapitalHistory(): CapitalHistoryPoint[] {
  const accountId=getSelectedAccountId(); const q=db.select().from(capitalSnapshots); const rows=(accountId>0?q.where(eq(capitalSnapshots.accountId,accountId)):q).orderBy(capitalSnapshots.asOfDate).all();
  const byDate = new Map<string, CapitalHistoryPoint>();
  for (const r of rows) {
    const p = byDate.get(r.asOfDate) ?? { date: r.asOfDate, equity: null, active: null };
    if (r.bucket === "equity") p.equity = r.openingCapital;
    else if (r.bucket === "active") p.active = r.openingCapital;
    byDate.set(r.asOfDate, p);
  }
  // Append today's live capitals so the chart always ends at the current state.
  const s = getSettings();
  if (s) {
    const today = todayIstIso();
    const last = byDate.get(today) ?? { date: today, equity: null, active: null };
    const account=getSelectedAccount(); last.equity = account?.equityCapital ?? s.equityCapital;
    last.active = account?.activeCapital ?? s.activeCapital;
    byDate.set(today, last);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function getOpeningSnapshot(bucket: Bucket) {
  const accountId=getSelectedAccountId();
  return (
    db
      .select()
      .from(capitalSnapshots)
      .where(accountId>0?and(eq(capitalSnapshots.accountId,accountId),eq(capitalSnapshots.bucket, bucket)):eq(capitalSnapshots.bucket,bucket))
      .orderBy(capitalSnapshots.asOfDate)
      .all()[0] ?? null
  );
}

export function getTradeCount(): number {
  return getTrades().length;
}

export interface CompoundResult {
  ok: boolean;
  message: string;
  added?: number;
  bucket?: Bucket;
}

/**
 * Compound this account's un-compounded realised P&L into its bucket capital.
 *
 * PER-ACCOUNT on both sides (migration 0044). The old implementation wrote
 * the GLOBAL settings row while `getCapitalSummary` read the account row
 * first — "Compounded +₹X", no visible change, and the global rolled-in
 * marker burned every other account's un-compounded P&L with it.
 *
 * The aggregate view is refused, not resolved: its `available` sums EVERY
 * account's realised P&L, and compounding a cross-account figure into any
 * single account would move money between books (invariant 9).
 */
export function compoundRealised(bucket: Bucket): CompoundResult {
  const accountId = getSelectedAccountId();
  if (accountId === 0) {
    return {
      ok: false,
      message: "Compounding needs a single account — its realised P&L would land in that account's capital. Pick one in the sidebar first.",
    };
  }

  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  const s = getSettings();
  if (!account || !s) return { ok: false, message: "Account or settings not found" };

  // getCapitalSummary is scoped through the same getSelectedAccountId, so
  // `available` here is THIS account's un-compounded P&L only.
  const summary = getCapitalSummary();
  const add = summary.available;
  if (Math.abs(add) < 0.005) return { ok: false, message: "No new realised P&L to compound." };
  // A negative figure means the rolled-in marker exceeds realised P&L (e.g. a
  // marker inherited from a state an old merge produced). Compounding it would
  // silently WITHDRAW capital — refuse instead of moving money.
  if (add < 0) {
    return {
      ok: false,
      message: `Realised P&L is ₹${Math.abs(Math.round(add)).toLocaleString("en-IN")} below the rolled-in marker — compounding now would withdraw capital, so nothing was changed. If this account's capital really changed, edit it in Settings instead.`,
    };
  }

  // The account may not carry its own capital yet (NULL falls back to the
  // settings figure on reads). Compounding materialises it onto the account,
  // which is where the read will look next render.
  const baseEquity = account.equityCapital ?? s.equityCapital;
  const baseActive = account.activeCapital ?? s.activeCapital;
  const newEquity = bucket === "equity" ? r2(baseEquity + add) : baseEquity;
  const newActive = bucket === "active" ? r2(baseActive + add) : baseActive;

  db.update(accounts)
    .set({ equityCapital: newEquity, activeCapital: newActive, pnlRolledIn: summary.totalRealised })
    .where(eq(accounts.id, accountId))
    .run();

  // A capital checkpoint for history — scoped to the account it belongs to.
  db.insert(capitalSnapshots)
    .values({
      accountId,
      bucket,
      asOfDate: todayIstIso(),
      openingCapital: bucket === "equity" ? newEquity : newActive,
      deployed: 0,
      available: bucket === "equity" ? newEquity : newActive,
      realisedPnlToDate: summary.totalRealised,
    })
    .run();

  return {
    ok: true,
    message: `Compounded ${add >= 0 ? "+" : ""}₹${Math.round(add).toLocaleString("en-IN")} into ${bucket} capital.`,
    added: add,
    bucket,
  };
}
