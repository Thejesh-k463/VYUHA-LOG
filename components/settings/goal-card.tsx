"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toaster";
import { inr, inrCompact } from "@/lib/format";
import type { GoalBucket, GoalFacts, GoalKind } from "@/lib/analytics/goal";
import { Target, Trash2 } from "lucide-react";

/**
 * Expected Capital goals editor (v3.6, decision #4) — one goal per bucket,
 * absolute ₹ or %-profit, optional target date, baseline frozen at creation.
 * Same shape as capital-card: fetch → toast → router.refresh(), never server
 * actions (recorded convention).
 */

const BUCKETS: { key: GoalBucket; label: string }[] = [
  { key: "equity", label: "Equity" },
  { key: "active", label: "Trade F&O" },
  { key: "total", label: "Total" },
];

export interface GoalCardProps {
  goals: GoalFacts[];
  /** Resolved capital per bucket (0 = unknown) — gates the % kind honestly. */
  capital: { equity: number; active: number; total: number };
  /** All-accounts view: writes are refused server-side; say so up front. */
  aggregate: boolean;
  /** Aggregate view only: buckets whose goals could not be summed. */
  excluded: { bucket: GoalBucket; reason: string }[];
}

export function GoalCard({ goals, capital, aggregate, excluded }: GoalCardProps) {
  // Remount the per-bucket editors when the VIEW changes underneath them.
  // Switching accounts re-renders this card with the new account's facts, but
  // React keeps a same-position component's state — so a half-typed edit of
  // account A's goal would silently save into account B. The card receives no
  // account id, so this fingerprint of every account-varying prop stands in
  // for one: any switch changes goals and/or capital, the key changes, and
  // staged editor state is discarded instead of crossing books.
  const viewKey = JSON.stringify([aggregate, capital, goals]);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Target className="size-4 text-primary" /> Expected capital goals
        </CardTitle>
        {goals.length > 0 && <Badge variant="secondary">{goals.length} set</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        {aggregate ? (
          <p className="text-sm text-muted-foreground">
            The All-accounts view shows each bucket&apos;s goals <b>summed across accounts</b> and cannot edit them —
            a goal belongs to one account&apos;s book. Pick an account in the sidebar to set or change one.
          </p>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-3">
          {BUCKETS.map((b) => (
            <BucketGoal
              key={`${b.key}:${viewKey}`}
              bucket={b.key}
              label={b.label}
              goal={goals.find((g) => g.bucket === b.key) ?? null}
              capitalKnown={capital[b.key === "active" ? "active" : b.key === "equity" ? "equity" : "total"] > 0}
              readOnly={aggregate}
              excludedReason={excluded.find((e) => e.bucket === b.key)?.reason ?? null}
            />
          ))}
        </div>
        <p className="text-[0.6875rem] text-muted-foreground">
          The baseline freezes when a goal is created, so progress measures realised P&L from that day — later
          capital edits are not progress. Editing a goal keeps its baseline; delete and recreate to re-baseline.
          A %-profit goal needs this bucket&apos;s capital configured first, because the percent is of that frozen base.
        </p>
      </CardContent>
    </Card>
  );
}

function BucketGoal({
  bucket,
  label,
  goal,
  capitalKnown,
  readOnly,
  excludedReason,
}: {
  bucket: GoalBucket;
  label: string;
  goal: GoalFacts | null;
  capitalKnown: boolean;
  readOnly: boolean;
  excludedReason: string | null;
}) {
  const router = useRouter();
  // A goal created before capital was configured froze a NULL baseline, and
  // edits keep the frozen baseline by design — so it can never become a
  // %-profit goal by editing, even now that capital IS set. The only
  // re-baseline path is delete + recreate (deliberate: a silent re-baseline
  // at today's capital would quietly restart progress from a fatter base).
  const frozenNullBaseline = goal != null && goal.baselineCapital == null;
  const [editing, setEditing] = React.useState(false);
  const [kind, setKind] = React.useState<GoalKind>(goal?.kind ?? "absolute");
  const [amount, setAmount] = React.useState(goal?.targetAmount != null ? String(goal.targetAmount) : "");
  const [pct, setPct] = React.useState(goal?.pctTarget != null ? String(goal.pctTarget) : "");
  const [date, setDate] = React.useState(goal?.targetDate ?? "");
  const [pending, setPending] = React.useState(false);

  async function call(body: Record<string, unknown>) {
    setPending(true);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      const text = json.message ?? (json.ok ? "Done." : "Failed.");
      if (json.ok) {
        toast.success(text);
        setEditing(false);
        router.refresh();
      } else toast.error(text);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  function save() {
    const targetAmount = kind === "absolute" ? Number(amount) : null;
    const pctTarget = kind === "pct_profit" ? Number(pct) : null;
    if (kind === "absolute" && (!Number.isFinite(targetAmount!) || targetAmount! <= 0)) {
      toast.error("Enter a ₹ target above zero.");
      return;
    }
    if (kind === "pct_profit" && (!Number.isFinite(pctTarget!) || pctTarget! <= 0)) {
      toast.error("Enter a profit % above zero.");
      return;
    }
    void call({ action: "upsert", bucket, kind, targetAmount, pctTarget, targetDate: date || null });
  }

  return (
    <div className="space-y-2 rounded-md border border-border bg-background/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        {goal && !readOnly && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-muted-foreground"
            disabled={pending}
            onClick={() => void call({ action: "delete", bucket })}
            aria-label={`Remove the ${label} goal`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {goal && !editing ? (
        <div className="space-y-1 text-sm">
          <div className="text-base font-semibold tabular-nums">
            {goal.kind === "absolute" ? inrCompact(goal.targetAmount ?? 0) : `+${goal.pctTarget}% profit`}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {goal.kind === "pct_profit" && goal.baselineCapital != null
              ? `of ${inr(goal.baselineCapital, { decimals: 0 })} frozen ${goal.baselineDate}`
              : goal.baselineCapital != null
                ? `from ${inr(goal.baselineCapital, { decimals: 0 })} on ${goal.baselineDate}`
                : `baseline unknown at creation (${goal.baselineDate})`}
            {goal.targetDate ? ` · by ${goal.targetDate}` : ""}
          </div>
          {!readOnly && (
            <Button type="button" variant="outline" size="sm" className="mt-1 h-7" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>
      ) : goal && excludedReason ? (
        <p className="text-[0.6875rem] text-muted-foreground">{excludedReason}</p>
      ) : readOnly ? (
        excludedReason ? (
          <p className="text-[0.6875rem] text-muted-foreground">{excludedReason}</p>
        ) : (
          <p className="text-[0.6875rem] text-muted-foreground">No goal in any account for this bucket.</p>
        )
      ) : (
        <div className="space-y-2">
          <div className="flex gap-1" role="group" aria-label={`${label} goal kind`}>
            <Button
              type="button"
              size="sm"
              className="h-7 flex-1"
              variant={kind === "absolute" ? "default" : "outline"}
              onClick={() => setKind("absolute")}
            >
              ₹ target
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 flex-1"
              variant={kind === "pct_profit" ? "default" : "outline"}
              disabled={!capitalKnown || frozenNullBaseline}
              onClick={() => setKind("pct_profit")}
            >
              % profit
            </Button>
          </div>
          {frozenNullBaseline ? (
            <p className="text-[0.6875rem] text-warning">
              This goal was created before capital was configured, so it has no frozen baseline — a %-profit target
              needs one. Delete and recreate the goal to baseline at today&apos;s capital; edits keep the original
              baseline by design.
            </p>
          ) : !capitalKnown ? (
            <p className="text-[0.6875rem] text-warning">
              %-profit goals need this bucket&apos;s capital configured (Capital &amp; Go-Live above) — the percent is
              of that frozen base. ₹ targets work without it.
            </p>
          ) : null}
          {kind === "absolute" ? (
            <Input
              type="number"
              inputMode="decimal"
              min={1}
              placeholder="Target capital, ₹"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={`${label} ₹ target`}
            />
          ) : (
            <Input
              type="number"
              inputMode="decimal"
              min={1}
              placeholder="Profit target, %"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              aria-label={`${label} % profit target`}
            />
          )}
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={`${label} target date (optional)`} />
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-7" disabled={pending} onClick={save}>
              {pending ? "Saving…" : goal ? "Save" : "Set goal"}
            </Button>
            {goal && (
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
