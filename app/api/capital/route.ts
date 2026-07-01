import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { settings, capitalSnapshots } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { getCapitalSummary } from "@/lib/queries/capital";

export const runtime = "nodejs";

/**
 * Compound realised P&L (closed trades + exited IPOs) into the bucket capital.
 * Adds only the amount not yet rolled in (tracked via settings.pnlRolledIn) so
 * repeated use never double-counts. All %-based views read the bucket capital, so
 * they auto-adjust on the next render.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const bucket = body?.bucket === "active" ? "active" : "equity";

  const s = db.select().from(settings).limit(1).all()[0];
  if (!s) return NextResponse.json({ ok: false, message: "Settings not found" }, { status: 400 });

  const summary = getCapitalSummary();
  const add = summary.available;
  if (Math.abs(add) < 0.005) {
    return NextResponse.json({ ok: false, message: "No new realised P&L to compound." }, { status: 200 });
  }

  const newEquity = bucket === "equity" ? Math.round((s.equityCapital + add) * 100) / 100 : s.equityCapital;
  const newActive = bucket === "active" ? Math.round((s.activeCapital + add) * 100) / 100 : s.activeCapital;

  db.update(settings)
    .set({
      equityCapital: newEquity,
      activeCapital: newActive,
      pnlRolledIn: summary.totalRealised, // mark everything realised-to-date as rolled in
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(settings.id, s.id))
    .run();

  // record a capital snapshot for history
  const today = new Date().toISOString().slice(0, 10);
  db.insert(capitalSnapshots)
    .values({
      bucket,
      asOfDate: today,
      openingCapital: bucket === "equity" ? newEquity : newActive,
      deployed: 0,
      available: bucket === "equity" ? newEquity : newActive,
      realisedPnlToDate: summary.totalRealised,
    })
    .run();

  for (const p of ["/", "/settings", "/equity", "/active", "/targets/equity", "/targets/active", "/risk", "/ipos"]) {
    revalidatePath(p);
  }
  return NextResponse.json({
    ok: true,
    message: `Compounded ${add >= 0 ? "+" : ""}₹${Math.round(add).toLocaleString("en-IN")} into ${bucket} capital.`,
    added: add,
    bucket,
  });
}
