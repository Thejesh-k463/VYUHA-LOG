import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ipos, trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { linkedSyncFor, tradePatchFromIpo, type IpoLinkInput, type LinkedSync } from "@/lib/analytics/ipo-link";
import { computeIpo, isPriceableExitDate, type IpoInput } from "@/lib/analytics/ipo";
import type { ChargeBreakdown } from "@/lib/engine/types";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { getSelectedAccountId, getWriteAccountId } from "@/lib/queries/accounts";
import { sellChargerFor } from "@/lib/queries/ipos";

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
 * Deliberately narrow: basis, mark and provenance, and (Z2, wave 2H) the charges of
 * an exit the IPO prices. Notes, tags, the journal entry and the setup all belong to
 * the trade and are never overwritten from here.
 */
function linkInput(values: Record<string, unknown>): IpoLinkInput {
  return {
    appliedPrice: Number(values.appliedPrice) || 0,
    discountPerShare: Number(values.discountPerShare) || 0,
    allottedQty: Number(values.allottedQty) || 0,
    allotted: Boolean(values.allotted),
    listingPrice: (values.listingPrice ?? null) as number | null,
    exitPrice: (values.exitPrice ?? null) as number | null,
    allotmentDate: (values.allotmentDate ?? null) as string | null,
    listingDate: (values.listingDate ?? null) as string | null,
    exitDate: (values.exitDate ?? null) as string | null,
  };
}
function linkPatch(values: Record<string, unknown>) {
  return tradePatchFromIpo(linkInput(values));
}

/**
 * X1 (v4.3.0 wave 2H seam fix 5): may this save write to the linked holding? A holding
 * with a sale recorded in Trades that is not the IPO's own exit is never recomputed
 * from the IPO (lib/analytics/ipo-link.ts linkedSyncFor): a save that changes nothing
 * the sync writes leaves it alone, any other save is refused. `stored` is the IPO as
 * stored while the save keeps its link; null for a create or a new link.
 */
function linkedSync(tradeId: number, stored: Record<string, unknown> | null, values: Record<string, unknown>): LinkedSync {
  const trade = db
    .select({ sellQty: trades.sellQty, avgSellPrice: trades.avgSellPrice, sellDate: trades.sellDate })
    .from(trades)
    .where(eq(trades.id, tradeId))
    .get();
  return linkedSyncFor({ stored: stored ? linkInput(stored) : null, next: linkInput(values), trade: trade ?? null });
}
const refuseHoldingSold = () =>
  NextResponse.json(
    { ok: false, message: "The linked holding has a sale recorded in Trades. Change its quantity or prices there, or remove the sale first. Nothing was saved." },
    { status: 409 },
  );

/**
 * H5 (v4.3.0 wave 2H): would syncLinkedTrade write this save's exit date onto the
 * linked trade as a NEW sell date? True when the patch closes the holding and the
 * trade is still open or carries a different sell date. A trade an earlier save
 * already closed on the same date gets that same date back and writes nothing new.
 */
function syncWritesSellDate(tradeId: number, values: Record<string, unknown>): boolean {
  const patch = linkPatch(values);
  if (!patch?.sellDate) return false;
  const row = db.select({ isOpen: trades.isOpen, sellDate: trades.sellDate }).from(trades).where(eq(trades.id, tradeId)).get();
  if (!row) return false; // syncLinkedTrade writes nothing to a trade that is not there
  return row.isOpen || row.sellDate !== patch.sellDate;
}

/**
 * S4 (v4.3.0 wave 2H seam): would syncLinkedTrade CLOSE the linked trade, as a new
 * write, on an exit date that is empty or unreadable? The form opens an unreadable
 * stored date as a blank input and sends '', so H5's check above never saw it:
 * measured before, 200 and the holding closed with sell_date NULL, which the tax
 * base files in the current financial year. A trade already closed on that same
 * date gets the same values back and writes nothing new, so it is not refused.
 */
function syncClosesUndated(tradeId: number, values: Record<string, unknown>): boolean {
  const patch = linkPatch(values);
  if (!patch || patch.isOpen) return false;
  if (patch.sellDate != null && isPriceableExitDate(patch.sellDate)) return false;
  const row = db.select({ isOpen: trades.isOpen, sellDate: trades.sellDate }).from(trades).where(eq(trades.id, tradeId)).get();
  if (!row) return false; // syncLinkedTrade writes nothing to a trade that is not there
  return row.isOpen || row.sellDate !== patch.sellDate;
}
const refuseUndatedClose = () =>
  NextResponse.json(
    { ok: false, message: "An exit needs a readable exit date — enter the date the shares were sold." },
    { status: 400 },
  );

/**
 * Z2 (v4.3.0 wave 2H): the IPO's own computed exit charges for these values, exactly as
 * /ipos prices the saved row (getIposComputed: computeIpo over sellChargerFor, which reads
 * charge_config at the exit date — invariant 3). Null when the exit is not priced (no exit,
 * an unreadable date) or charge_config has no row to price it from; the caller then keeps
 * the trade's own charges rather than write a 0 it does not know (invariant 6).
 */
function ipoExitCharges(values: Record<string, unknown>): ChargeBreakdown | number | null {
  try {
    const input = { id: 0, ...values } as IpoInput;
    const c = computeIpo(input, sellChargerFor(input.broker, input.exchange, input.exitDate ?? null, loadRatesMap()));
    return c.realised ? (c.chargeBreakdown ?? c.charges) : null;
  } catch {
    return null;
  }
}
const HEADS = ["brokerage", "sttCtt", "exchangeTxn", "sebi", "stampDuty", "ipft", "gst", "dpCharges", "mtfInterest", "pledgeCharges"] as const;
const headsOf = (b: ChargeBreakdown | null) => Object.fromEntries(HEADS.map((k) => [k, b ? b[k] : 0])) as Record<(typeof HEADS)[number], number>;

function syncLinkedTrade(tradeId: number, values: Record<string, unknown>) {
  const priced = ipoExitCharges(values);
  const patch = tradePatchFromIpo(linkInput(values), typeof priced === "number" ? priced : priced?.total ?? null);
  // An application that was not allotted produced no shares, so there is
  // nothing to write — the trade is left exactly as it was.
  if (!patch) return;

  const row = db.select().from(trades).where(eq(trades.id, tradeId)).get();
  if (!row) return;

  const grossPnl = patch.grossPnl;
  // Z2: a priced exit writes the IPO's charges (every head the trade row carries, when the
  // charger stated them). Re-opening a holding this sync closed takes that sale's charges
  // off with the sale. Otherwise (open and staying open, or an unpriced exit) the trade's
  // own charges stand, as before.
  const reopens = patch.isOpen && !row.isOpen;
  const chargesTotal = patch.chargesTotal ?? (reopens ? 0 : row.chargesTotal);
  const heads = patch.chargesTotal != null
    ? (typeof priced === "object" && priced ? headsOf(priced) : patch.chargesTotal === 0 ? headsOf(null) : {})
    : reopens ? headsOf(null) : {};
  const netPnl = patch.netPnl ?? Math.round((grossPnl - chargesTotal) * 100) / 100;

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
      chargesTotal,
      ...heads,
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

  // IPO-EXITDATE (v4.3.0): an exit date is stored only if it is a real
  // YYYY-MM-DD day from 1875 on — the same rule computeIpo reads it by (N13).
  // A half-typed date input ('0002-06-15') or a day-first date ('15-03-2011')
  // used to be saved as typed and then read as "not yet priced"; it is refused
  // while the user can still fix it: on a create, and on an edit that CHANGES
  // the exit date (L3, wave 2G) or USES it (H5, wave 2H: see the edit branch).
  // An edit that sends back the value already stored, and does not use it,
  // passes it through — a row written unreadable before 4.3.0 would otherwise
  // refuse every edit, notes included — and clearing is always allowed.
  const exitDate = strOrNull(body.exitDate);
  const exitDateRefused = (): boolean => exitDate != null && !isPriceableExitDate(exitDate);
  const refuseExitDate = () =>
    NextResponse.json(
      { ok: false, message: "The exit date must be a real calendar day written year-month-day, such as 2026-06-15, with a year from 1875 on. Nothing was saved." },
      { status: 400 },
    );

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
    exitDate,
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
    const link = linkedTradeId === undefined ? before.tradeId ?? null : linkedTradeId;
    // X1: the stored IPO is compared only while the save keeps the same link.
    const sync = link ? linkedSync(link, link === (before.tradeId ?? null) ? before : null, values) : null;
    // H5 (v4.3.0 wave 2H): the stored value passes through only while the save does
    // not USE it. It is checked when the request changes it, when this save makes
    // the IPO exited (an exit price where there was none), or when the sync would
    // write it onto the linked trade as its sell date. Measured before: an open
    // linked holding was closed with sell_date '2026-02-30' and a realised P&L.
    if (exitDateRefused()) {
      const changed = exitDate !== strOrNull(before.exitDate);
      const becomesExited = values.allotted && values.exitPrice != null && !(before.allotted && before.exitPrice != null);
      if (changed || becomesExited || (!!link && sync === "sync" && syncWritesSellDate(link, values))) return refuseExitDate();
    }
    if (sync === "refuse") return refuseHoldingSold();
    if (link && sync === "sync" && syncClosesUndated(link, values)) return refuseUndatedClose();
    db.update(ipos)
      .set({
        ...values,
        ...(linkedTradeId === undefined ? {} : { tradeId: linkedTradeId }),
        updatedAt: sql`(datetime('now'))`,
      })
      .where(eq(ipos.id, id))
      .run();

    if (link && sync === "sync") syncLinkedTrade(link, values);

    revalidate();
    return NextResponse.json({
      ok: true,
      id,
      message: !link
        ? "IPO updated."
        : sync === "leave"
          ? "IPO updated. The linked holding has a sale recorded in Trades and was left as it is."
          : "IPO updated — the linked holding's cost basis and mark were updated with it.",
    });
  }

  // A create has no stored value to pass through: any unreadable exit date is refused.
  if (exitDateRefused()) return refuseExitDate();

  // Invariant 9: 0 is a view, not a place. Defect D9 (2026-08-12) swapped
  // `getSelectedAccountId() || 1` for getWriteAccountId() and the comment here
  // claimed the misfiling was gone — it was not: until v3.8 the resolver's own
  // no-selection fallback was the lowest account id, which reproduced `|| 1`
  // exactly (probed: two-account temp DB, selected_account_id = 0, POST
  // /api/ipos → 200, ipos.account_id = 1). The resolver now THROWS on that
  // question; the aggregate view is still refused BEFORE it is asked so the
  // answer keeps the house shape (lib/queries/challans.ts, /api/bf-losses):
  // 403 for the aggregate-view write ban, 400 for everything else. An account
  // picker on /ipos (as /import and /trades have) would be friendlier; UI work.
  //
  // The EDIT branch above needs no such guard: it locates the row first and
  // only lets the aggregate view touch rows it can already see, which is the
  // same rule DELETE uses.
  if (getSelectedAccountId() === 0) {
    return NextResponse.json(
      {
        ok: false,
        forbidden: true,
        message: "An IPO application belongs to one account's book — pick an account in the sidebar first. The All-accounts view only reads.",
      },
      { status: 403 },
    );
  }

  // X1: a create has no stored IPO, so linking a holding whose sale is not this exit is refused.
  if (linkedTradeId && linkedSync(linkedTradeId, null, values) === "refuse") return refuseHoldingSold();
  if (linkedTradeId && syncClosesUndated(linkedTradeId, values)) return refuseUndatedClose();

  const row = db
    .insert(ipos)
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
