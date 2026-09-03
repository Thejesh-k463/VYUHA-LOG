import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { removeBrokerRows } from "@/lib/trash";
import { ImportSourceError, assertAccountId, countTradesByBroker } from "@/lib/queries/import-sources";

/**
 * Broker-scoped remove before a clean re-import (v3.8 W2a).
 *
 *   GET  ?accountId=N                          → { accountId, sources: BrokerTradeCount[] }
 *   POST { accountId, broker, confirm: true }  → { ok, removed, unlinked, snapshotId, message }
 *
 * The account id travels in the request and is refused when 0 or missing
 * (`ACCOUNT_REQUIRED`, 400) BEFORE any query runs — the aggregate view is a
 * view, never a write target (invariant 9), and `getWriteAccountId`'s
 * fallback is exactly the guess a destructive route must not make. Every
 * refusal carries a stable `code` so the UI branches on it, not on prose.
 *
 * A route handler, not a server action (AGENTS.md): the import page keeps a
 * dropped file and a column mapping in client state that a server action's
 * auto-refresh would silently reset.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refuse(e: unknown): NextResponse {
  if (e instanceof ImportSourceError) {
    return NextResponse.json({ ok: false, code: e.code, message: e.message }, { status: e.status });
  }
  return NextResponse.json(
    { ok: false, code: "FAILED", message: `Nothing was removed — ${e instanceof Error ? e.message : "unknown error"}. Your journal is unchanged.` },
    { status: 500 },
  );
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("accountId");
  try {
    const accountId = assertAccountId(raw);
    return NextResponse.json({ accountId, sources: countTradesByBroker(accountId) });
  } catch (e) {
    return refuse(e);
  }
}

export async function POST(req: Request) {
  let body: { accountId?: unknown; broker?: unknown; confirm?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, code: "MALFORMED", message: "Malformed request." }, { status: 400 });
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { ok: false, code: "CONFIRM_REQUIRED", message: "Confirm the remove first — it takes every trade this broker put into the account." },
      { status: 400 },
    );
  }

  try {
    const res = removeBrokerRows({ accountId: body.accountId, broker: body.broker, actor: "ui" });
    for (const p of ["/import", "/trades", "/lenses", "/risk", "/equity", "/active", "/", "/backup"]) revalidatePath(p);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return refuse(e);
  }
}
