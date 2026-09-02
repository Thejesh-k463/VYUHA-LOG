"use client";

/**
 * The confirmation an ACCOUNT delete must pass through.
 *
 * The preview is computed on the SERVER (action "deletePreview") every time the
 * dialog opens or an option changes, so the counts and warnings shown are the
 * true blast radius, not a client-side guess. The type-to-confirm arm follows
 * the bulk-delete cockpit pattern (delete-trades-dialog.tsx) — a destructive
 * action earns one deliberate step; here the thing typed is the account's
 * name, because "which account" is the fact worth re-reading, not a count.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { Trash2, TriangleAlert } from "lucide-react";

export interface AccountLite {
  id: number;
  name: string;
  archived: boolean;
  isDefault: boolean;
}

interface Preview {
  ok: boolean;
  message?: string;
  counts?: Record<string, number>;
  dedupCollisions?: number;
  sessionCollisions?: number;
  warnings?: string[];
}

const COUNT_LABELS: [string, string][] = [
  ["trades", "Trades"],
  ["legs", "Legs"],
  ["attachments", "Attachments"],
  ["importBatches", "Imports"],
  ["ipos", "IPOs"],
  ["ledgerEntries", "Ledger entries"],
  ["tradingSessions", "Sessions"],
  ["capitalSnapshots", "Capital snapshots"],
  ["capitalGoals", "Capital goals"],
  ["brokerConnections", "Broker APIs"],
  ["panelDismissals", "Dismissals"],
];

export function AccountDeleteDialog({
  account,
  accounts,
  open,
  onOpenChange,
}: {
  account: AccountLite;
  accounts: AccountLite[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const router = useRouter();
  // Merge targets are LIVE accounts only: merging a journal into an archived
  // book buries it behind a switcher that filters archived accounts out. The
  // server would only warn; the picker simply does not offer it.
  const others = accounts.filter((a) => a.id !== account.id && !a.archived);
  // The default merge destination is the default account, else the first live
  // one — the same preference order the server uses to move the selection.
  const suggested = others.find((a) => a.isDefault) ?? others[0];

  const [mode, setMode] = React.useState<"purge" | "merge">("purge");
  const [targetId, setTargetId] = React.useState<number>(suggested?.id ?? 0);
  const [moveConnections, setMoveConnections] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // The preview is stored WITH the key of the request that produced it, and a
  // stale one is derived away rather than cleared by a setState-in-effect
  // (the convention the Trades-filter bug bought): while the key differs the
  // dialog is simply "loading" again.
  const previewKey = `${account.id}:${mode}:${mode === "merge" ? targetId : ""}`;
  const [loaded, setLoaded] = React.useState<{ key: string; data: Preview } | null>(null);
  const preview = loaded && loaded.key === previewKey ? loaded.data : null;

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "deletePreview", id: account.id, mode, targetId: mode === "merge" ? targetId : undefined }),
    })
      .then((r) => r.json())
      .then((p: Preview) => { if (!cancelled) setLoaded({ key: previewKey, data: p }); })
      .catch(() => { if (!cancelled) setLoaded({ key: previewKey, data: { ok: false, message: "The preview could not be loaded." } }); });
    return () => { cancelled = true; };
  }, [open, mode, targetId, account.id, previewKey]);

  // Trim BOTH sides: a name stored with stray whitespace (pre-trim installs)
  // or a trailing space in the input must not make the delete un-armable.
  const armed = !busy && !!preview?.ok && typed.trim() === account.name.trim() && (mode === "purge" || targetId > 0);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          id: account.id,
          mode,
          targetId: mode === "merge" ? targetId : undefined,
          connections: mode === "merge" && moveConnections ? "move" : "delete",
        }),
      }).then((r) => r.json());
      if (res.ok) {
        toast.success(res.message || "Account deleted.");
        onOpenChange(false);
        // If the deleted account was the one being viewed, the server has
        // already moved the selection — the refresh lands on the new view.
        router.refresh();
      } else {
        toast.error(res.message || "The account could not be deleted.");
      }
    } catch {
      toast.error("The account could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setTyped(""); setLoaded(null); } onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-4 text-loss" /> Delete account “{account.name}”?
          </DialogTitle>
          <DialogDescription>
            Choose what happens to everything this account holds. A recovery snapshot is saved before anything is removed —
            broker API credentials are never written to it and cannot be recovered.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-xs">
          <label className="flex items-start gap-2">
            <input type="radio" name="acct-del-mode" className="mt-0.5 accent-current" checked={mode === "purge"} onChange={() => setMode("purge")} />
            <span>
              <b>Delete everything</b> — trades, imports, IPOs, ledger, sessions, capital history, broker APIs and dismissals in this account are removed with it.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="acct-del-mode" className="mt-0.5 accent-current" checked={mode === "merge"} onChange={() => setMode("merge")} disabled={others.length === 0} />
            <span className="flex-1">
              <b>Merge into another account</b> — the journal moves there under the same trade ids; only exact duplicates are skipped.
              {mode === "merge" && (
                <Select className="mt-2" value={String(targetId)} onChange={(e) => setTargetId(Number(e.target.value))}>
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </span>
          </label>

          {mode === "merge" && (
            <label className="flex items-start gap-2 pl-5">
              <input type="checkbox" className="mt-0.5 accent-current" checked={moveConnections} onChange={(e) => setMoveConnections(e.target.checked)} />
              <span>Move broker API connections to the destination (unchecked: they are deleted).</span>
            </label>
          )}

          {preview === null && <p className="text-muted-foreground">Computing what this removes…</p>}
          {preview && !preview.ok && <p className="text-loss">{preview.message}</p>}
          {preview?.ok && preview.counts && (
            <>
              <div className="grid grid-cols-3 gap-2">
                {COUNT_LABELS.filter(([k]) => (preview.counts![k] ?? 0) > 0).map(([k, label]) => (
                  <div key={k} className="rounded-md border border-border p-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                    <div className="font-mono text-sm tabular-nums">{preview.counts![k]}</div>
                  </div>
                ))}
              </div>
              {Object.values(preview.counts).every((n) => n === 0) && (
                <p className="text-muted-foreground">This account holds no data — only the account itself is removed.</p>
              )}
              {(preview.warnings ?? []).length > 0 && (
                <ul className="space-y-1.5">
                  {preview.warnings!.map((w, i) => (
                    <li key={i} className="flex items-start gap-1.5">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <div>
            <label className="mb-1 block font-medium" htmlFor="confirm-account-name">
              Type <b>{account.name}</b> to confirm
            </label>
            <Input id="confirm-account-name" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={account.name} autoComplete="off" />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={!armed} onClick={() => void run()}>
            {busy ? "Deleting…" : mode === "purge" ? "Delete account" : "Merge & delete account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
