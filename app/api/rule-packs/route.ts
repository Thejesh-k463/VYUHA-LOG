import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { regulatoryRulePacks } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const body = await req.json().catch(() => null); const id = Number(body?.id);
  if (!Number.isInteger(id) || id < 1) return NextResponse.json({ ok: false, message: "Invalid pack." }, { status: 400 });
  const reviewedAt = new Date().toISOString();
  db.update(regulatoryRulePacks).set({ reviewedAt }).where(eq(regulatoryRulePacks.id, id)).run();
  recordAudit({ entity: "rule_pack", entityId: id, action: "update", summary: "source reviewed", source: "ui" });
  revalidatePath("/rule-packs"); return NextResponse.json({ ok: true, reviewedAt });
}
