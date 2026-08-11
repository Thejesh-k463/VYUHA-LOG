"use client";

// IND-5 — AIS/26AS reconciliation client: paste rows, POST /api/ais, render
// the match/mismatch tables. Stateless — nothing is stored.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { Badge } from "@/components/ui/badge";
import { inr } from "@/lib/format";
import type { AisReconciliation, ReconStatus } from "@/lib/analytics/ais";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";

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
  const [recon, setRecon] = useState<AisReconciliation | null>(null);

  async function run(payload?: { jsonText: string }) {
    setBusy(true);
    try {
      const res = await fetch("/api/ais", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? { text }),
      });
      const data = await res.json();
      if (data.ok) setRecon(data.recon);
      else toast.error(data.message ?? "Failed");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    const jsonText = await file.text();
    await run({ jsonText });
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
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => run()} disabled={busy || !text.trim()}>
            {busy ? "Reconciling…" : "Reconcile"}
          </Button>
          {/* The portal's JSON download, parsed directly — no re-typing.
              incometax.gov.in → login → AIS → the download arrow → JSON. */}
          <label
            className="inline-flex cursor-pointer items-center"
            title="Upload the AIS JSON from incometax.gov.in (AIS → Download → JSON). The PDF won't work — it's password-protected and made for reading, not parsing."
          >
            <input
              type="file"
              accept=".json,application/json"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
                e.target.value = "";
              }}
            />
            <span className="inline-flex h-9 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-card-hover">
              {busy ? "Reading…" : "Upload AIS JSON"}
            </span>
          </label>
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
            <ReportTable>
              <ReportThead>
                <ReportTh>Dividend — company · FY</ReportTh>
                <ReportTh align="right">AIS gross</ReportTh>
                <ReportTh align="right">AIS TDS</ReportTh>
                <ReportTh align="right">Journal gross</ReportTh>
                <ReportTh align="right">Journal TDS</ReportTh>
                <ReportTh align="right">Δ</ReportTh>
                <ReportTh>Status</ReportTh>
              </ReportThead>
              <tbody>
                {recon.dividends.map((d) => (
                  <ReportTr key={d.key}>
                    <ReportTd className="font-medium">{d.key}</ReportTd>
                    <ReportTd align="right">{amt(d.aisGross)}</ReportTd>
                    <ReportTd align="right">{amt(d.aisTds)}</ReportTd>
                    <ReportTd align="right">{amt(d.journalGross)}</ReportTd>
                    <ReportTd align="right">{amt(d.journalTds)}</ReportTd>
                    <ReportTd align="right">{d.delta !== 0 ? amt(d.delta) : "—"}</ReportTd>
                    <ReportTd className={STATUS_CLS[d.status]}>{STATUS_LABEL[d.status]}</ReportTd>
                  </ReportTr>
                ))}
              </tbody>
            </ReportTable>
          )}

          {recon.fyTotals.length > 0 && (
            <ReportTable>
              <ReportThead>
                <ReportTh>Securities — FY · type</ReportTh>
                <ReportTh align="right">AIS</ReportTh>
                <ReportTh align="right">Journal</ReportTh>
                <ReportTh align="right">Δ</ReportTh>
                <ReportTh>Status</ReportTh>
              </ReportThead>
              <tbody>
                {recon.fyTotals.map((t) => (
                  <ReportTr key={`${t.fy}-${t.kind}`}>
                    <ReportTd className="font-medium">
                      {t.fy} <Badge variant="outline" className="ml-1">{t.kind}</Badge>
                    </ReportTd>
                    <ReportTd align="right">{amt(t.ais)}</ReportTd>
                    <ReportTd align="right">{amt(t.journal)}</ReportTd>
                    <ReportTd align="right">{t.delta !== 0 ? amt(t.delta) : "—"}</ReportTd>
                    <ReportTd className={STATUS_CLS[t.status]}>{STATUS_LABEL[t.status]}</ReportTd>
                  </ReportTr>
                ))}
              </tbody>
            </ReportTable>
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
