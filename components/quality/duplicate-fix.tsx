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
import { removeDuplicateCopy } from "@/app/data-quality/actions";

export interface DuplicateFixAccount {
  id: number;
  name: string;
  rows: number;
}

export interface DuplicateFixGroup {
  broker: string;
  brokerLabel: string;
  dedupHash: string;
  symbol: string;
  qty: number;
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

  async function run(t: Target) {
    setBusy(true);
    const res = await removeDuplicateCopy({
      broker: t.group.broker,
      dedupHash: t.group.dedupHash,
      accountId: t.account.id,
    });
    setBusy(false);
    setTarget(null);
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
    router.refresh();
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
                    {g.brokerLabel} · qty {g.qty}
                    {dates(g) ? ` · ${dates(g)}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-muted-foreground">
                  Held in {g.accounts.map((a) => `${a.name} (${a.rows})`).join(", ")}.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {g.accounts.map((a) => (
                    <Button
                      key={a.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setTarget({ group: g, account: a })}
                    >
                      Remove the copy in {a.name}
                    </Button>
                  ))}
                </div>
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-warning" />
              Remove the copy in {target?.account.name}
            </DialogTitle>
            <DialogDescription>
              {target
                ? `${target.account.rows} row${target.account.rows === 1 ? "" : "s"} of ${target.group.symbol} ` +
                  `(${target.group.brokerLabel}, qty ${target.group.qty}) leave ${target.account.name}. ` +
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
