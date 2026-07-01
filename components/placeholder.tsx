import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Construction } from "lucide-react";

export function Placeholder({
  title,
  description,
  phase,
  bullets,
}: {
  title: string;
  description?: string;
  phase: string;
  bullets?: string[];
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <div className="p-6">
        <div className="flex max-w-2xl flex-col items-start gap-4 rounded-lg border border-dashed border-border bg-card/40 p-8">
          <div className="flex items-center gap-3">
            <Construction className="size-5 text-warning" />
            <Badge variant="warning">{phase}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            This screen is scaffolded and will be built in {phase}.
          </p>
          {bullets && bullets.length > 0 && (
            <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
              {bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
