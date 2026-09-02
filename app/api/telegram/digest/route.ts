import { NextResponse } from "next/server";
import { runTelegramDigest } from "@/lib/jobs/telegram-digest";

export const runtime = "nodejs";

/** Trigger the opt-in Telegram EOD digest (no-op unless every precondition in
 *  lib/telegram/digest-gate.ts holds; stamped once per day, only on a
 *  confirmed send). Fired in the background on app open by TelegramRunner —
 *  never blocks anything, never throws to the client. */
export async function POST() {
  const outcome = await runTelegramDigest();
  return NextResponse.json({ ok: true, ...outcome });
}
