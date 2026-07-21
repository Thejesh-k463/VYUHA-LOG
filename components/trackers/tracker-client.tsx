"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { Select } from "@/components/ui/select";
import { ExportButtons } from "@/components/ui/export-button";
import { MtmForm } from "./mtm-form";
import type { OpenPosition } from "@/lib/analytics/positions";
import { inr, inrCompact, num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

interface ClosedLite {
  symbol: string; segment: string; broker: string; netPnl: number; grossPnl: number; sellDate: string | null; rMultiple: number | null;
}

export function TrackerClient({
  variant,
  positions,
  closed,
  bucketCapital,
}: {
  variant: "equity" | "active";
  positions: OpenPosition[];
  closed: ClosedLite[];
  bucketCapital: number;
}) {
  const [seg, setSeg] = React.useState("");
  const [funding, setFunding] = React.useState<"" | "user" | "broker">("");
  const data = React.useMemo(() => {
    let list = positions;
    if (seg) list = list.filter((p) => p.segment === seg);
    if (funding === "user") list = list.filter((p) => p.fundedAmount <= 0);
    if (funding === "broker") list = list.filter((p) => p.fundedAmount > 0);
    return list;
  }, [positions, seg, funding]);

  const deployed = positions.reduce((s, p) => s + p.invested, 0);
  const available = bucketCapital - deployed;
  const unrealised = positions.reduce((s, p) => s + p.unrealised, 0);
  const mtfFunded = positions.reduce((s, p) => s + p.fundedAmount, 0);
  const mtfInterest = positions.reduce((s, p) => s + p.accruedInterest, 0);

  // Drill-down inputs for the KPI popups (click any card).
  const sortedByInvested = [...positions].sort((a, b) => b.invested - a.invested);
  const topPosition = sortedByInvested[0] ?? null;
  const oldest = [...positions].sort((a, b) => (b.daysHeld ?? 0) - (a.daysHeld ?? 0))[0] ?? null;
  const byUnrealised = [...positions].sort((a, b) => b.unrealised - a.unrealised);
  const bestPos = byUnrealised[0] ?? null;
  const worstPos = byUnrealised[byUnrealised.length - 1] ?? null;

  const segments = [...new Set(positions.map((p) => p.segment))];
  const segGroups = segments.map((s) => {
    const list = positions.filter((p) => p.segment === s);
    return {
      segment: s as Segment,
      count: list.length,
      invested: list.reduce((a, b) => a + b.invested, 0),
      unrealised: list.reduce((a, b) => a + b.unrealised, 0),
    };
  });

  const columns = React.useMemo<ColumnDef<OpenPosition, unknown>[]>(() => {
    const base: ColumnDef<OpenPosition, unknown>[] = [
      {
        accessorKey: "symbol", header: "Instrument",
        cell: ({ row }) => (
          <div className="min-w-[140px]">
            <div className="font-medium">{row.original.symbol}</div>
            <div className="text-[10px] text-muted-foreground">
              {row.original.optionType ? `${row.original.strike} ${row.original.optionType}` : SEGMENT_LABELS[row.original.segment as Segment]}
            </div>
          </div>
        ),
      },
      { accessorKey: "broker", header: "Broker", cell: ({ getValue }) => <span className="capitalize">{String(getValue())}</span> },
      { accessorKey: "qty", header: "Qty", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
      { accessorKey: "avgPrice", header: "Avg", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 2) },
      { accessorKey: "mtmPrice", header: "MTM", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 2) },
      { accessorKey: "invested", header: "Invested", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
      { accessorKey: "unrealised", header: "Unrealised", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnl(getValue() as number)}>{num(getValue() as number, 0)}</span> },
      { accessorKey: "unrealisedPct", header: "%", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnl(getValue() as number)}>{(getValue() as number).toFixed(2)}%</span> },
    ];
    if (variant === "equity") {
      base.push(
        { accessorKey: "daysHeld", header: "Days", meta: { align: "right" }, cell: ({ getValue }) => (getValue() as number | null) ?? "—" },
        { accessorKey: "ownCapital", header: "Own capital", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number; return v > 0 ? num(v, 0) : "—"; } },
        { accessorKey: "fundedAmount", header: "MTF funded", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number; return v > 0 ? num(v, 0) : "—"; } },
        { accessorKey: "accruedInterest", header: "MTF int.", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number; return v > 0 ? num(v, 0) : "—"; } },
        {
          accessorKey: "roiOnCapitalPct", header: "ROI on capital", meta: { align: "right" },
          cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnl(v)}>{v.toFixed(2)}%</span>; },
        },
        {
          accessorKey: "breakevenPrice", header: "Breakeven", meta: { align: "right" },
          cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : num(v, 2); },
        },
        {
          id: "mtfWarning", header: "",
          cell: ({ row }) => {
            const p = row.original;
            // Matches the reference sheet's flag exactly: interest has eaten
            // your ENTIRE paper gain — a losing position doesn't need this
            // (of course a loss got worse; nothing new to flag).
            if (!p.isMtf || p.unrealised <= 0 || p.accruedInterest < p.unrealised) return null;
            return (
              <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[9px] font-medium text-loss" title="MTF interest has eaten this position's entire unrealised gain">
                ⚠ interest &gt; profit
              </span>
            );
          },
        },
      );
    } else {
      base.push(
        { accessorKey: "expiry", header: "Expiry", cell: ({ getValue }) => (getValue() as string | null) ?? "—" },
        { accessorKey: "dte", header: "DTE", meta: { align: "right" }, cell: ({ getValue }) => (getValue() as number | null) ?? "—" },
      );
    }
    base.push(
      { accessorKey: "rMultiple", header: "Current R", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnl(v)}>{v.toFixed(2)}</span>; } },
      {
        accessorKey: "targetRR", header: "Target R:R", meta: { align: "right" },
        cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : `1:${v.toFixed(2)}`; },
      },
    );
    return base;
  }, [variant]);

  const exportCols = [
    { key: "symbol", label: "Symbol" }, { key: "broker", label: "Broker" },
    { key: "segment", label: "Segment" }, { key: "qty", label: "Qty" },
    { key: "avgPrice", label: "Avg" }, { key: "mtmPrice", label: "MTM" },
    { key: "invested", label: "Invested" }, { key: "unrealised", label: "Unrealised" },
    { key: "daysHeld", label: "Days" }, { key: "dte", label: "DTE" },
    { key: "ownCapital", label: "Own capital" }, { key: "fundedAmount", label: "MTF funded" },
    { key: "accruedInterest", label: "MTF int." }, { key: "roiOnCapitalPct", label: "ROI on capital %" },
    { key: "breakevenPrice", label: "Breakeven" }, { key: "targetRR", label: "Target R:R" },
  ];

  return (
    <div className="space-y-5">
      {/* Capital gauge */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Bucket capital · {inr(bucketCapital, { decimals: 0 })}</span>
            <span className="tabular-nums">
              Deployed <span className="font-medium">{inrCompact(deployed)}</span> · Available{" "}
              <span className={available >= 0 ? "text-profit" : "text-loss"}>{inrCompact(available)}</span>
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-card-hover">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, bucketCapital ? (deployed / bucketCapital) * 100 : 0)}%` }} />
          </div>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Open positions"
          value={positions.length}
          detail={{
            title: "Open positions — the book right now",
            summary: "Every position still running in this bucket.",
            rows: [
              { label: "Positions open", value: `${positions.length}` },
              { label: "Winners / losers", value: `${positions.filter((p) => p.unrealised > 0).length} / ${positions.filter((p) => p.unrealised < 0).length}` },
              { label: "Largest position", value: topPosition ? `${topPosition.symbol} · ${inr(topPosition.invested, { decimals: 0 })}` : "—", hint: topPosition && bucketCapital ? `${((topPosition.invested / bucketCapital) * 100).toFixed(1)}% of bucket capital` : undefined },
              { label: "Oldest holding", value: oldest ? `${oldest.symbol} · ${oldest.daysHeld ?? 0}d` : "—" },
              ...(variant === "equity" ? [{ label: "MTF-funded positions", value: `${positions.filter((p) => p.fundedAmount > 0).length}` }] : []),
            ],
            note: "Concentration is risk: one position dominating the bucket is the most common way a good month becomes a bad one.",
          }}
        />
        <KpiCard
          label="Invested"
          value={inrCompact(deployed)}
          sub={`${bucketCapital ? ((deployed / bucketCapital) * 100).toFixed(0) : 0}% of bucket`}
          detail={{
            title: "Capital deployed in this bucket",
            summary: "How much of the bucket is working, and how much is still dry powder.",
            rows: [
              { label: "Bucket capital", value: inr(bucketCapital, { decimals: 0 }) },
              { label: "Deployed", value: inr(deployed, { decimals: 0 }), hint: `${bucketCapital ? ((deployed / bucketCapital) * 100).toFixed(1) : 0}% utilised` },
              { label: "Available", value: inr(available, { decimals: 0 }), tone: available >= 0 ? "profit" : "loss" },
              { label: "Current value", value: inr(deployed + unrealised, { decimals: 0 }) },
              ...(variant === "equity" ? [{ label: "Own capital in MTF", value: inr(positions.reduce((s, p) => s + p.ownCapital, 0), { decimals: 0 }), hint: "your money; the rest is broker-funded" }] : []),
            ],
            note: "Capital is editable in Settings — every risk %, target and allocation recomputes from it.",
          }}
        />
        <KpiCard
          label="Unrealised P&L"
          value={inr(unrealised, { decimals: 0 })}
          valueClassName={pnl(unrealised)}
          detail={{
            title: "Unrealised P&L — paper money",
            summary: "Marked against your latest MTM prices, not live quotes.",
            rows: [
              { label: "Unrealised P&L", value: inr(unrealised, { decimals: 0 }), tone: unrealised >= 0 ? "profit" : "loss" },
              { label: "On invested", value: deployed ? `${((unrealised / deployed) * 100).toFixed(2)}%` : "—" },
              { label: "Best position", value: bestPos ? `${bestPos.symbol} · ${inr(bestPos.unrealised, { decimals: 0 })}` : "—", tone: "profit" },
              { label: "Worst position", value: worstPos ? `${worstPos.symbol} · ${inr(worstPos.unrealised, { decimals: 0 })}` : "—", tone: "loss" },
              ...(variant === "equity" ? [{ label: "Less accrued MTF interest", value: `−${inr(mtfInterest, { decimals: 0 })}`, tone: "loss" as const, hint: "financing cost already booked against these positions" }] : []),
            ],
            note: "Nothing here is realised until you close. Update MTM prices below to keep it honest.",
          }}
        />
        {variant === "equity" ? (
          <KpiCard
            label="MTF funded"
            value={inrCompact(mtfFunded)}
            sub={`Accrued int. ${inrCompact(mtfInterest)}`}
            valueClassName="text-warning"
            detail={{
              title: "MTF — what the broker is funding",
              summary: "Interest accrues only on the broker-funded portion, never on your own capital.",
              rows: [
                { label: "Broker-funded", value: inr(mtfFunded, { decimals: 0 }), tone: "loss" },
                { label: "Your own capital", value: inr(positions.reduce((s, p) => s + p.ownCapital, 0), { decimals: 0 }) },
                { label: "Effective leverage", value: (() => { const own = positions.reduce((s, p) => s + p.ownCapital, 0); return own > 0 ? `${((own + mtfFunded) / own).toFixed(2)}×` : "—"; })() },
                { label: "Interest accrued so far", value: `−${inr(mtfInterest, { decimals: 0 })}`, tone: "loss" },
                { label: "Interest vs unrealised gain", value: unrealised > 0 ? `${((mtfInterest / unrealised) * 100).toFixed(1)}%` : "—", hint: mtfInterest > 0 && unrealised > 0 && mtfInterest >= unrealised ? "interest has eaten the entire paper gain" : "share of your paper gain already spent on financing" },
              ],
              note: "MTF interest compounds daily whether the position moves or not — time is a cost here, not a free option.",
            }}
          />
        ) : (
          <KpiCard label="Segments live" value={segments.length} sub={segments.map((s) => SEGMENT_LABELS[s as Segment]).slice(0, 2).join(", ")} />
        )}
      </section>

      {/* Per-segment mini cards (active) */}
      {variant === "active" && segGroups.length > 0 && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {segGroups.map((g) => (
            <Card key={g.segment} className="p-3">
              <div className="text-[11px] font-medium text-muted-foreground">{SEGMENT_LABELS[g.segment]}</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-lg font-semibold tabular-nums">{g.count}</span>
                <span className={`text-xs tabular-nums ${pnl(g.unrealised)}`}>{inrCompact(g.unrealised)}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">{inrCompact(g.invested)} invested</div>
            </Card>
          ))}
        </section>
      )}

      {/* MTM entry */}
      <Card>
        <CardHeader><CardTitle>Update MTM (manual / EOD)</CardTitle></CardHeader>
        <CardContent><MtmForm /></CardContent>
      </Card>

      {/* Positions table */}
      <Card className="p-0">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Open positions</span>
            <Select value={seg} onChange={(e) => setSeg(e.target.value)} className="h-7 w-40 text-xs">
              <option value="">All segments</option>
              {segments.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s as Segment]}</option>)}
            </Select>
            {variant === "equity" && (
              <Select value={funding} onChange={(e) => setFunding(e.target.value as "" | "user" | "broker")} className="h-7 w-44 text-xs">
                <option value="">All funding</option>
                <option value="user">User-funded only</option>
                <option value="broker">Broker-funded (MTF)</option>
              </Select>
            )}
          </div>
          <ExportButtons filename={`vyuha-${variant}-positions`} columns={exportCols} rows={data} />
        </div>
        <DataTable columns={columns} data={data} maxHeight="460px" emptyMessage="No open positions. Import or add trades, then set MTM prices." />
      </Card>

      {/* Recent closed */}
      <Card>
        <CardHeader><CardTitle>Recent closed ({closed.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="max-h-[320px] overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Symbol</th>
                  <th className="px-2 py-1.5 font-medium">Segment</th>
                  <th className="px-2 py-1.5 text-right font-medium">Net</th>
                  <th className="px-2 py-1.5 text-right font-medium">R</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((c, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="px-2 py-1 text-muted-foreground">{c.sellDate ?? "—"}</td>
                    <td className="px-2 py-1 font-medium">{c.symbol}</td>
                    <td className="px-2 py-1 text-muted-foreground">{SEGMENT_LABELS[c.segment as Segment]}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pnl(c.netPnl)}`}>{num(c.netPnl, 0)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.rMultiple == null ? "—" : c.rMultiple.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
