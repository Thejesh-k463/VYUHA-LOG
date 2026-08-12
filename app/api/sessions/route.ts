import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tradingSessions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { getWriteAccountId } from "@/lib/queries/accounts";

export const runtime = "nodejs";
const input = z.object({ id: z.number().int().positive().optional(), accountId: z.number().int().positive().optional(), sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), market: z.string().min(1).default("NSE"), plannedSymbols: z.array(z.string()).default([]), plannedPlaybookIds: z.array(z.number().int().positive()).default([]), maxTrades: z.number().int().positive().nullable().optional(), maxLoss: z.number().positive().nullable().optional(), cutoffTime: z.string().nullable().optional(), thesis: z.string().nullable().optional(), status: z.enum(["planned", "reviewed"]).default("planned"), reviewNotes: z.string().nullable().optional() });

export async function POST(req: Request) {
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message ?? "Invalid session plan." }, { status: 400 });
  // The write account is RESOLVED, never trusted: an explicit id is validated
  // against the accounts table and anything else falls back to the selected
  // account (invariant 9). The old shape took the client's number verbatim,
  // so a stale tab could write — and via the update below, MOVE — a session
  // into an account that was never on screen (defect D7, 2026-08-12).
  const accountId = getWriteAccountId(parsed.data.accountId ?? null);
  const v = { ...parsed.data, accountId };
  const values = { ...v, plannedSymbols: [...new Set(v.plannedSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))], updatedAt: new Date().toISOString() };
  // Scoped to (id, account): an id from another account is treated as "no
  // such session" rather than overwritten across the boundary.
  const existing = v.id
    ? db.select().from(tradingSessions).where(and(eq(tradingSessions.id, v.id), eq(tradingSessions.accountId, accountId))).get()
    : null;
  if (existing) db.update(tradingSessions).set(values).where(eq(tradingSessions.id, existing.id)).run();
  else db.insert(tradingSessions).values(values).onConflictDoUpdate({ target: [tradingSessions.accountId, tradingSessions.sessionDate], set: values }).run();
  recordAudit({ entity: "session", entityId: v.id, action: existing ? "update" : "create", summary: `${v.sessionDate} session ${v.status}`, after: values, source: "ui" });
  revalidatePath("/sessions");
  return NextResponse.json({ ok: true });
}
