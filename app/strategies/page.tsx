import type * as React from "react";
import { PageHeader } from "@/components/layout/page-header";
import { PayoffChart } from "@/components/reports/payoff-chart";
import { LazyMount } from "@/components/ui/lazy-mount";
import { Badge } from "@/components/ui/badge";
import { StrategiesClient } from "@/components/strategies/strategies-client";
import { STRATEGY_COPY, withholdForFree, type PickerRow } from "@/components/strategies/strategy-copy";
import { getOpenOptionPositions, getOpenUnderlyingPositions } from "@/lib/queries/trades";
import { getSpotMap } from "@/lib/queries/mtm";
import { getSettings } from "@/lib/queries/settings";
import { getEntitlement } from "@/lib/queries/license";
import { buildStrategies, type PositionedLeg } from "@/lib/analytics/strategies";
import { CATALOGUE, STRATEGY_IDS } from "@/lib/analytics/strategy-catalogue";
import { parseShelf } from "@/lib/domain/strategy-shelf";
import { sebiRealityLine } from "@/lib/domain/options-help";
import { SEBI_FNO_FACTS } from "@/lib/analytics/sebi-reality";

/**
 * `/strategies` — the option structures the journal already holds (v4.3).
 *
 * FORCE-DYNAMIC because it reads the journal (AGENTS.md), and a cached open
 * position is a wrong structure on screen.
 *
 * NOT WRAPPED IN A WHOLE-PAGE GATE, deliberately (invariant 7). The user's own
 * legs, their four figures and the payoff curve are their record and stay free;
 * the Pro capability is the CATALOGUE — the named shape beyond the eight that
 * this screen has always named, and the shelf and picker built on it.
 * `lib/license.ts` carries /strategies as `partial: true`, and
 * `tests/pro-gating.test.ts` holds both halves of that: this file must read
 * `getEntitlement`, and it must not carry a whole-page gate. (That guard reads
 * the RAW source, so the element's own name is deliberately not written here.)
 *
 * THE WITHHOLDING HAPPENS HERE, BEFORE THE PAYLOAD (app/live/page.tsx:21 is the
 * precedent). Handing the entitlement to the client as a prop would leave every
 * Pro name computed on the server and shipped inside the RSC payload, where a
 * locked chip on screen hides nothing at all. `withholdForFree` is pure and
 * `tests/strategies-page.test.ts` proves the absence on the SERIALISED result.
 *
 * THE PICKER'S 40 ROWS ARE SENT ONLY TO A PRO BUILD, for the same reason and
 * for one more: a free build has no use for them, and a payload nobody can act
 * on is weight on every page load.
 */
export const dynamic = "force-dynamic";

export default function StrategiesPage() {
  const pro = getEntitlement().pro;

  // The open/option/strike/CE-PE filter lives in SQL (getOpenOptionPositions):
  // the whole-book read mapped 25k rows to keep 673 on the 25k perf tier.
  const optionLegs: PositionedLeg[] = getOpenOptionPositions().map((t) => {
    const side: "long" | "short" = t.buyQty >= t.sellQty ? "long" : "short";
    const qty = Math.abs(t.buyQty - t.sellQty) || Math.max(t.buyQty, t.sellQty);
    return {
      symbol: t.symbol,
      expiry: t.expiry,
      kind: t.optionType as "CE" | "PE",
      optionType: t.optionType as "CE" | "PE",
      strike: t.strike as number,
      side,
      qty,
      premium: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
    };
  });

  // The underlying, read-only (research note Q4): without it there is no
  // covered call and no protective put. `premium` on a UL leg is its ENTRY
  // PRICE per unit — the field is named for the option case and carries the
  // same arithmetic (strategies.ts `payoffAt`).
  const underlyingLegs: PositionedLeg[] = getOpenUnderlyingPositions().map((t) => {
    const net = t.buyQty - t.sellQty;
    const side: "long" | "short" = net >= 0 ? "long" : "short";
    const qty = Math.abs(net) || Math.max(t.buyQty, t.sellQty);
    return {
      symbol: t.symbol,
      expiry: null,
      kind: "UL" as const,
      // A UL leg has no strike. It is excluded from the strike ladder by
      // `computeStrategy`, so this is a placeholder and never a level.
      strike: 0,
      side,
      qty,
      premium: side === "long" ? t.avgBuyPrice : t.avgSellPrice,
    };
  });

  const groups = withholdForFree(buildStrategies([...optionLegs, ...underlyingLegs]), pro);

  // THE CHARTS ARE BUILT HERE, not inside the card, and stay MOUNTED ON
  // APPROACH. All 626 of them used to build their SVGs in one commit after
  // hydration, which was this page's entire cost (6026 → 1022 ms, v3.4.0;
  // `tests/render-windowing.test.ts` pins it to this file). 240 is
  // PayoffChart's own height, so nothing shifts when a chart arrives.
  const spotMap = getSpotMap();
  const charts: Record<string, React.ReactNode> = {};
  for (const g of groups) {
    charts[g.key] = (
      <LazyMount minHeight={240}>
        <PayoffChart data={g.payoff} breakevens={g.breakevens} spot={spotMap.get(g.symbol.toUpperCase()) ?? null} />
      </LazyMount>
    );
  }

  const shelf = parseShelf(getSettings()?.strategyShelfJson ?? null, STRATEGY_IDS);
  const picker: PickerRow[] | null = pro
    ? CATALOGUE.map((d) => ({ id: d.id, name: d.name, style: d.style, beginner: d.beginner }))
    : null;

  return (
    <>
      <PageHeader
        title={STRATEGY_COPY.title}
        description={STRATEGY_COPY.description}
        actions={
          <Badge variant="secondary">
            {groups.length} {groups.length === 1 ? "structure" : "structures"}
          </Badge>
        }
      />
      <div className="space-y-5 p-6">
        {/* The SEBI line, once, at the top — computed from SEBI_FNO_FACTS by
            B5's own function, so a revised study updates the sentence and
            cannot leave a stale literal behind. */}
        <p className="rounded-md border border-border bg-card-hover/30 p-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
          {sebiRealityLine(SEBI_FNO_FACTS)}
        </p>

        <StrategiesClient groups={groups} charts={charts} shelf={shelf} picker={picker} pro={pro} />

        <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
          <span className="text-foreground">{STRATEGY_COPY.beforeCharges}</span> {STRATEGY_COPY.sttNote}
        </p>
      </div>
    </>
  );
}
