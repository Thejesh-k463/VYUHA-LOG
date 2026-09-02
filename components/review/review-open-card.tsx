import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { getEntitlement } from "@/lib/queries/license";
import { getReviewQueue, getReviewStats, getWeeklyReview } from "@/lib/queries/review";
import { isoWeekLabel, isoWeekStart } from "@/lib/analytics/week";
import { previousWeekStart } from "./week-gap";

/**
 * The dashboard's pointer at the Trade Review Desk — a SERVER component with no
 * props, so `app/page.tsx` mounts it in one line and owns none of this logic.
 *
 * ── Why it renders for licensed and trial only ────────────────────────────
 *
 * `/review` is Pro (owner decision #8). A card on the dashboard telling an
 * unlicensed user that seven trades are waiting behind a paywall is an advert
 * dressed as their own data, and the dashboard is the one screen that is
 * unconditionally theirs (invariant 7). So the entitlement is read here and an
 * unlicensed or expired copy gets NOTHING — not a locked card, not a teaser.
 *
 * It also stays quiet when there is nothing to say: no unreviewed trades and no
 * open ritual means no card, rather than a row congratulating the user.
 */
export function ReviewOpenCard() {
  const ent = getEntitlement();
  // The CAPABILITY, never an enumeration of states. An expired ANNUAL key with
  // trial days left evaluates to {state:"expired-key", pro:true}: ProGate hands
  // that install the desk, so a card listing "licensed" and "trial" by name hid
  // the pointer to a screen that works. `pro` is the one answer both read.
  if (!ent.pro) return null;

  // IST, the same zone app/review/page.tsx buckets in. Reading UTC here put the
  // card a whole week behind the desk it links to every Monday between 00:00
  // and 05:30 IST — and let it call a completed week open.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  // The ritual's week is the one that most recently ENDED — the desk reviews a
  // finished week, never the one still running.
  const ritualWeek = previousWeekStart(isoWeekStart(today));
  const stats = getReviewStats(ritualWeek);
  // limit 1: only `total` is read here, and the query returns it unwindowed.
  const unreviewed = getReviewQueue({ limit: 1 }).total;
  const weekly = getWeeklyReview(ritualWeek);
  const ritualOpen = stats.closed > 0 && weekly?.completedAt == null;

  if (unreviewed === 0 && !ritualOpen) return null;

  return (
    <Link
      href="/review"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card-hover/30 px-3 py-2 text-xs transition-colors hover:border-accent/40"
    >
      <ClipboardCheck className="size-4 shrink-0 text-accent" />
      <span className="font-medium text-foreground">
        {isoWeekLabel(ritualWeek)} review {ritualOpen ? "is open" : "is done"}
      </span>
      <span className="text-muted-foreground">
        {stats.closed} closed that week
        {unreviewed > 0
          ? ` · ${unreviewed} trade${unreviewed === 1 ? "" : "s"} in the book carry no review stamp`
          : " · every closed trade carries a review stamp"}
      </span>
    </Link>
  );
}
