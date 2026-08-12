import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { playbooks, trades, tradingSessions } from "@/lib/db/schema";
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

    // The references go WITH the playbook, in the same transaction — the
    // pattern lib/queries/delete.ts set for IPO and ledger links. This
    // response used to say "its trades fall back to Untagged" while doing
    // nothing of the sort: the Lenses page labelled them "Playbook #N — no
    // longer on record" and the journal dialog rendered a select whose value
    // matched no option (defect D6, 2026-08-12). Now the message is true.
    let untagged = 0, plansPruned = 0;
    db.transaction((tx) => {
      untagged = tx.update(trades).set({ playbookId: null }).where(eq(trades.playbookId, id)).run().changes;
      const plans = tx.select({ id: tradingSessions.id, ids: tradingSessions.plannedPlaybookIds }).from(tradingSessions).all();
      for (const p of plans) {
        if (!p.ids.includes(id)) continue;
        tx.update(tradingSessions).set({ plannedPlaybookIds: p.ids.filter((x) => x !== id) }).where(eq(tradingSessions.id, p.id)).run();
        plansPruned++;
      }
      tx.delete(playbooks).where(eq(playbooks.id, id)).run();
    });

    recordAudit({
      entity: "settings", entityId: id, action: "delete",
      summary: `Playbook "${cur?.name ?? id}" deleted — ${untagged} trade(s) untagged, ${plansPruned} session plan(s) pruned`,
    });
    revalidate();
    return NextResponse.json({
      ok: true,
      message:
        untagged > 0 || plansPruned > 0
          ? `Playbook deleted — ${untagged} trade${untagged === 1 ? "" : "s"} back to Untagged${plansPruned ? `, removed from ${plansPruned} session plan${plansPruned === 1 ? "" : "s"}` : ""}.`
          : "Playbook deleted — nothing referenced it.",
    });
  }

  return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
}
