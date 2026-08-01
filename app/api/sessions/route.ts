import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tradingSessions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { getSelectedAccountId } from "@/lib/queries/accounts";

export const runtime = "nodejs";
const input = z.object({ id: z.number().int().positive().optional(), accountId: z.number().int().positive().default(1), sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), market: z.string().min(1).default("NSE"), plannedSymbols: z.array(z.string()).default([]), plannedPlaybookIds: z.array(z.number().int().positive()).default([]), maxTrades: z.number().int().positive().nullable().optional(), maxLoss: z.number().positive().nullable().optional(), cutoffTime: z.string().nullable().optional(), thesis: z.string().nullable().optional(), status: z.enum(["planned", "reviewed"]).default("planned"), reviewNotes: z.string().nullable().optional() });

export async function POST(req: Request) {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid session plan." }, { status: 400 });
  const v = { ...parsed.data, accountId: parsed.data.accountId === 1 ? (getSelectedAccountId() || 1) : parsed.data.accountId };
  const values = { ...v, plannedSymbols: [...new Set(v.plannedSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))], updatedAt: new Date().toISOString() };
  const existing = v.id ? db.select().from(tradingSessions).where(eq(tradingSessions.id, v.id)).get() : null;
  if (existing) db.update(tradingSessions).set(values).where(eq(tradingSessions.id, existing.id)).run();
  else db.insert(tradingSessions).values(values).onConflictDoUpdate({ target: [tradingSessions.accountId, tradingSessions.sessionDate], set: values }).run();
  recordAudit({ entity: "session", entityId: v.id, action: existing ? "update" : "create", summary: `${v.sessionDate} session ${v.status}`, after: values, source: "ui" });
  revalidatePath("/sessions");
  return NextResponse.json({ ok: true });
}
