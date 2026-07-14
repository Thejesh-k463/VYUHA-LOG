import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { runAutoMtm } from "@/lib/jobs/auto-mtm";

export const runtime = "nodejs";

/** Trigger an opt-in auto-MTM run (no-op unless enabled in Settings; at most
 *  once per bhavcopy date). Fired in the background on app open by
 *  AutoMtmRunner — never blocks anything, never throws to the client. */
export async function POST() {
  const outcome = await runAutoMtm();
  if (outcome.ran) {
    for (const p of ["/", "/risk", "/equity", "/active", "/reports/performance", "/strategies"]) revalidatePath(p);
  }
  return NextResponse.json({ ok: true, ...outcome });
}
