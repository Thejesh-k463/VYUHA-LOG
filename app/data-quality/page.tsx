import Link from "next/link";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDataQualityReport } from "@/lib/queries/data-quality";
import { crossAccountIssues, scoreIssues } from "@/lib/analytics/data-quality";
import { listDuplicateConnections, listDuplicateTradeGroups } from "@/lib/import/broker-identity";
import { DuplicateFix } from "@/components/quality/duplicate-fix";

export const dynamic = "force-dynamic";

export default function DataQualityPage() {
  const report = getDataQualityReport();
  // Cross-account facts (v4.2.1). They span EVERY account by definition — one
  // broker client connected twice, and one broker record imported into two
  // books — so they are resolved here rather than inside the account-scoped
  // report, and folded into the same issue list and the same score.
  const duplicateConnections = listDuplicateConnections();
  const duplicateTradeGroups = listDuplicateTradeGroups();
  const issues = [...report.issues, ...crossAccountIssues({ duplicateConnections, duplicateTradeGroups })];
  const score = scoreIssues(issues);
  const affected = new Set(issues.flatMap((x) => x.ids ?? [])).size;
  return <>
    <PageHeader title="Data Quality Center" description="The health of every input that feeds P&L, risk, tax and behavioural analytics." actions={<Badge variant={score >= 90 ? "profit" : score >= 70 ? "warning" : "loss"}>{score}/100</Badge>} />
    <div className="space-y-5 p-6">
      <Card className="card-hero"><CardContent className="grid gap-4 p-5 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Records checked</p><p className="text-2xl font-semibold tabular-nums">{report.checked}</p></div>
        <div><p className="text-xs text-muted-foreground">Affected trades</p><p className="text-2xl font-semibold tabular-nums">{affected}</p></div>
        <div><p className="text-xs text-muted-foreground">Open issue groups</p><p className="text-2xl font-semibold tabular-nums">{issues.length}</p></div>
      </CardContent></Card>
      <Card className="p-0"><CardHeader><CardTitle>Diagnostics</CardTitle></CardHeader><CardContent className="divide-y divide-border/50 p-0">
        {issues.length === 0 ? <EmptyState variant="playbook" title="Every quality check passed" /> : issues.map((issue) => {
          const Icon = issue.severity === "critical" ? ShieldAlert : issue.severity === "warning" ? AlertTriangle : Info;
          return <div key={issue.code} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
            <Icon className={`size-5 shrink-0 ${issue.severity === "critical" ? "text-loss" : issue.severity === "warning" ? "text-warning" : "text-accent"}`} />
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-medium">{issue.title}</p><Badge variant="outline">{issue.count}</Badge></div><p className="text-xs text-muted-foreground">{issue.detail}</p></div>
            <Button asChild size="sm" variant="outline"><Link href={issue.href}>Review</Link></Button>
          </div>;
        })}
      </CardContent></Card>
      <DuplicateFix groups={duplicateTradeGroups} connections={duplicateConnections} />
      <p className="text-[0.6875rem] text-muted-foreground">The score is a completeness indicator, not a judgement of trading performance. Critical unknowns carry more weight because they can change reported money.</p>
    </div>
  </>;
}
