"use client";

// IND-5 — AIS/26AS reconciliation client: paste rows, POST /api/ais, render
// the match/mismatch tables. Stateless — nothing is stored.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { inr } from "@/lib/format";
import type { AisReconciliation, ReconStatus } from "@/lib/analytics/ais";

const STATUS_LABEL: Record<ReconStatus, string> = {
  matched: "Matched",
  mismatch: "MISMATCH",
  missing_in_journal: "Not in journal",
  missing_in_ais: "Not in AIS",
};

const STATUS_CLS: Record<ReconStatus, string> = {
  matched: "text-profit",
  mismatch: "text-loss font-semibold",
  missing_in_journal: "text-warning",
  missing_in_ais: "text-warning",
};

const PLACEHOLDER = `dividend, ATGL, 2026-27, 9000, 900
sale, Sale of securities (SFT-18), 2026-27, 1250000
purchase, SFT-17, 2026-27, 1100000
interest, SBI Savings, 2026-27, 4210`;

export function AisReconcile() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recon, setRecon] = useState<AisReconciliation | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/ais", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.ok) setRecon(data.recon);
      else setErr(data.message ?? "Failed");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const amt = (v: number | null) => (v == null ? "—" : inr(v, { decimals: 0 }));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          placeholder={PLACEHOLDER}
          className="w-full rounded-md border border-border bg-input p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex items-center gap-3">
          <Button onClick={run} disabled={busy || !text.trim()}>
            {busy ? "Reconciling…" : "Reconcile"}
          </Button>
          {err && <span className="text-xs text-loss">{err}</span>}
          {recon && (
            <span className="text-xs text-muted-foreground">
              <span className="text-profit">{recon.counts.matched} matched</span>
              {" · "}
              <span className={recon.counts.mismatch ? "text-loss" : ""}>{recon.counts.mismatch} mismatched</span>
              {" · "}
              {recon.counts.missingInJournal} not in journal · {recon.counts.missingInAis} not in AIS
            </span>
          )}
        </div>
      </div>

      {recon && (
        <>
          {recon.unparsed.length > 0 && (
            <p className="text-xs text-warning">
              {recon.unparsed.length} line{recon.unparsed.length === 1 ? "" : "s"} could not be parsed:{" "}
              <span className="font-mono">{recon.unparsed.slice(0, 3).join(" | ")}</span>
              {recon.unparsed.length > 3 && " …"}
            </p>
          )}

          {recon.dividends.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">Dividend — company · FY</th>
                    <th className="px-2 py-2 text-right font-medium">AIS gross</th>
                    <th className="px-2 py-2 text-right font-medium">AIS TDS</th>
                    <th className="px-2 py-2 text-right font-medium">Journal gross</th>
                    <th className="px-2 py-2 text-right font-medium">Journal TDS</th>
                    <th className="px-2 py-2 text-right font-medium">Δ</th>
                    <th className="px-2.5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.dividends.map((d) => (
                    <tr key={d.key} className="border-b border-border/40">
                      <td className="px-2.5 py-1.5 font-medium">{d.key}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(d.aisGross)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(d.aisTds)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(d.journalGross)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(d.journalTds)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.delta !== 0 ? amt(d.delta) : "—"}</td>
                      <td className={`px-2.5 py-1.5 ${STATUS_CLS[d.status]}`}>{STATUS_LABEL[d.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {recon.fyTotals.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-medium">Securities — FY · type</th>
                    <th className="px-2 py-2 text-right font-medium">AIS</th>
                    <th className="px-2 py-2 text-right font-medium">Journal</th>
                    <th className="px-2 py-2 text-right font-medium">Δ</th>
                    <th className="px-2.5 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recon.fyTotals.map((t) => (
                    <tr key={`${t.fy}-${t.kind}`} className="border-b border-border/40">
                      <td className="px-2.5 py-1.5 font-medium">
                        {t.fy} <Badge variant="outline" className="ml-1">{t.kind}</Badge>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(t.ais)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{amt(t.journal)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{t.delta !== 0 ? amt(t.delta) : "—"}</td>
                      <td className={`px-2.5 py-1.5 ${STATUS_CLS[t.status]}`}>{STATUS_LABEL[t.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {recon.interest.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Interest rows (informational — bank interest isn&apos;t journaled here):{" "}
              {recon.interest.map((i) => `${i.party} ${i.fy} ${inr(i.amount, { decimals: 0 })}`).join(" · ")}
            </p>
          )}
        </>
      )}
    </div>
  );
}
