"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { inr } from "@/lib/format";
import { CheckCircle2, AlertCircle, Trash2 } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Editor for pre-journal brought-forward losses (v3.6, WS5) — losses from
 * ITRs filed BEFORE this journal began, entered by hand and seeded into the
 * set-off engine. Server computes each row's expiry via lossExpiryFy (the
 * engine's own formula) and passes it down — this component derives nothing.
 * Writes: fetch + router.refresh() (recorded convention, never server actions).
 */

export interface BfLossEditorRow {
  id: number;
  incurredFy: string;
  head: string;
  headLabel: string;
  amount: number;
  originalAmount: number | null;
  note: string | null;
  /** Last FY the vintage is usable — computed server-side by lossExpiryFy. */
  expiresAfterFy: string;
}

export interface BfLossHeadOption {
  value: string;
  label: string;
}

const FY_RE = /^\d{4}-\d{2}$/;

function fyConsistent(fy: string): boolean {
  if (!FY_RE.test(fy)) return false;
  const start = Number(fy.slice(0, 4));
  return fy.slice(5) === String((start + 1) % 100).padStart(2, "0");
}

export function BfLossEditor({ rows, heads, aggregate }: { rows: BfLossEditorRow[]; heads: BfLossHeadOption[]; aggregate: boolean }) {
  const router = useRouter();
  const [fy, setFy] = React.useState("");
  const [head, setHead] = React.useState(heads[0]?.value ?? "stcl");
  const [amount, setAmount] = React.useState("");
  const [original, setOriginal] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const fyOk = fy === "" || fyConsistent(fy);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/bf-losses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setBusy(false);
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) router.refresh();
    return !!data.ok;
  }

  async function add() {
    const amt = Number(amount);
    const orig = original.trim() === "" ? null : Number(original);
    const ok = await post({
      action: "upsert",
      incurredFy: fy.trim(),
      head,
      amount: amt,
      originalAmount: orig,
      note: note.trim() === "" ? null : note.trim(),
    });
    if (ok) {
      setFy("");
      setAmount("");
      setOriginal("");
      setNote("");
    }
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyState
          variant="journal"
          title="No brought-forward losses entered"
          hint="This is for losses from ITRs filed before you started this journal — the unabsorbed carry-forward your last return reported, per year and head. Losses from imported trades are tracked automatically and do not belong here."
        />
      ) : (
        <ReportTable>
          <ReportThead>
            <ReportTh>FY incurred</ReportTh>
            <ReportTh>Head</ReportTh>
            <ReportTh align="right">Remaining then</ReportTh>
            <ReportTh align="right">Original</ReportTh>
            <ReportTh align="right">Expires after FY</ReportTh>
            <ReportTh>Note</ReportTh>
            <ReportTh></ReportTh>
          </ReportThead>
          <tbody>
            {rows.map((r) => (
              <ReportTr key={r.id}>
                <ReportTd className="font-medium">{r.incurredFy}</ReportTd>
                <ReportTd>{r.headLabel}</ReportTd>
                <ReportTd align="right" className="text-loss">{inr(r.amount, { decimals: 0 })}</ReportTd>
                <ReportTd align="right" muted>{r.originalAmount != null ? inr(r.originalAmount, { decimals: 0 }) : "—"}</ReportTd>
                <ReportTd align="right" muted>{r.expiresAfterFy}</ReportTd>
                <ReportTd className="max-w-56 truncate text-muted-foreground" title={r.note ?? undefined}>{r.note ?? "—"}</ReportTd>
                <ReportTd className="text-right">
                  {!aggregate && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove the ${r.incurredFy} ${r.headLabel} lot`}
                      disabled={busy}
                      onClick={() => post({ action: "delete", id: r.id })}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
      )}

      {aggregate ? (
        <p className="text-xs text-muted-foreground">
          Viewing all accounts — every account&apos;s lots are shown and seeded together. Pick one account in the
          sidebar to add or edit its lots.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="bf-fy">FY incurred</label>
            <Input
              id="bf-fy"
              value={fy}
              onChange={(e) => setFy(e.target.value)}
              placeholder="2022-23"
              className={`h-8 w-24 ${fyOk ? "" : "border-loss"}`}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="bf-head">Loss head</label>
            <Select id="bf-head" value={head} onChange={(e) => setHead(e.target.value)} className="h-8 w-72 text-xs">
              {heads.map((h) => (
                <option key={h.value} value={h.value}>{h.label}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="bf-amount">₹ remaining (per last return)</label>
            <Input id="bf-amount" type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="h-8 w-36 text-right tabular-nums" />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="bf-original">₹ original (blank = unknown)</label>
            <Input id="bf-original" type="number" step="any" min="0" value={original} onChange={(e) => setOriginal(e.target.value)} className="h-8 w-36 text-right tabular-nums" />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="bf-note">Note</label>
            <Input id="bf-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. AY 2023-24 ITR-3" className="h-8 w-44" />
          </div>
          <Button size="sm" variant="outline" disabled={busy || fy.trim() === "" || !fyOk || amount.trim() === ""} onClick={add}>
            {busy ? "Saving…" : "Add / update lot"}
          </Button>
        </div>
      )}

      {!fyOk && <p className="text-xs text-loss">The FY must look like 2022-23 — start year, then the next year&apos;s last two digits.</p>}
      {msg && (
        <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
          {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
          {msg.text}
        </span>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        Seeded lots enter the set-off and expiry maths above exactly like journal-tracked ones: absorbed
        oldest-first under the usual rules, and dropped once their window closes (8 years for capital and
        F&amp;O losses, 4 for speculative). Re-entering a year and head updates that lot rather than adding a
        second one. Figures here are your own transcription of filed returns — verify against the returns
        themselves.
      </p>
    </div>
  );
}
