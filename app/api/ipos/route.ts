import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ipos, trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { tradePatchFromIpo } from "@/lib/analytics/ipo-link";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";

export const runtime = "nodejs";

const num = (v: unknown): number => {
  const x = Number(String(v ?? "").trim());
  return Number.isFinite(x) ? x : 0;
};
const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
};
const strOrNull = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

function revalidate() {
  for (const p of ["/ipos", "/settings", "/", "/trades", "/arjuns-eye", "/reports/performance"]) {
    revalidatePath(p);
  }
}

/**
 * Push the IPO's numbers onto the holding it is linked to.
 *
 * Once linked, the IPO record is the SOURCE OF TRUTH for the two facts an
 * allotment-derived holding is missing: what it cost, and what it is worth.
 * Keeping them in one place is the whole point — a second copy would drift.
 *
 * Deliberately narrow: basis, mark and provenance only. Charges, notes, tags,
 * the journal entry and the setup all belong to the trade and are never
 * overwritten from here.
 */
function syncLinkedTrade(tradeId: number, values: Record<string, unknown>) {
  const patch = tradePatchFromIpo({
    appliedPrice: Number(values.appliedPrice) || 0,
    discountPerShare: Number(values.discountPerShare) || 0,
    allottedQty: Number(values.allottedQty) || 0,
    allotted: Boolean(values.allotted),
    listingPrice: values.listingPrice as number | null,
    exitPrice: values.exitPrice as number | null,
    allotmentDate: values.allotmentDate as string | null,
    listingDate: values.listingDate as string | null,
    exitDate: values.exitDate as string | null,
  });
  // An application that was not allotted produced no shares, so there is
  // nothing to write — the trade is left exactly as it was.
  if (!patch) return;

  const row = db.select().from(trades).where(eq(trades.id, tradeId)).get();
  if (!row) return;

  const grossPnl = patch.grossPnl;
  const netPnl = Math.round((grossPnl - row.chargesTotal) * 100) / 100;

  db.update(trades)
    .set({
      acquisition: patch.acquisition,
      // Only a POSITIVE cost counts as a supplied basis. Leaving it null while
      // the issue price is still blank keeps the holding out of win rate and
      // expectancy, which is correct: it has no basis yet.
      acquisitionPrice: patch.acquisitionPrice > 0 ? patch.acquisitionPrice : null,
      acquisitionDate: patch.acquisitionDate,
      buyQty: patch.buyQty,
      avgBuyPrice: patch.avgBuyPrice,
      buyValue: patch.buyValue,
      buyDate: patch.acquisitionDate ?? row.buyDate,
      closingPrice: patch.closingPrice,
      unrealisedPnl: patch.unrealisedPnl,
      sellQty: patch.sellQty ?? 0,
      avgSellPrice: patch.avgSellPrice ?? 0,
      sellValue: patch.sellValue ?? 0,
      sellDate: patch.sellDate,
      isOpen: patch.isOpen,
      grossPnl,
      netPnl,
      realisedPct: !patch.isOpen && patch.buyValue > 0
        ? Math.round((grossPnl / patch.buyValue) * 10000) / 100
        : null,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(trades.id, tradeId))
    .run();
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const name = strOrNull(body.name);
  if (!name) return NextResponse.json({ ok: false, message: "IPO name is required." }, { status: 400 });

  const allotted = Boolean(body.allotted);
  const values = {
    name,
    broker: strOrNull(body.broker),
    exchange: strOrNull(body.exchange) ?? "NSE",
    board: body.board === "sme" ? "sme" : "mainboard",
    category: strOrNull(body.category),
    discountPerShare: Math.max(0, num(body.discountPerShare)),
    appliedPrice: num(body.appliedPrice),
    lotSize: Math.max(1, Math.round(num(body.lotSize)) || 1),
    lotsApplied: Math.max(1, Math.round(num(body.lotsApplied)) || 1),
    allotted,
    allottedQty: allotted ? num(body.allottedQty) : 0,
    listingPrice: numOrNull(body.listingPrice),
    exitPrice: numOrNull(body.exitPrice),
    appliedDate: strOrNull(body.appliedDate),
    allotmentDate: strOrNull(body.allotmentDate),
    listingDate: strOrNull(body.listingDate),
    exitDate: strOrNull(body.exitDate),
    notes: strOrNull(body.notes),
  };

  // Null clears a link; a number sets one. Undefined leaves it untouched so an
  // ordinary edit never silently unlinks a holding.
  const linkedTradeId =
    body.tradeId === undefined ? undefined : (numOrNull(body.tradeId) ?? null);

  const id = Number(body.id);
  if (Number.isFinite(id) && id > 0) {
    // Scoped like every other account-bound mutation (invariant 8): an IPO id
    // from an account the user is not viewing reads as "not found", never as
    // something a stale tab can edit across the boundary.
    const before = db.select().from(ipos).where(eq(ipos.id, id)).get();
    const viewing = getSelectedAccountId();
    if (!before || (viewing > 0 && before.accountId !== viewing)) {
      return NextResponse.json({ ok: false, message: "That IPO is not in the account you are viewing." }, { status: 404 });
    }
    db.update(ipos)
      .set({
        ...values,
        ...(linkedTradeId === undefined ? {} : { tradeId: linkedTradeId }),
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(ipos.id, id))
      .run();

    const link = linkedTradeId === undefined ? before?.tradeId ?? null : linkedTradeId;
    if (link) syncLinkedTrade(link, values);

    revalidate();
    return NextResponse.json({
      ok: true,
      id,
      message: link
        ? "IPO updated — the linked holding's cost basis and mark were updated with it."
        : "IPO updated.",
    });
  }

  const row = db
    .insert(ipos)
    // getWriteAccountId, not `getSelectedAccountId() || 1`: 0 is a view, not a
    // place (invariant 9), and the old fallback silently filed every IPO added
    // from the All-accounts view into account 1 (defect D9, 2026-08-12).
    .values({ accountId: getWriteAccountId(), ...values, ...(linkedTradeId ? { tradeId: linkedTradeId } : {}) })
    .returning({ id: ipos.id })
    .get();
  if (linkedTradeId) syncLinkedTrade(linkedTradeId, values);
  revalidate();
  return NextResponse.json({ ok: true, message: "IPO added.", id: row!.id });
}

export async function DELETE(req: Request) {
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
  // Account enforcement mirrors lib/queries/delete.ts: the aggregate view may
  // delete anywhere it can see, a single-account view only inside itself.
  const row = db.select({ accountId: ipos.accountId }).from(ipos).where(eq(ipos.id, id)).get();
  const viewing = getSelectedAccountId();
  if (!row || (viewing > 0 && row.accountId !== viewing)) {
    return NextResponse.json({ ok: false, message: "That IPO is not in the account you are viewing." }, { status: 404 });
  }
  db.delete(ipos).where(eq(ipos.id, id)).run();
  revalidate();
  return NextResponse.json({ ok: true, message: "IPO deleted." });
}
