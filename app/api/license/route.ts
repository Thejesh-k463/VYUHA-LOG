import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { verifyLicenseKey, SKU_LABELS, ENTITLEMENT_PATHS, LICENSE_PUBLIC_KEY_PEM, REVOKED_KEY_IDS } from "@/lib/license";
import { getMachineId } from "@/lib/machine-id.server";
import { encryptSecret } from "@/lib/vault";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

// Every entitlement-dependent route, derived in lib/license.ts — the
// hand-written list this replaced covered 4 of 17 Pro screens.
function revalidate() {
  for (const p of ENTITLEMENT_PATHS) revalidatePath(p);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  if (body.action === "activate") {
    const key = String(body.key ?? "").trim();
    // Same question the read path asks (lib/queries/license.ts): a key bound
    // to another machine used to ACTIVATE cleanly here and only read back
    // unlicensed later, so the buyer saw "Activated" and an unlicensed app
    // with no explanation. Verified with this computer's id, the refusal
    // carries lib/license.ts's own mismatch sentence — the one the read
    // path already shows — through the route's existing {ok,message}/400.
    const check = verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM, REVOKED_KEY_IDS, getMachineId());
    if (!check.valid) return NextResponse.json({ ok: false, message: check.reason ?? "Invalid key." }, { status: 400 });
    // Stored encrypted at rest (v2.99.80). encryptSecret THROWS on a broken
    // vault — surfaced as an error rather than silently storing plaintext,
    // because a new secret written beside a broken vault would downgrade the
    // guarantee without anyone choosing to.
    let stored: string;
    try {
      stored = encryptSecret(key);
    } catch (e) {
      return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "The secrets vault is unavailable." }, { status: 500 });
    }
    db.update(settings).set({ licenseKey: stored, updatedAt: sql`(datetime('now'))` }).run();
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
