"use client";

// Chart screenshots for a trade — stored in app-data, indexed in
// trade_attachments, served by /api/trades/attachments. Shared by the journal
// dialog, the add-trade flow (attach right after saving) and the edit dialog,
// so the upload/thumbnail/delete behaviour cannot drift between entry points.

import * as React from "react";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, ExternalLink, Trash2 } from "lucide-react";

export interface AttachmentMeta {
  id: number;
  fileName: string;
  mime: string;
  sizeBytes: number;
  /** ISO timestamp — the list API always returns it; the viewer captions with it. */
  createdAt: string;
}

const fmtBytes = (b: number) => (b >= 1024 * 1024 ? `${(b / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function TradeAttachments({ tradeId, label = "Chart screenshots" }: { tradeId: number; label?: string }) {
  const [items, setItems] = React.useState<AttachmentMeta[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  // Which image the viewer shows, or null when closed. `items` can shrink
  // under it (delete, reload), so every read CLAMPS rather than trusting it.
  const [viewerIdx, setViewerIdx] = React.useState<number | null>(null);
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

  /**
   * A strip thumbnail, downscaled in the browser (P6, 2026-08-11).
   *
   * The API used to serve the FULL original — up to 8 MB, decoded to hundreds
   * of MB of bitmap — to paint a 96×64 box; a screenshot-heavy journal dialog
   * was the app's single worst memory event. The webview's canvas does the
   * resize with zero dependencies (a native sharp module would have to ride
   * the installer on every platform). Null when a thumbnail would be wrong:
   * GIFs animate, tiny images ARE their own thumb, and a decode failure just
   * means the GET falls back to the original byte-for-byte, as it always did.
   */
  async function makeThumb(file: File): Promise<Blob | null> {
    if (file.type === "image/gif") return null;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 480 / bmp.width);
      if (scale >= 1) {
        bmp.close();
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      return await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.82));
    } catch {
      return null;
    }
  }

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set("tradeId", String(tradeId));
      fd.set("file", file);
      const thumb = await makeThumb(file);
      if (thumb) fd.set("thumb", thumb, "thumb.jpg");
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
                {/* Click opens the IN-APP viewer — the old behaviour (raw image
                    in a new browser tab) lives on as a button inside it. */}
                <button
                  type="button"
                  onClick={() => setViewerIdx(items.indexOf(a))}
                  title={`${a.fileName} — click to view`}
                  data-testid="attachment-thumb"
                  className="block cursor-zoom-in"
                >
                  {/* Thumbnails come from the local attachments API — next/image adds nothing for localhost blobs. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/trades/attachments?id=${a.id}&thumb=1`}
                    alt={a.fileName}
                    className="h-16 w-24 rounded border border-border object-cover"
                  />
                </button>
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
        {err && <p className="mt-1 text-[0.6875rem] text-loss">{err}</p>}
        <p className="mt-1 text-[0.6875rem] text-muted-foreground">
          PNG/JPG/WebP/GIF up to 8 MB — saved in the app data folder (not in JSON backups).
        </p>
      </div>
      <AttachmentViewer
        items={items}
        index={viewerIdx}
        onIndex={setViewerIdx}
        onDelete={remove}
        busy={busy}
      />
    </div>
  );
}

/**
 * Full-size in-app viewer — a NESTED Radix dialog, deliberately: all three
 * mount points of TradeAttachments already sit inside a Dialog, Radix portals
 * each layer to <body>, and Escape closes only the topmost — so closing the
 * viewer never takes the journal/edit dialog down with it.
 */
function AttachmentViewer({
  items,
  index,
  onIndex,
  onDelete,
  busy,
}: {
  items: AttachmentMeta[];
  index: number | null;
  onIndex: (i: number | null) => void;
  onDelete: (id: number) => Promise<void>;
  busy: boolean;
}) {
  // Clamp instead of trusting `index`: a delete or reload can shrink `items`
  // while the viewer is open, and a stale index would render a blank dialog.
  const idx = index === null ? null : Math.min(index, items.length - 1);
  const current = idx !== null && idx >= 0 ? items[idx] : null;
  const open = current !== null;

  const step = (delta: number) => {
    if (idx === null) return;
    const next = idx + delta;
    if (next >= 0 && next < items.length) onIndex(next);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onIndex(null); }}>
      <DialogContent
        // Full-bleed dark shell: cn() is tailwind-merge, so these reliably
        // beat DialogContent's own max-w-2xl / p-5 / max-h-[90vh].
        className="max-w-[95vw] max-h-none w-auto gap-0 overflow-hidden border-0 bg-black/95 p-0"
        data-testid="attachment-viewer"
        onKeyDown={(e) => {
          // Scoped, not a window listener: the dialog holds focus, so arrows
          // land here without leaking into the page behind.
          if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        }}
      >
        <DialogTitle className="sr-only">Chart screenshot viewer</DialogTitle>
        {current && (
          <div className="flex flex-col">
            <div className="relative flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/trades/attachments?id=${current.id}`}
                alt={current.fileName}
                className="max-h-[82vh] max-w-[95vw] object-contain"
              />
              {items.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    disabled={idx === 0}
                    aria-label="Previous screenshot"
                    data-testid="attachment-prev"
                    className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white/90 hover:bg-black/80 disabled:opacity-30"
                  >
                    <ChevronLeft className="size-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => step(1)}
                    disabled={idx === items.length - 1}
                    aria-label="Next screenshot"
                    data-testid="attachment-next"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white/90 hover:bg-black/80 disabled:opacity-30"
                  >
                    <ChevronRight className="size-5" />
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-white/10 px-3 py-2 text-[0.6875rem] text-white/80">
              <span className="min-w-0 truncate font-mono" title={current.fileName}>
                {current.fileName}
                <span className="ml-2 font-sans text-white/50">
                  {fmtBytes(current.sizeBytes)}{current.createdAt ? ` · ${current.createdAt.slice(0, 10)}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {items.length > 1 && (
                  <span className="tabular-nums text-white/60" data-testid="attachment-counter">
                    {(idx ?? 0) + 1} / {items.length}
                  </span>
                )}
                <a
                  href={`/api/trades/attachments?id=${current.id}`}
                  target="_blank"
                  rel="noreferrer"
                  title="Open in new tab"
                  data-testid="attachment-open-tab"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10"
                >
                  <ExternalLink className="size-3.5" /> Open in tab
                </a>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="attachment-delete"
                  title="Delete this screenshot"
                  onClick={() => {
                    // Deleting the LAST image must also null the index, not
                    // just let the derived `open` flip false: Radix fires
                    // onOpenChange only for user-driven closes, so a stale
                    // index would survive — and the next upload would satisfy
                    // the clamp again and pop the viewer open uninvited
                    // (2026-08-10 audit, lane C). Non-last deletes keep the
                    // index; the clamp slides onto the survivor.
                    if (items.length <= 1) onIndex(null);
                    void onDelete(current.id);
                  }}
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-loss hover:bg-white/10 disabled:opacity-40"
                >
                  <Trash2 className="size-3.5" /> Delete
                </button>
              </span>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
