import "server-only";
import { db } from "@/lib/db";
import { capitalSnapshots, trades } from "@/lib/db/schema";
import { eq, count } from "drizzle-orm";
import type { Bucket } from "@/lib/domain/constants";
import { getSettings } from "./settings";
import { getIpoRealisedNet } from "./ipos";

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
  const closed = db.select().from(trades).where(eq(trades.isOpen, false)).all();
  const equityRealised = r2(closed.filter((t) => t.bucket === "equity").reduce((a, t) => a + t.netPnl, 0));
  const activeRealised = r2(closed.filter((t) => t.bucket === "active").reduce((a, t) => a + t.netPnl, 0));
  const ipoRealised = r2(getIpoRealisedNet());
  const totalRealised = r2(equityRealised + activeRealised + ipoRealised);
  const rolledIn = s?.pnlRolledIn ?? 0;
  return {
    equityCapital: s?.equityCapital ?? 0,
    activeCapital: s?.activeCapital ?? 0,
    totalCapital: (s?.equityCapital ?? 0) + (s?.activeCapital ?? 0),
    equityRealised,
    activeRealised,
    ipoRealised,
    totalRealised,
    rolledIn,
    available: r2(totalRealised - rolledIn),
  };
}

export function getOpeningSnapshot(bucket: Bucket) {
  return (
    db
      .select()
      .from(capitalSnapshots)
      .where(eq(capitalSnapshots.bucket, bucket))
      .orderBy(capitalSnapshots.asOfDate)
      .all()[0] ?? null
  );
}

export function getTradeCount(): number {
  return db.select({ c: count() }).from(trades).all()[0]?.c ?? 0;
}
