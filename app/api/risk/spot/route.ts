import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mtmPrices } from "@/lib/db/schema";
import { todayIstIso } from "@/lib/domain/trading-day";
import { writeTypedMark } from "@/lib/queries/mtm";
import { isContractKey } from "@/lib/risk/spot-ref";

export const runtime = "nodejs";

/**
 * ONE underlying's cash mark, typed on the moneyness chip on /risk.
 *
 * WHY A ROUTE AND NOT THE BULK-MTM SERVER ACTION. The chip first reached
 * `saveMtmPrices` (a server action) because no route reached `writeTypedMark`
 * for a bare symbol — `/api/positions/risk` is keyed on `tradeId` and refuses a
 * derivative row's mark outright. But AGENTS.md is explicit: an editor write is
 * a route handler + client `fetch` + `router.refresh()`, never a server action,
 * because an action revalidates the whole route and REMOUNTS the sibling client
 * components — on /risk that is the cockpit, whose open row and dialog state
 * would silently reset every time someone typed a spot. This is that route.
 *
 * NO ACCOUNT SCOPE, DELIBERATELY. `mtm_prices` has no `account_id` column: a
 * mark is a fact about the market, not about a book, and every account reads
 * the same one. So there is no `getSelectedAccountId()` read here and no
 * `getWriteAccountId()` write guard — invariants 8 and 9 have nothing to bind
 * to. (`tests/account-isolation.test.ts` is what would catch the day that
 * changes: it fails on any table that gains an `account_id` without a scoped
 * read.)
 *
 * MONEY: `price` is REAL RUPEES — a per-unit price, invariant 1's documented
 * exception. Nothing here converts.
 */

/**
 * THE CONTRACT-KEY RULE IS IMPORTED, NOT COPIED. `mtm_prices` keys its
 * derivative rows `OPT …` / `FUT …`; a spot mark is never one of those — it
 * belongs to the cash underlying, and a premium stored under the underlying's
 * symbol would delete the cash mark every share position reads (see
 * `writeTypedMark`'s own doc-comment).
 *
 * This route used to keep its own copy of that one-line rule, for one reason
 * only: the rule lived in `components/risk/spot-mark-editor.tsx`, a
 * `"use client"` module, and every export of one of those reaches the server
 * layer as a throwing `registerClientReference` stub. The rule is now pure, in
 * `lib/risk/spot-ref.ts`, so both sides of the wire call the SAME function and
 * cannot drift — which is what the copy risked.
 */

const bad = (message: string) => NextResponse.json({ ok: false, message, updated: 0 }, { status: 400 });

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { symbol?: unknown; price?: unknown } | null;
  if (!body || typeof body !== "object") return bad("Bad request");

  const symbol = String(body.symbol ?? "").trim().toUpperCase();
  if (!symbol) return bad("A spot mark needs the underlying's symbol.");
  if (isContractKey(symbol)) {
    return bad(`${symbol} is a contract key — a spot mark belongs to the underlying's symbol, never OPT …/FUT ….`);
  }

  // Refused BEFORE any write, like /api/positions/risk: a typed mark REPLACES
  // the day's row, so letting a 0 or a negative through would delete a real
  // mark and print −100 % on every figure that reads it (invariant 6).
  const price = Number(body.price);
  if (!Number.isFinite(price) || price <= 0) return bad("A mark is a price above zero.");

  // The same as-of default the bulk-MTM box uses — today's IST day, never a UTC
  // one and never a date this chip invented: every reader takes the newest
  // `as_of_date` as a string, so an invented day would outrank every real one.
  const asOfDate = todayIstIso();

  // TRADINGSYMBOL. `undefined` tells `writeTypedMark` to carry whatever today's
  // row already holds, which is right for a key the live feed recorded — but
  // `getSpotMap()` SKIPS any row whose tradingsymbol starts with `OPT `/`FUT `,
  // and the bulk-MTM box stores the first OPEN trade's tradingsymbol for the
  // symbol it was handed, which for an underlying whose only open position is
  // an option IS a contract key. Carrying that would file the spot the user
  // just typed in a row the moneyness panel cannot read — the chip would appear
  // to do nothing. In that one case the CASH key is written instead.
  const held = db
    .select({ tradingsymbol: mtmPrices.tradingsymbol })
    .from(mtmPrices)
    .where(and(eq(mtmPrices.symbol, symbol), eq(mtmPrices.asOfDate, asOfDate)))
    .limit(1)
    .get();
  const heldKey = (held?.tradingsymbol ?? "").trim().toUpperCase();
  const tradingsymbol = heldKey && isContractKey(heldKey) ? symbol : undefined;

  try {
    writeTypedMark({ symbol, tradingsymbol, price, asOfDate });
  } catch (e) {
    // The backstop refusals inside writeTypedMark are answered as this route's
    // own words rather than as a stack trace (the shape /api/license and
    // /api/import use for a write that threw).
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "The mark was not stored.", updated: 0 },
      { status: 500 },
    );
  }

  // Every surface that reads a mark, matching /api/positions/risk.
  for (const path of ["/risk", "/equity", "/active", "/", "/trades"]) revalidatePath(path);
  return NextResponse.json({ ok: true, message: `${symbol} spot stored.`, updated: 1 });
}
