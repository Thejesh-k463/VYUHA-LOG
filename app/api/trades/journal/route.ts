import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { MISTAKE_TAGS, EMOTION_TAGS } from "@/lib/analytics/behavior";

export const runtime = "nodejs";

const MISTAKES = new Set<string>(MISTAKE_TAGS);
const EMOTIONS = new Set<string>(EMOTION_TAGS);

/** Set a trade's behavioral-journal fields: playbook, emotion, mistakes, notes. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: "Bad request" }, { status: 400 });

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ ok: false, message: "Bad trade id" }, { status: 400 });
  const prev = db.select().from(trades).where(eq(trades.id, id)).get();
  if (!prev) return NextResponse.json({ ok: false, message: "Trade not found" }, { status: 404 });

  const playbookId = body.playbookId == null || body.playbookId === "" ? null : Number(body.playbookId);
  if (playbookId != null && (!Number.isFinite(playbookId) || playbookId <= 0)) {
    return NextResponse.json({ ok: false, message: "Bad playbook id" }, { status: 400 });
  }
  const emotionTag = typeof body.emotionTag === "string" && EMOTIONS.has(body.emotionTag) ? body.emotionTag : null;
  const mistakeTags = Array.isArray(body.mistakeTags)
    ? [...new Set(body.mistakeTags.map(String).filter((t) => MISTAKES.has(t)))]
    : [];
  const notes = String(body.notes ?? "").trim() || null;

  db.update(trades)
    .set({ playbookId, emotionTag, mistakeTags: mistakeTags.length ? mistakeTags : null, notes, updatedAt: sql`(datetime('now'))` })
    .where(eq(trades.id, id))
    .run();
  recordAudit({
    entity: "trade",
    entityId: id,
    action: "update",
    summary: `${prev.symbol} journal updated (playbook ${playbookId ?? "—"} · ${emotionTag ?? "no emotion"} · ${mistakeTags.length} mistake${mistakeTags.length === 1 ? "" : "s"})`,
    before: { playbookId: prev.playbookId, emotionTag: prev.emotionTag, mistakeTags: prev.mistakeTags, notes: prev.notes },
    after: { playbookId, emotionTag, mistakeTags, notes },
  });
  for (const p of ["/trades", "/reports/discipline"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: "Journal saved." });
}
