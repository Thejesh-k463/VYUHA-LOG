"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Download, Upload, Database, CheckCircle2, AlertCircle } from "lucide-react";

export function BackupPanel() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onRestoreFile(file: File) {
    setMsg(null);
    let dump: unknown;
    try {
      dump = JSON.parse(await file.text());
    } catch {
      setMsg({ ok: false, text: "That file isn't valid JSON." });
      return;
    }
    if (!confirm("Restore will REPLACE all current data with the backup's contents. Continue?")) return;
    setBusy(true);
    const res = await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", dump }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Restore failed" }));
    setBusy(false);
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href="/api/backup" download>
            <Download className="size-3.5" /> Backup (JSON)
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href="/api/backup?format=sqlite" download>
            <Database className="size-3.5" /> Download SQLite
          </a>
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" /> {busy ? "Restoring…" : "Restore from JSON"}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onRestoreFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {msg && (
        <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
          {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
          {msg.text}
        </span>
      )}
      <p className="text-[11px] text-muted-foreground">
        Chart-screenshot attachments are image files in the app data folder (data/attachments) — copy that folder
        separately; the JSON backup covers tables only.
      </p>
    </div>
  );
}
