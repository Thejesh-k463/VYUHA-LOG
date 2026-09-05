"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BackfillProgress } from "@/lib/jobs/bhavcopy-backfill";

/**
 * The backfill strip: confirm → start → progress → abort, plus the offline
 * file drop beside it (research answer Q43 has BOTH halves).
 *
 * WHY A ROUTE HANDLER AND NOT A SERVER ACTION (AGENTS.md): a server action
 * auto-refreshes the route, which remounts sibling client components and
 * silently resets their state — here that would wipe the progress readout and
 * the file-drop results mid-run. `fetch` + `router.refresh()` only when there
 * is genuinely something new to render.
 *
 * WHY THE CONFIRM STEP IS NOT A FORMALITY: the button starts up to 252
 * downloads from NSE. The panel states the count, the pace and the host BEFORE
 * the first request, and the server refuses to start without the consent
 * anyway (403) — the dialog is not the only gate, it is the honest one.
 */

interface FileOutcome {
  name: string;
  ok: boolean;
  date: string | null;
  rows: number;
  message: string;
}

export function BackfillPanel({
  initialProgress,
  consented,
  defaultDays,
  rateLimitMs,
}: {
  initialProgress: BackfillProgress;
  consented: boolean;
  defaultDays: number;
  rateLimitMs: number;
}) {
  const router = useRouter();
  const [progress, setProgress] = React.useState(initialProgress);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [drop, setDrop] = React.useState<{ rows: number; results: FileOutcome[] } | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const running = progress.status === "running";

  // Poll while a run is in flight. The state write happens in a TIMER
  // callback, never synchronously in the effect body — that is the pattern
  // AGENTS.md bans, and it is banned because it broke the Trades filter.
  React.useEffect(() => {
    if (!running) return;
    let alive = true;
    const tick = async () => {
      const res = await fetch("/api/atlas/backfill").catch(() => null);
      if (!alive || !res?.ok) return;
      const data = (await res.json()) as { progress: BackfillProgress };
      setProgress(data.progress);
      if (data.progress.status !== "running") router.refresh();
    };
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [running, router]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/atlas/backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string; progress?: BackfillProgress };
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status}).`);
        return false;
      }
      if (data.progress) setProgress(data.progress);
      return true;
    } catch {
      setError("Could not reach the app's own server.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!consented && !(await post({ action: "ack" }))) return;
    if (await post({ action: "start", days: defaultDays })) {
      setConfirming(false);
      setProgress((p) => ({ ...p, status: "running", message: "Starting…" }));
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("files", f);
      const res = await fetch("/api/atlas/import-files", { method: "POST", body: form });
      const data = (await res.json()) as { error?: string; rows?: number; results?: FileOutcome[] };
      if (!res.ok) {
        setError(data.error ?? `Import failed (${res.status}).`);
        return;
      }
      setDrop({ rows: data.rows ?? 0, results: data.results ?? [] });
      router.refresh();
    } catch {
      setError("Could not read those files.");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const done = progress.attempted;
  const pct = progress.requested > 0 ? Math.min(100, Math.round((done / progress.requested) * 100)) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">History backfill</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <p className="text-muted-foreground">
          Atlas is computed from the end-of-day bhavcopy files stored on this machine. A fresh install has one
          session, so most figures read &ldquo;needs N sessions, you have 1&rdquo;. Two ways to fix that, and you
          choose which: download the past {defaultDays} sessions from NSE at one file every {rateLimitMs / 1000}s,
          or drop files you already have — the second makes no network request at all.
        </p>

        {running ? (
          <div className="space-y-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="tabular-nums text-muted-foreground">
              {done} of {progress.requested} sessions · {progress.applied} downloaded · {progress.skipped} already
              had bars · {progress.missing} had no file · {progress.rows.toLocaleString("en-IN")} price rows
              {progress.lastDate ? ` · at ${progress.lastDate}` : ""}
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => post({ action: "abort" })}>
              Stop
            </Button>
          </div>
        ) : confirming ? (
          <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 p-3">
            <p>
              This downloads up to {defaultDays} past bhavcopy files from{" "}
              <span className="font-medium text-foreground">nsearchives.nseindia.com</span> — the same public
              archive the end-of-day price fetch already uses, one request every {rateLimitMs / 1000} seconds,
              about {Math.ceil((defaultDays * rateLimitMs) / 60000)} minutes in all. The files are public and
              carry nothing about you: no account, no identifier, no trade. You can stop it at any point and
              whatever has already been saved is kept.
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={start}>
                Start the backfill
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                Not now
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Backfill {defaultDays} sessions
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}>
              Drop bhavcopy files instead
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".csv,.zip"
              className="hidden"
              onChange={(e) => upload(e.target.files)}
            />
          </div>
        )}

        {progress.status !== "idle" && !running ? (
          <p className="text-muted-foreground">{progress.message}</p>
        ) : null}

        {error ? <p className="rounded-md border border-loss/40 bg-loss/5 p-2 text-foreground">{error}</p> : null}

        {drop ? (
          <div className="space-y-1">
            <div className="font-medium text-foreground">
              {drop.results.filter((r) => r.ok).length} of {drop.results.length} files applied ·{" "}
              {drop.rows.toLocaleString("en-IN")} price rows saved
            </div>
            <ul className="max-h-40 space-y-0.5 overflow-y-auto text-muted-foreground">
              {drop.results.map((r) => (
                <li key={r.name} className="tabular-nums">
                  {r.ok ? "✓" : "✗"} {r.name}
                  {r.date ? ` · ${r.date}` : ""} · {r.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
