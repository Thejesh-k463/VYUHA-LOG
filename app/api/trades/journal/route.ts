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
  // U3 — WHY the trade was closed (migration 0051). The curated EXIT_TRIGGERS
  // list is a UI convenience, not a validation set: the schema says free text,
  // so any non-blank string is stored verbatim (trimmed). Blank means
  // UNANSWERED and stays null — "" is never written as a value.
  const exitTrigger = typeof body.exitTrigger === "string" ? body.exitTrigger.trim() || null : null;

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

  // The two JSON columns store NULL for "none", never an empty array — an
  // empty list is not a fact about the trade, it is the absence of one. These
  // are the values that reach the DB, so both the UPDATE and the audit
  // snapshot below read from here: writing `[]` into the audit while writing
  // `null` into the row made every no-mistake save render a phantom
  // `mistakeTags: null → []` (and the same for `ruleViolations`) in a log the
  // product calls an append-only record of every mutation. One binding each,
  // used twice, is what keeps the two from drifting apart again.
  const storedMistakeTags = mistakeTags.length ? mistakeTags : null;
  const storedRuleViolations = ruleViolations.length ? ruleViolations : null;

  // v3.7 — saving a review IS reviewing it, so the journal save stamps
  // `reviewed_at` and the trade leaves the desk's queue without a second
  // click. Two conditions, both load-bearing:
  //
  //  * CLOSED ONLY. The notebook icon renders on EVERY row of /trades, so a
  //    user can journal a thesis on a position they still hold — and that is
  //    not a review. A review is of a finished trade (migration 0055's header
  //    states the same rule for its backfill). Stamping an open row would
  //    remove that trade from the queue permanently, because nothing clears
  //    the stamp when it closes: `lib/import/commit.ts` and the close dialog
  //    set `isOpen:false` and never touch `reviewedAt`, and "Reopen" is the
  //    only writer that nulls it. It would then close already "reviewed" and
  //    count in the Process Score's `reviewed` component without ever having
  //    been looked at as a closed trade. So an open trade is journalled and
  //    left UNSTAMPED; it enters the queue on the day it closes, still owing
  //    its review, and the first save after that close is what stamps it.
  //  * `?? now`, never an unconditional restamp: the date the desk shows is
  //    when the trade was FIRST reviewed, and re-opening the dialog to fix a
  //    typo must not move it. "Reopen" (app/api/review/route.ts) is the only
  //    way back into the queue.
  //
  // Note this never CLEARS a stamp either — an already-stamped row keeps its
  // value whatever its open state, because clearing is "Reopen"'s job alone.
  //
  // This route stays FREE, and the stamp does not change that: recording a
  // trade's own review is record-keeping (invariant 7). Only the DESK — queue,
  // ritual, Process Score — is gated.
  const stampsReview = !prev.isOpen && prev.reviewedAt == null;
  const reviewedAt = stampsReview ? sql`(datetime('now'))` : prev.reviewedAt;

  db.update(trades)
    .set({
      playbookId,
      emotionTag,
      mistakeTags: storedMistakeTags,
      notes,
      exitTrigger,
      ruleViolations: storedRuleViolations,
      reviewedAt,
      updatedAt: sql`(datetime('now'))`,
    })
    .where(eq(trades.id, id))
    .run();
  // The audit viewer diffs the UNION of the two snapshots' keys
  // (lib/analytics/audit-diff.ts) and this call site passes no `fields`
  // allow-list, so a key present on only ONE side reads as a change to null.
  // `reviewedAt` must therefore appear on BOTH, carrying the value actually
  // stored: re-saving an already-reviewed trade then produces no `reviewedAt`
  // row (nothing changed, and this route cannot clear a stamp), and the save
  // that lands the stamp shows null → the stored time. Read back rather than
  // recomputed, because the value is `datetime('now')` evaluated by SQLite —
  // a JS clock would put a second-off number in the log for the row it claims
  // to describe.
  const storedReviewedAt = stampsReview
    ? db.select({ reviewedAt: trades.reviewedAt }).from(trades).where(eq(trades.id, id)).get()?.reviewedAt ?? null
    : prev.reviewedAt;
  recordAudit({
    entity: "trade",
    entityId: id,
    action: "update",
    summary: `${prev.symbol} journal updated (playbook ${playbookId ?? "—"} · ${emotionTag ?? "no emotion"} · ${mistakeTags.length} mistake${mistakeTags.length === 1 ? "" : "s"} · ${brokenRules.length} rule${brokenRules.length === 1 ? "" : "s"} broken)`,
    before: { playbookId: prev.playbookId, emotionTag: prev.emotionTag, mistakeTags: prev.mistakeTags, notes: prev.notes, exitTrigger: prev.exitTrigger, ruleViolations: prev.ruleViolations, reviewedAt: prev.reviewedAt },
    after: { playbookId, emotionTag, mistakeTags: storedMistakeTags, notes, exitTrigger, ruleViolations: storedRuleViolations, reviewedAt: storedReviewedAt },
  });
  // /review joins the list: a save takes the trade out of the desk's queue.
  for (const p of ["/trades", "/reports/discipline", "/review"]) revalidatePath(p);
  return NextResponse.json({ ok: true, message: "Journal saved." });
}
