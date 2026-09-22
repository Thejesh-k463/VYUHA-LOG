import { NextResponse } from "next/server";
import { evaluateLimits, type ProspectiveOrder } from "@/lib/risk/limits";
import { resolveRules, getPortfolioState, bucketForSegment } from "@/lib/queries/limits";
import { parseFormNumber } from "@/lib/domain/signal";

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

  // B1 (v4.5.0 fix list) — THE form-number rule, in one place (`parseFormNumber`,
  // lib/domain/signal.ts, added in v4.4.0 for every trade-form number). These two
  // stripped commas by hand, so "14,48" and "1e5" read as numbers the user never
  // typed. The refusal semantics are unchanged: an unreadable value is still 0
  // here and null in `optNum`, and a blank is still null.
  const num = (v: unknown): number => parseFormNumber(String(v ?? "")) ?? 0;
  const optNum = (v: unknown): number | null => {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    return parseFormNumber(s);
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
