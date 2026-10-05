import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { unJoinStaleClose, type UnJoinCode } from "@/lib/import/commit";

export const runtime = "nodejs";

/**
 * v4.8.0 FIX-A (J-3, owner ruling 2026-10-05) — UNDO a Data Quality join
 * (Trades → the row's menu → "Undo Data Quality join").
 *
 * A route handler answered by client `fetch` + `router.refresh()`, NOT a server
 * action: a server action refreshes the route itself and remounts the sibling
 * client components, silently resetting the table's state (AGENTS.md). Every
 * rule — the account the user is viewing, the join's shape, the restore from
 * the audit `before`, the sale back from its Trash envelope in ONE transaction
 * — lives in `unJoinStaleClose`; this file only maps its answer to HTTP.
 *
 * Body: `{ lotId }` — the row the user pressed the button on. The sale is read
 * from the lot's own alias and its Trash envelope, never taken from the request.
 */

const STATUS: Record<UnJoinCode, number> = {
  NOT_FOUND: 404,
  OTHER_ACCOUNT: 403,
  SHAPE: 409,
  STAGED: 409,
  // The sale the join removed is no longer in Deleted items: a conflict with
  // the book's state, not a crash — nothing is invented.
  ENVELOPE_GONE: 409,
  FAILED: 409,
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { lotId?: unknown } | null;
  const lotId = Number(body?.lotId);
  if (!Number.isInteger(lotId) || lotId <= 0) {
    return NextResponse.json({ ok: false, code: "NOT_FOUND", message: "Name the position whose Data Quality join to undo. Nothing was changed." }, { status: 400 });
  }

  // A mid-un-join failure ANSWERS, it does not throw (the un-close route's A7
  // rule): the transaction rolled the book back, and the sentence says so.
  let res: ReturnType<typeof unJoinStaleClose>;
  try {
    res = unJoinStaleClose(lotId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, code: "FAILED", message: `The join could not be undone, so nothing was changed — your book is exactly as it was. (${detail})` },
      { status: 409 },
    );
  }
  if (res.ok) {
    for (const p of ["/trades", "/data-quality", "/equity", "/risk", "/active", "/backup", "/"]) revalidatePath(p);
  }
  return NextResponse.json(res, { status: res.ok ? 200 : STATUS[res.code ?? "SHAPE"] });
}
