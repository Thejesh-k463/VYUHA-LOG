"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { Badge } from "@/components/ui/badge";
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
  const data = React.useMemo(() => (seg ? positions.filter((p) => p.segment === seg) : positions), [positions, seg]);

  const deployed = positions.reduce((s, p) => s + p.invested, 0);
  const available = bucketCapital - deployed;
  const unrealised = positions.reduce((s, p) => s + p.unrealised, 0);
  const mtfFunded = positions.reduce((s, p) => s + p.fundedAmount, 0);
  const mtfInterest = positions.reduce((s, p) => s + p.accruedInterest, 0);

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
    base.push({ accessorKey: "rMultiple", header: "R", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnl(v)}>{v.toFixed(2)}</span>; } });
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
    { key: "breakevenPrice", label: "Breakeven" },
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
        <KpiCard label="Open positions" value={positions.length} />
        <KpiCard label="Invested" value={inrCompact(deployed)} sub={`${bucketCapital ? ((deployed / bucketCapital) * 100).toFixed(0) : 0}% of bucket`} />
        <KpiCard label="Unrealised P&L" value={inr(unrealised, { decimals: 0 })} valueClassName={pnl(unrealised)} />
        {variant === "equity" ? (
          <KpiCard label="MTF funded" value={inrCompact(mtfFunded)} sub={`Accrued int. ${inrCompact(mtfInterest)}`} valueClassName="text-warning" />
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
