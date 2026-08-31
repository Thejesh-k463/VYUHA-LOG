import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/kpi-card";
import { inr, num } from "@/lib/format";
import {
  MIN_SAMPLE as WL_MIN_SAMPLE,
  DEEP_LOSS_R,
  type RDistribution,
  type TailReport,
  type WinLossReport,
  type WinLossVerdict,
} from "@/lib/analytics/win-loss";
import { QuadrantScatter, RHistogram } from "./win-loss-charts";

/**
 * Winners-vs-losers tab — M2's winLossReport verdict as the hero, the
 * win-rate/payoff quadrant against the breakeven curve, the provenance-split R
 * histogram, and the loss-tail economics. All copy is DESCRIPTIVE: it names the
 * shape the record already has, never what to do about it.
 */

const VERDICT_COPY: Record<WinLossVerdict, { title: string; detail: string; tone: "good" | "warn" | "info" }> = {
  "wins-big-loses-small": {
    title: "Your wins are bigger than your losses, and losing is the minority",
    detail:
      "The average win exceeds the average loss AND more than half of priced trades win — the quadrant where both levers already point the right way.",
    tone: "good",
  },
  "wins-big-loses-big": {
    title: "Your wins are big, and so is your losing frequency",
    detail:
      "The average win exceeds the average loss, but losses are the majority of trades — the trend-follower shape, which lives or dies by how far above the breakeven curve the payoff sits.",
    tone: "info",
  },
  "wins-small-loses-small": {
    title: "Your wins are small, and losing is rare",
    detail:
      "More than half of priced trades win, but the average win is smaller than the average loss — the scalper shape, which lives or dies by keeping the loss tail short.",
    tone: "info",
  },
  "wins-small-loses-big": {
    title: "Your wins are smaller than your losses, and losses are the majority",
    detail:
      "Both levers point the wrong way at once on this sample: the average win is below the average loss AND fewer than half of priced trades win.",
    tone: "warn",
  },
  "near-breakeven": {
    title: "This book sits on the breakeven curve",
    detail:
      "Win rate and payoff land within five points of the breakeven line, so any quadrant label would be a coin flip — the honest reading is that the edge is not yet distinguishable from zero here.",
    tone: "info",
  },
};

const toneCls = { good: "border-profit/40", warn: "border-warning/45", info: "border-accent/40" } as const;

export function WinLossTab({ report, dist, tail }: { report: WinLossReport; dist: RDistribution; tail: TailReport }) {
  const v = report.verdict ? VERDICT_COPY[report.verdict] : null;
  const winPct = report.winRate.point * 100;

  return (
    <div className="space-y-5">
      {/* ── The verdict ─────────────────────────────────────────────── */}
      <Card className={v ? `border-l-2 ${toneCls[v.tone]}` : undefined}>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{v ? v.title : "No verdict yet"}</CardTitle>
          <Badge variant="secondary">{report.n} priced closed trades</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {v
              ? v.detail
              : report.n < WL_MIN_SAMPLE
                ? `A verdict needs ${WL_MIN_SAMPLE} priced closed trades; this book has ${report.n}. Sorting a trader into a quadrant off fewer would be noise dressed as identity.`
                : "The payoff ratio is unmeasurable — a book with no wins or no losses yet has nothing to put on the magnitude axis, not an infinitely good number."}
          </p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard
              label="Win rate"
              value={report.n > 0 ? `${num(winPct, 1)}%` : "—"}
              sub={report.n > 0 ? `95% CI ${num(report.winRate.lo * 100, 0)}–${num(report.winRate.hi * 100, 0)}%` : "no priced trades"}
            />
            <KpiCard label="Payoff ratio" value={report.payoff == null ? "—" : num(report.payoff, 2)} sub="avg win ÷ avg loss" />
            <KpiCard
              label="Payoff needed"
              value={report.payoffNeeded == null ? "—" : num(report.payoffNeeded, 2)}
              sub="to break even at this win rate"
            />
            <KpiCard
              label="Win rate needed"
              value={report.winRateNeeded == null ? "—" : `${num(report.winRateNeeded * 100, 1)}%`}
              sub="to break even at this payoff"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── The quadrant ────────────────────────────────────────────── */}
      {report.payoff != null && report.n > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Where the book sits against breakeven</CardTitle>
          </CardHeader>
          <CardContent>
            <QuadrantScatter payoff={report.payoff} winRatePct={winPct} />
            <p className="mt-2 text-[0.6875rem] text-muted-foreground">
              The curve is w = 1/(1+p): every combination of win rate and payoff that exactly breaks even
              per trade, before charges and sizing. The dashed lines at payoff 1 and win rate 50% are the
              quadrant axes the verdict above reads from.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ── R distribution, split by provenance ─────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>R-multiple distribution</CardTitle>
          <Badge variant={dist.planCount > 0 ? "secondary" : "warning"}>
            {dist.planCount} plan-derived · {dist.defaultCapCount} default-cap · {dist.noRCount} no R
          </Badge>
        </CardHeader>
        <CardContent>
          {dist.planCount + dist.defaultCapCount === 0 ? (
            <p className="text-sm text-muted-foreground">No closed priced trade carries an R multiple yet.</p>
          ) : (
            <>
              <RHistogram buckets={dist.buckets} />
              <p className="mt-2 text-[0.6875rem] text-muted-foreground">
                Two series because the R means two different things. <b>Plan-derived R</b> is measured against a
                risk amount that verifiably derives from a recorded stop (the stored risk matches
                |entry &minus; stop| &times; qty). <b>Default-cap R</b> is everything else — including trades that
                recorded a stop but whose risk stayed the per-trade cap (₹9,500 by default) that imports fall
                back to — it measures P&amp;L in cap units, <b>not</b> plan adherence, and a &minus;2 there does
                not mean a stop was overrun.
                {dist.noRCount > 0 && <> {dist.noRCount} trade{dist.noRCount === 1 ? "" : "s"} carry no R at all and sit in neither series.</>}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── The loss tail ───────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>How concentrated the losses are</CardTitle>
          <Badge variant="secondary">{tail.lossCount} losing trades</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {tail.lossCount === 0 ? (
            <p className="text-sm text-muted-foreground">No closed losses on this book yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Worst single loss" value={tail.worstLoss == null ? "—" : inr(-tail.worstLoss, { decimals: 0 })} valueClassName="text-loss" sub={tail.worstLossShare == null ? "" : `${num(tail.worstLossShare * 100, 1)}% of all losses`} />
                <KpiCard label={`Worst ${tail.worst5PctCount} trade${tail.worst5PctCount === 1 ? "" : "s"}`} value={tail.worst5PctShare == null ? "—" : `${num(tail.worst5PctShare * 100, 1)}%`} sub="share of gross losses (top 5%)" />
                <KpiCard label={`Deep losses (≤ ${DEEP_LOSS_R}R)`} valueNum={tail.deepLossCount} format="int" valueClassName={tail.deepLossCount > 0 ? "text-loss" : ""} sub={`vs ${tail.cleanLossCount} losses that stayed inside`} />
                <KpiCard label="Deep-loss gap" value={tail.deepLossGapTotal == null ? "—" : inr(tail.deepLossGapTotal, { decimals: 0 })} valueClassName={tail.deepLossGapTotal != null ? "text-loss" : ""} sub={tail.deepLossGapPerTrade == null ? "needs both deep and clean losses" : `${inr(tail.deepLossGapPerTrade, { decimals: 0 })} per deep loss vs the clean average`} />
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                Deep-loss economics are computed on <b>{tail.planLossCoverage.recorded} of {tail.planLossCoverage.total}</b>{" "}
                losses — the ones whose R denominator verifiably derives from a recorded stop. Default-cap R cannot say whether a stop
                was overrun, so those losses are excluded from this comparison, not assumed clean. The gap is an
                expectancy difference against the clean-loss average, never a counterfactual &quot;would have saved&quot;.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
