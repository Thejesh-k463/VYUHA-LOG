"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ProLock } from "@/components/system/pro-lock";
import { RiskEditDialog } from "@/components/risk/risk-edit-dialog";
import { daysToResults } from "@/lib/live/results-date";
import { stopChip } from "@/lib/live/positions-view";
import {
  EM_DASH,
  POSITIONS_COPY,
  needsData,
  resultsChip,
  riskAtStopSentence,
  stalenessLabel,
} from "./desk-copy";
import * as fmt from "./desk-format";
import type { DeskRow, LiveDeskData } from "./desk-types";
import { PositionCalculator } from "./position-calculator";

/**
 * The Positions tab's pop-up card — artboard Blend 2 (v4.7.0 C4, D9).
 *
 * The BODY of a `<DialogContent>`: `positions-tab.tsx` owns the `<Dialog>` and
 * which row it shows, so j/k can swap the row behind an open card without
 * remounting the dialog.
 *
 * BIGGER THAN EVERY OTHER DESK SURFACE (owner): body text 13–15 px, figures
 * 22 px, the zone bar 14 px, actions 38 px. Nothing in here is below 13 px.
 *
 * FREE / PRO (ruling P6 — facts free, risk Pro): the zone bar, quantity, entry,
 * mark, the stop and target LEVELS, partials, results and corporate actions
 * and the arithmetic of levels are free. Risk at stop, R, heat share, % of
 * capital, the 30-session zone chart, the inline calculator and Edit levels
 * render `<ProLock/>` — a lock, never a 0 and never the em dash that means
 * "cannot be computed" (invariant 6). The server strips those figures too, so
 * the lock is not hiding a number that shipped.
 */

/** Where stop · entry · mark · target sit along one line, 0–100. Null when fewer than two levels exist. */
export interface ZonePoints {
  stop: number | null;
  entry: number | null;
  mark: number | null;
  target: number | null;
}

export function zonePoints(
  row: Pick<DeskRow, "effectiveStopP" | "avgEntryP" | "markP" | "targetP">,
): ZonePoints | null {
  const raw = [row.effectiveStopP, row.avgEntryP, row.markP, row.targetP];
  const vals = raw.filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  if (hi === lo) return null;
  const at = (v: number | null) => (v === null || !Number.isFinite(v) || v <= 0 ? null : ((v - lo) / (hi - lo)) * 100);
  return { stop: at(row.effectiveStopP), entry: at(row.avgEntryP), mark: at(row.markP), target: at(row.targetP) };
}

/** The span between two points as `{left, width}` %, or null when either is missing. */
export function span(a: number | null, b: number | null): { left: number; width: number } | null {
  if (a === null || b === null) return null;
  return { left: Math.min(a, b), width: Math.abs(a - b) };
}

/** P&L at a level, before charges: qty × (level − entry), mirrored for a short. Paise. */
export function pnlAt(row: Pick<DeskRow, "side" | "qty" | "avgEntryP">, levelP: number): number {
  const d = row.side === "short" ? row.avgEntryP - levelP : levelP - row.avgEntryP;
  return Math.round(row.qty * d);
}

/** ppm of `num` over `den`, or null — the card's capital-relative figures. */
function ppmOf(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !(den > 0)) return null;
  return Math.trunc((num * 1_000_000) / den);
}

export interface PositionCardProps {
  row: DeskRow;
  data: Pick<LiveDeskData, "atrLength" | "positions" | "heat" | "today" | "feed">;
  pro: boolean;
  /** This row's slice of open risk, from the Risk lens arithmetic. Pro; null on free. */
  heatSharePpm: number | null;
  /**
   * The Σ open risk `heatSharePpm` is OF — the lens's own `openRiskP` over the rows
   * in view (C4 fix 2). Under a filter it is NOT `heat.openRiskP` (the whole book's),
   * so the card never prints a share against a figure it was not taken of.
   */
  heatShareOfP: number | null;
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  onOpenChart: () => void;
  onLab: () => void;
}

export function PositionCard({
  row,
  data,
  pro,
  heatSharePpm,
  heatShareOfP,
  editOpen,
  onEditOpenChange,
  onOpenChart,
  onLab,
}: PositionCardProps) {
  const router = useRouter();
  const chip = stopChip(row, data.atrLength, data.positions.atrMultPermille);
  const resultsIn = daysToResults(row.resultsDate, data.today);
  const capitalP = row.pctOfCapital.denominator;
  const onCapitalPpm = ppmOf(row.unrealisedP, capitalP);
  const zone = zonePoints(row);
  const computedStopP =
    row.effectiveStopP === null && (row.stop.kind === "ok" || row.stop.kind === "zero") ? row.stop.stopP : null;

  // R at the recorded target: reward over the risk frozen at entry (Pro — riskAmountP is null on free).
  const targetRPpm =
    row.targetP !== null && row.riskAmountP !== null && row.riskAmountP > 0
      ? Math.trunc((pnlAt(row, row.targetP) * 1_000_000) / row.riskAmountP)
      : null;

  const stopSourceSentence = (() => {
    if (row.effectiveStopSource === "trailing") return POSITIONS_COPY.stopFromTrailing;
    if (row.effectiveStopSource === "planned") return POSITIONS_COPY.stopFromPlanned;
    switch (chip?.kind) {
      case "atr": {
        const k = data.positions.atrMultPermille;
        return k !== null && k > 0
          ? POSITIONS_COPY.stopFromAtr(data.atrLength, String(Math.round(k) / 1000))
          : POSITIONS_COPY.stopFromAtrNoMult(data.atrLength);
      }
      case "structure":
        return POSITIONS_COPY.stopFromStructure;
      case "percent":
        return POSITIONS_COPY.stopFromPercent;
      default:
        return null;
    }
  })();

  return (
    <div className="flex flex-col gap-5 text-[14px]" data-testid="position-card" data-trade-id={row.id}>
      {/* ── title row ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4 pr-8">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <DialogTitle className="text-[30px] font-bold leading-none tracking-[0.01em]">{row.symbol}</DialogTitle>
            <Badge variant="outline" className="text-[13px]">
              {row.exchange}
            </Badge>
            <Badge variant="outline" className="text-[13px]">
              {row.product === "raw" ? row.segment : row.product}
            </Badge>
            <Badge variant="outline" className="text-[13px]">
              {row.accountName ?? `account ${row.accountId}`}
            </Badge>
            <Badge variant="secondary" className="text-[13px]">
              {row.side === "short" ? "short" : "long"}
            </Badge>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            {fmt.qty(row.qty)} qty · held {row.holdingDays ?? EM_DASH} d
            {row.partial ? ` · ${POSITIONS_COPY.partiallyBooked(fmt.pct(row.partial.bookedPpm))}` : ""}
            {resultsIn !== null ? ` · ${resultsChip(resultsIn)}` : ""}
            {` · ${stalenessLabel(row.staleness, row.markAsOf ? fmt.shortDate(row.markAsOf) : null)}`}
          </DialogDescription>
          {row.corpActions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {row.corpActions.map((a) => (
                <Badge key={`${a.type}-${a.exDate}`} variant="gold" className="text-[13px]">
                  {POSITIONS_COPY.corpAction(a.type, a.fromUnits, a.toUnits, fmt.shortDate(a.exDate))}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className="text-right">
          <p className={`font-mono text-[32px] font-semibold leading-none tabular-nums ${fmt.pnlClass(row.unrealisedP)}`}>
            {fmt.signedMoney(row.unrealisedP)}
          </p>
          <p className={`mt-2 flex flex-wrap items-center justify-end gap-1 font-mono text-[14px] tabular-nums ${fmt.pnlClass(row.unrealisedP)}`}>
            <span>{fmt.signedPct(row.unrealisedPctPpm)} from entry ·</span>
            {pro ? <span>{fmt.signedPct(onCapitalPpm)} on capital ·</span> : <span className="inline-flex items-center gap-1">on capital <ProLock /> ·</span>}
            {pro ? <span>{fmt.rMultiple(row.openRPpm)}</span> : <span className="inline-flex items-center gap-1">R <ProLock /></span>}
          </p>
        </div>
      </div>

      {/* ── zone bar: stop · entry · mark · target ─────────────────────────── */}
      <ZoneBar row={row} zone={zone} stopLabel={chip?.label ?? null} />

      {/* ── five figures ──────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-5" aria-label={POSITIONS_COPY.cardFigures}>
        <Figure
          label={POSITIONS_COPY.figRiskAtStop}
          value={
            !pro ? (
              <ProLock />
            ) : row.effectiveStopP === null ? (
              EM_DASH
            ) : (
              <span className={row.riskAtStopP !== null && row.riskAtStopP > 0 ? "text-loss" : undefined}>
                {fmt.money(row.riskAtStopP)}
              </span>
            )
          }
          sub={
            row.effectiveStopP === null
              ? POSITIONS_COPY.noStop
              : pro
                ? POSITIONS_COPY.ofCapital(fmt.pct(ppmOf(row.riskAtStopP, capitalP)))
                : undefined
          }
        />
        <Figure
          label={POSITIONS_COPY.figToStop}
          value={row.distanceToStopAtrX100 === null ? EM_DASH : POSITIONS_COPY.atrAway((row.distanceToStopAtrX100 / 100).toFixed(1))}
          sub={
            row.distanceToStopP === null
              ? row.effectiveStopP === null
                ? POSITIONS_COPY.noStop
                : DESK_NO_MARK
              : `${fmt.money(Math.abs(row.distanceToStopP))} · ${fmt.signedPct(row.distanceToStopPpm)}`
          }
        />
        <Figure
          label={POSITIONS_COPY.figToTarget}
          value={row.distanceToTargetP === null ? EM_DASH : fmt.money(Math.abs(row.distanceToTargetP))}
          sub={
            row.targetP === null ? (
              POSITIONS_COPY.noTarget
            ) : (
              <span className="inline-flex flex-wrap items-center gap-1">
                {fmt.signedPct(row.distanceToTargetPpm)} ·{" "}
                {pro ? fmt.rMultiple(targetRPpm) : <ProLock />}
              </span>
            )
          }
        />
        <Figure
          label={POSITIONS_COPY.figHeatShare}
          value={!pro ? <ProLock /> : row.effectiveStopP === null ? EM_DASH : fmt.pct(heatSharePpm)}
          sub={pro && heatShareOfP !== null ? POSITIONS_COPY.ofOpenRisk(fmt.money(heatShareOfP)) : undefined}
        />
        {row.mtf ? (
          <Figure label={POSITIONS_COPY.figMtf} value={fmt.money(row.mtf.fundedP)} sub={`interest ${fmt.money(row.mtf.accruedInterestP)}`} />
        ) : row.partial ? (
          <Figure
            label={POSITIONS_COPY.figBooked}
            value={<span className={fmt.pnlClass(row.partial.realisedGrossP)}>{fmt.signedMoney(row.partial.realisedGrossP)}</span>}
            sub={`${POSITIONS_COPY.partiallyBooked(fmt.pct(row.partial.bookedPpm))} · ${POSITIONS_COPY.beforeCharges.toLowerCase()}`}
          />
        ) : (
          <Figure label={POSITIONS_COPY.figDeployed} value={fmt.money(row.investedP)} sub={`${fmt.qty(row.qty)} @ ${fmt.level(row.avgEntryP)}`} />
        )}
      </dl>

      {/* ── zone chart (Pro) | the arithmetic + actions ────────────────────── */}
      <div className="grid gap-5 md:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-border bg-background/40 p-4">
          <p className="text-[13px] uppercase tracking-[0.14em] text-muted-foreground">{POSITIONS_COPY.zoneTitle}</p>
          {pro ? (
            <ZoneChart row={row} />
          ) : (
            <p className="flex items-center gap-2 text-[14px] text-muted-foreground">
              <ProLock /> {POSITIONS_COPY.zoneTitle}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <p className="text-[13px] uppercase tracking-[0.14em] text-muted-foreground">{POSITIONS_COPY.arithmeticTitle}</p>
          <div className="flex flex-col gap-1 text-[15px] leading-relaxed" data-testid="position-arithmetic">
            {row.effectiveStopP === null ? (
              <p>
                {POSITIONS_COPY.stopNone}
                {computedStopP !== null && <> {POSITIONS_COPY.computedLevel(fmt.level(computedStopP))}</>}
              </p>
            ) : !pro || row.riskAtStopP === null ? (
              <p className="flex flex-wrap items-center gap-1">
                {POSITIONS_COPY.lossAtStopLocked(fmt.level(row.effectiveStopP))} <ProLock />
              </p>
            ) : row.riskAtStopP > 0 ? (
              <p>
                {riskAtStopSentence(
                  fmt.level(row.effectiveStopP),
                  fmt.money(row.riskAtStopP),
                  capitalP === null ? null : fmt.pct(ppmOf(row.riskAtStopP, capitalP)),
                )}
              </p>
            ) : (
              <p>{POSITIONS_COPY.pnlAtStop(fmt.level(row.effectiveStopP), fmt.signedMoney(-row.riskAtStopP))}</p>
            )}
            <p>
              {row.targetP === null
                ? POSITIONS_COPY.noTarget
                : POSITIONS_COPY.pnlAtTarget(fmt.level(row.targetP), fmt.signedMoney(pnlAt(row, row.targetP)))}
            </p>
            {stopSourceSentence && <p>{stopSourceSentence}</p>}
          </div>
          {/* The fills caveat sits ABOVE the actions (D9). */}
          <p className="text-[13px] leading-normal text-muted-foreground">{POSITIONS_COPY.fillsCaveat}</p>
          <div className="mt-auto flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenChart}
              className="inline-flex h-[38px] items-center rounded-[var(--radius)] border border-primary px-4 text-[14px] font-medium text-primary hover:bg-primary/10"
            >
              {POSITIONS_COPY.actionOpenChart}
            </button>
            <button
              type="button"
              onClick={onLab}
              className="inline-flex h-[38px] items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-[14px] font-medium hover:bg-card-hover"
            >
              {POSITIONS_COPY.actionSizingLab}
              {!pro && <ProLock />}
            </button>
            {pro ? (
              <button
                type="button"
                onClick={() => onEditOpenChange(true)}
                className="inline-flex h-[38px] items-center rounded-[var(--radius)] border border-border px-4 text-[14px] font-medium hover:bg-card-hover"
              >
                {POSITIONS_COPY.actionEditLevels}
              </button>
            ) : (
              <button
                type="button"
                disabled
                title={POSITIONS_COPY.editLocked}
                className="inline-flex h-[38px] cursor-not-allowed items-center gap-2 rounded-[var(--radius)] border border-border px-4 text-[14px] font-medium text-muted-foreground"
              >
                {POSITIONS_COPY.actionEditLevels} <ProLock />
              </button>
            )}
            <Link
              href={`/trades?trade=${row.id}`}
              className="inline-flex h-[38px] items-center rounded-[var(--radius)] border border-border px-4 text-[14px] font-medium hover:bg-card-hover"
            >
              {POSITIONS_COPY.actionTradeRecord}
            </Link>
          </div>
        </div>
      </div>

      {/* ── the inline calculator (D10, Pro) ─────────────────────────────── */}
      <PositionCalculator key={row.id} row={row} pro={pro} onOpenLab={onLab} />

      {/* Edit levels — the extracted /risk editor, Pro only (D11). Route
          handler + fetch inside it; router.refresh() here on success. */}
      {pro && (
        <Dialog open={editOpen} onOpenChange={onEditOpenChange}>
          <DialogContent>
            <RiskEditDialog
              key={row.id}
              tradeId={row.id}
              symbol={row.symbol}
              avgEntry={row.avgEntryP / 100}
              openQty={row.qty}
              originalSl={row.slPlannedP === null ? null : row.slPlannedP / 100}
              trailingSl={row.trailingSlP === null ? null : row.trailingSlP / 100}
              target={row.targetP === null ? null : row.targetP / 100}
              onDone={() => {
                onEditOpenChange(false);
                router.refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** "No mark stored for this position yet." — the desk's own sentence for a missing mark. */
const DESK_NO_MARK = stalenessLabel(null, null);

function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-[13px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-[22px] font-semibold leading-tight tabular-nums">{value}</dd>
      {sub !== undefined && <dd className="text-[13px] text-muted-foreground">{sub}</dd>}
    </div>
  );
}

/** The 14 px zone bar with its four labelled points (Blend 2). */
function ZoneBar({ row, zone, stopLabel }: { row: DeskRow; zone: ZonePoints | null; stopLabel: string | null }) {
  if (zone === null) {
    return <p className="text-[14px] text-muted-foreground">{needsData("a stop or a target beside the entry")}</p>;
  }
  const loss = span(zone.stop, zone.entry);
  const run = span(zone.entry, zone.mark);
  const favourable = row.markP !== null && (row.side === "short" ? row.markP <= row.avgEntryP : row.markP >= row.avgEntryP);
  const label = (pos: number | null, text: string, extra = "") =>
    pos === null ? null : (
      <span
        className={`absolute top-6 whitespace-nowrap text-[13px] ${extra}`}
        style={{ left: `${pos}%`, transform: pos > 85 ? "translateX(-100%)" : pos < 15 ? "none" : "translateX(-50%)" }}
      >
        {text}
      </span>
    );
  const tick = (pos: number | null, cls: string) =>
    pos === null ? null : <span className={`absolute -top-1.5 h-[26px] w-[3px] rounded-sm ${cls}`} style={{ left: `calc(${pos}% - 1.5px)` }} />;
  return (
    <div className="relative mb-12 mt-3 h-[14px] rounded-full bg-muted/20" role="img" aria-label={POSITIONS_COPY.stripLabel(row.symbol)}>
      {loss && <span className="absolute h-[14px] bg-loss/50" style={{ left: `${loss.left}%`, width: `${loss.width}%` }} />}
      {run && (
        <span
          className={`absolute h-[14px] ${favourable ? "bg-profit/50" : "bg-loss/30"}`}
          style={{ left: `${run.left}%`, width: `${run.width}%` }}
        />
      )}
      {tick(zone.stop, "bg-loss")}
      {tick(zone.entry, "bg-foreground")}
      {tick(zone.target, "bg-profit")}
      {zone.mark !== null && (
        <span
          className="absolute -top-1.5 size-[26px] rounded-full border-4 border-card bg-primary shadow-[0_0_0_2px_var(--color-primary)]"
          style={{ left: `calc(${zone.mark}% - 13px)` }}
        />
      )}
      {label(zone.stop, `stop ${fmt.level(row.effectiveStopP)}${stopLabel ? ` · ${stopLabel}` : ""}`, "text-loss")}
      {label(zone.entry, `entry ${fmt.level(row.avgEntryP)}`, "text-muted-foreground")}
      {label(zone.mark, `mark ${fmt.level(row.markP)}`, "top-10 font-semibold text-primary")}
      {label(zone.target, `your target ${fmt.level(row.targetP)}`, "text-profit")}
    </div>
  );
}

/**
 * The 30-session zone chart — an inline SVG of `row.spark` with the stop,
 * entry and target drawn (D9). NOT lightweight-charts and NOT `barsBySymbol`
 * (capped at 60 symbols): `spark` is on every row, so the card works on every row.
 */
function ZoneChart({ row }: { row: DeskRow }) {
  const closes = row.spark;
  if (closes.length < 2) return <p className="text-[14px] text-muted-foreground">{POSITIONS_COPY.zoneNeedsData}</p>;
  const w = 520;
  const h = 150;
  const levels = [row.effectiveStopP, row.avgEntryP, row.targetP].filter((v): v is number => v !== null && v > 0);
  const lo = Math.min(...closes, ...levels);
  const hi = Math.max(...closes, ...levels);
  const rng = hi - lo || 1;
  const y = (v: number) => h - 6 - ((v - lo) / rng) * (h - 12);
  const step = w / (closes.length - 1);
  const path = closes.map((c, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${y(c).toFixed(1)}`).join(" ");
  const entryY = y(row.avgEntryP);
  const stopY = row.effectiveStopP === null ? null : y(row.effectiveStopP);
  const targetY = row.targetP === null ? null : y(row.targetP);
  const lastY = y(closes[closes.length - 1]);
  return (
    <>
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={POSITIONS_COPY.zoneLabel(row.symbol, closes.length)}
      >
        {stopY !== null && (
          <rect x={0} y={Math.min(stopY, entryY)} width={w} height={Math.abs(stopY - entryY)} className="fill-loss/15" />
        )}
        {targetY !== null && (
          <rect x={0} y={Math.min(targetY, entryY)} width={w} height={Math.abs(targetY - entryY)} className="fill-profit/15" />
        )}
        <line x1={0} x2={w} y1={entryY} y2={entryY} strokeDasharray="4 4" strokeWidth={1.2} className="stroke-muted-foreground" vectorEffect="non-scaling-stroke" />
        {stopY !== null && <line x1={0} x2={w} y1={stopY} y2={stopY} strokeWidth={1.5} className="stroke-loss" vectorEffect="non-scaling-stroke" />}
        {targetY !== null && <line x1={0} x2={w} y1={targetY} y2={targetY} strokeWidth={1.5} className="stroke-profit" vectorEffect="non-scaling-stroke" />}
        <path d={path} fill="none" strokeWidth={2.2} className="stroke-foreground" vectorEffect="non-scaling-stroke" />
        <circle cx={w} cy={lastY} r={5} className="fill-primary" />
      </svg>
      <div className="flex justify-between text-[13px] text-muted-foreground">
        <span className="text-loss">stop {fmt.level(row.effectiveStopP)}</span>
        <span>entry {fmt.level(row.avgEntryP)}</span>
        <span className="text-primary">mark {fmt.level(row.markP)}</span>
        <span className="text-profit">target {fmt.level(row.targetP)}</span>
      </div>
    </>
  );
}
