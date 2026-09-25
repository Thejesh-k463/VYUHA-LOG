import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { runAutoMtm } from "@/lib/jobs/auto-mtm";
import { isAutoMtmEnabled, runBhavcopyCatchup } from "@/lib/jobs/bhavcopy-catchup";

export const runtime = "nodejs";

/** Trigger an opt-in auto-MTM run (no-op unless enabled in Settings; at most
 *  once per bhavcopy date). Fired in the background on app open by
 *  AutoMtmRunner — never blocks anything, never throws to the client.
 *
 *  v4.6.0 W5 (Q51 A1): AFTER the day's top-up, and ONLY when the same toggle is
 *  on, the freshness catch-up fills up to ten missing past sessions at the
 *  backfill's pace. It is fired with `void` — the response never waits on it —
 *  and the shared progress envelope plus a process lock keep it to one run at
 *  a time (lib/jobs/bhavcopy-catchup.ts). */
export async function POST() {
  const outcome = await runAutoMtm();
  if (outcome.ran) {
    for (const p of ["/", "/risk", "/equity", "/active", "/reports/performance", "/strategies"]) revalidatePath(p);
  }
  if (isAutoMtmEnabled()) {
    void runBhavcopyCatchup().catch(() => {
      /* offline, blocked, or refused — the envelope says which; never thrown to the client */
    });
  }
  return NextResponse.json({ ok: true, ...outcome });
}
