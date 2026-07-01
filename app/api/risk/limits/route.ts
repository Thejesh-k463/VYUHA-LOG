import { NextResponse } from "next/server";
import { evaluateLimits, type ProspectiveOrder } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState, bucketForSegment } from "@/lib/queries/limits";

export const runtime = "nodejs";

/**
 * Pre-trade limits check. POST a prospective order; returns pass/warn/block with
 * each rule's verdict. Shared by the Add-open-trade form and the /risk what-if panel.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  const num = (v: unknown): number => {
    const n = Number(String(v ?? "").toString().replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  };
  const optNum = (v: unknown): number | null => {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const segment = String(body.segment ?? "").trim();
  const bucket = String(body.bucket ?? "").trim() || bucketForSegment(segment);
  const symbol = String(body.symbol ?? "").trim();
  const entry = num(body.entry);
  const qty = num(body.qty);

  if (entry <= 0 || qty <= 0) {
    return NextResponse.json({ ok: false, message: "Entry price and quantity are required." }, { status: 400 });
  }

  const order: ProspectiveOrder = {
    bucket,
    segment,
    symbol,
    entry,
    stop: optNum(body.stop),
    qty,
  };

  const rules = resolveRules(bucket, segment);
  const state = getPortfolioState(bucket, symbol);
  const result = evaluateLimits(order, rules, state);

  return NextResponse.json({ ok: true, result, rules, state, bucket });
}
