import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { unCloseExecution, type UnCloseCode } from "@/lib/import/commit";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { executionHashOfPiece } from "@/lib/import/close-open-lots";

export const runtime = "nodejs";

/**
 * W3 — UNDO an import's automatic close (Trades → the row's menu → "Un-close").
 *
 * A route handler answered by client `fetch` + `router.refresh()`, NOT a server
 * action: a server action refreshes the route itself and remounts the sibling
 * client components, silently resetting their state (AGENTS.md). Every rule —
 * the account the user is viewing, the shape refusals, the exact inverse of the
 * charge split — lives in `unCloseExecution`; this file only maps its answer to
 * HTTP.
 *
 * Body: `{ tradeId }` (the row the user is looking at — the execution and its
 * account are read from that row), or `{ accountId, broker, execHash }` for a
 * caller that already knows the execution (Data Quality).
 *
 * It is the door every W3 refusal points at: a row delete, an import-batch
 * delete and an account merge all refuse to break a close and name this.
 */

const STATUS: Record<UnCloseCode, number> = {
  NOT_FOUND: 404,
  OTHER_ACCOUNT: 403,
  SHAPE: 409,
  STAGED: 409,
  JOURNAL: 409,
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { tradeId?: unknown; accountId?: unknown; broker?: unknown; execHash?: unknown }
    | null;

  let accountId = Number(body?.accountId);
  let broker = typeof body?.broker === "string" ? body.broker : "";
  let execHash = typeof body?.execHash === "string" ? body.execHash : "";

  const tradeId = Number(body?.tradeId);
  if (Number.isInteger(tradeId) && tradeId > 0) {
    // The row the user pressed the button on is the fact; its execution is read
    // from it, never taken from the request.
    const row = db.select().from(trades).where(eq(trades.id, tradeId)).get();
    if (!row) {
      return NextResponse.json({ ok: false, code: "NOT_FOUND", message: "That trade is no longer in the journal. Nothing was changed." }, { status: 404 });
    }
    accountId = row.accountId;
    broker = row.broker;
    // A lot a sale consumed WHOLE keeps its own identity and holds the
    // execution's as an alias, so the execution is read through the one rule
    // that knows both shapes — never off the `dedup_hash` column, which there
    // is the LOT's and made un-close refuse its own commonest shape.
    execHash = executionHashOfPiece(row);
  }

  if (!Number.isInteger(accountId) || accountId <= 0 || !broker || !execHash) {
    return NextResponse.json({ ok: false, code: "NOT_FOUND", message: "Name the row to un-close. Nothing was changed." }, { status: 400 });
  }

  /**
   * A7 (DECIDED, v4.5.0 fix list) — A MID-UN-CLOSE FAILURE ANSWERS, IT DOES NOT
   * THROW.
   *
   * `unCloseExecution` does its work in ONE transaction, so a failure part way
   * through rolls the book back (proven by the W3 tests): nothing is half
   * un-closed. But the throw propagated, and Next answered the client `fetch`
   * with a 500 HTML page — the dialog then showed its generic "request failed"
   * and the user had no idea whether the journal had moved. Every other refusal
   * on this route is `{ok:false, code, message}`; this one now is too, at 409
   * ("your book is unchanged" is a statement about a conflict, not a crash),
   * and the sentence says so explicitly.
   */
  let res: ReturnType<typeof unCloseExecution>;
  try {
    res = unCloseExecution(accountId, broker, execHash);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        code: "FAILED",
        message: `Un-close could not be completed, so nothing was changed — your book is exactly as it was. (${detail})`,
      },
      { status: 409 },
    );
  }
  if (res.ok) {
    for (const p of ["/trades", "/data-quality", "/equity", "/risk", "/active", "/"]) revalidatePath(p);
  }
  return NextResponse.json(res, { status: res.ok ? 200 : STATUS[res.code ?? "SHAPE"] });
}
