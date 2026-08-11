"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/format";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

export interface FmvRow {
  id: number;
  symbol: string;
  buyDate: string;
  sellDate: string | null;
  buyQty: number;
  avgBuyPrice: number;
  fmv31Jan2018: number | null;
}

/** Per-lot FMV @ 31-Jan-2018 entry for LTCG grandfathering (pre-2018 closed equity lots). */
export function FmvEditor({ rows }: { rows: FmvRow[] }) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<number, string>>(
    Object.fromEntries(rows.map((r) => [r.id, r.fmv31Jan2018 == null ? "" : String(r.fmv31Jan2018)])),
  );
  const [busy, setBusy] = React.useState<number | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function save(id: number) {
    setBusy(id);
    setMsg(null);
    const res = await fetch("/api/trades/fmv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fmv: values[id] ?? "" }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setBusy(null);
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Enter the scrip&apos;s <b>closing price on 31-Jan-2018</b> (per share). Grandfathered cost = higher of your
        actual cost or this FMV (capped at the sale price) — it only ever lowers the taxable LTCG. Leave blank to
        use actual cost.
      </p>
      <ReportTable>
        <ReportThead>
          <ReportTh>Symbol</ReportTh>
          <ReportTh align="right">Bought</ReportTh>
          <ReportTh align="right">Qty</ReportTh>
          <ReportTh align="right">Avg cost</ReportTh>
          <ReportTh align="right">FMV @ 31-Jan-2018 (₹/sh)</ReportTh>
          <ReportTh></ReportTh>
        </ReportThead>
        <tbody>
          {rows.map((r) => (
            <ReportTr key={r.id}>
              <ReportTd className="font-medium">{r.symbol}</ReportTd>
              <ReportTd align="right">{r.buyDate}</ReportTd>
              <ReportTd align="right">{num(r.buyQty, 0)}</ReportTd>
              <ReportTd align="right">{num(r.avgBuyPrice, 2)}</ReportTd>
              <ReportTd className="text-right">
                <Input
                  type="number"
                  step="any"
                  value={values[r.id] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [r.id]: e.target.value }))}
                  placeholder="blank = actual cost"
                  className="h-7 w-36 text-right tabular-nums"
                />
              </ReportTd>
              <ReportTd className="text-right">
                <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => save(r.id)}>
                  {busy === r.id ? "Saving…" : "Save"}
                </Button>
              </ReportTd>
            </ReportTr>
          ))}
        </tbody>
      </ReportTable>
      {msg && (
        <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
          {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
          {msg.text}
        </span>
      )}
    </div>
  );
}
