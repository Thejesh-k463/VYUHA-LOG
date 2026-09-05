"use client";
/**
 * The expanded position screen: summary strip · stop-method control · chart ·
 * trailing-level rail (spec §3.2, rulings Q33/Q34/Q35).
 *
 * EVERY NUMBER ON THIS SCREEN COMES FROM `lib/live`. `computeStop` produces the
 * level and `trailSuggestions` produces the chandelier, the MA trail and the R
 * ladder. This file converts paise to rupees for display and does no money
 * arithmetic of its own beyond that division — the whole point of the pure
 * layer is that the desk's numbers can be reproduced from a fixture.
 *
 * WHY THE PANEL RECOMPUTES AT ALL. The stop-method control is a question about
 * the SAME position ("what would the structure stop be?"), so it re-runs the
 * same pure function with a different `stopMethod` rather than asking the
 * server. What it does NOT do is invent the inputs:
 *
 *  * the risk BUDGET is carried across from the server-computed `stop`
 *    (`riskBudgetP`), fed back in as `capitalP` with `riskPpm = PPM`, which
 *    reproduces that budget exactly. Capital is not a prop and this file will
 *    not guess one (invariant 6). With no server stop there is no budget, and
 *    the screen shows the risk-not-set state instead of a number;
 *  * `side` is read off the server stop (a stop below entry is a long) and only
 *    falls back to the target's direction when there is no stop at all;
 *  * the flat-percentage branch has no stored setting behind it, so its
 *    percentage is stated on screen as the chart's own, never as the user's.
 *
 * NO SERVER ACTION, NO `setState` IN AN EFFECT. The two controls are plain
 * `useState` driven by clicks; everything else is `useMemo` over props and
 * state. A `useEffect` that re-derived state here is the pattern that broke the
 * Trades filter under the React Compiler with no error anywhere.
 */
import { useMemo, useState, type JSX } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { inr, num } from "@/lib/format";
import { cn } from "@/lib/utils";
import { computeStop, type StopResult, type StopSource } from "@/lib/live/stop";
import { wilderAtrSeriesP3 } from "@/lib/live/tracker-row";
import { trailSuggestions } from "@/lib/live/trail";
import { PPM, type Bar, type Paise, type Side } from "@/lib/live/types";

const PositionChart = dynamic(() => import("@/components/charts/lw/position-chart"), {
  // lightweight-charts touches `document` on creation; every DB-backed page
  // here is `force-dynamic`, so a server import would 500 the route at request
  // time rather than failing the build.
  ssr: false,
  loading: () => <div className="h-96 w-full animate-pulse rounded-md bg-card" />,
});

const PAISE_PER_RUPEE = 100;
const rupees = (p: Paise) => p / PAISE_PER_RUPEE;

/** NSE cash-equity tick. Levels round AWAY from entry inside `computeStop`. */
const TICK_P = 5;
/** Cash equity. A derivative row carries its own lot size in the tracker. */
const LOT_SIZE = 1;
/** `risk_config.stop_atr_mult_permille` ships at 2.0 × ATR. */
const ATR_MULT_PERMILLE = 2000;
/**
 * The flat-percentage branch. There is no stored percentage behind this
 * control, so the figure is the chart's own and is LABELLED as such on screen.
 */
const PANEL_PERCENT_PPM = 80_000;
/** Sessions of low/high the structure branch reads. Stated in the note. */
const STRUCTURE_LOOKBACK = 12;
/** Ruling Q34 — 21 by default, 14 and 20 selectable. */
const ATR_LENGTHS = [14, 20, 21] as const;
const DEFAULT_ATR_LENGTH = 21;

const METHODS: { id: StopSource; label: string }[] = [
  { id: "structure", label: "Structure" },
  { id: "atr", label: "ATR" },
  { id: "percent", label: "Percent" },
  { id: "manual", label: "Manual" },
];

/** A stop below entry is a long. Only consulted when there is no stop at all. */
function deriveSide(entryP: Paise, targetP: Paise | null, stop: StopResult | null): Side {
  if (stop !== null && (stop.kind === "ok" || stop.kind === "zero")) return stop.stopP < entryP ? "long" : "short";
  if (targetP !== null && targetP < entryP) return "short";
  return "long";
}

/** Lowest low (long) / highest high (short) of the last `n` sessions. */
function structureLevelP(bars: Bar[], side: Side, n: number): Paise | null {
  const window = bars.slice(-n);
  if (window.length === 0) return null;
  const lows = window.map((b) => (side === "short" ? (b.highP ?? b.closeP) : (b.lowP ?? b.closeP)));
  return side === "short" ? Math.max(...lows) : Math.min(...lows);
}

/** The last ATR the series could produce, or null with too few sessions. */
function latestAtrP3(bars: Bar[], length: number): number | null {
  const series = wilderAtrSeriesP3(bars, length);
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return series[i];
  return null;
}

/** `+₹1,20,000` / `−₹4,500`. The minus is a real minus sign, not a hyphen. */
function signedInr(p: Paise | null): string {
  if (p === null) return "—";
  const sign = p < 0 ? "−" : "+";
  return `${sign}${inr(Math.abs(rupees(p)), { decimals: 0 })}`;
}

function moneyClass(p: Paise | null): string {
  if (p === null || p === 0) return "text-muted-foreground";
  return p > 0 ? "text-profit" : "text-loss";
}

/** One cell of the summary strip. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <div className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", tone)}>{value}</div>
    </div>
  );
}

export function PositionChartPanel(props: {
  symbol: string;
  isin: string | null;
  entryP: number;
  targetP: number | null;
  qty: number;
  accountId: number;
  stop: StopResult | null;
  bars: Bar[];
}): JSX.Element {
  const { symbol, isin, entryP, targetP, qty, accountId, stop, bars } = props;

  const serverSource = stop !== null && (stop.kind === "ok" || stop.kind === "zero") ? stop.source : null;
  const [method, setMethod] = useState<StopSource>(serverSource ?? "atr");
  const [atrLength, setAtrLength] = useState<number>(DEFAULT_ATR_LENGTH);

  const side = useMemo(() => deriveSide(entryP, targetP, stop), [entryP, targetP, stop]);

  // The budget the server already computed. null ⇒ risk-not-set, never a guess.
  const riskBudgetP = stop !== null && (stop.kind === "ok" || stop.kind === "zero") ? stop.riskBudgetP : null;
  // The user's own level, available only when the server's stop came from it.
  const manualStopP = stop !== null && (stop.kind === "ok" || stop.kind === "zero") && stop.source === "manual" ? stop.stopP : null;

  const atrP3 = useMemo(() => latestAtrP3(bars, atrLength), [bars, atrLength]);
  const structureStopP = useMemo(() => structureLevelP(bars, side, STRUCTURE_LOOKBACK), [bars, side]);

  const computed = useMemo(
    () =>
      computeStop(
        { side, entryP, tickP: TICK_P, lotSize: LOT_SIZE, manualStopP, structureStopP, atrP3 },
        {
          riskPpm: riskBudgetP === null ? null : PPM,
          capitalP: riskBudgetP,
          stopMethod: method,
          atrMultPermille: ATR_MULT_PERMILLE,
          defaultPctPpm: PANEL_PERCENT_PPM,
          deployCapPpm: null,
        },
      ),
    [side, entryP, manualStopP, structureStopP, atrP3, riskBudgetP, method],
  );

  const riskNotSet = computed.kind === "risk-not-set";
  const stopP = computed.kind === "ok" || computed.kind === "zero" ? computed.stopP : null;
  const stopSource = computed.kind === "ok" || computed.kind === "zero" ? computed.source : null;
  const riskPerShareP = computed.kind === "ok" || computed.kind === "zero" ? computed.riskPerShareP : null;

  const markP = bars.length > 0 ? bars[bars.length - 1].closeP : null;
  const dirn = side === "short" ? -1 : 1;
  const unrealisedP = markP === null ? null : qty * dirn * (markP - entryP);
  const openR = markP === null || riskPerShareP === null || riskPerShareP <= 0 ? null : (dirn * (markP - entryP)) / riskPerShareP;
  const atRiskP = markP === null || stopP === null ? null : qty * Math.max(dirn * (markP - stopP), 0);

  const trail = useMemo(
    () =>
      trailSuggestions({
        side,
        entryP,
        bars,
        currentStopP: stopP,
        riskPerShareP,
        qty,
        atrLength,
      }),
    [side, entryP, bars, stopP, riskPerShareP, qty, atrLength],
  );

  const trailLabel = trail.chandelier.levelP === null ? null : `chandelier, ${trail.chandelier.params.bars} bars × ${trail.chandelier.params.atrMultPermille / 1000} ATR`;

  const methodNote = ((): string => {
    if (riskNotSet) return "With a risk per trade recorded, every method here produces a level and a size.";
    if (computed.kind === "no-stop") return "None of the four methods has an input on this position yet.";
    if (computed.kind === "error") return `This method returns no usable level: ${computed.code.replace(/-/g, " ")}.`;
    const fellThrough = stopSource !== null && stopSource !== method;
    const prefix = fellThrough ? `No ${method} input is stored, so the level below is the ${stopSource} one. ` : "";
    switch (stopSource) {
      case "manual":
        return `${prefix}Your own level. Vyuha stores it and freezes R at first entry; nothing recomputes it behind your back.`;
      case "structure":
        return `${prefix}The extreme of the last ${STRUCTURE_LOOKBACK} sessions, rounded away from entry to the ${num(rupees(TICK_P), 2)} tick.`;
      case "atr":
        return `${prefix}${ATR_MULT_PERMILLE / 1000} × the ${atrLength}-day Wilder ATR${atrP3 === null ? "" : ` of ${num(rupees(atrP3 / 1000))}`}, measured from your entry.`;
      case "percent":
        return `${prefix}A flat ${PANEL_PERCENT_PPM / 10_000}% below entry — this chart's own figure, not a percentage read from your settings. It ignores how much this stock actually moves.`;
      default:
        return "";
    }
  })();

  const ladderBookedP =
    trail.rLadder === null || riskPerShareP === null
      ? null
      : trail.rLadder.reduce((sum, step) => sum + (step.reached ? step.qty * step.r * riskPerShareP : 0), 0);

  return (
    <section className="flex flex-col gap-4" data-testid="position-chart-panel" data-account-id={accountId}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{symbol}</h2>
        {isin === null ? null : <span className="text-[0.6875rem] tabular-nums text-muted-foreground">{isin}</span>}
        <span className="text-xs text-muted-foreground">
          Your open position, the levels you recorded, and the arithmetic between them.
        </span>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Qty" value={num(qty, 0)} />
        <Stat label="Entry" value={inr(rupees(entryP))} />
        <Stat label="Last close" value={markP === null ? "—" : inr(rupees(markP))} />
        <Stat label="Unrealised" value={signedInr(unrealisedP)} tone={moneyClass(unrealisedP)} />
        <Stat
          label="Open R"
          value={openR === null ? "—" : `${openR >= 0 ? "+" : "−"}${num(Math.abs(openR))}R`}
          tone={moneyClass(openR === null ? null : Math.round(openR * 100))}
        />
        <Stat label="₹ at risk, mark → stop" value={atRiskP === null ? "—" : inr(rupees(atRiskP), { decimals: 0 })} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="rounded-lg border border-border bg-card p-3">
          <PositionChart
            symbol={symbol}
            bars={bars}
            side={side}
            entryP={entryP}
            targetP={targetP}
            stopP={stopP}
            stopSource={stopSource}
            riskPpm={null}
            atrLength={atrLength}
            trailStopP={trail.chandelier.levelP}
            trailMethodLabel={trailLabel}
            riskNotSet={riskNotSet}
          />
        </div>

        <aside className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-card p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide">Stop method</h3>
            <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Stop method">
              {METHODS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={method === m.id}
                  onClick={() => setMethod(m.id)}
                  className={cn(
                    "rounded-md border border-border px-2 py-1 text-[0.6875rem]",
                    method === m.id ? "bg-primary text-primary-foreground" : "text-muted-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <label htmlFor="position-chart-atr-length" className="text-[0.6875rem] text-muted-foreground">
                ATR length
              </label>
              <select
                id="position-chart-atr-length"
                value={atrLength}
                onChange={(e) => setAtrLength(Number(e.target.value))}
                className="rounded-md border border-border bg-card px-2 py-1 text-[0.6875rem] tabular-nums"
              >
                {ATR_LENGTHS.map((n) => (
                  <option key={n} value={n}>
                    {n} sessions{n === DEFAULT_ATR_LENGTH ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">{methodNote}</p>
            {computed.kind === "zero" ? (
              <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
                Stop distance exceeds your risk budget — this method returns no size.
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border border-border bg-card p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide">Trailing profit suggestions</h3>

            {riskNotSet ? (
              <div className="mt-2 rounded-md border border-l-2 border-border p-3 text-[0.6875rem] leading-relaxed">
                <b className="block font-semibold">Position size needs your risk per trade.</b>
                The stop, the zones and the R ladder are hidden because there is no stored risk to compute them from.{" "}
                <Link href="/sizing-lab" className="underline underline-offset-4">
                  Open the Sizing Lab
                </Link>{" "}
                — the method and the percentage come back here.
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                <div className="rounded-md border border-border p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="text-xs font-semibold">Chandelier ATR({atrLength})×{trail.chandelier.params.atrMultPermille / 1000}</b>
                    <em className="not-italic text-xs font-semibold tabular-nums">
                      {trail.chandelier.levelP === null ? "—" : inr(rupees(trail.chandelier.levelP))}
                    </em>
                  </div>
                  <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                    The extreme since entry minus {trail.chandelier.params.atrMultPermille / 1000} ATRs. It ratchets one way
                    and never back.
                    {trail.chandelier.beyondCurrentStop === true ? " It sits beyond the stop in force." : ""}
                  </p>
                  <div className="mt-1 flex justify-between text-[0.6875rem] tabular-nums">
                    <span className="text-muted-foreground">If applied now</span>
                    <span>
                      {trail.chandelier.levelP === null
                        ? `needs ${trail.chandelier.params.atrLength + 1} sessions`
                        : `${signedInr(qty * dirn * (trail.chandelier.levelP - entryP))} locked`}
                    </span>
                  </div>
                </div>

                <div className="rounded-md border border-border p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="text-xs font-semibold">MA({trail.ma.params.maLength}) trail</b>
                    <em className="not-italic text-xs font-semibold tabular-nums">
                      {trail.ma.levelP === null ? "—" : inr(rupees(trail.ma.levelP))}
                    </em>
                  </div>
                  <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                    Exit on a close beyond the {trail.ma.params.maLength}-session mean. It moves slower than the chandelier
                    and gives back more at the turn.
                  </p>
                  <div className="mt-1 flex justify-between text-[0.6875rem] tabular-nums">
                    <span className="text-muted-foreground">If applied now</span>
                    <span>
                      {trail.ma.levelP === null
                        ? `needs ${trail.ma.params.maLength + 1} sessions`
                        : `${signedInr(qty * dirn * (trail.ma.levelP - entryP))} locked`}
                    </span>
                  </div>
                </div>

                <div className="rounded-md border border-border p-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <b className="text-xs font-semibold">R ladder · ⅓ at 1R / 2R / 3R</b>
                    <em className="not-italic text-xs font-semibold tabular-nums">
                      {trail.rLadder === null ? "—" : `${num(trail.rLadder[0].qty, 0)} sh each`}
                    </em>
                  </div>
                  <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted-foreground">
                    {riskPerShareP === null
                      ? "One R needs a stop; without one there is no ladder."
                      : `One R is ${inr(rupees(riskPerShareP))} per share. Vyuha never applies a step on its own.`}
                  </p>
                  {trail.rLadder === null ? null : (
                    <>
                      <div className="mt-2 flex gap-1">
                        {trail.rLadder.map((step) => (
                          <span
                            key={step.r}
                            className={cn(
                              "flex-1 rounded px-1 py-1 text-center text-[0.625rem] tabular-nums",
                              step.reached ? "bg-profit/15 text-profit" : "text-muted-foreground",
                            )}
                          >
                            {step.r}R {step.reached ? "reached" : "pending"}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 flex justify-between text-[0.6875rem] tabular-nums">
                        <span className="text-muted-foreground">On the levels reached</span>
                        <span>{signedInr(ladderBookedP)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
              Each level is computed from the bars on this chart and the risk you recorded. Vyuha states what each rulebook
              produces; the choice stays yours.
            </p>
          </div>
        </aside>
      </div>

      <footer className="flex flex-wrap justify-between gap-3 border-t border-border pt-3 text-[0.6875rem] text-muted-foreground">
        <span>
          {bars.length} sessions of stored end-of-day bars · the stop is computed once and passed to the chart as a number.
        </span>
        <b className="font-semibold text-foreground">Vyuha computes; it does not advise.</b>
      </footer>
    </section>
  );
}
