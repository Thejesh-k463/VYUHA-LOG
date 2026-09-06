"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toaster";
import type { InstrumentDisplay } from "@/lib/queries/instruments";

/**
 * Per-instrument results date (owner ruling Q-9, migration 0068).
 *
 * ── IT IS THE SAME WRITE PATTERN AS EVERY OTHER EDIT ON THIS PAGE ──────────
 * Route handler + client `fetch` + `router.refresh()`, exactly as
 * `components/system/instrument-manager.tsx` does for sector / lot size / ISIN.
 * NOT a server action: a server action auto-refreshes the route, which remounts
 * the sibling manager above and silently resets the text it is holding
 * (AGENTS.md, the charge-editor bug).
 *
 * ── WHY A SEPARATE COMPONENT AND NOT A SIXTH COLUMN IN THE MANAGER ─────────
 * `components/system/instrument-manager.tsx` is outside this wave's file set,
 * so the column could not be added to its table. The natural home for this
 * control is that table; until a wave owns both, it lives here, and the
 * builder's report says so.
 *
 * ── WHY THE LIST IS FILTERED AND CAPPED ────────────────────────────────────
 * "Add every symbol in the map" puts ~1,379 rows in this table, and a second
 * un-virtualised full table under the manager's own would double the DOM on
 * that page for a field almost every row leaves blank. So: rows that ALREADY
 * carry a date are always shown (they are the ones the user comes back to
 * change), a filter box reaches any other symbol, and the render is capped with
 * the shortfall STATED rather than silently trimmed.
 *
 * ── NO `useEffect` STATE SYNC ──────────────────────────────────────────────
 * The edit buffer is an overlay map keyed by row id and the displayed value is
 * DERIVED (`edits[id] ?? row.resultsDate ?? ""`). Resetting the buffer from
 * props in an effect is the pattern that broke the Trades filter under the
 * React Compiler (AGENTS.md), and it is not needed: after a successful save the
 * buffer already holds exactly what the server now stores.
 */

const RENDER_CAP = 100;

export function ResultsDateEditor({ rows }: { rows: InstrumentDisplay[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState<number | null>(null);

  const needle = filter.trim().toUpperCase();
  const matching = needle
    ? rows.filter((r) => r.symbol.includes(needle) || (r.name ?? "").toUpperCase().includes(needle))
    : rows.filter((r) => r.resultsDate !== null);
  const shown = matching.slice(0, RENDER_CAP);

  const valueOf = (r: InstrumentDisplay) => edits[r.id] ?? r.resultsDate ?? "";

  async function save(r: InstrumentDisplay, next: string) {
    // The buffer already matches what is stored — nothing to write.
    if (next === (r.resultsDate ?? "")) return;
    setSaving(r.id);
    const res = await fetch("/api/instruments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "results-date", id: r.id, resultsDate: next === "" ? null : next }),
    });
    const data = (await res.json().catch(() => ({ ok: false, message: "Request failed" }))) as {
      ok: boolean;
      message?: string;
    };
    setSaving(null);
    if (data.ok) {
      toast.success(data.message ?? "");
      router.refresh();
    } else {
      toast.error(data.message ?? "");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        The date a company reports, as <b>you</b> record it — Vyuha fetches no results calendar and bundles none.
        It is a date fact about the company, so it travels with the instrument in a backup and shows on the Live
        Desk row as <span className="font-mono">Results in N days</span>. Nothing follows it: the desk states the
        distance and stops there. Clear the field to remove the date.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs" htmlFor="results-date-filter">
            Find a symbol
          </label>
          <Input
            id="results-date-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="RELIANCE"
            className="h-8 w-56"
          />
        </div>
        <p className="pb-1.5 text-[0.6875rem] text-muted-foreground">
          {needle
            ? `${matching.length} of ${rows.length} instruments match.`
            : `${matching.length} of ${rows.length} instruments have a results date. Search to add one.`}
          {matching.length > shown.length ? ` Showing the first ${shown.length} — narrow the search to reach the rest.` : ""}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {rows.length === 0
            ? "No instruments yet — add one above first."
            : needle
              ? "No instrument matches that."
              : "No results dates recorded yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-y border-border text-left text-muted-foreground">
                <th className="px-2.5 py-2 font-medium">Symbol</th>
                <th className="px-2.5 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Results date</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-rule">
                  <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                  <td className="px-2.5 py-1.5 text-muted-foreground">{r.name ?? "—"}</td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="date"
                      aria-label={`Results date for ${r.symbol}`}
                      value={valueOf(r)}
                      disabled={saving === r.id}
                      onChange={(e) => setEdits((m) => ({ ...m, [r.id]: e.target.value }))}
                      onBlur={(e) => void save(r, e.target.value)}
                      className="h-8 w-40"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
