"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { Segment } from "@/lib/domain/constants";
import type {
  JournalKellyOk,
  JournalKellyResponse,
  JournalKellySlice,
  JournalKellyWindow,
} from "@/lib/analytics/journal-kelly";
import {
  JOURNAL_CEILING_FLAG,
  journalCeilingLine,
  journalRefusalLine,
  journalSampleLine,
  kellyExceedsCeiling,
} from "./lab-config";

/**
 * v4.7.0 C3 — "Use my journal" on the Sizing Lab's Kelly tab (design D3, D9, D10).
 *
 * Reads GET /api/sizing/journal-kelly for ONE slice of the selected account —
 * the whole account by default, a segment or a segment × setup when the user
 * narrows it, never a ranked list (K4) — over all dates or the last 12 months
 * (K5, off by default). It fetches on mount (the Kelly tab opening), on a slice
 * or window change, and when the server re-renders the page (`serverRender`
 * changes identity only then — e.g. `router.refresh()` after an account switch),
 * and every setState runs in the fetch's callback, never synchronously in an
 * effect. NOTHING fills on any of those: the two Kelly fields change only on the
 * button's click, through the parent's `onUse` (R8, D12) — and the Kelly
 * fraction is never touched.
 */

interface Sel {
  key: string;
  segment: Segment | null;
  setup: string | null;
}

const BOOK: Sel = { key: "all|all", segment: null, setup: null };

interface Loaded {
  query: string;
  body: JournalKellyResponse | null;
  error: string | null;
}

export interface JournalKellyPanelProps {
  /** The Lab's current Kelly row `kellyFUsedPpm` (null when Kelly returns no size). */
  kellyFUsedPpm: number | null;
  /** Applies the measured p and b — the ONLY write this panel can cause. */
  onUse: (result: JournalKellyOk) => void;
  /** Any value whose identity changes only when the server re-renders the page. */
  serverRender: unknown;
}

const GROUPS: { kind: JournalKellySlice["kind"]; label: string }[] = [
  { kind: "book", label: "Whole account" },
  { kind: "segment", label: "By segment" },
  { kind: "setup", label: "By segment and setup" },
];

export function JournalKellyPanel({ kellyFUsedPpm, onUse, serverRender }: JournalKellyPanelProps) {
  const [sel, setSel] = React.useState<Sel>(BOOK);
  const [last12, setLast12] = React.useState(false);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);

  const span: JournalKellyWindow = last12 ? "12m" : "all";
  const qs = new URLSearchParams();
  if (sel.segment) qs.set("segment", sel.segment);
  if (sel.segment && sel.setup != null) qs.set("setup", sel.setup);
  qs.set("window", span);
  const query = qs.toString();

  React.useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/sizing/journal-kelly?${query}`, { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as (JournalKellyResponse & { message?: string }) | null;
        if (ctl.signal.aborted) return;
        if (!res.ok || !body || !("result" in body)) {
          setLoaded({ query, body: null, error: body?.message ?? "Your journal could not be read just now." });
          return;
        }
        setLoaded({ query, body, error: null });
      })
      .catch(() => {
        if (ctl.signal.aborted) return;
        setLoaded({ query, body: null, error: "Your journal could not be read just now." });
      });
    return () => ctl.abort();
  }, [query, serverRender]);

  // Derived, every render: the answer for THIS query, or nothing yet.
  const current = loaded?.query === query ? loaded : null;
  const result = current?.body?.result ?? null;
  // The slice list stays on screen while the next answer loads.
  const slices = loaded?.body?.slices ?? [];
  const ok = result != null && result.ok ? result : null;
  const refusal = result != null && !result.ok ? result : null;
  const allView = refusal?.reason === "all-view";
  // Both sides per 1R (owner Q3): the Lab's risk budget and the Clinic's per-1R ceiling.
  const flagged = ok != null && kellyExceedsCeiling(kellyFUsedPpm, ok.halfKellyLowerBound);

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-[0.6875rem]" data-journal-kelly="">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <Label htmlFor="lab-jk-slice">Measure from</Label>
          <Select
            id="lab-jk-slice"
            className="h-8 text-xs"
            disabled={allView || slices.length === 0}
            value={sel.key}
            onChange={(e) => {
              const s = slices.find((x) => x.key === e.target.value);
              setSel(s ? { key: s.key, segment: s.segment, setup: s.setup } : BOOK);
            }}
          >
            {slices.length === 0 ? <option value={BOOK.key}>Whole account</option> : null}
            {GROUPS.map((g) => {
              const items = slices.filter((s) => s.kind === g.kind);
              if (items.length === 0) return null;
              return (
                <optgroup key={g.kind} label={g.label}>
                  {items.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label} — {s.n} of {s.of}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={last12}
            disabled={allView}
            onChange={(e) => setLast12(e.target.checked)}
            aria-label="Last 12 months only"
          />
          Last 12 months
        </label>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={ok == null}
          onClick={() => {
            if (ok) onUse(ok);
          }}
        >
          Use my journal
        </Button>
      </div>

      <div className="space-y-1 text-muted-foreground" aria-live="polite">
        {current == null ? (
          <p>Reading your journal…</p>
        ) : current.error ? (
          <p>{current.error}</p>
        ) : ok ? (
          <>
            <p data-journal-sample="">{journalSampleLine(ok, span)}</p>
            <p data-journal-ceiling="" data-supports={ok.supportsSizingUp ? "yes" : "no"}>
              {journalCeilingLine(ok)}
            </p>
            {flagged ? (
              <p className="text-warning" data-journal-flag="">
                {JOURNAL_CEILING_FLAG}
              </p>
            ) : null}
            <p>The two fields change only when you press the button; the Kelly fraction stays yours.</p>
          </>
        ) : refusal ? (
          <p data-journal-refusal={refusal.reason}>{journalRefusalLine(refusal)}</p>
        ) : null}
      </div>
    </div>
  );
}
