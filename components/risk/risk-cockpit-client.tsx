"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  computeExposure,
  sectorConcentration,
  type ExposureInput,
  type ExposurePosition,
  type RiskLevel,
  type SectorConcentration,
} from "@/lib/analytics/exposure";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { inr, inrCompact, num } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";
import { ExportButtons } from "@/components/ui/export-button";
import { ChevronDown, SlidersHorizontal, CheckCircle2, AlertCircle, ShieldAlert, ShieldCheck, CircleX } from "lucide-react";

const POSITION_EXPORT_COLS = [
  { key: "symbol", label: "Symbol" }, { key: "bucket", label: "Bucket" }, { key: "segment", label: "Segment" },
  { key: "side", label: "Side" }, { key: "qty", label: "Qty" }, { key: "entry", label: "Entry" },
  { key: "mtm", label: "MTM" }, { key: "invested", label: "Invested" }, { key: "currentValue", label: "Current value" },
  { key: "unrealised", label: "Unrealised" }, { key: "returnPct", label: "Return %" }, { key: "allocPct", label: "Alloc %" },
  { key: "stop", label: "Stop" }, { key: "target", label: "Target" }, { key: "openRiskAmt", label: "Open risk" },
  { key: "initialRiskAmt", label: "Initial risk" }, { key: "rr", label: "R:R" }, { key: "sector", label: "Sector" },
  { key: "dte", label: "DTE" },
];

const RISK_STYLE: Record<RiskLevel, { label: string; text: string; dot: string; ring: string }> = {
  low: { label: "Low Risk", text: "text-profit", dot: "bg-profit", ring: "ring-profit/30" },
  medium: { label: "Medium Risk", text: "text-warning", dot: "bg-warning", ring: "ring-warning/30" },
  high: { label: "High Risk", text: "text-loss", dot: "bg-loss", ring: "ring-loss/30" },
};

type Scope = "all" | "equity" | "active";

export function RiskCockpitClient({
  inputs,
  capitals,
}: {
  inputs: ExposureInput[];
  capitals: { equity: number; active: number; all: number };
}) {
  const router = useRouter();
  const [scope, setScope] = React.useState<Scope>("all");
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<ExposurePosition | null>(null);
  const [closing, setClosing] = React.useState<ExposurePosition | null>(null);

  const [trailingId, setTrailingId] = React.useState<number | null>(null);

  const filtered = React.useMemo(
    () => (scope === "all" ? inputs : inputs.filter((i) => i.bucket === scope)),
    [inputs, scope],
  );
  const capital = capitals[scope];
  const e = React.useMemo(() => computeExposure(filtered, capital), [filtered, capital]);
  const sectors = React.useMemo(() => sectorConcentration(e.positions, capital), [e.positions, capital]);
  const rs = RISK_STYLE[e.riskLevel];

  async function trailBreakeven(id: number) {
    setTrailingId(id);
    try {
      await fetch("/api/positions/trail", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId: id, mode: "breakeven" }),
      });
      router.refresh();
    } finally {
      setTrailingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header / exposure banner */}
      <Card className="overflow-hidden border-border bg-gradient-to-br from-surface to-card p-0">
        <div className="flex items-start justify-between p-6">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Live Exposure</div>
            <h2 className="mt-1 text-3xl font-bold tracking-tight">Portfolio Risk</h2>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex rounded-lg border border-border bg-background/40 p-0.5 text-xs">
              {(["all", "equity", "active"] as Scope[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={`rounded-md px-3 py-1 transition-colors ${
                    scope === s ? "bg-primary/15 font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s === "all" ? "All" : s === "equity" ? "Equity" : "Trade F&O"}
                </button>
              ))}
            </div>
            <div className={`flex items-center gap-1.5 rounded-full bg-background/50 px-3 py-1.5 text-sm font-semibold ring-1 ${rs.ring} ${rs.text}`}>
              <span className={`size-2 rounded-full ${rs.dot}`} />
              {rs.label}
            </div>
          </div>
        </div>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 gap-3 px-6 pb-6 lg:grid-cols-4">
          <Tile label="Initial Risk" value={`${e.initialRiskPct.toFixed(2)}%`} valueCls="text-primary" />
          <Tile label="Open P&L" value={`${e.openPnlPct >= 0 ? "+" : ""}${e.openPnlPct.toFixed(2)}%`} valueCls={e.openPnlPct >= 0 ? "text-profit" : "text-loss"} />
          <Tile label="Open Risk @ SL" value={`${e.openRiskPct.toFixed(2)}%`} valueCls="text-warning" highlight />
          <Tile label="Allocated" value={`${e.allocatedPct.toFixed(2)}%`} valueCls="text-violet-400" />
        </div>
      </Card>

      {/* Live tracker */}
      <Card className="p-0">
        <div className="flex items-end justify-between p-5 pb-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Live Tracker</div>
            <h3 className="mt-0.5 text-lg font-semibold">Open Positions</h3>
          </div>
          <div className="text-sm text-muted-foreground">{e.count} position{e.count === 1 ? "" : "s"}</div>
        </div>

        {e.count === 0 ? (
          <div className="px-5 pb-8 pt-2 text-sm text-muted-foreground">
            No open positions in this scope. Import or add trades, then set MTM prices and stops here.
          </div>
        ) : (
          <div className="px-2 pb-3">
            <div className="flex justify-end px-3 pt-1">
              <ExportButtons
                filename="vyuha-open-positions"
                columns={POSITION_EXPORT_COLS}
                rows={e.positions.map((p) => ({
                  symbol: p.symbol, bucket: p.bucket, segment: p.segment, side: p.side ?? "long",
                  qty: p.qty, entry: p.entry, mtm: p.mtm, invested: p.invested, currentValue: p.currentValue,
                  unrealised: p.unrealised, returnPct: p.returnPct, allocPct: p.allocPct,
                  stop: p.effectiveStop ?? "", target: p.target ?? "",
                  openRiskAmt: p.openRiskAmt ?? "", initialRiskAmt: p.initialRiskAmt ?? "",
                  rr: p.rr ?? "", sector: p.sector ?? "", dte: p.dte ?? "",
                }))}
              />
            </div>
            {/* column header */}
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <div>Stock</div>
              <div className="w-28 text-right">Running impact</div>
              <div className="w-28 text-right">
                <span className="text-warning">Open risk</span>
                <div className="text-[9px] normal-case text-muted-foreground/70">if SL/TSL hits</div>
              </div>
              <div className="w-36 text-right">Alloc</div>
            </div>

            <div className="space-y-1">
              {e.positions.map((p) => (
                <PositionRow
                  key={p.id}
                  p={p}
                  open={expanded === p.id}
                  onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
                  onEdit={() => setEditing(p)}
                  onClose={() => setClosing(p)}
                  onTrailBreakeven={() => trailBreakeven(p.id)}
                  trailing={trailingId === p.id}
                />
              ))}
            </div>
          </div>
        )}
      </Card>

      {sectors.totalInvested > 0 && <SectorPanel s={sectors} />}

      {e.unstoppedCount > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning/90">
          <ShieldAlert className="size-4 shrink-0" />
          {e.unstoppedCount} position{e.unstoppedCount === 1 ? " has" : "s have"} no stop set — their full invested value is counted as capital-at-risk. Set an SL to size the real risk.
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          {editing && (
            <RiskEditDialog
              p={editing}
              onSaved={() => {
                setEditing(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!closing} onOpenChange={(o) => !o && setClosing(null)}>
        <DialogContent className="max-w-md">
          {closing && (
            <CloseDialog
              p={closing}
              onClosed={() => {
                setClosing(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectorPanel({ s }: { s: SectorConcentration }) {
  // Concentrated = HHI high or one sector dominates capital. Mirrors the cockpit's
  // low/medium/high vocabulary so the signal reads consistently.
  const heat = s.topAllocPct > 35 || s.hhi > 0.5 ? "high" : s.topAllocPct > 20 || s.hhi > 0.33 ? "medium" : "low";
  const heatCls = heat === "high" ? "text-loss" : heat === "medium" ? "text-warning" : "text-profit";
  const palette = ["bg-violet-500", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-teal-500", "bg-fuchsia-500", "bg-slate-500"];
  return (
    <Card className="p-0">
      <div className="flex items-end justify-between p-5 pb-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Concentration</div>
          <h3 className="mt-0.5 text-lg font-semibold">By Sector</h3>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>Top: <span className={`font-medium ${heatCls}`}>{s.topSector}</span> {s.topAllocPct.toFixed(1)}% of capital</div>
          <div>HHI {s.hhi.toFixed(2)} · {s.classifiedPct.toFixed(0)}% classified</div>
        </div>
      </div>
      <div className="space-y-2 px-5 pb-5">
        {s.slices.map((slice, i) => (
          <div key={slice.sector} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-xs">
            <span className={`truncate ${slice.sector === "Unclassified" ? "text-muted-foreground" : ""}`}>{slice.sector}</span>
            <div className="h-2 overflow-hidden rounded-full bg-card-hover">
              <div className={`h-full rounded-full ${palette[i % palette.length]}`} style={{ width: `${Math.min(100, slice.sharePct)}%` }} />
            </div>
            <span className="w-28 text-right tabular-nums text-muted-foreground">
              {inrCompact(slice.invested)} · {slice.allocPct.toFixed(1)}%
            </span>
          </div>
        ))}
        {s.classifiedPct < 100 && (
          <p className="pt-1 text-[11px] text-muted-foreground">
            {(100 - s.classifiedPct).toFixed(0)}% of invested capital is unclassified — add sectors on{" "}
            <span className="text-foreground">Instruments</span> for a complete picture.
          </p>
        )}
      </div>
    </Card>
  );
}

function Tile({ label, value, valueCls, highlight }: { label: string; value: string; valueCls: string; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border bg-background/30 p-4 ${highlight ? "border-warning/50" : "border-border"}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${valueCls}`}>{value}</div>
    </div>
  );
}

function PositionRow({
  p, open, onToggle, onEdit, onClose, onTrailBreakeven, trailing,
}: {
  p: ExposurePosition;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onClose: () => void;
  onTrailBreakeven: () => void;
  trailing: boolean;
}) {
  const impactCls = p.runningImpactPct >= 0 ? "bg-profit/15 text-profit" : "bg-loss/15 text-loss";
  const isShort = p.side === "short";
  const inProfit = isShort ? p.mtm <= p.entry : p.mtm >= p.entry;
  const alreadyAtBreakeven = p.trailingSl != null && Math.abs(p.trailingSl - p.entry) < 1e-6;
  return (
    <div className="rounded-lg">
      <button
        onClick={onToggle}
        className="grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-4 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-card-hover/50"
      >
        <div className="flex items-center gap-2">
          <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          <span className="rounded-md border border-border bg-background/40 px-2.5 py-1 text-sm font-semibold">{p.symbol}</span>
          {p.optionType && (
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${isShort ? "bg-loss/15 text-loss" : "bg-profit/15 text-profit"}`}>
              {isShort ? "Short" : "Long"}
            </span>
          )}
          {p.optionType && <span className="text-[10px] text-muted-foreground">{p.strike} {p.optionType}</span>}
        </div>
        <div className="w-28 text-right">
          <span className={`rounded-md px-2 py-1 text-xs font-medium tabular-nums ${impactCls}`}>
            {p.runningImpactPct >= 0 ? "+" : ""}{p.runningImpactPct.toFixed(2)}%
          </span>
        </div>
        <div className="w-28 text-right">
          <span className="rounded-md bg-warning/15 px-2 py-1 text-xs font-medium tabular-nums text-warning">
            {p.openRiskPct == null ? "—" : `${p.openRiskPct.toFixed(2)}%`}
          </span>
        </div>
        <div className="flex w-36 items-center justify-end gap-2">
          <span className="text-xs font-medium tabular-nums text-violet-400">{p.allocPct.toFixed(1)}%</span>
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-card-hover">
            <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.min(100, p.allocPct)}%` }} />
          </div>
        </div>
      </button>

      {open && (
        <div className="mx-3 mb-2 rounded-lg border border-border bg-background/30 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
            <Detail k="Segment" v={SEGMENT_LABELS[p.segment as Segment] ?? p.segment} />
            <Detail k="Qty" v={num(p.qty, 0)} />
            <Detail k="Entry" v={num(p.entry, 2)} />
            <Detail k="MTM" v={num(p.mtm, 2)} />
            <Detail k="Invested" v={inrCompact(p.invested)} />
            <Detail k="Return" v={`${p.returnPct >= 0 ? "+" : ""}${p.returnPct.toFixed(2)}%`} cls={p.returnPct >= 0 ? "text-profit" : "text-loss"} />
            <Detail k="Original SL" v={p.originalSl == null ? "—" : num(p.originalSl, 2)} />
            <Detail k="Trailing SL" v={p.trailingSl == null ? "—" : num(p.trailingSl, 2)} />
            <Detail k="Target" v={p.target == null ? "—" : num(p.target, 2)} />
            <Detail k="Reward:Risk" v={p.rr == null ? "—" : `${p.rr.toFixed(2)}R`} />
            <Detail k="Open risk ₹" v={p.openRiskAmt == null ? "—" : inrCompact(p.openRiskAmt)} cls="text-warning" />
            <Detail k="Initial risk ₹" v={p.initialRiskAmt == null ? "—" : inrCompact(p.initialRiskAmt)} />
            <Detail k="Days held" v={p.daysHeld ?? "—"} />
            <Detail k="DTE" v={p.dte ?? "—"} />
            <Detail k="To target" v={p.toTargetPct == null ? "—" : `${p.toTargetPct.toFixed(2)}%`} />
            <Detail k="Effective stop" v={p.effectiveStop == null ? "—" : num(p.effectiveStop, 2)} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onTrailBreakeven}
              disabled={trailing || !inProfit || alreadyAtBreakeven}
              title={
                alreadyAtBreakeven
                  ? "Trailing stop already at breakeven"
                  : !inProfit
                    ? "Position is not in profit — can't trail above the current price"
                    : "Move trailing stop to entry (lock in no-loss)"
              }
            >
              <ShieldCheck className="size-3.5" />
              {trailing ? "Trailing…" : alreadyAtBreakeven ? "At breakeven" : "Trail to breakeven"}
            </Button>
            <Button size="sm" variant="secondary" onClick={onEdit}>
              <SlidersHorizontal className="size-3.5" /> Set SL / TSL / target / price
            </Button>
            <Button size="sm" variant="destructive" onClick={onClose}>
              <CircleX className="size-3.5" /> Close position
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`tabular-nums ${cls ?? ""}`}>{v}</span>
    </div>
  );
}

function RiskEditDialog({ p, onSaved }: { p: ExposurePosition; onSaved: () => void }) {
  const [originalSl, setOriginalSl] = React.useState(p.originalSl == null ? "" : String(p.originalSl));
  const [trailingSl, setTrailingSl] = React.useState(p.trailingSl == null ? "" : String(p.trailingSl));
  const [target, setTarget] = React.useState(p.target == null ? "" : String(p.target));
  const [mtmPrice, setMtmPrice] = React.useState(String(p.mtm));
  const [impliedVol, setImpliedVol] = React.useState(p.impliedVol == null ? "" : String(p.impliedVol));
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setPending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/positions/risk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId: p.id, originalSl, trailingSl, target, mtmPrice, impliedVol }),
      });
      const json = await res.json();
      if (json.ok) {
        onSaved();
      } else {
        setMsg({ ok: false, text: json.message ?? "Failed" });
      }
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{p.symbol} — risk inputs</DialogTitle>
        <DialogDescription>Entry {num(p.entry, 2)} · {num(p.qty, 0)} qty · invested {inrCompact(p.invested)}</DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Fld label="Original SL"><Input type="number" step="any" value={originalSl} onChange={(e) => setOriginalSl(e.target.value)} /></Fld>
        <Fld label="Trailing SL (TSL)"><Input type="number" step="any" value={trailingSl} onChange={(e) => setTrailingSl(e.target.value)} /></Fld>
        <Fld label="Target"><Input type="number" step="any" value={target} onChange={(e) => setTarget(e.target.value)} /></Fld>
        <Fld label="Current price (MTM)"><Input type="number" step="any" value={mtmPrice} onChange={(e) => setMtmPrice(e.target.value)} /></Fld>
        {p.optionType && (
          <Fld label="Implied vol % (for Greeks)">
            <Input type="number" step="any" value={impliedVol} onChange={(e) => setImpliedVol(e.target.value)} placeholder="e.g. 15 — blank = 20% default" />
          </Fld>
        )}
      </div>
      <div className="flex items-center justify-end gap-2">
        {msg && (
          <span className={`mr-auto flex items-center gap-1.5 text-xs ${msg.ok ? "text-profit" : "text-loss"}`}>
            {msg.ok ? <CheckCircle2 className="size-3.5" /> : <AlertCircle className="size-3.5" />}{msg.text}
          </span>
        )}
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </>
  );
}

function CloseDialog({ p, onClosed }: { p: ExposurePosition; onClosed: () => void }) {
  const [exitPrice, setExitPrice] = React.useState(String(p.mtm));
  const [exitDate, setExitDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [pending, setPending] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const exit = Number(exitPrice) || 0;
  const isShort = p.side === "short";
  // Short profits when bought back (covered) below the entry premium — inverse of a long.
  const estGross = (exit - p.entry) * p.qty * (isShort ? -1 : 1);

  async function close() {
    setPending(true); setMsg(null);
    try {
      const res = await fetch("/api/positions/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tradeId: p.id, exitPrice, exitDate }),
      });
      const json = await res.json();
      if (json.ok) onClosed();
      else setMsg(json.message ?? "Failed");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isShort ? "Cover" : "Close"} {p.symbol}</DialogTitle>
        <DialogDescription>
          {isShort ? "Sold" : "Entry"} {num(p.entry, 2)} · {num(p.qty, 0)} qty · invested {inrCompact(p.invested)}
        </DialogDescription>
      </DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <Fld label={isShort ? "Buy-back (cover) price" : "Exit price"}><Input type="number" step="any" value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} /></Fld>
        <Fld label={isShort ? "Cover date" : "Exit date"}><Input type="date" value={exitDate} onChange={(e) => setExitDate(e.target.value)} /></Fld>
      </div>
      <div className="rounded-md border border-border bg-card-hover/30 p-3 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Est. gross P&amp;L (before charges)</span>
          <span className={`tabular-nums font-medium ${estGross >= 0 ? "text-profit" : "text-loss"}`}>{inr(estGross)}</span>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          {isShort ? "Covering" : "Closing"} recomputes full charges{p.segment === "eq_mtf" ? " + MTF interest over the holding period" : ""} and moves this to realised P&amp;L.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2">
        {msg && <span className="mr-auto text-xs text-loss">{msg}</span>}
        <DialogClose asChild><Button type="button" variant="ghost">Cancel</Button></DialogClose>
        <Button type="button" variant="destructive" onClick={close} disabled={pending || exit <= 0}>{pending ? (isShort ? "Covering…" : "Closing…") : isShort ? "Cover position" : "Close position"}</Button>
      </div>
    </>
  );
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
