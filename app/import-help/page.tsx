import { PageHeader } from "@/components/layout/page-header";
import { ImportHelp } from "@/components/system/import-help";
import { IMPORT_HELP_CARDS } from "@/lib/domain/import-help-content";

export const dynamic = "force-dynamic";

export default function ImportHelpPage() {
  return (
    <>
      <PageHeader
        title="Import Help"
        description="Where each broker's files come from, how the API connections are set up, and what each path honestly does."
      />
      <div className="p-6">
        <ImportHelp cards={IMPORT_HELP_CARDS} />
      </div>
    </>
  );
}
