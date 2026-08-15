import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { OptionsJournalEditor } from "@/components/behavior/options-journal-editor";
import { OutcomeMixBar } from "@/components/behavior/outcome-mix-bar";
import { optionsSellerReport, sellerKpiDetails, orderedOutcomes } from "@/lib/analytics/options-seller";
import { dteReport, hedgeReport, rollReport, ivRankReport, thetaEfficiency } from "@/lib/analytics/options-seller-depth";
import { inr } from "@/lib/format";
import { getTrades } from "@/lib/queries/trades";
import { ProGate } from "@/components/system/pro-gate";

export const dynamic = "force-dynamic";

/** Section eyebrow — the same 10.5px tracked caps the KPI cards use for their
 *  label, with a short accent rule so the eye finds each block on a long page. */
function Eyebrow({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2.5 pt-1">
      <span aria-hidden className="h-px w-5 shrink-0 self-center bg-primary/70" />
      <span className="text-[10.5px] font-medium uppercase tracking-[0.13em] text-muted-foreground">{children}</span>
      {hint && <span className="text-[0.6875rem] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

export default function OptionsJournalPage() {
  const options = getTrades().filter((t) => t.instrumentType === "option");
  const seller = optionsSellerReport(options);
  const details = sellerKpiDetails(options, seller);
  const outcomeSlices = orderedOutcomes(seller.outcomes);
  const dominant = outcomeSlices.slice().sort((a, b) => b.count - a.count)[0];
  // Round two: the questions a seller actually changes behaviour over.
  const dte = dteReport(options);
  const hedge = hedgeReport(options);
  const rolls = rollReport(options);
  const iv = ivRankReport(options);
  const theta = thetaEfficiency(options);
  return <>
    <PageHeader title="Options Seller Journal" description="Premium capture, IV change, hedge state, DTE, adjustments and expiry outcomes." />
    <div className="space-y-5 p-6">
        <ProGate>
      <Eyebrow hint="click any card for the breakdown">The book</Eyebrow>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Seller trades" valueNum={seller.count} format="int" sub={`${seller.closed} closed · ${seller.count - seller.closed} open`} detail={details.trades} />
        {/* Hero on the one number that outranks the band — KpiCard allows one per screen. */}
        <KpiCard label="Net P&L" valueNum={seller.netPnl} hero detail={details.netPnl} valueClassName={seller.netPnl > 0 ? "text-profit" : seller.netPnl < 0 ? "text-loss" : undefined} />
        <KpiCard label="Premium captured" value={seller.capturePct == null ? "—" : `${seller.capturePct}%`} sub="of premium sold, kept" detail={details.capture} />
        <KpiCard label="Fully hedged" value={seller.hedgedPct == null ? "—" : `${seller.hedgedPct}%`} sub="of seller contracts, as recorded" detail={details.hedged} />
      </div>
      {/* Outcome mix: a KPI card (dominant outcome) carrying the stacked bar in
          its sub-line. The bar is a true partition — every contract lands in
          exactly one outcome — which is why a single stacked bar is honest here
          where a theme chart would not be. */}
      <KpiCard
        label="Outcome mix"
        value={dominant && dominant.count ? <span className="capitalize">{dominant.label} <span className="text-muted-foreground">· {dominant.count}</span></span> : "—"}
        sub={outcomeSlices.some((s) => s.count > 0) ? <div className="mt-2"><OutcomeMixBar slices={outcomeSlices} /></div> : "No seller contracts yet."}
        detail={details.outcomes}
      />
      {/* Round two: DTE band, hedging, rolls, IV rank, theta efficiency. */}
      <Eyebrow hint="closed trades only, small samples flagged">Where the edge is</Eyebrow>
      <Card><CardHeader><CardTitle>By days to expiry</CardTitle></CardHeader><CardContent className="space-y-2">
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="border-b border-border text-left uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">Band</th>
            <th className="py-1.5 pr-3 text-right font-medium">Trades</th>
            <th className="py-1.5 pr-3 text-right font-medium">Net</th>
            <th className="py-1.5 pr-3 text-right font-medium">Expectancy</th>
            <th className="py-1.5 pr-3 text-right font-medium">Win rate</th>
            <th className="py-1.5 pr-3 text-right font-medium">Capture</th>
          </tr></thead>
          <tbody>{dte.buckets.map((b) => (
            <tr key={b.label} className="border-b border-rule">
              <td className="py-1.5 pr-3">{b.label}{!b.trustworthy && b.trades > 0 && <span className="ml-1.5 text-[10px] text-warning">small sample</span>}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.trades}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.trades ? inr(b.net, { decimals: 0 }) : "—"}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.expectancy == null ? "—" : inr(b.expectancy, { decimals: 0 })}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.winRate == null ? "—" : `${b.winRate}%`}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.capturePct == null ? "—" : `${b.capturePct}%`}</td>
            </tr>))}</tbody>
        </table></div>
        <p className="text-[0.6875rem] text-muted-foreground">
          {dte.best ? <>Strongest band so far: <b>{dte.best}</b>{dte.worst ? <> · weakest: <b>{dte.worst}</b></> : null}. </> : <>No band yet carries enough closed trades to rank. </>}
          {dte.unknownDte > 0 && <>{dte.unknownDte} closed trade(s) had no entry DTE recorded and are excluded rather than guessed.</>}
        </p>
      </CardContent></Card>

      <Eyebrow hint="each against what was actually available, never a model">Hedging and adjustments</Eyebrow>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Does hedging pay?</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          {[hedge.hedged, hedge.unhedged].map((a) => (
            <div key={a.label} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span>{a.label} <span className="text-muted-foreground">({a.trades} closed)</span></span>
              <span className="tabular-nums">{a.expectancy == null ? "—" : `${inr(a.expectancy, { decimals: 0 })} / trade`}</span>
            </div>))}
          <p className="text-[0.6875rem] text-muted-foreground">
            {hedge.comparable
              ? <>Gap: <b>{inr(hedge.expectancyGap ?? 0, { decimals: 0 })}</b> per trade in favour of {(hedge.expectancyGap ?? 0) >= 0 ? "hedged" : "unhedged"}. </>
              : <>Not enough closed trades on both sides to compare yet. </>}
            {hedge.note}
          </p>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Did rolling help?</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Helped</span><p className="text-lg font-semibold tabular-nums text-profit">{rolls.helped}</p></div>
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Hurt</span><p className="text-lg font-semibold tabular-nums text-loss">{rolls.hurt}</p></div>
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Neutral</span><p className="text-lg font-semibold tabular-nums">{rolls.neutral}</p></div>
          </div>
          {rolls.rescuesThatBackfired > 0 && (
            <p className="rounded-md border border-loss/40 bg-loss/5 px-3 py-2 text-loss">
              {rolls.rescuesThatBackfired} chain(s) turned a first-leg profit into an overall loss.
            </p>)}
          <p className="text-[0.6875rem] text-muted-foreground">
            Compared against what the first leg alone actually booked — a result that was genuinely available, not a model of what the underlying did next. Chains with an open leg are excluded.
          </p>
        </CardContent></Card>
      </div>

      <Eyebrow hint="IV is what you or the broker recorded, never inferred">Volatility and time</Eyebrow>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Selling into rich or cheap IV</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Rank ≥ 50 (richer)</span><p className="text-base font-semibold tabular-nums">{iv.richHalf.expectancy == null ? "—" : inr(iv.richHalf.expectancy, { decimals: 0 })}</p><span className="text-[10px] text-muted-foreground">{iv.richHalf.trades} trades</span></div>
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Rank under 50 (cheaper)</span><p className="text-base font-semibold tabular-nums">{iv.cheapHalf.expectancy == null ? "—" : inr(iv.cheapHalf.expectancy, { decimals: 0 })}</p><span className="text-[10px] text-muted-foreground">{iv.cheapHalf.trades} trades</span></div>
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">
            {!iv.comparable && <>Not enough ranked trades on both sides to compare yet. </>}
            {iv.insufficient.length > 0 && <>Unranked for now: {iv.insufficient.join(", ")}. </>}
            {iv.note}
          </p>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Premium kept per day of risk</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          <p className="text-2xl font-semibold tabular-nums">{theta.medianPerDay == null ? "—" : inr(theta.medianPerDay, { decimals: 0 })}<span className="ml-1 text-xs font-normal text-muted-foreground">median / day</span></p>
          {theta.rows.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-rule py-1">
              <span>{r.symbol} <span className="text-muted-foreground">· {r.daysHeld}d</span></span>
              <span className="tabular-nums">{inr(r.perDay, { decimals: 0 })}/day</span>
            </div>))}
          <p className="text-[0.6875rem] text-muted-foreground">
            Median, not mean — one expiry-day scalp would distort an average badly.
            {theta.undated > 0 && <> {theta.undated} closed trade(s) lacked complete dates and are excluded.</>}
          </p>
        </CardContent></Card>
      </div>

      <Eyebrow hint="the drill-downs above read what you record here">Contract journal</Eyebrow>
      <Card className="p-0"><CardHeader><CardTitle>Contract journal</CardTitle></CardHeader><CardContent className="p-0">
        <OptionsJournalEditor trades={options.map((t) => ({ id: t.id, symbol: t.symbol, tradingsymbol: t.tradingsymbol, entryIv: t.entryIv, exitIv: t.exitIv, entryDte: t.entryDte, hedgeStatus: t.hedgeStatus, expiryOutcome: t.expiryOutcome, adjustmentGroup: t.adjustmentGroup, isOpen: t.isOpen }))} />
        {!options.length && <p className="p-4 text-sm text-muted-foreground">No option trades yet.</p>}
      </CardContent></Card>
      <p className="text-[0.6875rem] text-muted-foreground">Premium capture is descriptive. Return-on-risk uses the recorded risk amount when present; it is not a broker SPAN statement. IV fields are user/broker observations, never silently inferred.</p>
    </ProGate>
      </div>
  </>;
}
