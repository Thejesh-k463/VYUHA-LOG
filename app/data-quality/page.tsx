import Link from "next/link";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDataQualityReport } from "@/lib/queries/data-quality";

export const dynamic = "force-dynamic";

export default function DataQualityPage() {
  const report = getDataQualityReport();
  return <>
    <PageHeader title="Data Quality Center" description="The health of every input that feeds P&L, risk, tax and behavioural analytics." actions={<Badge variant={report.score >= 90 ? "profit" : report.score >= 70 ? "warning" : "loss"}>{report.score}/100</Badge>} />
    <div className="space-y-5 p-6">
      <Card className="card-hero"><CardContent className="grid gap-4 p-5 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Records checked</p><p className="text-2xl font-semibold tabular-nums">{report.checked}</p></div>
        <div><p className="text-xs text-muted-foreground">Affected trades</p><p className="text-2xl font-semibold tabular-nums">{report.affected}</p></div>
        <div><p className="text-xs text-muted-foreground">Open issue groups</p><p className="text-2xl font-semibold tabular-nums">{report.issues.length}</p></div>
      </CardContent></Card>
      <Card className="p-0"><CardHeader><CardTitle>Diagnostics</CardTitle></CardHeader><CardContent className="divide-y divide-border/50 p-0">
        {report.issues.length === 0 ? <div className="flex items-center gap-2 p-5 text-sm text-profit"><CheckCircle2 className="size-4" /> Every quality check passed.</div> : report.issues.map((issue) => {
          const Icon = issue.severity === "critical" ? ShieldAlert : issue.severity === "warning" ? AlertTriangle : Info;
          return <div key={issue.code} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <Icon className={`size-5 shrink-0 ${issue.severity === "critical" ? "text-loss" : issue.severity === "warning" ? "text-warning" : "text-accent"}`} />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-medium">{issue.title}</p><Badge variant="outline">{issue.count}</Badge></div><p className="text-xs text-muted-foreground">{issue.detail}</p></div>
            <Button asChild size="sm" variant="outline"><Link href={issue.href}>Review</Link></Button>
          </div>;
        })}
      </CardContent></Card>
      <p className="text-[0.6875rem] text-muted-foreground">The score is a completeness indicator, not a judgement of trading performance. Critical unknowns carry more weight because they can change reported money.</p>
    </div>
  </>;
}
