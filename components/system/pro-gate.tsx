import Link from "next/link";
import { KeyRound, Sparkles, Lock, ShieldCheck, TriangleAlert, CalendarClock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PricingTable } from "@/components/system/pricing-table";
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

  // A licence inside its revocation GRACE window (v2.99.91). Nothing is taken
  // away yet — this is the warning that makes the countdown visible on every
  // Pro screen, so nobody discovers a withdrawal by finding a screen locked.
  // Deliberately loud (loss colour, days remaining) and deliberately
  // non-blocking: it renders ABOVE the real content, which still works.
  if (ent.revocationWarning) {
    const w = ent.revocationWarning;
    return (
      <>
        <div className="flex items-start gap-2 rounded-md border border-loss/40 bg-loss/5 p-3 text-xs">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-loss" />
          <div>
            <span className="font-medium text-foreground">
              This licence is scheduled to stop working on {w.effectiveFrom} —{" "}
              {w.daysLeft} day{w.daysLeft === 1 ? "" : "s"} left.
            </span>{" "}
            {w.message}{" "}
            <span className="text-muted-foreground">
              Your journal is not affected: trades, imports, backups and exports keep working after that date.
            </span>
          </div>
        </div>
        {children}
      </>
    );
  }

  // An annual licence inside its last 30 days (v2.99.94). Nothing is gated —
  // this is the renewal notice that did not exist, and without it 17 Pro
  // screens locked overnight with the buyer's first signal being a locked
  // screen. Deliberately calmer than the revocation banner: nothing is being
  // taken away, a decision is simply due.
  if (ent.state === "licensed" && ent.expiryWarning) {
    const w = ent.expiryWarning;
    return (
      <>
        <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 p-3 text-xs">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-accent" />
          <div>
            <span className="font-medium text-foreground">
              Your Pro licence renews on {w.expires} — {w.daysLeft} day{w.daysLeft === 1 ? "" : "s"} left.
            </span>{" "}
            <span className="text-muted-foreground">
              Nothing changes today. After that date the Pro analytics lock, and your journal —
              trades, imports, backups and exports — keeps working exactly as it does now.
            </span>{" "}
            <a href={BUY_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Renew</a>
          </div>
        </div>
        {children}
      </>
    );
  }

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
            <a href={BUY_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">Get Vyuha Pro</a>
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
              Pro feature —{" "}
              {ent.state === "expired-key"
                ? ent.reason ? "this licence is no longer active." : "your annual key has expired."
                : "unlicensed copy."}
            </span>{" "}
            {/* The specific reason, when there is one — a revocation message, a
                key locked to another machine, an unreadable vault. Without this
                a revoked buyer reads "expired", which is both wrong and
                unactionable, and the message the vendor wrote never arrives. */}
            {ent.reason ? <span className="text-foreground">{ent.reason}</span> : null}{" "}
            This screen is part of Vyuha Pro. Already bought it? Activate your key in{" "}
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
          {ent.state === "expired-key"
            // A revoked key is "expired-key" too, but nothing about it expired
            // — the reason line below says what actually happened, so the
            // heading must not assert a date-based story over it.
            ? (ent.reason ? "This licence is no longer active" : "Your annual license has expired")
            : `Your ${TRIAL_DAYS}-day Pro trial has ended`}
        </div>
        {/* Same reason as the banner branch: a revoked or machine-locked key
            has something specific to say, and "your annual license has
            expired" is the wrong sentence to show that buyer. */}
        {ent.reason ? (
          <p className="rounded-md border border-loss/40 bg-loss/5 p-3 text-sm text-foreground">{ent.reason}</p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          This screen is part of <span className="text-foreground">Vyuha Pro</span>. Your
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
        {/* The panel is the top of the funnel — it must answer "how much?".
            Until 2026-08-12 it did not, and every prospect had to open a
            WhatsApp chat to learn the price. */}
        <PricingTable compact />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button asChild>
            {/* Named for the plans actually on sale. This said "Get the
                Trader's Toolkit" until 2026-08-12 — an app+indicators bundle
                retired by the v2.99.76 reprice, so the funnel's primary CTA
                was offering a product that no longer existed. */}
            <a href={BUY_URL} target="_blank" rel="noreferrer">Get Vyuha Pro</a>
          </Button>
          <Button asChild variant="outline">
            <Link href="/pricing">Compare plans</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/settings#license">Activate a key</Link>
          </Button>
        </div>
        {/* "Lifetime license" flatly until 2026-08-12 — untrue of the annual
            plan the reprice introduced, and it sat directly under a table
            offering both. */}
        <p className="text-[0.6875rem] text-muted-foreground">
          Annual or lifetime, verified fully offline — activation never phones home. One key per trader; it shows
          your email in-app.
        </p>
      </CardContent>
    </Card>
  );
}
