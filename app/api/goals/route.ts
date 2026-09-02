import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteGoal, upsertGoal } from "@/lib/queries/goals";

export const runtime = "nodejs";

/**
 * Capital-goal writes (v3.6). The decisions and the writes live in
 * lib/queries/goals.ts so the temp-DB tests exercise the real path; this route
 * only parses, calls, and revalidates. Clients use fetch + router.refresh()
 * (never server actions — recorded convention).
 */

const dateISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Target date must be YYYY-MM-DD");

// Sane upper bound: ₹10,000 Cr. A target beyond it is a typo (an extra digit,
// paise pasted as rupees), and storing it would render every progress % as a
// confident rounding error — refused with the reason, never clamped.
const MAX_TARGET_RUPEES = 1e11;

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    bucket: z.enum(["equity", "active", "total"]),
    kind: z.enum(["absolute", "pct_profit"]),
    targetAmount: z
      .number()
      .positive()
      .max(MAX_TARGET_RUPEES, "A ₹ target above ₹10,000 Cr reads like a typo — check the amount; nothing was saved.")
      .nullable()
      .optional(),
    pctTarget: z.number().positive().max(10000).nullable().optional(),
    targetDate: dateISO.nullable().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    bucket: z.enum(["equity", "active", "total"]),
  }),
]);

// Every surface that renders a goal (mirrors app/api/capital/route.ts).
const PATHS = ["/", "/reports/performance", "/targets/equity", "/targets/active", "/settings"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const p = schema.safeParse(body);
  if (!p.success) return NextResponse.json({ ok: false, message: p.error.issues[0]?.message }, { status: 400 });

  const res =
    p.data.action === "delete"
      ? deleteGoal(p.data.bucket)
      : upsertGoal({
          bucket: p.data.bucket,
          kind: p.data.kind,
          targetAmount: p.data.targetAmount ?? null,
          pctTarget: p.data.pctTarget ?? null,
          targetDate: p.data.targetDate ?? null,
        });

  // Aggregate-view write ban → 403, matching /api/bf-losses: the write is
  // understood but this view may never make it. Every other refusal is a 400.
  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });
  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json(res);
}
