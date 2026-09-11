import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { closeStaleLot, type StaleCloseCode } from "@/lib/import/commit";

export const runtime = "nodejs";

/**
 * R26 (v4.3.0) — close a stale open lot with the sale the book already stored
 * for it (Data Quality → "Close with the recorded sale").
 *
 * A route handler answered by client `fetch` + `router.refresh()`, NOT a server
 * action: a server action refreshes the route itself and remounts the sibling
 * client components (AGENTS.md). Every rule — the re-derived pair, the account
 * the user is viewing, the journal-field refusal, the charges — lives in
 * `closeStaleLot`; this file only maps its answer to HTTP.
 *
 * Body: `{ lotId, saleId, exitDate }`. `exitDate` is REQUIRED: the screen
 * pre-fills it with the sale row's own date, or with the IST day that row was
 * pulled when it states none, and the user accepts or edits it — a close date
 * is never assumed here (invariant 6).
 */

const STATUS: Record<StaleCloseCode, number> = {
  BAD_DATE: 400,
  OTHER_ACCOUNT: 403,
  NOT_FOUND: 404,
  NO_PAIR: 409,
  PARTIAL: 409,
  JOURNAL: 409,
  DELETE_FAILED: 500,
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { lotId?: unknown; saleId?: unknown; exitDate?: unknown } | null;
  const lotId = Number(body?.lotId);
  const saleId = Number(body?.saleId);
  if (!Number.isInteger(lotId) || lotId <= 0 || !Number.isInteger(saleId) || saleId <= 0) {
    return NextResponse.json({ ok: false, message: "Name the position and its recorded sale. Nothing was changed." }, { status: 400 });
  }
  const exitDate = typeof body?.exitDate === "string" ? body.exitDate : null;
  if (!exitDate) {
    return NextResponse.json(
      { ok: false, code: "BAD_DATE", message: "Confirm the date of the recorded sale first. Nothing was changed." },
      { status: 400 },
    );
  }

  const res = closeStaleLot(lotId, saleId, exitDate);
  if (res.ok) {
    for (const p of ["/data-quality", "/trades", "/equity", "/risk", "/active", "/"]) revalidatePath(p);
  }
  return NextResponse.json(res, { status: res.ok ? 200 : STATUS[res.code ?? "NO_PAIR"] });
}
