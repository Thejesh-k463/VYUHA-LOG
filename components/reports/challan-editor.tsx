"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { inr } from "@/lib/format";
import { CheckCircle2, AlertCircle, Copy, Pencil, Trash2, X } from "lucide-react";
import { ReportTable, ReportThead, ReportTh, ReportTr, ReportTd } from "@/components/ui/report-table";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Editor for the dated advance-tax challan ledger (v3.7, WS4) — the payments
 * actually made to the department, transcribed from the receipts, so the
 * planner can ask "what stood paid on 15 September?" instead of applying one
 * hand-typed scalar to every instalment.
 *
 * Sibling of components/reports/bf-loss-editor.tsx by design: both hold
 * STATEMENTS OF FACT copied off paper, so both get the same shape — the SERVER
 * computes every derived value (which instalment the payment counted towards,
 * whether findDuplicateChallan matched, the FY's own date window) and passes it
 * down; this component derives nothing.
 *
 * Writes: fetch + router.refresh() (recorded convention — a server action
 * auto-refreshes the route, which remounts sibling client components and
 * silently resets their state; that is what broke the charge editor and made
 * the settings theme appear to revert).
 *
 * BSR code and challan serial stay OPTIONAL all the way through. A
 * self-assessment receipt often carries neither, and refusing a real payment
 * over a blank transcription field would be the worse error — the ITR pack
 * leaves those columns blank rather than inventing a placeholder.
 *
 * A duplicate WARNS and is still saved. Two genuine payments of the same amount
 * on the same day are legal, the table has no unique index for exactly that
 * reason, and the honest response to an ambiguity is to show it, not to refuse.
 */

export interface ChallanEditorRow {
  id: number;
  /** ISO date, for the edit form. */
  paidOn: string;
  /** Display date — formatted on the server (this component derives nothing). */
  paidOnLabel: string;
  /** ₹ paid (rupees at runtime; the column stores integer paise). */
  amount: number;
  bsrCode: string | null;
  challanSerial: string | null;
  note: string | null;
  /**
   * Which instalment the payment counted towards, decided SERVER-SIDE against
   * the FY's own due dates — e.g. "15 Sep" — or the s.408(3) verdict for a
   * payment made after the year closed.
   */
  countsTowards: string;
  /**
   * True when `findDuplicateChallan` matched another row on this account:
   * same FY, same date, same amount to the paise. A warning, never a block.
   */
  duplicate: boolean;
}

export function ChallanEditor({
  rows,
  fy,
  aggregate,
  minDate,
  maxDate,
}: {
  rows: ChallanEditorRow[];
  /** The FY these challans belong to, e.g. "2026-27". */
  fy: string;
  /** All-accounts view: rows are read-only and the refusal is explained. */
  aggregate: boolean;
  /** First date the FY can accept — server-side, from advanceTaxFyWindow(). */
  minDate: string;
  /**
   * Last date it can accept: TODAY IN INDIA (`todayIstIso()`, the same day
   * `upsertChallan` refuses a future challan against), or the FY end once the
   * year has closed. A UTC-derived `today` put this on yesterday until 05:30
   * IST, so a challan paid this morning could not be entered at all.
   */
  maxDate: string;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [paidOn, setPaidOn] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [bsr, setBsr] = React.useState("");
  const [serial, setSerial] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  const duplicates = rows.filter((r) => r.duplicate).length;

  function clear() {
    setEditingId(null);
    setPaidOn("");
    setAmount("");
    setBsr("");
    setSerial("");
    setNote("");
  }

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/challans", {
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

  async function save() {
    const ok = await post({
      action: "upsert",
      id: editingId,
      fy,
      paidOn: paidOn.trim(),
      amount: Number(amount),
      bsrCode: bsr.trim() === "" ? null : bsr.trim(),
      challanSerial: serial.trim() === "" ? null : serial.trim(),
      note: note.trim() === "" ? null : note.trim(),
    });
    if (ok) clear();
  }

  function edit(r: ChallanEditorRow) {
    setEditingId(r.id);
    setPaidOn(r.paidOn);
    setAmount(String(r.amount));
    setBsr(r.bsrCode ?? "");
    setSerial(r.challanSerial ?? "");
    setNote(r.note ?? "");
    setMsg(null);
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <EmptyState
          variant="journal"
          title={`No advance-tax challans recorded for ${fy}`}
          hint="Enter each payment from its receipt — the date is what matters, because every instalment is measured against what stood paid on its own due date. Until then the planner uses the single 'paid so far' figure above."
        />
      ) : (
        <ReportTable>
          <ReportThead>
            <ReportTh>Paid on</ReportTh>
            <ReportTh align="right">Amount</ReportTh>
            <ReportTh>Counts towards</ReportTh>
            <ReportTh>BSR code</ReportTh>
            <ReportTh>Challan serial</ReportTh>
            <ReportTh>Note</ReportTh>
            <ReportTh></ReportTh>
          </ReportThead>
          <tbody>
            {rows.map((r, i) => (
              <ReportTr key={r.id} className={r.id === editingId ? "bg-accent/5" : undefined}>
                <ReportTd className="font-medium">
                  {r.paidOnLabel}
                  {r.duplicate && (
                    <span
                      className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-warning"
                      title="Another challan on this account has the same date and the same amount. Both are kept — two genuine payments can look identical."
                    >
                      <Copy className="size-3" /> duplicate
                    </span>
                  )}
                </ReportTd>
                <ReportTd align="right" className="tabular-nums">{inr(r.amount, { decimals: 0 })}</ReportTd>
                <ReportTd muted>{r.countsTowards}</ReportTd>
                <ReportTd className="font-mono text-xs" muted={r.bsrCode === null}>{r.bsrCode ?? "—"}</ReportTd>
                <ReportTd className="font-mono text-xs" muted={r.challanSerial === null}>{r.challanSerial ?? "—"}</ReportTd>
                <ReportTd className="max-w-48 truncate text-muted-foreground" title={r.note ?? undefined}>{r.note ?? "—"}</ReportTd>
                <ReportTd className="text-right">
                  {!aggregate && (
                    <span className="inline-flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit row ${i + 1} — challan dated ${r.paidOnLabel}`}
                        disabled={busy}
                        onClick={() => edit(r)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove row ${i + 1} — challan dated ${r.paidOnLabel}`}
                        disabled={busy}
                        onClick={() => post({ action: "delete", id: r.id })}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  )}
                </ReportTd>
              </ReportTr>
            ))}
          </tbody>
        </ReportTable>
      )}

      {duplicates > 0 && !aggregate && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <Copy className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {duplicates} row{duplicates === 1 ? " shares" : "s share"} a date and amount with another challan. Both are
            kept — two genuine payments of the same amount on one day are legal, so this is a flag to check against your
            receipts, not an error. Delete one if it was entered twice.
          </span>
        </p>
      )}

      {aggregate ? (
        <p className="text-xs text-muted-foreground">
          Viewing all accounts — every account&apos;s challans are shown and fed to the planner together, but a challan is
          ONE account&apos;s payment to the department, so this view cannot add or edit them. Pick an account in the sidebar
          to record a payment.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="challan-paid-on">Paid on</label>
            <Input
              id="challan-paid-on"
              type="date"
              min={minDate}
              max={maxDate}
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              className="h-8 w-40"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="challan-amount">₹ paid</label>
            <Input
              id="challan-amount"
              type="number"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-8 w-36 text-right tabular-nums"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="challan-bsr">BSR code (optional)</label>
            <Input id="challan-bsr" value={bsr} onChange={(e) => setBsr(e.target.value)} placeholder="0510308" className="h-8 w-32 font-mono" />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="challan-serial">Challan serial (optional)</label>
            <Input id="challan-serial" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="02451" className="h-8 w-32 font-mono" />
          </div>
          <div className="space-y-1">
            <label className="text-[0.6875rem] text-muted-foreground" htmlFor="challan-note">Note</label>
            <Input id="challan-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Q2 instalment, HDFC net banking" className="h-8 w-52" />
          </div>
          <Button size="sm" variant="outline" disabled={busy || paidOn.trim() === "" || amount.trim() === ""} onClick={save}>
            {busy ? "Saving…" : editingId != null ? "Save changes" : "Record payment"}
          </Button>
          {editingId != null && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={clear}>
              <X className="size-3.5" /> Cancel
            </Button>
          )}
        </div>
      )}

      {msg && (
        <span className={`flex items-start gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
          {msg.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertCircle className="mt-0.5 size-3.5 shrink-0" />}
          {msg.text}
        </span>
      )}

      <p className="text-[0.6875rem] text-muted-foreground">
        BSR code and challan serial are optional — a self-assessment receipt often omits them, and the ITR pack leaves
        those columns blank rather than inventing a placeholder. Dates are what the instalment maths runs on: a payment
        counts towards an instalment only if it was made on or before that instalment&apos;s own due date, and money paid
        after 31 March is self-assessment tax, not advance tax for {fy}. These are your own transcriptions — verify them
        against your receipts and Form 26AS / AIS.
      </p>
    </div>
  );
}
