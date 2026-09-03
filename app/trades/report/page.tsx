import { todayIstIso } from "@/lib/domain/trading-day";
import { PrintButton } from "@/components/reports/print-button";
import { ProGate } from "@/components/system/pro-gate";
import { VyuhaMark } from "@/components/brand/mark";
import { Badge } from "@/components/ui/badge";
import { getTrades } from "@/lib/queries/trades";
import { inr } from "@/lib/format";
import { SEGMENT_LABELS, BROKER_LABELS, type Segment } from "@/lib/domain/constants";

export const dynamic = "force-dynamic";

/**
 * Print-ready report of SELECTED trades — reached from the Trades tab's
 * selection toolbar. Ctrl+P → "Save as PDF" ships it, same mechanism as the
 * monthly report.
 *
 * The ids in the URL are a FILTER over the account-scoped journal, never a
 * fetch list: everything renders through getTrades(), so an id from another
 * account (or a guessed one) simply doesn't match. The header says exactly
 * what the report is — a hand-picked selection, not the book — so a partial
 * export can't masquerade as a full statement.
 */
export default async function SelectedTradesReport({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids: idsRaw } = await searchParams;
  const wanted = new Set(
    (idsRaw ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  const rows = getTrades().filter((t) => wanted.has(t.id));

  const closed = rows.filter((t) => !t.isOpen);
  const net = rows.reduce((s, t) => s + t.netPnl, 0);
  const gross = rows.reduce((s, t) => s + t.grossPnl, 0);
  const charges = rows.reduce((s, t) => s + t.chargesTotal, 0);
  const mtfInt = rows.reduce((s, t) => s + (t.mtfInterest ?? 0), 0);
  const wins = closed.filter((t) => t.netPnl > 0).length;

  const pnlCls = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "");
  const dt = todayIstIso();

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6 print:max-w-none print:p-2">
      <ProGate>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <VyuhaMark size={30} />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-wide">VYUHA — Selected trades</div>
            <div className="text-[0.6875rem] text-muted-foreground">
              {rows.length} trade{rows.length === 1 ? "" : "s"} ({closed.length} closed, {rows.length - closed.length} open) · generated {dt} ·
              hand-picked selection, not the full journal
            </div>
          </div>
        </div>
        <PrintButton />
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to report — the selected trades were not found in this account&apos;s journal.
        </p>
      ) : (
        <>
          {/* Selection totals */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 print:grid-cols-5">
            {[
              { label: "Net P&L", value: inr(net, { decimals: 0 }), cls: pnlCls(net) },
              { label: "Gross P&L", value: inr(gross, { decimals: 0 }), cls: pnlCls(gross) },
              { label: "Charges", value: inr(charges, { decimals: 0 }), cls: "" },
              { label: "MTF interest", value: mtfInt > 0 ? inr(mtfInt, { decimals: 0 }) : "—", cls: "" },
              { label: "Win rate (closed)", value: closed.length ? `${Math.round((wins / closed.length) * 100)}%` : "—", cls: "" },
            ].map((k) => (
              <div key={k.label} className="rounded-md border border-border p-2.5">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k.label}</div>
                <div className={`mt-0.5 font-mono text-sm tabular-nums ${k.cls}`}>{k.value}</div>
              </div>
            ))}
          </div>

          {/* One card per trade — full detail, page-break aware */}
          <div className="space-y-3">
            {rows.map((t) => (
              <div key={t.id} className="rounded-md border border-border p-3 print:break-inside-avoid">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold">{t.symbol}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">{t.tradingsymbol}</span>
                    <Badge variant="outline">{SEGMENT_LABELS[t.segment as Segment] ?? t.segment}</Badge>
                    <Badge variant="secondary">{BROKER_LABELS[t.broker as never] ?? t.broker}</Badge>
                    {t.isOpen && <Badge variant="warning">OPEN</Badge>}
                  </div>
                  <div className={`font-mono text-sm tabular-nums ${pnlCls(t.netPnl)}`}>
                    {inr(t.netPnl, { decimals: 0 })}
                    {t.rMultiple != null && <span className="ml-1.5 text-[0.6875rem]">{t.rMultiple.toFixed(2)}R</span>}
                  </div>
                </div>

                <table className="mt-2 w-full text-[0.6875rem]">
                  <tbody>
                    <tr className="text-muted-foreground">
                      <td className="py-0.5 pr-3">Buy</td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">
                        {t.buyQty > 0 ? `${t.buyQty} @ ${t.avgBuyPrice}` : "—"}
                      </td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">{t.buyDate ?? "no date"}</td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">{inr(t.buyValue, { decimals: 0 })}</td>
                      <td className="py-0.5 pr-3">Sell</td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">
                        {t.sellQty > 0 ? `${t.sellQty} @ ${t.avgSellPrice}` : "—"}
                      </td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">{t.sellDate ?? "no date"}</td>
                      <td className="py-0.5 text-right font-mono tabular-nums">{inr(t.sellValue, { decimals: 0 })}</td>
                    </tr>
                    <tr className="text-muted-foreground">
                      <td className="py-0.5 pr-3">Gross</td>
                      <td className={`py-0.5 pr-3 text-right font-mono tabular-nums ${pnlCls(t.grossPnl)}`}>{inr(t.grossPnl, { decimals: 0 })}</td>
                      <td className="py-0.5 pr-3 text-right">Charges</td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">{inr(t.chargesTotal, { decimals: 0 })}</td>
                      <td className="py-0.5 pr-3">MTF int.</td>
                      <td className="py-0.5 pr-3 text-right font-mono tabular-nums">
                        {t.mtfInterest && t.mtfInterest > 0 ? inr(t.mtfInterest, { decimals: 0 }) : "—"}
                      </td>
                      <td className="py-0.5 pr-3 text-right">SL / target</td>
                      <td className="py-0.5 text-right font-mono tabular-nums">
                        {t.slPlanned ?? "—"} / {t.targetPlanned ?? "—"}
                      </td>
                    </tr>
                  </tbody>
                </table>

                {(t.setupTag || t.notes) && (
                  <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
                    {t.setupTag && <span className="mr-2 text-foreground">[{t.setupTag}]</span>}
                    {t.notes}
                  </p>
                )}
              </div>
            ))}
          </div>

          <p className="text-[10px] text-muted-foreground">
            Self-reported journal data exported from Vyuha (offline; nothing verified with a broker or exchange).
            Charges are computed per broker × segment × exchange from the app&apos;s rate tables.
          </p>
        </>
      )}
      </ProGate>
    </div>
  );
}
