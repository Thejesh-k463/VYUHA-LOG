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
} from "@/lib/analytics/behavior";
import type { Trade } from "@/lib/db/schema";

export interface PlaybookOption {
  id: number;
  name: string;
  archived: boolean;
}

/** Post-trade review: playbook, emotion, mistakes, notes — the behavioral journal. */
export function JournalDialog({ trade, playbooks, onDone }: { trade: Trade; playbooks: PlaybookOption[]; onDone: () => void }) {
  const router = useRouter();
  const [playbookId, setPlaybookId] = React.useState(trade.playbookId == null ? "" : String(trade.playbookId));
  const [emotionTag, setEmotionTag] = React.useState(trade.emotionTag ?? "");
  const [mistakes, setMistakes] = React.useState<Set<string>>(new Set(trade.mistakeTags ?? []));
  const [notes, setNotes] = React.useState(trade.notes ?? "");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  // Archived playbooks stay pickable only when the trade already points at one.
  const options = playbooks.filter((p) => !p.archived || String(p.id) === playbookId);

  function toggleMistake(tag: string) {
    setMistakes((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
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

      <Attachments tradeId={trade.id} />

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

interface AttachmentMeta {
  id: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

/** Chart screenshots for a trade — stored in app-data, indexed in trade_attachments. */
function Attachments({ tradeId }: { tradeId: number }) {
  const [items, setItems] = React.useState<AttachmentMeta[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/trades/attachments?tradeId=${tradeId}`);
      const data = await res.json();
      if (data.ok) setItems(data.attachments);
    } catch {
      /* list stays empty */
    }
  }, [tradeId]);

  React.useEffect(() => {
    // .then keeps every setState async (react-compiler set-state-in-effect rule)
    let alive = true;
    fetch(`/api/trades/attachments?tradeId=${tradeId}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d.ok) setItems(d.attachments);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tradeId]);

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("tradeId", String(tradeId));
      fd.set("file", file);
      const res = await fetch("/api/trades/attachments", { method: "POST", body: fd });
      const data = await res.json();
      if (!data.ok) setErr(data.message ?? "Upload failed");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(id: number) {
    setBusy(true);
    try {
      await fetch("/api/trades/attachments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Label>Chart screenshots</Label>
      <div className="rounded-md border border-border bg-card-hover/30 p-2.5">
        {items.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {items.map((a) => (
              <div key={a.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <a href={`/api/trades/attachments?id=${a.id}`} target="_blank" rel="noreferrer" title={a.fileName}>
                  <img
                    src={`/api/trades/attachments?id=${a.id}`}
                    alt={a.fileName}
                    className="h-16 w-24 rounded border border-border object-cover"
                  />
                </a>
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  disabled={busy}
                  title="Remove"
                  className="absolute -right-1.5 -top-1.5 hidden size-4 items-center justify-center rounded-full bg-loss text-[10px] leading-none text-white group-hover:flex"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-accent/15 file:px-2 file:py-1 file:text-xs file:text-accent"
        />
        {err && <p className="mt-1 text-[11px] text-loss">{err}</p>}
        <p className="mt-1 text-[11px] text-muted-foreground">
          PNG/JPG/WebP/GIF up to 8 MB — saved in the app data folder (not in JSON backups).
        </p>
      </div>
    </div>
  );
}
