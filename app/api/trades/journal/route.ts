import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { trades, playbooks } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { MISTAKE_TAGS, EMOTION_TAGS, PLAYBOOK_RULE_PREFIX } from "@/lib/analytics/behavior";

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

  // T1.2 — rule checklist. Broken rules are validated against the selected
  // playbook's actual rules (no free-text injection into rule_violations), then
  // MERGED with the entry-time limit breaches already in the column: those come
  // from the pre-trade limits engine and are not the journal's to erase.
  let brokenRules: string[] = [];
  if (playbookId != null && Array.isArray(body.brokenRules)) {
    const pb = db.select().from(playbooks).where(eq(playbooks.id, playbookId)).get();
    const valid = new Set(pb?.rules ?? []);
    brokenRules = [...new Set(body.brokenRules.map(String).filter((r) => valid.has(r)))];
  }
  const keptLimitBreaches = (prev.ruleViolations ?? []).filter((v) => !v.startsWith(PLAYBOOK_RULE_PREFIX));
  const ruleViolations = [...keptLimitBreaches, ...brokenRules.map((r) => `${PLAYBOOK_RULE_PREFIX}${r}`)];

  db.update(trades)
    .set({
      playbookId,
      emotionTag,
      mistakeTags: mistakeTags.length ? mistakeTags : null,
      notes,
      ruleViolations: ruleViolations.length ? ruleViolations : null,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(trades.id, id))
    .run();
  recordAudit({
    entity: "trade",
    entityId: id,
    action: "update",
    summary: `${prev.symbol} journal updated (playbook ${playbookId ?? "—"} · ${emotionTag ?? "no emotion"} · ${mistakeTags.length} mistake${mistakeTags.length === 1 ? "" : "s"} · ${brokenRules.length} rule${brokenRules.length === 1 ? "" : "s"} broken)`,
    before: { playbookId: prev.playbookId, emotionTag: prev.emotionTag, mistakeTags: prev.mistakeTags, notes: prev.notes, ruleViolations: prev.ruleViolations },
    after: { playbookId, emotionTag, mistakeTags, notes, ruleViolations },
  });
  for (const p of ["/trades", "/reports/discipline"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: "Journal saved." });
}
