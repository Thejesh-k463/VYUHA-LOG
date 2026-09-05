"use client";

import * as React from "react";
import { formatPaise } from "@/lib/money";
import { num } from "@/lib/format";
import { LAB_METHODS } from "./lab-config";
import type { SizeResult, SizingMethodId } from "@/lib/risk/sizing";

/**
 * All seven rulebooks at once (03 §6.5).
 *
 * The rows are `compareAll`'s own output in `compareAll`'s own order, so the
 * table can never lag the tab: one computation feeds both. A method whose
 * inputs are missing keeps its ROW and states its error — dropping it would
 * make the reader think six methods exist today and seven tomorrow.
 *
 * Sortable by any numeric column, and sorting is the only ordering the user
 * gets: nothing here marks a row as preferred, colours a method, or ranks by
 * outcome.
 */

type SortKey = "qty" | "deployedP" | "pctOfCapitalPpm" | "riskAtStopP" | "riskPctOfCapitalPpm";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "qty", label: "Shares" },
  { key: "deployedP", label: "₹ deployed" },
  { key: "pctOfCapitalPpm", label: "% of capital" },
  { key: "riskAtStopP", label: "₹ at risk if the stop is hit" },
  { key: "riskPctOfCapitalPpm", label: "Risk as % capital" },
];

const FLAG_LABELS: Record<string, string> = {
  "deploy-capped": "deploy-capped",
  "exceeds-capital": "exceeds capital",
  "wider-than-n-stop": "wider than N-stop",
  "non-positive-kelly": "Kelly fraction not positive",
  "zero-size": "zero size",
};

function ppm(v: number | null, decimals = 2): string {
  return v == null ? "—" : `${num(v / 10_000, decimals)}%`;
}

function labelFor(id: SizingMethodId): string {
  return LAB_METHODS.find((m) => m.id === id)?.label ?? id;
}

export function CompareTable({
  rows,
  active,
  onSelect,
}: {
  rows: SizeResult[];
  active: SizingMethodId;
  onSelect: (id: SizingMethodId) => void;
}) {
  const [sortKey, setSortKey] = React.useState<SortKey | null>(null);
  const [dir, setDir] = React.useState<1 | -1>(-1);

  // Derived at render, not synced into state through an effect: the rows prop
  // changes on every keystroke of the setup, and a state mirror of it would be
  // exactly the stale-filter pattern that broke the Trades view.
  const ordered = React.useMemo(() => {
    if (!sortKey) return rows;
    return [...rows].sort((a, b) => ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir);
  }, [rows, sortKey, dir]);

  function toggle(k: SortKey) {
    if (k === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setDir(-1);
    }
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-2 text-left font-medium">Method</th>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                className="px-2 py-2 text-right font-medium"
                aria-sort={sortKey === c.key ? (dir === 1 ? "ascending" : "descending") : "none"}
              >
                <button type="button" onClick={() => toggle(c.key)} className="underline-offset-2 hover:underline">
                  {c.label}
                </button>
              </th>
            ))}
            <th className="px-2 py-2 text-left font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr
              key={r.method}
              onClick={() => onSelect(r.method)}
              className={`cursor-pointer border-b border-border/50 ${
                r.method === active ? "bg-primary/[0.06]" : "hover:bg-card-hover"
              }`}
            >
              <th scope="row" className="px-2 py-1.5 text-left font-normal">
                {labelFor(r.method)}
              </th>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.ok ? num(r.qty, 0) : "—"}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {r.ok ? formatPaise(r.deployedP, { decimals: 0 }) : "—"}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{ppm(r.ok ? r.pctOfCapitalPpm : null, 1)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {r.ok ? formatPaise(r.riskAtStopP, { decimals: 0 }) : "—"}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{ppm(r.ok ? r.riskPctOfCapitalPpm : null)}</td>
              <td className="px-2 py-1.5 text-left text-muted-foreground">
                {r.ok
                  ? r.flags.length
                    ? r.flags.map((f) => FLAG_LABELS[f] ?? f).join(" · ")
                    : "—"
                  : `inputs incomplete (${r.error})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
