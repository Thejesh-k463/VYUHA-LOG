import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { getSelectedAccountId } from "@/lib/queries/accounts";
import { chargeInputsChanged, chargeInputsOf, statesNoCharges, storedCharges } from "@/lib/domain/trade-edit";
import type { ChargeBreakdown } from "@/lib/engine/types";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { findRates, pricingDate } from "@/lib/engine/rates";
import { todayIstIso } from "@/lib/domain/trading-day";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { SEGMENT_BUCKET, BROKERS, type Segment } from "@/lib/domain/constants";
import { getMarginPct } from "@/lib/queries/margin";
import { getSettings } from "@/lib/queries/settings";
import { defaultMtfFundedAmount } from "@/lib/risk/margin";

export const runtime = "nodejs";

const Body = z.object({
  broker: z.enum(BROKERS),
  tradingsymbol: z.string().min(1),
  productHint: z.enum(["intraday", "delivery", "mtf"]).nullish(),
  segment: z.string().nullish(),
  exchange: z.enum(["NSE", "BSE", "MCX"]).nullish(),
  buyValue: z.number().nonnegative(),
  sellValue: z.number().nonnegative(),
  buyQty: z.number().nonnegative(),
  sellQty: z.number().nonnegative(),
  // A SENT count wins; an omitted one is filled from settings below (V4).
  buyOrders: z.number().int().min(0).optional(),
  sellOrders: z.number().int().min(0).optional(),
  ownCapitalUsed: z.number().nonnegative().nullish(),
  /** Q-A (v4.3.0 wave 2N) — "this row's funded amount is NOT recorded", sent by
   *  the two dialogs that price an EXISTING row (the close dialog and the trade
   *  editor). Their saves keep the null and bill no interest for it, so the
   *  preview must too. The manual Add form never sets it: a NEW trade with the
   *  own-capital field left blank is still estimated by `commitManualTrade`,
   *  which is the one writer the ruling leaves alone. */
  mtfFundingUnstated: z.boolean().nullish(),
  daysHeld: z.number().nonnegative().nullish(),
  grossPnl: z.number().nullish(),
  isOpen: z.boolean().nullish(),
  // D4 (v4.3.0 wave 2N) — the row being EDITED, sent by the trade editor alone
  // (`editPreviewBody`). With it this route can answer the question its save
  // answers: does this edit change anything the engine is fed? If not, the row's
  // stored charges stand, and the preview shows exactly what the save will keep.
  // The other two callers (the close dialog, the manual Add form) send none and
  // are priced as before.
  tradeId: z.number().int().positive().nullish(),
  avgBuyPrice: z.number().nullish(),
  avgSellPrice: z.number().nullish(),
  // The trade's own dates (R56). Every SAVE prices at pricingDate — the sell
  // date, else the buy date — so a preview priced at today's epoch showed a
  // figure the save would not store. Today (IST) is only the fallback.
  buyDate: z.string().nullish(),
  sellDate: z.string().nullish(),
});

/**
 * D4 (v4.3.0 wave 2N) — the charges the trade editor's save would KEEP for this
 * body, or null when the save would re-price (and the engine below prices it).
 *
 * The stored row is read in the account being viewed (invariant 8: a trade id from
 * another book reads as "not found", and the preview is then priced fresh, exactly
 * as it was before this route could see a row at all).
 */
function keptCharges(tradeId: number, v: z.infer<typeof Body>): { breakdown: ChargeBreakdown; netPnl: number } | null {
  const accountId = getSelectedAccountId();
  const where = accountId > 0 ? and(eq(trades.id, tradeId), eq(trades.accountId, accountId)) : eq(trades.id, tradeId);
  const t = db.select().from(trades).where(where).get();
  if (!t) return null;

  const s = getSettings();
  const defaults = { buyOrders: s?.defaultBuyOrders ?? 1, sellOrders: s?.defaultSellOrders ?? 1 };
  const buyQty = v.buyQty;
  const sellQty = v.sellQty;
  const next = chargeInputsOf(
    {
      buyQty,
      avgBuyPrice: v.avgBuyPrice ?? (buyQty > 0 ? v.buyValue / buyQty : 0),
      buyValue: v.buyValue,
      buyDate: v.buyDate ?? null,
      sellQty,
      avgSellPrice: v.avgSellPrice ?? (sellQty > 0 ? v.sellValue / sellQty : 0),
      sellValue: v.sellValue,
      sellDate: v.sellDate ?? null,
      isOpen: v.isOpen ?? buyQty !== sellQty,
      buyOrderCount: v.buyOrders ?? defaults.buyOrders,
      sellOrderCount: v.sellOrders ?? defaults.sellOrders,
      // The funded amount the SAVE would store: an explicit own-capital entry wins,
      // otherwise the row keeps what it has — a stated 0 (V3) and a NULL alike
      // (Q-A, wave 2N: `updateManualTrade` no longer estimates one, so a preview
      // that did would call a notes-only save on an unpriced row a re-price).
      mtfFundedAmount:
        t.segment === "eq_mtf"
          ? v.ownCapitalUsed != null && v.ownCapitalUsed >= 0
            ? Math.max(0, Math.round((v.buyValue - v.ownCapitalUsed) * 100) / 100)
            : t.mtfFundedAmount
          : null,
    },
    defaults,
  );
  const row = t as unknown as Record<string, unknown>;
  if (statesNoCharges(row) || chargeInputsChanged(chargeInputsOf(t, defaults), next)) return null;
  return { breakdown: storedCharges(row), netPnl: t.netPnl };
}

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const v = parsed.data;
  // V4 — ONE default for a side's order count: settings.defaultBuyOrders /
  // defaultSellOrders, the count the saves bill for a side that gains its first
  // quantity (commitManualTrade, updateManualTrade, closePosition). No settings
  // row: 1, as lib/import/commit.ts loadRatesContext.
  const s = v.buyOrders === undefined || v.sellOrders === undefined ? getSettings() : null;
  const buyOrders = v.buyOrders ?? s?.defaultBuyOrders ?? 1;
  const sellOrders = v.sellOrders ?? s?.defaultSellOrders ?? 1;

  let cls = classify({
    tradingsymbol: v.tradingsymbol,
    broker: v.broker,
    productHint: v.productHint ?? null,
    exchangeHint: v.exchange ?? null,
  });
  if (v.segment) {
    const segment = v.segment as Segment;
    cls = { ...cls, segment, bucket: SEGMENT_BUCKET[segment], exchange: v.exchange ?? cls.exchange };
  }

  // D4 — the editor's save keeps every stored head when no charge input moved
  // (lib/import/commit.ts#updateManualTrade, one pure predicate in
  // lib/domain/trade-edit.ts). The preview must say the same, or the dialog shows
  // ₹52.72 beside a row that keeps ₹37.97 — the divergence
  // tests/preview-equals-save-matrix.test.ts exists to catch.
  const kept = v.tradeId == null ? null : keptCharges(v.tradeId, v);
  if (kept) {
    const grossKept = v.grossPnl ?? v.sellValue - v.buyValue;
    return NextResponse.json({
      classification: cls,
      breakdown: kept.breakdown,
      grossPnl: grossKept,
      netPnl: kept.netPnl,
      // Said out loud, so a caller that renders the figure can say whose it is.
      keptCharges: true,
    });
  }

  const rates = loadRatesMap();
  let breakdown;
  try {
    const r = findRates(rates, v.broker, cls.segment, cls.exchange, pricingDate({ buyDate: v.buyDate, sellDate: v.sellDate }, todayIstIso()));
    // Mirror commitManualTrade's MTF defaulting exactly, so the preview never
    // understates what actually gets saved: ownCapitalUsed (what YOU put in) is
    // the primary input, funded = buyValue − ownCapitalUsed; no explicit entry →
    // auto-estimate from margin_config's eq_mtf %. daysHeld forced to 0 for an
    // open position (interest hasn't accrued yet — see lib/jobs/mtf-accrual.ts).
    const isMtf = cls.segment === "eq_mtf";
    const fundedAmount = isMtf
      ? v.ownCapitalUsed != null && v.ownCapitalUsed >= 0
        ? Math.max(0, Math.round((v.buyValue - v.ownCapitalUsed) * 100) / 100)
        : // Q-A — a row whose funding the journal never recorded bills no
          // interest (and keeps its pledge charge), exactly as closePosition /
          // updateManualTrade now store it.
          v.mtfFundingUnstated
          ? 0
          : defaultMtfFundedAmount(v.buyValue, getMarginPct(v.broker, "eq_mtf"))
      : null;
    const daysHeld = v.isOpen ? 0 : v.daysHeld ?? 0;
    breakdown = computeCharges(
      {
        segment: cls.segment,
        buyValue: v.buyValue,
        sellValue: v.sellValue,
        buyQty: v.buyQty,
        sellQty: v.sellQty,
        buyOrderCount: buyOrders,
        sellOrderCount: sellOrders,
        mtf: isMtf ? { fundedAmount: fundedAmount!, daysHeld, pledgeScrips: 1 } : null,
      },
      r,
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const gross = v.grossPnl ?? v.sellValue - v.buyValue;
  return NextResponse.json({
    classification: cls,
    breakdown,
    grossPnl: gross,
    netPnl: Math.round((gross - breakdown.total) * 100) / 100,
  });
}
