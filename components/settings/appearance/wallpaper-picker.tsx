"use client";

import { useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { WALLPAPER_MAX_BYTES, wallpaperUrl } from "@/lib/domain/appearance";

const ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * Wallpaper: an image behind the canvas, faded by a scrim the opacity slider
 * controls. The FILE uploads the moment it is chosen (POST /api/appearance/
 * wallpaper, which owns the wallpaper_stored_name column); the OPACITY is
 * ordinary form state and saves with the rest of the settings. The parent owns
 * both values and applies the live preview.
 */
export function WallpaperPicker({
  storedName,
  opacity,
  onOpacityChange,
  onUploaded,
  onRemoved,
}: {
  storedName: string | null;
  opacity: number;
  onOpacityChange: (next: number) => void;
  onUploaded: (storedName: string) => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function upload(file: File) {
    if (file.size > WALLPAPER_MAX_BYTES) {
      toast.error(`That image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${WALLPAPER_MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/appearance/wallpaper", { method: "POST", body: fd });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; storedName?: string; message?: string; error?: string };
      if (!res.ok || !json.storedName) {
        toast.error(json.message ?? json.error ?? "Wallpaper upload failed.");
        return;
      }
      onUploaded(json.storedName);
      toast.success("Wallpaper set. The opacity slider saves with the form.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove() {
    setBusy("remove");
    try {
      const res = await fetch("/api/appearance/wallpaper", { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        toast.error(json.message ?? json.error ?? "Could not remove the wallpaper.");
        return;
      }
      onRemoved();
      toast.success("Wallpaper removed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2" data-testid="wallpaper-picker">
      <Label htmlFor="wallpaper-file">Wallpaper</Label>
      <div className="flex flex-wrap items-start gap-3">
        {storedName ? (
          // eslint-disable-next-line @next/next/no-img-element -- local API stream, cache-busted by name; next/image adds nothing here
          <img
            src={wallpaperUrl(storedName)}
            alt="Current wallpaper"
            className="h-16 w-28 shrink-0 rounded-md border border-border object-cover"
          />
        ) : (
          <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-[10px] text-muted-foreground">
            none
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              id="wallpaper-file"
              type="file"
              accept={ACCEPT}
              disabled={busy !== null}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
              className="max-w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border file:border-border file:bg-card file:px-2 file:py-1 file:text-xs file:text-foreground"
            />
            {storedName && (
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={remove}>
                {busy === "remove" ? "Removing…" : "Remove"}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="wallpaper-opacity" className="shrink-0 text-xs font-normal text-muted-foreground">
              Opacity
            </Label>
            <input
              id="wallpaper-opacity"
              type="range"
              min={0}
              max={100}
              step={5}
              value={opacity}
              disabled={!storedName}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
              className="h-2 w-full flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{opacity}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        PNG, JPEG or WebP up to {WALLPAPER_MAX_BYTES / 1024 / 1024} MB.{" "}
        <span className="text-foreground">Uploads immediately; the slider saves with the form.</span> Not included in
        backups; stored on this computer only.
        {busy === "upload" && <span className="text-foreground"> Uploading…</span>}
      </p>
    </div>
  );
}
