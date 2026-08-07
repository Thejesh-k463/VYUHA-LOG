"use client";

// Chart screenshots for a trade — stored in app-data, indexed in
// trade_attachments, served by /api/trades/attachments. Shared by the journal
// dialog, the add-trade flow (attach right after saving) and the edit dialog,
// so the upload/thumbnail/delete behaviour cannot drift between entry points.

import * as React from "react";
import { Label } from "@/components/ui/label";

export interface AttachmentMeta {
  id: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
}

export function TradeAttachments({ tradeId, label = "Chart screenshots" }: { tradeId: number; label?: string }) {
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
      <Label>{label}</Label>
      <div className="rounded-md border border-border bg-card-hover/30 p-2.5">
        {items.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {items.map((a) => (
              <div key={a.id} className="group relative">
                <a href={`/api/trades/attachments?id=${a.id}`} target="_blank" rel="noreferrer" title={a.fileName}>
                  {/* Thumbnails come from the local attachments API — next/image adds nothing for localhost blobs. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
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
