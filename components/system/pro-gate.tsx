import Link from "next/link";
import { KeyRound, Sparkles, Lock, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getEntitlement } from "@/lib/queries/license";
import { PRO_FEATURES, BUY_URL, SKU_LABELS, TRIAL_DAYS } from "@/lib/license";

/**
 * Monetization v2 — the single gate every Pro screen sits behind. Server
 * component; wrap the page body: <ProGate>{content}</ProGate>.
 *
 * Behaviour by entitlement (and LICENSE_ENFORCEMENT in lib/license.ts):
 *   licensed            → children, nothing else
 *   trial               → children + slim countdown strip (buy/activate links)
 *   unlicensed, banner  → children + informational banner (current default)
 *   unlicensed, block   → upsell panel INSTEAD of children
 *   expired-key         → like unlicensed, but says so explicitly
 *
 * Product principle (deliberate): the core journal — trades, imports,
 * dashboard, playbooks, settings, backup — is NEVER gated. Analytics are the
 * product; the user's own data is not.
 */
export function ProGate({ children }: { children: React.ReactNode }) {
  const ent = getEntitlement();

  if (ent.state === "licensed") return <>{children}</>;

  if (ent.pro) {
    // Trial (or expired annual key with trial remaining) — full access + honest countdown.
    return (
      <>
        <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 text-xs">
          <Sparkles className="size-3.5 shrink-0 text-accent" />
          <span>
            <span className="font-medium text-foreground">
              Pro trial — {ent.trialDaysLeft} day{ent.trialDaysLeft === 1 ? "" : "s"} left.
            </span>{" "}
            {ent.state === "expired-key" && ent.payload ? (
              <>Your {SKU_LABELS[ent.payload.sku] ?? ent.payload.sku} key expired {ent.payload.expires}. </>
            ) : null}
            Everything stays unlocked while you evaluate.{" "}
            <a href={BUY_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Get the Toolkit</a>
            {" "}·{" "}
            <Link href="/settings" className="text-accent underline-offset-2 hover:underline">Activate a key</Link>
          </span>
        </div>
        {children}
      </>
    );
  }

  if (ent.enforcement === "banner") {
    // Pre-launch default: nothing blocked, honest banner.
    return (
      <>
        <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-xs text-muted-foreground">
          <KeyRound className="size-4 shrink-0 text-accent" />
          <div>
            <span className="font-medium text-foreground">
              Pro feature — {ent.state === "expired-key" ? "your annual key has expired." : "unlicensed copy."}
            </span>{" "}
            This screen is part of the paid toolkit. Already bought it? Activate your key in{" "}
            <Link href="/settings" className="text-accent underline-offset-2 hover:underline">Settings → License</Link>.
          </div>
        </div>
        {children}
      </>
    );
  }

  // "block" mode, trial over, no valid key → upsell panel instead of content.
  return (
    <Card>
      <CardContent className="mx-auto max-w-2xl space-y-4 p-8">
        <div className="flex items-center gap-2 text-base font-semibold">
          <Lock className="size-4 text-accent" />
          {ent.state === "expired-key" ? "Your annual license has expired" : `Your ${TRIAL_DAYS}-day Pro trial has ended`}
        </div>
        <p className="text-sm text-muted-foreground">
          This screen is part of the paid <span className="text-foreground">Trader&apos;s Toolkit</span>. Your
          journal keeps working forever — trades, imports, dashboard, playbooks, backups are never locked, and
          your data never leaves this machine either way.
        </p>
        <ul className="space-y-1.5 text-sm">
          {PRO_FEATURES.map((f) => (
            <li key={f.href} className="flex gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-profit" />
              {f.label}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button asChild>
            <a href={BUY_URL} target="_blank" rel="noreferrer">Get the Trader&apos;s Toolkit</a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings">Activate a key</Link>
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Lifetime license, verified fully offline — activation never phones home. One key per trader; it shows
          your email in-app.
        </p>
      </CardContent>
    </Card>
  );
}
