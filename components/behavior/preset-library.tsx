"use client";

// The 25 preset playbooks, VISIBLE on the Playbooks page.
//
// They previously existed only as a dropdown inside the "New playbook" dialog —
// technically shipped, practically invisible. This surfaces the whole library:
// browse by ecosystem, read the rules, add the ones you actually trade in one
// click. Deliberately NOT auto-seeded into the DB: 25 untraded setups would
// bury your real playbooks and turn the Discipline page's per-playbook
// expectancy into noise. You choose what becomes yours.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Plus, Library } from "lucide-react";
import { toast } from "@/components/ui/toaster";
import { PRESET_PLAYBOOKS, presetCategories, type PresetPlaybook } from "@/lib/domain/preset-playbooks";

export function PresetLibrary({ existingNames }: { existingNames: string[] }) {
  const router = useRouter();
  const [cat, setCat] = React.useState<string>("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [justAdded, setJustAdded] = React.useState<Set<string>>(new Set());

  const owned = React.useMemo(
    () => new Set(existingNames.map((n) => n.trim().toLowerCase())),
    [existingNames],
  );
  const has = (p: PresetPlaybook) => owned.has(p.name.trim().toLowerCase()) || justAdded.has(p.name);

  const cats = presetCategories();
  const shown = cat ? PRESET_PLAYBOOKS.filter((p) => p.category === cat) : PRESET_PLAYBOOKS;

  async function add(p: PresetPlaybook) {
    setBusy(p.name);
    try {
      const res = await fetch("/api/playbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add",
          name: p.name,
          description: p.description,
          rules: p.rules.join("\n"),
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
      if (data.ok) {
        setJustAdded((s) => new Set(s).add(p.name));
        toast.success(`"${p.name}" added — edit its rules to match your own risk.`);
        router.refresh();
      } else {
        toast.error(data.message ?? "Could not add that playbook.");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Library className="size-4" /> Preset library
        </CardTitle>
        <Badge variant="secondary">{PRESET_PLAYBOOKS.length} setups · {cats.length} ecosystems</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Battle-tested setups from trading ecosystems worldwide — add the ones you actually trade, then
          edit every rule and metric to your own risk. Nothing is added until you click.
        </p>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setCat("")}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              cat === "" ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            All ({PRESET_PLAYBOOKS.length})
          </button>
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                cat === c ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {c} ({PRESET_PLAYBOOKS.filter((p) => p.category === c).length})
            </button>
          ))}
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => {
            const added = has(p);
            return (
              <div
                key={p.name}
                className={`flex flex-col rounded-lg border p-3 transition-colors ${
                  added ? "border-profit/40 bg-profit/5" : "border-border bg-card-hover/30 hover:border-primary/40"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold">{p.name}</div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{p.category}</div>
                  </div>
                  <Button
                    size="sm"
                    variant={added ? "ghost" : "outline"}
                    className="h-7 shrink-0 px-2 text-[11px]"
                    disabled={added || busy === p.name}
                    onClick={() => add(p)}
                  >
                    {added ? <><Check className="size-3.5 text-profit" /> Added</> : busy === p.name ? "…" : <><Plus className="size-3.5" /> Add</>}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{p.description}</p>
                <ul className="mt-2 space-y-0.5">
                  {p.rules.map((r, i) => (
                    <li key={i} className="flex gap-1.5 text-[11px] text-muted-foreground">
                      <span className="text-profit">✓</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
