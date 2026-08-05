import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { OptionsJournalEditor } from "@/components/behavior/options-journal-editor";
import { optionsSellerReport } from "@/lib/analytics/options-seller";
import { dteReport, hedgeReport, rollReport, ivRankReport, thetaEfficiency } from "@/lib/analytics/options-seller-depth";
import { inr } from "@/lib/format";
import { getTrades } from "@/lib/queries/trades";

export const dynamic = "force-dynamic";

export default function OptionsJournalPage() {
  const options = getTrades().filter((t) => t.instrumentType === "option");
  const seller = optionsSellerReport(options);
  // Round two: the questions a seller actually changes behaviour over.
  const dte = dteReport(options);
  const hedge = hedgeReport(options);
  const rolls = rollReport(options);
  const iv = ivRankReport(options);
  const theta = thetaEfficiency(options);
  return <>
    <PageHeader title="Options Seller Journal" description="Premium capture, IV change, hedge state, DTE, adjustments and expiry outcomes." />
    <div className="space-y-5 p-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard label="Seller trades" value={String(seller.count)} />
        <KpiCard label="Net P&L" value={inr(seller.netPnl)} />
        <KpiCard label="Premium captured" value={seller.capturePct == null ? "—" : `${seller.capturePct}%`} />
        <KpiCard label="Fully hedged" value={seller.hedgedPct == null ? "—" : `${seller.hedgedPct}%`} />
      </div>
      <Card><CardHeader><CardTitle>Outcome mix</CardTitle></CardHeader><CardContent className="flex flex-wrap gap-2">
        {Object.entries(seller.outcomes).map(([k, v]) => <div key={k} className="rounded-md border border-border px-3 py-2 text-xs"><span className="text-muted-foreground">{k.replaceAll("_", " ")}</span><p className="text-lg font-semibold tabular-nums">{v}</p></div>)}
      </CardContent></Card>
      {/* Round two: DTE band, hedging, rolls, IV rank, theta efficiency. */}
      <Card><CardHeader><CardTitle>Where the edge is — by days to expiry</CardTitle></CardHeader><CardContent className="space-y-2">
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
            <tr key={b.label} className="border-b border-border/40">
              <td className="py-1.5 pr-3">{b.label}{!b.trustworthy && b.trades > 0 && <span className="ml-1.5 text-[10px] text-warning">small sample</span>}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.trades}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.trades ? inr(b.net, { decimals: 0 }) : "—"}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.expectancy == null ? "—" : inr(b.expectancy, { decimals: 0 })}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.winRate == null ? "—" : `${b.winRate}%`}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{b.capturePct == null ? "—" : `${b.capturePct}%`}</td>
            </tr>))}</tbody>
        </table></div>
        <p className="text-[11px] text-muted-foreground">
          {dte.best ? <>Strongest band so far: <b>{dte.best}</b>{dte.worst ? <> · weakest: <b>{dte.worst}</b></> : null}. </> : <>No band yet carries enough closed trades to rank. </>}
          {dte.unknownDte > 0 && <>{dte.unknownDte} closed trade(s) had no entry DTE recorded and are excluded rather than guessed.</>}
        </p>
      </CardContent></Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Does hedging pay?</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          {[hedge.hedged, hedge.unhedged].map((a) => (
            <div key={a.label} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <span>{a.label} <span className="text-muted-foreground">({a.trades} closed)</span></span>
              <span className="tabular-nums">{a.expectancy == null ? "—" : `${inr(a.expectancy, { decimals: 0 })} / trade`}</span>
            </div>))}
          <p className="text-[11px] text-muted-foreground">
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
          <p className="text-[11px] text-muted-foreground">
            Compared against what the first leg alone actually booked — a result that was genuinely available, not a model of what the underlying did next. Chains with an open leg are excluded.
          </p>
        </CardContent></Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Selling into rich or cheap IV</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Rank ≥ 50 (richer)</span><p className="text-base font-semibold tabular-nums">{iv.richHalf.expectancy == null ? "—" : inr(iv.richHalf.expectancy, { decimals: 0 })}</p><span className="text-[10px] text-muted-foreground">{iv.richHalf.trades} trades</span></div>
            <div className="rounded-md border border-border px-3 py-2"><span className="text-muted-foreground">Rank under 50 (cheaper)</span><p className="text-base font-semibold tabular-nums">{iv.cheapHalf.expectancy == null ? "—" : inr(iv.cheapHalf.expectancy, { decimals: 0 })}</p><span className="text-[10px] text-muted-foreground">{iv.cheapHalf.trades} trades</span></div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {!iv.comparable && <>Not enough ranked trades on both sides to compare yet. </>}
            {iv.insufficient.length > 0 && <>Unranked for now: {iv.insufficient.join(", ")}. </>}
            {iv.note}
          </p>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Premium kept per day of risk</CardTitle></CardHeader><CardContent className="space-y-2 text-xs">
          <p className="text-2xl font-semibold tabular-nums">{theta.medianPerDay == null ? "—" : inr(theta.medianPerDay, { decimals: 0 })}<span className="ml-1 text-xs font-normal text-muted-foreground">median / day</span></p>
          {theta.rows.slice(0, 5).map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-border/40 py-1">
              <span>{r.symbol} <span className="text-muted-foreground">· {r.daysHeld}d</span></span>
              <span className="tabular-nums">{inr(r.perDay, { decimals: 0 })}/day</span>
            </div>))}
          <p className="text-[11px] text-muted-foreground">
            Median, not mean — one expiry-day scalp would distort an average badly.
            {theta.undated > 0 && <> {theta.undated} closed trade(s) lacked complete dates and are excluded.</>}
          </p>
        </CardContent></Card>
      </div>

      <Card className="p-0"><CardHeader><CardTitle>Contract journal</CardTitle></CardHeader><CardContent className="p-0">
        <OptionsJournalEditor trades={options.map((t) => ({ id: t.id, symbol: t.symbol, tradingsymbol: t.tradingsymbol, entryIv: t.entryIv, exitIv: t.exitIv, entryDte: t.entryDte, hedgeStatus: t.hedgeStatus, expiryOutcome: t.expiryOutcome, adjustmentGroup: t.adjustmentGroup, isOpen: t.isOpen }))} />
        {!options.length && <p className="p-4 text-sm text-muted-foreground">No option trades yet.</p>}
      </CardContent></Card>
      <p className="text-[11px] text-muted-foreground">Premium capture is descriptive. Return-on-risk uses the recorded risk amount when present; it is not a broker SPAN statement. IV fields are user/broker observations, never silently inferred.</p>
    </div>
  </>;
}
