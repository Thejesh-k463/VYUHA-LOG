"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { num } from "@/lib/format";
import { CheckCircle2, AlertCircle } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { fmvIsMixed, type FmvGroup } from "@/lib/analytics/grandfather-groups";

/**
 * FMV @ 31-Jan-2018 entry for LTCG grandfathering — ONE row per scrip
 * (symbol + ISIN, `grandfatherKey`), v4.6.0 W7 (D3). The FMV is a fact about
 * the scrip, so one Save writes it onto every lot of the group
 * (`POST /api/trades/fmv { ids, fmv, person }`); the lots are listed under a
 * native <details>.
 *
 * The shown value is DERIVED — `edits[g.key] ?? initial(g)` — never a state
 * initialised once from `groups`: router.refresh() keeps client state, so an
 * init-once copy would go stale, and the page keys this editor by person so
 * one person's typed value never lands on another person's same-scrip group.
 * A MIXED group with a blank input cannot Save: a blank Save clears the whole
 * group, and it must never wipe values that exist.
 */
const initial = (g: FmvGroup): string => (typeof g.fmv === "number" ? String(g.fmv) : "");

export function FmvEditor({ groups, person }: { groups: FmvGroup[]; person?: string }) {
  const router = useRouter();
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const shown = (g: FmvGroup): string => edits[g.key] ?? initial(g);
  // The route refuses the same thing with the same test (`fmvIsMixed`), so a
  // disabled button here is never the only guard.
  const blankOverMixed = (g: FmvGroup): boolean => fmvIsMixed(g.lots) && shown(g).trim() === "";

  async function save(g: FmvGroup) {
    if (blankOverMixed(g)) return;
    setBusy(g.key);
    setMsg(null);
    const res = await fetch("/api/trades/fmv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: g.ids, fmv: shown(g), ...(person ? { person } : {}) }),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setBusy(null);
    setMsg({ ok: !!data.ok, text: `${g.symbol}: ${data.message ?? ""}` });
    if (data.ok) router.refresh();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Enter the scrip&apos;s <b>highest price quoted on 31-Jan-2018</b> (per share — s.55(2)(ac)) — once per scrip; it applies to every
        pre-2018 lot of it. Grandfathered cost = higher of your actual cost or this FMV (capped at the sale price) — it
        only ever lowers the taxable LTCG. Leave blank to use actual cost.
      </p>
      <ReportTable>
        <ReportThead>
          <ReportTh>Symbol</ReportTh>
          <ReportTh>ISIN</ReportTh>
          <ReportTh align="right">Lots</ReportTh>
          <ReportTh align="right">Total qty</ReportTh>
          <ReportTh align="right">Bought</ReportTh>
          <ReportTh align="right">FMV @ 31-Jan-2018 (₹/sh)</ReportTh>
          <ReportTh></ReportTh>
        </ReportThead>
        <tbody>
          {groups.map((g) => (
            <ReportTr key={g.key}>
              <ReportTd className="align-top font-medium">
                {g.symbol}
                <details className="mt-1 text-xs font-normal text-muted-foreground">
                  <summary className="cursor-pointer">{g.lots.length === 1 ? "the lot" : `the ${g.lots.length} lots`}</summary>
                  <ul className="mt-1 space-y-0.5 tabular-nums">
                    {g.lots.map((l) => (
                      <li key={l.id}>
                        bought {l.buyDate ?? "—"} · {l.isOpen ? "open" : `sold ${l.sellDate ?? "—"}`} · {num(l.buyQty, 0)} @{" "}
                        {num(l.avgBuyPrice, 2)} · FMV {l.fmv31Jan2018 == null ? "—" : num(l.fmv31Jan2018, 2)}
                      </li>
                    ))}
                  </ul>
                </details>
              </ReportTd>
              <ReportTd muted className="align-top">{g.isin ?? "no ISIN"}</ReportTd>
              <ReportTd align="right" className="align-top">{g.lots.length}</ReportTd>
              <ReportTd align="right" className="align-top">{num(g.totalQty, 0)}</ReportTd>
              <ReportTd align="right" className="align-top">
                {g.firstBuyDate === g.lastBuyDate ? g.firstBuyDate : `${g.firstBuyDate} → ${g.lastBuyDate}`}
              </ReportTd>
              <ReportTd className="text-right align-top">
                <Input
                  type="number"
                  step="any"
                  value={shown(g)}
                  onChange={(e) => setEdits((v) => ({ ...v, [g.key]: e.target.value }))}
                  placeholder={g.fmv === "mixed" ? `mixed — saving sets all ${g.lots.length} lots` : "blank = actual cost"}
                  className="h-7 w-52 text-right tabular-nums"
                />
                {blankOverMixed(g) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Enter a value to set all {g.lots.length} lots; to clear a mixed group, set one value first, then save blank
                  </p>
                )}
              </ReportTd>
              <ReportTd className="text-right align-top">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === g.key || blankOverMixed(g)}
                  onClick={() => save(g)}
                >
                  {busy === g.key ? "Saving…" : "Save"}
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
