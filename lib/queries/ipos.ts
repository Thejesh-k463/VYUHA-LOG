import "server-only";
import { db } from "@/lib/db";
import { ipos } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { computeIpo, summariseIpos, type IpoComputed, type IpoSummary } from "@/lib/analytics/ipo";

export function getIposComputed(): { rows: IpoComputed[]; summary: IpoSummary } {
  const raw = db.select().from(ipos).orderBy(desc(ipos.createdAt)).all();
  const rows = raw.map((r) =>
    computeIpo({
      id: r.id,
      name: r.name,
      broker: r.broker,
      exchange: r.exchange,
      board: r.board,
      category: r.category,
      discountPerShare: r.discountPerShare,
      appliedPrice: r.appliedPrice,
      lotSize: r.lotSize,
      lotsApplied: r.lotsApplied,
      allotted: r.allotted,
      allottedQty: r.allottedQty,
      listingPrice: r.listingPrice,
      exitPrice: r.exitPrice,
      appliedDate: r.appliedDate,
      allotmentDate: r.allotmentDate,
      listingDate: r.listingDate,
      exitDate: r.exitDate,
      notes: r.notes,
    }),
  );
  return { rows, summary: summariseIpos(rows) };
}

/** Realised (exited) IPO net P&L — feeds the capital-compounding view. */
export function getIpoRealisedNet(): number {
  return getIposComputed().rows.filter((r) => r.realised).reduce((s, r) => s + r.netPnl, 0);
}
