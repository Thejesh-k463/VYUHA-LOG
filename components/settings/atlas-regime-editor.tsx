"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import { DEFAULT_REGIME_THRESHOLDS, type RegimeThresholds } from "@/lib/atlas/regime";
import { isDefaultRegimeThresholds, parseRegimeThresholds, REGIME_PPM_MAX } from "@/lib/atlas/regime-thresholds";

/**
 * The Atlas regime thresholds editor (v4.6.0 W5, owner ruling AQ13).
 *
 * The four numbers the regime card prints become a SETTING: the two %-above-
 * SMA50 bounds (entered as percentages, stored as ppm) and the two net
 * high−low bounds (whole symbols). They travel WITH the journal (a per-journal
 * analytic preference, not a machine preference — two machines, one journal,
 * one regime label), and "Reset to defaults" returns the column to NULL.
 *
 * WRITE PATH: route handler + client `fetch` + `router.refresh()` — never a
 * server action (AGENTS.md: a server action remounts sibling client editors
 * and silently resets their state). The route (`POST /api/settings`, type
 * `atlas-regime`) validates with the same pure helper the stored column is
 * parsed with, and its 400 message is echoed INLINE, verbatim: the user reads
 * why the edit was refused where they typed it.
 *
 * DERIVED, NOT SYNCED: the draft is keyed on the stored column's raw string.
 * After a save, `router.refresh()` hands the card a new `stored`, the draft's
 * key no longer matches, and the inputs derive from the fresh row — no
 * setState in an effect (the pattern AGENTS.md bans).
 */

type Field = keyof RegimeThresholds;

const FIELDS: { key: Field; label: string; unit: "pct" | "count"; hint: string }[] = [
  { key: "expansionAboveSma50Ppm", label: "Expansion needs above-SMA50 ≥", unit: "pct", hint: "% of the measurable universe" },
  { key: "expansionNetHighLow", label: "AND net new high − new low >", unit: "count", hint: "symbols" },
  { key: "contractionAboveSma50Ppm", label: "Contraction needs above-SMA50 ≤", unit: "pct", hint: "% of the measurable universe" },
  { key: "contractionNetHighLow", label: "OR net new high − new low <", unit: "count", hint: "symbols" },
];

/** ppm → the percentage string the input shows; a count → itself. */
function toInput(key: Field, v: number): string {
  return FIELDS.find((f) => f.key === key)!.unit === "pct" ? String(v / 10_000) : String(v);
}

/**
 * The typed strings → thresholds in ppm / counts. A non-number stays a
 * non-number (NaN) so the route says so — INCLUDING a cleared field:
 * `Number("") === 0`, so a blank input used to post 0 and a 0% contraction
 * ceiling saved silently. NaN serialises as `null`, which the route's
 * `thresholdsFromObject` refuses with "All four thresholds are required, as
 * numbers." (W5 skeptic item 2).
 */
export function fromInputs(values: Record<Field, string>): Record<Field, number> {
  const out = {} as Record<Field, number>;
  for (const f of FIELDS) {
    const raw = String(values[f.key] ?? "").trim();
    const n = raw === "" ? NaN : Number(raw);
    out[f.key] = f.unit === "pct" ? Math.round(n * 10_000) : n;
  }
  return out;
}

function valuesOf(t: RegimeThresholds): Record<Field, string> {
  const out = {} as Record<Field, string>;
  for (const f of FIELDS) out[f.key] = toInput(f.key, t[f.key]);
  return out;
}

/**
 * POST the edit (or the reset) and hand back the ROUTE'S OWN sentence. A 400
 * is returned as `{ ok: false, message }` with the server's message VERBATIM —
 * never paraphrased, never swallowed — so the card can print exactly why the
 * edit was refused. Exported so the echo rule is unit-tested without a DOM.
 */
export async function submitRegime(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetchImpl("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "atlas-regime", ...body }),
    });
    const data = (await res.json()) as { ok?: boolean; message?: string };
    if (!res.ok || !data.ok) return { ok: false, message: data.message ?? `Request failed (${res.status}).` };
    return { ok: true, message: data.message ?? "Saved." };
  } catch {
    return { ok: false, message: "Could not reach the app's own server." };
  }
}

export function AtlasRegimeEditor({ stored }: { stored: string | null }) {
  const router = useRouter();
  const current = parseRegimeThresholds(stored) ?? DEFAULT_REGIME_THRESHOLDS;
  const isDefault = isDefaultRegimeThresholds(current);

  const [draft, setDraft] = React.useState<{ base: string | null; values: Record<Field, string> } | null>(null);
  const values = draft && draft.base === stored ? draft.values : valuesOf(current);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const edit = (key: Field, v: string) => {
    setError(null);
    setDraft({ base: stored, values: { ...values, [key]: v } });
  };

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const r = await submitRegime(body);
    setBusy(false);
    if (!r.ok) {
      // The route's own sentence, inline — never paraphrased.
      setError(r.message);
      return;
    }
    toast.success(r.message);
    setDraft(null);
    router.refresh();
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-card-hover/40 px-3 py-2 sm:col-span-2" data-testid="atlas-regime-editor">
      <div>
        <div className="text-sm font-medium">Atlas regime thresholds</div>
        <div className="text-xs text-muted-foreground">
          The four bounds the Market Atlas regime card prints. Both percentages lie between 0 and{" "}
          {(REGIME_PPM_MAX / 10_000).toLocaleString("en-IN")}; each contraction bound stays below its expansion bound.
          The label is re-read against these on the next Atlas view — nothing is recomputed, and the stored rows are
          untouched. Saved with the journal, not per machine.{" "}
          {isDefault ? "Currently the shipped defaults." : "Currently edited from the defaults."}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{f.label}</span>
            <span className="flex items-center gap-2">
              <Input
                type="number"
                step={f.unit === "pct" ? 0.1 : 1}
                value={values[f.key]}
                onChange={(e) => edit(f.key, e.target.value)}
                aria-label={f.label}
                data-testid={`atlas-regime-${f.key}`}
                className="h-8 w-28"
              />
              <span className="text-muted-foreground">{f.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {error ? (
        <p className="rounded-md border border-loss/40 bg-loss/5 p-2 text-xs text-foreground" role="alert" data-testid="atlas-regime-error">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => post({ thresholds: fromInputs(values) })} data-testid="atlas-regime-save">
          Save thresholds
        </Button>
        <Button size="sm" variant="outline" disabled={busy || isDefault} onClick={() => post({ reset: true })} data-testid="atlas-regime-reset">
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
