import { PageHeader } from "@/components/layout/page-header";
import { ProGate } from "@/components/system/pro-gate";
import { ProcessScorePanel, type ProcessRowView } from "@/components/review/process-score-panel";
import { ReviewQueuePanel } from "@/components/review/review-queue-panel";
import {
  SundayRitualPanel,
  type RitualHistoryRow,
  type RitualTagGap,
} from "@/components/review/sunday-ritual-panel";
import { previousWeekStart, weekOverWeek } from "@/components/review/week-gap";
import { db } from "@/lib/db";
import { riskConfig } from "@/lib/db/schema";
import { getTrades } from "@/lib/queries/trades";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getSelectedAccount, getSelectedAccountId, isAggregateView } from "@/lib/queries/accounts";
import { getReviewQueue, getWeeklyReview, listWeeklyReviews, weekEndOf } from "@/lib/queries/review";
import { getSessionPlanPage } from "@/lib/queries/session-plan";
import { processScore, processScoreByWeek, type ProcessScore } from "@/lib/analytics/process-score";
import { isoWeekLabel, isoWeekStart } from "@/lib/analytics/week";
import { mistakeReport } from "@/lib/analytics/behavior";
import { exitTriggers } from "@/lib/analytics/exit-behaviour";
import { metricCaveatLine, metricDetail } from "@/lib/domain/metric-help";
import { toSlimTrade } from "@/lib/domain/slim-trade";

export const dynamic = "force-dynamic";

/**
 * THE TRADE REVIEW DESK (v3.7 WS1, spec: docs/V370_BUILD_PLAN.md §1.4).
 *
 * Three panels: the open week's Process Score with its arithmetic beside it,
 * the queue of closed trades carrying no review stamp, and the ritual for the
 * week that most recently ended.
 *
 * Pro-gated (owner decision #8) — and the gate wraps the PANELS, not the
 * header, so a user who lands here still learns what the screen is. The core
 * journal on /trades is untouched by this: invariant 7 is about a trader's own
 * record, and none of it lives here.
 *
 * Two figures the page deliberately does NOT fabricate:
 *   - the per-trade cap and daily stop are read as NULL when unset, so the
 *     risk-cap and daily-stop components refuse rather than score a book
 *     against a limit nobody configured (the `|| 9500` this replaces);
 *   - the week-over-week line is blank across a gap, following the `momNet`
 *     rule in lib/analytics/monthly.ts.
 */

/** The registry's one-liner per component id — rendered under the five rows. */
const COMPONENT_NOTES: Record<string, string> = {
  planned: metricCaveatLine("processPlanned"),
  "risk-cap": metricCaveatLine("processRiskCap"),
  "daily-stop": metricCaveatLine("processDailyStop"),
  "rules-followed": metricCaveatLine("processRulesFollowed"),
  reviewed: metricCaveatLine("processReviewed"),
};

function rowsOf(s: ProcessScore): ProcessRowView[] {
  return s.components.map((c) => ({
    id: c.id,
    label: c.label,
    numerator: c.numerator,
    denominator: c.denominator,
    pct: c.pct,
    coverage: `${c.coverage.have} of ${c.coverage.of} ${c.coverage.noun}`,
    note: COMPONENT_NOTES[c.id] ?? "",
  }));
}

export default function ReviewPage() {
  const trades = getTrades();
  const aggregateView = isAggregateView();
  // Half of a weekly note's OWNER (the week is the other half). The ritual
  // panel derives its textarea from this, so an account switch — a soft
  // router.refresh() that keeps the client instance alive — can no longer leave
  // one book's prose sitting beside another book's figures.
  const accountId = getSelectedAccountId();
  const accountLabel = getSelectedAccount()?.name ?? "All accounts";

  // Unset means unset (invariant 6): a limit the user never configured is not a
  // limit to measure their losses against.
  const risk = db.select().from(riskConfig).all();
  const cfg = {
    perTradeCap: risk.find((r) => r.scope === "global")?.perTradeMaxLoss ?? null,
    dailyStop: risk.find((r) => r.scope === "bucket" && r.key === "active")?.dailyLossStop ?? null,
  };

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const thisMonday = isoWeekStart(today);
  const ritualMonday = previousWeekStart(thisMonday);

  // ONE bucketer for both panels and the history strip, so a week here is the
  // same week `weekly_reviews.week_start` means (lib/analytics/week.ts).
  const weeks = processScoreByWeek(trades, cfg);
  const byWeek = new Map(weeks.map((w) => [w.weekStart, w]));
  const scores = new Map<string, number | null>(weeks.map((w) => [w.weekStart, w.score]));

  // A week with nothing closed has no bucket at all; scoring an empty list
  // gives the same five rows with honest zero denominators.
  const thisWeek: ProcessScore = byWeek.get(thisMonday) ?? processScore([], cfg);
  const ritual: ProcessScore = byWeek.get(ritualMonday) ?? processScore([], cfg);

  // ── Panel 2 — the queue ──────────────────────────────────────────────────
  const queue = getReviewQueue();
  // The stamped rows are windowed like everything else on this desk, and the
  // house rule is that a shortened list SAYS what it held back — the header
  // used to print this slice's length beside the word "reviewed", which reads
  // as a total.
  const REVIEWED_LIMIT = 20;
  const reviewedAll = trades
    .filter((t) => !t.isOpen && t.reviewedAt)
    .sort((a, b) => (b.reviewedAt ?? "").localeCompare(a.reviewedAt ?? ""));
  const reviewed = reviewedAll.slice(0, REVIEWED_LIMIT).map(toSlimTrade);

  // ── Panel 3 — the ritual week ────────────────────────────────────────────
  const ritualEnd = weekEndOf(ritualMonday);
  const ritualTrades = trades.filter(
    (t) => !t.isOpen && t.sellDate != null && t.sellDate >= ritualMonday && t.sellDate <= ritualEnd,
  );
  const mistakes = mistakeReport(ritualTrades);
  // The expectancy GAP per tag, never a counterfactual: what the tagged trades
  // averaged against what the untagged ones did. With no untagged trade there
  // is no comparator, so there is no gap — an invented 0 baseline would be a
  // fabricated denominator.
  const gaps: RitualTagGap[] =
    mistakes.cleanTrades > 0
      ? mistakes.perTag
          .map((t) => ({
            tag: t.tag,
            label: t.label,
            trades: t.trades,
            avgNet: t.avgNet,
            gap: Math.round((mistakes.cleanExpectancy - t.avgNet) * 100) / 100,
          }))
          .sort((a, b) => b.gap - a.gap)
          .slice(0, 3)
      : [];

  const rated = ritualTrades.filter((t) => t.rMultiple != null);
  const byR = [...rated].sort((a, b) => (b.rMultiple ?? 0) - (a.rMultiple ?? 0));
  const extreme = (t: (typeof rated)[number] | undefined) =>
    t ? { symbol: t.symbol, rMultiple: t.rMultiple ?? 0, netPnl: t.netPnl, sellDate: t.sellDate } : null;

  const triggers = exitTriggers(ritualTrades);

  const sessions = getSessionPlanPage()
    .filter((s) => s.sessionDate >= ritualMonday && s.sessionDate <= ritualEnd)
    .map((s) => ({ sessionDate: s.sessionDate, market: s.market, adherencePct: s.review.adherencePct }));

  const weekly = getWeeklyReview(ritualMonday);
  // Completed weeks only, newest first. The window is generous (two years of
  // weeks) and then trimmed to 12, because `listWeeklyReviews` windows on rows
  // rather than on completions — asking for 12 rows could return 12 open ones.
  const history: RitualHistoryRow[] = listWeeklyReviews(104)
    .filter((w) => w.completedAt != null)
    .slice(0, 12)
    .map((w) => ({
      id: w.id,
      weekStart: w.weekStart,
      label: isoWeekLabel(w.weekStart),
      completedAt: w.completedAt!,
      scoreThen: w.scoreAtCompletion,
      scoreNow: byWeek.get(w.weekStart)?.score ?? null,
      noteExcerpt: (w.note ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    }));

  return (
    <>
      <PageHeader
        title="Trade Review Desk"
        description="The week's Process Score with its arithmetic, the trades still waiting to be read, and the ritual for the week just gone."
      />
      <div className="space-y-5 p-6">
        <ProGate>
          <ProcessScorePanel
            weekLabel={isoWeekLabel(thisMonday)}
            weekStart={thisMonday}
            weekEnd={weekEndOf(thisMonday)}
            score={thisWeek.score}
            refusal={thisWeek.refusal?.reason ?? null}
            closedTrades={thisWeek.closedTrades}
            rows={rowsOf(thisWeek)}
            comparison={weekOverWeek(scores, thisMonday, thisWeek.score)}
            detail={metricDetail("processScore")}
          />

          <ReviewQueuePanel
            rows={queue.rows}
            total={queue.total}
            limit={queue.limit}
            reviewed={reviewed}
            reviewedTotal={reviewedAll.length}
            reviewedLimit={REVIEWED_LIMIT}
            playbooks={getPlaybooks().map((p) => ({
              id: p.id,
              name: p.name,
              archived: p.archived,
              rules: p.rules,
            }))}
            weekStart={thisMonday}
            weekEnd={weekEndOf(thisMonday)}
            aggregateView={aggregateView}
          />

          <SundayRitualPanel
            weekLabel={isoWeekLabel(ritualMonday)}
            weekStart={ritualMonday}
            weekEnd={ritualEnd}
            closed={ritualTrades.length}
            net={Math.round(ritualTrades.reduce((s, t) => s + t.netPnl, 0) * 100) / 100}
            charges={Math.round(ritualTrades.reduce((s, t) => s + t.chargesTotal, 0) * 100) / 100}
            score={ritual.score}
            refusal={ritual.refusal?.reason ?? null}
            gaps={gaps}
            cleanExpectancy={mistakes.cleanExpectancy}
            cleanTrades={mistakes.cleanTrades}
            best={extreme(byR[0])}
            worst={extreme(byR[byR.length - 1])}
            ratedTrades={rated.length}
            triggers={triggers.rows.map((r) => ({
              key: r.key,
              count: r.count,
              net: r.net,
              winRate: r.winRate,
              expectancy: r.expectancy,
            }))}
            triggersAnswered={triggers.answered}
            triggersExcluded={triggers.unanswered}
            adherence={sessions}
            note={weekly?.note ?? ""}
            completedAt={weekly?.completedAt ?? null}
            scoreAtCompletion={weekly?.scoreAtCompletion ?? null}
            history={history}
            aggregateView={aggregateView}
            accountId={accountId}
            accountLabel={accountLabel}
          />
        </ProGate>
      </div>
    </>
  );
}
