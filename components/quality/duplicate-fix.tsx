"use client";

/**
 * The same broker record, held in two accounts — and the one button that
 * removes ONE account's copy (v4.2.1, owner ruling R4b).
 *
 * Every group here is a `(broker, dedupHash)` that exists in more than one
 * account. The dedup hash carries no account id and its unique index is per
 * account, so re-importing one file into a second book stores the record
 * twice and the All-accounts view sums both copies.
 *
 * The button names the ACCOUNT it removes from, never "remove the duplicate":
 * which copy goes is the whole decision, and it is the user's. The server
 * re-derives the group before it deletes anything, so a screen left open
 * cannot remove the last remaining copy.
 *
 * M-5 (2026-09-10): only a PLAIN copy gets a button. R5's auto-close makes a
 * row stand for two broker records at once — the lot it kept and the execution
 * it swallowed — so "remove the copy in <account>" on such a row deletes a
 * merged lot. `removable` is resolved server-side and re-checked by the action.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toaster";
import { NO_PLAIN_COPY_NOTE } from "@/lib/analytics/data-quality";
import { removeDuplicateCopy } from "@/app/data-quality/actions";

export interface DuplicateFixAccount {
  id: number;
  name: string;
  rows: number;
  /**
   * M-5 — this account's copy is a PLAIN single-source row, so removing it
   * removes nothing else. Resolved server-side by `isPlainDuplicateCopy`
   * (lib/analytics/data-quality.ts); a merged lot is never removable and never
   * gets a button.
   */
  removable: boolean;
}

export interface DuplicateFixGroup {
  broker: string;
  brokerLabel: string;
  dedupHash: string;
  symbol: string;
  /** Null when no row in the group states it — printed "—", never borrowed
   *  from a merged lot (U-2, invariant 6). */
  qty: number | null;
  buyDate: string | null;
  sellDate: string | null;
  rows: number;
  accounts: DuplicateFixAccount[];
}

export interface DuplicateConnection {
  broker: string;
  brokerLabel: string;
  maskedIdentity: string;
  accounts: { id: number; name: string }[];
}

interface Target {
  group: DuplicateFixGroup;
  account: DuplicateFixAccount;
}

const dates = (g: DuplicateFixGroup) =>
  [g.buyDate ? `bought ${g.buyDate}` : null, g.sellDate ? `sold ${g.sellDate}` : null].filter(Boolean).join(" · ");

export function DuplicateFix({
  groups,
  connections,
}: {
  groups: DuplicateFixGroup[];
  connections: DuplicateConnection[];
}) {
  const router = useRouter();
  // Derived at render from `target`, never synced in an effect — a
  // setState in an effect keyed on other state is what broke the Trades
  // filter under the React Compiler (AGENTS.md).
  const [target, setTarget] = React.useState<Target | null>(null);
  const [busy, setBusy] = React.useState(false);
  // R12 — the button that opened the confirm. The dialog opens from state
  // with no DialogTrigger, so Radix's own close restore focuses a null
  // triggerRef and keyboard focus fell to <body>. A ref, not state: it is
  // written in the click handler, read in onCloseAutoFocus, and never renders.
  const openerRef = React.useRef<HTMLButtonElement | null>(null);

  // U-1 — `busy` is cleared in a `finally`. Without it a thrown action left
  // `busy` true for ever: Confirm disabled, Cancel disabled, and
  // `onOpenChange` refusing to close, so the dialog could only be escaped by
  // reloading the page. Same shape as spot-mark-editor.tsx's `save()`.
  async function run(t: Target) {
    setBusy(true);
    try {
      const res = await removeDuplicateCopy({
        broker: t.group.broker,
        dedupHash: t.group.dedupHash,
        accountId: t.account.id,
      });
      setTarget(null);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      router.refresh();
    } catch {
      // U-1 (round 2): NEVER the thrown message. `removeDuplicateCopy` is a
      // server action, and a production build replaces a server-side error's
      // message with React's redaction boilerplate ("An error occurred in the
      // Server Components render…"), so the toast showed the user a paragraph
      // about digests instead of what happened to their data. The action's own
      // refusals arrive as `res.ok === false` above, with their real sentence.
      toast.error("Nothing was removed. Reload the page and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (groups.length === 0 && connections.length === 0) return null;

  return (
    <Card className="p-0" id="duplicates">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Copy className="size-4" />
          Duplicates across accounts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 p-5 pt-0">
        {connections.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">One broker client, several accounts</p>
            {connections.map((c) => (
              <div
                key={`${c.broker}:${c.accounts.map((a) => a.id).join("-")}`}
                className="flex flex-col gap-1 rounded-md border border-border p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {c.brokerLabel} <span className="text-muted-foreground">{c.maskedIdentity}</span>
                  </p>
                  <p className="text-muted-foreground">
                    Connected in {c.accounts.map((a) => a.name).join(", ")}. A pull from any of them brings the same
                    trades into each book.
                  </p>
                </div>
                <Button asChild size="sm" variant="outline">
                  <Link href="/import">Open Import</Link>
                </Button>
              </div>
            ))}
          </div>
        )}

        {groups.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium">One broker record, several accounts</p>
            {groups.map((g) => (
              <div key={`${g.broker}:${g.dedupHash}`} className="rounded-md border border-border p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{g.symbol}</p>
                  <Badge variant="outline">{g.rows} rows</Badge>
                  <span className="text-muted-foreground">
                    {g.brokerLabel} · qty {g.qty ?? "—"}
                    {dates(g) ? ` · ${dates(g)}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Held in {g.accounts.map((a) => `${a.name} (${a.rows})`).join(", ")}.
                </p>
                {/* M-5 — ONLY PLAIN COPIES GET A BUTTON. After R5's auto-close
                    a row can be one account's copy of this record AND the row
                    that closed a lot that account was holding, and removing it
                    would take the merged lot with it. A group with no plain
                    copy is stated and linked, never offered a delete. */}
                {g.accounts.some((a) => a.removable) ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {g.accounts
                      .filter((a) => a.removable)
                      .map((a) => (
                        <Button
                          key={a.id}
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={(e) => {
                            openerRef.current = e.currentTarget;
                            setTarget({ group: g, account: a });
                          }}
                        >
                          Remove the copy in {a.name}
                        </Button>
                      ))}
                  </div>
                ) : (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-muted-foreground">{NO_PLAIN_COPY_NOTE}</p>
                    <Button asChild size="sm" variant="outline">
                      <Link href="/import">Open Import</Link>
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog
        open={target !== null}
        onOpenChange={(v) => {
          if (!v && !busy) setTarget(null);
        }}
      >
        <DialogContent
          className="max-w-md"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            openerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-warning" />
              Remove the copy in {target?.account.name}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.account.rows} row${target.account.rows === 1 ? "" : "s"} of ${target.group.symbol} ` +
                  `(${target.group.brokerLabel}, qty ${target.group.qty ?? "—"}) leave ${target.account.name}. ` +
                  `The copy in ${target.group.accounts
                    .filter((a) => a.id !== target.account.id)
                    .map((a) => a.name)
                    .join(", ")} stays. Recoverable from Backup & Restore → Deleted items.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || target === null}
              onClick={() => {
                if (target) void run(target);
              }}
            >
              {busy ? "Removing…" : "Remove the copy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
