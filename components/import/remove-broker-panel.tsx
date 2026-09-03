"use client";

/**
 * Remove one broker's imported rows from one account, then re-import the file
 * clean (v3.8 W3, owner ruling 2026-09-04).
 *
 * Why a panel exists at all: a parser fix can change what a file MEANS (the
 * W2a Paytm fix paired executions on ISIN, merging 35 phantom positions), and
 * dedup cannot absorb that — the old rows are not mis-keyed, they are wrong.
 * The honest path is remove-then-re-import, scoped by (account, broker) so
 * what the panel COUNTS is exactly what goes.
 *
 * Rules the component keeps:
 *   - The account travels with every request. 0 / "All accounts" is a view,
 *     never a write target (invariant 9) — the panel says "Pick an account
 *     first" and disables everything rather than let the server guess.
 *   - No remove without the dialog: the POST carries `confirm: true` only from
 *     the dialog's own button, and the server refuses without it.
 *   - Route handler + fetch + router.refresh() (AGENTS.md), never a server
 *     action: the import page holds a dropped file and a column mapping in
 *     client state that an auto-refresh would silently reset.
 *   - Errors branch on the server's stable `code`, never on its prose.
 *   - Loading is DERIVED (`loaded.accountId !== account.id`), not reset in an
 *     effect — see AGENTS.md on `react-hooks/set-state-in-effect`.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Trash2 } from "lucide-react";

export const REMOVE_BROKER_ENDPOINT = "/api/import/remove-broker";
export const REMOVE_BROKER_PANEL_TITLE = "Remove a broker's imported rows";
export const REMOVE_BROKER_BUTTON = "Remove and re-import";
export const REMOVE_BROKER_REIMPORT_BUTTON = "Now re-import the file";
/** Shown, and used as the disabled reason, whenever the selector is on All accounts. */
export const REMOVE_BROKER_PICK_ACCOUNT = "Pick an account first";

/** One row of the GET — `countTradesByBroker` in lib/queries/import-sources.ts. */
export interface BrokerRowCount {
  broker: string;
  trades: number;
  closed: number;
  open: number;
  earliest: string | null;
  latest: string | null;
}

export interface RemoveBrokerResult {
  ok: true;
  accountId: number;
  broker: string;
  removed: { trades: number; closed: number; open: number; legs: number; attachments: number };
  unlinked: { ledgerEntries: number; ipos: number };
  snapshotId: string;
  orphanedFiles: string[];
  message: string;
}

const n = (v: number) => v.toLocaleString("en-IN");

export function brokerLabel(broker: string): string {
  return BROKER_LABELS[broker as Broker] ?? broker;
}

/** "2024-04-01–2025-03-31", or "—" when the rows carry no dates (Dhan P&L). */
export function dateSpan(earliest: string | null, latest: string | null): string {
  if (!earliest && !latest) return "—";
  return `${earliest ?? "—"}–${latest ?? "—"}`;
}

/**
 * The confirmation sentence — ONE writer, pinned verbatim by
 * tests/remove-broker-ui.test.ts. It names the count, the account, what goes
 * with the rows, what is kept, and where the rows can be recovered from,
 * because a delete dialog that says less than that is asking for trust it
 * has not earned.
 */
export function removeBrokerConfirmSentence(row: BrokerRowCount, accountName: string): string {
  return (
    `Remove all ${n(row.trades)} ${brokerLabel(row.broker)} trade${row.trades === 1 ? "" : "s"} from “${accountName}”? ` +
    `${n(row.closed)} closed, ${n(row.open)} open, ${dateSpan(row.earliest, row.latest)}. ` +
    `Staged legs and screenshots go with them; ledger entries and IPO records are kept and unlinked. ` +
    `A snapshot is saved first — restore from Backup & Restore → Deleted items. Re-import the file afterwards.`
  );
}

/**
 * Honest copy per refusal code. The server's own message is used where it is
 * the better sentence; the generic branch never claims to know what happened.
 */
export function removeBrokerErrorCopy(code: string | undefined, message: string | undefined, broker: string, status: number): string {
  switch (code) {
    case "ACCOUNT_REQUIRED":
      return `${REMOVE_BROKER_PICK_ACCOUNT} — “All accounts” is a view, not a place to remove from. Nothing was changed.`;
    case "ACCOUNT_NOT_FOUND":
      return "That account no longer exists — it may have been deleted in another tab. Nothing was changed. Reload the page.";
    case "BROKER_REQUIRED":
      return "Pick which broker's rows to remove. Nothing was changed.";
    case "NO_ROWS":
      return `No ${brokerLabel(broker)} trades are left in this account — they may already have been removed. Nothing was changed.`;
    case "CONFIRM_REQUIRED":
      return "The remove was not confirmed, so nothing was changed.";
    case "MALFORMED":
      return "The request was malformed. Nothing was changed.";
    default:
      return message && message.trim() !== ""
        ? message
        : `Nothing was removed — the request failed (HTTP ${status}). Your journal is unchanged.`;
  }
}

/** Response body that SHOULD be JSON but may be an error page. */
async function readJson<T>(res: Response): Promise<Partial<T> & { code?: string; message?: string }> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Partial<T> & { code?: string; message?: string };
  } catch {
    return {};
  }
}

type Loaded =
  | { accountId: number; version: number; rows: BrokerRowCount[]; error: null }
  | { accountId: number; version: number; rows: null; error: string };

export function RemoveBrokerPanel({
  account,
  onRemoved,
  onReimport,
}: {
  /** The account the selector resolves to; null when it is on All accounts. */
  account: { id: number; name: string } | null;
  /** Rows went to Trash — the caller drops any preview whose dedup counts are now stale. */
  onRemoved?: (result: RemoveBrokerResult) => void;
  /** "Now re-import the file" — the caller scrolls/focuses the dropzone and refreshes. */
  onReimport: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  // `version` bumps after a remove so the list reloads for the SAME account.
  const [version, setVersion] = React.useState(0);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [confirming, setConfirming] = React.useState<BrokerRowCount | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<RemoveBrokerResult | null>(null);

  const accountId = account?.id ?? 0;
  const loading = open && accountId > 0 && (loaded == null || loaded.accountId !== accountId || loaded.version !== version);

  React.useEffect(() => {
    if (!open || accountId <= 0) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/import/remove-broker?accountId=${accountId}` /* literal path: tests/egress-guard.test.ts resolves hosts statically */, { cache: "no-store" });
        const json = await readJson<{ sources: BrokerRowCount[] }>(res);
        if (!alive) return;
        if (!res.ok) {
          setLoaded({ accountId, version, rows: null, error: removeBrokerErrorCopy(json.code, json.message, "", res.status) });
          return;
        }
        setLoaded({ accountId, version, rows: json.sources ?? [], error: null });
      } catch (e) {
        if (alive) setLoaded({ accountId, version, rows: null, error: (e as Error).message });
      }
    })();
    return () => { alive = false; };
  }, [open, accountId, version]);

  async function doRemove(row: BrokerRowCount) {
    if (accountId <= 0) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/import/remove-broker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId, broker: row.broker, confirm: true }),
      });
      const json = await readJson<RemoveBrokerResult>(res);
      if (!res.ok || json.ok !== true) {
        setError(removeBrokerErrorCopy(json.code, json.message, row.broker, res.status));
        // NO_ROWS means the list is stale — show what is really there.
        if (json.code === "NO_ROWS") setVersion((v) => v + 1);
        return;
      }
      const result = json as RemoveBrokerResult;
      setDone(result);
      setConfirming(null);
      setVersion((v) => v + 1);
      onRemoved?.(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const rows = !loading && loaded?.accountId === accountId ? loaded.rows : null;
  const loadError = !loading && loaded?.accountId === accountId ? loaded.error : null;

  return (
    <div data-testid="remove-broker-panel" className="rounded-lg border border-border">
      <button
        type="button"
        data-testid="remove-broker-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-card-hover/40"
      >
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <Trash2 className="size-4 text-muted-foreground" />
        {REMOVE_BROKER_PANEL_TITLE}
        {account && <span className="ml-auto text-xs font-normal text-muted-foreground">in “{account.name}”</span>}
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3 text-xs">
          <p className="text-muted-foreground">
            For a clean re-import after a parser fix: every trade this broker put into the account goes to
            Deleted items (Backup &amp; Restore), and the same file can then be imported again from scratch.
            Dedup would otherwise keep the old rows.
          </p>

          {!account || accountId <= 0 ? (
            <div data-testid="remove-broker-pick-account" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="space-y-2">
                <p>
                  <b>{REMOVE_BROKER_PICK_ACCOUNT}.</b> “All accounts” is a view, not a place to remove from — choose
                  the account above and the brokers in it are listed here.
                </p>
                <Button size="sm" variant="destructive" disabled title={REMOVE_BROKER_PICK_ACCOUNT}>
                  {REMOVE_BROKER_BUTTON}
                </Button>
              </div>
            </div>
          ) : (
            <>
              {loading && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Counting…
                </div>
              )}
              {loadError && (
                <p className="flex items-center gap-2 text-loss"><AlertTriangle className="size-4" /> {loadError}</p>
              )}
              {rows && rows.length === 0 && (
                <p data-testid="remove-broker-empty" className="text-muted-foreground">
                  No imported trades in “{account.name}” — nothing to remove.
                </p>
              )}
              {rows && rows.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-left text-muted-foreground">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Broker</th>
                        <th className="py-1 pr-3 font-medium">Trades</th>
                        <th className="py-1 pr-3 font-medium">Closed</th>
                        <th className="py-1 pr-3 font-medium">Open</th>
                        <th className="py-1 pr-3 font-medium">Dates</th>
                        <th className="py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.broker} data-testid={`remove-broker-row-${r.broker}`} className="border-t border-border/60">
                          <td className="py-1.5 pr-3 font-medium">{brokerLabel(r.broker)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{n(r.trades)} trade{r.trades === 1 ? "" : "s"}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{n(r.closed)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{n(r.open)}</td>
                          <td className="py-1.5 pr-3 tabular-nums">{dateSpan(r.earliest, r.latest)}</td>
                          <td className="py-1.5 text-right">
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => { setError(null); setConfirming(r); }}
                            >
                              {REMOVE_BROKER_BUTTON}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {error && (
            <p data-testid="remove-broker-error" className="flex items-start gap-2 text-loss">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}

          {done && (
            <div data-testid="remove-broker-done" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-profit/40 bg-profit/5 p-3">
              <span className="flex items-start gap-2 text-profit">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> {done.message}
              </span>
              <Button size="sm" variant="secondary" onClick={onReimport}>
                {REMOVE_BROKER_REIMPORT_BUTTON} ↑
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={confirming != null} onOpenChange={(v) => { if (!v && !busy) setConfirming(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-4 text-loss" /> Remove {confirming ? brokerLabel(confirming.broker) : ""} trades?
            </DialogTitle>
            <DialogDescription data-testid="remove-broker-confirm-copy">
              {confirming && account ? removeBrokerConfirmSentence(confirming, account.name) : ""}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="flex items-start gap-2 text-xs text-loss">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="remove-broker-confirm"
              disabled={busy || !confirming}
              onClick={() => confirming && doRemove(confirming)}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Yes, remove {confirming ? n(confirming.trades) : ""} trade{confirming?.trades === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
