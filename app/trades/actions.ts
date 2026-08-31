"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades, ipos as iposTable } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { commitManualTrade, applyOverride, closePosition, updateManualTrade, type UpdateTradeFields } from "@/lib/import/commit";
import { deleteTradesByIds, deleteImportBatch } from "@/lib/queries/delete";
import { SEGMENTS, EXCHANGES, SEGMENT_BUCKET, BROKERS, type Segment } from "@/lib/domain/constants";
import { classify } from "@/lib/engine/classify";
import { evaluateLimits } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState } from "@/lib/queries/limits";
import type { NormalizedTrade } from "@/lib/engine/types";
import { ipoSeedFromTrade } from "@/lib/analytics/ipo-link";
import { recordAudit } from "@/lib/audit";
import {
  addLeg,
  updateLeg,
  deleteLeg,
  applyStopToOpenTranches,
  convertToStaged,
} from "@/lib/queries/staged";

export type ActionState = { ok: boolean; message: string; tradeId?: number | null };

const num = (v: FormDataEntryValue | null) => {
  const x = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(x) ? x : 0;
};
const str = (v: FormDataEntryValue | null) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

const ManualSchema = z.object({
  broker: z.enum(BROKERS),
  tradingsymbol: z.string().min(1, "Symbol is required"),
  productHint: z.enum(["intraday", "delivery", "mtf"]).nullable(),
  segment: z.string().nullable(),
  exchange: z.string().nullable(),
});

export async function createManualTrade(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const base = ManualSchema.safeParse({
    broker: formData.get("broker"),
    tradingsymbol: formData.get("tradingsymbol"),
    productHint: str(formData.get("productHint")) as never,
    segment: str(formData.get("segment")),
    exchange: str(formData.get("exchange")),
  });
  if (!base.success) return { ok: false, message: base.error.issues[0]?.message ?? "Invalid input" };

  const isOpenTrade = String(formData.get("open") ?? "") === "true";
  // Direction: "buy" (long, the default — preserves prior behavior for equity) or
  // "sell" (short / sell-to-open, e.g. a written CE/PE). The form's primary
  // qty/price/date fields always carry the ENTRY leg; the secondary set (only
  // present for a closed round-trip) carries the EXIT leg. Direction decides
  // which DB column pair (buy* vs sell*) each leg lands in.
  const direction = String(formData.get("direction") ?? "buy") === "sell" ? "sell" : "buy";
  const entryQty = num(formData.get("buyQty"));
  const entryPrice = num(formData.get("avgBuyPrice"));
  const entryDate = str(formData.get("buyDate"));
  // Exit leg only exists for a closed round-trip; open trades have no exit yet.
  const exitQty = isOpenTrade ? 0 : num(formData.get("sellQty"));
  const exitPrice = isOpenTrade ? 0 : num(formData.get("avgSellPrice"));
  const exitDate = isOpenTrade ? null : str(formData.get("sellDate"));

  let buyQty: number, avgBuyPrice: number, buyDateVal: string | null;
  let sellQty: number, avgSellPrice: number, sellDateVal: string | null;
  if (direction === "sell") {
    sellQty = entryQty; avgSellPrice = entryPrice; sellDateVal = entryDate;
    buyQty = exitQty; avgBuyPrice = exitPrice; buyDateVal = exitDate;
  } else {
    buyQty = entryQty; avgBuyPrice = entryPrice; buyDateVal = entryDate;
    sellQty = exitQty; avgSellPrice = exitPrice; sellDateVal = exitDate;
  }
  const buyValue = Math.round(buyQty * avgBuyPrice * 100) / 100;
  const sellValue = Math.round(sellQty * avgSellPrice * 100) / 100;

  if (isOpenTrade && entryQty <= 0) return { ok: false, message: "Enter quantity and entry price." };
  if (entryQty <= 0 && exitQty <= 0) return { ok: false, message: "Enter buy and/or sell quantity." };

  const grossPnl =
    sellQty > 0 && buyQty > 0
      ? Math.round((sellValue - buyValue) * 100) / 100
      : 0;

  const segment = base.data.segment && SEGMENTS.includes(base.data.segment as never) ? base.data.segment : null;
  const exchange = base.data.exchange && EXCHANGES.includes(base.data.exchange as never) ? base.data.exchange : null;

  const t: NormalizedTrade = {
    broker: base.data.broker,
    tradingsymbol: base.data.tradingsymbol.trim(),
    isin: str(formData.get("isin")),
    buyQty,
    avgBuyPrice,
    buyValue,
    sellQty,
    avgSellPrice,
    sellValue,
    closingPrice: num(formData.get("closingPrice")) || null,
    grossPnl,
    unrealisedPnl: 0,
    buyDate: buyDateVal,
    sellDate: sellDateVal,
    productHint: base.data.productHint,
    exchangeHint: (exchange as never) ?? null,
    sourceFile: "manual",
  };

  // Pre-trade limit breaches at entry (P1.4) — recorded on open trades for the
  // journal/audit history. Evaluated against state BEFORE this trade is inserted.
  const slPlanned = num(formData.get("slPlanned")) || null;
  let ruleViolations: string[] | null = null;
  if (isOpenTrade) {
    try {
      const cls = classify({
        tradingsymbol: t.tradingsymbol,
        broker: base.data.broker,
        isin: t.isin,
        productHint: base.data.productHint,
        exchangeHint: (exchange as never) ?? null,
      });
      const seg = (segment as Segment) ?? cls.segment;
      const bkt = segment ? SEGMENT_BUCKET[seg] : cls.bucket;
      const verdict = evaluateLimits(
        { bucket: bkt, segment: seg, symbol: cls.symbol, entry: entryPrice, stop: slPlanned, qty: entryQty },
        resolveRules(bkt, seg),
        getPortfolioState(bkt, cls.symbol),
      );
      if (verdict.status !== "pass") {
        // Only real breaches belong in the journal's violation history — a
        // "skipped" check (rule configured but not evaluable, e.g. no capital
        // set) is neither a pass nor a violation.
        ruleViolations = verdict.checks
          .filter((c) => c.status === "warn" || c.status === "block")
          .map((c) => `${c.label}: ${c.message}`);
      }
    } catch { /* never block a save on the limits check */ }
  }

  try {
    const res = commitManualTrade(t, {
      forcedSegment: (segment as never) ?? null,
      forcedExchange: (exchange as never) ?? null,
      setupTag: str(formData.get("setupTag")),
      notes: str(formData.get("notes")),
      ruleViolations,
      slPlanned,
      trailingSl: num(formData.get("trailingSl")) || null,
      targetPlanned: num(formData.get("targetPlanned")) || null,
      riskAmount: num(formData.get("riskAmount")) || null,
      ownCapitalUsed: num(formData.get("ownCapitalUsed")) || null,
      daysHeld: num(formData.get("daysHeld")) || null,
      currentPrice: num(formData.get("currentPrice")) || null,
      lotSize: num(formData.get("lotSize")) || null,
    },
    // Present only when the form was submitted from the "All accounts" view.
    num(formData.get("accountId")) || null);
    if (res.duplicate) return { ok: false, message: "A matching trade already exists (duplicate)." };
    revalidatePath("/trades");
    revalidatePath("/risk");
    revalidatePath("/equity");
    revalidatePath("/active");
    revalidatePath("/");
    return { ok: true, message: isOpenTrade ? "Open trade added — see Portfolio Risk." : "Trade added.", tradeId: res.id };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function overrideTrade(formData: FormData): Promise<void> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return;
  const segment = str(formData.get("segment"));
  const exchange = str(formData.get("exchange"));
  const isMtfRaw = str(formData.get("isMtf"));
  applyOverride(id, {
    segment: (segment as never) ?? null,
    exchange: (exchange as never) ?? null,
    isMtf: isMtfRaw == null ? null : isMtfRaw === "true",
    setupTag: str(formData.get("setupTag")),
  });
  revalidatePath("/trades");
  revalidatePath("/");
}

export async function deleteTrade(formData: FormData): Promise<void> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return;
  // Routed through the delete engine rather than deleting the row directly.
  // The old implementation removed `trades` and nothing else, orphaning
  // trade_legs and trade_attachments and leaving the attachment bytes on disk
  // forever, with no audit entry to say the trade had existed.
  deleteTradesByIds([id], "deleted from the trades table");
  revalidateAfterTradeChange();
}

/** Delete a resolved set of ids — the exact list the confirmation showed. */
export async function deleteTradesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const raw = String(formData.get("ids") ?? "");
  const reason = String(formData.get("reason") ?? "bulk delete");
  const ids = raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return { ok: false, message: "Nothing was selected." };
  const res = deleteTradesByIds(ids, reason);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Delete an import batch, optionally cascading to the trades it created. */
export async function deleteImportBatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const batchId = Number(formData.get("batchId"));
  const cascade = String(formData.get("cascade") ?? "") === "true";
  if (!Number.isFinite(batchId)) return { ok: false, message: "Invalid import." };
  const res = deleteImportBatch(batchId, cascade);
  if (res.ok) {
    revalidateAfterTradeChange();
    revalidatePath("/import");
  }
  return { ok: res.ok, message: res.message };
}

function revalidateAfterTradeChange() {
  for (const p of ["/trades", "/risk", "/equity", "/active", "/", "/reports/broker-compare"]) revalidatePath(p);
}

/** Close an open position at an exit price/date — any segment (equity/MTF/options/futures). */
export async function closeTradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const exitPrice = num(formData.get("exitPrice"));
  const exitDate = str(formData.get("exitDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(exitPrice > 0)) return { ok: false, message: "Enter a valid exit price." };
  const res = closePosition(id, exitPrice, exitDate);
  if (res.ok) revalidateAfterTradeChange();
  return res;
}

/**
 * Edit any trade (open or closed), any time — qty/prices/dates/SL-TSL-target/
 * risk/MTF own-capital/notes. The form is always pre-filled with the trade's
 * current values, so every field round-trips its existing value unless the
 * user changes it — blank always means "clear this", matching the create
 * form's own blank-means-null convention (num() || null).
 */
export async function updateTradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const fields: UpdateTradeFields = {
    buyQty: num(formData.get("buyQty")),
    avgBuyPrice: num(formData.get("avgBuyPrice")),
    buyDate: str(formData.get("buyDate")),
    sellQty: num(formData.get("sellQty")),
    avgSellPrice: num(formData.get("avgSellPrice")),
    sellDate: str(formData.get("sellDate")),
    slPlanned: num(formData.get("slPlanned")) || null,
    trailingSl: num(formData.get("trailingSl")) || null,
    targetPlanned: num(formData.get("targetPlanned")) || null,
    riskAmount: num(formData.get("riskAmount")) || null,
    ownCapitalUsed: num(formData.get("ownCapitalUsed")) || null,
    setupTag: str(formData.get("setupTag")),
    exitTrigger: str(formData.get("exitTrigger")),
    notes: str(formData.get("notes")),
    currentPrice: num(formData.get("currentPrice")) || null,
  };

  const res = updateManualTrade(id, fields);
  if (res.ok) revalidateAfterTradeChange();
  return res;
}

// ---------------------------------------------------------------------------
// Staged (scaled) positions — building a position in tranches and scaling out.
//
// Every mutation runs through lib/queries/staged.ts, which validates the
// PROSPECTIVE ladder before writing anything and then reprices the whole
// position. A rejected leg never leaves a half-applied trade behind.
// ---------------------------------------------------------------------------

function tradeDirection(id: number): "long" | "short" {
  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return "long";
  // sellQty > buyQty, not buyQty === 0 — a partially covered short has
  // buyQty > 0 and must stay short, or the rebuilt P&L sign-inverts (fix A6).
  return t.sellQty > t.buyQty ? "short" : "long";
}

/** Turn a plain trade into a staged one by seeding the ladder from its own
 *  numbers. Lossless — a one-entry ladder aggregates back to itself. */
export async function enableStagedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  const res = convertToStaged(id);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Add another entry to an open position.
 *
 * The pre-trade limits check runs on the ADD, not just on the original entry —
 * scaling in is exactly where position size quietly outgrows the plan, so the
 * same advisory guardrails apply. Advisory only: it never blocks, matching the
 * rest of the app.
 */
export async function addEntryLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const qty = num(formData.get("qty"));
  const price = num(formData.get("price"));
  const tradeDate = str(formData.get("tradeDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(qty > 0)) return { ok: false, message: "Enter a quantity greater than zero." };
  if (!(price > 0)) return { ok: false, message: "Enter a valid price." };
  if (!tradeDate) return { ok: false, message: "Pick the date of this entry." };

  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return { ok: false, message: "Trade not found." };

  if (!t.staged) {
    const conv = convertToStaged(id);
    if (!conv.ok) return { ok: false, message: conv.message };
  }

  const res = addLeg({
    tradeId: id,
    kind: "entry",
    tradeDate,
    tradeTime: str(formData.get("tradeTime")),
    qty,
    price,
    slPlanned: num(formData.get("slPlanned")) || null,
    trailingSl: num(formData.get("trailingSl")) || null,
    targetPlanned: num(formData.get("targetPlanned")) || null,
    note: str(formData.get("note")),
    direction: tradeDirection(id),
  });
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Book a partial (or full) exit. Available on ANY trade — a plain single-entry
 * trade is converted to a staged one on the fly, which is lossless, so
 * "book half at target and trail the rest" needs no mode switch.
 */
export async function addExitLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  const qty = num(formData.get("qty"));
  const price = num(formData.get("price"));
  const tradeDate = str(formData.get("tradeDate"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };
  if (!(qty > 0)) return { ok: false, message: "Enter a quantity greater than zero." };
  if (!(price > 0)) return { ok: false, message: "Enter a valid exit price." };
  if (!tradeDate) return { ok: false, message: "Pick the date of this exit." };

  const t = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!t) return { ok: false, message: "Trade not found." };
  if (!t.isOpen) return { ok: false, message: "This position is already closed." };

  if (!t.staged) {
    const conv = convertToStaged(id);
    if (!conv.ok) return { ok: false, message: conv.message };
  }

  const res = addLeg({
    tradeId: id,
    kind: "exit",
    tradeDate,
    tradeTime: str(formData.get("tradeTime")),
    qty,
    price,
    note: str(formData.get("note")),
    direction: tradeDirection(id),
  });
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Edit one fill — quantity, price, date, or its own stop. */
export async function updateLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const legId = Number(formData.get("legId"));
  const tradeId = Number(formData.get("tradeId"));
  if (!Number.isFinite(legId)) return { ok: false, message: "Invalid leg." };

  const res = updateLeg(
    legId,
    {
      qty: num(formData.get("qty")) || undefined,
      price: num(formData.get("price")) || undefined,
      tradeDate: str(formData.get("tradeDate")) ?? undefined,
      slPlanned: formData.has("slPlanned") ? num(formData.get("slPlanned")) || null : undefined,
      trailingSl: formData.has("trailingSl") ? num(formData.get("trailingSl")) || null : undefined,
      targetPlanned: formData.has("targetPlanned") ? num(formData.get("targetPlanned")) || null : undefined,
      note: formData.has("note") ? str(formData.get("note")) : undefined,
    },
    Number.isFinite(tradeId) ? tradeDirection(tradeId) : undefined,
  );
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Remove a fill. Refused when it would leave the ladder inconsistent. */
export async function deleteLegAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const legId = Number(formData.get("legId"));
  const tradeId = Number(formData.get("tradeId"));
  if (!Number.isFinite(legId)) return { ok: false, message: "Invalid leg." };
  const res = deleteLeg(legId, Number.isFinite(tradeId) ? tradeDirection(tradeId) : undefined);
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/** Write one stop across every OPEN tranche — the "apply to all" button. */
export async function applyStopAllAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const hasSl = formData.has("slPlanned");
  const hasTsl = formData.has("trailingSl");
  if (!hasSl && !hasTsl) return { ok: false, message: "Nothing to apply." };

  const res = applyStopToOpenTranches(
    id,
    {
      ...(hasSl ? { slPlanned: num(formData.get("slPlanned")) || null } : {}),
      ...(hasTsl ? { trailingSl: num(formData.get("trailingSl")) || null } : {}),
    },
    tradeDirection(id),
  );
  if (res.ok) revalidateAfterTradeChange();
  return { ok: res.ok, message: res.message };
}

/**
 * Set how a holding was acquired, and what it cost.
 *
 * This is the resolution step for a trade the importer could not price: sold
 * inside the window, bought before it. Until a basis is supplied the trade is
 * counted in cash but held out of win rate, expectancy, profit factor and ROM,
 * because `buyValue = 0` would otherwise read as a 100% win — the single most
 * flattering lie the journal could tell.
 *
 * Supplying the price recomputes gross and net P&L from the sale that already
 * happened. Charges are left untouched: they were always real and were never
 * the thing in doubt.
 */
export async function setAcquisitionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const kind = str(formData.get("acquisition")) ?? "";
  if (!["unknown", "ipo", "bonus", "gift"].includes(kind)) {
    return { ok: false, message: "Pick how these shares were acquired." };
  }

  const row = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!row) return { ok: false, message: "Trade not found." };

  const rawPrice = formData.get("acquisitionPrice");
  const hasPrice = rawPrice != null && String(rawPrice).trim() !== "";
  const price = hasPrice ? Number(rawPrice) : null;
  if (hasPrice && (!Number.isFinite(price!) || price! < 0)) {
    return { ok: false, message: "Cost per share must be zero or more." };
  }

  const acquisitionDate = str(formData.get("acquisitionDate"));

  // Leaving the price blank is a legitimate "I do not know yet" — the trade
  // stays flagged and out of the statistics rather than being forced to a
  // number the user does not actually have.
  const patch: Record<string, unknown> = {
    acquisition: kind,
    acquisitionPrice: hasPrice ? price : null,
    acquisitionDate: acquisitionDate ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (hasPrice) {
    const buyValue = Math.round(row.sellQty * price! * 100) / 100;
    const grossPnl = Math.round((row.sellValue - buyValue) * 100) / 100;
    patch.buyQty = row.sellQty;
    patch.avgBuyPrice = price;
    patch.buyValue = buyValue;
    patch.grossPnl = grossPnl;
    patch.netPnl = Math.round((grossPnl - row.chargesTotal) * 100) / 100;
    patch.realisedPct = buyValue > 0 ? Math.round((grossPnl / buyValue) * 10000) / 100 : null;
    if (acquisitionDate) patch.buyDate = acquisitionDate;
  }

  db.update(trades).set(patch).where(eq(trades.id, id)).run();
  revalidateAfterTradeChange();
  for (const p of ["/ipos", "/arjuns-eye", "/reports/performance"]) revalidatePath(p);

  return {
    ok: true,
    message: hasPrice
      ? "Cost basis set — this trade now counts toward your edge."
      : "Marked. Add a cost per share to include it in win rate and expectancy.",
  };
}

/**
 * "This holding came from an IPO allotment."
 *
 * IPO shares are credited without ever appearing as a buy, so the position
 * lands in the journal with no cost basis and no mark — unable to be scored as
 * a gain or a loss, and unable to join the edge statistics. The IPO section is
 * where the user actually knows those numbers, so this creates the record,
 * links the two, and hands the user somewhere to fill them in.
 *
 * Nothing is guessed here. The issue price is left blank unless the holding
 * genuinely has a purchase price, because that price is precisely the fact the
 * journal is missing.
 */
export async function pushTradeToIpoAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = Number(formData.get("tradeId"));
  if (!Number.isFinite(id)) return { ok: false, message: "Invalid trade." };

  const row = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!row) return { ok: false, message: "Trade not found." };

  const existing = db.select().from(iposTable).where(eq(iposTable.tradeId, id)).get();
  if (existing) {
    return { ok: true, message: `Already linked to an IPO record — open IPOs to edit it.` };
  }

  const seed = ipoSeedFromTrade({
    symbol: row.symbol,
    exchange: row.exchange,
    buyQty: row.buyQty,
    avgBuyPrice: row.avgBuyPrice,
    buyValue: row.buyValue,
    buyDate: row.buyDate,
    closingPrice: row.closingPrice,
  });

  const created = db
    .insert(iposTable)
    .values({
      name: seed.name,
      exchange: seed.exchange,
      board: "mainboard",
      allotted: true,
      allottedQty: seed.allottedQty,
      appliedPrice: seed.appliedPrice,
      lotSize: seed.lotSize,
      lotsApplied: seed.lotsApplied,
      allotmentDate: seed.allotmentDate,
      listingPrice: seed.listingPrice,
      notes: seed.notes,
      tradeId: id,
    })
    .returning({ id: iposTable.id })
    .get();

  // Mark provenance immediately. The BASIS stays absent until the user enters
  // an issue price — flagging it as an IPO does not by itself make it priced,
  // and pretending otherwise would put it back into statistics it cannot join.
  db.update(trades)
    .set({ acquisition: "ipo", updatedAt: new Date().toISOString() })
    .where(eq(trades.id, id))
    .run();

  recordAudit({
    entity: "trade",
    action: "update",
    summary: `${row.symbol}: pushed to IPOs as an allotment (IPO #${created!.id})`,
    before: { acquisition: row.acquisition },
    after: { acquisition: "ipo", ipoId: created!.id },
  });

  revalidateAfterTradeChange();
  for (const p of ["/ipos", "/arjuns-eye", "/reports/performance"]) revalidatePath(p);

  return {
    ok: true,
    message: `Created an IPO record for ${row.symbol}. Open IPOs and enter the issue price — that supplies the cost basis, and a listing price gives the holding its mark.`,
  };
}
