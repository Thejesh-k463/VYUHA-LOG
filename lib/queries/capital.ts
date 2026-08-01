import "server-only";
import { db } from "@/lib/db";
import { capitalSnapshots } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import type { Bucket } from "@/lib/domain/constants";
import { getSettings } from "./settings";
import { getIpoRealisedNet } from "./ipos";
import { getSelectedAccount, getSelectedAccountId } from "./accounts";
import { getTrades } from "./trades";

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
  const s = getSettings();
  const closed = getTrades().filter((t)=>!t.isOpen);
  const account = getSelectedAccount();
  const equityRealised = r2(closed.filter((t) => t.bucket === "equity").reduce((a, t) => a + t.netPnl, 0));
  const activeRealised = r2(closed.filter((t) => t.bucket === "active").reduce((a, t) => a + t.netPnl, 0));
  const ipoRealised = r2(getIpoRealisedNet());
  const totalRealised = r2(equityRealised + activeRealised + ipoRealised);
  const rolledIn = s?.pnlRolledIn ?? 0;
  return {
    equityCapital: account?.equityCapital ?? s?.equityCapital ?? 0,
    activeCapital: account?.activeCapital ?? s?.activeCapital ?? 0,
    totalCapital: (account?.equityCapital ?? s?.equityCapital ?? 0) + (account?.activeCapital ?? s?.activeCapital ?? 0),
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
    const today = new Date().toISOString().slice(0, 10);
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
