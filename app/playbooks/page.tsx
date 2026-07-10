import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { PlaybookManager } from "@/components/behavior/playbook-manager";
import { getPlaybooks } from "@/lib/queries/playbooks";

export const dynamic = "force-dynamic";

export default function PlaybooksPage() {
  const rows = getPlaybooks();
  const active = rows.filter((r) => !r.archived).length;
  return (
    <>
      <PageHeader
        title="Playbooks"
        description="Named setups with the rules you commit to — tag trades, then see which playbooks actually pay on the Discipline page."
        actions={<Badge variant="secondary">{active} active</Badge>}
      />
      <div className="space-y-5 p-6">
        <PlaybookManager rows={rows} />
      </div>
    </>
  );
}
