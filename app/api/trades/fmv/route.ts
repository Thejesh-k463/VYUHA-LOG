import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/** Set/clear a trade's 31-Jan-2018 per-share FMV (LTCG grandfathering input). */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, message: "Bad trade id" }, { status: 400 });

  const raw = String(body.fmv ?? "").trim();
  const fmv = raw === "" ? null : Number(raw);
  if (fmv != null && (!Number.isFinite(fmv) || fmv <= 0)) {
    return NextResponse.json({ ok: false, message: "FMV must be a positive per-share price (or blank to clear)." }, { status: 400 });
  }

  const prev = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!prev) return NextResponse.json({ ok: false, message: "Trade not found" }, { status: 404 });

  db.update(trades).set({ fmv31Jan2018: fmv, updatedAt: sql`(datetime('now'))` }).where(eq(trades.id, id)).run();
  recordAudit({
    entity: "trade",
    entityId: id,
    action: "update",
    summary: `${prev.symbol} FMV@31-Jan-2018 ${fmv == null ? "cleared" : `set to ₹${fmv}`} (grandfathering)`,
    before: { fmv31Jan2018: prev.fmv31Jan2018 },
    after: { fmv31Jan2018: fmv },
  });
  revalidatePath("/reports/tax");
  return NextResponse.json({ ok: true, message: fmv == null ? "FMV cleared." : `FMV ₹${fmv}/share saved.` });
}
