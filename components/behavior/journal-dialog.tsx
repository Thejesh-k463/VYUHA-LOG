"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { DialogClose } from "@/components/ui/dialog";
import {
  MISTAKE_TAGS,
  MISTAKE_LABELS,
  EMOTION_TAGS,
  EMOTION_LABELS,
  PLAYBOOK_RULE_PREFIX,
} from "@/lib/analytics/behavior";
import type { Trade } from "@/lib/db/schema";
import { TradeAttachments } from "@/components/trades/trade-attachments";

export interface PlaybookOption {
  id: number;
  name: string;
  archived: boolean;
  rules: string[];
}

/** Post-trade review: playbook, emotion, mistakes, rule checklist, notes. */
export function JournalDialog({ trade, playbooks, onDone }: { trade: Trade; playbooks: PlaybookOption[]; onDone: () => void }) {
  const router = useRouter();
  const [playbookId, setPlaybookId] = React.useState(trade.playbookId == null ? "" : String(trade.playbookId));
  const [emotionTag, setEmotionTag] = React.useState(trade.emotionTag ?? "");
  const [mistakes, setMistakes] = React.useState<Set<string>>(new Set(trade.mistakeTags ?? []));
  // T1.2 — rules the user admits to having broken on this trade. Seeded from
  // what's already stored so reopening the journal shows the honest state.
  const [brokenRules, setBrokenRules] = React.useState<Set<string>>(
    new Set(
      (trade.ruleViolations ?? [])
        .filter((v) => v.startsWith(PLAYBOOK_RULE_PREFIX))
        .map((v) => v.slice(PLAYBOOK_RULE_PREFIX.length)),
    ),
  );
  const [notes, setNotes] = React.useState(trade.notes ?? "");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Archived playbooks stay pickable only when the trade already points at one.
  const options = playbooks.filter((p) => !p.archived || String(p.id) === playbookId);
  const selected = playbooks.find((p) => String(p.id) === playbookId) ?? null;

  function toggleMistake(tag: string) {
    setMistakes((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function toggleRule(rule: string) {
    setBrokenRules((prev) => {
      const next = new Set(prev);
      if (next.has(rule)) next.delete(rule);
      else next.add(rule);
      return next;
    });
  }

  async function save() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/trades/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: trade.id,
          playbookId: playbookId === "" ? null : Number(playbookId),
          emotionTag: emotionTag || null,
          mistakeTags: [...mistakes],
          // Only rules of the CURRENTLY selected playbook are persisted —
          // switching playbooks drops stale rule texts.
          brokenRules: selected ? [...brokenRules].filter((r) => selected.rules.includes(r)) : [],
          notes,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        router.refresh();
        onDone();
      } else setMsg(data.message ?? "Failed");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Playbook</Label>
          <Select value={playbookId} onChange={(e) => setPlaybookId(e.target.value)}>
            <option value="">— untagged —</option>
            {options.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.archived ? " (archived)" : ""}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Emotion at entry</Label>
          <Select value={emotionTag} onChange={(e) => setEmotionTag(e.target.value)}>
            <option value="">—</option>
            {EMOTION_TAGS.map((t) => (
              <option key={t} value={t}>{EMOTION_LABELS[t]}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-1">
        <Label>Mistakes (tick all that apply)</Label>
        <div className="grid grid-cols-2 gap-1.5 rounded-md border border-border bg-card-hover/30 p-2.5">
          {MISTAKE_TAGS.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={mistakes.has(t)}
                onChange={() => toggleMistake(t)}
                className="size-3.5 accent-[var(--color-loss)]"
              />
              {MISTAKE_LABELS[t]}
            </label>
          ))}
        </div>
      </div>

      {selected && selected.rules.length > 0 && (
        <div className="space-y-1">
          <Label>Playbook rules — tick what you actually followed</Label>
          <div className="space-y-1.5 rounded-md border border-border bg-card-hover/30 p-2.5">
            {selected.rules.map((rule) => {
              const followed = !brokenRules.has(rule);
              return (
                <label key={rule} className="flex cursor-pointer items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={followed}
                    onChange={() => toggleRule(rule)}
                    className="mt-0.5 size-3.5 accent-[var(--color-profit)]"
                  />
                  <span className={followed ? "" : "text-loss"}>{rule}</span>
                </label>
              );
            })}
            <p className="pt-1 text-[11px] text-muted-foreground">
              Unticked rules are recorded as violations against this trade. Honest ticking is what makes
              the Discipline page&apos;s &ldquo;which broken rule costs me the most&rdquo; report worth
              reading — nobody sees this but you.
            </p>
          </div>
        </div>
      )}

      <TradeAttachments tradeId={trade.id} />

      <div className="space-y-1">
        <Label>Notes</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What happened, what you'd do differently…"
          className="w-full rounded-md border border-border bg-input p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center justify-end gap-2">
        {msg && <span className="mr-auto text-xs text-loss">{msg}</span>}
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save journal"}</Button>
      </div>
    </div>
  );
}
