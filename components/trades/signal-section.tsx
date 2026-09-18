"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  SIGNAL_EXIT_STATUSES,
  SIGNAL_MODELS,
  SIGNAL_NUMBER_FIELDS,
  classifyStoredSignal,
  parseSignal,
  prefillLadder,
  type SignalNumberField,
} from "@/lib/domain/signal";

/**
 * THE SIGNAL SECTION — the entry door of the Signal book (v4.3.0).
 *
 * ── IT POSTS RAW STRINGS, AND NOTHING ELSE ──────────────────────────────────
 *
 * Every field goes on the wire exactly as typed, under `signal.<field>`, beside
 * one hidden `signalPresent`. The envelope is built SERVER-SIDE by
 * `signalFromForm` (lib/domain/signal.ts), which REFUSES a non-blank field that
 * is not a finite number. Serialising here instead would make the refusal
 * unreachable: "14,48" or "abc" would become null in the browser and arrive as
 * a gap the server was never told about — a ladder silently stored short, and
 * block A judging the trade against it for the life of the trade.
 *
 * ── NOTHING IS SYNCED IN AN EFFECT ──────────────────────────────────────────
 *
 * The T1/T2/SL prefill is DERIVED at render from the entry price and a per-field
 * touched flag (AGENTS.md: derive instead of resetting state in an effect —
 * that shape broke the Trades view filter outright under the React Compiler).
 * The value shown is the value emitted, always: there is no second copy to drift.
 *
 * ── WHEN IT SAYS ANYTHING AT ALL ────────────────────────────────────────────
 *
 * On ADD the toggle starts OFF, and with it off NOTHING is posted — a trade
 * entered without a signal is not a signal trade. On EDIT it posts only once an
 * input is DIRTY, so opening the dialog to fix a sell date cannot rewrite, or
 * blank, a signal the user did not look at.
 *
 * ── AN ENVELOPE FROM A NEWER VERSION IS SHOWN, NOT EDITED ───────────────────
 *
 * `parseSignal` answers null for a `v:2` value, so the fields would seed blank
 * and one keystroke would replace it with a one-field v1. The section renders
 * read-only instead, and `updateManualTrade` keeps the stored value and says so.
 */

type Mode = "add" | "edit";

const LABELS: Record<SignalNumberField, string> = {
  spot: "Spot",
  zoneLow: "Zone low",
  zoneHigh: "Zone high",
  distPct: "Distance %",
  moneynessPct: "Moneyness %",
  strikeOi: "Strike OI",
  oiChgPct: "ΔOI %",
  oiValueCr: "OI value (₹ Cr)",
  score: "Score",
  cprPct: "CPR %",
  volume: "Volume",
  rank: "Rank",
  dayHigh: "Day high",
  dayLow: "Day low",
  t1: "T1",
  t2: "T2",
  sl: "SL",
};

const LADDER_FIELDS: readonly SignalNumberField[] = ["t1", "t2", "sl"];

const STATUS_LABELS: Record<string, string> = {
  T1_HIT: "Target 1 hit",
  T2_HIT: "Target 2 hit (scale-out)",
  SL_HIT: "SL hit",
  EOD_PROFIT: "EOD close, in profit",
  EOD_LOSS: "EOD close, at a loss",
};

type Values = Record<string, string>;

function seedFrom(storedJson: string | null | undefined): Values {
  const s = parseSignal(storedJson);
  const v: Values = { model: s?.model ?? "", exitStatus: s?.exitStatus ?? "" };
  for (const k of SIGNAL_NUMBER_FIELDS) v[k] = s?.[k] != null ? String(s[k]) : "";
  return v;
}

export function SignalSection({
  mode,
  entry,
  storedJson = null,
}: {
  mode: Mode;
  /** The entry premium as the form holds it — the prefill's only input. */
  entry: string;
  /** Edit only: the row's stored `signal_json`. */
  storedJson?: string | null;
}) {
  const [on, setOn] = useState(false);
  const [values, setValues] = useState<Values>(() => seedFrom(storedJson));
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const stored = classifyStoredSignal(storedJson);
  if (mode === "edit" && stored === "unreadable") {
    return (
      <Wrapper>
        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          This trade&apos;s signal was recorded by a <b className="text-foreground">newer version of Vyuha</b> than this one, so it
          is shown nowhere and edited nowhere here. Saving this form leaves it exactly as it is.
        </p>
      </Wrapper>
    );
  }

  const dirty = Object.values(touched).some(Boolean);
  // The ladder is offered only where there is nothing to overwrite: on Add, and
  // on an option that has never carried a signal. An existing signal's blank
  // levels stay blank — otherwise dirtying `model` alone would store a
  // +30/+60/−25 ladder the trade was never taken on, and block A would then
  // judge the exit against levels the user never set (design review 2b).
  const prefillApplies = mode === "add" || stored === "absent" || stored === "cleared";
  const ladder = prefillApplies ? prefillLadder(Number(entry)) : null;

  /** What the field SHOWS — and therefore what it posts. */
  const shown = (k: string): string => {
    if (!touched[k] && ladder && (LADDER_FIELDS as readonly string[]).includes(k)) {
      return String(ladder[k as "t1" | "t2" | "sl"]);
    }
    return values[k] ?? "";
  };

  const set = (k: string) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  };

  const emitting = mode === "add" ? on : dirty;
  const expanded = mode === "add" ? on : true;

  return (
    <Wrapper>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-foreground">Signal</p>
          <p className="text-[0.6875rem] text-muted-foreground">
            {mode === "add"
              ? "Record the signal for this trade — model, zone, OI and the T1/T2/SL ladder."
              : "The signal this trade was taken on. Nothing here is saved until you change something."}
          </p>
        </div>
        {mode === "add" && (
          <button
            type="button"
            onClick={() => setOn((x) => !x)}
            aria-pressed={on}
            className={`shrink-0 rounded-md border px-2.5 py-1 text-[0.6875rem] font-medium transition-colors ${
              on ? "border-primary/40 bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {on ? "Recording" : "Record the signal"}
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs">Model</Label>
            <Select value={shown("model")} onChange={set("model")}>
              <option value="">—</option>
              {SIGNAL_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </div>
          {SIGNAL_NUMBER_FIELDS.map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs">{LABELS[k]}</Label>
              <Input
                type="number"
                step="any"
                value={shown(k)}
                onChange={set(k)}
                placeholder={ladder && (LADDER_FIELDS as readonly string[]).includes(k) ? "from entry" : undefined}
              />
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">Exit status</Label>
            <Select value={shown("exitStatus")} onChange={set("exitStatus")}>
              <option value="">—</option>
              {SIGNAL_EXIT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </div>
          {ladder && (
            <p className="col-span-2 text-[0.6875rem] text-muted-foreground sm:col-span-4">
              T1 / T2 / SL are pre-filled at +30% / +60% / −25% of your entry. Change any of them — adherence is judged against
              what THIS trade records, never against the prefill.
            </p>
          )}
        </div>
      )}

      {/* The wire. Raw strings only; the server builds and validates the
          envelope. `signalPresent` is what makes the save read any of it. */}
      {emitting && (
        <>
          <input type="hidden" name="signalPresent" value="1" />
          <input type="hidden" name="signal.model" value={shown("model")} />
          {SIGNAL_NUMBER_FIELDS.map((k) => (
            <input key={k} type="hidden" name={`signal.${k}`} value={shown(k)} />
          ))}
          <input type="hidden" name="signal.exitStatus" value={shown("exitStatus")} />
        </>
      )}
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border p-3">{children}</div>;
}
