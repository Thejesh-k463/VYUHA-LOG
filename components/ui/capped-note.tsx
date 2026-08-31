/**
 * A stated cap for SERVER-rendered lists.
 *
 * No "use client" here on purpose: `/risk`'s expiry-obligations, Greeks and
 * MTF-drift panels are server components, so they cannot hold the client state
 * that `useRowWindow` (components/ui/show-more.tsx) needs. They take a plain
 * slice instead — and every slice must be accompanied by this note.
 *
 * Between them those three panels were rendering ~1,250 rows into /risk's HTML,
 * which is most of what remained of that route's cost after the two big tables
 * were windowed. All three are already sorted with the urgent rows first
 * (obligations by physical-settlement then days-to-expiry, drift by size), so a
 * head slice keeps what matters.
 *
 * The note is not decoration. A silent `.slice()` reads as "this is your whole
 * book" — the same failure the harvest holding clock and the lenses drill-down
 * cap avoid by saying "Showing 15 of N" and "2,000 of N" out loud.
 */
export const RISK_LIST_CAP = 100;

export function CappedNote({
  total,
  cap = RISK_LIST_CAP,
  noun,
}: {
  total: number;
  cap?: number;
  noun: string;
}) {
  if (total <= cap) return null;
  return (
    <p className="px-2.5 py-2 text-xs text-muted-foreground">
      Showing the first {cap} of {total} {noun}, most urgent first.
    </p>
  );
}
