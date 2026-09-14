import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { dismissPanel } from "@/lib/queries/dismissals";
import { isContractKey, isIsoDay, SPOT_CLOSE_DIFF_PANEL, spotCloseFingerprint } from "@/lib/risk/spot-ref";

export const runtime = "nodejs";

/**
 * R13 — "Keep my mark": the user has read "Official close <day>: ₹X — differs
 * from your mark ₹Y" on /risk and keeps the stored mark.
 *
 * WHY A ROUTE AND NOT A SERVER ACTION. AGENTS.md: an editor write is a route
 * handler + client `fetch` + `router.refresh()`. An action revalidates /risk and
 * remounts the cockpit's client components, silently resetting its open row.
 *
 * WHAT IT WRITES. One `panel_dismissals` row through the existing writer
 * (`dismissPanel` in lib/queries/dismissals.ts — not a second one): panel
 * `spot-close-diff`, fingerprint `${SYMBOL}|${close day}|${close in paise}`. The
 * fingerprint is built HERE from the close the row showed, so a newer or
 * corrected close is a different fingerprint and the notice returns. A body
 * that names a close nobody has on record hides nothing: the page only checks
 * the fingerprint of the close it actually holds.
 *
 * WHICH ACCOUNT. A dismissal belongs to one book: `dismissPanel` files it on
 * the write account and REFUSES the All-accounts view (invariant 9 — 0 is a
 * view, not a place), which this route answers as 403, the mapping
 * /api/dismissals uses. The generic /api/dismissals route does NOT accept this
 * panel: its enum lists the Trades panels only.
 *
 * MONEY: `closePrice` is REAL RUPEES per unit (invariant 1's documented
 * exception); the paise in the fingerprint are a comparison key, never stored
 * as money.
 */

const bad = (message: string) => NextResponse.json({ ok: false, message }, { status: 400 });

/** NSE/BSE tickers are far shorter; the cap keeps the fingerprint within the
 *  64 characters `/api/dismissals` allows for any panel. */
const MAX_SYMBOL = 40;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { symbol?: unknown; closeAsOf?: unknown; closePrice?: unknown }
    | null;
  if (!body || typeof body !== "object") return bad("Bad request");

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  if (!symbol || symbol.length > MAX_SYMBOL) return bad("Keeping a mark needs the underlying's symbol.");
  if (isContractKey(symbol)) {
    return bad(`${symbol} is a contract key — a spot mark belongs to the underlying's symbol, never OPT …/FUT ….`);
  }
  if (!isIsoDay(body.closeAsOf)) return bad("The official close's day is a calendar day (YYYY-MM-DD).");
  const closePrice = Number(body.closePrice);
  if (body.closePrice == null || !Number.isFinite(closePrice) || closePrice <= 0) {
    return bad("The official close is a price above zero.");
  }

  const res = dismissPanel(SPOT_CLOSE_DIFF_PANEL, spotCloseFingerprint(symbol, { price: closePrice, asOf: body.closeAsOf }));
  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });

  revalidatePath("/risk");
  return NextResponse.json({ ok: true, message: `${symbol}: mark kept against the ${body.closeAsOf} close.` });
}
