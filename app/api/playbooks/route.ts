import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { playbooks } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

function revalidate() {
  for (const p of ["/playbooks", "/trades", "/reports/discipline"]) revalidatePath(p);
}

/** Parse one-rule-per-line text into a clean rules array. */
function parseRules(v: unknown): string[] {
  return String(v ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  if (body.action === "add" || body.action === "update") {
    const name = String(body.name ?? "").trim();
    if (!name) return NextResponse.json({ ok: false, message: "Playbook name is required." }, { status: 400 });
    const values = {
      name,
      description: String(body.description ?? "").trim() || null,
      rules: parseRules(body.rules),
    };
    const id = Number(body.id);
    try {
      if (body.action === "update" && Number.isFinite(id) && id > 0) {
        db.update(playbooks).set({ ...values, updatedAt: sql`(datetime('now'))` }).where(eq(playbooks.id, id)).run();
        recordAudit({ entity: "settings", entityId: id, action: "update", summary: `Playbook "${name}" updated` });
        revalidate();
        return NextResponse.json({ ok: true, message: `"${name}" updated.` });
      }
      const ins = db.insert(playbooks).values(values).returning({ id: playbooks.id }).get();
      recordAudit({ entity: "settings", entityId: ins?.id ?? null, action: "create", summary: `Playbook "${name}" created` });
      revalidate();
      return NextResponse.json({ ok: true, message: `"${name}" created.` });
    } catch (e) {
      const msg = e instanceof Error && /unique/i.test(e.message) ? "A playbook with that name already exists." : "Save failed.";
      return NextResponse.json({ ok: false, message: msg }, { status: 400 });
    }
  }

  if (body.action === "archive") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    const cur = db.select().from(playbooks).where(eq(playbooks.id, id)).get();
    if (!cur) return NextResponse.json({ ok: false, message: "Not found" }, { status: 404 });
    db.update(playbooks).set({ archived: !cur.archived, updatedAt: sql`(datetime('now'))` }).where(eq(playbooks.id, id)).run();
    revalidate();
    return NextResponse.json({ ok: true, message: cur.archived ? "Playbook restored." : "Playbook archived (existing trade tags kept)." });
  }

  if (body.action === "delete") {
    const id = Number(body.id);
    if (!Number.isFinite(id)) return NextResponse.json({ ok: false, message: "Bad id" }, { status: 400 });
    const cur = db.select().from(playbooks).where(eq(playbooks.id, id)).get();
    db.delete(playbooks).where(eq(playbooks.id, id)).run();
    recordAudit({ entity: "settings", entityId: id, action: "delete", summary: `Playbook "${cur?.name ?? id}" deleted` });
    revalidate();
    return NextResponse.json({ ok: true, message: "Playbook deleted — its trades fall back to Untagged." });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
