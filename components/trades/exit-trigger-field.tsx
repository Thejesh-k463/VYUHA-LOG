"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EXIT_TRIGGERS } from "@/lib/analytics/exit-behaviour";

/** Sentinel for the select only — never a persisted value. */
const CUSTOM = "__custom__";

/**
 * WHY the trade was closed (`exit_trigger`, migration 0051) — shared by both
 * trade writers (edit dialog + journal dialog), which
 * tests/exit-trigger-writers.test.ts asserts.
 *
 * Offers the curated EXIT_TRIGGERS list plus free text ("own words…") — a
 * trader's own vocabulary is worth more than a tidy enum. Blank means
 * UNANSWERED, never a value: callers persist "" as null, and the analytics
 * over this column (exitTriggers in lib/analytics/exit-behaviour.ts) exclude
 * blanks rather than bucketing them as "other".
 */
export function ExitTriggerField({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange: (v: string) => void;
  /** When set, a hidden input carries the value into a <form> submit. */
  name?: string;
}) {
  const listed = (EXIT_TRIGGERS as readonly string[]).includes(value);
  // A freshly picked "own words…" has value === "" and would fall back to the
  // unanswered option without this bit of local state; a STORED free-text
  // value needs no state — it lands on CUSTOM because it is not in the list.
  const [customPicked, setCustomPicked] = React.useState(() => value !== "" && !listed);
  const selectValue = customPicked || (value !== "" && !listed) ? CUSTOM : value;
  return (
    <div className="space-y-1">
      {name != null && <input type="hidden" name={name} value={value} />}
      <Select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            setCustomPicked(true);
            onChange("");
          } else {
            setCustomPicked(false);
            onChange(v);
          }
        }}
      >
        <option value="">— unanswered —</option>
        {EXIT_TRIGGERS.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
        <option value={CUSTOM}>own words…</option>
      </Select>
      {selectValue === CUSTOM && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="why did you close it?"
        />
      )}
    </div>
  );
}
