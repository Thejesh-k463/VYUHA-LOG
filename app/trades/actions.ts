"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { commitManualTrade, applyOverride } from "@/lib/import/commit";
import { SEGMENTS, EXCHANGES, SEGMENT_BUCKET, type Segment } from "@/lib/domain/constants";
import { classify } from "@/lib/engine/classify";
import { evaluateLimits } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState } from "@/lib/queries/limits";
import type { NormalizedTrade } from "@/lib/engine/types";

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
  broker: z.enum(["dhan", "zerodha", "groww"]),
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
      fundedAmount: num(formData.get("fundedAmount")) || null,
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
