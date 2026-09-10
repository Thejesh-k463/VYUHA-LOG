"use client";

import type * as React from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProLock } from "@/components/system/pro-lock";
import { inr } from "@/lib/format";
import { legKind, type CapLabel, type OptionLeg } from "@/lib/analytics/strategies";
import {
  EM_DASH,
  FIGURE_TONE_CLASS,
  NET_LABEL,
  STRATEGY_COPY,
  capNote,
  figureDescriptor,
  helpHref,
  legCountLabel,
  netTone,
  optionNetPremium,
  underlyingEntryLine,
  type ScreenGroup,
} from "./strategy-copy";

/**
 * ONE STRUCTURE, AS A CARD.
 *
 * A client component because the shelf above it re-renders the list as the
 * selection changes. It holds no state of its own: everything on it is the
 * group the server computed, and the payoff chart arrives already rendered by
 * the server page, which is where the v3.4.0 perf guard mounts it on approach.
 *
 * THE FOUR FIGURES CARRY THEIR SUB-LABEL, NEVER A BARE NUMBER (§6). "Unlimited"
 * is an uncapped leg; "Computed at underlying = 0" is a price floor;
 * "Not computed" is §7's model-dependent case and is NOT the same statement as
 * "Unlimited" — printing one for the other is a wrong fact, which is why
 * `capLabel` and `notComputed` are separate seams in B1's group.
 */
export function StrategyCard({ group, chart }: { group: ScreenGroup; chart: React.ReactNode }) {
  const g = group;
  const optionLegs = g.legs.filter((l) => legKind(l) !== "UL");
  const tone = netTone(g.strategyId, g.netPremium, g.ulLegs.length > 0);
  const optNet = optionNetPremium(g);
  const ulEntry = underlyingEntryLine(g);
  const multiExpiry = g.expiries.length > 1;

  return (
    <Card className="p-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{g.symbol}</CardTitle>
          <Badge variant="default">{g.displayName}</Badge>
          {g.proWithheld ? <ProLock /> : null}
          {tone ? <Badge variant={tone === "credit" ? "profit" : "secondary"}>{NET_LABEL[tone]}</Badge> : null}
          {g.expiry ? <span className="text-xs text-muted-foreground">exp {g.expiry}</span> : null}
          {multiExpiry && g.nearestExpiry ? (
            <span className="text-xs text-muted-foreground">nearest {g.nearestExpiry}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{legCountLabel(g.legs.length)}</span>
          {/* The accent link, highlighted: /help is where the shape is
              explained at length, and a Custom group lands on the section top
              because it has no entry of its own. */}
          <Link
            href={helpHref(g.strategyId)}
            className="rounded border border-accent/40 bg-accent/[0.07] px-2 py-0.5 text-xs font-medium text-accent underline-offset-2 hover:underline"
          >
            {STRATEGY_COPY.howThisWorks}
          </Link>
        </div>
      </CardHeader>

      <CardContent className="grid gap-4 p-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-3">
          {g.proWithheld ? (
            <p className="rounded-md border border-accent/30 bg-accent/[0.04] px-2.5 py-1.5 text-[0.6875rem] text-muted-foreground">
              {STRATEGY_COPY.proWithheldNote}
            </p>
          ) : null}

          <div className="space-y-1">
            {optionLegs.map((l, i) => (
              <LegRow key={`o${i}`} leg={l} />
            ))}
            {/* The underlying, read-only: it is priced from the journal and is
                never edited here. */}
            {g.ulLegs.map((l, i) => (
              <LegRow key={`u${i}`} leg={l} />
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            {/* THE OPTION LEGS' PREMIUM, and the underlying's entry cash on its
                own line: `netPremium` counts both, so on a covered call the
                tile contradicted its own "Net credit" chip. */}
            <Metric
              label="Net premium"
              value={`${optNet > 0 ? "+" : ""}${inr(optNet, { decimals: 0 })}`}
              tone={FIGURE_TONE_CLASS[optNet > 0 ? "gain" : optNet < 0 ? "loss" : "neutral"]}
              sub={ulEntry ?? undefined}
            />
            <Metric
              label="Breakeven(s)"
              value={g.breakevens.length ? g.breakevens.map((b) => Math.round(b)).join(" / ") : EM_DASH}
              sub={multiExpiry ? "At nearest expiry" : undefined}
            />
            <Figure which="maxProfit" value={g.maxProfit} cap={g.capLabel.maxProfit} />
            <Figure which="maxLoss" value={g.maxLoss} cap={g.capLabel.maxLoss} />
          </div>

          {multiExpiry ? (
            <p className="rounded-md border border-warning/30 bg-warning/[0.05] px-2.5 py-1.5 text-[0.6875rem] leading-relaxed text-muted-foreground">
              {STRATEGY_COPY.multiExpiryNote}
            </p>
          ) : null}

          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">{STRATEGY_COPY.footer}</p>
        </div>

        {/* The payoff diagram, rendered by the server page and passed in: it
            is mounted on approach there, which is where the v3.4.0 perf guard
            pins it and where it stays out of this card re-render. */}
        {chart}
      </CardContent>
    </Card>
  );
}

/** One leg, option or underlying. A UL leg prints its entry price, not a strike. */
function LegRow({ leg }: { leg: OptionLeg }) {
  const kind = legKind(leg);
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-card-hover/30 px-2.5 py-1.5 text-xs">
      <span className="inline-flex items-center gap-1.5">
        <Badge variant={leg.side === "long" ? "profit" : "loss"}>{leg.side === "long" ? "Long" : "Short"}</Badge>
        <span className="tabular-nums">
          {kind === "UL" ? `${leg.qty} × underlying` : `${leg.qty} × ${leg.strike} ${kind}`}
        </span>
      </span>
      <span className="tabular-nums text-muted-foreground">@ {inr(leg.premium, { decimals: 2 })}</span>
    </div>
  );
}

/**
 * A capped figure with its §6 sub-label. `null` is UNBOUNDED and the label says
 * so; `Not computed` blanks the number entirely rather than print a
 * confidently wrong one (invariant 6 applied to a payoff).
 *
 * THE HEADING AND THE COLOUR ARE NOT THIS COMPONENT'S TO CHOOSE: a minimum
 * payoff can be a gain and a maximum can be a loss, so both come from
 * `figureDescriptor` in the pure module, where the rule is unit-tested.
 */
function Figure({
  which,
  value,
  cap,
}: {
  which: "maxProfit" | "maxLoss";
  value: number | null;
  cap: CapLabel;
}) {
  const printed = cap === "Not computed" ? EM_DASH : value == null ? "Unlimited" : inr(value, { decimals: 0 });
  const d = figureDescriptor(which, value, cap);
  return (
    <Metric
      label={d.label}
      value={printed}
      sub={d.sub}
      title={capNote(cap) ?? undefined}
      tone={FIGURE_TONE_CLASS[d.tone]}
    />
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-card-hover/30 px-2.5 py-1.5" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
      {sub ? <div className="text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
