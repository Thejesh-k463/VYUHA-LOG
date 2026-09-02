"use client";

// v3.7 WS3 — the first-run wizard. Mounted once in app/layout.tsx beside
// CommandPalette/NavHistoryTracker, and fed from the layout's existing server
// read, so it can open over the app without any page knowing about it.
//
// Three things about this file are deliberate:
//
//  • It opens on the DASHBOARD only. The mount has to be the root layout (it is
//    the one component tree that survives navigation, which is what makes the
//    stored step resumable), but a modal that reopens over /import would block
//    the very screen step 2 sends people to. Pathname-gated open = the wizard
//    closes when you follow one of its own links and is waiting, on the step
//    you left, when you come back.
//  • Progress is DERIVED from localStorage through useStoredValue, not mirrored
//    into React state — the project's "derive, never set-state-in-effect" rule,
//    and the reason a mid-wizard navigation resumes correctly. Step 1's boxes
//    are derived for the same reason and by the same rule: they hold typing
//    that carries the server snapshot it was typed against, and fall back to
//    that snapshot otherwise (accountFormOwner in lib/domain/onboarding.ts).
//    Seeding them from props once at mount is the defect this file carried.
//  • It is not in NAV_ITEMS. The /pricing precedent (app/pricing/page.tsx:11-18)
//    keeps a real surface out of nav to avoid the help-content coupling; a
//    first-run wizard has no standing surface to describe at all.
//
// Capital stays OPTIONAL (owner decision Q4): blank is a real answer that keeps
// invariant 6's unknown-state paths live, and the copy says so.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { FileUp, Link2, PencilLine } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toaster";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { brokersWithNativeParser } from "@/lib/import/registry-meta";
import { TRIAL_DAYS } from "@/lib/license";
import {
  type AccountDraft,
  type AccountFormFields,
  type AccountSnapshot,
  LAST_STEP,
  ONBOARDING_COPY as C,
  ONBOARDING_STEP_KEY,
  accountFormFields,
  accountFormOwner,
  dismissalSurvives,
  isLastStep,
  nextStep,
  parseStoredStep,
  planAccountStep,
  prevStep,
  serializeStep,
} from "@/lib/domain/onboarding";

export interface OnboardingWizardProps {
  /** The install has never finished a first run (`settings.onboarding_completed_at` is NULL). */
  show: boolean;
  accountId: number | null;
  accountName: string;
  equityCapital: number | null;
  activeCapital: number | null;
}

export function OnboardingWizard({ show, accountId, accountName, equityCapital, activeCapital }: OnboardingWizardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const step = parseStoredStep(useStoredValue(ONBOARDING_STEP_KEY));
  // Closes the dialog the instant Skip/Finish is pressed; the server flag
  // catches up on the router.refresh() that follows.
  //
  // The latch belongs to ONE run of the wizard. Settings' "Run setup again"
  // clears the server flag, so `show` swings false and then true again — and a
  // one-way latch swallowed that second run for the rest of the session,
  // because the root layout survives client navigation. The rule lives in
  // lib/domain/onboarding.ts and is applied here during RENDER by comparing
  // the prop against the value already seen: React's own answer to a prop
  // change, and not the state-sync effect AGENTS.md rules out.
  const [seenShow, setSeenShow] = React.useState(show);
  const [dismissed, setDismissed] = React.useState(false);
  const closed = dismissalSurvives(seenShow, show, dismissed);
  if (seenShow !== show) {
    setSeenShow(show);
    setDismissed(closed);
  }
  const [pending, setPending] = React.useState(false);
  // Step 1's boxes are DERIVED from the server snapshot, never seeded from it.
  // Seeding them once at mount is what let "Run setup again" render empty
  // capital boxes over an account holding real capital, and then read that
  // emptiness as a deliberate clear. Typing carries the snapshot it was typed
  // against (accountFormOwner); anything else shows the server's own values.
  // The precedent is components/review/note-draft.ts — ownership, not a
  // re-seeding effect.
  const server: AccountSnapshot = { accountId, name: accountName, equityCapital, activeCapital };
  const owner = accountFormOwner(server);
  const [draft, setDraft] = React.useState<AccountDraft | null>(null);
  const fields = accountFormFields(draft, owner, server);
  const setField = (patch: Partial<AccountFormFields>) => setDraft({ owner, ...fields, ...patch });

  const open = show && !closed && pathname === "/";
  const goto = (n: number) => writeStored(ONBOARDING_STEP_KEY, serializeStep(n));

  /** Write step 1 only when something actually changed — see planAccountStep. */
  async function saveAccount(): Promise<boolean> {
    // Every branch of the decision is pure and lives in lib/domain/onboarding.
    // Two of them refuse: a capital box this build cannot read is not an
    // emptied box, and an emptied name box is not a saved step. Both name the
    // box, send nothing, and leave the step where it is — capital itself stays
    // optional, so a genuinely blank box still writes a NULL below.
    const plan = planAccountStep(server, fields);
    if (plan.kind === "refuse") {
      toast.error(
        plan.box === "name"
          ? C.step1.nameMissing(C.step1.nameLabel)
          : C.step1.capitalUnreadable(plan.box === "equity" ? C.step1.equityLabel : C.step1.activeLabel),
      );
      return false;
    }
    if (plan.kind === "skip") return true;
    setPending(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "upsert",
          id: accountId,
          name: plan.name,
          equityCapital: plan.equityCapital,
          activeCapital: plan.activeCapital,
          archived: false,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? C.step1.saveError);
        return false;
      }
      // What was typed IS what the server holds now. Dropping the draft keeps
      // it from coming back later if the snapshot ever returns to the one it
      // was typed against; a failed save keeps it, so nothing typed is lost.
      setDraft(null);
      router.refresh();
      return true;
    } catch {
      toast.error(C.step1.saveError);
      return false;
    } finally {
      setPending(false);
    }
  }

  /** Both "Skip for now" and "Finish" send `complete` — a skipped wizard must
   *  not return every launch (the route's own note says the same). */
  async function complete() {
    setDismissed(true);
    writeStored(ONBOARDING_STEP_KEY, null);
    try {
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete" }),
      });
    } catch {
      /* offline is not a reason to trap someone in a wizard — the dialog is
         already closed, and the next launch simply offers it again. */
    }
    router.refresh();
  }

  async function onNext() {
    if (step === 1 && !(await saveAccount())) return;
    if (isLastStep(step)) {
      await complete();
      return;
    }
    goto(nextStep(step));
  }

  if (!open) return null;

  return (
    // No onOpenChange: Radix routes Escape and backdrop presses through it, so
    // leaving it undefined makes both no-ops. The explicit handlers below say
    // that out loud, and `[&>button]:hidden` hides DialogContent's own X (its
    // only direct-child button) — "Skip for now" is the one way out, and it is
    // a decision, not an accident.
    <Dialog open>
      <DialogContent
        className="max-w-xl [&>button]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        data-testid="onboarding-wizard"
      >
        <DialogHeader>
          <DialogTitle>{C.dialogTitle}</DialogTitle>
          <DialogDescription>{C.dialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4" data-testid={`onboarding-step-${step}`}>
          <div className="flex items-center gap-2">
            {Array.from({ length: LAST_STEP }, (_, i) => i + 1).map((n) => (
              <span key={n} className={n <= step ? "h-1 flex-1 rounded-full bg-accent" : "h-1 flex-1 rounded-full bg-border"} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{C.stepLabel(step, LAST_STEP)}</p>

          {step === 1 && (
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">{C.step1.title}</h3>
              <p className="text-xs text-muted-foreground">{C.step1.lead}</p>
              <div className="space-y-1.5">
                <Label htmlFor="onboarding-account-name">{C.step1.nameLabel}</Label>
                <Input
                  id="onboarding-account-name"
                  value={fields.name}
                  onChange={(e) => setField({ name: e.target.value })}
                  data-testid="onboarding-account-name"
                />
                <p className="text-xs text-muted-foreground">{C.step1.nameHint}</p>
              </div>
              <div className="space-y-1.5">
                <Label>{C.step1.capitalLegend}</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    aria-label={C.step1.equityLabel}
                    placeholder={C.step1.equityLabel}
                    inputMode="decimal"
                    value={fields.equity}
                    onChange={(e) => setField({ equity: e.target.value })}
                    data-testid="onboarding-equity-capital"
                  />
                  <Input
                    aria-label={C.step1.activeLabel}
                    placeholder={C.step1.activeLabel}
                    inputMode="decimal"
                    value={fields.active}
                    onChange={(e) => setField({ active: e.target.value })}
                    data-testid="onboarding-active-capital"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{C.step1.capitalNote}</p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{C.step2.title}</h3>
              <p className="text-xs text-muted-foreground">{C.step2.lead}</p>
              <WayIn href="/import" icon={<FileUp className="size-4" />} title={C.step2.importTitle} hint={C.step2.importHint(brokersWithNativeParser().length)} testId="onboarding-goto-import" />
              <WayIn href="/import-help" icon={<Link2 className="size-4" />} title={C.step2.connectTitle} hint={C.step2.connectHint} testId="onboarding-goto-connect" />
              <WayIn href="/trades" icon={<PencilLine className="size-4" />} title={C.step2.manualTitle} hint={C.step2.manualHint} testId="onboarding-goto-trades" />
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{C.step3.title}</h3>
              {/* ONE sentence, and no second copy of the disclosure: the
                  consent text and its ack version are enforced server-side,
                  and a duplicate here would drift from the version on file. */}
              <p className="text-xs text-muted-foreground">{C.step3.sentence}</p>
              <Link
                href="/settings"
                className="inline-flex text-xs text-accent underline underline-offset-2"
                data-testid="onboarding-goto-settings"
              >
                {C.step3.settingsLink}
              </Link>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">{C.step4.title}</h3>
              <p className="text-xs text-muted-foreground">{C.step4.body}</p>
              <p className="text-xs text-muted-foreground">{C.step4.reviewDesk(TRIAL_DAYS)}</p>
            </div>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-[0.6875rem] text-muted-foreground">{C.skipNote}</span>
          <span className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void complete()} data-testid="onboarding-skip">
              {C.skip}
            </Button>
            {step > 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => goto(prevStep(step))} data-testid="onboarding-back">
                {C.back}
              </Button>
            )}
            <Button type="button" size="sm" disabled={pending} onClick={() => void onNext()} data-testid="onboarding-next">
              {isLastStep(step) ? C.finish : C.next}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One of step 2's three routes out. A plain link: following it closes the
 *  wizard (the pathname changes) and leaves the stored step where it was. */
function WayIn({ href, icon, title, hint, testId }: { href: string; icon: React.ReactNode; title: string; hint: string; testId: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="flex items-start gap-3 rounded-md border border-border bg-card-hover/40 px-3 py-2.5 hover:border-accent/60"
    >
      <span className="mt-0.5 text-accent">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </Link>
  );
}
