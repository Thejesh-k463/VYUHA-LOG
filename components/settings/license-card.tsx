"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, KeyRound } from "lucide-react";
import type { LicenseStatus } from "@/lib/queries/license";
import { SKU_LABELS } from "@/lib/license";

export function LicenseCard({ status }: { status: LicenseStatus }) {
  const router = useRouter();
  const [key, setKey] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function post(payload: object) {
    setPending(true);
    setMsg(null);
    const res = await fetch("/api/license", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending(false);
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) {
      setKey("");
      router.refresh();
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> License</CardTitle>
        {status.licensed ? (
          <Badge variant="profit">Licensed</Badge>
        ) : (
          <Badge variant="secondary">Unlicensed</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {status.licensed && status.payload ? (
          <div className="text-sm">
            <p>
              Licensed to <span className="font-medium">{status.payload.email}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {SKU_LABELS[status.payload.sku] ?? status.payload.sku} · issued {status.payload.issued} · verified offline
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              disabled={pending}
              onClick={() => { if (confirm("Remove the license from this machine?")) post({ action: "deactivate" }); }}
            >
              {pending ? "Removing…" : "Remove license"}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Paste the <code className="rounded bg-card-hover px-1 py-0.5">VYUHA-…</code> key from your purchase
              email. Activation is fully offline — the key is verified on this machine and never sent anywhere.
            </p>
            <textarea
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={2}
              placeholder="VYUHA-…"
              className="w-full rounded-md border border-border bg-input p-2 text-xs font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button size="sm" disabled={pending || !key.trim()} onClick={() => post({ action: "activate", key })}>
              {pending ? "Activating…" : "Activate"}
            </Button>
          </>
        )}
        {msg && (
          <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {msg.text}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
