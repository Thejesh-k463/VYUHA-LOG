import type { NotComputedFamily, NotComputedWhy } from "@/lib/atlas/not-computed";
import { NOT_COMPUTED_GATES } from "@/lib/atlas/not-computed";

/**
 * The honesty list (v4.6.0 W5, owner rulings AQ10 / AQ11): what Atlas does NOT
 * compute, grouped under the gate each family waits behind — in Vyuha's own
 * words. No vendor name, no widget title, no dashboard id: the registry in
 * `lib/atlas/not-computed.ts` is the only source, and `tests/atlas-copy.test.ts`
 * scans this file with the rest of `components/atlas/*.tsx`.
 *
 * "later" = computable once the named input exists; "never" = deliberately not
 * computed here. A greyed tile says which, never a blank.
 */
const STATUS_LABEL = { later: "later, once the input exists", never: "not computed here, by design" } as const;

export function NotComputedList({ families }: { families: readonly NotComputedFamily[] }) {
  const gates = NOT_COMPUTED_GATES.filter((g) => families.some((f) => f.why === g));
  if (gates.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="atlas-not-computed">
      {gates.map((gate: NotComputedWhy) => (
        <div key={gate}>
          <div className="mb-1 font-medium text-foreground">{capitalise(gate)}</div>
          <ul className="space-y-1">
            {families
              .filter((f) => f.why === gate)
              .map((f) => (
                <li key={f.family} className="rounded-md border border-dashed border-border bg-card/30 p-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="text-foreground">{f.family}</span>
                    <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{STATUS_LABEL[f.status]}</span>
                  </div>
                  <div className="mt-0.5 text-muted-foreground">{f.note}</div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
