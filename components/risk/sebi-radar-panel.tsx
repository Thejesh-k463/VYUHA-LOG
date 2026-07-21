import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import type { RadarReport, RadarLevel } from "@/lib/risk/sebi-radar";

const ICON: Record<RadarLevel, React.ReactNode> = {
  action: <ShieldAlert className="mt-0.5 size-4 shrink-0 text-loss" />,
  caution: <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />,
  info: <Info className="mt-0.5 size-4 shrink-0 text-accent" />,
};

const EDGE: Record<RadarLevel, string> = {
  action: "border-l-2 border-l-loss",
  caution: "border-l-2 border-l-warning",
  info: "border-l-2 border-l-accent",
};

/** T1.2 — date- and position-aware SEBI rule reminders. Informational only:
 *  the app never blocks anything, and exchange circulars + your broker's RMS
 *  remain the source of truth. */
export function SebiRadarPanel({ report }: { report: RadarReport }) {
  const actions = report.items.filter((i) => i.level === "action").length;
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>SEBI compliance radar</CardTitle>
        {actions > 0 ? (
          <Badge variant="warning">{actions} need attention today</Badge>
        ) : (
          <Badge variant="secondary">{report.today}</Badge>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {report.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No open derivative positions — the F&amp;O rule reminders (expiry-day ELM, calendar-spread
            margin, weekly-expiry regime, position limits) appear here when you hold F&amp;O.
          </p>
        ) : (
          <div className="divide-y divide-border/40">
            {report.items.map((i) => (
              <div key={i.id} className={`flex items-start gap-2 px-4 py-3 ${EDGE[i.level]}`}>
                {ICON[i.level]}
                <div>
                  <div className="text-xs font-medium">{i.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{i.detail}</div>
                  {i.positions && i.positions.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {i.positions.slice(0, 8).map((p) => (
                        <span key={p} className="rounded bg-card-hover px-1.5 py-0.5 text-[10px]">{p}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="border-t border-border/60 px-4 py-3 text-[11px] text-muted-foreground">
          Informational, not compliance advice. Rules and dates change with SEBI/exchange circulars
          (and shift for holidays) — your broker&apos;s RMS is the source of truth. Vyuha never blocks
          a trade; it only reminds you what today&apos;s regime does to your margin.
        </p>
      </CardContent>
    </Card>
  );
}
