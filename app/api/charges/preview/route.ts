import { NextResponse } from "next/server";
import { z } from "zod";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { SEGMENT_BUCKET, type Segment } from "@/lib/domain/constants";
import { getMarginRates } from "@/lib/queries/margin";
import { defaultMtfFundedAmount, DEFAULT_MTF_OWN_MARGIN_PCT } from "@/lib/risk/margin";

export const runtime = "nodejs";

const Body = z.object({
  broker: z.enum(["dhan", "zerodha", "groww"]),
  tradingsymbol: z.string().min(1),
  productHint: z.enum(["intraday", "delivery", "mtf"]).nullish(),
  segment: z.string().nullish(),
  exchange: z.enum(["NSE", "BSE", "MCX"]).nullish(),
  buyValue: z.number().nonnegative(),
  sellValue: z.number().nonnegative(),
  buyQty: z.number().nonnegative(),
  sellQty: z.number().nonnegative(),
  buyOrders: z.number().int().min(0).default(1),
  sellOrders: z.number().int().min(0).default(1),
  fundedAmount: z.number().nonnegative().nullish(),
  daysHeld: z.number().nonnegative().nullish(),
  grossPnl: z.number().nullish(),
  isOpen: z.boolean().nullish(),
});

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const v = parsed.data;

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

  const rates = loadRatesMap();
  let breakdown;
  try {
    const r = findRates(rates, v.broker, cls.segment, cls.exchange);
    // Mirror commitManualTrade's MTF defaulting exactly, so the preview never
    // understates what actually gets saved: an explicit fundedAmount wins, else
    // auto-estimate from margin_config's eq_mtf %; daysHeld forced to 0 for an
    // open position (interest hasn't accrued yet — see lib/jobs/mtf-accrual.ts).
    const isMtf = cls.segment === "eq_mtf";
    const fundedAmount = isMtf
      ? v.fundedAmount && v.fundedAmount > 0
        ? v.fundedAmount
        : defaultMtfFundedAmount(v.buyValue, getMarginRates().get("eq_mtf") ?? DEFAULT_MTF_OWN_MARGIN_PCT)
      : null;
    const daysHeld = v.isOpen ? 0 : v.daysHeld ?? 0;
    breakdown = computeCharges(
      {
        segment: cls.segment,
        buyValue: v.buyValue,
        sellValue: v.sellValue,
        buyQty: v.buyQty,
        sellQty: v.sellQty,
        buyOrderCount: v.buyOrders,
        sellOrderCount: v.sellOrders,
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
