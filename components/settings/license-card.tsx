"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { Copy, KeyRound, Sparkles } from "lucide-react";
import { PricingTable } from "@/components/system/pricing-table";
import type { LicenseStatus } from "@/lib/queries/license";
import { SKU_LABELS, BUY_URL, type Entitlement } from "@/lib/license";

export function LicenseCard({ status, entitlement }: { status: LicenseStatus; entitlement?: Entitlement }) {
  const router = useRouter();
  const [key, setKey] = React.useState("");
  const [pending, setPending] = React.useState(false);

  async function post(payload: object) {
    setPending(true);
    const res = await fetch("/api/license", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setPending(false);
    if (data.ok) toast.success(data.message ?? "");
    else toast.error(data.message ?? "");
    if (data.ok) {
      setKey("");
      router.refresh();
    }
  }

  return (
    // The id is the landing point for every "/settings#license" deep link (the
    // locked Open-trade button, the Lenses banner). It lives on the Card, not
    // on a wrapper in page.tsx, so reordering the settings page cannot orphan
    // the links again. scroll-mt clears the sticky page header.
    <Card id="license" className="scroll-mt-20">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" /> License</CardTitle>
        {status.licensed ? (
          <Badge variant="profit">Licensed</Badge>
        ) : entitlement?.state === "trial" ? (
          <Badge variant="warning">Pro trial — {entitlement.trialDaysLeft}d left</Badge>
        ) : entitlement?.state === "expired-key" ? (
          <Badge variant="warning">Key expired</Badge>
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
              {SKU_LABELS[status.payload.sku] ?? status.payload.sku} · issued {status.payload.issued}
              {status.payload.expires ? ` · expires ${status.payload.expires}` : " · lifetime"} · verified offline
            </p>
            {status.keyId && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Key ID <span className="font-mono text-foreground">{status.keyId}</span>
                <span className="ml-1.5">— quote this for support (it is not your key).</span>
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              {status.boundTo ? (
                <>Locked to this computer (<span className="font-mono">{status.boundTo}</span>). Changing computers needs a re-issued key.</>
              ) : (
                <>Not locked to a computer — this key works on any machine you own.</>
              )}
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
            {entitlement?.state === "trial" && (
              <p className="flex items-start gap-1.5 rounded-md border border-accent/30 bg-accent/5 p-2 text-xs">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                <span>
                  Every Pro screen is unlocked for {entitlement.trialDaysLeft} more day{entitlement.trialDaysLeft === 1 ? "" : "s"} while you
                  evaluate. Your journal itself is free forever — only advanced analytics need a key after the trial.{" "}
                  <a href={BUY_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Get Vyuha Pro</a>
                </span>
              </p>
            )}
            {entitlement?.state === "expired-key" && entitlement.payload && (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                Your {SKU_LABELS[entitlement.payload.sku] ?? entitlement.payload.sku} key for{" "}
                <span className="font-medium">{entitlement.payload.email}</span> expired on{" "}
                {entitlement.payload.expires}. Renew to keep Pro screens after the grace trial.{" "}
                <a href={BUY_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Renew</a>
              </p>
            )}
            {/* What it costs, right where the key is pasted — the question the
                funnel never answered in-app before 2026-08-12. */}
            <PricingTable compact />
            <p className="text-xs text-muted-foreground">
              Paste the <code className="rounded bg-card-hover px-1 py-0.5">VYUHA-…</code> key from your purchase
              email. Activation is fully offline — the key is verified on this machine and never sent anywhere.
            </p>
            <Textarea
              mono
              value={key}
              onChange={(e) => setKey(e.target.value)}
              rows={2}
              placeholder="VYUHA-…"
            />
            <Button size="sm" disabled={pending || !key.trim()} onClick={() => post({ action: "activate", key })}>
              {pending ? "Activating…" : "Activate"}
            </Button>

            {/* Machine ID lives on the ACTIVATION form, because that is the one
                moment the buyer needs it: keys can be locked to one computer,
                and to issue one the seller needs this value first. */}
            <div className="rounded-md border border-border bg-background/40 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    This computer&apos;s Machine ID
                  </div>
                  <div className="mt-0.5 font-mono text-sm">{status.machineId}</div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard?.writeText(status.machineId);
                    toast.success("Machine ID copied.");
                  }}
                >
                  <Copy className="size-3.5" /> Copy
                </Button>
              </div>
              <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
                Send this with your order if your key is being locked to one computer. It is a one-way
                fingerprint — it contains no personal information and never leaves this machine unless you
                send it.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
