import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteChallan, upsertChallan } from "@/lib/queries/challans";

export const runtime = "nodejs";

/**
 * Advance-tax challan ledger writes (v3.7, WS4). The decisions and the writes
 * live in lib/queries/challans.ts so the temp-DB tests exercise the real path;
 * this route only parses, calls, and revalidates. Clients use fetch +
 * router.refresh() (never server actions — recorded convention).
 *
 * Zod checks SHAPE only. The dated rules that need the journal — the FY's own
 * calendar window (s.408(3)), "not in the future", the account boundary — are
 * the query module's, because they need settings and the selected account. A
 * shape failure and a rule failure both 400; only the aggregate-view refusal
 * is 403 (the write is understood, but that view may never make it).
 */

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("upsert"),
    /** Present = editing that row; absent = a NEW payment (duplicates are legal). */
    id: z.number().int().positive().nullable().optional(),
    fy: z.string().regex(/^\d{4}-\d{2}$/, "The FY must look like 2026-27"),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The payment date must look like 2026-06-15"),
    amount: z.number().positive(),
    bsrCode: z.string().max(32).nullable().optional(),
    challanSerial: z.string().max(32).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    id: z.number().int().positive(),
  }),
]);

// The two surfaces that read the ledger: the calculator (paid-as-of per
// instalment) and the ITR pack's taxes-paid table.
const PATHS = ["/reports/advance-tax", "/reports/itr"];

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const p = schema.safeParse(body);
  if (!p.success) return NextResponse.json({ ok: false, message: p.error.issues[0]?.message }, { status: 400 });

  const res =
    p.data.action === "delete"
      ? deleteChallan(p.data.id)
      : upsertChallan({
          id: p.data.id ?? null,
          fy: p.data.fy,
          paidOn: p.data.paidOn,
          amount: p.data.amount,
          bsrCode: p.data.bsrCode ?? null,
          challanSerial: p.data.challanSerial ?? null,
          note: p.data.note ?? null,
        });

  if (!res.ok) return NextResponse.json(res, { status: res.forbidden ? 403 : 400 });
  for (const path of PATHS) revalidatePath(path);
  return NextResponse.json(res);
}
