import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { verifyLicenseKey, SKU_LABELS } from "@/lib/license";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

function revalidate() {
  for (const p of ["/settings", "/reports/tax", "/risk", "/reports/broker-compare"]) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  if (body.action === "activate") {
    const key = String(body.key ?? "").trim();
    const check = verifyLicenseKey(key);
    if (!check.valid) return NextResponse.json({ ok: false, message: check.reason ?? "Invalid key." }, { status: 400 });
    db.update(settings).set({ licenseKey: key, updatedAt: sql`(datetime('now'))` }).run();
    recordAudit({
      entity: "settings",
      entityId: null,
      action: "update",
      summary: `License activated — ${check.payload!.email} (${check.payload!.sku})`,
    });
    revalidate();
    return NextResponse.json({
      ok: true,
      message: `Activated: ${SKU_LABELS[check.payload!.sku] ?? check.payload!.sku} — licensed to ${check.payload!.email}.`,
    });
  }

  if (body.action === "deactivate") {
    db.update(settings).set({ licenseKey: null, updatedAt: sql`(datetime('now'))` }).run();
    recordAudit({ entity: "settings", entityId: null, action: "update", summary: "License removed" });
    revalidate();
    return NextResponse.json({ ok: true, message: "License removed from this machine." });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
