import { NextResponse } from "next/server";
import {
  BACKFILL_DEFAULT_DAYS,
  BACKFILL_MAX_DAYS,
  BACKFILL_RATE_LIMIT_MS,
  hasBackfillConsent,
  readBackfillProgress,
  recordBackfillAck,
  requestBackfillAbort,
  runBhavcopyBackfill,
} from "@/lib/jobs/bhavcopy-backfill";
import { CROSS_ORIGIN_MESSAGE, isSameOrigin } from "../origin";

/**
 * `GET  /api/atlas/backfill` — the persisted progress (the UI polls this).
 * `POST /api/atlas/backfill` — `{action:"ack"|"start"|"abort", days?}`.
 *
 * THE 403 IS THE POINT. Without `auto_mtm_enabled` or an explicit
 * `bhavcopy_backfill_ack`, `start` is refused outright — not silently ignored,
 * not started-then-stopped. A backfill downloads up to 252 files from NSE, and
 * research answer Q43 makes that a decision the user makes on purpose, once.
 *
 * The run is NOT awaited: 252 files at one every 1.5 s is about six and a half
 * minutes, and no HTTP request should be held open for that. The loop persists
 * its progress after every date, so the UI polls GET and a reload — or a
 * restart — still sees where it got to.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
  return NextResponse.json({
    ok: true,
    consented: hasBackfillConsent(),
    rateLimitMs: BACKFILL_RATE_LIMIT_MS,
    defaultDays: BACKFILL_DEFAULT_DAYS,
    maxDays: BACKFILL_MAX_DAYS,
    progress: readBackfillProgress(),
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: CROSS_ORIGIN_MESSAGE }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; days?: number };
  const action = body.action ?? "start";

  if (action === "ack") {
    recordBackfillAck();
    return NextResponse.json({ ok: true, consented: hasBackfillConsent(), progress: readBackfillProgress() });
  }

  if (action === "abort") {
    return NextResponse.json({ ok: true, progress: requestBackfillAbort() });
  }

  if (action !== "start") {
    return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
  }

  if (!hasBackfillConsent()) {
    return NextResponse.json(
      {
        error:
          "The history backfill downloads up to 252 past bhavcopy files from NSE. Confirm it first — " +
          "or switch on end-of-day auto-MTM in Settings, which is consent to the same host.",
        consented: false,
      },
      { status: 403 },
    );
  }

  const current = readBackfillProgress();
  if (current.status === "running") {
    return NextResponse.json({ error: "A backfill is already running.", progress: current }, { status: 409 });
  }

  const days = Number.isFinite(body.days) ? Number(body.days) : BACKFILL_DEFAULT_DAYS;
  // Deliberately NOT awaited — see the header. A rejection can only come from
  // a bug, and it must not become an unhandled rejection that kills the
  // sidecar mid-run.
  void runBhavcopyBackfill({ days }).catch(() => undefined);

  return NextResponse.json({ ok: true, started: true, days, progress: readBackfillProgress() });
}
