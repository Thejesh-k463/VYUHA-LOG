import { ReportTable, ReportTd, ReportTh, ReportThead, ReportTr } from "@/components/ui/report-table";
import { ProLock } from "@/components/system/pro-lock";
import { EmptyState } from "@/components/ui/empty-state";
import { inr, num } from "@/lib/format";
import { ADHERENCE_LABELS, ADHERENCE_TOL_PCT, type SignalAnalytics, type SignalTradeRow } from "@/lib/analytics/signal-book";
import { rProvenanceLine } from "@/lib/analytics/win-loss";

/**
 * THE SIGNAL BOOK tab (v4.3.0) — every option trade that recorded the signal it
 * was taken on, and what those signals add up to.
 *
 * ── WHAT IS FREE AND WHAT IS NOT ────────────────────────────────────────────
 *
 * The TABLE is the user's own record of their own trades and is never gated
 * (invariant 7). The three analytics blocks are the Pro capability, and they are
 * withheld SERVER-SIDE before the payload (`withholdSignalAnalytics`) — `analytics`
 * simply arrives null on a free build, so there is nothing behind the lock to find.
 *
 * ── "—" IS NOT A ZERO ───────────────────────────────────────────────────────
 *
 * Every unrecorded cell renders "—" (invariant 6). Lots need a recorded lot
 * size, and R needs a recorded SL; neither is invented from a default.
 *
 * TABLES ONLY. No chart library is imported here, by ruling — and
 * `tests/signal-book-page.test.ts` pins that.
 */

const DASH = "—";
const n2 = (x: number | null, d = 2) => (x == null ? DASH : num(x, d));
const pctCell = (x: number | null) => (x == null ? DASH : `${num(x, 2)}%`);

const STATUS_LABELS: Record<string, string> = {
  T1_HIT: "T1 hit",
  T2_HIT: "T2 hit",
  SL_HIT: "SL hit",
  EOD_PROFIT: "EOD profit",
  EOD_LOSS: "EOD loss",
};

/** The day's WHOLE range, not the range since entry — said wherever it is used. */
const DAY_RANGE_CAVEAT =
  "Day high and day low are the whole session's range for the contract, not the range since entry — a level the day reached may have been reached before the position existed.";

export function SignalBook({ rows, analytics }: { rows: SignalTradeRow[]; analytics: SignalAnalytics | null }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        variant="journal"
        title="No signals recorded yet"
        hint="Add or edit an OPTION trade and open its Signal section to record the model, the zone, the OI figures and the T1/T2/SL ladder it was taken on. Everything on this tab is built from what you record there."
      />
    );
  }

  return (
    <div className="space-y-5">
      <ReportTable minWidth={1500}>
        <ReportThead>
          <ReportTh>Model</ReportTh>
          <ReportTh>CE/PE</ReportTh>
          <ReportTh>Contract</ReportTh>
          <ReportTh align="right">Spot</ReportTh>
          <ReportTh align="right">S/R zone</ReportTh>
          <ReportTh align="right">Dist %</ReportTh>
          <ReportTh align="right">Moneyness %</ReportTh>
          <ReportTh align="right">Strike OI</ReportTh>
          <ReportTh align="right">ΔOI %</ReportTh>
          <ReportTh align="right">OI value ₹Cr</ReportTh>
          <ReportTh align="right">Score</ReportTh>
          <ReportTh align="right">T1 / T2 / SL</ReportTh>
          <ReportTh>Exit</ReportTh>
          <ReportTh align="right">Lots</ReportTh>
          <ReportTh align="right">Net P&amp;L</ReportTh>
        </ReportThead>
        <tbody>
          {rows.map((t) => {
            const s = t.signal;
            // Lots are RECORDED, never a sizing rule (owner ruling): without a
            // stored lot size the quantity does not state a lot count.
            const lots = t.lotSize && t.lotSize > 0 ? Math.max(t.buyQty, t.sellQty) / t.lotSize : null;
            return (
              <ReportTr key={t.id}>
                <ReportTd>{s.model ?? DASH}</ReportTd>
                <ReportTd>{t.optionType ?? DASH}</ReportTd>
                <ReportTd className="max-w-[16rem] truncate" title={t.tradingsymbol}>
                  {t.symbol}
                  {t.strike != null ? ` ${num(t.strike, 0)}` : ""}
                </ReportTd>
                <ReportTd align="right">{n2(s.spot)}</ReportTd>
                <ReportTd align="right">{s.zoneLow == null && s.zoneHigh == null ? DASH : `${n2(s.zoneLow)}–${n2(s.zoneHigh)}`}</ReportTd>
                <ReportTd align="right">{pctCell(s.distPct)}</ReportTd>
                <ReportTd align="right">{pctCell(s.moneynessPct)}</ReportTd>
                <ReportTd align="right">{n2(s.strikeOi, 0)}</ReportTd>
                <ReportTd align="right">{pctCell(s.oiChgPct)}</ReportTd>
                <ReportTd align="right">{n2(s.oiValueCr)}</ReportTd>
                <ReportTd align="right">{n2(s.score)}</ReportTd>
                <ReportTd align="right">{`${n2(s.t1)} / ${n2(s.t2)} / ${n2(s.sl)}`}</ReportTd>
                <ReportTd>{s.exitStatus ? STATUS_LABELS[s.exitStatus] : DASH}</ReportTd>
                <ReportTd align="right">{lots == null ? DASH : num(lots, 0)}</ReportTd>
                <ReportTd align="right" className={t.netPnl >= 0 ? "text-profit" : "text-loss"}>
                  {inr(t.netPnl)}
                </ReportTd>
              </ReportTr>
            );
          })}
        </tbody>
      </ReportTable>

      {analytics ? <Blocks a={analytics} /> : <Locked />}
    </div>
  );
}

function Locked() {
  return (
    <section className="rounded-md border border-dashed border-border p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        Rule adherence, edge and ladder <ProLock />
      </h3>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Your signals and every figure in the table above are yours and stay free. With Pro this tab also reads them back:
        how often each exit matched the level it claims, the edge by model, direction and exit, and how often the day&apos;s
        recorded range reached T1, T2 or the SL you recorded.
      </p>
    </section>
  );
}

function Blocks({ a }: { a: SignalAnalytics }) {
  const { adherence, edge, ladder } = a;
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <Head
          title="Rule adherence"
          note={`Judged against each trade's OWN recorded levels, within ${ADHERENCE_TOL_PCT}% of the level or ₹0.05, whichever is larger. ${DAY_RANGE_CAVEAT}`}
        />
        <p className="text-xs text-muted-foreground">
          {adherence.judged} judged · {adherence.notJudgeable} not judgeable
          {adherence.excludedShort > 0 ? ` · ${adherence.excludedShort} short, excluded` : ""} ·{" "}
          <span className="text-foreground">
            {adherence.deviating.n} deviated ({inr(adherence.deviating.netPnl)})
          </span>
        </p>
        {adherence.byCode.length === 0 ? (
          <p className="text-xs text-muted-foreground">No deviation was found in what these trades recorded.</p>
        ) : (
          <ReportTable>
            <ReportThead>
              <ReportTh>What happened</ReportTh>
              <ReportTh align="right">Trades</ReportTh>
              <ReportTh align="right">Net P&amp;L</ReportTh>
            </ReportThead>
            <tbody>
              {adherence.byCode.map((c) => (
                <ReportTr key={c.code}>
                  <ReportTd>{ADHERENCE_LABELS[c.code]}</ReportTd>
                  <ReportTd align="right">{c.n}</ReportTd>
                  <ReportTd align="right">{inr(c.netPnl)}</ReportTd>
                </ReportTr>
              ))}
            </tbody>
          </ReportTable>
        )}
      </section>

      <section className="space-y-2">
        <Head
          title="Edge by model, direction and exit"
          note="“—” is a group that has not been labelled yet, never a bucket called other."
        />
        <ReportTable>
          <ReportThead>
            <ReportTh>Model</ReportTh>
            <ReportTh>CE/PE</ReportTh>
            <ReportTh>Exit</ReportTh>
            <ReportTh align="right">Trades</ReportTh>
            <ReportTh align="right">Win rate</ReportTh>
            <ReportTh align="right">Expectancy</ReportTh>
            {/* NEVER just "R": this is R on the SIGNAL's stop, not the stored
                rMultiple (which divides by the trade's riskAmount). */}
            <ReportTh align="right">R on signal SL</ReportTh>
          </ReportThead>
          <tbody>
            {edge.map((g) => (
              <ReportTr key={g.key}>
                <ReportTd>{g.model}</ReportTd>
                <ReportTd>{g.optionType}</ReportTd>
                <ReportTd>{g.exitStatus === "—" ? DASH : STATUS_LABELS[g.exitStatus] ?? g.exitStatus}</ReportTd>
                <ReportTd align="right">{g.n}</ReportTd>
                <ReportTd align="right">{num(g.winRate * 100, 1)}%</ReportTd>
                <ReportTd align="right">{inr(g.expectancy)}</ReportTd>
                <ReportTd align="right">
                  {g.avgR == null ? DASH : `${num(g.avgR, 2)} (${g.rN} of ${g.n})`}
                  {/* v4.4.0 D2 — this R divides by the SIGNAL's own SL, never by the
                      stored riskAmount, so every one of them is plan-derived by
                      construction and none is a cap unit. Same wording helper as
                      every other Avg R surface, so the claim is comparable. */}
                  <div className="text-[9px] font-normal text-muted-foreground">
                    {rProvenanceLine({ plan: g.rN, typed: 0, cap: 0, unknown: 0, noR: g.n - g.rN })}
                  </div>
                </ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
      </section>

      <section className="space-y-2">
        <Head title="Ladder — what the day's recorded range reached" note={DAY_RANGE_CAVEAT} />
        <p className="text-xs text-muted-foreground">
          {ladder.eligible} of {ladder.total} closed long signal trades recorded a day range that contains their entry
          {ladder.excludedShort > 0 ? `, and ${ladder.excludedShort} short trade${ladder.excludedShort === 1 ? " is" : "s are"} excluded` : ""}.
        </p>
        <ReportTable>
          <ReportThead>
            <ReportTh>Level</ReportTh>
            <ReportTh align="right">Reached</ReportTh>
            <ReportTh align="right">Mean MFE</ReportTh>
            <ReportTh align="right">Mean MAE</ReportTh>
          </ReportThead>
          <tbody>
            {([["T1", ladder.reachT1], ["T2", ladder.reachT2], ["SL touched", ladder.touchSl]] as const).map(([label, v], i) => (
              <ReportTr key={label}>
                <ReportTd>{label}</ReportTd>
                <ReportTd align="right">{v.of === 0 ? DASH : `${v.n} of ${v.of}`}</ReportTd>
                <ReportTd align="right">{i === 0 ? (ladder.mfePct == null ? DASH : `${num(ladder.mfePct * 100, 1)}%`) : ""}</ReportTd>
                <ReportTd align="right">{i === 0 ? (ladder.maePct == null ? DASH : `${num(ladder.maePct * 100, 1)}%`) : ""}</ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
      </section>
    </div>
  );
}

function Head({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  );
}
