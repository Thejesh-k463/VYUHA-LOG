/**
 * Shared route-loading skeleton — pure divs on the `skeleton` shimmer utility,
 * shown by Next while a server page's data loads.
 *
 * MEASUREMENTS MATTER HERE (2026-08-10 audit): the first version guessed a
 * 57px header and a 4-across KPI grid, so every single navigation jumped
 * ~12px when the real 69px PageHeader landed and reflowed 4+1 KPI tiles into
 * 5-across. A skeleton that mis-measures is churn dressed as polish. The
 * numbers below are the real ones:
 *   header  = py-3 (24) + text-lg line (28) + text-xs line (16) + 1px border = 69px
 *   KPI row = lg:grid-cols-5, gap-4 (app/trades, dashboard)
 *   filter  = the dashboard's sticky 49px filter band
 * If PageHeader's typography changes, change this AND the dashboard's
 * `sticky top-[69px]` offset together — they are the same measurement.
 */

type Variant = "kpi" | "table" | "form" | "grid";

export function PageSkeleton({
  kpis = 5,
  variant = "kpi",
  filterBar = false,
}: {
  kpis?: number;
  variant?: Variant;
  /** Dashboard-style sticky filter band under the header. */
  filterBar?: boolean;
}) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="flex h-[69px] flex-col justify-center gap-1 border-b border-border px-6">
        <div className="skeleton h-5 w-44" />
        <div className="skeleton h-3 w-72" />
      </div>
      {filterBar && (
        <div className="flex h-[49px] items-center gap-2 border-b border-border px-6">
          <div className="skeleton h-7 w-40" />
          <div className="skeleton h-7 w-28" />
          <div className="skeleton h-7 w-28" />
        </div>
      )}
      <div className="space-y-5 p-6">
        {variant === "kpi" && (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: kpis }, (_, i) => (
                <div key={i} className="skeleton h-[92px]" />
              ))}
            </div>
            <div className="skeleton h-[280px]" />
            <div className="skeleton h-[200px]" />
          </>
        )}
        {variant === "table" && (
          <>
            <div className="flex items-center gap-2">
              <div className="skeleton h-8 w-64" />
              <div className="skeleton h-8 w-32" />
            </div>
            <div className="skeleton h-[480px]" />
          </>
        )}
        {variant === "form" && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-3">
              <div className="skeleton h-[320px]" />
              <div className="skeleton h-[160px]" />
            </div>
            <div className="skeleton h-[496px]" />
          </div>
        )}
        {variant === "grid" && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="skeleton h-[180px]" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
