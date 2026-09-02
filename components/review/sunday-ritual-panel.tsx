"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { inr, num } from "@/lib/format";
import { carriedOverDraft, noteDraftText, noteOwner, type NoteDraft } from "./note-draft";

/**
 * PANEL 3 — the weekly ritual for the ISO week that most recently ENDED.
 *
 * Everything on it is the record read back: what closed, what it netted, what
 * it cost, how the five process components landed, which tags carry the widest
 * expectancy GAP, the best and worst trade by R, and why positions were
 * actually closed. Nothing here is a counterfactual — no "this is what the week
 * would have made" line exists, because the journal cannot know that and
 * inventing it is the one thing the mistake economics were built not to do.
 *
 * Completing the week stores TWO things: the moment, and the score that was on
 * screen at that moment. The live score is recomputed on every render and shown
 * beside it under its own label — a later import can move the recomputed
 * number, and the pair the user actually saw is history that stays put.
 */

export interface RitualTagGap {
  tag: string;
  label: string;
  trades: number;
  avgNet: number;
  /** Untagged expectancy minus this tag's expectancy, ₹ per trade. */
  gap: number;
}

export interface RitualTrigger {
  key: string;
  count: number;
  net: number;
  /** 0..1 */
  winRate: number;
  expectancy: number;
}

export interface RitualExtreme {
  symbol: string;
  rMultiple: number;
  netPnl: number;
  sellDate: string | null;
}

export interface RitualHistoryRow {
  /** The row's own id — the All-accounts view can hold one week per account. */
  id: number;
  weekStart: string;
  label: string;
  completedAt: string;
  /** The score SHOWN when the ritual was completed. Null when it refused. */
  scoreThen: number | null;
  /** The same week's score recomputed now. Null when it refuses now. */
  scoreNow: number | null;
  noteExcerpt: string;
}

export interface RitualAdherence {
  sessionDate: string;
  market: string;
  adherencePct: number;
}

const dash = "—";
const tone = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

function Stat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <span className="text-xs text-muted-foreground">{label}</span>
      <p className={`text-base font-medium tabular-nums ${className ?? ""}`}>{value}</p>
    </div>
  );
}

export function SundayRitualPanel({
  weekLabel,
  weekStart,
  weekEnd,
  closed,
  net,
  charges,
  score,
  refusal,
  gaps,
  cleanExpectancy,
  cleanTrades,
  best,
  worst,
  ratedTrades,
  triggers,
  triggersAnswered,
  triggersExcluded,
  adherence,
  note,
  completedAt,
  scoreAtCompletion,
  history,
  aggregateView,
  accountId,
  accountLabel,
}: {
  weekLabel: string;
  weekStart: string;
  weekEnd: string;
  closed: number;
  net: number;
  charges: number;
  score: number | null;
  refusal: string | null;
  gaps: RitualTagGap[];
  cleanExpectancy: number;
  cleanTrades: number;
  best: RitualExtreme | null;
  worst: RitualExtreme | null;
  /** Closed trades in the week that carry an R at all — best/worst's real base. */
  ratedTrades: number;
  triggers: RitualTrigger[];
  triggersAnswered: number;
  /** Closed trades with no exit reason recorded — excluded, never bucketed. */
  triggersExcluded: number;
  adherence: RitualAdherence[];
  note: string;
  completedAt: string | null;
  scoreAtCompletion: number | null;
  history: RitualHistoryRow[];
  aggregateView: boolean;
  /** The selected account (0 = the All-accounts view) — half of a note's owner. */
  accountId: number;
  /** How that account reads on screen, for the carried-draft notice. */
  accountLabel: string;
}) {
  const router = useRouter();
  // The draft carries the account and week it was typed against, and what the
  // textarea shows is DERIVED from that at render time (components/review/
  // note-draft.ts). An account switch is a soft `router.refresh()`, so this
  // instance survives it — seeding the textarea once was how one book's prose
  // ended up filed against another.
  const [draft, setDraft] = React.useState<NoteDraft | null>(null);
  const [pending, setPending] = React.useState(false);

  const owner = noteOwner(accountId, weekStart);
  const ownerLabel = `${accountLabel} · ${weekLabel}`;
  const text = noteDraftText(draft, owner, note);
  const carried = carriedOverDraft(draft, owner);

  async function send(action: "weekly-upsert" | "weekly-complete") {
    setPending(true);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          weekStart,
          note: text,
          ...(action === "weekly-complete" ? { scoreAtCompletion: score } : {}),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok) {
        // Keep the words on screen through the refresh, but stop calling them
        // unsaved: they are on file for THIS owner now.
        setDraft({ owner, ownerLabel, text, unsaved: false });
        toast.success(data.message ?? "Saved.");
        router.refresh();
      } else {
        toast.error(data.message ?? "That did not go through.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Sunday ritual — {weekLabel}</CardTitle>
          <p className="text-xs text-muted-foreground">
            The week of {weekStart} to {weekEnd}, read back from the record.
          </p>
        </div>
        {completedAt && (
          <Badge variant="secondary" data-testid="ritual-completed">
            Reviewed {completedAt.slice(0, 10)}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Trades closed" value={closed} />
          <Stat label="Net" value={inr(net)} className={tone(net)} />
          <Stat label="Charges" value={inr(charges)} />
          <Stat
            label="Process Score"
            value={score == null ? dash : score}
            className={score == null ? "text-muted-foreground" : ""}
          />
        </div>
        {refusal && <p className="text-xs text-muted-foreground">{refusal}.</p>}

        {/* Expectancy GAP, never a counterfactual: the difference between what
            tagged and untagged trades averaged, stated with both counts. */}
        <div className="space-y-1">
          <span className="text-xs font-medium">Widest expectancy gaps</span>
          {gaps.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {cleanTrades === 0
                ? "Every closed trade in this week carries a mistake tag, so there is no untagged expectancy to measure a gap against."
                : "No closed trade in this week carries a mistake tag, so there is no gap to state."}
            </p>
          ) : (
            <>
              <div className="rounded-md border border-border">
                {gaps.map((g) => (
                  <div key={g.tag} className="flex flex-wrap items-baseline gap-x-3 border-t border-rule px-2.5 py-1.5 text-xs first:border-t-0">
                    <span className="w-40 shrink-0 font-medium">{g.label}</span>
                    <span className="text-muted-foreground">n={g.trades}</span>
                    <span className={`tabular-nums ${tone(g.avgNet)}`}>{inr(g.avgNet)} per trade</span>
                    <span className="tabular-nums text-muted-foreground">gap {inr(g.gap)}</span>
                  </div>
                ))}
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                The gap is measured against the {cleanTrades} untagged closed trade
                {cleanTrades === 1 ? "" : "s"} in the same week, which averaged {inr(cleanExpectancy)}. A
                trade can carry several tags, so these rows overlap and do not partition the week.
              </p>
            </>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <span className="text-xs font-medium">Best and worst by R</span>
            {best && worst ? (
              <div className="space-y-0.5 text-xs">
                <p>
                  <span className="text-muted-foreground">Best </span>
                  {best.symbol} · {num(best.rMultiple, 2)}R ·{" "}
                  <span className={tone(best.netPnl)}>{inr(best.netPnl)}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Worst </span>
                  {worst.symbol} · {num(worst.rMultiple, 2)}R ·{" "}
                  <span className={tone(worst.netPnl)}>{inr(worst.netPnl)}</span>
                </p>
                <p className="text-[0.6875rem] text-muted-foreground">
                  Ranked over the {ratedTrades} closed trade{ratedTrades === 1 ? "" : "s"} that carry an R;
                  the rest have no risk recorded and are outside this ranking.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                No closed trade in this week carries an R, so there is nothing to rank.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <span className="text-xs font-medium">Why positions were closed</span>
            {triggers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No closed trade in this week records an exit reason.
              </p>
            ) : (
              <div className="space-y-0.5 text-xs">
                {triggers.map((t) => (
                  <p key={t.key}>
                    <span className="w-32 inline-block">{t.key}</span>
                    <span className="text-muted-foreground">{t.count}× · </span>
                    <span className={tone(t.net)}>{inr(t.net)}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · win {Math.round(t.winRate * 100)}% · exp {inr(t.expectancy)}
                    </span>
                  </p>
                ))}
              </div>
            )}
            <p className="text-[0.6875rem] text-muted-foreground" data-testid="trigger-coverage">
              {triggersAnswered} of {triggersAnswered + triggersExcluded} closed trade
              {triggersAnswered + triggersExcluded === 1 ? "" : "s"} recorded an exit reason;{" "}
              {triggersExcluded} left it blank and {triggersExcluded === 1 ? "is" : "are"} excluded from
              this mix rather than bucketed as other.
            </p>
          </div>
        </div>

        {adherence.length > 0 && (
          <div className="space-y-1">
            <span className="text-xs font-medium">Session plan adherence</span>
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {adherence.map((a) => (
                <p key={`${a.sessionDate}-${a.market}`}>
                  {a.sessionDate} · {a.market} · {a.adherencePct}% of the plan matched the journal
                </p>
              ))}
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              Session plan adherence is plan-versus-day and is a different measure from the Process Score
              above.
            </p>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="weekly-note">This week in your own words</Label>
          {carried && (
            <div
              className="rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 text-xs"
              data-testid="ritual-carried-note"
            >
              <p className="font-medium text-warning">
                Words you typed for {carried.ownerLabel} were never saved, and they are not part of this
                note.
              </p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{carried.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                  Discard them
                </Button>
                <span className="text-muted-foreground">
                  Switching back to {carried.ownerLabel} brings them back; typing below replaces them.
                </span>
              </div>
            </div>
          )}
          <Textarea
            id="weekly-note"
            rows={4}
            value={text}
            onChange={(e) => setDraft({ owner, ownerLabel, text: e.target.value, unsaved: true })}
            placeholder="What the week looked like from the inside…"
          />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="secondary" disabled={pending || aggregateView} onClick={() => send("weekly-upsert")}>
              Save note
            </Button>
            {!completedAt && (
              <Button disabled={pending || aggregateView} onClick={() => send("weekly-complete")}>
                Complete this week&apos;s review
              </Button>
            )}
            {completedAt && (
              <span className="text-xs text-muted-foreground">
                Completed {completedAt.slice(0, 10)} · score then{" "}
                {scoreAtCompletion == null ? dash : scoreAtCompletion} · score now {score == null ? dash : score}
              </span>
            )}
          </div>
          {aggregateView && (
            <p className="text-xs text-warning">
              A weekly note belongs to one book. Pick an account in the sidebar and this writes to it.
            </p>
          )}
        </div>

        <div className="space-y-1 border-t border-rule pt-3">
          <span className="text-xs font-medium">Last {history.length} completed week{history.length === 1 ? "" : "s"}</span>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No week has been completed on this account yet.</p>
          ) : (
            <div className="rounded-md border border-border" data-testid="ritual-history">
              {history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-baseline gap-x-3 border-t border-rule px-2.5 py-1.5 text-xs first:border-t-0">
                  <span className="w-24 shrink-0 font-medium">{h.label}</span>
                  <span className="text-muted-foreground tabular-nums">
                    score then {h.scoreThen == null ? dash : h.scoreThen}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    score now {h.scoreNow == null ? dash : h.scoreNow}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{h.noteExcerpt || dash}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
