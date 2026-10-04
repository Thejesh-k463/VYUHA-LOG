import { NextResponse } from "next/server";
import { runTelegramAlerts } from "@/lib/jobs/telegram-alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/telegram/alerts` — the ONE door to the Telegram stop/target alert
 * check (v4.7.0 C5, design D1; the job is lib/jobs/telegram-alerts.ts). The
 * client runner POSTs here about once a minute while Vyuha is open and
 * schedules its next POST from `nextInMs`; every gate (Pro, consent, the feed,
 * the calendar) is applied server-side by the job.
 *
 * THE CONTRACT (review R10): a REFUSAL is not an error. "Not Pro", "market
 * closed", "end-of-day feed" … all answer HTTP 200 `{ok:true, refused, nextInMs}`
 * (plus `detail` on `feed-reaccept`: the feed's own blocked reason, R4) — a 4xx every minute would put a console error on every page the runner is
 * mounted on. A run that checked answers `{ok:true, refused:null, sent, failed,
 * summarySent, nextInMs}`, where `failed` carries `sendTelegram`'s own
 * hand-built reason (never the token, never a caught message). Only a request
 * that is not the app's own — cross-origin — or is malformed gets a 4xx.
 */

/** The desktop shell and the dev server; anything else must match the host. */
const LOCAL_ORIGINS = /^(?:tauri\.localhost|localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * Same-origin guard, the `app/api/live/stream/route.ts` `isSameOrigin` rule
 * (there is still no shared helper for route files — `app/api/atlas/origin.ts`
 * is the Atlas's own): DENY the known-cross-origin case rather than allow one
 * fixed origin, because a same-origin request may carry no `Origin` header.
 */
function isSameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = req.headers.get("host");
    if (host && url.host.toLowerCase() === host.toLowerCase()) return true;
    return LOCAL_ORIGINS.test(url.hostname);
  } catch {
    return false;
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: "This door only answers the app itself." }, { status: 403 });
  }
  // The body is optional and carries nothing the job reads; a body that is
  // present but not a JSON object is malformed.
  const text = await req.text().catch(() => "");
  if (text.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, message: "Bad request." }, { status: 400 });
    }
  }

  const out = await runTelegramAlerts();
  if (out.refused) {
    // `detail` rides only a feed-reaccept refusal: the registry's blockedReason
    // (a fixed sentence — never a token, key or host; review R4, D-C5-1).
    return NextResponse.json({
      ok: true,
      refused: out.refused,
      nextInMs: out.nextInMs,
      ...(out.detail ? { detail: out.detail } : {}),
    });
  }
  return NextResponse.json({
    ok: true,
    refused: null,
    sent: out.sent,
    failed: out.failed,
    summarySent: out.summarySent,
    checked: out.checked,
    nextInMs: out.nextInMs,
  });
}
