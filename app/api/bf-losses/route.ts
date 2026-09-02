import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteBfLoss, upsertBfLoss, LOSS_HEADS } from "@/lib/queries/bf-losses";

export const runtime = "nodejs";

/**
 * Brought-forward loss writes (v3.6, WS5). The decisions and the writes live
 * in lib/queries/bf-losses.ts so the temp-DB tests exercise the real path;
 * this route only parses, calls, and revalidates. Clients use fetch +
 * router.refresh() (never server actions — recorded convention).
 *
 * The aggregate-view refusal maps to 403 (the write is understood but this
 * view may never make it); every other refusal is a 400.
 */

const fy = z.string().regex(/^\d{4}-\d{2}$/, "The FY must look like 2022-23");

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    incurredFy: fy,
    head: z.enum(LOSS_HEADS),
    amount: z.number().positive(),
    originalAmount: z.number().positive().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.number().int().positive(),
  }),
]);

// Every surface that renders the seeded timeline or the lots themselves
// (only the tax and ITR pages call computeTaxTimeline).
const PATHS = ["/reports/tax", "/reports/itr"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const p = schema.safeParse(body);
  if (!p.success) return NextResponse.json({ ok: false, message: p.error.issues[0]?.message }, { status: 400 });

  const res =
    p.data.action === "delete"
      ? deleteBfLoss(p.data.id)
      : upsertBfLoss({
          incurredFy: p.data.incurredFy,
          head: p.data.head,
          amount: p.data.amount,
          originalAmount: p.data.originalAmount ?? null,
          note: p.data.note ?? null,
        });

  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });
  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json(res);
}
