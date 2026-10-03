"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * v4.7.0 C2 (design D5) — the two experiment writes. Route handlers + client
 * fetch + router.refresh() (AGENTS.md: never a server action for an editor
 * write). The server refuses a start in the All-accounts VIEW (invariant 9);
 * the button is disabled there too, with the reason in words, so the refusal is
 * never the first thing a user meets.
 */

type Reply = { ok: true } | { ok: false; message?: string };

async function send(method: "POST" | "PATCH", body: unknown): Promise<string | null> {
  try {
    const r = await fetch("/api/edge-clinic/experiments", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = (await r.json().catch(() => null)) as Reply | null;
    if (r.ok && d?.ok) return null;
    return (d && !d.ok && d.message) || `HTTP ${r.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : "Request failed";
  }
}

function useWrite() {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = async (method: "POST" | "PATCH", body: unknown) => {
    setBusy(true);
    setError(null);
    const err = await send(method, body);
    setBusy(false);
    if (err) setError(err);
    else router.refresh();
  };
  return { busy, error, run };
}

export function StartExperimentButton({
  cellKey,
  hypothesis,
  canStart,
}: {
  cellKey: string;
  hypothesis: string;
  canStart: boolean;
}) {
  const { busy, error, run } = useWrite();
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Experiment:</span> {hypothesis}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canStart || busy}
          onClick={() => run("POST", { cellKey })}
        >
          {busy ? "Starting…" : "Start experiment"}
        </Button>
        {!canStart ? <span className="text-[0.6875rem] text-muted-foreground">Pick one account to start an experiment</span> : null}
        {error ? <span role="alert" className="text-[0.6875rem] text-loss">{error}</span> : null}
      </div>
    </div>
  );
}

export function AbandonExperimentButton({ id, disabled }: { id: number; disabled?: boolean }) {
  const { busy, error, run } = useWrite();
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => run("PATCH", { id, status: "abandoned" })}>
        {busy ? "Abandoning…" : "Abandon"}
      </Button>
      {error ? <span role="alert" className="text-[0.6875rem] text-loss">{error}</span> : null}
    </span>
  );
}
