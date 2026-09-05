/**
 * A 90-session spark for one breadth series.
 *
 * Hand-rolled SVG, not a chart library: it is a polyline with no axes, no
 * tooltip and no legend, and it must survive `@media print` (AGENTS.md: canvas
 * charts rasterise their draw-time colours and print dark on white). `stroke`
 * is `currentColor`, so the skin and the print palette both re-theme it for
 * free without this file knowing a single colour.
 *
 * Missing sessions are HOLES, not zeros: a null value ends the current
 * polyline and the next run starts a new one, so a gap in the history reads as
 * a gap rather than as a plunge to the floor.
 */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  label,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  label: string;
}) {
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) {
    return (
      <div className="text-[0.625rem] text-muted-foreground" aria-label={`${label}: not enough sessions to plot`}>
        not enough sessions to plot
      </div>
    );
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : width;

  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length > 1) runs.push(current.join(" "));
      current = [];
      return;
    }
    const x = (i * step).toFixed(2);
    const y = (height - ((v - min) / span) * (height - 2) - 1).toFixed(2);
    current.push(`${x},${y}`);
  });
  if (current.length > 1) runs.push(current.join(" "));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="text-accent"
      role="img"
      aria-label={`${label}: ${present.length} of ${values.length} sessions plotted`}
    >
      {runs.map((points, i) => (
        <polyline key={i} points={points} fill="none" stroke="currentColor" strokeWidth="1.25" />
      ))}
    </svg>
  );
}
