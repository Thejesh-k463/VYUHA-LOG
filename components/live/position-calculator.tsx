"use client";

import * as React from "react";
import { ProLock } from "@/components/system/pro-lock";
import { FormulaBlock } from "@/components/sizing/formula-block";
import { sizeFixedFractional } from "@/lib/risk/sizing";
import { EM_DASH, POSITIONS_COPY } from "./desk-copy";
import * as fmt from "./desk-format";
import type { DeskRow } from "./desk-types";

/**
 * The inline size calculator inside the Positions card (v4.7.0 C4, D10 / ruling P2).
 *
 * PRO. On a free licence the whole block is a `<ProLock/>` — not an empty
 * calculator and not zeros (invariant 6): the defaults it would start from
 * (`row.sizing` — capital and risk %) are not on the free wire at all.
 *
 * NOTHING HERE WRITES. The four inputs are local component state, seeded once
 * from the row (`useState` initialisers — never re-synced from an effect), and
 * the arithmetic is `sizeFixedFractional` from `lib/risk/sizing.ts`, the same
 * function the Sizing Lab prints. A refusal prints that function's own
 * sentence through `FormulaBlock`. "Open in Lab" hands the position to the
 * full Lab, `side` carried, through the desk's one `openLab`.
 *
 * The card remounts this component per row (`key={row.id}` at the call site),
 * so moving j/k to another row starts from that row's defaults.
 */

/** Paise → an editable rupee string ("" for null), two decimals at most. */
function rupeesText(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isFinite(paise)) return "";
  return String(Math.round(paise) / 100);
}

/** An editable rupee string → paise, or null when it is not a positive-or-zero number. */
function toPaise(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** The effective stop the calculator starts from: the recorded one, else the stop tree's level (Pro). */
export function calculatorStopP(row: Pick<DeskRow, "effectiveStopP" | "stop">): number | null {
  if (row.effectiveStopP !== null) return row.effectiveStopP;
  return row.stop.kind === "ok" || row.stop.kind === "zero" ? row.stop.stopP : null;
}

export function PositionCalculator({
  row,
  pro,
  onOpenLab,
}: {
  row: DeskRow;
  pro: boolean;
  onOpenLab: () => void;
}) {
  return (
    <section
      role="region"
      aria-label={POSITIONS_COPY.calcTitle}
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-background/40 p-4 text-[14px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {POSITIONS_COPY.calcTitle}
        </h3>
        {pro && <span className="text-[13px] text-muted-foreground">{POSITIONS_COPY.calcNote}</span>}
      </div>
      {pro ? (
        <CalculatorBody row={row} onOpenLab={onOpenLab} />
      ) : (
        <p className="flex items-center gap-2 text-[14px] text-muted-foreground">
          <ProLock /> {POSITIONS_COPY.calcLocked}
        </p>
      )}
    </section>
  );
}

function CalculatorBody({ row, onOpenLab }: { row: DeskRow; onOpenLab: () => void }) {
  // Seeded ONCE from the row; the user's edits live here and nowhere else.
  const [capital, setCapital] = React.useState(() => rupeesText(row.sizing?.capitalP ?? null));
  const [riskPct, setRiskPct] = React.useState(() =>
    row.sizing ? String(Math.round(row.sizing.riskPpm) / 10_000) : "",
  );
  const [entry, setEntry] = React.useState(() => rupeesText(row.markP ?? row.avgEntryP));
  const [stop, setStop] = React.useState(() => rupeesText(calculatorStopP(row)));

  const capitalP = toPaise(capital);
  const riskNum = Number(riskPct.trim());
  const riskPpm = riskPct.trim() !== "" && Number.isFinite(riskNum) ? Math.round(riskNum * 10_000) : 0;
  const entryP = toPaise(entry);
  const stopP = toPaise(stop);

  // Derived at render — the result is a pure function of the four fields.
  const result = sizeFixedFractional({
    capitalP: capitalP ?? 0,
    riskPpm,
    entryP: entryP ?? 0,
    stopP: stopP ?? 0,
    lotSize: row.lotSize ?? 1,
    atrP3: row.atrP3,
  });

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
  ) => (
    <label className="flex flex-col gap-1 text-[13px] text-muted-foreground" htmlFor={id}>
      {label}
      <input
        id={id}
        type="number"
        step="any"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        className="h-9 rounded-[var(--radius)] border border-border bg-input px-2 font-mono text-[14px] tabular-nums text-foreground"
      />
    </label>
  );

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {field(`calc-capital-${row.id}`, POSITIONS_COPY.calcCapital, capital, setCapital)}
        {field(`calc-risk-${row.id}`, POSITIONS_COPY.calcRisk, riskPct, setRiskPct)}
        {field(`calc-entry-${row.id}`, POSITIONS_COPY.calcEntry, entry, setEntry)}
        {field(`calc-stop-${row.id}`, POSITIONS_COPY.calcStop, stop, setStop)}
      </div>
      {result.ok && (
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Out label={POSITIONS_COPY.calcQty} value={fmt.qty(result.qty)} testId="calc-qty" />
          <Out label={POSITIONS_COPY.calcLots} value={result.lots === null ? EM_DASH : fmt.qty(result.lots)} />
          <Out label={POSITIONS_COPY.calcDeployed} value={fmt.money(result.deployedP)} />
          <Out label={POSITIONS_COPY.calcRiskAtStop} value={fmt.money(result.riskAtStopP)} />
        </dl>
      )}
      {result.ok && result.flags.includes("exceeds-capital") && (
        <p className="text-[13px] text-warning">{POSITIONS_COPY.calcExceedsCapital}</p>
      )}
      {result.ok && result.flags.includes("zero-size") && (
        <p className="text-[13px] text-muted-foreground">{POSITIONS_COPY.calcZeroSize}</p>
      )}
      {/* The formula on success, the function's own refusal sentence otherwise.
          Lifted to 13 px: the card's floor (D9) is above the Lab's 12 px block. */}
      <div className="[&_div]:text-[13px]">
        <FormulaBlock result={result} />
      </div>
      <div>
        <button
          type="button"
          onClick={onOpenLab}
          className="inline-flex h-9 items-center rounded-[var(--radius)] border border-border px-3 text-[14px] hover:bg-card-hover"
        >
          {POSITIONS_COPY.calcOpenLab}
        </button>
      </div>
    </>
  );
}

function Out({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-[18px] font-semibold tabular-nums" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
