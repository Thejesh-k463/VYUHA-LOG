/** C5 — shared route-loading skeleton: header bar, KPI row, two content blocks.
 *  Pure divs with the `skeleton` shimmer utility; shown by Next.js while a
 *  server page's data loads, instead of a blank flash. */
export function PageSkeleton({ kpis = 4 }: { kpis?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="flex h-[57px] items-center border-b border-border px-6">
        <div className="skeleton h-5 w-44" />
      </div>
      <div className="space-y-5 p-6">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: kpis }, (_, i) => (
            <div key={i} className="skeleton h-[92px]" />
          ))}
        </div>
        <div className="skeleton h-[280px]" />
        <div className="skeleton h-[200px]" />
      </div>
    </div>
  );
}
