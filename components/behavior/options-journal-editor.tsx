"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ShowMore, useRowWindow } from "@/components/ui/show-more";

export interface OptionJournalTrade { id: number; symbol: string; tradingsymbol: string; entryIv: number | null; exitIv: number | null; entryDte: number | null; hedgeStatus: string | null; expiryOutcome: string | null; adjustmentGroup: string | null; isOpen: boolean; }
type JournalValues = Omit<OptionJournalTrade, "id" | "symbol" | "tradingsymbol" | "isOpen">;

/**
 * WINDOWED. Every option contract used to become a live form row: at 25k trades
 * that is 8,058 rows × 7 controls ≈ 56,000 form elements, each row its own
 * stateful component. That was ~21 MB of server-rendered HTML and the bulk of
 * /options-journal's 5.8 s — for a table showing about fifteen rows at a time.
 *
 * Only the DOM is windowed. Every KPI, band and outcome figure above this table
 * is computed server-side over the WHOLE book and is unaffected.
 */
export function OptionsJournalEditor({ trades }: { trades: OptionJournalTrade[] }) {
  const router = useRouter(); const [busy, setBusy] = useState<number | null>(null);
  const win = useRowWindow(trades);
  return <div className="overflow-x-auto"><table className="w-full min-w-[1050px] text-xs"><thead><tr className="border-y border-border text-left text-muted-foreground"><th className="p-2">Contract</th><th className="p-2">Entry IV%</th><th className="p-2">Exit IV%</th><th className="p-2">Entry DTE</th><th className="p-2">Hedge</th><th className="p-2">Outcome</th><th className="p-2">Adjustment group</th><th className="p-2"></th></tr></thead><tbody>{win.visible.map((t) => <OptionRow key={t.id} t={t} busy={busy === t.id} save={async (values) => { setBusy(t.id); const r = await fetch("/api/options-journal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id, ...values }) }); setBusy(null); if (r.ok) router.refresh(); }} />)}</tbody></table><ShowMore hidden={win.hidden} total={win.total} onClick={win.showMore} noun="contracts" /></div>;
}

function OptionRow({ t, busy, save }: { t: OptionJournalTrade; busy: boolean; save: (v: JournalValues) => Promise<void> }) {
  const [v, setV] = useState<JournalValues>({ entryIv: t.entryIv, exitIv: t.exitIv, entryDte: t.entryDte, hedgeStatus: t.hedgeStatus, expiryOutcome: t.expiryOutcome ?? (t.isOpen ? "open" : "squared_off"), adjustmentGroup: t.adjustmentGroup });
  const num = (x: string) => x === "" ? null : Number(x);
  return <tr className="border-b border-rule"><td className="p-2 font-medium">#{t.id} {t.tradingsymbol || t.symbol}</td><td className="p-1"><Input className="h-8" type="number" step="0.01" value={v.entryIv ?? ""} onChange={(e) => setV({ ...v, entryIv: num(e.target.value) })} /></td><td className="p-1"><Input className="h-8" type="number" step="0.01" value={v.exitIv ?? ""} onChange={(e) => setV({ ...v, exitIv: num(e.target.value) })} /></td><td className="p-1"><Input className="h-8" type="number" value={v.entryDte ?? ""} onChange={(e) => setV({ ...v, entryDte: num(e.target.value) })} /></td><td className="p-1"><Select className="h-8" value={v.hedgeStatus ?? ""} onChange={(e) => setV({ ...v, hedgeStatus: e.target.value || null })}><option value="">Unknown</option><option value="unhedged">Unhedged</option><option value="partial">Partial</option><option value="hedged">Hedged</option><option value="not_applicable">N/A</option></Select></td><td className="p-1"><Select className="h-8" value={v.expiryOutcome ?? ""} onChange={(e) => setV({ ...v, expiryOutcome: e.target.value || null })}><option value="open">Open</option><option value="squared_off">Squared off</option><option value="expired_worthless">Expired worthless</option><option value="exercised">Exercised</option><option value="assigned">Assigned</option></Select></td><td className="p-1"><Input className="h-8" value={v.adjustmentGroup ?? ""} onChange={(e) => setV({ ...v, adjustmentGroup: e.target.value || null })} placeholder="e.g. AUG-IRON-CONDOR" /></td><td className="p-1"><Button size="sm" variant="outline" disabled={busy} onClick={() => void save(v)}>{busy ? "Saving…" : "Save"}</Button></td></tr>;
}
