import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { marginConfig } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/** Update one broker+segment's margin % (the /risk margin gauge's editable rate table). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });
  }

  const broker = String(body.broker ?? "").trim();
  const segment = String(body.segment ?? "").trim();
  const pct = Number(body.marginPct);
  if (!broker || !segment || !Number.isFinite(pct) || pct < 0 || pct > 100) {
    return NextResponse.json({ ok: false, message: "Broker, segment and a margin % between 0 and 100 are required." }, { status: 400 });
  }

  const before = db.select().from(marginConfig).where(and(eq(marginConfig.broker, broker), eq(marginConfig.segment, segment))).all()[0] ?? null;
  db.insert(marginConfig)
    .values({ broker, segment, marginPct: pct })
    .onConflictDoUpdate({
      target: [marginConfig.broker, marginConfig.segment],
      set: { marginPct: pct, updatedAt: new Date().toISOString() },
    })
    .run();
  recordAudit({
    entity: "risk_config",
    entityId: before?.id ?? null,
    action: before ? "update" : "create",
    summary: `Margin rate ${broker}/${segment} → ${pct}%`,
    before: before ? { broker: before.broker, segment: before.segment, marginPct: before.marginPct } : null,
    after: { broker, segment, marginPct: pct },
  });
  revalidatePath("/risk");
  return NextResponse.json({ ok: true, message: `${broker} · ${segment} margin set to ${pct}%.` });
}
