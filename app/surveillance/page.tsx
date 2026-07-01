import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RestrictionForm } from "@/components/risk/restriction-form";
import { getRestrictedList, getHeldSymbols } from "@/lib/queries/restrictions";
import { getAliasMap } from "@/lib/queries/aliases";
import { resolveTicker } from "@/lib/analytics/aliases";
import { computeRestrictions, CATEGORY_META, type Severity } from "@/lib/analytics/restrictions";
import { fmtDate } from "@/lib/format";
import { ShieldAlert, ShieldCheck, Ban } from "lucide-react";

export const dynamic = "force-dynamic";

const sevBadge: Record<Severity, "loss" | "warning" | "secondary"> = {
  high: "loss",
  medium: "warning",
  info: "secondary",
};
const sevBorder: Record<Severity, string> = {
  high: "border-l-loss",
  medium: "border-l-warning",
  info: "border-l-border",
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card-hover/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

export default function SurveillancePage() {
  const list = getRestrictedList();
  const held = getHeldSymbols();
  const aliasMap = getAliasMap();
  const report = computeRestrictions(held, list, (s) => resolveTicker(s, aliasMap));
  const loaded = report.totalRestricted > 0;

  return (
    <>
      <PageHeader
        title="Surveillance"
        description="F&O ban, ASM/GSM & circuit-band alerts matched to your open positions."
        actions={
          loaded ? (
            <Badge variant="secondary">list as of {fmtDate(report.asOfDate)}</Badge>
          ) : (
            <Badge variant="secondary">no list loaded</Badge>
          )
        }
      />
      <div className="space-y-5 p-6">
        {loaded && (
          <section className="grid grid-cols-3 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Restricted" value={String(report.totalRestricted)} />
            <Stat
              label="You hold"
              value={String(report.heldRestricted)}
              tone={report.heldRestricted > 0 ? "text-warning" : "text-profit"}
            />
            <Stat label="F&O ban" value={String(report.byCategory.fno_ban)} />
            <Stat label="ASM" value={String(report.byCategory.asm)} />
            <Stat label="GSM" value={String(report.byCategory.gsm)} />
            <Stat label="Circuit" value={String(report.byCategory.circuit)} />
          </section>
        )}

        {/* Alerts on held positions */}
        <Card className="p-0">
          <CardHeader className="flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="size-4 text-muted-foreground" />
              <CardTitle>Alerts on your positions</CardTitle>
            </div>
            {report.heldRestricted > 0 ? (
              <Badge variant="loss">{report.heldRestricted} flagged</Badge>
            ) : (
              <Badge variant="secondary">all clear</Badge>
            )}
          </CardHeader>
          <CardContent className="p-0">
            {report.alerts.length === 0 ? (
              <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted-foreground">
                <ShieldCheck className="size-4 text-profit" />
                {loaded
                  ? "None of your open positions are on the current restriction list."
                  : "Load a restriction list below to check your open positions against it."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">Symbol</th>
                      <th className="px-2 py-2 font-medium">Flags</th>
                      <th className="px-2 py-2 font-medium">You hold</th>
                      <th className="px-2.5 py-2 font-medium">What it means</th>
                      <th className="px-2.5 py-2 font-medium">Severity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.alerts.map((a) => (
                      <tr key={a.symbol} className={`border-b border-border/40 border-l-2 ${sevBorder[a.severity]}`}>
                        <td className="px-2.5 py-2 font-medium text-foreground">{a.symbol}</td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-1">
                            {a.categories.map((c) => (
                              <Badge key={c} variant={c === "fno_ban" ? "loss" : c === "gsm" ? "warning" : "secondary"}>
                                {CATEGORY_META[c].label}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-2 py-2">
                          {a.isFno ? (
                            <Badge variant="outline">F&O</Badge>
                          ) : (
                            <Badge variant="secondary">Equity</Badge>
                          )}
                        </td>
                        <td className="px-2.5 py-2 text-muted-foreground">{a.guidance}</td>
                        <td className="px-2.5 py-2">
                          <span className="inline-flex items-center gap-1">
                            {a.severity === "high" ? <Ban className="size-3 text-loss" /> : null}
                            <Badge variant={sevBadge[a.severity]}>{a.severity}</Badge>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Load list */}
        <Card>
          <CardHeader>
            <CardTitle>Load restriction list</CardTitle>
          </CardHeader>
          <CardContent>
            <RestrictionForm count={list.length} />
          </CardContent>
        </Card>

        {/* Full list */}
        {loaded && (
          <Card className="p-0">
            <CardHeader>
              <CardTitle>Current list ({list.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-y border-border text-left text-muted-foreground">
                      <th className="px-2.5 py-2 font-medium">Symbol</th>
                      <th className="px-2 py-2 font-medium">Category</th>
                      <th className="px-2 py-2 font-medium">Stage / note</th>
                      <th className="px-2.5 py-2 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r, i) => (
                      <tr key={`${r.symbol}-${r.category}-${i}`} className="border-b border-border/40">
                        <td className="px-2.5 py-1.5 font-medium">{r.symbol}</td>
                        <td className="px-2 py-1.5">
                          <Badge variant={r.category === "fno_ban" ? "loss" : r.category === "gsm" ? "warning" : "secondary"}>
                            {CATEGORY_META[r.category].label}
                          </Badge>
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{r.stage ?? "—"}</td>
                        <td className="px-2.5 py-1.5 text-muted-foreground">{r.source ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        <p className="text-[11px] text-muted-foreground">
          Offline-first: paste the daily NSE/BSE restriction lists (F&O ban / ASM / GSM / circuit). Alerts are advisory —
          a stock in F&O ban allows only position reduction; ASM/GSM raise margins and tighten bands. Always confirm with
          your broker before trading a flagged scrip.
        </p>
      </div>
    </>
  );
}
