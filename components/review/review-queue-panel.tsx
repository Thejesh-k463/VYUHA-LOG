"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShowMore, useRowWindow } from "@/components/ui/show-more";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toaster";
import { JournalDialog, type PlaybookOption } from "@/components/behavior/journal-dialog";
import { useStoredValue, writeStored } from "@/components/layout/use-stored-value";
import { MISTAKE_LABELS, MISTAKE_TAGS } from "@/lib/analytics/behavior";
import type { SlimTrade } from "@/lib/domain/slim-trade";
import { inr, num } from "@/lib/format";
import {
  REVIEW_PREFS_KEY,
  REVIEW_SCOPES,
  REVIEW_SCOPE_LABELS,
  REVIEW_SORTS,
  REVIEW_SORT_LABELS,
  reviewPrefsOrDefault,
  serialiseReviewPrefs,
  type ReviewPrefs,
} from "./review-prefs";

/**
 * PANEL 2 — the queue of closed trades with no review stamp.
 *
 * Reuses the EXISTING journal dialog (components/behavior/journal-dialog.tsx)
 * rather than forking a second review form: a fork would drift, and the journal
 * route already stamps `reviewed_at` on save. "Mark reviewed" is the other
 * path — a trade the trader has nothing to add to still gets read, and saying
 * so is a legitimate outcome of a review.
 *
 * TWO windows are in play and BOTH are stated. The server sends at most
 * `limit` rows out of `total` (lib/queries/review.ts), and this list renders a
 * further slice of what arrived. Neither is allowed to look like the whole
 * book — a silent `.slice()` reads as "this is everything".
 *
 * Filter, sort and the fold on already-reviewed rows are per-device chrome, so
 * they live in localStorage behind a versioned envelope (`review-prefs.ts`) and
 * never touch the database.
 */

const dash = "—";

function tone(v: number): string {
  return v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground";
}

function inWeek(t: SlimTrade, weekStart: string, weekEnd: string): boolean {
  return t.sellDate != null && t.sellDate >= weekStart && t.sellDate <= weekEnd;
}

function sortRows(rows: SlimTrade[], sort: ReviewPrefs["sort"]): SlimTrade[] {
  const byDate = (a: SlimTrade, b: SlimTrade, dir: 1 | -1) => {
    // A closed trade with no sell date sorts last either way: it has no place
    // on a timeline, and pretending it does would put it where a date would.
    if (a.sellDate === b.sellDate) return b.id - a.id;
    if (!a.sellDate) return 1;
    if (!b.sellDate) return -1;
    return a.sellDate < b.sellDate ? dir : -dir;
  };
  const out = [...rows];
  if (sort === "worst") out.sort((a, b) => a.netPnl - b.netPnl);
  else out.sort((a, b) => byDate(a, b, sort === "oldest" ? -1 : 1));
  return out;
}

function TradeLine({ trade }: { trade: SlimTrade }) {
  const tags = trade.mistakeTags ?? [];
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
      <span className="w-28 shrink-0 font-medium">{trade.symbol}</span>
      <span className="text-muted-foreground">{trade.sellDate ?? dash}</span>
      <span className={`tabular-nums ${tone(trade.netPnl)}`}>{inr(trade.netPnl)}</span>
      <span className="text-muted-foreground tabular-nums">
        R {trade.rMultiple == null ? dash : num(trade.rMultiple, 2)}
      </span>
      {tags.length > 0 && (
        <span className="text-muted-foreground">
          {tags.map((t) => MISTAKE_LABELS[t as keyof typeof MISTAKE_LABELS] ?? t).join(", ")}
        </span>
      )}
    </div>
  );
}

export function ReviewQueuePanel({
  rows,
  total,
  limit,
  reviewed,
  reviewedTotal,
  reviewedLimit,
  playbooks,
  weekStart,
  weekEnd,
  aggregateView,
}: {
  /** The server's window of unreviewed closed trades, newest close first. */
  rows: SlimTrade[];
  /** The UNWINDOWED count of unreviewed closed trades. */
  total: number;
  /** The window the server applied. */
  limit: number;
  /** Recently stamped trades, so a stamp made by mistake can be withdrawn. */
  reviewed: SlimTrade[];
  /** How many stamped trades the book actually holds — `reviewed` is a slice. */
  reviewedTotal: number;
  /** The slice the page applied. Stated, never silent. */
  reviewedLimit: number;
  playbooks: PlaybookOption[];
  weekStart: string;
  weekEnd: string;
  /** All-accounts view: reads work, writes are refused (0 is a view). */
  aggregateView: boolean;
}) {
  const router = useRouter();
  const prefs = reviewPrefsOrDefault(useStoredValue(REVIEW_PREFS_KEY));
  const [journaling, setJournaling] = React.useState<SlimTrade | null>(null);
  const [pendingId, setPendingId] = React.useState<number | null>(null);

  const setPrefs = React.useCallback(
    (patch: Partial<ReviewPrefs>) => writeStored(REVIEW_PREFS_KEY, serialiseReviewPrefs({ ...prefs, ...patch })),
    [prefs],
  );

  const filtered = React.useMemo(() => {
    let out = rows;
    if (prefs.scope === "week") out = out.filter((t) => inWeek(t, weekStart, weekEnd));
    if (prefs.tag) out = out.filter((t) => (t.mistakeTags ?? []).includes(prefs.tag));
    return sortRows(out, prefs.sort);
  }, [rows, prefs.scope, prefs.tag, prefs.sort, weekStart, weekEnd]);

  const win = useRowWindow(filtered);

  async function post(body: Record<string, unknown>, id: number) {
    setPendingId(id);
    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string };
      if (data.ok) {
        toast.success(data.message ?? "Saved.");
        router.refresh();
      } else {
        toast.error(data.message ?? "That did not go through.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPendingId(null);
    }
  }

  const heldBack = total - rows.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review queue</CardTitle>
        <p className="text-xs text-muted-foreground">
          Closed trades carrying no review stamp yet. Saving the journal stamps one; so does marking it
          reviewed when there is nothing to add.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="review-scope">Show</Label>
            <Select
              id="review-scope"
              value={prefs.scope}
              onChange={(e) => setPrefs({ scope: e.target.value as ReviewPrefs["scope"] })}
            >
              {REVIEW_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {REVIEW_SCOPE_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="review-sort">Order</Label>
            <Select
              id="review-sort"
              value={prefs.sort}
              onChange={(e) => setPrefs({ sort: e.target.value as ReviewPrefs["sort"] })}
            >
              {REVIEW_SORTS.map((s) => (
                <option key={s} value={s}>
                  {REVIEW_SORT_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="review-tag">Mistake tag</Label>
            <Select id="review-tag" value={prefs.tag} onChange={(e) => setPrefs({ tag: e.target.value })}>
              <option value="">Every tag</option>
              {MISTAKE_TAGS.map((t) => (
                <option key={t} value={t}>
                  {MISTAKE_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <p className="text-xs text-muted-foreground" data-testid="queue-window">
          {filtered.length} of {total} unreviewed trade{total === 1 ? "" : "s"} match this filter
          {heldBack > 0
            ? `. The newest ${limit} are loaded here; ${heldBack} older ${heldBack === 1 ? "one is" : "ones are"} not on this page.`
            : "."}
        </p>

        {filtered.length === 0 ? (
          <EmptyState
            variant="chart"
            title="Nothing in the queue under this filter"
            hint="Every closed trade this filter covers already carries a review stamp."
          />
        ) : (
          <div className="rounded-md border border-border">
            {win.visible.map((t) => (
              <div
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-2.5 py-2 first:border-t-0"
              >
                <TradeLine trade={t} />
                <div className="flex shrink-0 items-center gap-2">
                  {/* Saving the journal stamps `reviewed_at`, which takes the
                      row out of the queue — a write, and so refused in the
                      All-accounts view exactly like the two buttons beside it.
                      Leaving it live contradicted the notice below it. */}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={aggregateView}
                    onClick={() => setJournaling(t)}
                  >
                    Open journal
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pendingId === t.id || aggregateView}
                    onClick={() => post({ action: "mark-reviewed", id: t.id }, t.id)}
                  >
                    Mark reviewed
                  </Button>
                </div>
              </div>
            ))}
            <ShowMore hidden={win.hidden} total={win.total} onClick={win.showMore} noun="queued trades" />
          </div>
        )}

        {aggregateView && (
          <p className="text-xs text-warning">
            The All-accounts view reads only, so the journal, the stamps and Reopen are switched off here.
            Pick one account in the sidebar and they write to that book.
          </p>
        )}

        <div className="space-y-2 border-t border-rule pt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium" data-testid="reviewed-count">
              Recently reviewed ({reviewed.length} of {reviewedTotal})
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPrefs({ hideReviewed: !prefs.hideReviewed })}>
              {prefs.hideReviewed ? "Show reviewed" : "Hide reviewed"}
            </Button>
          </div>
          {!prefs.hideReviewed && reviewedTotal > reviewed.length && (
            <p className="text-xs text-muted-foreground" data-testid="reviewed-window">
              The {reviewedLimit} most recently stamped are listed here; {reviewedTotal - reviewed.length}{" "}
              older stamped trade{reviewedTotal - reviewed.length === 1 ? " is" : "s are"} not on this page.
            </p>
          )}
          {!prefs.hideReviewed &&
            (reviewed.length === 0 ? (
              <p className="text-xs text-muted-foreground">No trade on this account carries a stamp yet.</p>
            ) : (
              <div className="rounded-md border border-border">
                {reviewed.map((t) => (
                  <div
                    key={t.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-2.5 py-2 first:border-t-0"
                  >
                    <TradeLine trade={t} />
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Reviewed {(t.reviewedAt ?? "").slice(0, 10) || dash}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pendingId === t.id || aggregateView}
                        onClick={() => post({ action: "reopen", id: t.id }, t.id)}
                      >
                        Reopen
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
        </div>
      </CardContent>

      <Dialog open={!!journaling} onOpenChange={(o) => !o && setJournaling(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Trade journal — {journaling?.symbol}</DialogTitle>
            <DialogDescription>
              Saving this also stamps the trade reviewed, which is what takes it out of the queue.
            </DialogDescription>
          </DialogHeader>
          {journaling && (
            <JournalDialog trade={journaling} playbooks={playbooks} onDone={() => setJournaling(null)} />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
