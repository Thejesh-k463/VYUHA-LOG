"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { positionSize, optionLotSize } from "@/lib/risk/calculators";
import { inr } from "@/lib/format";

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-md border border-border bg-card-hover/30 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

export function PositionSizeCalc({ defaultRisk }: { defaultRisk: number }) {
  const [mode, setMode] = React.useState<"sl" | "points">("sl");
  const [entry, setEntry] = React.useState("100");
  const [stop, setStop] = React.useState("95");
  const [points, setPoints] = React.useState("5");
  const [risk, setRisk] = React.useState(String(defaultRisk));
  const [lot, setLot] = React.useState("");

  const e = Number(entry) || 0;
  const stopPrice = mode === "sl" ? Number(stop) || 0 : e - (Number(points) || 0);
  const res = positionSize({ entry: e, stop: stopPrice, riskAmount: Number(risk) || 0, lotSize: Number(lot) || undefined });

  return (
    <Card>
      <CardHeader><CardTitle>Position-size calculator</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Lbl t="Mode"><Select value={mode} onChange={(e) => setMode(e.target.value as never)}><option value="sl">Stop price</option><option value="points">Points SL</option></Select></Lbl>
          <Lbl t="Entry"><Input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} /></Lbl>
          {mode === "sl"
            ? <Lbl t="Stop price"><Input type="number" step="any" value={stop} onChange={(e) => setStop(e.target.value)} /></Lbl>
            : <Lbl t="Points to SL"><Input type="number" step="any" value={points} onChange={(e) => setPoints(e.target.value)} /></Lbl>}
          <Lbl t="Risk (₹)"><Input type="number" step="any" value={risk} onChange={(e) => setRisk(e.target.value)} /></Lbl>
          <Lbl t="Lot size (optional)"><Input type="number" step="any" value={lot} onChange={(e) => setLot(e.target.value)} placeholder="for F&O" /></Lbl>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Max qty" value={res.maxQty.toLocaleString("en-IN")} cls="text-primary" />
          {res.lots != null && <Stat label="Lots" value={String(res.lots)} />}
          <Stat label="Risk / unit" value={inr(res.riskPerUnit)} />
          <Stat label="Actual risk" value={inr(res.totalRisk)} cls={res.totalRisk <= Number(risk) ? "text-profit" : "text-loss"} />
          <Stat label="Capital req." value={inr(res.capitalRequired, { decimals: 0 })} />
        </div>
        <p className="text-[11px] text-muted-foreground">
          0.73% rule: ₹{defaultRisk.toLocaleString("en-IN")} max loss ≈ {((defaultRisk / 1300000) * 100).toFixed(2)}% of the ₹13L equity bucket.
        </p>
      </CardContent>
    </Card>
  );
}

export function OptionLotCalc({ defaultRisk }: { defaultRisk: number }) {
  const [premium, setPremium] = React.useState("50");
  const [stopPremium, setStopPremium] = React.useState("30");
  const [lotSize, setLotSize] = React.useState("75");
  const [risk, setRisk] = React.useState(String(defaultRisk));

  const res = optionLotSize({ premium: Number(premium) || 0, stopPremium: Number(stopPremium) || 0, lotSize: Number(lotSize) || 0, riskAmount: Number(risk) || 0 });

  return (
    <Card>
      <CardHeader><CardTitle>Options lot sizing</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Lbl t="Entry premium"><Input type="number" step="any" value={premium} onChange={(e) => setPremium(e.target.value)} /></Lbl>
          <Lbl t="SL premium"><Input type="number" step="any" value={stopPremium} onChange={(e) => setStopPremium(e.target.value)} /></Lbl>
          <Lbl t="Lot size"><Input type="number" step="any" value={lotSize} onChange={(e) => setLotSize(e.target.value)} /></Lbl>
          <Lbl t="Risk (₹)"><Input type="number" step="any" value={risk} onChange={(e) => setRisk(e.target.value)} /></Lbl>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Max lots" value={String(res.maxLots)} cls="text-primary" />
          <Stat label="Risk / lot" value={inr(res.riskPerLot)} />
          <Stat label="Actual risk" value={inr(res.totalRisk)} cls={res.totalRisk <= Number(risk) ? "text-profit" : "text-loss"} />
          <Stat label="Premium outlay" value={inr(res.premiumOutlay, { decimals: 0 })} />
        </div>
      </CardContent>
    </Card>
  );
}

function Lbl({ t, children }: { t: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label>{t}</Label>{children}</div>;
}
