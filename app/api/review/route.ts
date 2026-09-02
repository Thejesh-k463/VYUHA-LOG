import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { markReviewed, reopenReview, upsertWeeklyReview } from "@/lib/queries/review";

export const runtime = "nodejs";

/**
 * Trade Review Desk writes (v3.7, WS1). The decisions and the writes live in
 * lib/queries/review.ts so the temp-DB tests exercise the real path; this route
 * only parses, calls, and revalidates. Clients use fetch + router.refresh()
 * (never server actions — recorded convention).
 *
 * The aggregate-view refusal maps to 403 (the write is understood but this view
 * may never make it); every other refusal is a 400.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A week is filed against its ISO Monday (YYYY-MM-DD)");
const tradeId = z.number().int().positive();
// The weekly note is the user's own prose, so the cap is generous; a bound
// still exists because an unbounded body is a body nobody chose to write.
const note = z.string().max(20000).nullable().optional();

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark-reviewed"), id: tradeId }),
  z.object({ action: z.literal("reopen"), id: tradeId }),
  z.object({ action: z.literal("weekly-upsert"), weekStart: isoDate, note }),
  z.object({
    action: z.literal("weekly-complete"),
    weekStart: isoDate,
    note,
    // Whole 0–100 or explicit null: under the sample floor the Process Score
    // refuses to exist, and null is how that is recorded (never 0).
    scoreAtCompletion: z.number().int().min(0).max(100).nullable().optional(),
  }),
]);

// Every surface whose render depends on a review stamp or a weekly row: the
// desk itself, the trades table's reviewed marker, the discipline report's
// weekly score, and the dashboard's "review open" card.
const PATHS = ["/review", "/trades", "/reports/discipline", "/"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const p = schema.safeParse(body);
  if (!p.success) return NextResponse.json({ ok: false, message: p.error.issues[0]?.message }, { status: 400 });

  const res =
    p.data.action === "mark-reviewed"
      ? markReviewed(p.data.id)
      : p.data.action === "reopen"
        ? reopenReview(p.data.id)
        : p.data.action === "weekly-upsert"
          ? upsertWeeklyReview({ weekStart: p.data.weekStart, note: p.data.note ?? null })
          : upsertWeeklyReview({
              weekStart: p.data.weekStart,
              note: p.data.note ?? null,
              completed: true,
              scoreAtCompletion: p.data.scoreAtCompletion ?? null,
            });

  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });
  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json(res);
}
