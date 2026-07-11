import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { marginConfig } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/** Update one segment's margin % (the /risk margin gauge's editable rate table). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  const segment = String(body.segment ?? "").trim();
  const pct = Number(body.marginPct);
  if (!segment || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    return NextResponse.json({ ok: false, message: "Segment and a margin % between 0 and 100 are required." }, { status: 400 });
  }

  const before = db.select().from(marginConfig).where(eq(marginConfig.segment, segment)).all()[0] ?? null;
  db.insert(marginConfig)
    .values({ segment, marginPct: pct })
    .onConflictDoUpdate({ target: marginConfig.segment, set: { marginPct: pct, updatedAt: new Date().toISOString() } })
    .run();
  recordAudit({
    entity: "risk_config",
    entityId: before?.id ?? null,
    action: before ? "update" : "create",
    summary: `Margin rate ${segment} → ${pct}%`,
    before: before ? { segment: before.segment, marginPct: before.marginPct } : null,
    after: { segment, marginPct: pct },
  });
  revalidatePath("/risk");
  return NextResponse.json({ ok: true, message: `${segment} margin set to ${pct}%.` });
}
