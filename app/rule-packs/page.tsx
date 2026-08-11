import { ExternalLink, FileCheck2 } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RulePackReview } from "@/components/system/rule-pack-review";
import { getRulePacks } from "@/lib/queries/rule-packs";

export const dynamic = "force-dynamic";
export default function RulePacksPage() {
  const packs = getRulePacks(); const stale = packs.filter((p) => p.reviewDue).length;
  return <><PageHeader title="Rule & Rate Packs" description="Effective dates, encoded assumptions and the primary source behind every changing market rule." actions={<Badge variant={stale ? "warning" : "profit"}>{stale ? `${stale} need review` : "sources current"}</Badge>} />
    <div className="space-y-4 p-6">{packs.map((p) => <Card key={p.id}><CardHeader className="flex-row items-start justify-between"><div className="flex gap-2"><FileCheck2 className="mt-0.5 size-4 text-accent" /><div><CardTitle>{p.title}</CardTitle><p className="text-xs text-muted-foreground">{p.category} · version {p.version} · effective {p.effectiveFrom}{p.effectiveTo ? ` to ${p.effectiveTo}` : " onward"}</p></div></div><Badge variant={p.active ? "profit" : "secondary"}>{p.active ? "active" : "archived"}</Badge></CardHeader><CardContent className="space-y-3"><pre className="overflow-x-auto rounded-md bg-card-hover/50 p-3 text-[0.6875rem] text-muted-foreground">{JSON.stringify(p.payload, null, 2)}</pre><div className="flex flex-wrap items-center gap-3"><a href={p.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">{p.sourceTitle}<ExternalLink className="size-3" /></a><RulePackReview id={p.id} /><span className="text-[0.6875rem] text-muted-foreground">Reviewed: {p.reviewedAt?.slice(0, 10) ?? "never"}</span></div></CardContent></Card>)}<p className="text-[0.6875rem] text-muted-foreground">Rule packs are informational snapshots. An effective date prevents today’s regime being applied silently to older trades; the linked regulator/exchange source and broker RMS remain authoritative.</p></div></>;
}
