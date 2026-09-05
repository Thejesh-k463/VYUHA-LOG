"use client";

import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { formatPaise } from "@/lib/money";
import { num } from "@/lib/format";
import { BROKER_LABELS, type Broker, type Segment } from "@/lib/domain/constants";
import type { ChargeRates } from "@/lib/engine/types";
import {
  chargesAdjustedRisk,
  compareAll,
  mtfInterestDrag,
  type ChargesAdjustedRiskResult,
  type SizeResult,
  type SizingMethodId,
} from "@/lib/risk/sizing";
import {
  LAB_METHODS,
  LAB_PRODUCTS,
  LAB_PRODUCT_LABELS,
  LAB_PRODUCT_SEGMENT,
  LIVE_DESK_RANGES,
  buildSetup,
  methodByKey,
  sampleInputs,
  stopIsOriented,
  type LabInputs,
  type LabProduct,
  type ResolvedLiveDeskRisk,
} from "./lab-config";
import { MethodRail } from "./method-rail";
import { FormulaBlock } from "./formula-block";
import { ResultTiles, FlagRow } from "./tiles";
import { CompareTable } from "./compare-table";
import { WriteBackDialog } from "./write-back-dialog";

/**
 * The Sizing Lab's one client component (03 §6, spec §3.4).
 *
 * ONE piece of state holds the setup, and every figure on screen — the seven
 * compare rows, the active tab's tiles, its formula, the charges panel — is
 * DERIVED from it during render. No effect mirrors one piece of state into
 * another: that pattern is what silently broke the Trades filter, and here it
 * would also let the compare table lag the tab, which 03 §6.1 forbids in so
 * many words.
 *
 * All arithmetic is `lib/risk` in integer paise and ppm; this file converts at
 * the edge and formats with `en-IN` grouping. Charge rates arrive from the
 * server as a resolved `ChargeRates` object (invariant 3) — never a constant,
 * and the schedule that priced them is named on screen.
 */

// ---------------------------------------------------------------------------

export interface LabSchedule {
  broker: Broker;
  segment: Segment;
  rates: ChargeRates;
  /** Where the row came from — the UI states which. */
  source: "charge_config" | "default-schedule";
}

export interface LabClientProps {
  capitalRupees: number;
  risk: ResolvedLiveDeskRisk;
  brokers: Broker[];
  schedules: LabSchedule[];
  /** As-of date the rate epochs were resolved for (YYYY-MM-DD). */
  ratesAsOf: string;
}

const SOURCE_LABEL: Record<LabSchedule["source"], string> = {
  charge_config: "your saved broker schedule",
  "default-schedule": "default schedule",
};

function numberField(v: string, fallback: number): number {
  const n = Number(v.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------

export function LabClient(p: LabClientProps) {
  const [inputs, setInputs] = React.useState<LabInputs>(() =>
    sampleInputs({
      capitalRupees: p.capitalRupees,
      riskPctPpm: p.risk.riskPctPpm,
      deployCapPpm: p.risk.deployCapPpm,
      atrLen: p.risk.stopAtrLen,
      nStopMultPermille: p.risk.stopAtrMultPermille,
    }),
  );
  const [method, setMethod] = React.useState<SizingMethodId>("fixed-fractional");
  const [broker, setBroker] = React.useState<Broker>(p.brokers[0] ?? "zerodha");

  const set = <K extends keyof LabInputs>(k: K, v: LabInputs[K]) => setInputs((s) => ({ ...s, [k]: v }));

  // 1..7 switch tabs (03 §6.8). Registered once; a keystroke inside a field is
  // left to the field, so typing "5" into Capital does not jump to Kelly.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const m = methodByKey(e.key);
      if (!m) return;
      setMethod(m.id);
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── everything below is derived, every render ───────────────────────────
  const setup = buildSetup(inputs);
  const rows: SizeResult[] = compareAll(setup);
  const active = rows.find((r) => r.method === method) ?? rows[1];
  const segment = LAB_PRODUCT_SEGMENT[inputs.product];
  const schedule = p.schedules.find((s) => s.broker === broker && s.segment === segment) ?? null;

  let charges: ChargesAdjustedRiskResult | null = null;
  if (inputs.chargesOn && schedule && active.ok && active.qty > 0) {
    charges = chargesAdjustedRisk(
      {
        segment,
        qty: active.qty,
        entryP: setup.entryP,
        stopP: setup.stopP,
        capitalP: setup.capitalP,
      },
      schedule.rates,
    );
  }

  const fundedP = Math.floor((active.deployedP * (1_000_000 - inputs.mtfOwnPctPpm)) / 1_000_000);
  const mtfRatePpm = schedule ? Math.round(schedule.rates.mtfInterestAnnual * 1_000_000) : 0;
  const mtfUnknown = schedule?.rates.mtfRateUnknown ?? true;
  const drag =
    inputs.product === "mtf" && active.ok && active.qty > 0 && !mtfUnknown
      ? mtfInterestDrag(
          { fundedP, positionValueP: active.deployedP, otherChargesP: charges?.chargesP ?? 0 },
          mtfRatePpm,
          inputs.mtfDaysHeld,
        )
      : null;

  const riskPerShareP = Math.abs(setup.entryP - setup.stopP);
  const oriented = stopIsOriented(inputs);
  const capitalUnset = !(inputs.capitalRupees > 0);
  const activeMeta = LAB_METHODS.find((m) => m.id === active.method)!;

  return (
    <div className="space-y-4">
      {/* Header row: title, the stored-risk chip, and the explicit write-back. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Sizing Lab</h1>
          <p className="text-xs text-muted-foreground">
            One trade, seven rulebooks for how many shares. Enter your numbers on the left, then switch methods with
            the rail or the keys 1–7 — the formula shows your own figures substituted in, and the table below computes
            all seven at once.
          </p>
        </div>
        <Badge variant={p.risk.riskSource === "stored" ? "accent" : "secondary"} size="chip">
          {p.risk.riskSource === "stored"
            ? `Stored risk per trade ${num(p.risk.riskPctPpm / 10_000, 2)}%`
            : `No risk per trade stored yet · lab default ${num(p.risk.riskPctPpm / 10_000, 2)}%`}
        </Badge>
        <WriteBackDialog
          stored={p.risk.stored}
          values={{
            riskPctPpm: Math.round(inputs.riskPctPpm),
            deployCapPpm: Math.round(inputs.deployCapPpm),
            stopMethod: "atr",
            stopAtrLen: Math.round(inputs.atrLen),
            stopAtrMultPermille: Math.round(inputs.nStopMultPermille),
          }}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* ── Left: the one shared setup ────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Trade setup</CardTitle>
            <p className="text-[0.6875rem] text-muted-foreground">
              Opens on a sample swing trade. Every field is yours to change; nothing here is stored.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label htmlFor="lab-capital">Capital (₹)</Label>
              <Input
                id="lab-capital"
                inputMode="decimal"
                value={inputs.capitalRupees}
                onChange={(e) => set("capitalRupees", numberField(e.target.value, inputs.capitalRupees))}
              />
              {capitalUnset ? (
                <p className="pt-1 text-[0.6875rem] text-warning">
                  Capital is not configured, so the fraction-of-capital methods have no denominator. Set it in Settings,
                  or type a figure here to work through the arithmetic.
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="lab-entry">Entry price</Label>
                <Input
                  id="lab-entry"
                  inputMode="decimal"
                  value={inputs.entryRupees}
                  onChange={(e) => set("entryRupees", numberField(e.target.value, inputs.entryRupees))}
                />
              </div>
              <div>
                <Label htmlFor="lab-stop">Stop-loss price</Label>
                <Input
                  id="lab-stop"
                  inputMode="decimal"
                  value={inputs.stopRupees}
                  onChange={(e) => set("stopRupees", numberField(e.target.value, inputs.stopRupees))}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="lab-risk">
                Risk per trade — {num(inputs.riskPctPpm / 10_000, 2)}% of capital
              </Label>
              <input
                id="lab-risk"
                type="range"
                className="w-full accent-[var(--color-primary)]"
                min={LIVE_DESK_RANGES.riskPctPpm.min}
                max={LIVE_DESK_RANGES.riskPctPpm.max}
                step={500}
                value={inputs.riskPctPpm}
                onChange={(e) => set("riskPctPpm", Number(e.target.value))}
              />
              <p className="text-[0.6875rem] text-muted-foreground">
                0.1% to 5%. Used by fixed fractional, % volatility and Kelly. Dragging it changes the figures on screen
                and stores nothing.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label htmlFor="lab-atr">ATR (₹)</Label>
                <Input
                  id="lab-atr"
                  inputMode="decimal"
                  value={inputs.atrRupees}
                  onChange={(e) => set("atrRupees", numberField(e.target.value, inputs.atrRupees))}
                />
              </div>
              <div>
                <Label htmlFor="lab-atrlen">Length</Label>
                <Input
                  id="lab-atrlen"
                  inputMode="numeric"
                  value={inputs.atrLen}
                  onChange={(e) => set("atrLen", numberField(e.target.value, inputs.atrLen))}
                />
              </div>
              <div>
                <Label htmlFor="lab-nmult">N-stop ×</Label>
                <Input
                  id="lab-nmult"
                  inputMode="decimal"
                  value={inputs.nStopMultPermille / 1000}
                  onChange={(e) =>
                    set("nStopMultPermille", Math.round(numberField(e.target.value, inputs.nStopMultPermille / 1000) * 1000))
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="lab-lot">Lot size</Label>
                <Input
                  id="lab-lot"
                  inputMode="numeric"
                  value={inputs.lotSize}
                  onChange={(e) => set("lotSize", numberField(e.target.value, inputs.lotSize))}
                />
              </div>
              <div>
                <Label htmlFor="lab-dir">Direction</Label>
                <Select
                  id="lab-dir"
                  value={inputs.direction}
                  onChange={(e) => set("direction", e.target.value as LabInputs["direction"])}
                >
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="lab-product">Product</Label>
                <Select
                  id="lab-product"
                  value={inputs.product}
                  onChange={(e) => set("product", e.target.value as LabProduct)}
                >
                  {LAB_PRODUCTS.map((pr) => (
                    <option key={pr} value={pr}>
                      {LAB_PRODUCT_LABELS[pr]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="lab-broker">Broker schedule</Label>
                <Select id="lab-broker" value={broker} onChange={(e) => setBroker(e.target.value as Broker)}>
                  {p.brokers.map((b) => (
                    <option key={b} value={b}>
                      {BROKER_LABELS[b]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {inputs.product === "mtf" ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="lab-mtf-days">MTF days held</Label>
                  <Input
                    id="lab-mtf-days"
                    inputMode="numeric"
                    value={inputs.mtfDaysHeld}
                    onChange={(e) => set("mtfDaysHeld", numberField(e.target.value, inputs.mtfDaysHeld))}
                  />
                </div>
                <div>
                  <Label htmlFor="lab-mtf-own">Own funds (%)</Label>
                  <Input
                    id="lab-mtf-own"
                    inputMode="decimal"
                    value={inputs.mtfOwnPctPpm / 10_000}
                    onChange={(e) =>
                      set("mtfOwnPctPpm", Math.round(numberField(e.target.value, inputs.mtfOwnPctPpm / 10_000) * 10_000))
                    }
                  />
                </div>
              </div>
            ) : null}

            {/* Footer chip — the one line that says whether the setup is even
                arithmetically valid before any method is chosen. */}
            <div
              className={`rounded-md border p-2 text-[0.6875rem] ${
                oriented ? "border-border bg-muted/[0.06] text-muted-foreground" : "border-loss/40 bg-loss/[0.06] text-loss"
              }`}
            >
              {oriented ? (
                <>
                  Risk per share {formatPaise(riskPerShareP)} (
                  {num((riskPerShareP * 100) / Math.max(1, setup.entryP), 1)}% of entry) · risk budget{" "}
                  {formatPaise(Math.floor((setup.capitalP * setup.riskPpm) / 1_000_000), { decimals: 0 })} ·{" "}
                  {LAB_PRODUCT_LABELS[inputs.product]} · {inputs.direction}
                </>
              ) : (
                <>The stop sits on the wrong side of entry for a {inputs.direction} trade at these two prices.</>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Right: rail + body ────────────────────────────────────────── */}
        <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
          <MethodRail active={active.method} onSelect={setMethod} />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">{activeMeta.label}</CardTitle>
              <p className="text-[0.6875rem] text-muted-foreground">{activeMeta.description}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <MethodExtras id={active.method} inputs={inputs} set={set} />

              <FormulaBlock result={active} />

              <ResultTiles
                result={active}
                capitalP={setup.capitalP}
                entryP={setup.entryP}
                lotSize={setup.lotSize ?? 1}
                deployCapOn={inputs.deployCapOn}
                deployCapPpm={inputs.deployCapPpm}
                charges={charges}
                ratesLabel={schedule ? SOURCE_LABEL[schedule.source] : null}
              />
              <FlagRow result={active} />

              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={inputs.deployCapOn}
                    onCheckedChange={(v) => set("deployCapOn", v === true)}
                    aria-label="Apply the max-deploy cap"
                  />
                  Max-deploy cap
                  <Input
                    className="h-7 w-16"
                    inputMode="decimal"
                    aria-label="Deploy cap, percent of capital"
                    value={inputs.deployCapPpm / 10_000}
                    onChange={(e) =>
                      set("deployCapPpm", Math.round(numberField(e.target.value, inputs.deployCapPpm / 10_000) * 10_000))
                    }
                  />
                  %
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={inputs.chargesOn}
                    onCheckedChange={(v) => set("chargesOn", v === true)}
                    aria-label="Add brokerage and statutory charges"
                  />
                  Charges-adjusted R
                </label>
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">
                {inputs.deployCapOn
                  ? "The cap is on: a computed size larger than this share of capital is clipped down to it, and the row says so. Raw Kelly regularly returns more than the whole account."
                  : "The cap is off: sizes may come out larger than capital, and the rows will say so."}
              </p>

              {inputs.chargesOn ? (
                <ChargesPanel
                  charges={charges}
                  schedule={schedule}
                  asOf={p.ratesAsOf}
                  product={inputs.product}
                  drag={drag}
                  mtfUnknown={mtfUnknown}
                  mtfRatePpm={mtfRatePpm}
                  fundedP={fundedP}
                  days={inputs.mtfDaysHeld}
                />
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Compare</CardTitle>
          <p className="text-[0.6875rem] text-muted-foreground">
            Every method recomputes on each keystroke, so the table never lags the tab. The order is the catalogue
            order — it is not a ranking, and no row is marked as preferred.
          </p>
        </CardHeader>
        <CardContent>
          <CompareTable rows={rows} active={active.method} onSelect={setMethod} />
        </CardContent>
      </Card>

      {/* The three standing disclaimers (03 §9), beside the results and not
          hidden below them. */}
      <div className="space-y-1 rounded-md border border-border bg-muted/[0.06] p-3 text-[0.6875rem] text-muted-foreground">
        <p>A calculator: it computes sizes from the figures entered. Vyuha computes; it does not advise.</p>
        <p>
          Stops are not guaranteed fills — gaps, circuits and illiquidity can execute worse than the level shown.
        </p>
        <p>Figures exclude brokerage and statutory charges unless the charges toggle is on.</p>
        <p>
          Arithmetic in integer paise, floored once at the end · Indian grouping throughout · charge rates read from the
          schedule you keep in Settings.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-method extra inputs
// ---------------------------------------------------------------------------

function MethodExtras({
  id,
  inputs,
  set,
}: {
  id: SizingMethodId;
  inputs: LabInputs;
  set: <K extends keyof LabInputs>(k: K, v: LabInputs[K]) => void;
}) {
  const field = (
    key: string,
    label: string,
    value: number,
    onChange: (n: number) => void,
  ) => (
    <div key={key}>
      <Label htmlFor={`lab-x-${key}`}>{label}</Label>
      <Input
        id={`lab-x-${key}`}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(numberField(e.target.value, value))}
      />
    </div>
  );

  const fields: React.ReactNode[] = [];
  if (id === "fixed-rupee") {
    fields.push(field("amount", "Amount to allocate (₹)", inputs.fixedAmountRupees, (n) => set("fixedAmountRupees", n)));
  } else if (id === "volatility-unit") {
    fields.push(
      field("unit", "Unit risk (% of capital)", inputs.unitRiskPpm / 10_000, (n) =>
        set("unitRiskPpm", Math.round(n * 10_000)),
      ),
    );
  } else if (id === "kelly") {
    fields.push(
      field("win", "Win rate (%)", inputs.winPpm / 10_000, (n) => set("winPpm", Math.round(n * 10_000))),
      field("payoff", "Payoff (R)", inputs.payoffPpm / 1_000_000, (n) => set("payoffPpm", Math.round(n * 1_000_000))),
      field("kfrac", "Kelly fraction", inputs.kellyFractionPpm / 1_000_000, (n) =>
        set("kellyFractionPpm", Math.round(n * 1_000_000)),
      ),
    );
  } else if (id === "fixed-ratio") {
    fields.push(
      field("delta", "Delta δ (₹ per unit)", inputs.deltaRupees, (n) => set("deltaRupees", n)),
      field("closed", "Closed profit (₹)", inputs.closedProfitRupees, (n) => set("closedProfitRupees", n)),
      field("block", "Block qty per unit", inputs.blockQty, (n) => set("blockQty", n)),
    );
  } else if (id === "equal-weight") {
    fields.push(field("slots", "Portfolio slots", inputs.slots, (n) => set("slots", n)));
  }

  if (fields.length === 0) return null;
  return <div className="grid gap-2 sm:grid-cols-3">{fields}</div>;
}

// ---------------------------------------------------------------------------
// Charges panel
// ---------------------------------------------------------------------------

function ChargesPanel({
  charges,
  schedule,
  asOf,
  product,
  drag,
  mtfUnknown,
  mtfRatePpm,
  fundedP,
  days,
}: {
  charges: ChargesAdjustedRiskResult | null;
  schedule: LabSchedule | null;
  asOf: string;
  product: LabProduct;
  drag: ReturnType<typeof mtfInterestDrag> | null;
  mtfUnknown: boolean;
  mtfRatePpm: number;
  fundedP: number;
  days: number;
}) {
  if (!schedule) {
    return (
      <p className="rounded-md border border-border p-3 text-[0.6875rem] text-muted-foreground">
        No charge schedule is on file for this broker and product, so the charges figure is left blank rather than
        estimated.
      </p>
    );
  }
  if (!charges) {
    return (
      <p className="rounded-md border border-border p-3 text-[0.6875rem] text-muted-foreground">
        There is no quantity to charge yet — the round trip appears once this method returns a size above zero.
      </p>
    );
  }

  const b = charges.breakdownP;
  const lines: [string, number][] = [
    ["Brokerage", b.brokerage],
    ["STT / CTT", b.sttCtt],
    ["Exchange transaction", b.exchangeTxn],
    ["SEBI turnover", b.sebi],
    ["Stamp duty (purchase leg)", b.stampDuty],
    ["IPFT", b.ipft],
    ["GST", b.gst],
    ["DP charges", b.dpCharges],
    ["Pledge charges", b.pledgeCharges],
  ];

  return (
    <div className="rounded-md border border-border p-3 text-[0.6875rem]">
      <div className="pb-1.5 text-muted-foreground">
        Round trip if the stop is hit · {BROKER_LABELS[schedule.broker]} · {SOURCE_LABEL[schedule.source]} · rates as
        at {asOf}
      </div>
      <table className="w-full">
        <tbody>
          {lines
            .filter(([, v]) => v !== 0)
            .map(([label, v]) => (
              <tr key={label}>
                <th scope="row" className="py-0.5 text-left font-normal text-muted-foreground">
                  {label}
                </th>
                <td className="py-0.5 text-right tabular-nums">{formatPaise(v)}</td>
              </tr>
            ))}
          <tr className="border-t border-border">
            <th scope="row" className="py-1 text-left font-medium">
              Total round trip
            </th>
            <td className="py-1 text-right font-medium tabular-nums">{formatPaise(charges.chargesP)}</td>
          </tr>
        </tbody>
      </table>

      {/* Owner Q41 — the MTF row exists only when the product is MTF. */}
      {product === "mtf" ? (
        <div className="mt-2 border-t border-border pt-2 text-muted-foreground">
          {mtfUnknown ? (
            <>This broker publishes no MTF interest rate, so the funding drag is left blank rather than assumed.</>
          ) : drag ? (
            <>
              MTF interest drag · {num(mtfRatePpm / 10_000, 2)}% p.a. × {num(days, 0)} days on{" "}
              {formatPaise(fundedP, { decimals: 0 })} funded ={" "}
              <span className="tabular-nums text-foreground">{formatPaise(drag.interestP)}</span>
              {drag.breakevenMovePpm != null ? (
                <> · break-even move {num(drag.breakevenMovePpm / 10_000, 2)}% including the charges above</>
              ) : null}
            </>
          ) : (
            <>There is no funded amount to accrue interest on at this size.</>
          )}
        </div>
      ) : null}
    </div>
  );
}
