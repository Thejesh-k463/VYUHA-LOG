import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * First-run onboarding flag (v3.7, WS3, migration 0057). Route handler + client
 * fetch + router.refresh(), never a server action (recorded convention).
 *
 * `settings.onboarding_completed_at` is INSTALL state, not a preference and not
 * account-scoped: it answers "has this copy been through its first run", which
 * is why it sits outside BASELINE_SETTINGS_FIELDS and inside
 * SETTINGS_MACHINE_COLUMNS (lib/domain/settings-baseline.ts,
 * lib/backup-format.ts). "Back to my defaults" must not re-run a wizard the
 * user finished, and a restored backup must not mark one finished that they
 * never saw. There is therefore no getWriteAccountId() here — nothing about
 * this row belongs to an account.
 *
 * "complete" is also what "Skip for now" sends: a skipped wizard must not
 * return every launch. "reset" powers Settings → "Run setup again", the only
 * way back, and it is audited for the same reason the Telegram toggle is —
 * a switch that changes what the app does on next launch leaves a trail.
 */

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("reset") }),
]);

// The wizard shows over the dashboard, and Settings carries the button that
// puts it back.
const PATHS = ["/", "/settings"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const p = schema.safeParse(body);
  if (!p.success) return NextResponse.json({ ok: false, message: p.error.issues[0]?.message ?? "Bad request" }, { status: 400 });

  const s = db.select().from(settings).limit(1).get();
  if (!s) return NextResponse.json({ ok: false, message: "No settings row." }, { status: 400 });

  const complete = p.data.action === "complete";
  // Completing twice keeps the FIRST timestamp: when this install finished its
  // first run is a fact about the install, and a second "Done" click (or a
  // wizard re-run) must not restate it. Reset is what clears it.
  const onboardingCompletedAt = complete ? (s.onboardingCompletedAt ?? new Date().toISOString()) : null;

  db.update(settings).set({ onboardingCompletedAt }).where(eq(settings.id, s.id)).run();
  recordAudit({
    entity: "settings",
    action: "update",
    summary: complete ? "First-run setup completed" : "First-run setup reset — the wizard will run again",
    before: { onboardingCompletedAt: s.onboardingCompletedAt },
    after: { onboardingCompletedAt },
  });

  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json({
    ok: true,
    message: complete ? "Setup complete." : "Setup will run again next time you open Vyuha.",
    onboardingCompletedAt,
  });
}
