import { RISK_LIST_CAP, CappedNote } from "@/components/ui/capped-note";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CalendarClock, ShieldCheck, PackageCheck } from "lucide-react";
import { inr, inrCompact, fmtDate } from "@/lib/format";
import {
  DEFAULT_SETTLEMENT_RATES,
  type SettlementSummary,
  type SettlementObligation,
  type Warn,
} from "@/lib/analytics/settlement";

const warnBadge: Record<Warn, { variant: "loss" | "warning" | "secondary"; label: string }> = {
  danger: { variant: "loss", label: "Square off" },
  warn: { variant: "warning", label: "Watch" },
  info: { variant: "secondary", label: "Info" },
  none: { variant: "secondary", label: "—" },
};
const warnBorder: Record<Warn, string> = {
  danger: "border-l-loss",
  warn: "border-l-warning",
  info: "border-l-border",
  none: "border-l-border",
};
const kindLabel: Record<SettlementObligation["kind"], string> = {
  stock_future: "Stock fut",
  stock_option: "Stock opt",
  index_cash: "Index · cash",
  commodity: "Commodity",
  not_derivative: "—",
};

/** A rate fraction as the percent WORD the footer prints: 0.0015 → "0.15".
 *  Derived, never written down beside the constant — for five months after the
 *  Finance Act 2026 raised `exerciseSttPct`, the footer went on naming the
 *  repealed rate while the panel computed with the new one (P-1). */
const pctText = (frac: number) => String(Number((frac * 100).toFixed(4)));

function dteChip(dte: number | null) {
  if (dte == null) return <span className="text-muted-foreground">—</span>;
  if (dte < 0) return <Badge variant="secondary">expired</Badge>;
  if (dte === 0) return <Badge variant="loss">today</Badge>;
  const v = dte <= 3 ? "loss" : dte <= 7 ? "warning" : "secondary";
  return <Badge variant={v}>{dte}d</Badge>;
}

function Stat({ label, value, tone, note }: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {/* A total that excluded something must say so on the same tile — a
          silently short total reads as the whole obligation (ruling C-1). */}
      {note ? <div className="mt-0.5 text-[10px] text-warning">{note}</div> : null}
    </div>
  );
}

export function ExpiryObligations({ summary }: { summary: SettlementSummary }) {
  const { obligations } = summary;
  const hasDanger = obligations.some((o) => o.warn === "danger");
  // Positions that WILL settle but whose reference price the book does not
  // know: excluded from both ₹ totals, and said so rather than counted as ₹0.
  const unknownNote =
    summary.unknownNotionalCount > 0 ? `${summary.unknownNotionalCount} unknown` : undefined;
  // The Funds total has a NARROWER base — it sums "Take delivery (buy)" rows
  // only — so its exclusion count is its own (M-2). A give-delivery row with an
  // unknown notional is not something that total left out; it is something it
  // never wanted, and borrowing the other tiles' count printed "Funds to take
  // delivery ₹0 · 1 unknown" over a short future that needs no cash at all.
  const unknownFundsNote =
    summary.unknownFundsCount > 0 ? `${summary.unknownFundsCount} unknown` : undefined;

  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock className="size-4 text-muted-foreground" />
          <CardTitle>Expiry &amp; physical-settlement obligations</CardTitle>
        </div>
        {summary.expiringPhysicalCount > 0 ? (
          <Badge variant={hasDanger ? "loss" : "warning"}>
            {summary.expiringPhysicalCount} expiring ≤ {summary.windowDays}d
          </Badge>
        ) : (
          <Badge variant="secondary">no near-expiry F&amp;O</Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {obligations.length === 0 ? (
          <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-profit" />
            No open F&amp;O positions — nothing can devolve into a physical-settlement obligation.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Physical F&O" value={String(summary.physicalCount)} />
              <Stat
                label="Certain delivery"
                value={String(summary.certainDeliveryCount)}
                tone={summary.certainDeliveryCount > 0 ? "text-warning" : undefined}
              />
              <Stat
                label="Notional at risk"
                value={inrCompact(summary.notionalAtRisk)}
                note={unknownNote}
              />
              <Stat
                label="Funds to take delivery"
                value={inrCompact(summary.fundsNeeded)}
                note={unknownFundsNote}
              />
              {/* Labelled as what the number IS — the STT settlement will
                  levy. "Extra vs squaring off" is only computable for
                  futures; an option's exit STT needs its current premium,
                  which an offline journal does not have. Per-row sttJump
                  still shows the honest delta where it exists. */}
              <Stat
                label="STT on physical settlement"
                value={inrCompact(summary.physicalSttTotal)}
                tone={summary.physicalSttTotal > 0 ? "text-loss" : undefined}
                note={unknownNote}
              />
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-y border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">Instrument</th>
                    <th className="px-2 py-2 font-medium">Expiry</th>
                    <th className="px-2 py-2 font-medium">Position</th>
                    <th className="px-2 py-2 font-medium">Moneyness</th>
                    <th className="px-2 py-2 font-medium">Obligation</th>
                    <th className="px-2 py-2 text-right font-medium">Notional</th>
                    <th className="px-2 py-2 text-right font-medium">STT if held</th>
                    <th className="px-2.5 py-2 font-medium">Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {obligations.slice(0, RISK_LIST_CAP).map((o) => {
                    const wb = warnBadge[o.warn];
                    return (
                      <tr key={o.id} className={`border-b border-rule border-l-2 ${warnBorder[o.warn]}`}>
                        <td className="px-2.5 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-foreground">{o.symbol}</span>
                            <Badge variant={o.physical ? "outline" : "secondary"}>{kindLabel[o.kind]}</Badge>
                          </div>
                          <div className="mt-0.5 truncate text-[10px] text-muted-foreground" title={o.tradingsymbol}>
                            {o.tradingsymbol}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            {dteChip(o.dte)}
                            <span className="text-muted-foreground">{fmtDate(o.expiry)}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 tabular-nums">
                          <span className={o.side === "long" ? "text-profit" : "text-loss"}>
                            {o.side === "long" ? "Long" : "Short"}
                          </span>{" "}
                          {o.netQty}
                          {o.optionType ? (
                            <span className="text-muted-foreground">
                              {" "}
                              · {o.strike} {o.optionType}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-2">
                          {o.kind === "stock_option" ? (
                            o.moneyness === "ITM" ? (
                              <Badge variant="warning">ITM{o.intrinsicPerUnit != null ? ` +${o.intrinsicPerUnit}` : ""}</Badge>
                            ) : o.moneyness === "OTM" ? (
                              <Badge variant="secondary">OTM</Badge>
                            ) : (
                              <Badge variant="outline">spot?</Badge>
                            )
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {o.deliveryAction ? (
                            <div>
                              <div className="flex items-center gap-1 font-medium">
                                <PackageCheck className="size-3 text-muted-foreground" />
                                {o.deliveryAction}
                              </div>
                              <div className="text-[10px] text-muted-foreground">{o.fundsOrShares}</div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">{o.reason}</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {/* An unknown reference price prints "—", never ₹0
                              (ruling C-1, invariant 6). */}
                          {o.settles === "no" || o.notional == null ? "—" : inr(o.notional, { decimals: 0 })}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {o.physicalStt != null ? (
                            <span className="text-loss">{inr(o.physicalStt, { decimals: 0 })}</span>
                          ) : o.settles === "if-ITM" ? (
                            <span className="text-muted-foreground">if ITM</span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2.5 py-2">
                          <span className="inline-flex items-center gap-1">
                            {o.warn === "danger" ? <AlertTriangle className="size-3 text-loss" /> : null}
                            <Badge variant={wb.variant}>{wb.label}</Badge>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <CappedNote total={obligations.length} noun="obligations" />
            </div>

            {/* The rate WORD is derived from the rate the panel computed with
                (P-1). Delivery and futures-exit STT are resolved from
                charge_config by the page (invariant 3); exercise STT has no
                charge_config column and stays a named constant by ruling
                (DECISIONS 2026-08-12), so the copy must not promise it is
                editable. */}
            <p className="text-[0.6875rem] text-muted-foreground">
              Indian single-stock F&amp;O is <strong>physically settled</strong>; index F&amp;O is cash-settled. An ITM
              stock option or any stock future left open at expiry devolves into share delivery and a delivery-STT
              charge on the whole notional, plus exercise STT (
              {`${pctText(DEFAULT_SETTLEMENT_RATES.exerciseSttPct)}% of intrinsic`}) — computed as far more than the
              STT of squaring off. Enter the underlying spot in the bulk-MTM box below to resolve option moneyness;
              otherwise obligations are shown conditionally. Delivery STT and the futures square-off STT are read from
              your charge config; exercise STT is a fixed statutory rate (Finance Act 2026, in force 1 April 2026) and
              is not editable.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
