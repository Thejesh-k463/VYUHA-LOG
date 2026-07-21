import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { PlaybookManager } from "@/components/behavior/playbook-manager";
import { PresetLibrary } from "@/components/behavior/preset-library";
import { getPlaybooks } from "@/lib/queries/playbooks";
import { getTrades } from "@/lib/queries/trades";
import { playbookStats, type PlaybookStat } from "@/lib/analytics/behavior";

export const dynamic = "force-dynamic";

export default function PlaybooksPage() {
  const rows = getPlaybooks();
  const active = rows.filter((r) => !r.archived).length;

  // T1.3 — closed-trade expectancy per playbook, shown on each card so the
  // setup's rules and its real results live on the same screen.
  const trades = getTrades().map((t) => ({
    id: t.id, isOpen: t.isOpen, netPnl: t.netPnl, rMultiple: t.rMultiple,
    playbookId: t.playbookId, emotionTag: t.emotionTag, mistakeTags: t.mistakeTags,
  }));
  const stats: Record<number, PlaybookStat> = {};
  for (const s of playbookStats(trades, rows.map((p) => ({ id: p.id, name: p.name })))) {
    if (s.playbookId != null) stats[s.playbookId] = s;
  }

  return (
    <>
      <PageHeader
        title="Playbooks"
        description="Named setups with the rules you commit to — tag trades, then see which playbooks actually pay on the Discipline page."
        actions={<Badge variant="secondary">{active} active</Badge>}
      />
      <div className="space-y-5 p-6">
        <PlaybookManager rows={rows} stats={stats} />
        <PresetLibrary existingNames={rows.map((r) => r.name)} />
      </div>
    </>
  );
}
