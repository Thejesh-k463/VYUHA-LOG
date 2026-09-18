import Link from "next/link";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getDataQualityReport, getStaleOpenSection } from "@/lib/queries/data-quality";
import { crossAccountIssues, scoreIssues } from "@/lib/analytics/data-quality";
import { listDuplicateConnections, listDuplicateTradeGroups } from "@/lib/import/broker-identity";
import { DuplicateFix } from "@/components/quality/duplicate-fix";
import { StaleLotFix } from "@/components/quality/stale-lot-fix";

export const dynamic = "force-dynamic";

export default function DataQualityPage() {
  const report = getDataQualityReport();
  // Cross-account facts (4.3.0 wave 1). They span EVERY account by definition — one
  // broker client connected twice, and one broker record imported into two
  // books — so they are resolved here rather than inside the account-scoped
  // report, and folded into the same issue list and the same score.
  const duplicateConnections = listDuplicateConnections();
  const duplicateTradeGroups = listDuplicateTradeGroups();
  const issues = [...report.issues, ...crossAccountIssues({ duplicateConnections, duplicateTradeGroups })];
  const score = scoreIssues(issues);
  const affected = new Set(issues.flatMap((x) => x.ids ?? [])).size;
  const stale = getStaleOpenSection();
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
            {/* D5 (wave 2O, identity#1) — the badge is how many records the issue is
                ABOUT. The grouped IPO-record issue carries `count: 1` on purpose (one
                question costs one warning in `scoreIssues`) while its detail names n
                holdings, so it states `affectedCount` and the badge reads that; every
                other issue passes the affected number as `count` and is unchanged. */}
            <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="text-sm font-medium">{issue.title}</p><Badge variant="outline">{issue.affectedCount ?? issue.count}</Badge></div><p className="text-xs text-muted-foreground">{issue.detail}</p></div>
            <Button asChild size="sm" variant="outline"><Link href={issue.href}>Review</Link></Button>
          </div>;
        })}
      </CardContent></Card>
      {/* R26 — the stale open rows the `stale_open` issue counts, and the join
          that closes each one with its recorded sale; W2-DQ P2 — the closing
          rows the `stale_sale` warning counts, listed only. Account-scoped. */}
      <StaleLotFix pairs={stale.pairs} sales={stale.sales} />
      <DuplicateFix groups={duplicateTradeGroups} connections={duplicateConnections} />
      <p className="text-[0.6875rem] text-muted-foreground">The score is a completeness indicator, not a judgement of trading performance. Critical unknowns carry more weight because they can change reported money.</p>
    </div>
  </>;
}
