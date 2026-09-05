"use client";

import * as React from "react";
import { formatPaise } from "@/lib/money";
import { num } from "@/lib/format";
import type { SizeResult } from "@/lib/risk/sizing";
import type { ChargesAdjustedRiskResult } from "@/lib/risk/sizing";

/**
 * The Lab's result tiles (03 §6.4): four always, a fifth when the charges
 * toggle is on (owner Q40 — the headline `₹ at risk` stays GROSS, and the
 * charges figure is an ADDITIONAL tile rather than a quiet redefinition of
 * the headline).
 *
 * Every number arrives as integer paise or ppm and is formatted here, at the
 * edge, with `en-IN` grouping (03 §6.6) — `lib/` never formats. The block is
 * `aria-live="polite"` because the figures change on each keystroke of the
 * setup, and tile values are selectable text (03 §6.8: users paste them).
 */

function ppmToPct(ppm: number | null, decimals = 2): string {
  if (ppm == null) return "—";
  return `${num(ppm / 10_000, decimals)}%`;
}

function Tile({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-card/60 p-3">
      <div className="text-[0.6875rem] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className="select-text pt-1 text-xl font-semibold tabular-nums">{value}</div>
      <div className="pt-0.5 text-[0.6875rem] text-muted-foreground">{note}</div>
    </div>
  );
}

export interface ResultTilesProps {
  result: SizeResult;
  capitalP: number;
  entryP: number;
  lotSize: number;
  deployCapOn: boolean;
  deployCapPpm: number;
  /** Present only while the charges toggle is on — the fifth tile. */
  charges: ChargesAdjustedRiskResult | null;
  /** Which schedule priced the charges, for the tile's own note. */
  ratesLabel: string | null;
}

export function ResultTiles(p: ResultTilesProps) {
  const { result: r } = p;

  return (
    <div
      aria-live="polite"
      className={`grid gap-2 sm:grid-cols-2 ${p.charges ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}
    >
      <Tile
        label="Shares computed"
        value={r.ok ? num(r.qty, 0) : "—"}
        note={p.lotSize > 1 ? `lot size ${num(p.lotSize, 0)}, floored` : "floored to whole shares"}
      />
      <Tile
        label="₹ deployed"
        value={r.ok ? formatPaise(r.deployedP, { decimals: 0 }) : "—"}
        note={r.ok ? `${num(r.qty, 0)} × ${formatPaise(p.entryP)}` : "no size to deploy"}
      />
      <Tile
        label="% of capital"
        value={ppmToPct(r.ok ? r.pctOfCapitalPpm : null, 1)}
        note={
          <>
            of {formatPaise(p.capitalP, { decimals: 0 })}
            {p.deployCapOn ? ` · cap ${ppmToPct(p.deployCapPpm, 0)}` : ""}
          </>
        }
      />
      <Tile
        label="₹ at risk if the stop is hit"
        value={r.ok ? formatPaise(r.riskAtStopP, { decimals: 0 }) : "—"}
        note={
          r.ok ? (
            <>{ppmToPct(r.riskPctOfCapitalPpm)} of capital · before charges</>
          ) : (
            "risk per share is zero at these prices"
          )
        }
      />
      {p.charges ? (
        <Tile
          label="₹ at risk incl. charges"
          value={formatPaise(p.charges.effectiveRiskP, { decimals: 0 })}
          note={
            <>
              charges add {ppmToPct(p.charges.chargeUpliftPpm, 1)} to R
              {p.ratesLabel ? ` · ${p.ratesLabel}` : ""}
            </>
          }
        />
      ) : null}
    </div>
  );
}

/** The flags row beneath the tiles — facts about the arithmetic, never advice. */
export function FlagRow({ result }: { result: SizeResult }) {
  const labels: string[] = [];
  for (const f of result.flags) {
    if (f === "deploy-capped") labels.push("clipped by the deploy cap");
    else if (f === "exceeds-capital") labels.push("deployment is larger than capital");
    else if (f === "wider-than-n-stop") {
      const n = result.stopToNPermille;
      labels.push(n == null ? "stop is wider than the method's own N-stop" : `stop is ${num(n / 1000, 2)} N — wider than the method's own N-stop`);
    } else if (f === "non-positive-kelly") labels.push("the Kelly fraction is not positive at these inputs");
    else if (f === "zero-size") labels.push("the computed size is zero");
  }
  if (labels.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 pt-2">
      {labels.map((l) => (
        <span
          key={l}
          className="rounded-[var(--radius-pill)] border border-warning/40 bg-warning/[0.07] px-2 py-0.5 text-[0.6875rem] text-warning"
        >
          {l}
        </span>
      ))}
    </div>
  );
}
