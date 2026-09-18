"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi-card";
import { Select } from "@/components/ui/select";
import { ExportButtons } from "@/components/ui/export-button";
import { MtmForm } from "./mtm-form";
import {
  fundingSide,
  interestOnWholeLeg,
  MTF_INTEREST_WHOLE_LEG_NOTE,
  mtfFundedStated,
  ownCapitalNote,
  ownCapitalTotal,
  statesOwnCapital,
  type OpenPosition,
} from "@/lib/analytics/positions";
import { inr, inrCompact, num, plural } from "@/lib/format";
import { SEGMENT_LABELS, type Segment } from "@/lib/domain/constants";

const pnl = (v: number) => (v > 0 ? "text-profit" : v < 0 ? "text-loss" : "text-muted-foreground");

interface ClosedLite {
  symbol: string; segment: string; broker: string; netPnl: number; grossPnl: number; sellDate: string | null; rMultiple: number | null;
}

export function TrackerClient({
  variant,
  positions,
  closed,
  closedTotal,
  bucketCapital,
}: {
  variant: "equity" | "active";
  positions: OpenPosition[];
  /** The most recent slice the server ships — NOT the whole history. */
  closed: ClosedLite[];
  /** Every closed trade in the bucket, so the slice never masquerades as the count. */
  closedTotal: number;
  /** 0 means NOT CONFIGURED — capital-relative figures render "—", never a
   *  stand-in number (the ₹13L/₹4L fallbacks fabricated every utilisation %
   *  on a fresh install; invariant 6). */
  bucketCapital: number;
}) {
  const [seg, setSeg] = React.useState("");
  const [funding, setFunding] = React.useState<"" | "user" | "broker">("");
  const data = React.useMemo(() => {
    let list = positions;
    if (seg) list = list.filter((p) => p.segment === seg);
    // D7 — `fundedAmount <= 0` filed a row the journal never priced under "user
    // funded", and `> 0` hid it from both. One rule, and a null is neither.
    if (funding === "user") list = list.filter((p) => fundingSide(p) === "user");
    if (funding === "broker") list = list.filter((p) => fundingSide(p) === "broker");
    return list;
  }, [positions, seg, funding]);

  const deployed = positions.reduce((s, p) => s + p.invested, 0);
  const capitalKnown = bucketCapital > 0;
  const available = bucketCapital - deployed;
  const unrealised = positions.reduce((s, p) => s + p.unrealised, 0);
  const mtfInterest = positions.reduce((s, p) => s + p.accruedInterest, 0);
  // L2[0]: the own-capital total is not a plain reduce. A partly sold MTF leg
  // states no own capital (the stored funded amount is the whole buy leg's),
  // and summing it straight across the book SUBTRACTED that row from the
  // trader's own money. `ownCapitalTotal` leaves those rows out and counts
  // them; `ownCapitalNote` is the sentence shown wherever the total is.
  //
  // D7 (close-readers#2): BROKER-FUNDED COMES FROM THE SAME SET. It used to be
  // the whole-book `positions.reduce(p.fundedAmount)` while own capital and
  // leverage were the stating subset, so the dialog read ₹32,000 funded beside
  // ₹4,000 own and a 5.00× ratio the two rows above it make 9.00×. All three
  // money rows now describe one set of rows, the note is on all three, and a
  // fourth line states the financing left out of them.
  const ownCap = ownCapitalTotal(positions);
  const ownCapNote = ownCapitalNote(ownCap);
  // D8 (wave 2O, mtf#2 ≡ seams#0): THE FACE STATES WHAT THE BOOK RECORDS. Wave 2N
  // set this to `ownCap.funded` — the own-capital-STATING subset — so a book of
  // partly sold MTF rows, each with its funding recorded, printed "MTF funded ₹0"
  // on the headline KPI while the cells below it printed those very amounts and
  // /targets stated their sum. A partly sold leg's funded amount IS stated (it is
  // the whole leg, which is what Q-B keeps accruing on); only its own capital is
  // unstatable. One helper, read here and by /targets, so they cannot disagree.
  //
  // RECORDED DEVIATION from D7.2's "the three money rows come from ONE set": the
  // Broker-funded row below is this SUPERSET and says so in its own hint, while
  // own capital and leverage keep `ownCapitalTotal`'s subset and say so in theirs.
  // The face is never summed with `ownCap.funded` (DECISIONS 2026-09-16, wave 2O).
  const mtfFunded = mtfFundedStated(positions);
  const mtfRowsOut = positions.filter((p) => p.isMtf && !statesOwnCapital(p));
  // Interest is stored money and is NOT subset-scoped: it is what the journal
  // has already booked on every MTF row, including the ones left out above.
  const outInterest = mtfRowsOut.reduce((s, p) => s + p.accruedInterest, 0);

  // Drill-down inputs for the KPI popups (click any card).
  const sortedByInvested = [...positions].sort((a, b) => b.invested - a.invested);
  const topPosition = sortedByInvested[0] ?? null;
  const oldest = [...positions].sort((a, b) => (b.daysHeld ?? 0) - (a.daysHeld ?? 0))[0] ?? null;
  const byUnrealised = [...positions].sort((a, b) => b.unrealised - a.unrealised);
  const bestPos = byUnrealised[0] ?? null;
  const worstPos = byUnrealised[byUnrealised.length - 1] ?? null;

  const segments = [...new Set(positions.map((p) => p.segment))];
  const segGroups = segments.map((s) => {
    const list = positions.filter((p) => p.segment === s);
    return {
      segment: s as Segment,
      count: list.length,
      invested: list.reduce((a, b) => a + b.invested, 0),
      unrealised: list.reduce((a, b) => a + b.unrealised, 0),
    };
  });

  const columns = React.useMemo<ColumnDef<OpenPosition, unknown>[]>(() => {
    const base: ColumnDef<OpenPosition, unknown>[] = [
      {
        accessorKey: "symbol", header: "Instrument",
        cell: ({ row }) => (
          <div className="min-w-[140px]">
            <div className="font-medium">{row.original.symbol}</div>
            <div className="text-[10px] text-muted-foreground">
              {row.original.optionType ? `${row.original.strike} ${row.original.optionType}` : SEGMENT_LABELS[row.original.segment as Segment]}
            </div>
          </div>
        ),
      },
      { accessorKey: "broker", header: "Broker", cell: ({ getValue }) => <span className="capitalize">{String(getValue())}</span> },
      { accessorKey: "qty", header: "Qty", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
      { accessorKey: "avgPrice", header: "Avg", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 2) },
      { accessorKey: "mtmPrice", header: "MTM", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 2) },
      { accessorKey: "invested", header: "Invested", meta: { align: "right" }, cell: ({ getValue }) => num(getValue() as number, 0) },
      { accessorKey: "unrealised", header: "Unrealised", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnl(getValue() as number)}>{num(getValue() as number, 0)}</span> },
      { accessorKey: "unrealisedPct", header: "%", meta: { align: "right" }, cell: ({ getValue }) => <span className={pnl(getValue() as number)}>{(getValue() as number).toFixed(2)}%</span> },
    ];
    if (variant === "equity") {
      base.push(
        { accessorKey: "daysHeld", header: "Days", meta: { align: "right" }, cell: ({ getValue }) => (getValue() as number | null) ?? "—" },
        // Reads the SAME predicate the KPI total does (L2[0]) — the cell and
        // the total held the rule separately, so the row showed "—" while the
        // total was quietly reduced by it.
        // D7 — the predicate ALONE. The extra `> 0` on top of it printed "—"
        // for a STATED own capital of 0 (funded == invested) that the KPI total
        // counted, which is the same cell-vs-total disagreement L2[0] ended.
        { accessorKey: "ownCapital", header: "Own capital", meta: { align: "right" }, cell: ({ row }) => { const p = row.original; return statesOwnCapital(p) ? num(p.ownCapital as number, 0) : "—"; } },
        // A null is "the journal never priced this row"; a stated 0 is "the
        // broker funded none of it". Only the null renders a dash.
        { accessorKey: "fundedAmount", header: "MTF funded", meta: { align: "right" }, cell: ({ row }) => { const p = row.original; return p.isMtf && p.fundedAmount != null ? num(p.fundedAmount, 0) : "—"; } },
        {
          accessorKey: "accruedInterest", header: "MTF int.", meta: { align: "right" },
          cell: ({ row }) => {
            const p = row.original;
            if (!(p.accruedInterest > 0)) return "—";
            // Q-B: the figure stands; the caveat is stated where it is read.
            return <span title={interestOnWholeLeg(p) ? MTF_INTEREST_WHOLE_LEG_NOTE : undefined}>{num(p.accruedInterest, 0)}</span>;
          },
        },
        {
          accessorKey: "roiOnCapitalPct", header: "ROI on capital", meta: { align: "right" },
          cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnl(v)}>{v.toFixed(2)}%</span>; },
        },
        {
          accessorKey: "breakevenPrice", header: "Breakeven", meta: { align: "right" },
          cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : num(v, 2); },
        },
        {
          id: "mtfWarning", header: "",
          cell: ({ row }) => {
            const p = row.original;
            // Matches the reference sheet's flag exactly: interest has eaten
            // your ENTIRE paper gain — a losing position doesn't need this
            // (of course a loss got worse; nothing new to flag).
            if (!p.isMtf || p.unrealised <= 0 || p.accruedInterest < p.unrealised) return null;
            return (
              <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[9px] font-medium text-loss" title="MTF interest has eaten this position's entire unrealised gain">
                ⚠ interest &gt; profit
              </span>
            );
          },
        },
      );
    } else {
      base.push(
        { accessorKey: "expiry", header: "Expiry", cell: ({ getValue }) => (getValue() as string | null) ?? "—" },
        { accessorKey: "dte", header: "DTE", meta: { align: "right" }, cell: ({ getValue }) => (getValue() as number | null) ?? "—" },
      );
    }
    base.push(
      { accessorKey: "rMultiple", header: "Current R", meta: { align: "right" }, cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : <span className={pnl(v)}>{v.toFixed(2)}</span>; } },
      {
        accessorKey: "targetRR", header: "Target R:R", meta: { align: "right" },
        cell: ({ getValue }) => { const v = getValue() as number | null; return v == null ? "—" : `1:${v.toFixed(2)}`; },
      },
    );
    return base;
  }, [variant]);

  const exportCols = [
    { key: "symbol", label: "Symbol" }, { key: "broker", label: "Broker" },
    { key: "segment", label: "Segment" }, { key: "qty", label: "Qty" },
    { key: "avgPrice", label: "Avg" }, { key: "mtmPrice", label: "MTM" },
    { key: "invested", label: "Invested" }, { key: "unrealised", label: "Unrealised" },
    { key: "daysHeld", label: "Days" }, { key: "dte", label: "DTE" },
    { key: "ownCapital", label: "Own capital" }, { key: "fundedAmount", label: "MTF funded" },
    { key: "accruedInterest", label: "MTF int." }, { key: "roiOnCapitalPct", label: "ROI on capital %" },
    { key: "breakevenPrice", label: "Breakeven" }, { key: "targetRR", label: "Target R:R" },
  ];

  return (
    <div className="space-y-5">
      {/* Capital gauge */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              Bucket capital ·{" "}
              {capitalKnown ? (
                inr(bucketCapital, { decimals: 0 })
              ) : (
                <>
                  — <Link href="/settings" className="underline decoration-dotted underline-offset-2">set it in Settings</Link>
                </>
              )}
            </span>
            <span className="tabular-nums">
              Deployed <span className="font-medium">{inrCompact(deployed)}</span>
              {capitalKnown && (
                <>
                  {" "}· Available{" "}
                  <span className={available >= 0 ? "text-profit" : "text-loss"}>{inrCompact(available)}</span>
                </>
              )}
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-card-hover">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, capitalKnown ? (deployed / bucketCapital) * 100 : 0)}%` }} />
          </div>
        </CardContent>
      </Card>

      {/* Summary cards */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiCard
          label="Open positions"
          valueNum={positions.length}
          format="int"
          detail={{
            title: "Open positions — the book right now",
            summary: "Every position still running in this bucket.",
            rows: [
              { label: "Positions open", value: `${positions.length}` },
              { label: "Winners / losers", value: `${positions.filter((p) => p.unrealised > 0).length} / ${positions.filter((p) => p.unrealised < 0).length}` },
              { label: "Largest position", value: topPosition ? `${topPosition.symbol} · ${inr(topPosition.invested, { decimals: 0 })}` : "—", hint: topPosition && bucketCapital ? `${((topPosition.invested / bucketCapital) * 100).toFixed(1)}% of bucket capital` : undefined },
              { label: "Oldest holding", value: oldest ? `${oldest.symbol} · ${oldest.daysHeld ?? 0}d` : "—" },
              ...(variant === "equity"
                ? [{
                    label: "MTF-funded positions",
                    value: `${positions.filter((p) => fundingSide(p) === "broker").length}`,
                    hint: ownCap.unstatedWhy.unpriced > 0 ? `${plural(ownCap.unstatedWhy.unpriced, "MTF row states", "MTF rows state")} no funded amount yet` : undefined,
                  }]
                : []),
            ],
            note: "Concentration is risk: one position dominating the bucket is the most common way a good month becomes a bad one.",
          }}
        />
        <KpiCard
          label="Invested"
          valueNum={deployed}
          format="inrCompact"
          sub={capitalKnown ? `${((deployed / bucketCapital) * 100).toFixed(0)}% of bucket` : "capital not set"}
          detail={{
            title: "Capital deployed in this bucket",
            summary: "How much of the bucket is working, and how much is still dry powder.",
            rows: [
              { label: "Bucket capital", value: capitalKnown ? inr(bucketCapital, { decimals: 0 }) : "— (set in Settings)" },
              { label: "Deployed", value: inr(deployed, { decimals: 0 }), hint: capitalKnown ? `${((deployed / bucketCapital) * 100).toFixed(1)}% utilised` : undefined },
              ...(capitalKnown ? [{ label: "Available", value: inr(available, { decimals: 0 }), tone: (available >= 0 ? "profit" : "loss") as "profit" | "loss" }] : []),
              { label: "Current value", value: inr(deployed + unrealised, { decimals: 0 }) },
              ...(variant === "equity" ? [{ label: "Own capital in MTF", value: inr(ownCap.total, { decimals: 0 }), hint: ownCapNote ? `your money; the rest is broker-funded · ${ownCapNote}` : "your money; the rest is broker-funded" }] : []),
            ],
            note: "Capital is editable in Settings — every risk %, target and allocation recomputes from it.",
          }}
        />
        <KpiCard
          label="Unrealised P&L"
          valueNum={unrealised}
          format="inr0"
          valueClassName={pnl(unrealised)}
          detail={{
            title: "Unrealised P&L — paper money",
            summary: "Marked against your latest stored marks — end-of-day, typed, or one dated mark a day from your own feed — never a live tick.",
            rows: [
              { label: "Unrealised P&L", value: inr(unrealised, { decimals: 0 }), tone: unrealised >= 0 ? "profit" : "loss" },
              { label: "On invested", value: deployed ? `${((unrealised / deployed) * 100).toFixed(2)}%` : "—" },
              { label: "Best position", value: bestPos ? `${bestPos.symbol} · ${inr(bestPos.unrealised, { decimals: 0 })}` : "—", tone: "profit" },
              { label: "Worst position", value: worstPos ? `${worstPos.symbol} · ${inr(worstPos.unrealised, { decimals: 0 })}` : "—", tone: "loss" },
              ...(variant === "equity" ? [{ label: "Less accrued MTF interest", value: `−${inr(mtfInterest, { decimals: 0 })}`, tone: "loss" as const, hint: "financing cost already booked against these positions" }] : []),
            ],
            note: "Nothing here is realised until you close. Update MTM prices below to keep it honest.",
          }}
        />
        {variant === "equity" ? (
          <KpiCard
            label="MTF funded"
            valueNum={mtfFunded.funded}
            format="inrCompact"
            sub={
              mtfFunded.unstated > 0
                ? `Accrued int. ${inrCompact(mtfInterest)} · ${plural(mtfFunded.unstated, "row states", "rows state")} no funding`
                : `Accrued int. ${inrCompact(mtfInterest)}`
            }
            valueClassName="text-grad-gold"
            detail={{
              title: "MTF — what the broker is funding",
              summary: "Interest accrues only on the broker-funded portion, never on your own capital.",
              rows: [
                // D8 (wave 2O) — EACH ROW STATES ITS OWN SET, which is the
                // recorded deviation from D7.2's one-set rule: "Broker-funded" is
                // the whole book's recorded financing (the same figure as the face
                // and as /targets), while own capital and the leverage ratio keep
                // `ownCapitalTotal`'s stating subset, because a ratio built from
                // two different sets describes no book. Neither figure is a
                // superset of a number the other already counts, so nothing here
                // is summed with anything (close-readers#2's arithmetic property).
                { label: "Broker-funded", value: inr(mtfFunded.funded, { decimals: 0 }), tone: "loss", hint: `every MTF row that states funding — ${mtfFunded.stated} of ${mtfFunded.stated + mtfFunded.unstated}` },
                { label: "Your own capital", value: inr(ownCap.total, { decimals: 0 }), hint: ownCapNote ?? undefined },
                { label: "Effective leverage", value: ownCap.total > 0 ? `${((ownCap.total + ownCap.funded) / ownCap.total).toFixed(2)}×` : "—", hint: `over the ${plural(ownCap.stating, "row that states", "rows that state")} own capital: ${inr(ownCap.funded, { decimals: 0 })} funded + ${inr(ownCap.total, { decimals: 0 })} own${ownCapNote ? ` · ${ownCapNote}` : ""}` },
                // …and what those three left out is stated, never estimated.
                ...(mtfRowsOut.length > 0
                  ? [{
                      label: "Not in these figures",
                      value: plural(mtfRowsOut.length, "MTF row", "MTF rows"),
                      hint: `${ownCapNote ?? ""}${outInterest > 0 ? ` · ${inr(outInterest, { decimals: 0 })} of interest on them is still counted below` : ""}`,
                    }]
                  : []),
                { label: "Interest accrued so far", value: `−${inr(mtfInterest, { decimals: 0 })}`, tone: "loss", hint: mtfRowsOut.some(interestOnWholeLeg) ? MTF_INTEREST_WHOLE_LEG_NOTE : undefined },
                { label: "Interest vs unrealised gain", value: unrealised > 0 ? `${((mtfInterest / unrealised) * 100).toFixed(1)}%` : "—", hint: mtfInterest > 0 && unrealised > 0 && mtfInterest >= unrealised ? "interest has eaten the entire paper gain" : "share of your paper gain already spent on financing" },
              ],
              note: "MTF interest compounds daily whether the position moves or not — time is a cost here, not a free option.",
            }}
          />
        ) : (
          <KpiCard label="Segments live" valueNum={segments.length} format="int" sub={segments.map((s) => SEGMENT_LABELS[s as Segment]).slice(0, 2).join(", ")} />
        )}
      </section>

      {/* Per-segment mini cards (active) */}
      {variant === "active" && segGroups.length > 0 && (
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {segGroups.map((g) => (
            <Card key={g.segment} className="p-3">
              <div className="text-[0.6875rem] font-medium text-muted-foreground">{SEGMENT_LABELS[g.segment]}</div>
              <div className="mt-1 flex items-baseline justify-between">
                <span className="text-lg font-semibold tabular-nums">{g.count}</span>
                <span className={`text-xs tabular-nums ${pnl(g.unrealised)}`}>{inrCompact(g.unrealised)}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">{inrCompact(g.invested)} invested</div>
            </Card>
          ))}
        </section>
      )}

      {/* MTM entry */}
      <Card>
        <CardHeader><CardTitle>Update MTM (manual / EOD)</CardTitle></CardHeader>
        <CardContent><MtmForm /></CardContent>
      </Card>

      {/* Positions table */}
      <Card className="p-0">
        <div className="flex items-center justify-between p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Open positions</span>
            <Select value={seg} onChange={(e) => setSeg(e.target.value)} className="h-7 w-40 text-xs">
              <option value="">All segments</option>
              {segments.map((s) => <option key={s} value={s}>{SEGMENT_LABELS[s as Segment]}</option>)}
            </Select>
            {variant === "equity" && (
              <Select value={funding} onChange={(e) => setFunding(e.target.value as "" | "user" | "broker")} className="h-7 w-44 text-xs">
                <option value="">All funding</option>
                <option value="user">User-funded only</option>
                <option value="broker">Broker-funded (MTF)</option>
              </Select>
            )}
          </div>
          <ExportButtons filename={`vyuha-${variant}-positions`} columns={exportCols} rows={data} />
        </div>
        {/* `virtual` — this table was rendering EVERY open position into the DOM.
            At 25k trades that is ~2,750 rows behind a 460px scroller showing ~9,
            and the hydration cost of the other 2,741 was the whole of /equity's
            3.2 s. Same windowing /trades has used since v3.0.0; `measureElement`
            handles the two-line cells below. */}
        <DataTable columns={columns} data={data} maxHeight="460px" virtual emptyMessage="No open positions. Import or add trades, then set MTM prices." />
      </Card>

      {/* Recent closed — the server ships a recent SLICE; the title carries
          the real total so the window never reads as the whole history. */}
      <Card>
        <CardHeader>
          <CardTitle>
            Recent closed{" "}
            {closedTotal > closed.length ? (
              <span className="text-xs font-normal text-muted-foreground">
                (most recent {closed.length} of {closedTotal})
              </span>
            ) : (
              <span className="text-xs font-normal text-muted-foreground">({closed.length})</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="max-h-[320px] overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1.5 font-medium">Date</th>
                  <th className="px-2 py-1.5 font-medium">Symbol</th>
                  <th className="px-2 py-1.5 font-medium">Segment</th>
                  <th className="px-2 py-1.5 text-right font-medium">Net</th>
                  <th className="px-2 py-1.5 text-right font-medium">R</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((c, i) => (
                  <tr key={i} className="border-t border-rule">
                    <td className="px-2 py-1 text-muted-foreground">{c.sellDate ?? "—"}</td>
                    <td className="px-2 py-1 font-medium">{c.symbol}</td>
                    <td className="px-2 py-1 text-muted-foreground">{SEGMENT_LABELS[c.segment as Segment]}</td>
                    <td className={`px-2 py-1 text-right tabular-nums ${pnl(c.netPnl)}`}>{num(c.netPnl, 0)}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{c.rMultiple == null ? "—" : c.rMultiple.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
