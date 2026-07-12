"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import type { Playbook } from "@/lib/db/schema";
import { PRESET_PLAYBOOKS } from "@/lib/domain/preset-playbooks";
import { Plus, Pencil, Trash2, Archive, ArchiveRestore, CheckCircle2, AlertCircle } from "lucide-react";

export function PlaybookManager({ rows }: { rows: Playbook[] }) {
  const router = useRouter();
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Playbook | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  // Command-palette deep link: /playbooks?add=1 — open the dialog once, then clean the URL.
  React.useEffect(() => {
    if (new URLSearchParams(window.location.search).get("add")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAddOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  async function post(payload: object) {
    const res = await fetch("/api/playbooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Request failed" }));
    setMsg({ ok: !!data.ok, text: data.message ?? "" });
    if (data.ok) router.refresh();
    return !!data.ok;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {msg ? (
          <span className={`flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}
            {msg.text}
          </span>
        ) : <span />}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="size-4" /> New playbook</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New playbook</DialogTitle>
              <DialogDescription>A named setup with the rules you commit to. Tag trades to it from the Trades screen.</DialogDescription>
            </DialogHeader>
            <PlaybookForm onSave={async (p) => { const ok = await post({ action: "add", ...p }); if (ok) setAddOpen(false); }} />
          </DialogContent>
        </Dialog>
      </div>

      {rows.length === 0 ? (
        <Card><CardContent className="p-6 text-sm text-muted-foreground">
          No playbooks yet. A playbook is a named setup — &ldquo;Breakout&rdquo;, &ldquo;Pullback to 20 EMA&rdquo;,
          &ldquo;Expiry theta&rdquo; — with the rules you promise to follow. Create one, tag your trades, and the
          Discipline page shows which setups actually make you money.
        </CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((p) => (
            <Card key={p.id} className={p.archived ? "opacity-60" : ""}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  {p.name}
                  {p.archived && <Badge variant="secondary">archived</Badge>}
                </CardTitle>
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="size-7" title="Edit" onClick={() => setEditing(p)}><Pencil className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="size-7" title={p.archived ? "Restore" : "Archive"} onClick={() => post({ action: "archive", id: p.id })}>
                    {p.archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
                  </Button>
                  <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-loss" title="Delete"
                    onClick={() => { if (confirm(`Delete "${p.name}"? Trades tagged with it fall back to Untagged.`)) post({ action: "delete", id: p.id }); }}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                {p.rules.length > 0 ? (
                  <ul className="space-y-1">
                    {p.rules.map((r, i) => (
                      <li key={i} className="flex gap-2 text-xs"><span className="text-profit">✓</span>{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted-foreground">No rules written yet.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit playbook</DialogTitle>
            <DialogDescription>{editing?.name}</DialogDescription>
          </DialogHeader>
          {editing && (
            <PlaybookForm
              existing={editing}
              onSave={async (p) => { const ok = await post({ action: "update", id: editing.id, ...p }); if (ok) setEditing(null); }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlaybookForm({
  existing,
  onSave,
}: {
  existing?: Playbook;
  onSave: (p: { name: string; description: string; rules: string }) => Promise<void>;
}) {
  const [name, setName] = React.useState(existing?.name ?? "");
  const [description, setDescription] = React.useState(existing?.description ?? "");
  const [rules, setRules] = React.useState((existing?.rules ?? []).join("\n"));
  const [pending, setPending] = React.useState(false);
  const [preset, setPreset] = React.useState("");

  const applyPreset = (presetName: string) => {
    setPreset(presetName);
    const p = PRESET_PLAYBOOKS.find((x) => x.name === presetName);
    if (!p) return; // "Custom (blank)" — leave whatever's already typed
    setName(p.name);
    setDescription(p.description);
    setRules(p.rules.join("\n"));
  };

  return (
    <div className="space-y-3">
      {!existing && (
        <div className="space-y-1">
          <Label>Start from a preset (optional)</Label>
          <Select value={preset} onChange={(e) => applyPreset(e.target.value)} className="h-8 w-full text-xs">
            <option value="">Custom (blank)</option>
            {PRESET_PLAYBOOKS.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </Select>
          <p className="text-[11px] text-muted-foreground">
            Picks a globally-recognized setup to start from — edit anything below before saving.
          </p>
        </div>
      )}
      <div className="space-y-1">
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Breakout retest" />
      </div>
      <div className="space-y-1">
        <Label>Description</Label>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional — when does this setup apply?" />
      </div>
      <div className="space-y-1">
        <Label>Rules (one per line)</Label>
        <textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={5}
          placeholder={"Wait for the retest\nRisk ≤ 1% of capital\nStop below the breakout level\nNo entries after 2:30pm"}
          className="w-full rounded-md border border-border bg-input p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button
          type="button"
          disabled={pending || !name.trim()}
          onClick={async () => { setPending(true); try { await onSave({ name, description, rules }); } finally { setPending(false); } }}
        >
          {pending ? "Saving…" : existing ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
