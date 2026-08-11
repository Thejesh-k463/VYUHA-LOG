"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { Download, Upload, Database, ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";

export function BackupPanel() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");

  async function onExport() {
    setBusy(true);
    const res = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "export", password, includeAttachments: true }) });
    const data = await res.json().catch(() => ({ ok: false, message: "Backup failed." }));
    setBusy(false);
    if (!data.ok) return toast.error(data.message);
    const blob = new Blob([JSON.stringify(data.payload)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href; a.download = data.fileName; a.click(); URL.revokeObjectURL(href);
    toast.success(`Complete backup downloaded${password ? " with AES-256 encryption" : ""}.`);
  }

  async function onRestoreFile(file: File) {
    let dump: unknown;
    try {
      dump = JSON.parse(await file.text());
    } catch {
      toast.error("That file isn't valid JSON.");
      return;
    }
    setBusy(true);
    const encrypted = !!(dump && typeof dump === "object" && "vyuhaEncrypted" in dump);
    const restorePassword = encrypted ? prompt("This backup is encrypted. Enter its password:") : "";
    if (encrypted && restorePassword == null) { setBusy(false); return; }
    const previewRes = await fetch("/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview", dump, password: restorePassword }),
    });
    const preview = await previewRes.json().catch(() => ({ ok: false, message: "Preview failed" }));
    if (!preview.ok) { setBusy(false); toast.error(preview.message); return; }
    if (!confirm(`Restore snapshot from ${preview.createdAt ?? "unknown date"}?\n\n${preview.totalRows} rows and ${preview.attachments} attachment files will replace current data.`)) { setBusy(false); return; }
    const res = await fetch("/api/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "restore", dump, password: restorePassword }) });
    const data = await res.json().catch(() => ({ ok: false, message: "Restore failed" }));
    setBusy(false);
    if (data.ok) toast.success(data.message ?? "");
    else toast.error(data.message ?? "");
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onExport()}>
          <Download className="size-3.5" /> {busy ? "Working…" : "Complete backup"}
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
      <div className="flex max-w-xl items-center gap-2">
        <ShieldCheck className="size-4 shrink-0 text-accent" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Optional password (8+ characters encrypts the backup)" />
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">
        Complete backups include every database table and chart attachment. A password encrypts the entire portable
        file with AES-256-GCM; keep it safe because an offline encrypted backup cannot be recovered without it.
      </p>
    </div>
  );
}
