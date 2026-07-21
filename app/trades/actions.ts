"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { commitManualTrade, applyOverride, closePosition, updateManualTrade, type UpdateTradeFields } from "@/lib/import/commit";
import { SEGMENTS, EXCHANGES, SEGMENT_BUCKET, BROKERS, type Segment } from "@/lib/domain/constants";
import { classify } from "@/lib/engine/classify";
import { evaluateLimits } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState } from "@/lib/queries/limits";
import type { NormalizedTrade } from "@/lib/engine/types";
import {
  addLeg,
  updateLeg,
  deleteLeg,
  applyStopToOpenTranches,
  convertToStaged,
} from "@/lib/queries/staged";

export type ActionState = { ok: boolean; message: string };

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
        ruleViolations = verdict.checks.filter((c) => c.status !== "pass").map((c) => `${c.label}: ${c.message}`);
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
    });
    if (res.duplicate) return { ok: false, message: "A matching trade already exists (duplicate)." };
    revalidatePath("/trades");
    revalidatePath("/risk");
    revalidatePath("/equity");
    revalidatePath("/active");
    revalidatePath("/");
    return { ok: true, message: isOpenTrade ? "Open trade added — see Portfolio Risk." : "Trade added." };
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
  db.delete(trades).where(eq(trades.id, id)).run();
  revalidatePath("/trades");
  revalidatePath("/");
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
  // Legs already exist → the opening side is whichever the first leg used; for
  // a fresh conversion fall back to the classic sell-first heuristic.
  return t.sellQty > 0 && t.buyQty === 0 ? "short" : "long";
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
