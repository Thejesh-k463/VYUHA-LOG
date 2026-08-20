"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BROKERS, BROKER_LABELS, type Broker } from "@/lib/domain/constants";
import {
  FIELD_SPECS,
  shapeOf,
  validateMapping,
  type ColumnMapping,
  type GenericField,
} from "@/lib/import/generic-map";
import { AlertCircle, Wand2 } from "lucide-react";

/**
 * "Tell Vyuha what these columns mean."
 *
 * Shown when no hand-written parser recognises a file. This is what makes the
 * importer work with brokers whose export format nobody has published —
 * Kotak Neo and Sahi document theirs nowhere, and guessing at
 * their column names would import quantity into the price field and call it a
 * trade. Asking is the only honest way to read a file we have never seen.
 *
 * The mapping is remembered per broker, so this screen appears once and every
 * later file from that broker imports in a single click.
 */

const KEY = (b: Broker) => `vyuha-import-mapping:${b}`;

export function ColumnMapper({
  headers,
  sampleRows,
  totalRows,
  suggested,
  busy,
  onApply,
}: {
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
  suggested: ColumnMapping;
  busy: boolean;
  onApply: (broker: Broker, mapping: ColumnMapping) => void;
}) {
  const [broker, setBroker] = React.useState<Broker>("kotakneo");
  const [mapping, setMapping] = React.useState<ColumnMapping>(suggested);
  const [restored, setRestored] = React.useState(false);

  // A saved mapping for this broker beats the header guess — the user already
  // corrected it once and should not be asked to do it again.
  React.useEffect(() => {
    let saved: ColumnMapping | null = null;
    try {
      const raw = localStorage.getItem(KEY(broker));
      if (raw) saved = JSON.parse(raw) as ColumnMapping;
    } catch { /* corrupt entry = fall back to the suggestion */ }
    // .then keeps the write async (react-compiler set-state-in-effect rule)
    Promise.resolve().then(() => {
      const usable = saved && Object.keys(saved).some((k) => headers[saved![k as GenericField] ?? -1] !== undefined);
      setMapping(usable ? saved! : suggested);
      setRestored(Boolean(usable));
    });
  }, [broker, suggested, headers]);

  const check = validateMapping(mapping);
  const shape = shapeOf(mapping);
  const fields = FIELD_SPECS.filter((f) => f.shape === shape || f.shape === "both");

  const setField = (field: GenericField, value: string) => {
    setMapping((m) => {
      const next = { ...m };
      if (value === "") delete next[field];
      else next[field] = Number(value);
      return next;
    });
    setRestored(false);
  };

  const apply = () => {
    try {
      localStorage.setItem(KEY(broker), JSON.stringify(mapping));
    } catch { /* private mode — the import still works, it just won't be remembered */ }
    onApply(broker, mapping);
  };

  return (
    <div className="space-y-4 rounded-lg border border-primary/30 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Wand2 className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Tell Vyuha what these columns mean</h3>
        <Badge variant="secondary">{totalRows} row{totalRows === 1 ? "" : "s"}</Badge>
        {restored && <Badge variant="accent">saved mapping restored</Badge>}
      </div>

      <p className="text-xs text-muted-foreground">
        No built-in parser recognised this file, so Vyuha will not guess at it — a column read wrongly
        would put quantity in the price field and book a trade that never happened. Match each column
        once and it is remembered for this broker; later files import in one click.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs text-muted-foreground">Which broker is this file from?</span>
          <Select value={broker} onChange={(e) => setBroker(e.target.value as Broker)} className="h-9">
            {BROKERS.map((b) => (
              <option key={b} value={b}>{BROKER_LABELS[b]}</option>
            ))}
          </Select>
        </label>
        <div className="self-end text-xs text-muted-foreground">
          Reading as{" "}
          <span className="text-foreground">
            {shape === "executions" ? "one row per execution (tradebook)" : "one row per completed trade (P&L)"}
          </span>
          {" — "}
          {shape === "executions"
            ? "buys and sells will be paired into positions — same-day buys and sells net off first, then oldest-lot FIFO."
            : "map a Buy/Sell column instead if each row is a single fill."}
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.field} className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-xs">
              {f.label}
              {f.required && <span className="text-loss"> *</span>}
            </span>
            <Select
              value={mapping[f.field] === undefined ? "" : String(mapping[f.field])}
              onChange={(e) => setField(f.field, e.target.value)}
              className="h-8 flex-1"
              title={f.hint}
            >
              <option value="">— not in this file —</option>
              {headers.map((h, i) => (
                <option key={`${h}-${i}`} value={i}>{h || `(column ${i + 1})`}</option>
              ))}
            </Select>
          </label>
        ))}
      </div>

      {/* The file's own first rows, so a wrong mapping is visible before it is
          applied rather than after it has been committed. */}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[0.6875rem]">
          <thead>
            <tr className="bg-card-hover">
              {headers.map((h, i) => {
                const mapped = (Object.keys(mapping) as GenericField[]).find((k) => mapping[k] === i);
                return (
                  <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                    <div className="text-muted-foreground">{h || `col ${i + 1}`}</div>
                    {mapped && <div className="text-primary">↳ {FIELD_SPECS.find((f) => f.field === mapped)?.label}</div>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sampleRows.map((r, ri) => (
              <tr key={ri} className="border-t border-rule">
                {headers.map((_, ci) => (
                  <td key={ci} className="whitespace-nowrap px-2 py-1 tabular-nums text-muted-foreground">{r[ci] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={apply} disabled={!check.ok || busy}>
          {busy ? "Reading…" : "Preview with this mapping"}
        </Button>
        {!check.ok && (
          <span className="flex items-center gap-1.5 text-xs text-warning">
            <AlertCircle className="size-3.5" />
            Still needed: {check.missing.map((f) => FIELD_SPECS.find((s) => s.field === f)?.label ?? f).join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}
