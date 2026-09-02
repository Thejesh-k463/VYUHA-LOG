import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { runAutoPull } from "@/lib/jobs/auto-pull";

export const runtime = "nodejs";

/** Trigger the opt-in once-per-day auto-pull sweep (no-op unless enabled in
 *  Settings and not yet swept today; only UNATTENDED connections; 409-shaped
 *  outcomes are skipped, never forced — see lib/jobs/auto-pull.ts). Fired in
 *  the background on app open by AutoPullRunner. */
export async function POST() {
  const outcome = await runAutoPull();
  if (outcome.summary.some((e) => e.status === "imported")) {
    for (const p of ["/", "/trades", "/import"]) revalidatePath(p);
  }
  return NextResponse.json({ ok: true, ...outcome });
}
