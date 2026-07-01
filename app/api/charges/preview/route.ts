import { NextResponse } from "next/server";
import { z } from "zod";
import { classify } from "@/lib/engine/classify";
import { computeCharges } from "@/lib/engine/charges";
import { findRates } from "@/lib/engine/rates";
import { loadRatesMap } from "@/lib/engine/rates-db";
import { SEGMENT_BUCKET, type Segment } from "@/lib/domain/constants";

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
    breakdown = computeCharges(
      {
        segment: cls.segment,
        buyValue: v.buyValue,
        sellValue: v.sellValue,
        buyQty: v.buyQty,
        sellQty: v.sellQty,
        buyOrderCount: v.buyOrders,
        sellOrderCount: v.sellOrders,
        mtf:
          cls.segment === "eq_mtf" && v.fundedAmount
            ? { fundedAmount: v.fundedAmount, daysHeld: v.daysHeld ?? 0, pledgeScrips: 1 }
            : null,
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
